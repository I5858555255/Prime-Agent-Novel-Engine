# -*- coding: utf-8 -*-
"""CC ch584 回归：最终组装稿 latin 残片自动修复（_auto_fix_final_latin）。

ch584 归因：_run_latin_leak_gate 只修"进入该 gate 时的 scenes 快照"，后续
review/topup/Progression 等改写相位在最终稿重新注入拉丁残片（'barely'），而
final pre-commit gate 是 fail-closed 只检不修 -> quarantine+human 白费一轮。
修复：final 段对所有改写相位之后的定稿做一次全文级 latin 自动修复
（fix_latin_leak verify-then-trust：复检干净才采纳；失败保持原样，由
final_det / final pre-commit gate 照常 fail-closed）。
hermetic：stub orchestrator + fake llm，零网络。
"""
from __future__ import annotations

import types

from novel_engine.pipeline import pipeline_orchestrator as orch_mod

_CLEAN = "陈老根顿了顿枣木棍，笃的一声，三名村民退后半步，谁也没敢再往前凑。"
_LATIN_TEXT = "　　" + _CLEAN + "他 barely 敢抬头。\n" + _CLEAN
_LATIN_FIXED = "　　" + _CLEAN + "他几乎不敢抬头。\n" + _CLEAN


class _FakeLLM:
    """模拟 chinese_gate.fix_latin_leak 的 llm_client 接口。"""

    def __init__(self, reply: str):
        self.reply = reply
        self.calls = 0

    def chat_completion(self, messages, temperature=0.0, max_tokens=1000):
        self.calls += 1
        return {"content": self.reply}


class _StubOrchestrator:
    def __init__(self, llm: _FakeLLM, use_mock: bool = False):
        self.config = {"llm": {"use_mock": use_mock}}
        self.llm = llm
        self._auto_fix_final_latin = types.MethodType(
            orch_mod.PipelineOrchestrator._auto_fix_final_latin, self)
        self._restore_lead_indent = orch_mod.PipelineOrchestrator._restore_lead_indent


def _run(text: str, reply: str | None = None, use_mock: bool = False):
    llm = _FakeLLM(reply if reply is not None else text)
    stub = _StubOrchestrator(llm, use_mock=use_mock)
    out = stub._auto_fix_final_latin(text, 584)
    return llm, out


def test_final_latin_auto_fix_cleans_assembly():
    """含拉丁残片的定稿：LLM 修复干净后采纳，替换最终稿。"""
    llm, out = _run(_LATIN_TEXT, reply=_LATIN_FIXED)
    assert out == _LATIN_FIXED, "fixed text must replace the final assembly"
    assert llm.calls == 1, "fix must be invoked exactly once on latin hit"


def test_final_latin_auto_fix_keeps_original_on_verify_failure():
    """LLM 修复后复检仍含拉丁（verify-then-trust 失败）：保持原样，
    fail-closed 语义不破坏——由紧随的 final gate 照常阻断。"""
    still_dirty = _LATIN_TEXT + "\n" + _LATIN_TEXT
    llm, out = _run(_LATIN_TEXT, reply=still_dirty)
    assert out == _LATIN_TEXT, "unverified fix must NOT replace the original"
    assert llm.calls >= 1


def test_final_latin_auto_fix_clean_text_untouched():
    """无拉丁残片：不调用 LLM，原样返回。"""
    llm, out = _run(_CLEAN + "\n" + _CLEAN)
    assert out == _CLEAN + "\n" + _CLEAN
    assert llm.calls == 0


def test_final_latin_auto_fix_skipped_in_mock_mode():
    """mock 模式（use_mock=True）：跳过 LLM 修复，原样返回（测试计数不被扰动）。"""
    llm, out = _run(_LATIN_TEXT, use_mock=True)
    assert out == _LATIN_TEXT
    assert llm.calls == 0
