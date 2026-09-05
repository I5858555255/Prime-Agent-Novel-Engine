from novel_engine.pipeline.chapter_journal import (
    append_scene,
    completed_scene_ids,
    journal_path,
    load_scenes,
)

def test_corrupt_line_means_scene_incomplete(tmp_path):
    append_scene(tmp_path, 1, {"scene_id": 1, "scene_text": "a", "hook": "", "beats": []})
    append_scene(tmp_path, 1, {"scene_id": 2, "scene_text": "b", "hook": "h", "beats": ["x"]})
    # Corrupt lines go into the REAL journal file (via the module's path helper)
    with open(journal_path(tmp_path, 1), "a", encoding="utf-8") as f:
        f.write("{broken json\n")            # malformed JSON
        f.write('{"scene_text": "no id"}\n')  # missing scene_id
        f.write("[1, 2, 3]\n")                # valid JSON but not a scene dict
    assert completed_scene_ids(tmp_path, 1) == {1, 2}
    # File stays valid: further appends still work and count
    append_scene(tmp_path, 1, {"scene_id": 3, "scene_text": "c", "hook": "", "beats": []})
    assert completed_scene_ids(tmp_path, 1) == {1, 2, 3}
    loaded = load_scenes(tmp_path, 1)
    assert [(d["scene_id"], d["scene_text"], d["hook"], d["beats"]) for d in loaded] == [
        (1, "a", "", []),
        (2, "b", "h", ["x"]),
        (3, "c", "", []),
    ]

def test_missing_journal_means_nothing_complete(tmp_path):
    assert completed_scene_ids(tmp_path, 99) == set()
    assert load_scenes(tmp_path, 99) == []
