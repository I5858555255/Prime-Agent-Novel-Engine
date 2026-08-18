"""
LLM 客户端：封装 Agnes 2.0 Flash API 调用。
支持真实 API 和离线 Mock 两种模式。
"""
import json
import time
import logging
from pathlib import Path
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# Module-level call log for cost tracking
_call_log: list[dict] = []

DEFAULT_API_BASE = "https://apihub.agnes-ai.com"
DEFAULT_MODEL = "agnes-2.0-flash"


class MockLLMClient:
    """离线 Mock LLM：返回确定性模板内容，用于测试流水线。"""

    def __init__(self):
        self.call_count = 0

    @staticmethod
    def _extract_chapter_num(messages: list[dict]) -> int:
        """从消息中提取章节号。"""
        import re
        combined = "\n".join(m.get("content", "") for m in messages)
        match = re.search(r'第\s*(\d+)\s*章', combined)
        if match:
            return int(match.group(1))
        return 0

    def chat_completion(
        self,
        messages: list[dict],
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        retry_on_error: bool = True,
        max_retries: int = 3,
    ) -> dict:
        self.call_count += 1
        user_content = messages[-1]["content"] if messages else ""

        # Check ALL message content, not just user_content, since system_prompt may carry the signal
        combined = "\n".join(m.get("content", "") for m in messages)

        # Extract chapter number from prompt
        chapter_num = self._extract_chapter_num(messages)

        # Review scoring has the most specific signature — check first
        if "审查要求" in combined or ("评分" in combined and "维度" in combined):
            return {"role": "assistant", "content": _mock_review(self.call_count)}
        # Task card generation
        elif "任务卡" in combined or "scene_blueprints" in combined:
            return {"role": "assistant", "content": _mock_task_card(chapter_num)}
        # Synopsis generation
        elif "缩写" in combined or "state_changes" in combined:
            return {"role": "assistant", "content": _mock_synopsis(chapter_num)}
        # Novel writing
        elif "正文" in combined or "场景" in combined:
            return {"role": "assistant", "content": _mock_novel_scene(chapter_num)}
        else:
            return {"role": "assistant", "content": "这是 Mock LLM 的默认回复。"}


def _mock_task_card(seed: int) -> str:
    return json.dumps({
        "chapter_num": seed,
        "core_goal": f"第{seed}章核心目标：推进主线剧情",
        "conflicts": {
            "internal": "主角内心迷茫，不知未来道路",
            "external": "外部强敌环伺，生存压力巨大"
        },
        "emotion_curve": {
            "start": "压抑",
            "middle": "冲突",
            "climax": "高潮",
            "end": "余韵"
        },
        "scene_blueprints": [
            {
                "scene_num": 1,
                "location": "雾隐村",
                "characters": ["陆烬", "陈老根"],
                "goal": "展现荒村的诡异和生活细节",
                "conflict": "陈老根行为反常",
                "emotion": "疑惑",
                "word_count_target": 1000
            },
            {
                "scene_num": 2,
                "location": "昆仑禁区外围",
                "characters": ["陆烬"],
                "goal": "主角探索禁区并吸收暴走活化氧",
                "conflict": "禁区凶险",
                "emotion": "紧张",
                "word_count_target": 1200
            },
            {
                "scene_num": 3,
                "location": "铁风武馆",
                "characters": ["陆烬", "馆主"],
                "goal": "拜师学艺，初窥武道门径",
                "conflict": "武馆弟子的排挤",
                "emotion": "不屈",
                "word_count_target": 1500
            }
        ],
        "foreshadow_actions": [
            {
                "foreshadow_id": "F001",
                "action": "主角抚摸古玉，古玉发出微弱的红光",
                "intensity": "隐晦提示"
            }
        ],
        "chapter_hook": "远处天空划过一道璀璨的剑光，预示着风暴将至。",
        "forbidden_checks": [
            "确认未违反 author_intent 中的 forbidden 项"
        ]
    }, ensure_ascii=False)


def _mock_synopsis(seed: int) -> str:
    return json.dumps({
        "chapter_num": seed,
        "synopsis": f"第{seed}章缩写：韩玄在宗门中继续成长，经历考验与挑战，逐步揭开身世之谜。",
        "state_changes": [
            {"type": "character_realm", "target": "C001", "new_value": "炼气四层", "chapter": seed},
            {"type": "relationship_update", "target": "R002", "new_value": "好感度提升", "chapter": seed}
        ],
        "foreshadow_execution": [
            {
                "foreshadow_id": "F001",
                "executed": True,
                "note": "陆烬抚摸古玉并感受到其异样"
            }
        ]
    }, ensure_ascii=False)


def _mock_novel_scene(seed: int) -> str:
    # return string directly for scene generation
    return f"这是第 {seed} 章生成的正文场景片段。韩玄在迷雾中前行，每一步都带着坚定与谨慎。"


def _mock_review(seed: int) -> str:
    base_score = min(85 + (seed % 10), 96)
    return json.dumps({
        "chapter_num": seed,
        "scores": {
            "plot_consistency": 23,
            "character_consistency": 18,
            "foreshadow_execution": 17,
            "style_match": 13,
            "pacing": 9,
            "innovation": 9
        },
        "total_score": base_score,
        "verdict": "pass" if base_score >= 85 else "fix",
        "issues": [],
        "praise": "整体质量良好，情节连贯，人物塑造生动。",
        "fix_scope": ""
    }, ensure_ascii=False)


class LLMClient:
    """OpenAI-compatible LLM 客户端。"""

    def __init__(
        self,
        api_base: str = DEFAULT_API_BASE,
        model: str = DEFAULT_MODEL,
        api_key: Optional[str] = None,
        temperature: float = 0.85,
        max_tokens: int = 4096,
        timeout: int = 120,
        use_mock: bool = False,
    ):
        self.api_base = api_base.rstrip("/")
        self.model = model
        self.api_key = api_key or ""
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.timeout = timeout
        self.use_mock = use_mock
        self._client: Optional[httpx.Client] = None
        self._mock = MockLLMClient() if use_mock else None

    @classmethod
    def from_config(cls, config_path: str | Path) -> "LLMClient":
        path = Path(config_path)
        if not path.exists():
            logger.warning(f"配置文件不存在：{path}，使用默认配置")
            return cls()
        with open(path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        llm_cfg = cfg.get("llm", {})
        # Fallback: check environment variable first, then fallback to config
        import os
        api_key = os.environ.get("ZLEAP_MODEL_API_KEY") or os.environ.get("ZLEAP_API_KEY") or llm_cfg.get("api_key") or ""
        if not api_key or "redacted" in str(api_key).lower():
            _env_path = Path(__file__).parent.parent / ".env"
            if _env_path.exists():
                for _line in _env_path.read_text(encoding="utf-8").splitlines():
                    if _line.startswith("ZLEAP_MODEL_API_KEY="):
                        api_key = _line.split("=", 1)[1].strip().strip('"').strip("'")
                        break
        return cls(
            api_base=llm_cfg.get("api_base", DEFAULT_API_BASE),
            model=llm_cfg.get("model", DEFAULT_MODEL),
            api_key=api_key,
            temperature=llm_cfg.get("temperature", 0.85),
            max_tokens=llm_cfg.get("max_tokens", 4096),
            timeout=llm_cfg.get("timeout_seconds", 120),
            use_mock=llm_cfg.get("use_mock", False),
        )

    def _get_client(self) -> httpx.Client:
        if self._client is None:
            headers = {"Content-Type": "application/json"}
            if self.api_key:
                headers["Authorization"] = f"Bearer {self.api_key}"
            self._client = httpx.Client(
                base_url=self.api_base,
                headers=headers,
                timeout=self.timeout,
            )
        return self._client

    def chat_completion(
        self,
        messages: list[dict],
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        retry_on_error: bool = True,
        max_retries: int = 3,
    ) -> dict:
        if self.use_mock or self._mock:
            return self._mock.chat_completion(messages, temperature, max_tokens, retry_on_error, max_retries)

        client = self._get_client()
        last_error = None

        for attempt in range(max_retries):
            try:
                resp = client.post(
                    "/v1/chat/completions",
                    json={
                        "model": self.model,
                        "messages": messages,
                        "temperature": temperature if temperature is not None else self.temperature,
                        "max_tokens": max_tokens if max_tokens is not None else self.max_tokens,
                    },
                )
                resp.raise_for_status()
                data = resp.json()
                # Capture token usage for cost tracking
                usage = data.get("usage", {})
                prompt_tokens = usage.get("prompt_tokens", 0)
                completion_tokens = usage.get("completion_tokens", 0)
                total_tokens = usage.get("total_tokens", prompt_tokens + completion_tokens)
                # Also capture reasoning tokens if present (Agnes thinking tokens)
                reasoning_tokens = usage.get("reasoning_tokens", 0)

                choice = data["choices"][0]
                return {
                    "role": choice.get("message", {}).get("role", "assistant"),
                    "content": choice.get("message", {}).get("content", ""),
                    "finish_reason": choice.get("finish_reason"),
                    "_usage": {
                        "prompt_tokens": prompt_tokens,
                        "completion_tokens": completion_tokens,
                        "total_tokens": total_tokens,
                        "reasoning_tokens": reasoning_tokens,
                    },
                }
            except httpx.HTTPStatusError as e:
                last_error = e
                logger.error(f"HTTP错误 (尝试 {attempt+1}/{max_retries}): {e.response.status_code} {e.response.text[:200]}")
                if not retry_on_error or attempt == max_retries - 1:
                    raise
                time.sleep(2 ** attempt)
            except httpx.ConnectError as e:
                last_error = e
                logger.error(f"连接失败 (尝试 {attempt+1}/{max_retries}): {e}")
                if not retry_on_error or attempt == max_retries - 1:
                    raise RuntimeError(f"API连接失败：{e}") from e
                time.sleep(30)
            except Exception as e:
                last_error = e
                logger.error(f"未知错误 (尝试 {attempt+1}/{max_retries}): {e}")
                if not retry_on_error or attempt == max_retries - 1:
                    raise
                time.sleep(2 ** attempt)

        raise RuntimeError(f"LLM调用失败，已重试{max_retries}次：{last_error}")

    def close(self):
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def call_llm(
    prompt: str,
    system_prompt: str = "",
    client: Optional[LLMClient] = None,
    output_json: bool = False,
    **kwargs,
) -> str | dict:
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})

    if client is None:
        client = LLMClient.from_config(Path(__file__).parent / "config" / "runtime_config.json")

    result = client.chat_completion(messages, **kwargs)
    content = result["content"]

    # Log token usage for cost tracking
    usage = result.get("_usage")
    if usage:
        _call_log.append({
            "prompt_tokens": usage.get("prompt_tokens", 0),
            "completion_tokens": usage.get("completion_tokens", 0),
            "reasoning_tokens": usage.get("reasoning_tokens", 0),
            "total_tokens": usage.get("total_tokens", 0),
        })

    # Strip markdown code fences from ALL LLM responses (Agnes wraps in ``` sometimes)
    import re
    cleaned = content.strip()
    cleaned = re.sub(r'^\s*```(?:json)?\s*', '', cleaned)
    cleaned = re.sub(r'\s*```\s*$', '', cleaned)
    cleaned = cleaned.strip()

    if not cleaned:
        logger.warning("LLM返回空内容，可能是thinking tokens耗尽")
        raise RuntimeError("LLM返回了空响应（可能thinking tokens消耗了全部budget）")

    if output_json:
        # Handle double-brace JSON (Agnes echoes Python f-string escapes like {{...}})
        cleaned = cleaned.replace('{{', '{').replace('}}', '}')
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            logger.warning(f"JSON parse failed, attempting repair on:\n{cleaned[:300]}")
            # Attempt 1: Use json_repair library for robust malformed JSON handling
            try:
                import json_repair
                parsed = json_repair.loads(cleaned)
                if parsed is not None and isinstance(parsed, dict):
                    logger.info("JSON repair succeeded via json_repair")
                    return parsed
            except Exception:
                pass
            # Attempt 2: Fix unquoted string values after colons
            repaired = re.sub(
                r'(?<=:\s)([^",{}\[\]\n\r]+?)(?=\s*[},\]\n\r])',
                lambda m: '"' + m.group(1).strip() + '"',
                cleaned,
            )
            try:
                parsed = json.loads(repaired)
                logger.info("JSON repair succeeded (attempt 2)")
                return parsed
            except json.JSONDecodeError:
                pass
            # Attempt 3: Aggressive — quote ALL unquoted values between : and ,/}
            repaired2 = re.sub(
                r':\s*([^":\{\[\],}\n\r][^,}\n\r]*?)(?=\s*[},\]])',
                lambda m: ': "' + m.group(1).strip() + '"',
                repaired,
            )
            try:
                parsed = json.loads(repaired2)
                logger.info("JSON repair succeeded (attempt 3: aggressive)")
                return parsed
            except json.JSONDecodeError:
                pass
            # Attempt 4: Fallback — extract JSON-like object via regex
            json_match = re.search(r'\{[\s\S]*\}', cleaned)
            if json_match:
                try:
                    parsed = json_repair.loads(json_match.group())
                    if parsed and isinstance(parsed, dict):
                        logger.info("JSON repair succeeded (attempt 4: regex extract + json_repair)")
                        return parsed
                except Exception:
                    pass
            logger.error(f"LLM返回非JSON内容:\n{content[:500]}")
            raise RuntimeError("LLM返回的内容无法解析为有效JSON") from None

    return cleaned




def remove_english_words(text: str) -> str:
    """Remove English words from text to maintain Chinese novel style."""
    # Remove standalone English words (3+ chars)
    text = re.sub(r'\b[a-zA-Z]{3,}\b', '', text)
    # Remove mixed English-Chinese segments
    text = re.sub(r'[a-zA-Z]+(?:\s*[a-zA-Z]+)*', '', text)
    return text.strip()


def get_call_log() -> list[dict]:
    """Return the module-level call log for cost analysis."""
    return list(_call_log)


def reset_call_log():
    """Clear the call log (for test isolation)."""
    _call_log.clear()
