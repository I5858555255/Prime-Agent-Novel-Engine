"""Single source of truth for all quality thresholds and severities (Q2/Q7)."""
import json
from pathlib import Path

DEFAULT_POLICY = {
    "chapter_target_chars": 10000,
    # CC round-21 P1：单场景初稿目标下限 2150（区间 2100-2200）。flash 系统性把单场写短，
    # 把每场景 ask 抬到 2150（只升不降），配合初稿 <0.7 源头重生，使组装稿稳定越过章软下限。
    "scene_target_chars": 2150,
    "min_ratio": 0.80,
    "max_ratio": 1.20,
    "tolerance_chars": 100,
    "publication_line": 88,
    "soft_publication_line": 85,  # CC round-14: 85-87.9 且确定性门全过+无high即放行（人验抽查）
    "fix_threshold": 60,
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


def derive_scene_targets(chapter_target: int, scene_count: int,
                         scene_floor: int | None = None) -> list[int]:
    n = max(1, int(scene_count))
    base, rem = divmod(int(chapter_target), n)
    # CC round-21：每场景 ask 不低于 scene_target_chars（默认 2150），只升不降；
    # 故各场目标之和可能高于 chapter_target——那是写作侧 ask（flash 会缩水），章长度门
    # 仍以 chapter_target_chars/min_ratio 为准。
    floor = int(scene_floor) if scene_floor else int(DEFAULT_POLICY["scene_target_chars"])
    per = max(base, floor)
    out = [per] * n
    out[-1] = per + rem
    return out


def is_blocking(policy: dict, category: str) -> bool:
    return policy.get("severity_map", {}).get(category) == "hard"
