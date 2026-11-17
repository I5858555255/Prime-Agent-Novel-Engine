"""Detached no-proxy launcher for long batch generation.

Spawns `run_volume` (or any python module) as a detached background process
with all proxy environment variables stripped, and a stdout wrapper log.
The LLM outbound layer (httpx) reads HTTP(S)_PROXY; when the Clash proxy at
127.0.0.1:7897 is down every call fails with "Invalid port: ':1]'" while the
urllib-based preflight check still passes. So ALL batch launches must go
through this launcher (or an equivalent env-clean path).

Usage (from the package `src/` directory):

    python -X utf8 -m novel_engine.scripts.noproxy_launcher \
        --chapters 3490 [--resume] [--stdout-log <path>]

The launched process is detached (DETACHED | NO_WINDOW); re-launch is safe:
if a run_volume process is already alive this script reports it and exits 0.
API keys are NOT passed on argv; run_volume loads them from `.env` itself.
"""
from __future__ import annotations

import argparse
import datetime
import os
import subprocess
import sys
from pathlib import Path

# Proxy vars to strip (upper + lower case groups). DSH sessions inject
# HTTP_PROXY/HTTPS_PROXY pointing at a local Clash instance that is often
# down; httpx honors these, urllib (run_volume preflight) does not.
PROXY_VARS = (
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
)

_DETACHED = 0x00000008
_NO_WINDOW = 0x08000000


def find_existing_run_volume() -> int | None:
    """Return the pid of a live run_volume process, or None."""
    try:
        import psutil
    except ImportError:
        print("psutil not available; cannot detect existing run_volume. "
              "Check manually (Get-CimInstance Win32_Process) before launching.")
        return None
    for proc in psutil.process_iter(["name", "cmdline"]):
        try:
            name = (proc.info["name"] or "").lower()
            if "python" not in name:
                continue
            cmd = " ".join(proc.info["cmdline"] or [])
            if "novel_engine.scripts.run_volume" in cmd:
                return proc.pid
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return None


def clean_env() -> dict[str, str]:
    return {k: v for k, v in os.environ.items() if k not in PROXY_VARS}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chapters", type=int, required=True,
                        help="run_volume --chapters target")
    parser.add_argument("--resume", action="store_true",
                        help="pass --resume to run_volume")
    parser.add_argument("--stdout-log", default=None,
                        help="wrapper log path; default run_noproxy_<ts>.log "
                             "in the system temp dir")
    parser.add_argument("--python", default=None,
                        help="python interpreter; default: the running "
                             "interpreter (sys.executable)")
    args = parser.parse_args(argv)

    existing = find_existing_run_volume()
    if existing:
        print(f"run_volume already running (pid {existing}); nothing to do. "
              f"Kill it first if a restart is intended (and stop the "
              f"watchdog BEFORE the generator).")
        return 0

    src_root = Path(__file__).resolve().parents[2]
    py = args.python or sys.executable
    ts = datetime.datetime.now().strftime("%Y%m%dT%H%M%SZ")
    out_log = Path(args.stdout_log) if args.stdout_log else \
        Path(os.environ.get("TEMP", ".")) / f"run_noproxy_{ts}.log"

    cmd = [py, "-X", "utf8", "-m", "novel_engine.scripts.run_volume",
           "--chapters", str(args.chapters)]
    if args.resume:
        cmd.append("--resume")

    out_log.parent.mkdir(parents=True, exist_ok=True)
    with open(out_log, "a", encoding="utf-8") as fh:
        fh.write(f"\n=== noproxy launch target={args.chapters} "
                 f"{datetime.datetime.now().isoformat()} ===\n")
    fh = open(out_log, "a", encoding="utf-8")
    proc = subprocess.Popen(
        cmd,
        cwd=str(src_root),
        stdout=fh,
        stderr=subprocess.STDOUT,
        creationflags=_DETACHED | _NO_WINDOW,
        env=clean_env(),
    )
    print(f"launched run_volume pid={proc.pid} target={args.chapters} "
          f"stdout={out_log} (proxy vars stripped)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
