"""Relay watchdog for multi-batch generation (config-driven, no hardcodes).

Watches a live `run_volume` process: when it exits before reaching its
target, the watchdog relaunches it. The next target follows this rule:

- progress (largest contiguous completed-or-skipped chapter) < target
  -> relaunch the same target (mid-batch interruption);
- progress >= target and an approved mid-outline covers further
  -> advance target to the approved mid-outline end (the outline must
     lead generation by at least one slice);
- progress >= approved coverage
  -> advance one --loose-step slice past progress (loose reference;
     a log note reminds that the mid-outline should be extended);
- progress >= --final-cap -> exit 0 (all work done).

Stall policy: three relaunches of the SAME target with no movement in the
maximum completed chapter -> exit 1 (a livelocked chapter blocks both the
contiguous frontier and the max-progress test; remedy = mark the chapter
skipped, then relaunch the watchdog).

Concurrency guard: the watchdog takes a heartbeat lock file
(default `runtime/relay_watchdog.lock.json`, holding pid + start ts). A
second instance that finds a *live* owner refuses to start, so two
watchdogs can never relay the same checkpoint (the 2026-11-09 double-run
incident, which violated the single-batch rule, happened before this lock
existed). A stale lock (owner pid dead) is taken over automatically.

Launches use a detached process with all proxy env vars stripped (the
httpx LLM layer honors HTTP(S)_PROXY; a dead Clash proxy makes every call
fail with "Invalid port"). Run it itself via `pythonw` (no console window).

Usage (from the package `src/` directory):

    pythonw -X utf8 -m novel_engine.scripts.relay_watchdog \
        --final-cap 3800 [--initial-target 1846] [--poll 120]

Logs to --relay-log (default %TEMP%\\relay_watchdog.log) and appends launch
banners to --stdout-log (default %TEMP%\\run_relay_watchdog.log).
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = Path(__file__).resolve().parents[2]
CHECKPOINT = ROOT / "runtime" / "checkpoint.json"
PLANNING = ROOT / "config" / "planning"
_LOCK = ROOT / "runtime" / "relay_watchdog.lock.json"

PROXY_VARS = (
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
)
if os.name == "nt":
    _DETACHED = 0x00000008
    _NO_WINDOW = 0x08000000
    _LAUNCH_FLAGS = _DETACHED | _NO_WINDOW
else:
    # POSIX: spawn detached via setsid so a killed shell can't take the
    # generator down; stdout still goes to the wrapper log file.
    _LAUNCH_FLAGS = 0


def clean_env() -> dict[str, str]:
    return {k: v for k, v in os.environ.items() if k not in PROXY_VARS}


def log(msg: str, path: Path) -> None:
    stamp = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(f"{stamp} [relay] {msg}\n")


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        # alive but owned by another user
        return True
    except OSError:
        return False


def _psutil_pid_alive(pid: int) -> bool | None:
    """psutil-based liveness (None = psutil unavailable)."""
    try:
        import psutil
    except ImportError:
        return None
    return psutil.pid_exists(pid)


def acquire_lock() -> None:
    """Single-instance lock; stale locks (dead owner pid) are taken over.

    Liveness is checked with os.kill(0) + psutil.pid_exists when
    available (a pid can be reused by an unrelated process; the lock
    file's started-timestamp narrows that window). Cross-process safety
    note: the create-then-read window is small but non-atomic on
    Windows; two watchdogs started within milliseconds can both acquire.
    The operational discipline (start one watchdog, verify with
    `Get-CimInstance` before starting another) covers that residual
    race; the lock blocks the common case of a stale double-start.
    """
    LOCK = _LOCK
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    if LOCK.exists():
        try:
            owner = json.loads(LOCK.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            owner = {}
        owner_pid = int(owner.get("pid", 0))
        if owner_pid:
            alive = _pid_alive(owner_pid)
            ps_alive = _psutil_pid_alive(owner_pid)
            if alive and (ps_alive is None or ps_alive):
                raise SystemExit(
                    f"relay_watchdog already running (pid {owner_pid}, "
                    f"lock {LOCK}); kill it first if a restart is intended")
        log(f"taking over stale lock (owner pid {owner_pid} not alive)",
            _RELAY_LOG)
    LOCK.write_text(json.dumps({
        "pid": os.getpid(),
        "started": datetime.datetime.now().isoformat(timespec="seconds"),
    }), encoding="utf-8")


def release_lock() -> None:
    try:
        if _LOCK.exists():
            owner = json.loads(_LOCK.read_text(encoding="utf-8"))
            if int(owner.get("pid", -1)) == os.getpid():
                _LOCK.unlink()
    except (OSError, json.JSONDecodeError, ValueError):
        pass


_RELAY_LOG: Path = Path(os.environ.get("TEMP", ".")) / "relay_watchdog.log"


def live_run_volume_pid() -> int:
    try:
        import psutil
    except ImportError:
        return 0
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
    return 0


def read_max_progress() -> int:
    """Largest completed-or-skipped chapter.

    Used for the stall test only: a single stuck-failing chapter must not
    look like "no progress" while later chapters keep committing.
    """
    data = json.loads(CHECKPOINT.read_text(encoding="utf-8"))
    nums = {e["chapter"] for e in data.get("checkpoints", [])
            if e.get("complete") and isinstance(e.get("chapter"), int)}
    nums |= {int(c) for c in data.get("skipped_chapters", [])}
    return max(nums) if nums else 0


def read_progress() -> int:
    """Largest contiguous completed-or-skipped chapter (first gap above it)."""
    data = json.loads(CHECKPOINT.read_text(encoding="utf-8"))
    complete = {e["chapter"] for e in data.get("checkpoints", [])
                if e.get("complete") and isinstance(e.get("chapter"), int)}
    complete |= {int(c) for c in data.get("skipped_chapters", [])}
    n = 1
    while n in complete:
        n += 1
    return n - 1


def approved_mid_outline_end() -> int:
    """Largest ch_end whose mid-outline file has meta.status == approved."""
    best = 0
    if not PLANNING.is_dir():
        return 0
    for name in os.listdir(PLANNING):
        if not (name.startswith("mid_outline_") and name.endswith(".json")):
            continue
        m = re.search(r"_ch(\d+)-(\d+)\.json$", name)
        if not m:
            continue
        ch_end = int(m.group(2))
        try:
            meta = json.loads(
                (PLANNING / name).read_text(encoding="utf-8")).get("meta", {})
        except (OSError, json.JSONDecodeError):
            continue
        if meta.get("status") == "approved":
            best = max(best, ch_end)
    return best


def next_target(progress: int, target: int, final_cap: int,
                loose_step: int, log_path: Path) -> int:
    if progress >= final_cap:
        return final_cap
    if progress < target:
        return target
    covered = approved_mid_outline_end()
    if covered and covered > progress:
        return covered
    nxt = min(progress + loose_step, final_cap)
    log(f"note: next batch target {nxt} exceeds approved mid-outline end "
        f"{covered}; chapters past that run on loose reference until the "
        f"mid-outline is extended", log_path)
    return nxt


def launch(target: int, out_log: Path, python: str) -> int:
    with open(out_log, "a", encoding="utf-8") as fh:
        fh.write(f"\n=== relay launch target={target} "
                 f"{datetime.datetime.now().isoformat()} ===\n")
    fh = open(out_log, "a", encoding="utf-8")
    cmd = [python, "-X", "utf8", "-m", "novel_engine.scripts.run_volume",
           "--chapters", str(target), "--resume"]
    if os.name == "nt":
        proc = subprocess.Popen(
            cmd,
            cwd=str(SRC),
            stdout=fh,
            stderr=subprocess.STDOUT,
            creationflags=_LAUNCH_FLAGS,
            env=clean_env(),
        )
    else:
        # POSIX: setsid-style detach via start_new_session; no window flags.
        proc = subprocess.Popen(
            cmd,
            cwd=str(SRC),
            stdout=fh,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            env=clean_env(),
        )
    return proc.pid


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--final-cap", type=int, required=True,
                        help="chapter cap; exit 0 when progress reaches it")
    parser.add_argument("--initial-target", type=int, default=0,
                        help="first batch target (0 = auto from coverage)")
    parser.add_argument("--poll", type=int, default=120,
                        help="seconds between liveness checks")
    parser.add_argument("--loose-step", type=int, default=30,
                        help="batch size beyond approved mid-outline coverage")
    parser.add_argument("--relay-log", default=None,
                        help="watchdog log; default relay_watchdog.log in "
                             "the system temp dir")
    parser.add_argument("--stdout-log", default=None,
                        help="launch wrapper log; default "
                             "run_relay_watchdog.log in the system temp dir")
    parser.add_argument("--python", default=sys.executable,
                        help="interpreter used to launch run_volume")
    parser.add_argument("--no-lock", action="store_true",
                        help="skip the single-instance lock (testing)")
    args = parser.parse_args(argv)

    relay_log = Path(args.relay_log) if args.relay_log else \
        Path(os.environ.get("TEMP", ".")) / "relay_watchdog.log"
    out_log = Path(args.stdout_log) if args.stdout_log else \
        Path(os.environ.get("TEMP", ".")) / "run_relay_watchdog.log"

    # Single-instance guard (heartbeat lock): refuse to start if another
    # live watchdog owns the checkpoint; take over stale locks.
    global _RELAY_LOG
    _RELAY_LOG = relay_log
    if not args.no_lock:
        acquire_lock()

    target = args.initial_target or approved_mid_outline_end()
    if target == 0:
        target = args.final_cap
    log(f"autorelay start initial_target={target} final_cap={args.final_cap} "
        f"pid={os.getpid()}", relay_log)

    stall = 0
    seen_target = 0
    seen_max = -1
    beat = 0
    heartbeat = 0
    try:
        while target <= args.final_cap:
            pid = live_run_volume_pid()
            if pid:
                beat += 1
                if beat % 10 == 1:
                    log(f"waiting for run_volume pid={pid} target={target} "
                        f"(beat {beat})", relay_log)
                time.sleep(args.poll)
                continue
            try:
                progress = read_progress()
            except Exception as exc:
                log(f"checkpoint read failed: {exc!r}", relay_log)
                time.sleep(args.poll)
                continue
            log(f"no run_volume alive; progress={progress} target={target}",
                relay_log)
            if progress >= args.final_cap:
                log(f"FINAL CAP {args.final_cap} reached, autorelay exit",
                    relay_log)
                return 0
            new_target = next_target(progress, target, args.final_cap,
                                     args.loose_step, relay_log)
            if new_target != target:
                log(f"batch advance: target {target} -> {new_target} "
                    f"(progress={progress})", relay_log)
                target = new_target
            # Stall only counts when the SAME target is relaunched three
            # times in a row without any max-progress movement (advancing
            # target resets the counter).
            max_done = read_max_progress()
            if target == seen_target and max_done == seen_max:
                stall += 1
            else:
                stall = 0
            seen_target = target
            seen_max = max_done
            if stall >= 3:
                log(f"no progress across 3 relaunches of target={target}; "
                    f"autorelay exit", relay_log)
                return 1
            try:
                new_pid = launch(target, out_log, args.python)
                log(f"launched pid={new_pid} target={target}", relay_log)
            except Exception as exc:
                log(f"launch failed: {exc!r}", relay_log)
                stall += 1
            # heartbeat: refresh the lock's mtime so an external monitor
            # can tell a live watchdog from a crashed one.
            heartbeat += 1
            if heartbeat % 10 == 1:
                _LOCK.touch()
            time.sleep(args.poll)
    finally:
        if not args.no_lock:
            release_lock()
    return 0


if __name__ == "__main__":
    sys.exit(main())
