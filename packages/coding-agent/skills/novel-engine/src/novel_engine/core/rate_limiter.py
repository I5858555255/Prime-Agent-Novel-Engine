import time
import threading

class RateLimitError(Exception):
    pass

class ModelRateLimiter:
    def __init__(self, rpm: int = 1000, tpm: int = 100_000):
        self.rpm = rpm
        self.tpm = tpm
        self._lock = threading.Lock()
        self._requests = 0.0
        self._tokens = 0.0
        self._win_start = time.monotonic()
        self._minute = 60.0
        self._floor_tpm = 10_000

    def _refill(self, now):
        if now - self._win_start >= self._minute:
            self._win_start = now
            self._requests = 0.0
            self._tokens = 0.0

    def acquire(self, est_tokens: int):
        while True:
            with self._lock:
                now = time.monotonic()
                self._refill(now)
                if self._requests + 1 <= self.rpm and self._tokens + est_tokens <= self.tpm:
                    self._requests += 1
                    self._tokens += est_tokens
                    return
                wait = max(0.1, self._minute - (now - self._win_start))
            time.sleep(wait)

    def report_429(self):
        with self._lock:
            self.tpm = max(self._floor_tpm, int(self.tpm * 0.75))

    def report_success(self):
        with self._lock:
            pass
