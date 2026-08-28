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
