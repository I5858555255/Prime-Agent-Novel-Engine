import threading
from core.llm_client import LLMClient
from core.rate_limiter import ModelRateLimiter, RateLimitError

class ModelRouter:
    def __init__(self, phase: str, cfg: dict, providers: dict = None):
        mr = cfg.get("model_router", {})
        self.phase = phase
        self.models = mr.get("phases", {}).get(phase, [])
        self.limits_cfg = mr.get("limits", {})
        self.providers = providers or self._build_providers(cfg)
        self.limiters = {
            m: ModelRateLimiter(**{k: int(v) for k, v in self.limits_cfg.get(m, {"rpm": 1000, "tpm": 100000}).items()})
            for m in self.models
        }
        self._lock = threading.Lock()

    @staticmethod
    def _build_providers(cfg: dict) -> dict:
        import os
        out = {}
        base = cfg["llm"]["api_base"]
        key = os.environ.get(cfg["llm"].get("api_key_env", "ZLEAP_MODEL_API_KEY"), "")
        def sf_model(model):
            c = LLMClient()
            c.model = model
            c.api_base = base
            c.api_key = key
            c.max_tokens = cfg["llm"].get("max_tokens", 12000)
            c.timeout = cfg["llm"].get("timeout_seconds", 120)
            return c
        for phase, models in cfg.get("model_router", {}).get("phases", {}).items():
            for m in models:
                out.setdefault(m, sf_model(m))
        rv = cfg.get("review_llm", {})
        if rv:
            ac = LLMClient()
            ac.model = rv["model"]
            ac.api_base = rv["api_base"]
            ac.api_key = os.environ.get(rv.get("api_key_env", "AGNES_API_KEY"), "")
            ac.max_tokens = rv.get("max_tokens", 4096)
            ac.timeout = rv.get("timeout_seconds", 60)
            out["agnes-2.5-flash"] = ac
        return out

    def chat_completion(self, messages, temperature=None, max_tokens=None, extra_body=None,
                        retry_on_error=True, max_retries=3):
        est = int(max_tokens or 2000)
        candidates = list(self.models) or ["agnes-2.5-flash"]
        last_err = None
        for attempt in range(max(1, len(candidates)) * max(1, max_retries)):
            model = candidates[attempt % len(candidates)]
            lim = self.limiters.get(model)
            client = self.providers.get(model)
            if client is None:
                continue
            try:
                if lim:
                    lim.acquire(est)
                result = client.chat_completion(messages, temperature=temperature, max_tokens=max_tokens, extra_body=extra_body)
                if lim:
                    lim.report_success()
                return result
            except RateLimitError:
                if lim:
                    lim.report_429()
                last_err = f"rate_limited:{model}"
                continue
            except Exception as e:
                last_err = str(e)
                continue
        raise RuntimeError(f"ModelRouter phase={self.phase} exhausted candidates: {last_err}")
