# -*- coding: utf-8 -*-
"""ch1682 回归：跨场危机门的召唤识别误判（否定式 + 单字谓词）。

线上 ch1682 hard gate 报 `[跨场危机] off-card crisis 未承接`，实际触发句是幼儿
护理场景中的否定式叙述：

    起身走向床尾的矮凳坐下并未催促也不强求继续而是用掌心抵住陆烬的后颈…

旧逻辑把「并未催促」的「催」（_CALL_VERBS）与「走向」的「走」（_CRISIS_PREDICATES
单字）当成「召唤动作 + 紧急谓词」共现，于是在无危机的日常场景里造出悬空危机，
再叠加后续场的时间/状态复位判为未承接。

修订：否定语境中的关键词不计；单字「走」改为祈使短语「快走/赶紧走/走啊」。
"""
from __future__ import annotations

import pytest

from novel_engine.quality.cross_scene_crisis_gate import (
    _has_call_crisis,
    _has_call_crisis_window,
    _split_sentences,
    detect_off_card_crisis,
)

# ch1682 线上触发句（原文摘录）
_CH1682_TRIGGER = (
    '起身走向床尾的矮凳坐下并未催促也不强求继续而是用掌心抵住陆烬的后颈'
    '施加了一个微小的支撑力。'
)

# 真实危机形态（ch5 判例同型：拍门 + 吼 + 快开门）
_REAL_CRISIS = '忽然有人疯狂拍门大喊快开门出大事了陈老根被惊醒。'


def _detect_with_scenes(scenes: dict[int, str], chapter_num: int = 1682) -> dict:
    task_card = {'chapter_num': chapter_num, 'scene_blueprints': [], 'chapter_events': []}
    return detect_off_card_crisis('', chapter_num, task_card, scene_texts=scenes)


def test_negated_summon_sentence_not_crisis():
    """「并未催促」+「走向」不得构成召唤+紧急谓词共现。"""
    assert _has_call_crisis(_CH1682_TRIGGER) is False
    sents = _split_sentences(_CH1682_TRIGGER)
    hit, _ = _has_call_crisis_window(sents, 0)
    assert hit is False


def test_real_crisis_sentence_still_hits():
    """正向保真：真实拍门召唤仍判为危机。"""
    assert _has_call_crisis(_REAL_CRISIS) is True


def test_daily_movement_with_kuai_compound_not_crisis():
    """「走向」为日常位移、「很快」为复合词，均不得构成危机。"""
    assert _has_call_crisis('他走向灶台，很快又折返回来添了把柴。') is False


def test_broader_single_char_negation_not_over_filtered():
    """否定过滤只收明确否定组合：单字「不」不得把「不知道谁在拍门」判成非危机。"""
    assert _has_call_crisis('不知道谁在拍门喊快开门。') is True


def test_ch1682_scene_pair_no_false_crisis():
    """ch1682 同型场景对：否定式叙述 + 后续时间/状态复位，不得报未承接危机。

    修复前：场景1 命中「催」「走」→ crisis_found；场景2 出现「当晚/静坐/只字未提」
    且无承接 → has_issue=True，即线上 hard gate 的直接来源。
    """
    scenes = {
        1: '陆烬躺在粗布襁褓里。' + _CH1682_TRIGGER,
        2: '当晚陈老根照常静坐，对昨晚的事只字未提。',
    }
    r = _detect_with_scenes(scenes)
    assert r['has_issue'] is False, f'negated daily narration must not raise crisis, got {r}'


def test_real_crisis_scene_pair_still_flagged():
    """正向保真：真实危机后时间+状态复位且无承接，仍应报。"""
    scenes = {
        1: '陈老根在屋里坐着，听着外面的风声。',
        2: _REAL_CRISIS,
        3: '当晚陈老根照常静坐，对昨晚的事只字未提。',
    }
    r = _detect_with_scenes(scenes)
    assert r['has_issue'] is True, f'expected crisis hit, got {r}'
    assert r['off_card_crises'][0]['scene_id'] == 2
