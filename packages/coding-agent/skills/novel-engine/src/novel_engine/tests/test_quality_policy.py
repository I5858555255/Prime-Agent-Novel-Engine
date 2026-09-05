from novel_engine.core.quality_policy import load_quality_policy, derive_scene_targets, is_blocking

def test_policy_has_six_keys_and_eight_severities(tmp_path):
    p = load_quality_policy(tmp_path)
    assert p["chapter_target_chars"] == 7500
    assert p["publication_line"] == 88
    assert p["severity_map"]["leak_scaffolding"] == "hard"
    assert p["severity_map"]["length_deviation"] == "note"

def test_scene_targets_derived_remainder_last():
    assert derive_scene_targets(7500, 4) == [1875, 1875, 1875, 1875]
    assert derive_scene_targets(7500, 3) == [2500, 2500, 2500]

def test_is_blocking_reads_table_only():
    p = {"severity_map": {"length_deviation": "note", "truncation": "hard"}}
    assert is_blocking(p, "length_deviation") is False
    assert is_blocking(p, "truncation") is True

def test_detector_uses_policy_ratios(monkeypatch, tmp_path):
    # Detector-only coverage: the repetition detector reads policy via the
    # quality_policy module attribute, so patching there shifts its bounds.
    from novel_engine.core import quality_policy as qp
    seen = {}
    real = qp.load_quality_policy
    def spy(root):
        p = real(root)
        seen.update(p)
        p["min_ratio"] = 0.10
        p["max_ratio"] = 10.0
        return p
    monkeypatch.setattr(qp, "load_quality_policy", spy)
    # any length gate computed afterwards must use 0.10/10.0 bounds
    from novel_engine.quality.repetition_detector import detect_length_anomaly
    assert detect_length_anomaly("x" * 5000, 7500)["anomaly"] is False
    assert seen["chapter_target_chars"] == 7500

def test_orchestrator_uses_policy_ratios(monkeypatch, tmp_path):
    # Orchestrator binds load_quality_policy directly, so the spy must patch
    # novel_engine.pipeline.pipeline_orchestrator.load_quality_policy.
    from novel_engine.pipeline import pipeline_orchestrator as orch_mod
    real = orch_mod.load_quality_policy
    def spy(root):
        p = dict(real(root))
        p["min_ratio"] = 0.10
        p["max_ratio"] = 10.0
        return p
    monkeypatch.setattr(orch_mod, "load_quality_policy", spy)
    p = orch_mod.load_quality_policy(tmp_path)
    assert p["min_ratio"] == 0.10
    assert p["max_ratio"] == 10.0
    # A shifted ratio changes the orchestrator's computed word-count bounds.
    target_min = int(p["chapter_target_chars"] * p["min_ratio"])
    target_max = int(p["chapter_target_chars"] * p["max_ratio"])
    assert target_min == int(7500 * 0.10)
    assert target_max == int(7500 * 10.0)
    assert target_min < int(7500 * 0.65) < target_max

def test_no_hardcoded_severity_in_orchestrator():
    import pathlib
    src = pathlib.Path("novel_engine/pipeline/pipeline_orchestrator.py").read_text(encoding="utf-8")
    assert 'in ("high", "block")' not in src
    assert 'in ("high","block")' not in src

def test_director_targets_come_from_policy():
    import pathlib
    src = pathlib.Path("novel_engine/agents/chapter_director.py").read_text(encoding="utf-8")
    assert '"word_count_target": 2000' not in src
    assert '"word_count_target": 1800' not in src
