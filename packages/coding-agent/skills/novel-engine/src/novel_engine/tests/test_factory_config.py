"""Factory config contract tests (W7): verify shipped config values are correct."""
import json
from pathlib import Path


def test_llm_providers_factory_contract():
    """Verify llm_providers.json has expected shipped values."""
    cfg_path = Path(__file__).parent.parent / "config" / "llm_providers.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))

    # active_profile must be siliconflow (CC round-0 baseline)
    assert cfg["active_profile"] == "siliconflow", f"expected siliconflow, got {cfg['active_profile']}"

    # base_url must NOT contain /v1
    profile = cfg["profiles"]["siliconflow"]
    base_url = profile["base_url"]
    assert "/v1" not in base_url, f"base_url should not contain /v1: {base_url}"
    assert base_url == "https://api.siliconflow.cn"

    # CC round-0：所有相位主模型 deepseek-ai/DeepSeek-V3.2
    phases = profile["phases"]
    for phase_name in ["outline", "director", "synopsis", "scenes", "polish", "review", "refine"]:
        assert phase_name in phases, f"missing phase: {phase_name}"
        models = phases[phase_name]["models"]
        assert models == ["deepseek-ai/DeepSeek-V3.2"], f"{phase_name} models: {models}"


def test_runtime_config_factory_contract():
    """Verify runtime_config.json has expected shipped quality values."""
    cfg_path = Path(__file__).parent.parent / "config" / "runtime_config.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))

    # Quality policy values
    qp = cfg.get("quality_policy", {})
    assert qp.get("chapter_target_chars") == 8000
    assert qp.get("min_ratio") == 0.85
    assert qp.get("max_ratio") == 1.3125

    # Quality section
    q = cfg.get("quality", {})
    assert q.get("publication_line") == 88
