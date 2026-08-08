from __future__ import annotations

import base64
import csv
import hashlib
import json
import shutil
import subprocess
import sys
from importlib.metadata import distribution
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: vendor_termux_packages.py <venv-python>")

    toolchain = json.loads(Path(__file__).with_name("toolchain.json").read_text())
    native_packages = toolchain["termuxPython"]["nativePackages"]
    android_tag = f"android_{toolchain['termuxPython']['androidApiLevel']}_arm64_v8a"
    target_python = sys.argv[1]
    target_site = Path(
        subprocess.check_output(
            [target_python, "-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
            text=True,
        ).strip()
    ).resolve()

    for package in native_packages:
        dist = distribution(package["distribution"])
        if dist.version != package["version"]:
            raise SystemExit(
                f"expected {package['distribution']} {package['version']}, found {dist.version}"
            )
        source_site = Path(dist.locate_file("")).resolve()
        files = list(dist.files or ())
        dist_info = next(
            (
                relative_file.parent
                for relative_file in files
                if relative_file.name == "METADATA"
                and relative_file.parent.name.endswith(".dist-info")
            ),
            None,
        )
        if dist_info is None:
            raise SystemExit(f"{package['distribution']} has no dist-info metadata")
        direct_url = dist_info / "direct_url.json"
        for relative_file in files:
            if relative_file.name == "direct_url.json" and any(
                part.endswith(".dist-info") for part in relative_file.parts
            ):
                continue
            source = Path(dist.locate_file(relative_file)).resolve()
            if not source.is_relative_to(source_site):
                raise SystemExit(f"refusing to copy {source} outside {source_site}")
            destination = (target_site / source.relative_to(source_site)).resolve()
            if not destination.is_relative_to(target_site):
                raise SystemExit(f"refusing to write {destination} outside {target_site}")
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination, follow_symlinks=False)

        wheel_path = target_site / dist_info / "WHEEL"
        record_path = target_site / dist_info / "RECORD"
        wheel = wheel_path.read_text()
        if "android_aarch64" not in wheel:
            raise SystemExit(f"{package['distribution']} has an unexpected Android wheel tag")
        wheel = wheel.replace("android_aarch64", android_tag)
        wheel_path.write_text(wheel)
        wheel_bytes = wheel.encode()
        wheel_hash = base64.urlsafe_b64encode(hashlib.sha256(wheel_bytes).digest()).rstrip(b"=").decode()

        with record_path.open(newline="") as record_file:
            rows = list(csv.reader(record_file))
        with record_path.open("w", newline="") as record_file:
            writer = csv.writer(record_file, lineterminator="\n")
            for row in rows:
                if row[0] == direct_url.as_posix():
                    continue
                if row[0] == (dist_info / "WHEEL").as_posix():
                    row[1:] = [f"sha256={wheel_hash}", str(len(wheel_bytes))]
                writer.writerow(row)


if __name__ == "__main__":
    main()
