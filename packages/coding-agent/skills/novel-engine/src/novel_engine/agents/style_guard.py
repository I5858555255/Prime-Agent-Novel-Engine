class StyleGuard:
    def rewrite(self, text: str, client=None) -> str:
        from novel_engine.core.llm_client import call_llm
        prompt = "请比对既定文风样本，统一语气与句式节奏，修正违和表达：\n" + text
        return call_llm(prompt, system_prompt="你是文风一致性编辑", client=client, output_json=False)
