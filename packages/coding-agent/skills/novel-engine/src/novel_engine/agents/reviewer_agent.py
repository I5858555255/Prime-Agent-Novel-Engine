"""
审查评分 Agent：对生成的章节进行分级审查。
100分制：剧情一致性(25) / 人物一致性(20) / 伏笔执行(20) / 文风符合度(15) / 节奏控制(10) / 创新亮点(10)
"""
import json
import logging
import re
from pathlib import Path
from typing import Optional

from novel_engine.core.llm_client import LLMClient, call_llm

logger = logging.getLogger(__name__)

# 各评分维度满分（与 SYSTEM_PROMPT / _rewrite_weak_dimensions 保持一致，总计 100）
DIM_MAX = {
    "plot_consistency": 25,
    "character_consistency": 20,
    "foreshadow_execution": 20,
    "style_match": 15,
    "pacing": 10,
    "innovation": 10,
}


def _to_float(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _normalize_review(review: dict) -> dict:
    """强制总分落在 0-100 刻度：将各维度夹取到定义上限后重新求和，
    避免模型返回越界分数（如 total_score=110）导致刻度失真。"""
    raw = review.get("scores") or {}
    norm = {name: max(0.0, min(mx, _to_float(raw.get(name))))
            for name, mx in DIM_MAX.items()}
    total = sum(norm.values())
    review["scores"] = norm
    review["total_score"] = int(round(total))
    return review


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

硬性约束（违反任意一条直接扣5-10分）：
- 禁止出现英文词汇（如 steady, crossed, arms 等）
- 禁止场景顺序与任务卡不符
- 禁止章节内容截断（必须完整呈现所有场景）
- 禁止核心伏笔完全缺失
- 禁止人物台词风格与设定不符

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
            review = _normalize_review(review)
            logger.info(f"Review completed for chapter {chapter_num}: score={review.get('total_score')}")
            return review
        except Exception as e:
            logger.error(f"Review failed for chapter {chapter_num}: {e}")
            raise

    def grade_review(self, review: dict) -> str:
        import json
        from pathlib import Path
        try:
            cfg = json.loads((Path(__file__).parent.parent / "config" /
                              "runtime_config.json").read_text(encoding="utf-8"))
        except Exception:
            cfg = {}
        line = cfg.get("quality", {}).get("publication_line", 85)
        fix_t = cfg.get("quality", {}).get("fix_threshold", 60)
        score = review.get("total_score", 0)
        if score >= line:
            return "pass"
        elif score >= fix_t:
            return "fix"
        return "fail"

    @staticmethod
    def _chinese_num_to_int(cn: str) -> int:
        """将中文数字（一~十、十一~十九、二十）转为整数。"""
        cn_map = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
                  "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
        if cn == "十":
            return 10
        if "十" in cn:
            head, _, tail = cn.partition("十")
            tens = cn_map.get(head, 1) * 10 if head else 10
            ones = cn_map.get(tail, 0)
            return tens + ones
        return cn_map.get(cn, 0)

    def _extract_segment(self, text: str, scope: str) -> str:
        """根据 fix_scope 从原文中提取问题段落，兼容多种场景标记格式。"""
        if not scope or not text:
            return text[:2000]

        scope_lower = scope.lower()
        # 尝试从 scope 中解析出场景编号，如 "场景2"、"scene 3"、"第2场景"
        target_nums = set()
        for m in re.finditer(r"(?:场景|scene)\s*(\d+)", scope_lower):
            target_nums.add(int(m.group(1)))

        # Format 1: 【场景N：地点】
        scene_pattern = r'【场景(\d+)：[^】]*】'
        scenes = list(re.finditer(scene_pattern, text))

        if scenes:
            target_scene_idx = None
            # 优先按场景编号匹配
            if target_nums:
                for i, scene_match in enumerate(scenes):
                    if int(scene_match.group(1)) in target_nums:
                        target_scene_idx = i
                        break
            # 其次按关键词匹配场景标题
            if target_scene_idx is None:
                for i, scene_match in enumerate(scenes):
                    if any(kw in scene_match.group().lower() for kw in scope_lower.split()):
                        target_scene_idx = i
                        break

            if target_scene_idx is not None:
                start = scenes[target_scene_idx].start()
                end = scenes[min(target_scene_idx + 1, len(scenes))].start() if target_scene_idx + 1 < len(scenes) else len(text)
                return text[start:end][:3000]

        # Format 2: ### 其一/其二...
        section_pattern = r'###\s*[一二三四五六七八九十]+'
        if re.search(section_pattern, text):
            sections = re.split(r'(?=###\s*[一二三四五六七八九十]+)', text)
            target_section_idx = None
            # 按场景编号映射到中文序号段
            if target_nums:
                for i, section in enumerate(sections):
                    match = re.match(r'###\s*([一二三四五六七八九十]+)', section.strip())
                    if match:
                        num = self._chinese_num_to_int(match.group(1))
                        if num in target_nums:
                            target_section_idx = i
                            break
            # 其次按关键词匹配段内容
            if target_section_idx is None:
                for i, section in enumerate(sections):
                    if any(kw in section.lower() for kw in scope_lower.split() if len(kw) > 2):
                        target_section_idx = i
                        break
            if target_section_idx is not None:
                return sections[target_section_idx][:3000]

        # Format 3: 按 ※ 分隔符分割
        parts = re.split(r'\n※\n', text)
        if len(parts) > 1:
            scope_lower = scope.lower()
            # 优先按场景编号匹配
            if target_nums:
                for i, part in enumerate(parts):
                    m = re.search(r'【场景(\d+)：', part)
                    if m and int(m.group(1)) in target_nums:
                        return part[:3000]
            for i, part in enumerate(parts):
                if any(kw in part.lower() for kw in scope_lower.split() if len(kw) > 2):
                    return part[:3000]
            # 如果找不到关键词，返回第一部分
            return parts[0][:3000]

        # Fallback: 按关键词定位
        scope_lower = scope.lower()
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
        problem_text = self._extract_segment(original_text, review.get("fix_scope", ""))

        if not problem_text:
            problem_text = original_text[:3000]

        issue_desc = "\n".join([
            f"- [{issue.get('severity', 'medium')}] {issue.get('dimension', '')}: {issue.get('description', '')}"
            for issue in issues
        ])

        prompt = f"""请修复以下章节中的问题段落。

## 问题描述
{issue_desc}

## 问题段落
{problem_text}

## 原文全文（前3000字）
{original_text[:3000]}

## 修复要求
1. 仅修复问题段落，保持其余内容不变
2. 保持文风、人物名字和上下文剧情连贯
3. 修复后输出完整章节文本
4. 不添加任何解释或注释"""

        return prompt
