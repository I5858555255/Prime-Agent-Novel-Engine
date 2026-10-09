# -*- coding: utf-8 -*-
"""CC round-30：任务卡章内场景时间顺序/跨日校验（ch141 时间倒置回归）。

纯函数测试，无 LLM。
"""
from __future__ import annotations

from novel_engine.agents.chapter_director import (
    detect_task_card_scene_time_inversion,
    _scene_time_order,
)


def test_time_order_basic():
    assert _scene_time_order("清晨") == 1
    assert _scene_time_order("午后") == 4
    assert _scene_time_order("深夜") == 8
    assert _scene_time_order("未知时段") == 0


def test_inversion_detected_afternoon_then_morning():
    """ch141 场景倒置样本：1午后→2上午/傍晚→3午后→4黄昏 必须报错。"""
    scenes = [
        {"scene_num": 1, "sequence_index": 1, "narrative_time": "午后"},
        {"scene_num": 2, "sequence_index": 2, "narrative_time": "上午"},
        {"scene_num": 3, "sequence_index": 3, "narrative_time": "午后"},
        {"scene_num": 4, "sequence_index": 4, "narrative_time": "黄昏"},
    ]
    errors = detect_task_card_scene_time_inversion(scenes)
    assert errors, "下午→上午 应判倒置"
    assert "场景2" in errors[0]


def test_monotonic_times_no_error():
    """清晨→上午→午后→黄昏 顺序正常，无报错。"""
    scenes = [
        {"scene_num": 1, "sequence_index": 1, "narrative_time": "清晨"},
        {"scene_num": 2, "sequence_index": 2, "narrative_time": "上午"},
        {"scene_num": 3, "sequence_index": 3, "narrative_time": "午后"},
        {"scene_num": 4, "sequence_index": 4, "narrative_time": "黄昏"},
    ]
    assert detect_task_card_scene_time_inversion(scenes) == []


def test_backref_scene_skipped():
    """含回溯词（回忆/昨夜）的场景不参与倒置判定。"""
    scenes = [
        {"scene_num": 1, "sequence_index": 1, "narrative_time": "午后"},
        {"scene_num": 2, "sequence_index": 2, "narrative_time": "回忆昨夜"},
        {"scene_num": 3, "sequence_index": 3, "narrative_time": "黄昏"},
    ]
    assert detect_task_card_scene_time_inversion(scenes) == []


def test_unknown_time_keeps_chain():
    """未知时间词不断链：午后→(月上柳梢)→清晨 仍应判倒置。"""
    scenes = [
        {"scene_num": 1, "sequence_index": 1, "narrative_time": "午后"},
        {"scene_num": 2, "sequence_index": 2, "narrative_time": "月上柳梢"},
        {"scene_num": 3, "sequence_index": 3, "narrative_time": "清晨"},
    ]
    errors = detect_task_card_scene_time_inversion(scenes)
    assert errors, "跨未知时间词的倒置应被检出"
    assert "场景3" in errors[0]


def test_validate_task_card_catches_inversion():
    """validate_task_card 应包含时间倒置错误（接入点回归）。"""
    from novel_engine.agents.chapter_director import ChapterDirector
    director = ChapterDirector.__new__(ChapterDirector)  # 仅测校验，不构造完整实例
    director._bible_cache = {}
    card = {
        "core_goal": "g", "conflicts": [], "emotion_curve": [], "chapter_hook": "h",
        "scene_blueprints": [
            {"scene_num": 1, "narrative_time": "午后", "location": "a", "characters": ["x"],
             "goal": "g1", "conflict": "c1", "emotion": "e1"},
            {"scene_num": 2, "narrative_time": "上午", "location": "b", "characters": ["x"],
             "goal": "g2", "conflict": "c2", "emotion": "e2"},
            {"scene_num": 3, "narrative_time": "黄昏", "location": "c", "characters": ["x"],
             "goal": "g3", "conflict": "c3", "emotion": "e3"},
        ],
    }
    errors = director.validate_task_card(card, 141)
    assert any("倒置" in e for e in errors), f"expect time inversion error, got {errors}"
