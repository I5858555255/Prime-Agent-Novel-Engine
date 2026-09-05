from novel_engine.agents.scene_schema import extract_beats_fallback, parse_scene


def test_fallback_extracts_from_text_not_self_report():
    text = "陈老根抱起婴儿走出迷雾，脚步沉重而坚定。村民在槐树下质疑婴儿的来历，议论纷纷不肯散去。"
    beats = extract_beats_fallback(text)
    assert any("陈老根" in b or "婴儿" in b for b in beats)
    assert len(beats) >= 1

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


# ---- Task B2: writer emits structured scenes (stub-client no-markers test first) ----
import json as _json

import pytest as _pytest

from novel_engine.agents.writer_agent import WriterAgent

# Step-3 contract line (must appear verbatim in the scene prompt).
CONTRACT_LINE = '只输出严格JSON {"scene_id","scene_text","hook","beats"}；scene_text 为纯叙事，禁任何【】括号指令；hook 为完整自然语句，可为空'


def _strict_json(scene_id=1, hook="远处传来脚步声。"):
    return _json.dumps(
        {"scene_id": scene_id, "scene_text": "夜色如墨，寒风穿林而过。",
         "hook": hook, "beats": ["夜探"]},
        ensure_ascii=False,
    )


class _StubClient:
    """Brief-specified stub: chat_completion returns strict JSON + stamped head model."""

    def __init__(self, payloads):
        self.payloads = [payloads] if isinstance(payloads, str) else list(payloads)
        self.calls = 0
        self.last_messages = None

    def chat_completion(self, messages, temperature=None, **kwargs):
        self.calls += 1
        self.last_messages = messages
        payload = self.payloads[min(self.calls - 1, len(self.payloads) - 1)]
        return {"content": payload, "_model_used": "deepseek-ai/DeepSeek-V3.2"}


@_pytest.fixture
def stub_client():
    return _StubClient(_strict_json())


def test_writer_output_has_no_markers(stub_client):
    w = WriterAgent(llm_client=stub_client)
    scene = w.generate_scene(task_card={"chapter_num": 1}, scene_blueprint={"scene_num": 1}, chapter_synopsis="x")
    body = scene.scene_text + scene.hook
    assert "【" not in body and "】" not in body and "章末钩子" not in body
    assert scene.scene_id == 1


def test_writer_prompt_demands_json_contract(stub_client):
    w = WriterAgent(llm_client=stub_client)
    w.generate_scene(task_card={"chapter_num": 1}, scene_blueprint={"scene_num": 1}, chapter_synopsis="x")
    prompt = "\n".join(m.get("content", "") for m in stub_client.last_messages)
    assert CONTRACT_LINE in prompt


def test_writer_strict_failure_regenerates_once():
    stub = _StubClient(["夜色如墨，纯散文无JSON。", _strict_json()])
    w = WriterAgent(llm_client=stub)
    scene = w.generate_scene(task_card={"chapter_num": 1}, scene_blueprint={"scene_num": 1}, chapter_synopsis="x")
    assert stub.calls == 2
    assert scene.scene_text == "夜色如墨，寒风穿林而过。"


def test_writer_strict_failure_twice_raises():
    stub = _StubClient(["夜色如墨，纯散文无JSON。", "还是散文。"])
    w = WriterAgent(llm_client=stub)
    with _pytest.raises(ValueError):
        w.generate_scene(task_card={"chapter_num": 1}, scene_blueprint={"scene_num": 1}, chapter_synopsis="x")
    assert stub.calls == 2
