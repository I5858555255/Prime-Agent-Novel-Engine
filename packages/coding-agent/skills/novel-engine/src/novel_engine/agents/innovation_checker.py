class InnovationChecker:
    def rewrite(self, text: str, review: dict, client=None) -> str:
        from novel_engine.core.llm_client import call_llm
        scores = review.get("scores") or {}
        maxes = {"plot_consistency": 25, "character_consistency": 20,
                 "foreshadow_execution": 20, "style_match": 15,
                 "pacing": 10, "innovation": 10}
        weak = [k for k, v in scores.items() if (v / maxes.get(k, 10)) < 0.85]
        prompt = (f"请在不破坏设定前提下为下文注入新颖转折/意象/视角，重点改善：{weak}。\n\n原文：\n{text}")
        return call_llm(prompt, system_prompt="你是创意写作顾问，擅长用新鲜比喻、意外视角与反常转折提升文本的新颖度", client=client, output_json=False)
