import json, time, os, sys

# make novel_engine importable when run as a script
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from novel_engine.core.model_router import ModelRouter

def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true", help="list models and exit without calling the API")
    args = ap.parse_args()

    cfg = json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config", "runtime_config.json"), encoding="utf-8"))
    models = sorted({m for ph in cfg["model_router"]["phases"].values() for m in ph})
    if args.dry:
        print("Would probe:", models)
        return
    out = {}
    for m in models:
        mr = ModelRouter("probe", {"model_router": {"phases": {"probe": [m]}, "limits": {m: {"rpm": 1000, "tpm": 100000}}}})
        start = time.monotonic(); n = 0; toks = 0
        while time.monotonic() - start < 55:
            try:
                mr.chat_completion([{"role": "user", "content": "hi"}], max_tokens=1)
                n += 1; toks += 1
            except Exception:
                break
        out[m] = {"observed_rpm": n, "observed_tpm": toks}
        print(m, out[m])
    os.makedirs("runtime", exist_ok=True)
    json.dump(out, open("runtime/ratelimit_probe.json", "w"), ensure_ascii=False, indent=2)

if __name__ == "__main__":
    main()
