"""Structured scene contract (Q3/Q8). Pure narrative + independent hook, measured word counts."""
import json, re
from dataclasses import dataclass, field


@dataclass
class SceneOutput:
    scene_id: int
    scene_text: str
    hook: str
    beats: list = field(default_factory=list)


def _clean(text: str) -> str:
    t = text.strip().strip("`").strip()
    m = re.search(r"\{[\s\S]*\}", t)
    return m.group(0) if m else t


def _from_prose(text: str) -> dict:
    return {"scene_id": 0, "scene_text": text.strip(), "hook": "", "beats": []}


def extract_beats_fallback(scene_text: str, limit: int = 3) -> list[str]:
    import re
    sents = [s.strip() for s in re.split(r"[。！？]", scene_text) if len(s.strip()) > 12]
    scored = sorted(sents, key=lambda s: (len(set(re.findall(r"[\u4e00-\u9fa5]{2,}", s))), len(s)), reverse=True)
    return scored[:limit]


def parse_scene(raw: str, model_used: str, strict_models: list) -> "SceneOutput":
    strict = model_used in (strict_models or [])
    data = None
    if strict:
        data = json.loads(_clean(raw))  # raises on prose: caller retries once, then patch path
    else:
        m = re.search(r"```scene\s*([\s\S]*?)\s*```", raw)
        if m:
            try:
                data = json.loads(_clean(m.group(1)))
            except (json.JSONDecodeError, ValueError):
                data = _from_prose(m.group(1))
        else:
            data = _from_prose(raw)
    if "【" in data.get("scene_text", "") or "】" in data.get("scene_text", ""):
        raise ValueError("scene_text contains scaffolding markers")
    return SceneOutput(int(data.get("scene_id", 0)), data.get("scene_text", "").strip(),
                       data.get("hook", "").strip(), list(data.get("beats", []) or []))
