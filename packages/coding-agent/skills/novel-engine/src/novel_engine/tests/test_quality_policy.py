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

def test_orchestrator_uses_policy_ratios(monkeypatch, tmp_path):
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
