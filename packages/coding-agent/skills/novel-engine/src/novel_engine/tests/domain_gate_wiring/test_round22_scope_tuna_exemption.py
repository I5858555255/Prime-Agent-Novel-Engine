# -*- coding: utf-8 -*-
"""CC round-21：scope_gate 吐纳/调息豁免扩展 + 气感子串 + 反诘降级测试。

覆盖：
- 放行：陈老根深夜/当晚独白吐纳调息（包括"自己"/"他"跨句回溯）
- 降 soft：反问"如何理解气感"、否定"他没有再盘膝调息"
- 不误伤："空气感"不命中
- 仍 hard（红线）：陆烬学练吐纳/调息、真实传授呼吸法给陆烬、
  陆烬肯定气感/内视、非夜场景陈老根吐纳
- 真机回归夹具：ch6 失败草稿 scene4 终版断言 hard 为空（反问句在 soft）
"""
from __future__ import annotations

import json
from pathlib import Path
import pytest

from novel_engine.quality import scope_gate as sg
from novel_engine.quality.scope_gate import (
    detect_scope_violations,
    reset_config_cache,
    _has_teach_violation,
    _is_air_sensibility_substring,
)


# ── 夹具 ───────────────────────────────────────────────────────────────────────

_FIXTURE_ROOT = str(Path(__file__).resolve().parent / "fixtures" / "ch6_scope_tuna")
_SCENE4_PATH = Path(_FIXTURE_ROOT) / "chapter_6_scene4.jsonl"


def _load_scene4() -> str:
    """读取真机 ch6 失败草稿 scene4 终版文本。"""
    with open(_SCENE4_PATH, encoding="utf-8") as f:
        return json.loads(f.readline()).get("scene_text", "")


_NIGHT_ANCHOR = {
    "chapter_start_marker": "当晚",
    "max_time_progression": "数时辰",
}

_ROOT = "novel_engine"  # relative to src/ when running from src dir


# ── 放行用例 ──────────────────────────────────────────────────────────────────


def test_exempt_chen_laogen_night_tuna():
    """陈老根深夜盘膝吐纳 → 豁免（硬门空）。"""
    reset_config_cache()
    r = detect_scope_violations(
        "是夜子时，陈老根独自盘膝坐在炕边吐纳呼吸，气息绵长。陆烬在旁偷看。"
        + "x" * 500,
        6, _NIGHT_ANCHOR, _ROOT,
    )
    assert "吐纳" not in [h["term"] for h in r["hard"]]


def test_exempt_chen_laogen_tiaoxi_same_night():
    """陈老根调息（吐纳同义）→ 豁免。"""
    reset_config_cache()
    r = detect_scope_violations(
        "深夜，陈老根在房中调息，气息绵长而规律。陆烬在襁褓里静静看着。"
        + "x" * 500,
        6, _NIGHT_ANCHOR, _ROOT,
    )
    assert "调息" not in [h["term"] for h in r["hard"]]


def test_exempt_chen_self_reflexive_tuna():
    """陈老根'自己吐纳'（内心独白反身标记）→ 豁免。"""
    reset_config_cache()
    # 使用场景级 night_bounded（通过 timeline_anchor），确保 night_bounded=True
    r = detect_scope_violations(
        "深夜，他独自坐在窗前，想起自己吐纳调息时的情形，心中翻涌。"
        + "x" * 500,
        6, _NIGHT_ANCHOR, _ROOT,
    )
    # 验证：该句含"深夜"(night_anchor) + "自己"+ 吐纳/调息 → 应豁免
    hard_terms = [h["term"] for h in r["hard"]]
    assert "吐纳" not in hard_terms, f"self-reflexive 应豁免，实际 hard={hard_terms}"
    assert "调息" not in hard_terms


def test_exempt_chen_pronoun_cross_sentence():
    """他（陈老根）回想起昨夜吐纳 → 代词跨句回溯豁免。"""
    reset_config_cache()
    prev = "是夜子时，陈老根独自盘膝坐在炕边。他缓缓吐纳，呼吸绵长。"
    r = detect_scope_violations(prev + "x" * 500, 6, _NIGHT_ANCHOR, _ROOT)
    assert "吐纳" not in [h["term"] for h in r["hard"]]


def test_exempt_observer_lu_jin():
    """陆烬旁观陈老根吐纳（无模仿动词）→ 豁免。"""
    reset_config_cache()
    r = detect_scope_violations(
        "陆烬裹在襁褓中，偷偷看着陈老根盘膝吐纳。"
        + "x" * 500,
        6, _NIGHT_ANCHOR, _ROOT,
    )
    assert "吐纳" not in [h["term"] for h in r["hard"]]


def test_exempt_descriptive_reference():
    """吐纳作为描述性名词引用（非施为动作）→ 豁免。"""
    reset_config_cache()
    r = detect_scope_violations(
        "深夜，那呼吸又变回了平常的样子，粗重，带着轻微的鼾意，"
        "和刚才那绵长规律的吐纳判若两人。"
        + "x" * 500,
        6, _NIGHT_ANCHOR, _ROOT,
    )
    hard_terms = [h["term"] for h in r["hard"]]
    assert "吐纳" not in hard_terms, f"descriptive 引用 应豁免，实际 hard={hard_terms}"


# ── 降 soft 用例 ──────────────────────────────────────────────────────────────


def test_rhetorical_qi_gan_soft():
    """反问'如何理解气感' → soft（非 hard）。"""
    reset_config_cache()
    r = detect_scope_violations(
        "话都不会说，路都不会走，如何理解气感，如何引导周天？"
        + "x" * 500,
        6, _NIGHT_ANCHOR, _ROOT,
    )
    hard_terms = [h["term"] for h in r["hard"]]
    assert "气感" not in hard_terms
    soft_terms = [(s["kind"], s["term"]) for s in r["soft"]]
    assert ("negated_hard", "气感") in soft_terms


def test_negated_tuna_soft():
    """否定句'他没有再盘膝调息' → soft（非 hard）。"""
    reset_config_cache()
    r = detect_scope_violations(
        "他并没有再盘膝调息，只是普通地坐着。"
        + "x" * 500,
        6, _NIGHT_ANCHOR, _ROOT,
    )
    hard_terms = [h["term"] for h in r["hard"]]
    assert "调息" not in hard_terms


def test_hesitant_teach_soft():
    """犹豫/权衡'权衡是否传授' → soft（非 hard）。"""
    reset_config_cache()
    r = detect_scope_violations(
        "他权衡是否传授呼吸法，终究没有开口。"
        + "x" * 500,
        6, _NIGHT_ANCHOR, _ROOT,
    )
    hard_terms = [h["term"] for h in r["hard"]]
    assert "吐纳" not in hard_terms


# ── 不误伤 ────────────────────────────────────────────────────────────────────


def test_air_sensibility_not_hit():
    """'空气感'等普通构词不命中'气感'硬门。"""
    reset_config_cache()
    r = detect_scope_violations(
        "那种粘稠的空气感让他感到不适。"
        + "x" * 500,
        6, _NIGHT_ANCHOR, _ROOT,
    )
    hard_terms = [h["term"] for h in r["hard"]]
    assert "气感" not in hard_terms


def test_air_sensibility_substring_detection():
    """_is_air_sensibility_substring 直接单元测试。"""
    s = "那种粘稠的空气感"
    idx = s.find("气感")  # idx=6, prev char is '空'
    assert idx == 6
    # "空气感"含"气感" → 前一字为"空" → True（放过）
    assert _is_air_sensibility_substring(idx, s) is True
    # "有气感" → 前字为"有"不在白名单 → False（命中）
    assert _is_air_sensibility_substring(2, "感到体内有气感") is False
    # 句首"气感" → 直接命中
    assert _is_air_sensibility_substring(0, "气感涌动") is False


# ── 红线反例（必须仍 hard）───────────────────────────────────────────────────


def test_red_line_lu_jin_mimics_tuna():
    """陆烬学陈老根自己吐纳 → hard（红线）。"""
    reset_config_cache()
    r = detect_scope_violations(
        "深夜，陆烬学陈老根的样子，自己在床上吐纳。"
        + "x" * 500,
        6, _NIGHT_ANCHOR, _ROOT,
    )
    assert "吐纳" in [h["term"] for h in r["hard"]]


def test_red_line_actual_teach_tuna():
    """真实传授（肯定实施）'教陆烬吐纳' → hard。"""
    reset_config_cache()
    r = detect_scope_violations(
        "陈老根教陆烬吐纳呼吸法门。"
        + "x" * 500,
        6, _NIGHT_ANCHOR, _ROOT,
    )
    assert "吐纳" in [h["term"] for h in r["hard"]]


def test_red_line_lu_jin_positive_qi_gan():
    """陆烬肯定具备气感（非反问语境）→ hard。"""
    reset_config_cache()
    r = detect_scope_violations(
        "陆烬感到体内有气感涌动。"
        + "x" * 500,
        6, _NIGHT_ANCHOR, _ROOT,
    )
    assert "气感" in [h["term"] for h in r["hard"]]


def test_red_line_lu_jin_positive_neishi():
    """陆烬肯定内视 → hard。"""
    reset_config_cache()
    r = detect_scope_violations(
        "陆烬以内视看见自己脏腑。"
        + "x" * 500,
        6, _NIGHT_ANCHOR, _ROOT,
    )
    assert "内视" in [h["term"] for h in r["hard"]]


def test_red_line_daytime_tuna():
    """非夜场景（次日）陈老根吐纳 → hard。"""
    reset_config_cache()
    day_anchor = {"chapter_start_marker": "次日", "max_time_progression": "白昼"}
    r = detect_scope_violations(
        "白天陈老根在院中吐纳呼吸。"
        + "x" * 500,
        6, day_anchor, _ROOT,
    )
    assert "吐纳" in [h["term"] for h in r["hard"]]


def test_red_line_ch5_tuna():
    """ch5 吐纳不受 ch6 豁免 → hard。"""
    reset_config_cache()
    r = detect_scope_violations(
        "陈老根夜里吐纳呼吸。"
        + "x" * 500,
        5, None, _ROOT,
    )
    assert "吐纳" in [h["term"] for h in r["hard"]]


# ── 真机回归夹具（ch6 失败草稿 scene4）──────────────────────────────────────


def test_real_ch6_scene4_no_hard():
    """真机 ch6 失败草稿 scene4 终版 → hard 为空。

    scene4 内容：陈老根独坐回想昨夜，"自己吐纳调息""每次吐纳/调息"均合法；
    "如何理解气感"为反问应降 soft；绝无 hard 阻断。
    """
    reset_config_cache()
    scene4_text = _load_scene4()
    r = detect_scope_violations(scene4_text, 6, _NIGHT_ANCHOR, _ROOT)
    hard_terms = [h["term"] for h in r["hard"]]
    assert hard_terms == [], f"scene4 hard 应为空，实际硬伤：{hard_terms}"
    # 反问气感应降 soft
    soft_terms = [s["term"] for s in r["soft"]]
    assert "气感" in soft_terms, f"反问气感应降为 soft，实际：{r['soft']}"
    # 吐纳/调息应豁免
    assert "吐纳" not in hard_terms
    assert "调息" not in hard_terms


def test_real_ch6_scene4_tuna_exempt_sentences():
    """scene4 中'自己吐纳调息'等句应标记为 tuna_exempt soft。"""
    reset_config_cache()
    scene4_text = _load_scene4()
    r = detect_scope_violations(scene4_text, 6, _NIGHT_ANCHOR, _ROOT)
    soft_kinds = {s["kind"] for s in r["soft"]}
    assert "tuna_exempt" in soft_kinds, f"应有 tuna_exempt soft，实际：{r['soft']}"


# ── Gap A 补测：婴儿反身漏放修复 ─────────────────────────────────────────────


def test_gap_a_lu_jin_self_tuna_hard():
    """GapA：陆烬自己吐纳调息（无字学）→ hard。"""
    reset_config_cache()
    r = detect_scope_violations(
        "陆烬自己吐纳调息。" + "x" * 500,
        6, _NIGHT_ANCHOR, _ROOT,
    )
    assert "吐纳" in [h["term"] for h in r["hard"]]
    assert "调息" in [h["term"] for h in r["hard"]]


def test_gap_a_na_lu_jin_zixing_hard():
    """GapA：那陆烬便自行吐纳 → hard（'那'不豁免婴儿主语）。"""
    reset_config_cache()
    r = detect_scope_violations(
        "那陆烬便自行吐纳。" + "x" * 500,
        6, _NIGHT_ANCHOR, _ROOT,
    )
    assert "吐纳" in [h["term"] for h in r["hard"]]


def test_scene4_legit_still_exempt():
    """真机scene4合法句（无婴儿词，含自己+吐纳调息）→ 仍豁免，防误伤。"""
    reset_config_cache()
    scene4_text = _load_scene4()
    r = detect_scope_violations(scene4_text, 6, _NIGHT_ANCHOR, _ROOT)
    hard_terms = [h["term"] for h in r["hard"]]
    assert "吐纳" not in hard_terms
    assert "调息" not in hard_terms


# ── Gap B 补测：既成传授被犹豫词放掉修复 ─────────────────────────────────────


def test_gap_b_definite_teach_with_hesitant_hard():
    """GapB：犹豫但仍传给陆烬（既成事实）→ hard。"""
    reset_config_cache()
    r = detect_scope_violations(
        "他犹豫再三，还是把呼吸法传给了陆烬。" + "x" * 500,
        6, _NIGHT_ANCHOR, _ROOT,
    )
    hard_terms = [h["term"] for h in r["hard"]]
    assert "吐纳" in hard_terms, f"既成传授应 hard，实际：{hard_terms}"


def test_gap_b_hesitant_no_teach_soft():
    """GapB：权衡是否传授（未实施）→ soft，不回归。"""
    reset_config_cache()
    r = detect_scope_violations(
        "他权衡是否传授呼吸法，终究没有开口。" + "x" * 500,
        6, _NIGHT_ANCHOR, _ROOT,
    )
    hard_terms = [h["term"] for h in r["hard"]]
    assert "吐纳" not in hard_terms


# ── Gap C 补测：prev_sents 跨禁词污染修复 ─────────────────────────────────────


def test_gap_c_isolated_single_sentence_exempt():
    """GapC：孤立单句（无前文）含"他+自己+吐纳调息"不应被 prev_sents 污染误判 hard。

    根因：_scan_terms 中 prev_sents 在 for term 循环外初始化，扫到吐纳/调息之前
    的不命中硬词时就把当前句 append 进 prev_sents，导致跨禁词上下文泄漏。
    修法：每个禁词独立维护 prev_sents。
    """
    reset_config_cache()
    # 单句，无任何前文，ch6，night_bounded=True（通过 timeline_anchor 传入）
    txt = "他看得真切，那目光的落点，正是自己吐纳调息时，气息流转最隐晦、也最易暴露异常的所在。"
    r = detect_scope_violations(txt, 6, _NIGHT_ANCHOR, _ROOT)
    hard_terms = [h["term"] for h in r["hard"]]
    assert "吐纳" not in hard_terms, f"孤立单句应豁免，实际 hard={hard_terms}"
    assert "调息" not in hard_terms, f"孤立单句应豁免，实际 hard={hard_terms}"
