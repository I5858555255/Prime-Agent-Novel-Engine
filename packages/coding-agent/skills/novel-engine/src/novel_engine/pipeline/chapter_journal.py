"""Runner-owned chapter persistence (Q6/Q11). Writer produces memory objects only."""
import json
from pathlib import Path

def _path(root, chapter: int) -> Path:
    return Path(root) / "chapters" / "draft" / f"chapter_{chapter}_partial.jsonl"

def append_scene(root, chapter: int, scene: dict) -> bool:
    p = _path(root, chapter)
    p.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps({"scene_id": int(scene["scene_id"]), "scene_text": scene["scene_text"],
                       "hook": scene.get("hook", ""), "beats": list(scene.get("beats", []))}, ensure_ascii=False)
    json.loads(line)  # validate before write
    with open(p, "a", encoding="utf-8") as f:
        f.write(line + "\n")
    return True

def completed_scene_ids(root, chapter: int) -> set[int]:
    p = _path(root, chapter)
    done: set[int] = set()
    if not p.exists():
        return done
    for raw in p.read_text(encoding="utf-8").splitlines():
        try:
            done.add(int(json.loads(raw)["scene_id"]))
        except (ValueError, KeyError, TypeError):
            continue  # corrupt line = scene incomplete, file stays valid
    return done
