"""
审查评分 Agent：对生成的章节进行分级审查。
100分制：剧情一致性(25) / 人物一致性(20) / 伏笔执行(20) / 文风符合度(15) / 节奏控制(10) / 创新亮点(10)
"""
import json
import logging
from pathlib import Path
from typing import Optional

from llm_client import LLMClient, call_llm

logger = logging.getLogger(__name__)


class ReviewerAgent:
    """章节审查 Agent。"""

    SYSTEM_PROMPT = """你是一位严格的网络小说审查编辑。你的任务是对生成的章节进行评分和反馈。

评分维度（总分100）：
1. 剧情一致性（25分）：是否严格遵循任务卡目标和 plot_graph 节点
2. 人物一致性（20分）：角色行为、语气、境界是否与设定一致
3. 伏笔执行（20分）：clue_plan 中的写作指令是否体现
4. 文风符合度（15分）：是否符合 style_bible.md
5. 节奏控制（10分）：场景切换、情绪曲线是否符合任务卡
6. 创新亮点（10分）：是否有生动细节或意外转折

分级标准：
- ≥85分：PASS
- 60-84分：局部修复（指出问题段落）
- <60分：全量回退到导演环节

输出必须是 JSON：
{{
  "chapter_num": 1,
  "scores": {{
    "plot_consistency": 20,
    "character_consistency": 15,
    "foreshadow_execution": 18,
    "style_match": 12,
    "pacing": 8,
    "innovation": 7
  }},
  "total_score": 80,
  "verdict": "fix",
  "issues": [
    {{
      "dimension": "character_consistency",
      "severity": "high|medium|low",
      "description": "问题描述",
      "suggested_fix": "修复建议"
    }}
  ],
  "praise": "值得保留的优点",
  "fix_scope": "若 verdict=fix，说明需要重新生成的段落范围"
}}"""

    def __init__(self, llm_client: Optional[LLMClient] = None):
        self.llm = llm_client or LLMClient()

    def review_chapter(
        self,
        chapter_num: int,
        task_card: dict,
        synopsis: dict,
        novel_text: str,
        world_state: dict,
    ) -> dict:
        """审查单章。"""
        prompt = f"""请审查第 {chapter_num} 章。

## 任务卡
{json.dumps(task_card, ensure_ascii=False, indent=2)}

## 缩写
{synopsis.get('synopsis', '')}

## 正文（节选）
{novel_text[:6000]}

## 世界状态
{json.dumps(world_state, ensure_ascii=False, indent=2)[:2000]}

## 审查要求
1. 检查正文是否完成了任务卡中所有 scene_blueprints 的 goal
2. 检查伏笔动作是否执行
3. 检查是否有 forbidden 项被违反
4. 检查人物行为是否符合 character_bible
5. 检查文风是否符合 style_bible"""

        try:
            review = call_llm(
                prompt=prompt,
                system_prompt=self.SYSTEM_PROMPT,
                client=self.llm,
                output_json=True,
            )
            logger.info(f"Review completed for chapter {chapter_num}: score={review.get('total_score')}")
            return review
        except Exception as e:
            logger.error(f"Review failed for chapter {chapter_num}: {e}")
            raise

    def grade_review(self, review: dict) -> str:
        """根据评分给出 verdict。"""
        score = review.get("total_score", 0)
        if score >= 85:
            return "pass"
        elif score >= 60:
            return "fix"
        else:
            return "fail"

    def _extract_segment(self, text: str, scope: str) -> str:
        """根据 fix_scope 从原文中提取问题段落。"""
        if not scope or not text:
            return ""
        # Try to find the scope description as a heading or keyword in the text
        import re
        # Look for scene markers like 【场景N：地点】
        scene_pattern = r'【场景\d+：[^】]*】'
        scenes = list(re.finditer(scene_pattern, text))

        if not scenes:
            # No scene markers, return first 2000 chars as fallback
            return text[:2000]

        # Extract paragraphs around the problem area
        # Use the scope to determine which scene(s) are affected
        scope_lower = scope.lower()
        target_scene_idx = None
        for i, scene_match in enumerate(scenes):
            scene_text = scene_match.group()
            if any(kw in scene_text.lower() for kw in scope_lower.split()):
                target_scene_idx = i
                break

        if target_scene_idx is not None:
            start = scenes[target_scene_idx].start()
            end = scenes[min(target_scene_idx + 1, len(scenes))].start() if target_scene_idx + 1 < len(scenes) else len(text)
            return text[start:end][:2000]

        # Fallback: return text near the first problem keyword
        for kw in scope_lower.split():
            if len(kw) > 2:
                idx = text.lower().find(kw)
                if idx >= 0:
                    start = max(0, idx - 500)
                    end = min(len(text), idx + 2000)
                    return text[start:end]

        return text[:2000]

    def generate_fix_prompt(self, review: dict, original_text: str) -> str:
        """生成局部修复 prompt（优化版：只发送问题段落，减少 token）。"""
        issues = review.get("issues", [])
        fix_scope = review.get("fix_scope", "")

        issue_desc = "\n".join([
            f"- [{issue['severity']}] {issue['dimension']}: {issue['description']}"
            for issue in issues
        ])

        # 提取问题段落而非全文
        problem_segments = []
        if fix_scope:
            segment = self._extract_segment(original_text, fix_scope)
            if segment:
                problem_segments.append({
                    'scope': fix_scope,
                    'original_text': segment[:2000],
                })

        if problem_segments:
            return f"""请根据以下审查意见修复章节。

## 问题清单
{issue_desc}

## 问题段落
{json.dumps(problem_segments, ensure_ascii=False, indent=2)}

## 要求
1. 只修改被标记的问题段落
2. 保留其余内容不变
3. 修复后输出完整章节文本"""
        else:
            # 无具体范围时，使用全文（兼容旧逻辑）
            return f"""请根据以下审查意见修复章节。

## 问题清单
{issue_desc}

## 原文
{original_text[:6000]}

## 要求
1. 只修改被标记的问题段落
2. 保留其余内容不变
3. 修复后输出完整章节文本"""
