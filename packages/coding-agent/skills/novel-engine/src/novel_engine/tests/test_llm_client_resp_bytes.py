"""hermetic 回归：_resp_bytes 在 httpx 流式非 200 响应上必须先 read() 再取 content。

背景：httpx 新版 Response.content property 在流式模式（client.stream）未调用 read()
前访问会抛 RuntimeError("Attempted to access streaming response content, without
having called `read()`.")，导致 _stream_chat 非 200 分支把真实的 429/5xx 状态错误
掩盖成协议错误，整章被 directing_error 硬拦截（run_676 ch658-676 连续 19 章 FAILED）。
"""

import pytest

from novel_engine.core.llm_client import LLMClient


class _StreamingResp:
    """模拟 httpx 流式 Response：read() 返回错误体；content property 未读前抛 RuntimeError。"""

    def __init__(self, payload: bytes):
        self._payload = payload
        self.read_called = False

    def read(self) -> bytes:
        self.read_called = True
        return self._payload

    @property
    def content(self) -> bytes:
        raise RuntimeError(
            "Attempted to access streaming response content, "
            "without having called `read()`."
        )


class _LegacyContentResp:
    """模拟旧测试 fake：无 read，直接暴露 _content。"""

    _content = b'{"error": "boom"}'


class _ReadFailContentResp:
    """read() 抛异常但 _content 存在：应回退 _content 而不是崩溃。"""

    _content = b'{"error": "fallback"}'

    def read(self) -> bytes:
        raise RuntimeError("socket closed")


def test_streaming_resp_read_first():
    """流式响应：先 read() 取错误体，不触发 content property RuntimeError。"""
    payload = b'{"error": "rate limited"}'
    r = _StreamingResp(payload)
    out = LLMClient._resp_bytes(r)
    assert out == payload
    assert r.read_called is True


def test_streaming_resp_matches_httpx_runtime_error():
    """未 read 前访问 content 应复现 httpx 的 RuntimeError（防护有效的前提）。"""
    r = _StreamingResp(b"x")
    with pytest.raises(RuntimeError, match="streaming response content"):
        _ = r.content


def test_legacy_fake_without_read():
    """无 read 的 fake：走 _content 属性路径。"""
    r = _LegacyContentResp()
    assert LLMClient._resp_bytes(r) == r._content


def test_read_fails_falls_back_to_content():
    """read() 抛异常：回退 _content，不把异常冒出去。"""
    r = _ReadFailContentResp()
    assert LLMClient._resp_bytes(r) == r._content


def test_empty_resp_returns_empty_bytes():
    """完全空响应：返回 b"" 而非崩溃。"""

    class _Empty:
        pass

    assert LLMClient._resp_bytes(_Empty()) == b""
