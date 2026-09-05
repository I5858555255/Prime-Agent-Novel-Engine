"""Single source of truth for all quality thresholds and severities (Q2/Q7)."""
import json
from pathlib import Path

DEFAULT_POLICY = {
    "chapter_target_chars": 7500,
    "min_ratio": 0.65,
    "max_ratio": 1.35,
    "tolerance_chars": 50,
    "publication_line": 88,
    "severity_map": {
        "leak_scaffolding": "hard",
        "truncation": "hard",
        "verbatim_duplication": "hard",
        "forbidden_block": "hard",
        "scene_missing": "hard",
        "length_deviation": "note",
        "beat_repetition_thematic": "note",
        "hook_missing": "note",
    },
}


def load_quality_policy(root):
    cfg_path = Path(root) / "config" / "runtime_config.json"
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        cfg = {}
    merged = dict(DEFAULT_POLICY)
    merged.update(cfg.get("quality_policy", {}))
    table = dict(DEFAULT_POLICY["severity_map"])
    table.update(cfg.get("quality_policy", {}).get("severity_map", {}))
    merged["severity_map"] = table
    return merged


def derive_scene_targets(chapter_target: int, scene_count: int) -> list[int]:
    base, rem = divmod(int(chapter_target), max(1, int(scene_count)))
    out = [base] * max(1, int(scene_count))
    out[-1] += rem
    return out


def is_blocking(policy: dict, category: str) -> bool:
    return policy.get("severity_map", {}).get(category) == "hard"
