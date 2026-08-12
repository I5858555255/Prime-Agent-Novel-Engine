"""
缩写生成 Agent + 正文生成 Agent。
阶段2：缩写生成（500字缩写 + 待提交状态变更）
阶段3：正文生成（场景级分段生成）
"""
import json
import logging
from pathlib import Path
from typing import Optional
from concurrent.futures import ThreadPoolExecutor

from llm_client import LLMClient, call_llm

logger = logging.getLogger(__name__)
def _get_root():
    """获取项目根目录。"""
    return Path(__file__).parent



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


class WriterAgent:
    """正文生成 Agent：按场景拆分生成正文。"""

    SCENE_SYSTEM_PROMPT = """你是一位专业的网络小说作家。你的任务是根据场景蓝图生成高质量的正文段落。

写作要求：
1. 第三人称有限视角（以韩玄为主）
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
- 禁止主角光环过强（每次胜利必须有代价）"""

    def __init__(self, llm_client: Optional[LLMClient] = None):
        self.llm = llm_client or LLMClient()

    def generate_scene(self, task_card: dict, scene_blueprint: dict, chapter_synopsis: str) -> str:
        """生成单个场景的正文。"""
        chapter_num = task_card.get("chapter_num", 0)
        scene_num = scene_blueprint.get("scene_num", 0)

        prompt = f"""请生成第 {chapter_num} 章第 {scene_num} 场景的正文。

## 章节缩写
{chapter_synopsis}

## 本场景蓝图
{json.dumps(scene_blueprint, ensure_ascii=False, indent=2)}

## 全章节奏参考
- 核心目标：{task_card.get('core_goal', '')}
- 情绪曲线：{json.dumps(task_card.get('emotion_curve', {}), ensure_ascii=False)}
- 章末钩子：{task_card.get('chapter_hook', '')}

## 写作指令
请严格按照 scene_blueprint 中的 goal、conflict、emotion 写作。
场景地点：{scene_blueprint.get('location', '未知')}
出场人物：{', '.join(scene_blueprint.get('characters', []))}

目标字数：{scene_blueprint.get('word_count_target', 1000)}字左右"""

        try:
            content = call_llm(
                prompt=prompt,
                system_prompt=self.SCENE_SYSTEM_PROMPT,
                client=self.llm,
            )
            logger.info(f"Scene {scene_num} generated for chapter {chapter_num}")
            return content
        except Exception as e:
            logger.error(f"Failed to generate scene {scene_num} for chapter {chapter_num}: {e}")
            raise

    def _generate_scene_sync(self, task_card, scene_blueprint, chapter_synopsis):
        """同步生成单个场景（用于线程池调用）。"""
        return self.generate_scene(task_card, scene_blueprint, chapter_synopsis)


    def generate_full_chapter(self, task_card: dict, synopsis: dict) -> str:
        """
        并行生成完整章节正文。
        Scene1-N 彼此独立，使用线程池并发调用 LLM API。
        executor.map() 按输入顺序返回结果，保持场景顺序。
        """
        chapter_num = task_card.get("chapter_num", 0)
        scenes = task_card.get("scene_blueprints", [])
        synopsis_text = synopsis.get("synopsis", "")

        # 使用线程池并发生成所有场景（LLM API 是 I/O 密集型）
        max_workers = min(len(scenes), 4)  # 最多同时 4 个场景
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            # 使用 executor.submit 显式传递参数，避免 lambda 捕获问题
            futures = [
                executor.submit(self.generate_scene, task_card, bp, synopsis_text)
                for bp in scenes
            ]
            scene_contents = [fut.result() for fut in futures]

        full_chapter_parts = []
        for i, (content, bp) in enumerate(zip(scene_contents, scenes)):
            scene_num = bp.get('scene_num', i + 1)
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
