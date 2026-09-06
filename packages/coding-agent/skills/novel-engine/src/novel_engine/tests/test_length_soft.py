def test_length_is_soft_never_hard():
    from novel_engine.pipeline.pipeline_orchestrator import PipelineOrchestrator
    gate = PipelineOrchestrator._deterministic_quality_gate
    class Fake: pass
    task_card = {"chapter_num": 99, "scene_blueprints": [{"word_count_target": 1000}]}
    text = "字" * 2000  # 2000 > 1000*1.35+容差 → length anomaly fires
    out = gate(Fake(), text, task_card)
    assert out["passed"] is True
    assert any("长度" in s for s in out["soft_issues"])
    assert not any("长度" in s for s in out["issues"])
