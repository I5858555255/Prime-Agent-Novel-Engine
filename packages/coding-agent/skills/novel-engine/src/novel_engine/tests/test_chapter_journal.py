from novel_engine.pipeline.chapter_journal import append_scene, completed_scene_ids

def test_corrupt_line_means_scene_incomplete(tmp_path):
    append_scene(tmp_path, 1, {"scene_id": 1, "scene_text": "a", "hook": "", "beats": []})
    with open(tmp_path / "chapter_1_partial.jsonl", "a", encoding="utf-8") as f:
        f.write("{broken json\n")
    assert completed_scene_ids(tmp_path, 1) == {1}
