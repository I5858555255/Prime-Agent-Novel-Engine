#!/data/data/com.termux/files/usr/bin/bash

set -euo pipefail

uv_version="0.11.33"
uv_sha256="81911281e0f2fe5307c0b85e884f47cb6ca867932fb61871d339854edf3b4dcc"
build_dir="$(mktemp -d "${TMPDIR:-$PREFIX/tmp}/prime-agent-uv.XXXXXX")"
trap 'rm -rf "$build_dir"' EXIT

curl -fL "https://github.com/astral-sh/uv/archive/refs/tags/$uv_version.tar.gz" -o "$build_dir/uv.tar.gz"
printf '%s  %s\n' "$uv_sha256" "$build_dir/uv.tar.gz" | sha256sum -c -
tar -xzf "$build_dir/uv.tar.gz" -C "$build_dir"
PKG_CONFIG_ALL_DYNAMIC=1 \
ZSTD_SYS_USE_PKG_CONFIG=1 \
CARGO_PROFILE_RELEASE_LTO=false \
CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 \
cargo build \
	--manifest-path "$build_dir/uv-$uv_version/Cargo.toml" \
	--locked \
	--jobs "${PRIME_AGENT_TERMUX_BUILD_JOBS:-2}" \
	--package uv \
	--bins \
	--no-default-features \
	--features uv-distribution/static \
	--release \
	--target aarch64-linux-android
mkdir -p "$HOME/.local/bin"
install -m 700 "$build_dir/uv-$uv_version/target/aarch64-linux-android/release/uv" "$HOME/.local/bin/uv"
install -m 700 "$build_dir/uv-$uv_version/target/aarch64-linux-android/release/uvx" "$HOME/.local/bin/uvx"
"$HOME/.local/bin/uv" --version
