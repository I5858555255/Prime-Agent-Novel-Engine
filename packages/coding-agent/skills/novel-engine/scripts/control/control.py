#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
novel-engine 生成控制脚本
========================
子命令:
  clean            清理生成记录(章节/运行时状态/审计/日志)，不会删除源码与配置
  start [章节数]   开始全量生成(默认读取 config 的 pipeline.total_chapters，0=读配置)
  stop             优雅停止生成(已完成章节不会丢失)
  resume           从最后一个已完成章节续写(自动探测)
  status           查看运行状态与最近日志
  setkey <key>     修改 src/novel_engine/.env 中的 ZLEAP_MODEL_API_KEY

说明:
  - 生成进程以后台方式启动，pid 保存在本脚本同级的 runtime_gen.pid。
  - start 默认会重置运行时(等同 clean 后再生成)；resume 不会重置，可断点续写。
  - 所有路径均相对于本文件位置自动推导，移动整个 skill 目录也可正常工作。
"""
import sys
import os
import time
import json
import shutil
import subprocess
from pathlib import Path

# 强制 stdout/stderr 为 UTF-8，避免中文在控制台乱码
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 路径推导: control.py 位于 <skill>/scripts/control/control.py
SKILL_DIR = Path(__file__).resolve().parent.parent.parent   # -> novel-engine
SRC_DIR = SKILL_DIR / "src"
NE = SRC_DIR / "novel_engine"
PYTHON = r"D:\Program Files\Python312\python.exe"
PID_FILE = SKILL_DIR / "runtime_gen.pid"          # 放在 skill 根，clean 不会清掉
LOG_FILE = NE / "runtime" / "logs" / "production.log"


def _is_running() -> bool:
    if not PID_FILE.exists():
        return False
    pid = PID_FILE.read_text(encoding="utf-8").strip()
    if not pid.isdigit():
        return False
    try:
        out = subprocess.run(
            ["tasklist", "/NH", "/FI", f"PID eq {pid}"],
            capture_output=True, text=True, timeout=10,
        ).stdout
        return pid in out
    except Exception:
        return False


def _last_chapter() -> int:
    novel_dir = NE / "chapters" / "novel"
    last = 0
    if novel_dir.exists():
        for f in novel_dir.glob("chapter_*.txt"):
            try:
                n = int(f.stem.split("_", 1)[1])
                last = max(last, n)
            except Exception:
                pass
    return last


def clean():
    if _is_running():
        print("生成进程正在运行，请先执行 stop 再 clean。")
        return
    root = NE
    files = [
        "runtime/checkpoint.json", "runtime/state_machine.json",
        "runtime/recovery_policy.json", "runtime/session_tree.json",
        "audit/per_chapter_reviews.json", "audit/production_report.json",
        "audit/mini_test_report.json", "memory/quality_memory.json",
    ]
    for rel in files:
        p = root / rel
        if p.exists():
            try:
                p.unlink()
                print("删除 %s" % p)
            except Exception as e:
                print("跳过 %s: %s" % (p, e))
    for d in ["chapters/novel", "chapters/synopsis", "chapters/outline",
              "memory/world_state", "memory/short_term", "memory/long_term",
              "memory/long_term/embeddings"]:
        p = root / d
        if p.exists():
            shutil.rmtree(p, ignore_errors=True)
        p.mkdir(parents=True, exist_ok=True)
    for d in ["runtime/backups"]:
        p = root / d
        if p.exists():
            shutil.rmtree(p, ignore_errors=True)
    sdb = root / "runtime" / "state.db"
    if sdb.exists():
        try:
            sdb.unlink()
        except Exception:
            pass
    logdir = root / "runtime" / "logs"
    if logdir.exists():
        for f in logdir.glob("*.log"):
            try:
                f.unlink()
            except Exception:
                pass
    print("已清理生成记录(章节/运行时状态/审计/日志)。源码与配置未动。")


def start(num_chapters: int = 0, resume: int = 0):
    if _is_running():
        print("生成进程已在运行 (pid 见 %s)。请先 stop。" % PID_FILE)
        return
    cmd = [PYTHON, "-m", "novel_engine.pipeline.production_runner",
           str(num_chapters), "1", str(resume), "--real"]
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    logf = open(str(LOG_FILE), "a", encoding="utf-8")
    # DETACHED_PROCESS: 子进程不依附于启动它的控制台，
    # 关闭窗口(CTRL_CLOSE)不会杀掉它，可后台长期运行。
    creationflags = getattr(subprocess, "DETACHED_PROCESS", 0)
    proc = subprocess.Popen(cmd, cwd=str(SRC_DIR),
                            stdout=logf, stderr=subprocess.STDOUT,
                            creationflags=creationflags)
    PID_FILE.write_text(str(proc.pid), encoding="utf-8")
    print("已启动生成 (pid=%s, resume=%s)。日志: %s" % (proc.pid, resume, LOG_FILE))
    print("查看进度: status.bat   |   停止: stop.bat   |   续写: resume.bat")


def stop():
    if not PID_FILE.exists():
        print("没有 pid 文件，无需停止。")
        return
    pid = PID_FILE.read_text(encoding="utf-8").strip()
    subprocess.run(["taskkill", "/PID", pid, "/T", "/F"],
                   capture_output=True, text=True)
    time.sleep(2)
    if PID_FILE.exists():
        PID_FILE.unlink()
    print("已发送停止信号。已完成章节不会丢失，可用 resume 续写。")


def resume():
    last = _last_chapter()
    print("探测到最后章节: %d" % last)
    start(num_chapters=0, resume=last)


def _current_chapter() -> int:
    """从日志末尾反推当前正在生成的章节号。"""
    if not LOG_FILE.exists():
        return 0
    try:
        lines = LOG_FILE.read_text(encoding="utf-8", errors="ignore").splitlines()
    except Exception:
        return 0
    cur = 0
    for l in reversed(lines):
        idx = l.find("GENERATING CHAPTER")
        if idx != -1:
            try:
                cur = int(l[idx:].split()[2].split("/")[0])
                break
            except Exception:
                pass
    return cur


def _last_score() -> str:
    """从日志末尾反推最近一次评审分数/结论。"""
    if not LOG_FILE.exists():
        return "-"
    try:
        lines = LOG_FILE.read_text(encoding="utf-8", errors="ignore").splitlines()
    except Exception:
        return "-"
    for l in reversed(lines):
        if "review:" in l or "Review completed" in l:
            return l.split("INFO]")[-1].strip()
    return "-"


def status():
    running = _is_running()
    pid = PID_FILE.read_text(encoding="utf-8").strip() if (PID_FILE.exists() and running) else "-"
    last = _last_chapter()
    cur = _current_chapter()
    print("=== novel-engine 状态 ===")
    print("运行: %s%s" % ("是 (pid=%s)" % pid if running else "否", ""))
    print("已完成章节: %d" % last)
    print("正在生成: 第 %d 章" % cur if cur else "正在生成: -")
    print("最近评审: %s" % _last_score())
    print("日志: %s" % LOG_FILE)
    if LOG_FILE.exists():
        try:
            lines = LOG_FILE.read_text(encoding="utf-8", errors="ignore").splitlines()
        except Exception:
            lines = []
        print("----- 最近 15 行日志 -----")
        for l in lines[-15:]:
            print(l)
    print("提示: 实时滚动请运行 tail.bat (Ctrl+C 退出)")


def follow():
    """实时滚动日志 (Ctrl+C 退出)。"""
    if _is_running():
        try:
            pid = PID_FILE.read_text(encoding="utf-8").strip()
        except Exception:
            pid = "?"
        print("状态: 运行中 (pid=%s)" % pid)
    else:
        print("状态: 未运行")
    print("已完成章节: %d" % _last_chapter())
    print("日志: %s" % LOG_FILE)
    print("=== 实时滚动 (Ctrl+C 退出) ===")
    try:
        import os
        with open(str(LOG_FILE), "r", encoding="utf-8", errors="ignore") as f:
            size = os.path.getsize(str(LOG_FILE)) if LOG_FILE.exists() else 0
            f.seek(max(0, size - 4000))   # 从末尾附近开始
            f.readline()                  # 丢弃可能半截的首行
            while True:
                line = f.readline()
                if line:
                    print(line.rstrip("\n"))
                else:
                    time.sleep(0.5)
    except KeyboardInterrupt:
        print("\n已退出实时日志。")


def setkey(key: str):
    envf = NE / ".env"
    lines = envf.read_text(encoding="utf-8").splitlines() if envf.exists() else []
    out, found = [], False
    for l in lines:
        if l.startswith("ZLEAP_MODEL_API_KEY="):
            out.append("ZLEAP_MODEL_API_KEY=%s" % key)
            found = True
        else:
            out.append(l)
    if not found:
        out.append("ZLEAP_MODEL_API_KEY=%s" % key)
    envf.write_text("\n".join(out).rstrip("\n") + "\n", encoding="utf-8")
    print("已更新 API KEY -> %s" % envf)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    if cmd == "clean":
        clean()
    elif cmd == "start":
        n = int(sys.argv[2]) if len(sys.argv) > 2 else 0
        start(num_chapters=n)
    elif cmd == "stop":
        stop()
    elif cmd == "resume":
        resume()
    elif cmd == "status":
        status()
    elif cmd == "follow":
        follow()
    elif cmd == "setkey":
        if len(sys.argv) < 3:
            print("用法: setkey <新的API_KEY>")
            return
        setkey(sys.argv[2])
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
