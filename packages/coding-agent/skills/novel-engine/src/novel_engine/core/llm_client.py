"""
LLM 客户端：封装 Agnes 2.0 Flash API 调用。
支持真实 API 和离线 Mock 两种模式。
"""
import json
import threading
import time
import logging
from pathlib import Path
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# Module-level call log for cost tracking (single source of truth).
# Guarded by _CALL_LOG_LOCK since scene generation is multi-threaded.
_call_log: list[dict] = []
_CALL_LOG_LOCK = threading.Lock()

DEFAULT_API_BASE = "https://apihub.agnes-ai.com"
DEFAULT_MODEL = "agnes-2.5-flash"


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
        extra_body: Optional[dict] = None,
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
        # Match explicit instruction phrases in the USER prompt only. System prompts and
        # embedded context (task cards, volume outline) legitimately contain "任务卡"/
        # "scene_blueprints"/"缩写"/"正文", so only the driving instruction is matched.
        # Task card generation
        if "生成任务卡" in user_content:
            return {"role": "assistant", "content": _mock_task_card(chapter_num)}
        # Synopsis generation
        if "生成剧情缩写" in user_content or "生成缩写" in user_content or "state_changes" in user_content:
            return {"role": "assistant", "content": _mock_synopsis(chapter_num)}
        # Polish — no-op in mock: return the input chapter text unchanged
        if "润色" in user_content:
            marker = "## 待润色文本"
            idx = user_content.find(marker)
            if idx != -1:
                return {"role": "assistant", "content": user_content[idx + len(marker):].strip()}
            return {"role": "assistant", "content": _mock_novel_scene(chapter_num)}
        # Novel writing
        if "正文" in user_content:
            # 目标字数来自场景蓝图，mock 按其扩充正文，使字数分析真实可用
            import re as _re
            _m = _re.search(r"目标字数[:：]\s*(\d+)", user_content)
            target = int(_m.group(1)) if _m else 800
            return {"role": "assistant", "content": _mock_novel_scene(chapter_num, target)}
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


def _mock_novel_scene(seed: int, target: int = 800) -> str:
    # 确定性正文：按目标字数扩充，使 mock 章节字数与 scene word_count_target 匹配
    base = (
        f"第{seed}章，夜色如墨，浓雾自荒原尽头漫卷而来。"
        f"韩玄立于断崖之上，衣袍猎猎作响，目光穿透层层迷雾，"
        f"望见远处城郭中隐约的灯火。他深吸一口气，将胸中积郁尽数压下，"
        f"抬步踏下石阶，每一步都带着坚定与谨慎。"
        f"风声呜咽，似有低语在耳畔盘桓，他却不为所动，"
        f"心中默念道：既已踏上此路，便再无回头之时。"
        f"刹那之间，一缕剑光自天际划过，照亮了他坚毅的面容。"
    )
    if target <= len(base):
        return base
    fill = (
        f"韩玄放慢脚步，细细感受着四周的气息变化。"
        f"草木间偶尔传来的虫鸣，与远处隐约的风声交织成一片。"
        f"他想起师父的教诲：越是看似平静的时刻，越要警惕暗藏的危险。"
        f"指尖轻轻抚过腰间的古玉，温润的触感让他稍稍安心。"
        f"他沿着山路继续前行，心中盘算着接下来的每一步。"
        f"夜色渐深，星光稀疏，他却仿佛看到了前路的方向。"
    )
    out = base
    while len(out) < target:
        out += fill
    return out[:target]


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
        # httpx.Client is not thread-safe for concurrent requests; give each
        # thread its own client via threading.local.
        self._local = threading.local()
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
            _env_path = Path(__file__).parent.parent.parent / ".env"
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
        client = getattr(self._local, "client", None)
        if client is None:
            headers = {"Content-Type": "application/json"}
            if self.api_key:
                headers["Authorization"] = f"Bearer {self.api_key}"
            client = httpx.Client(
                base_url=self.api_base,
                headers=headers,
                timeout=self.timeout,
            )
            self._local.client = client
        return client

    def chat_completion(
        self,
        messages: list[dict],
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        retry_on_error: bool = True,
        max_retries: int = 3,
        extra_body: Optional[dict] = None,
    ) -> dict:
        if self.use_mock or self._mock:
            return self._mock.chat_completion(messages, temperature, max_tokens, retry_on_error, max_retries, extra_body)

        client = self._get_client()
        last_error = None

        for attempt in range(max_retries):
            try:
                body = {
                    "model": self.model,
                    "messages": messages,
                    "temperature": temperature if temperature is not None else self.temperature,
                    "max_tokens": max_tokens if max_tokens is not None else self.max_tokens,
                }
                if extra_body:
                    body.update(extra_body)
                resp = client.post(
                    "/v1/chat/completions",
                    json=body,
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
                # Capture reasoning_content (Agnes/DeepSeek-style thinking) if present
                reasoning_content = choice.get("message", {}).get("reasoning_content", "")
                # Log token usage for cost tracking (thread-safe).
                # Callers may read it via get_call_log().
                with _CALL_LOG_LOCK:
                    _call_log.append({
                        "prompt_tokens": prompt_tokens,
                        "completion_tokens": completion_tokens,
                        "reasoning_tokens": reasoning_tokens,
                        "total_tokens": total_tokens,
                    })
                return {
                    "role": choice.get("message", {}).get("role", "assistant"),
                    "content": choice.get("message", {}).get("content", ""),
                    "finish_reason": choice.get("finish_reason"),
                    "reasoning_content": reasoning_content or "",
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
        client = getattr(self._local, "client", None)
        if client is not None:
            client.close()
            self._local.client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _repair_json(cleaned: str) -> Optional[dict]:
    """多级修复 Agnes 返回的 JSON，成功返回 dict，失败返回 None。"""
    import re
    # Handle double-brace JSON (Agnes echoes Python f-string escapes like {{...}})
    cleaned = cleaned.replace('{{', '{').replace('}}', '}')
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    try:
        import json_repair
        parsed = json_repair.loads(cleaned)
        if parsed is not None and isinstance(parsed, dict):
            logger.info("JSON repair succeeded via json_repair")
            return parsed
    except Exception:
        pass
    repaired = re.sub(
        r'(?<=:\s)([^",{}\[\]\n\r]+?)(?=\s*[},\]\n\r])',
        lambda m: '"' + m.group(1).strip() + '"',
        cleaned,
    )
    try:
        return json.loads(repaired)
    except json.JSONDecodeError:
        pass
    repaired2 = re.sub(
        r':\s*([^":\{\[\],}\n\r][^,}\n\r]*?)(?=\s*[},\]])',
        lambda m: ': "' + m.group(1).strip() + '"',
        repaired,
    )
    try:
        return json.loads(repaired2)
    except json.JSONDecodeError:
        pass
    try:
        import json_repair
        m = re.search(r'\{[\s\S]*\}', cleaned)
        if m:
            parsed = json_repair.loads(m.group())
            if parsed and isinstance(parsed, dict):
                return parsed
    except Exception:
        pass
    return None


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
        client = LLMClient.from_config(
            Path(__file__).parent.parent / "config" / "runtime_config.json")
    from novel_engine.core.llm_provider import LLMProvider, ProviderConfig
    provider = LLMProvider(client, _provider_config_from_runtime())
    return provider.complete(
        messages, output_json=output_json,
        temperature=kwargs.get("temperature"),
        max_tokens=kwargs.get("max_tokens"),
        extra_body=kwargs.get("extra_body"),
    )


def _provider_config_from_runtime():
    try:
        import json
        from pathlib import Path
        from novel_engine.core.llm_provider import ProviderConfig
        cfg = json.loads((Path(__file__).parent.parent / "config" /
                          "runtime_config.json").read_text(encoding="utf-8"))
        p = cfg.get("provider", {})
        return ProviderConfig(
            family=p.get("family", "agnes"),
            api_base=p.get("api_base", "https://apihub.agnes-ai.com"),
            model=p.get("model", "agnes-2.5-flash"),
            reasoning_fallback=p.get("reasoning_fallback", True),
            thinking_param=p.get("thinking_param", "enable_thinking"),
            cache_bust_suffix=p.get("cache_bust_suffix", ""),
            retry_temperatures=p.get("retry_temperatures", [0.85, 0.7, 0.95, 1.0]),
        )
    except Exception:
        return ProviderConfig()




def remove_english_words(text: str) -> str:
    """Remove English words from text to maintain Chinese novel style."""
    # Remove standalone English words (3+ chars)
    text = re.sub(r'\b[a-zA-Z]{3,}\b', '', text)
    # Remove mixed English-Chinese segments
    text = re.sub(r'[a-zA-Z]+(?:\s*[a-zA-Z]+)*', '', text)
    return text.strip()


def get_call_log(client: Optional["LLMClient"] = None) -> list[dict]:
    """Return a snapshot of the thread-safe module-level call log."""
    with _CALL_LOG_LOCK:
        return list(_call_log)


def reset_call_log(client: Optional["LLMClient"] = None):
    """Clear the thread-safe module-level call log."""
    with _CALL_LOG_LOCK:
        _call_log.clear()
