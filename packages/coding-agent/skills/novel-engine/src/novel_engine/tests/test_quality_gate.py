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
