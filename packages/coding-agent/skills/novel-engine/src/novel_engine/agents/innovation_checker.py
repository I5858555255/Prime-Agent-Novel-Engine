class InnovationChecker:
    def rewrite(self, text: str, review: dict, client=None) -> str:
        from novel_engine.core.llm_client import call_llm
        weak = [k for k, v in (review.get("dimension_scores") or {}).items() if v < 8]
        prompt = (f"请在不破坏设定前提下为下文注入新颖转折/意象/视角，重点改善：{weak}。\n\n原文：\n{text}")
        return call_llm(prompt, system_prompt="你是创意写作顾问", client=client, output_json=False)
