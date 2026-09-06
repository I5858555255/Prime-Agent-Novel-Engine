"""Task P3 (TDD): scene_id-indexed patch is THE patch path + read-only seam check.

Design ruling (locked): no marker attempt first — _patch_weak_scenes goes
straight to chapter_journal partials (scene_id-indexed). verify_seams is
read-only: notes only, never gates, never triggers re-polish.
"""
import json

from novel_engine.pipeline.chapter_journal import append_scene


def _make_orchestrator(tmp_path):
    """Minimal orchestrator rooted at tmp_path; config WITHOUT use_mock so the
    fix loop is not skipped, writer.generate_scene stubbed by the caller."""
    (tmp_path / "config").mkdir(parents=True, exist_ok=True)
    (tmp_path / "config" / "runtime_config.json").write_text(
        json.dumps({"llm": {}, "review_llm": {}, "fallback_llm": {}}),
        encoding="utf-8",
    )
    from novel_engine.pipeline.pipeline_orchestrator import PipelineOrchestrator
    return PipelineOrchestrator(project_root=str(tmp_path))


def test_marker_miss_falls_back_to_scene_index(tmp_path, monkeypatch):
    orch = _make_orchestrator(tmp_path)

    # partial.jsonl WITH scenes 1-3 (scene_id-indexed source of truth)
    append_scene(tmp_path, 1, {"scene_id": 1, "scene_text": "场景一旧正文：村口晨雾。", "hook": "", "beats": []})
    append_scene(tmp_path, 1, {"scene_id": 2, "scene_text": "场景二旧正文：集市喧闹。", "hook": "", "beats": []})
    append_scene(tmp_path, 1, {"scene_id": 3, "scene_text": "旧场景三内容：祠堂夜话。", "hook": "", "beats": []})

    # Draft WITHOUT any markers: no 【场景】, no ※ — old marker path can only
    # "Skipping patch" here (single ※-part, scene_num=3 out of range).
    draft = "第一章正文旧场景三内容：祠堂夜话。无人知晓的旧事。"

    class _SceneOut:
        scene_text = "新场景三内容重写版：祠堂灯火通明旧事重提。"

    monkeypatch.setattr(
        orch.writer, "generate_scene", lambda *a, **k: _SceneOut()
    )
    # Prove the marker path is dead: if IncrementalPatcher is called at all, fail.
    from novel_engine.engine import patcher as _patcher_mod

    def _boom(*a, **k):
        raise AssertionError("apply_scene_patch must no longer be called from the fix loop")

    monkeypatch.setattr(_patcher_mod.IncrementalPatcher, "apply_scene_patch", staticmethod(_boom))

    task_card = {
        "chapter_num": 1,
        "scene_blueprints": [
            {"scene_num": 1}, {"scene_num": 2}, {"scene_num": 3},
        ],
    }
    review = {"fix_scope": "场景3", "issues": []}
    result = orch._patch_weak_scenes(draft, review, task_card, {"synopsis": ""})

    assert result is not None, "scene_id-indexed patch must not silently skip"
    assert "新场景三内容重写版" in result
    assert "旧场景三内容" not in result


def test_seam_check_is_read_only():
    from novel_engine.quality.repetition_detector import verify_seams
    original = "…scene1 ends 午后…\n\n…scene2 starts 午后…"
    notes = verify_seams(original)
    assert isinstance(notes, list)  # notes only, no rewrite, no raise
    assert original == "…scene1 ends 午后…\n\n…scene2 starts 午后…"  # input untouched


def test_fresh_reset_clears_stale_draft_journals(tmp_path):
    """P3 fix round 1: fresh reset must clear run-scoped chapters/draft artifacts
    (stale chapter_{n}_partial.jsonl would otherwise clobber newer draft text via
    the scene_id-indexed patch path, which trusts the journal by filename)."""
    from novel_engine.pipeline.reset_state import reset_runtime_state

    # Seed a stale journal + a stale force-best draft .txt (both run-scoped).
    append_scene(tmp_path, 1, {"scene_id": 1, "scene_text": "stale", "hook": "", "beats": []})
    stale_txt = tmp_path / "chapters" / "draft" / "chapter_1.txt"
    stale_txt.write_text("stale draft", encoding="utf-8")
    # Out-of-scope files must survive the reset.
    keeper = tmp_path / "chapters" / "draft" / "notes.md"
    keeper.write_text("keep", encoding="utf-8")

    reset_runtime_state(tmp_path)

    assert not (tmp_path / "chapters" / "draft" / "chapter_1_partial.jsonl").exists()
    assert not stale_txt.exists()
    assert keeper.read_text(encoding="utf-8") == "keep"
