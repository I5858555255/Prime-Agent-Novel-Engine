import threading
from .llm_client import LLMClient
from .rate_limiter import ModelRateLimiter, RateLimitError

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
        # Graceful fallback for minimal mock configs (e.g., tests with {"llm":{"use_mock":true}})
        llm_cfg = cfg.get("llm") or {}
        if llm_cfg.get("use_mock"):
            mock = LLMClient(use_mock=True)
            phases = cfg.get("model_router", {}).get("phases", {}) or {}
            if not phases:
                phases = {"scenes": ["mock"], "polish": ["mock"], "planning": ["mock"], "review": ["mock"]}
            for phase, models in phases.items():
                for m in models:
                    out[m] = mock
            out.setdefault("mock", mock)
            out.setdefault("agnes-2.5-flash", mock)
            return out
        base = llm_cfg.get("api_base")
        if not base:
            return out
        key = os.environ.get(llm_cfg.get("api_key_env", "ZLEAP_MODEL_API_KEY"), "")
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
                        retry_on_error=True, max_retries=3, timeout=None):
        est = int(max_tokens or 2000)
        # P0-API: POLISH 等单步加 15min 看门狗由上层保证；此处对 Server disconnected 快速切模型，不在同一模型上空转 3 次
        candidates = list(self.models) or ["agnes-2.5-flash"]
        last_err = None
        # 对 POLISH 强制缩短重试次数，避免 5min*3 空转
        effective_retries = 2 if self.phase == "polish" else max_retries
        for attempt in range(max(1, len(candidates)) * max(1, effective_retries)):
            model = candidates[attempt % len(candidates)]
            lim = self.limiters.get(model)
            client = self.providers.get(model)
            if client is None:
                continue
            try:
                if lim:
                    lim.acquire(est)
                # 透传 timeout 给 LLMClient，POLISH 用 90s 快速失败
                kwargs = {}
                if timeout is not None:
                    kwargs["timeout"] = timeout
                result = client.chat_completion(messages, temperature=temperature, max_tokens=max_tokens, extra_body=extra_body, **kwargs)
                if lim:
                    lim.report_success()
                if isinstance(result, dict):
                    result["_model_used"] = model
                return result
            except RateLimitError:
                if lim:
                    lim.report_429()
                last_err = f"rate_limited:{model}"
                continue
            except Exception as e:
                msg = str(e)
                # Server disconnected / 401 鉴权等快速切下一个模型，不在同一模型上重试
                if "Server disconnected" in msg or "RemoteProtocolError" in msg or "Token is invalid" in msg or "401" in msg:
                    last_err = f"fast-fail {model}: {msg[:120]}"
                    continue
                last_err = msg
                continue
        raise RuntimeError(f"ModelRouter phase={self.phase} exhausted candidates: {last_err}")
