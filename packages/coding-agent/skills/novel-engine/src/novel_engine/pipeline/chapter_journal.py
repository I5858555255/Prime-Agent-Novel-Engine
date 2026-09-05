"""Runner-owned chapter persistence (Q6/Q11). Writer produces memory objects only."""
import json
from pathlib import Path

def journal_path(root, chapter: int) -> Path:
    return Path(root) / "chapters" / "draft" / f"chapter_{chapter}_partial.jsonl"

def _path(root, chapter: int) -> Path:
    return journal_path(root, chapter)

def append_scene(root, chapter: int, scene: dict) -> bool:
    p = _path(root, chapter)
    p.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps({"scene_id": int(scene["scene_id"]), "scene_text": scene["scene_text"],
                       "hook": scene.get("hook", ""), "beats": list(scene.get("beats", []))}, ensure_ascii=False)
    json.loads(line)  # validate before write
    with open(p, "a", encoding="utf-8") as f:
        f.write(line + "\n")
    return True

def load_scenes(root, chapter: int) -> list[dict]:
    """Shared loader: validated scene dicts in file order; corrupt lines skipped.

    Canonical corrupt-line rule (Q11/Q15c): a line that is not valid JSON, has
    no integer scene_id, or is not a dict means that scene is incomplete — it is
    skipped and the file itself stays valid.
    """
    p = journal_path(root, chapter)
    scenes: list[dict] = []
    if not p.exists():
        return scenes
    for raw in p.read_text(encoding="utf-8").splitlines():
        try:
            d = json.loads(raw)
            if not isinstance(d, dict):
                continue  # valid JSON but not a scene record
            scenes.append({"scene_id": int(d["scene_id"]), "scene_text": d.get("scene_text", ""),
                           "hook": d.get("hook", ""), "beats": list(d.get("beats", []) or [])})
        except (ValueError, KeyError, TypeError):
            continue  # corrupt line = scene incomplete, file stays valid
    return scenes

def completed_scene_ids(root, chapter: int) -> set[int]:
    return {s["scene_id"] for s in load_scenes(root, chapter)}
