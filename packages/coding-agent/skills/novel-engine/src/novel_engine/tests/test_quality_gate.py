from novel_engine.pipeline.quality_gate import evaluate_publish
from novel_engine.core.quality_policy import DEFAULT_POLICY

def test_93_with_leak_is_vetoed():
    r = evaluate_publish(score=93, reviewer_issues=[], det_hard=[], leak=["残留【test】"], violations=[], policy=DEFAULT_POLICY)
    assert r["publish"] is False
    assert any("leak" in x or "泄漏" in x for x in r["reasons"])

def test_88_clean_publishes():
    r = evaluate_publish(score=88, reviewer_issues=[], det_hard=[], leak=[], violations=[], policy=DEFAULT_POLICY)
    assert r["publish"] is True

def test_length_is_note_only():
    r = evaluate_publish(score=90, reviewer_issues=[], det_hard=["[长度] 超标"], leak=[], violations=[], policy=DEFAULT_POLICY)
    assert r["publish"] is True
    assert "长度" in r["note"]

def test_dimension_fallback_matches_orchestrator_log():
    # 回退顺序 category → dimension → severity：hard 维度即使 severity 为 low 也阻断，
    # 且仲裁器与 orchestrator 日志谓词一致。
    from novel_engine.pipeline.pipeline_orchestrator import _review_issue_is_blocking
    issue = {"dimension": "scene_missing", "severity": "low", "description": "x"}
    r = evaluate_publish(score=90, reviewer_issues=[issue], det_hard=[], leak=[], violations=[], policy=DEFAULT_POLICY)
    assert r["publish"] is False
    assert _review_issue_is_blocking(DEFAULT_POLICY, issue) is True

def test_forced_draft_rate_recorded_not_enforced(tmp_path):
    from novel_engine.pipeline.production_runner import summarize_batch
    rep = summarize_batch([{"published": True}, {"published": False, "draft": True}] * 5)
    assert rep["forced_draft_rate"] == 0.5
    assert rep["paused"] is False  # record-only during observation period

def test_forced_draft_predicate_honors_success_and_published(tmp_path):
    from novel_engine.pipeline.production_runner import summarize_batch
    results = [
        {"success": True, "published": True},   # force-published best → not a draft
        {"success": True},                       # published best without flag → not a draft
        {"success": False},                      # failed chapter → draft
        {"success": False, "published": False},  # failed + unpublished → draft
        {"success": True, "published": False},   # unpublished despite success → draft
        {},                                      # missing keys → published (back-compat default)
    ]
    rep = summarize_batch(results)
    assert rep["forced_drafts"] == 3
    assert rep["forced_draft_rate"] == 0.5
    assert rep["paused"] is False
