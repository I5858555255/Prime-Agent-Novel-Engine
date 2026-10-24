# -*- coding: utf-8 -*-
"""ch805 归因回归：writer 输出约束含世界观纯净条款（佛学词堆砌禁写）。

修复前 writer 反复输出佛偈（"不二法门/圆顿大教/见性成佛"），仅靠
P6-1 传授检测误打误撞拦截（归因误导）。修复后在 writer 主 prompt 注入
世界观纯净约束，从源头阻断佛学词堆砌。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from novel_engine.agents.writer_agent import WriterAgent


def test_writer_prompt_has_worldview_purity_clause():
    prompt = WriterAgent.SCENE_SYSTEM_PROMPT
    assert "世界观纯净约束" in prompt
    # 关键佛学词必须被点名，确保约束可执行而非空话
    for term in ("不二法门", "圆顿大教", "见性成佛"):
        assert term in prompt, f"prompt 缺禁写词 {term}"


def test_writer_prompt_keeps_existing_language_rule():
    prompt = WriterAgent.SCENE_SYSTEM_PROMPT
    # 既有语言硬约束不得被覆盖（ch805 修复不应破坏英文拦截）
    assert "语言硬约束" in prompt
    assert "100% 中文" in prompt
