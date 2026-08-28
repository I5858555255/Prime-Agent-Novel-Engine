from agents.writer_agent import WriterAgent

def test_polish_uses_full_text_not_truncated():
    seen = {}
    class Rec:
        def chat_completion(self, messages, **k):
            seen["prompt"] = messages[0]["content"]
            seen["max_tokens"] = k.get("max_tokens")
            return "POLISHED"
    w = WriterAgent(llm_client=Rec())
    long_text = "正文" * 6000          # > 8000 chars
    out = w.polish_chapter(long_text, {"title": "t"}, llm_client=Rec())
    assert "POLISHED" == out
    assert "正文" * 100 in seen["prompt"]   # full text present, not just first 8000
    assert seen["max_tokens"] <= 12000
