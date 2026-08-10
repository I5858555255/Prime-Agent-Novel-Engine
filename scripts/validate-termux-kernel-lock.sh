#!/data/data/com.termux/files/usr/bin/bash

set -euo pipefail

repo_dir="${1:-$PWD}"
project_dir="$repo_dir/prime-agent-runtime/kernel"
runtime_dir="$repo_dir/prime-agent-runtime"
toolchain_file="$project_dir/toolchain.json"
uv_version="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1])).uv" "$toolchain_file")"
python_minimum="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1])).termuxPython.minimum" "$toolchain_file")"
python_maximum="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1])).termuxPython.maximumExclusive" "$toolchain_file")"
validation_python="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1])).termuxPython.validation" "$toolchain_file")"
exclude_newer="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1])).excludeNewer" "$toolchain_file")"
actual_uv="$(uv --version | sed -E 's/^uv ([^ ]+).*/\1/')"
actual_python="$(python -c 'import platform; print(platform.python_version())')"
android_api_level="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1])).termuxPython.androidApiLevel" "$toolchain_file")"

if [[ "$actual_uv" != "$uv_version" ]]; then
	echo "expected uv $uv_version, found $actual_uv" >&2
	exit 1
fi
python - "$actual_python" "$python_minimum" "$python_maximum" <<'PY'
import sys

actual, minimum, maximum = (tuple(map(int, value.split("."))) for value in sys.argv[1:])
if not minimum <= actual < maximum:
    raise SystemExit(f"Termux Python {actual} is outside >={minimum},<{maximum}")
PY
if [[ "${PRIME_AGENT_TERMUX_VALIDATION:-0}" == "1" && "$actual_python" != "$validation_python" ]]; then
	echo "Termux validation Python changed: expected $validation_python, found $actual_python; review and refresh toolchain.json" >&2
	exit 1
fi

while IFS=$'\t' read -r system_package package_version distribution distribution_version; do
	actual_package_version="$(dpkg-query -W -f='${Version}' "$system_package")"
	if [[ "$actual_package_version" != "$package_version" ]]; then
		echo "expected $system_package $package_version, found $actual_package_version" >&2
		exit 1
	fi
	actual_distribution_version="$(python -c 'from importlib.metadata import version; import sys; print(version(sys.argv[1]))' "$distribution")"
	if [[ "$actual_distribution_version" != "$distribution_version" ]]; then
		echo "expected $distribution $distribution_version, found $actual_distribution_version" >&2
		exit 1
	fi
done < <(
	node -e '
const config = JSON.parse(require("fs").readFileSync(process.argv[1]));
for (const pkg of config.termuxPython.nativePackages) {
  console.log([pkg.systemPackage, pkg.packageVersion, pkg.distribution, pkg.version].join("\t"));
}
' "$toolchain_file"
)

mapfile -t build_requirements < <(
	node -e '
const config = JSON.parse(require("fs").readFileSync(process.argv[1]));
for (const requirement of config.termuxPython.buildRequirements) console.log(requirement);
' "$toolchain_file"
)

validation_dir="$(mktemp -d "${TMPDIR:-$PREFIX/tmp}/prime-agent-kernel.XXXXXX")"
trap 'rm -rf "$validation_dir"' EXIT

validate_environment() {
	local venv="$1"
	local offline="$2"
	ANDROID_API_LEVEL="$android_api_level" UV_OFFLINE="$offline" uv venv "$venv" --python "$(command -v python)" --seed --relocatable
	python "$project_dir/vendor_termux_packages.py" "$venv/bin/python"
	ANDROID_API_LEVEL="$android_api_level" UV_OFFLINE="$offline" uv pip install \
		--python "$venv/bin/python" \
		--constraint "$project_dir/constraints.txt" \
		"${build_requirements[@]}"
	ANDROID_API_LEVEL="$android_api_level" VIRTUAL_ENV="$venv" UV_OFFLINE="$offline" uv sync \
		--project "$project_dir" \
		--locked \
		--active \
		--no-dev \
		--no-install-project \
		--no-build-isolation-package pandas \
		--exclude-newer "$exclude_newer" \
		--python-platform aarch64-linux-android
	ANDROID_API_LEVEL="$android_api_level" UV_OFFLINE="$offline" uv pip install --python "$venv/bin/python" --no-build-isolation --no-deps "$runtime_dir"
	uv pip check --python "$venv/bin/python"
	"$venv/bin/python" -c 'import httpx, ipykernel, lxml, numpy, pandas, pydantic, rlm, scipy'
}

validate_environment "$validation_dir/online" false
validate_environment "$validation_dir/offline" true
echo "validated Termux/Bionic kernel bootstrap with Python $actual_python and uv $actual_uv"
