# -*- coding: utf-8 -*-
"""CC round-27：相位级模型路由配置回归。

当前基线：active_profile=siliconflow，所有 phase 主模型为 deepseek-ai/DeepSeek-V3.2。
本测试锁定 llm_providers.json 的这一矩阵，防止选择器/后续改动意外回退。
"""
import json
from pathlib import Path

_CFG = Path(__file__).parents[2] / "config" / "llm_providers.json"


def _sf_phases():
    cfg = json.loads(_CFG.read_text(encoding="utf-8"))
    assert cfg.get("active_profile") == "siliconflow"
    return cfg["profiles"]["siliconflow"]["phases"]


def test_all_phases_use_deepseek_v3_2():
    ph = _sf_phases()
    for name in ("scenes", "outline", "director", "synopsis", "polish", "review", "refine"):
        models = ph[name]["models"]
        assert models and models[0] == "deepseek-ai/DeepSeek-V3.2", (name, models)


def test_review_phase_keeps_json_mode():
    rev = _sf_phases()["review"]
    assert rev.get("response_format") == "json_object"
