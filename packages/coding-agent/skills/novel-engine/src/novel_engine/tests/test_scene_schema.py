from novel_engine.agents.scene_schema import parse_scene

STRICT = ["deepseek-ai/DeepSeek-V3.2"]


def test_strict_parses_clean_json():
    raw = '{"scene_id": 2, "scene_text": "夜色如墨。", "hook": "远处传来脚步声。", "beats": ["夜探"]}'
    out = parse_scene(raw, "deepseek-ai/DeepSeek-V3.2", STRICT)
    assert out.scene_text == "夜色如墨。"
    assert out.hook == "远处传来脚步声。"


def test_lenient_accepts_fenced_fallback():
    raw = "```scene\n夜色如墨。\n```"
    out = parse_scene(raw, "Qwen/Qwen3.5-27B", STRICT)
    assert out.scene_text == "夜色如墨。"


def test_strict_rejects_prose():
    import pytest
    with pytest.raises(ValueError):
        parse_scene("夜色如墨，纯散文无JSON。", "deepseek-ai/DeepSeek-V3.2", STRICT)
