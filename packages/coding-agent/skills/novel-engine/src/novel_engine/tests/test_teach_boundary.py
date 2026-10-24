# -*- coding: utf-8 -*-
"""CC 2026-10-06: 传授既成 vs 提及/认知 边界回归（ch59/ch60 实证来源）。

- ch59 L56（体感+传授既成）必须判违规
- ch60 L234（"您教我……呼吸的法子"传授既成）必须判违规
- 认知句（"陆烬知道根伯会些调息的法子"）必须放行
- 纯提及句（"陈老根提起过呼吸法"无传授/无体感）必须放行
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from novel_engine.quality.scope_gate import _has_teach_violation


def test_ch59_teach_violation():
    """ch59：体感描写 + 传授既成（"教他呼吸法时"）→ 违规。"""
    s = "陆烬能感觉到，根伯说话时气息的走向与平日教他呼吸法时那种奇特的平稳节奏隐隐相合"
    assert _has_teach_violation(s) is True


def test_ch60_teach_violation():
    """ch60：传授既成（"您教我……呼吸的法子"——方法已交付陆烬）→ 违规。"""
    s = "您教我认字，教我那些呼吸的法子，还有辨认药草。"
    assert _has_teach_violation(s) is True


def test_cognition_mention_allowed():
    """认知/提及（"知道根伯会些法子"——被告知结果，无传授动词）→ 放行。"""
    s = "陆烬知道根伯会些调息的法子"
    assert _has_teach_violation(s) is False


def test_pure_mention_allowed():
    """纯提及（陈老根提及呼吸法，无"教/传"动词、无陆烬体感）→ 放行。"""
    s = "陈老根偶尔会说起一些调息的法子，但从不细讲"
    assert _has_teach_violation(s) is False


def test_buddhist_compound_noun_not_teach_verb():
    """ch805 归因：佛偈"圆顿大教"中的"教"是复合名词后缀，非传授动词。

    修复前该句被判传授违规（"大教"+近窗"法门"），归因误导并硬阻断；
    修复后复合名词词边界排除，佛学词堆砌改由 writer 约束拦截。
    """
    s = "回头是岸彼岸此岸中岸此岸彼岸同时到达不二法门圆顿大教直指人心见性成佛顿悟渐修顿渐双修次第证"
    assert _has_teach_violation(s) is False


def test_buddhist_and_daoist_noun_suffix_variants():
    """复合名词尾变体（大教/佛教/道教/经教）均不作传授动词。"""
    for s in (
        "他诵读佛教经文的调子，与呼吸法无关",
        "圆顿大教直指人心，与那套呼吸法毫无干系",
        "道教典籍里并无吐纳之术的记载",
    ):
        assert _has_teach_violation(s) is False, s


def test_real_teach_verb_still_hard_after_boundary():
    """词边界修复不放松真实传授：裸"教"+修炼宾语近窗仍判违规。"""
    s = "陈老根蹲下身，教陆烬吐纳的节奏"
    assert _has_teach_violation(s) is True


def test_teach_verb_after_proper_name_still_hard():
    """"教"前为代词/人名（非复合名词尾）仍正常判定。"""
    s = "他教陆烬那套呼吸法门"
    assert _has_teach_violation(s) is True
