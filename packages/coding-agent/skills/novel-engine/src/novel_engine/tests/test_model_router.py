from core.model_router import ModelRouter

def _fake_client(text):
    class C:
        def chat_completion(self, messages, **k):
            return text
    return C()

def test_router_picks_first_with_capacity():
    cfg = {
        "model_router": {
            "phases": {"scenes": ["M1", "M2"]},
            "limits": {"M1": {"rpm": 1000, "tpm": 100000}, "M2": {"rpm": 1000, "tpm": 100000}},
        }
    }
    providers = {"M1": _fake_client("A"), "M2": _fake_client("B")}
    r = ModelRouter("scenes", cfg, providers)
    assert r.chat_completion([{"role": "user", "content": "x"}]) == "A"

def test_router_falls_to_next_on_429():
    class C429:
        def chat_completion(self, messages, **k):
            from core.rate_limiter import RateLimitError
            raise RateLimitError("429")
    class Cok:
        def chat_completion(self, messages, **k):
            return "ok"
    cfg = {
        "model_router": {
            "phases": {"scenes": ["M1", "M2"]},
            "limits": {"M1": {"rpm": 1000, "tpm": 100000}, "M2": {"rpm": 1000, "tpm": 100000}},
        }
    }
    r = ModelRouter("scenes", cfg, {"M1": C429(), "M2": Cok()})
    assert r.chat_completion([{"role": "user", "content": "x"}]) == "ok"
