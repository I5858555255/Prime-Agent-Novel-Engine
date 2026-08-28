import time
from core.rate_limiter import ModelRateLimiter, RateLimitError

def test_acquire_blocks_until_window_rolls():
    lim = ModelRateLimiter(rpm=2, tpm=1000)
    lim.acquire(400)
    lim.acquire(400)
    start = time.monotonic()
    lim.acquire(400)          # must wait for next 60s window
    assert time.monotonic() - start >= 55

def test_report_429_shrinks_tpm():
    lim = ModelRateLimiter(rpm=1000, tpm=100000)
    lim.report_429()
    assert lim.tpm == 75000


def test_llm_client_raises_rate_limit():
    import httpx
    from core.llm_client import LLMClient, RateLimitError

    class _FakeResp:
        status_code = 429
        text = "rate limited"
        def raise_for_status(self):
            raise httpx.HTTPStatusError("rate", request=None, response=self)
        def json(self):
            return {}

    class _FakeClient:
        def post(self, *args, **kwargs):
            return _FakeResp()

    c = LLMClient()
    c._local.client = _FakeClient()
    raised = False
    try:
        c.chat_completion([{"role": "user", "content": "x"}])
    except RateLimitError:
        raised = True
    assert raised, "expected RateLimitError"
