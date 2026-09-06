"""Task P1: scene-boundary-split polish with measured budget (TDD RED)."""
from novel_engine.agents.writer_agent import WriterAgent


def test_split_preserves_scene_count_and_budget():
    calls = []

    class Stub:
        def chat_completion(self, messages, temperature=None, max_tokens=None, timeout=None, **kw):
            calls.append(max_tokens)
            return {"content": messages[-1]["content"].split("【正文】\n")[-1], "finish_reason": "stop"}

    w = WriterAgent(llm_client=Stub())
    text = "【场景1：村口】\n" + "正" * 2000 + "\n\n※\n\n【场景2：村尾】\n" + "正" * 2000
    out = w._polish_by_scenes(text, {"chapter_num": 1, "title": "t",
        "scene_blueprints": [{"scene_num": 1}, {"scene_num": 2}]}, Stub())
    assert out.count("正") > 1500 and out.count("正") > 1500
    assert all(t >= int(2000 / 0.9) for t in calls)
    # Split proof: one LLM call per scene, ※-joined output with both scenes intact.
    assert len(calls) == 2
    parts = out.split("※")
    assert len(parts) == 2
    assert all(p.count("正") > 1500 for p in parts)
