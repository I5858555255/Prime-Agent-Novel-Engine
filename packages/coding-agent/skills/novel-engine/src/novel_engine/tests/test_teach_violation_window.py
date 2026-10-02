# -*- coding: utf-8 -*-
"""CC ch21-50 F1 回归：_has_teach_violation 婴儿受事近窗收紧。

背景：ch24/25/37/38 四章同源误报——全句级婴儿标记检查把
"陆烬…教导孩子时的温和…"（无传授语义）判为传授违规并标 [canon硬词] 吐纳，
而 final 文本实际 0 吐纳，导致 det 修复修不存在的泄漏、章节反复 FAILED。
修复：婴儿标记由"全句 any"收紧为"动词后 20 字窗内 + 受事结构（给/与 或 传给/教给/授徒）"。
"""
import pytest

from novel_engine.quality.scope_gate import _has_teach_violation

FALSE_POSITIVE_CASES = [
    # ch24 实测误报句：含"教导"+"陆烬"（全句），无传授语义
    "那对眼睛里，没有寻常父亲教导孩子时的温和或鼓励，反而像两口深井，里面沉淀着太多陆烬看不懂的东西。",
    # ch37 实测误报句：含"教导"+"陆烬"（句首），无传授语义
    "陆烬下意识地想问为什么，想问这与白日的教导、与那些关于外界凶险的讲述有何不同。",
    # 普通教导/讲解（非修炼传授）
    "先生教导孩子读书识字，日复一日。",
    "陆烬在村塾听先生讲解《三字经》，一字一句记在心里。",
    # 回忆语境：教导与修炼无关
    "他想起母亲教导他做人的道理，字字句句都刻在心里。",
]

TRUE_POSITIVE_CASES = [
    "陈老根教孩子吐纳，引着气流在四肢百骸间流转。",
    "传功给陆烬，让他夜半修习。",
    "教陆烬吐纳之法。",
    "他盘算着把呼吸之法传给这个孩子。",
]


@pytest.mark.parametrize("sentence", FALSE_POSITIVE_CASES)
def test_teach_violation_no_false_positive(sentence):
    assert _has_teach_violation(sentence) is False, f"误报: {sentence[:50]}"


@pytest.mark.parametrize("sentence", TRUE_POSITIVE_CASES)
def test_teach_violation_still_catches_real(sentence):
    assert _has_teach_violation(sentence) is True, f"漏拦: {sentence[:50]}"
