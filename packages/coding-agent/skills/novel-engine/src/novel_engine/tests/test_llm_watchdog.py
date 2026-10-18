"""LLMClient watchdog：防止代理半开连接导致 LLM 调用永久阻塞流水线。

根因：上游/本地代理（如 127.0.0.1:7897）断连后半开连接（CLOSE_WAIT、无数据无 EOF）
时，httpx 的 read/idle/total 超时可能均不触发，chat_completion 永久阻塞，整个
run_volume 批次挂死（ch370/ch584 实录）。watchdog 将调用放入 daemon 线程并施加
wall-clock 上限，超时抛 TransientLLMError 交由上层重试/降级/跳过。

hermetic：全部用 monkeypatch 替代 _one_chat_attempt，无真实网络请求。
"""
import time

import pytest

from novel_engine.core.llm_client import LLMClient
from novel_engine.core.errors import TransientLLMError


def _make_client() -> LLMClient:
    return LLMClient(api_base="https://mock.invalid", model="mock/model", api_key="x")


def _cjk_text(n: int = 30) -> str:
    return "这是一段足够长的中文正文用于通过退化分类判定。" * n


def test_watchdog_aborts_blocked_call():
    """阻塞的底层调用在 watchdog 上限内被放弃并抛 TransientLLMError。"""
    c = _make_client()

    def _blocked(*a, **k):
        time.sleep(30)
        return {"content": _cjk_text()}

    c._one_chat_attempt = _blocked  # type: ignore[assignment]
    start = time.monotonic()
    with pytest.raises(TransientLLMError) as ei:
        c.chat_completion(
            [{"role": "user", "content": "生成正文"}],
            watchdog_s=1,
            retry_on_error=False,
        )
    elapsed = time.monotonic() - start
    assert "watchdog" in str(ei.value)
    assert elapsed < 10  # 不被底层 sleep(30) 拖住


def test_watchdog_passes_fast_call_through():
    """正常快速返回不受 watchdog 影响，结果原样透传。"""
    c = _make_client()

    def _fast(*a, **k):
        return {"content": _cjk_text(), "finish_reason": "stop"}

    c._one_chat_attempt = _fast  # type: ignore[assignment]
    out = c.chat_completion(
        [{"role": "user", "content": "生成正文"}],
        watchdog_s=30,
        retry_on_error=False,
    )
    assert out["content"].startswith("这是一段")


def test_watchdog_rethrows_worker_exception():
    """worker 内异常（含既有重试耗尽路径）原样回传，不吞不换。"""
    c = _make_client()

    def _boom(*a, **k):
        raise TransientLLMError("boom-from-underlying", phase="writer")

    c._one_chat_attempt = _boom  # type: ignore[assignment]
    with pytest.raises(TransientLLMError) as ei:
        c.chat_completion(
            [{"role": "user", "content": "生成正文"}],
            watchdog_s=10,
            retry_on_error=False,
        )
    assert "boom-from-underlying" in str(ei.value)


def test_watchdog_disabled_when_zero():
    """watchdog_s=0 显式禁用：直接同步执行（底层异常原样抛）。"""
    c = _make_client()

    def _boom(*a, **k):
        raise TransientLLMError("sync-path", phase="writer")

    c._one_chat_attempt = _boom  # type: ignore[assignment]
    with pytest.raises(TransientLLMError) as ei:
        c.chat_completion(
            [{"role": "user", "content": "生成正文"}],
            watchdog_s=0,
            retry_on_error=False,
        )
    assert "sync-path" in str(ei.value)


def test_watchdog_default_bound_positive():
    """默认上限 = effective_total(max_tokens) + slack，为正且足够覆盖长生成。"""
    c = _make_client()
    from novel_engine.core.llm_client import TimeoutSpec

    spec = TimeoutSpec()
    total = spec.effective_total(4096)
    assert total == 650  # min(650, ceil(4096/3)+60=1425)
    # 默认 watchdog 不阻塞正常路径
    def _fast(*a, **k):
        return {"content": _cjk_text()}

    c._one_chat_attempt = _fast  # type: ignore[assignment]
    out = c.chat_completion(
        [{"role": "user", "content": "生成正文"}],
        timeout_spec=spec,
        retry_on_error=False,
    )
    assert out["content"]
