# -*- coding: utf-8 -*-
"""CC round-9 orchestrator scope 门接线测试（轻量假对象，不构造完整 Pipeline）。"""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from novel_engine.agents.scene_schema import SceneOutput
from novel_engine.core.errors import ChapterResampleRequiredError
from novel_engine.pipeline.pipeline_orchestrator import PipelineOrchestrator
from novel_engine.quality import scope_gate

INFANT = {
    "arc": "infant", "chapters": [1, 5], "negation_window": 20,
    "negation_markers": ["不是", "并非"], "idiom_whitelist": ["魂飞魄散"],
    "hard_block": ["守护者", "魂魄印记", "仙门", "筑基"],
    "soft_warn": ["修炼", "境界"],
    "night_anchor_markers": ["当夜", "数时辰"],
    "dawn_markers": ["天亮", "鱼肚白"],
    "future_markers": ["等", "等到", "再说"],
}


@pytest.fixture()
def harness(tmp_path: Path):
    d = tmp_path / "config" / "leak_terms"
    d.mkdir(parents=True)
    (d / "infant.json").write_text(json.dumps(INFANT, ensure_ascii=False), encoding="utf-8")
    scope_gate.reset_config_cache()
    bps = [
        {"scene_num": 1, "sequence_index": 1},
        {"scene_num": 2, "sequence_index": 2},
    ]
    card = {"chapter_num": 1, "scene_blueprints": bps,
            "timeline_anchor": {"max_time_progression": "数时辰内"}}
    yield tmp_path, card
    scope_gate.reset_config_cache()


def _run(fake, card, scenes, assembled=""):
    return PipelineOrchestrator._run_scope_gate(fake, 1, card, scenes, assembled)


def _fake(root):
    f = SimpleNamespace(root=root, config={},
                        writer=SimpleNamespace(last_scenes=None),
                        _chapter_gate_fired=False)
    return f


def test_extra_scene_count_is_hard_block(harness):
    root, card = harness
    scenes = [SceneOutput(1, "甲", "", []), SceneOutput(2, "乙", "", []),
              SceneOutput(3, "丙", "", [])]  # 3 > 规划 2
    f = _fake(root)
    with pytest.raises(ChapterResampleRequiredError) as ei:
        _run(f, card, scenes)
    assert ei.value.replan == "scope_block"


def test_hard_leak_regenerated_and_resolved(harness):
    root, card = harness
    scenes = [
        SceneOutput(1, "陈老根在雾中蹲下身查看焦土。", "", []),
        SceneOutput(2, "雾里响起守护者的低语，挥之不去。", "", []),
    ]
    clean = SceneOutput(2, "他抱起裹好麻布的婴儿，转身沿山道往村里走。", "", [])
    f = _fake(root)
    f._regen_scene_for_id = lambda *a, **k: clean
    out = _run(f, card, scenes, "assembled")
    assert "守护者" not in out
    assert f._chapter_gate_fired is True
    # 被修场景已替换为干净文本
    s2 = next(s for s in scenes if s.scene_id == 2)
    assert "守护者" not in s2.scene_text


def test_persistent_leak_raises_scope_block(harness):
    root, card = harness
    scenes = [
        SceneOutput(1, "陈老根在雾中蹲下身。", "", []),
        SceneOutput(2, "雾里响起守护者的低语。", "", []),
    ]
    still_bad = SceneOutput(2, "那守护者又借魂魄印记传念。", "", [])
    f = _fake(root)
    f._regen_scene_for_id = lambda *a, **k: still_bad
    with pytest.raises(ChapterResampleRequiredError) as ei:
        _run(f, card, scenes)
    assert ei.value.replan == "scope_block"
    assert 2 in (ei.value.scene_ids or [])


def test_clean_chapter_no_gate_fired(harness):
    root, card = harness
    scenes = [
        SceneOutput(1, "陈老根借着雾气摸到村口外的焦土。", "", []),
        SceneOutput(2, "他抱起婴儿，麻布裹紧，深一脚浅一脚往回走。", "", []),
    ]
    f = _fake(root)
    f._regen_scene_for_id = lambda *a, **k: pytest.fail("clean chapter must not regen")
    out = _run(f, card, scenes, "assembled")
    assert out == "assembled"
    assert f._chapter_gate_fired is False
