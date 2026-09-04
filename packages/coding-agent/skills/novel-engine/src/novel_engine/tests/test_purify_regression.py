"""回归测试：清洗层必须拦截 round7/round8 的 4 类泄漏样本。"""
from novel_engine.quality.repetition_detector import purify_novel_for_publish, verify_no_scaffolding


def test_ch2_beat_point():
    raw = "**节拍点1（冲突酝酿）：村民聚集，议论声起**\n\n正文段落。"
    purified = purify_novel_for_publish(raw)
    assert "节拍点" not in purified, f"节拍点未清洗: {purified}"
    assert verify_no_scaffolding(purified) == []


def test_ch3_scene_summary():
    raw = "****\n\n【场景小结】\n场景剧情概述：...\n作者意图：...\n伏笔说明：...\n\n正文。"
    purified = purify_novel_for_publish(raw)
    assert "场景小结" not in purified
    assert "****" not in purified
    assert verify_no_scaffolding(purified) == []


def test_ch4_word_count():
    raw = "【当前字数：约 1850 字】\n\n【本节拍点完成】- 场景冲突/细节呈现/伏笔铺垫\n\n正文。"
    purified = purify_novel_for_publish(raw)
    assert "当前字数" not in purified
    assert "本节拍" not in purified
    assert verify_no_scaffolding(purified) == []


def test_ch7_scene_header():
    raw = "【场景 1：陈老根家，简陋的土屋内】\n\n正文段落。"
    purified = purify_novel_for_publish(raw)
    assert "【场景" not in purified
    assert "陈老根家" not in purified or "正文段落" in purified
    assert verify_no_scaffolding(purified) == []


def test_verify_catches_leak():
    raw = "**节拍点1（冲突酝酿）：村民聚集，议论声起**"
    assert verify_no_scaffolding(raw) != []
    raw2 = "【场景小结】\nxxx"
    assert verify_no_scaffolding(raw2) != []
