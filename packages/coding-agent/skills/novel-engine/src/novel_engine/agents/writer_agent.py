"""
缩写生成 Agent + 正文生成 Agent。
阶段2：缩写生成（500字缩写 + 待提交状态变更）
阶段3：正文生成（场景级分段生成）
"""
import json
import logging
from pathlib import Path
from typing import Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

from novel_engine.core.llm_client import LLMClient, call_llm

logger = logging.getLogger(__name__)
def _get_root():
    """获取项目根目录。"""
    return Path(__file__).parent.parent




class SynopsisAgent:
    """缩写生成 Agent：根据任务卡生成500字缩写 + 状态变更提案。"""

    SYSTEM_PROMPT = """你是一位严谨的网络小说缩写生成器。你的任务是根据章节任务卡，生成500字左右的剧情缩写。

要求：
1. 严格按照 scene_blueprints 的顺序组织场景
2. 每个场景的 goal 必须在缩写中体现
3. 缩写要包含关键情节转折和情绪变化
4. 在缩写末尾列出待提交的状态变更（JSON数组）
5. 遵守伏笔动作指令

输出格式：
{{
  "chapter_num": 1,
  "synopsis": "500字左右的剧情缩写...",
  "state_changes": [
    {{
      "type": "character_realm|character_location|relationship_update|timeline_event",
      "target": "目标ID或关系ID",
      "new_value": "新值",
      "chapter": 1
    }}
  ],
  "foreshadow_execution": [
    {{
      "foreshadow_id": "F001",
      "executed": true,
      "note": "如何执行的"
    }}
  ]
}}"""

    def __init__(self, llm_client: Optional[LLMClient] = None):
        self.llm = llm_client or LLMClient()

    def generate_synopsis(self, task_card: dict) -> dict:
        """根据任务卡生成缩写。"""
        chapter_num = task_card.get("chapter_num", 0)

        prompt = f"""请为第 {chapter_num} 章生成剧情缩写。

## 任务卡
{json.dumps(task_card, ensure_ascii=False, indent=2)}

## 约束
- 严格遵守 scene_blueprints 顺序
- 每个场景 goal 必须完成
- 执行所有 foreshadow_actions
- 字数控制在450-550字"""

        try:
            synopsis = call_llm(
                prompt=prompt,
                system_prompt=self.SYSTEM_PROMPT,
                client=self.llm,
                output_json=True,
            )
            logger.info(f"Synopsis generated for chapter {chapter_num}")
            return synopsis
        except Exception as e:
            logger.error(f"Failed to generate synopsis for chapter {chapter_num}: {e}")
            raise



def validate_scene_order(full_text: str, task_card: dict) -> bool:
    """Validate that scenes appear in the correct order as specified in task card."""
    import re
    blueprints = task_card.get("scene_blueprints", [])
    if not blueprints:
        return True
    
    # Find scene markers in text
    scene_pattern = r"【场景\d+：[^】]*】"
    scenes_in_text = re.findall(scene_pattern, full_text)
    
    if len(scenes_in_text) < len(blueprints):
        return False
    
    # Check order matches
    for i, bp in enumerate(blueprints):
        scene_num = bp.get("scene_num", i + 1)
        if f"【场景{scene_num}：" not in scenes_in_text[i]:
            return False
    
    return True


class WriterAgent:
    """正文生成 Agent：按场景拆分生成正文。"""

    SCENE_SYSTEM_PROMPT = """你是一位专业的网络小说作家。你的任务是根据场景蓝图生成高质量的正文段落。

写作要求：
1. 第三人称有限视角（以**陆烬**为主视角）
2. 半文半白，通俗易懂但有古风韵味
3. 对话符合角色身份
4. 战斗描写简洁有力，重意境轻招式罗列
5. 心理描写克制内敛，通过动作和环境折射
6. 环境描写服务于情绪，不单独铺陈超过200字
7. 每场景目标3000-5000字（整个章节）
8. 遵守 scene_blueprints 中的 goal/conflict/emotion
9. 若任务卡中有 foreshadow_actions，必须在本场景中执行

禁忌：
- 禁止现代词汇
- 禁止OOC
- 禁止无意义水字数对话
- 禁止主角光环过强（每次胜利必须有代价）
- 严格禁止出现任何英文词汇
- 必须按照 scene_blueprints 顺序生成，不得打乱
- 必须完整呈现所有场景，不得截断
- 严格执行 foreshadow_actions 中的所有伏笔指令
- 禁止人物台词风格与设定不符
- 禁止场景内容重复"""

    def __init__(self, llm_client: Optional[LLMClient] = None):
        self.llm = llm_client or LLMClient()

    def generate_scene(self, task_card: dict, scene_blueprint: dict, chapter_synopsis: str, previous_context: str = "", pacing_constraints: str = "", temperature_override: Optional[float] = None) -> str:
        """生成单个场景的正文。"""
        chapter_num = task_card.get("chapter_num", 0)
        scene_num = scene_blueprint.get("scene_num", 0)

        context_section = ""
        if previous_context:
            context_section = f"\n\n## 前序场景摘要\n{previous_context}"

        pacing_block = f"\n## 节奏硬性约束\n{pacing_constraints}\n" if pacing_constraints else ""

        prompt = f"""请生成第 {chapter_num} 章第 {scene_num} 场景的正文。

## 章节缩写
{chapter_synopsis}
{context_section}

## 本场景蓝图
{json.dumps(scene_blueprint, ensure_ascii=False, indent=2)}

## 全章节奏参数
- 核心目标：{task_card.get('core_goal', '')}
- 情绪曲线：{json.dumps(task_card.get('emotion_curve', {}), ensure_ascii=False)}
- 章末钩子：{task_card.get('chapter_hook', '')}

## 写作指令
请严格按 scene_blueprint 中的 goal、conflict、emotion 写作。
场景地点：{scene_blueprint.get('location', '未知')}
出场人物：{', '.join(scene_blueprint.get('characters', []))}
{pacing_block}
节奏控制：场景内部要有张力起伏（冲突酝酿→爆发→余波），避免平铺直叙；对话与动作交替推进。
创新亮点：多用生动具体的细节和新鲜比喻，可安排小节内的意外转折，避免套路化表达。
目标字数：{scene_blueprint.get('word_count_target', 1000)}字左右"""

        try:
            content = call_llm(
                prompt=prompt,
                system_prompt=self.SCENE_SYSTEM_PROMPT,
                client=self.llm,
                temperature=temperature_override,
            )
            logger.info(f"Scene {scene_num} generated for chapter {chapter_num}")
            return content
        except Exception as e:
            logger.error(f"Failed to generate scene {scene_num} for chapter {chapter_num}: {e}")
            raise

    def _generate_scene_sync(self, task_card, scene_blueprint, chapter_synopsis, previous_context="", pacing_constraints=""):
        """同步生成单个场景（用于顺序执行）。"""
        return self.generate_scene(task_card, scene_blueprint, chapter_synopsis, previous_context, pacing_constraints)


    def _group_independent_scenes(self, scenes: list[dict]) -> list[list[dict]]:
        """
        将场景按人物重叠分组。
        不相邻且无共享人物的场景可并行生成。
        返回：[(scene_group_1), (scene_group_2), ...]，每组内顺序依赖。
        """
        if len(scenes) <= 1:
            return [scenes]

        groups = []
        current_group = [scenes[0]]

        for i in range(1, len(scenes)):
            prev_chars = set(current_group[-1].get("characters", []))
            curr_chars = set(scenes[i].get("characters", []))
            if not prev_chars.intersection(curr_chars):
                shares_with_any = any(
                    set(s.get("characters", [])).intersection(curr_chars)
                    for s in current_group
                )
                if not shares_with_any:
                    groups.append(current_group)
                    current_group = [scenes[i]]
                else:
                    current_group.append(scenes[i])
            else:
                current_group.append(scenes[i])

        if current_group:
            groups.append(current_group)

        return groups

    def _generate_group(self, task_card: dict, group: list[dict], synopsis_text: str, pacing_constraints: str = "", temperature_override: Optional[float] = None) -> list[tuple[dict, str]]:
        """顺序生成一个场景组（组内场景共享人物，存在上下文依赖）。"""
        group_contents = []
        previous_context = ""
        for bp in group:
            content = self.generate_scene(task_card, bp, synopsis_text, previous_context, pacing_constraints, temperature_override)
            group_contents.append((bp, content))
            previous_context = "\n\n※\n\n".join(
                c for _, c in group_contents[-3:]
            ) if len(group_contents) >= 3 else "\n\n".join(c for _, c in group_contents)
        return group_contents

    def generate_full_chapter(self, task_card: dict, synopsis: dict, pacing_constraints: str = "",
                              temperature_override: Optional[float] = None) -> str:
        """
        生成完整章节正文。
        独立场景组并行生成，组内依赖场景顺序生成，最终按 scene_num 排序保证顺序。
        """
        chapter_num = task_card.get("chapter_num", 0)
        scenes = task_card.get("scene_blueprints", [])
        synopsis_text = synopsis.get("synopsis", "")

        if not scenes:
            return ""

        # 分组：组间无人物重叠（可并行），组内共享人物（顺序执行）
        groups = self._group_independent_scenes(scenes)

        all_scene_contents: list[tuple[dict, str]] = []

        if len(groups) <= 1:
            # 只有一组：无并行价值，直接顺序生成
            for group in groups:
                all_scene_contents.extend(self._generate_group(task_card, group, synopsis_text, pacing_constraints, temperature_override))
        else:
            max_workers = min(len(groups), 4)
            with ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="scene") as executor:
                future_to_group = {
                    executor.submit(self._generate_group, task_card, group, synopsis_text, pacing_constraints, temperature_override): group
                    for group in groups
                }
                for future in as_completed(future_to_group):
                    group_contents = future.result()
                    all_scene_contents.extend(group_contents)

        # 按 scene_num 排序确保顺序正确
        all_scene_contents.sort(key=lambda x: x[0].get("scene_num", 0))

        full_chapter_parts = []
        for bp, content in all_scene_contents:
            scene_num = bp.get('scene_num', 0)
            location = bp.get('location', '')
            full_chapter_parts.append(
                f"【场景{scene_num}：{location}】\n\n{content}\n\n※\n"
            )

        full_chapter = "\n".join(full_chapter_parts)

        # 添加章末钩子
        hook = task_card.get("chapter_hook", "")
        if hook:
            full_chapter += f"\n\n---\n*（章末钩子：{hook}）*"

        logger.info(f"Full chapter {chapter_num} generated ({len(full_chapter)} chars)")
        return full_chapter


    def polish_chapter(self, chapter_text: str, task_card: dict) -> str:
        """章节润色：统一过渡与语气。"""
        prompt = f"""请对以下章节文本进行润色，确保：
1. 场景之间过渡自然
2. 语气统一
3. 符合 style_bible.md 的要求
4. 检查是否有 OOC 或现代词汇

任务卡核心目标：{task_card.get('core_goal', '')}

## 待润色文本
{chapter_text[:8000]}"""

        system_prompt = """你是一位严谨的小说润色编辑。只输出润色后的文本，不要添加解释。"""

        try:
            polished = call_llm(
                prompt=prompt,
                system_prompt=system_prompt,
                client=self.llm,
            )
            return polished
        except Exception as e:
            logger.error(f"Polish failed: {e}")
            return chapter_text  # 润色失败则返回原文
