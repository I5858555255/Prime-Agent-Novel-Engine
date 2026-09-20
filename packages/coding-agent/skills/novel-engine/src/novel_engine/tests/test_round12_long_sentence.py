# -*- coding: utf-8 -*-
"""CC round-12 R2：句末口径长句检测与零字改写安全断句测试。

覆盖需求：
- detect_long_sentences：旁白超长句检测、引号内对话豁免
- split_long_sentences：强边界前插"。\n"、对话内不动、无强边界只计数不拆
- 去标点逐字恒等校验
- 与 repair_text_punctuation 集成后最终文本健康
"""
import pytest

from novel_engine.quality import punctuation_health as ph


# ---------- detect_long_sentences ----------

def test_detect_long_narration_sentence():
    """旁白超长句（>=48中文字）应被检测出。"""
    text = "的" * 50
    result = ph.detect_long_sentences(text)
    assert len(result) == 1
    assert result[0]["cn_chars"] == 50
    assert result[0]["sentence_index"] == 0


def test_detect_short_sentence_not_flagged():
    """短于阈值的句子不应被检测出。"""
    text = "他走了。"
    result = ph.detect_long_sentences(text)
    assert result == []


def test_dialogue_inside_quotes_ignored():
    """引号内的长对话不应被检测为超长句。"""
    dialogue = "这是一段非常非常非常非常非常长的对话内容没有任何标点符号"
    text = f'他低声说："《{dialogue}》然后继续往前走。'
    result = ph.detect_long_sentences(text)
    assert result == []


def test_mixed_narration_and_dialogue():
    """旁白超长且夹带引号对话——旁白部分应被检测，对话部分豁免。"""
    long_narr = "的" * 50
    dialogue = '“这是一段很长的对话内容完全没有标点符号需要处理”'
    text = long_narr + dialogue
    result = ph.detect_long_sentences(text)
    assert len(result) == 1
    assert result[0]["cn_chars"] == 50


# ---------- split_long_sentences ----------

def test_split_at_strong_boundary():
    """旁白长句含强边界词——应在边界前插"。\n"。"""
    text = "的" * 50 + "然后" + "的" * 20
    fixed, stats = ph.split_long_sentences(text)
    assert stats["long_sentences_detected"] == 1
    assert stats["split_count"] >= 1
    assert "。\n" in fixed
    assert ph.strip_all_punctuation(fixed) == ph.strip_all_punctuation(text)


def test_no_strong_boundary_only_count():
    """无强边界的长句——只计数不拆分。"""
    text = "的" * 60
    fixed, stats = ph.split_long_sentences(text)
    assert stats["long_sentences_detected"] == 1
    assert stats["split_count"] == 0
    assert fixed == text


def test_dialogue_not_split():
    """纯对话长句——不应被检测也不应被拆分。"""
    text = '“' + "的" * 60 + '”'
    fixed, stats = ph.split_long_sentences(text)
    assert stats["long_sentences_detected"] == 0
    assert stats["split_count"] == 0
    assert fixed == text


def test_dialogue_preserved_after_split():
    """拆分后引号内对话内容完整保留。"""
    dialogue = '“这是很长的一段对话内容完全没有标点符号需要处理”'
    narration = "的" * 50 + "然后" + "的" * 20
    text = narration + dialogue
    fixed, stats = ph.split_long_sentences(text)
    assert dialogue in fixed
    assert ph.strip_all_punctuation(fixed) == ph.strip_all_punctuation(text)


def test_max_two_splits_per_sentence():
    """每句至多2处拆分（max_splits=2）。"""
    text = ("的" * 50 + "然后" + "的" * 20
            + "接着" + "的" * 20 + "随后" + "的" * 20)
    fixed, stats = ph.split_long_sentences(text)
    split_count = fixed.count("。\n")
    assert split_count <= 2
    assert stats["split_count"] <= 2


def test_weak_boundary_not_used_for_split():
    """弱边界词（因为/由于/虽然…）不应触发句号拆分。"""
    text = "的" * 50 + "因为" + "的" * 20
    fixed, stats = ph.split_long_sentences(text)
    assert "。\n" not in fixed
    assert stats["split_count"] == 0


# ---------- repair_text_punctuation integration ----------

def test_repair_text_punctuation_resolves_long_sentences():
    """repair_text_punctuation 对含长句的文本应检测并拆分，最终健康。"""
    text = "的" * 50 + "然后" + "的" * 20
    fixed, stats = ph.repair_text_punctuation(text)
    assert stats["long_sentences_detected"] >= 1
    assert ph.check_text_punctuation(fixed) == []
    assert ph.strip_all_punctuation(fixed) == ph.strip_all_punctuation(text)


def test_repair_text_punctuation_no_false_split():
    """健康文本不应被错误修改。"""
    text = "他走了很长一段路，然后停下来休息。"
    fixed, stats = ph.repair_text_punctuation(text)
    assert fixed == text
    assert stats["long_sentences_detected"] == 0


def test_repair_text_punctuation_preserves_dialogue():
    """修复过程中引号内对话不被触碰。"""
    dialogue = '“这是一段很长的对话内容完全没有标点符号需要处理”'
    text = "的" * 50 + dialogue
    fixed, stats = ph.repair_text_punctuation(text)
    assert dialogue in fixed
    assert ph.strip_all_punctuation(fixed) == ph.strip_all_punctuation(text)
