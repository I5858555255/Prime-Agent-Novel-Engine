"""Provider 抽象层：统一 LLM 调用的 reasoning 兜底 / both-empty 重试 / cache-bust。"""
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class ProviderConfig:
    family: str = "agnes"
    api_base: str = "https://apihub.agnes-ai.com"
    model: str = "agnes-2.5-flash"
    reasoning_fallback: bool = True
    thinking_param: Optional[str] = "enable_thinking"
    cache_bust_suffix: str = (
        "\n\n[请直接给出最终答案，严格使用合法 JSON，不要使用思考模式，"
        "不要输出任何分析或推理过程。]"
    )
    retry_temperatures: list = field(default_factory=lambda: [0.85, 0.7, 0.95, 1.0])


class LLMProvider:
    def __init__(self, client, config: Optional[ProviderConfig] = None):
        self.client = client
        self.config = config or ProviderConfig()

    def complete(self, messages, *, output_json=False, temperature=None,
                 max_tokens=None, extra_body=None):
        raise NotImplementedError  # Task 1 实现
