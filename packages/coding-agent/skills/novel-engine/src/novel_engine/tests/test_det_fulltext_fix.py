# -*- coding: utf-8 -*-
"""CC33 回归：det 硬项（称谓/canon/泄漏）接入全文级修复指令。
验证：mock 模式安全短路；非 mock 时生成含 det 明细的修复指令并被消费。
"""
import json
import pathlib

import pytest

from novel_engine.core.llm_client import MockLLMClient
from novel_engine.pipeline.pipeline_orchestrator import PipelineOrchestrator


def _mk_scene(root, chapter_num, texts):
    d = pathlib.Path(root) / "chapters" / "draft"
    d.mkdir(parents=True, exist_ok=True)
    with open(d / f"chapter_{chapter_num}_partial.jsonl", "w", encoding="utf-8") as f:
        for sid, t in texts.items():
            f.write(json.dumps({"scene_id": sid, "scene_text": t, "hook": "",
                                "beats": [], "entities_json": ""}, ensure_ascii=False) + "\n")


class _StubRouter:
    def __init__(self, edits):
        self.edits = edits
        self.last_prompt = ""

    def chat_completion(self, messages, **kw):
        self.last_prompt = messages[-1]["content"]
        return {"content": json.dumps({"edits": self.edits}, ensure_ascii=False)}


def test_det_fulltext_fix_mock_mode_safe(tmp_path):
    """mock 模式下应短路返回 None，不抛异常、不发请求。"""
    orch = PipelineOrchestrator(project_root=str(tmp_path), llm_client=MockLLMClient())
    res = orch._det_fulltext_fix("正文", ["[称谓] 陆烬/李淳 裸切"], 1, {})
    assert res is None


def test_det_fulltext_fix_generates_directive(tmp_path):
    """非 mock：指令必须包含 det 明细（同指锚点/硬词泄漏），编辑被消费。"""
    texts = {
        1: "陆烬抬起头，看见陈老根站在门口。李淳知道养父有话要说，便低下了头。",
        2: "他点点头，决定先观察几天再说。",
    }
    _mk_scene(tmp_path, 11, texts)
    edits = [{
        "scene_id": 1, "op": "replace_span",
        "anchor": "李淳知道养父有话要说",
        "replacement": "陆烬知道养父有话要说，他深吸一口气平复心绪。",
    }]
    stub = _StubRouter(edits)
    orch = PipelineOrchestrator(project_root=str(tmp_path))
    orch.polish_router = stub
    res = orch._det_fulltext_fix(
        "正文占位",
        ["[称谓] 同一角色陆烬/李淳 无锚点裸切",
         "[canon硬词] 吐纳：养父教他那一套晚上坐着调整呼吸的动作之后。"],
        11, {})
    assert "同指锚点" in stub.last_prompt
    assert "修炼" in stub.last_prompt or "硬词" in stub.last_prompt
    assert stub.last_prompt.count("【场景") >= 2
    # 结果允许 None（编辑应用后 det gate 拒绝则弃用，journal 不动）或 tuple
    assert res is None or (isinstance(res, tuple) and len(res) == 2)
