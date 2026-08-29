from agents.writer_agent import WriterAgent

def test_polish_uses_full_text_not_truncated():
    seen = {}
    class Rec:
        def chat_completion(self, messages, **k):
            seen["prompt"] = messages[0]["content"]
            seen["max_tokens"] = k.get("max_tokens")
            # 模拟模型返回与输入等长的完整润色正文
            return messages[0]["content"].split("【正文】\n", 1)[-1]
    w = WriterAgent(llm_client=Rec())
    long_text = "正文" * 6000          # > 8000 chars
    out = w.polish_chapter(long_text, {"title": "t"}, llm_client=Rec())
    assert out == long_text             # 返回完整正文
    assert "正文" * 100 in seen["prompt"]   # full text present, not just first 8000
    assert seen["max_tokens"] >= 8000       # 不被旧 8000 截断限制

def test_polish_falls_back_on_degenerate_output():
    class ShortRec:
        def chat_completion(self, messages, **k):
            return "好的"              # 退化短输出（如 5 字符）
    w = WriterAgent(llm_client=ShortRec())
    long_text = "正文" * 6000
    out = w.polish_chapter(long_text, {"title": "t"}, llm_client=ShortRec())
    assert out == long_text             # 回退到原始正文，避免残缺章节
