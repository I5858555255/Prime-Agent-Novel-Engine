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

    def build_synopsis_from_task_card(self, task_card: dict) -> dict:
        """无 LLM 的兜底：从任务卡确定性构造缩写（用于合并模式下模型未输出 synopsis 时）。"""
        chapter_num = task_card.get("chapter_num", 0)
        parts = [task_card.get("core_goal", "")]
        for bp in task_card.get("scene_blueprints", []):
            goal = bp.get("goal", "")
            if goal:
                parts.append(f"场景{bp.get('scene_num', '?')}：{goal}")
        synopsis_text = "。".join(p for p in parts if p).strip()
        if synopsis_text and not synopsis_text.endswith("。"):
            synopsis_text += "。"
        return {
            "chapter_num": chapter_num,
            "synopsis": synopsis_text,
            "state_changes": task_card.get("state_changes", []) or [],
            "foreshadow_execution": task_card.get("foreshadow_execution", []) or [],
        }



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

    SCENE_SYSTEM_PROMPT = """你是一位专业的网络小说作家（凡人流写实，参考《凡人修仙传》《仙逆》笔法）。你的任务是根据场景蓝图生成高质量的正文段落。

写作要求：
1. 第三人称有限视角（以**陆烬**为主视角），视角深度随年龄动态变化（婴儿期仅感官，无推理）
2. 半文半白，通俗易懂但有古风韵味；每段最多一个比喻，比喻必须服务信息
3. 对话符合角色身份
4. 战斗描写简洁有力，重意境轻招式罗列
5. 心理描写克制内敛，通过动作和环境折射
6. 环境描写服务于情绪，不单独铺陈超过200字
7. 每场景目标3000-5000字（整个章节）
8. 遵守 scene_blueprints 中的 goal/conflict/emotion
9. 若任务卡中有 foreshadow_actions，必须在本场景中执行
10. 严禁套话堆砌（“死水石子/古井/未出鞘/达摩克利斯/如野草疯长”等出现即扣分）

禁忌：
- 禁止现代词汇、西典词汇
- 禁止OOC
- 禁止无意义水字数对话
- 禁止主角光环过强（每次胜利必须有代价）
- 严格禁止出现任何英文词汇
- 必须按照 scene_blueprints 顺序生成，不得打乱
- 必须完整呈现所有场景，不得截断
- 严格执行 foreshadow_actions 中的所有伏笔指令
- 禁止人物台词风格与设定不符
- 禁止场景内容重复
- 严禁超龄认知（婴儿期出现“棋局/十年后”等未来知识直接判失败）"""

    def __init__(self, llm_client: Optional[LLMClient] = None, project_root: str | Path = None):
        self.llm = llm_client or LLMClient()
        self.root = Path(project_root or Path(__file__).parent.parent)
        self._bible_cache: dict[str, str] = {}
        self._load_bible_cache()

    def _load_bible_cache(self):
        for key, rel in {
            "world": "bible/world_bible.md",
            "character": "bible/character_bible.md",
            "style": "bible/style_bible.md",
        }.items():
            p = self.root / rel
            try:
                self._bible_cache[key] = p.read_text(encoding="utf-8") if p.exists() else ""
            except OSError:
                self._bible_cache[key] = ""

    def _bible_snippet(self, max_chars: int = 1200) -> str:
        world = (self._bible_cache.get("world", "") or "")[:600]
        char = (self._bible_cache.get("character", "") or "")[:600]
        parts = []
        if world.strip():
            parts.append(f"【世界观】{world.strip()}")
        if char.strip():
            parts.append(f"【人物卡】{char.strip()}")
        text = "\n\n".join(parts)
        return text[:max_chars]

    def generate_scene(self, task_card: dict, scene_blueprint: dict, chapter_synopsis: str, previous_context: str = "", pacing_constraints: str = "", temperature_override: Optional[float] = None) -> str:
        """生成单个场景的正文。"""
        chapter_num = task_card.get("chapter_num", 0)
        scene_num = scene_blueprint.get("scene_num", 0)

        context_section = ""
        if previous_context:
            context_section = f"\n\n## 前序场景摘要\n{previous_context}"

        pacing_block = f"\n## 节奏硬性约束\n{pacing_constraints}\n" if pacing_constraints else ""

        bible_block = self._bible_snippet()
        bible_section = f"\n\n## 人物/世界观显式设定（逐章注入，防 OOC/漂移）\n{bible_block}\n" if bible_block else ""
        # P1-C3 视角与时间线绑定：婴儿期禁用成人独白
        perspective_block = ""
        if chapter_num <= 5:
            perspective_block = "\n\n## 视角与时间线锚点\n- 当前时间：第 {} 章（主角为新生儿/婴儿期，年龄≈0岁）\n- 严禁任何成人式全知内心独白、未来知识（“棋局”“十年后”等）与超龄推理；仅保留感官、本能与外部观察\n- 内心独白强度：0（无）\n".format(chapter_num)
        elif chapter_num <= 20:
            perspective_block = f"\n\n## 视角与时间线锚点\n- 当前时间：第 {chapter_num} 章（幼年期）\n- 心理描写需符合年龄，避免超龄谋略独白\n"
        else:
            perspective_block = f"\n\n## 视角与时间线锚点\n- 当前时间：第 {chapter_num} 章\n- 按当前年龄与状态描写心理，禁止时间线穿帮\n"

        prompt = f"""请生成第 {chapter_num} 章第 {scene_num} 场景的正文。

## 章节缩写
{chapter_synopsis}
{context_section}
{bible_section}{perspective_block}
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
        P1-C1 修复：改为顺序执行并向前透传前序摘要，避免并行零上下文导致的重复叙事。
        """
        chapter_num = task_card.get("chapter_num", 0)
        scenes = task_card.get("scene_blueprints", []) or task_card.get("scenes", [])
        synopsis_text = synopsis.get("synopsis", "")

        if not scenes:
            return ""

        # 顺序生成：每场景携带前序场景摘要与基调，避免重复 beats
        # P0 自愈：每场景完成即原子落盘到 draft/partial，供中断后恢复
        partial_path = self.root / "chapters" / "draft" / f"chapter_{chapter_num}_partial.txt"
        try:
            partial_path.parent.mkdir(parents=True, exist_ok=True)
            # 章节开始时清空旧 partial（若为续跑则保留已有）
            if not partial_path.exists() or partial_path.stat().st_size == 0:
                partial_path.write_text("", encoding="utf-8")
        except Exception:
            pass
        all_scene_contents: list[tuple[dict, str]] = []
        previous_context = ""
        covered_beats: list[str] = []
        for bp in sorted(scenes, key=lambda x: x.get("scene_num", 0)):
            beat_hint = ""
            if covered_beats:
                beat_hint = f"\n已覆盖情节（避免重复）：{'; '.join(covered_beats[-5:])}\n"
            combined_pacing = (pacing_constraints or "") + beat_hint
            content = self.generate_scene(task_card, bp, synopsis_text, previous_context, combined_pacing, temperature_override)
            all_scene_contents.append((bp, content))
            # 原子落盘：每场景完成即追加
            try:
                with open(partial_path, "a", encoding="utf-8") as pf:
                    pf.write(f"【场景{bp.get('scene_num')}：{bp.get('location','')}】\n\n{content}\n\n※\n")
            except Exception:
                pass
            # 更新前序摘要（取前 300 字 + 场景目标，避免无限膨胀）
            snippet = content[:300].replace("\n", " ")
            covered_beats.append(f"场景{bp.get('scene_num')}({bp.get('location','')}:{bp.get('goal','')[:20]})")
            # 透传前序摘要：最多保留最近 2 场景的 600 字摘要
            previous_context = "\n\n".join(c for _, c in all_scene_contents[-2:])
            if len(previous_context) > 800:
                previous_context = previous_context[-800:]

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


    def polish_chapter(self, chapter_text: str, task_card: dict, llm_client=None) -> str:
        """章节润色：统一过渡与语气。

        校验润色结果长度：过短（退化/空输出，如 5 字符）时提高温度重试；
        全部失败后回退到原始正文，避免生成残缺章节。
        """
        client = llm_client or self.llm
        # 估算输出 token：中文约 1.5 字符/token，留少量余量避免截断，也避免过大导致超时
        max_tokens = min(16000, max(4096, int(len(chapter_text) / 1.5)))
        prompt = (
            "请润色并修正以下完整章节，保持人设、伏笔与节奏一致，仅返回润色后的完整正文，不要解释。\n\n"
            f"【任务卡】{task_card.get('title', '')}\n\n【正文】\n{chapter_text}"
        )
        min_ok = max(200, int(len(chapter_text) * 0.5))
        temps = [0.7, 0.85, 0.95]
        for attempt in range(len(temps)):
            try:
                # P0-API: POLISH 快速失败，超时 90s，避免 5min 空转；2 次断连即切 fallback 由 ModelRouter 负责
                raw = client.chat_completion(
                    [{"role": "user", "content": prompt}],
                    temperature=temps[attempt],
                    max_tokens=max_tokens,
                    timeout=90,
                )
            except Exception as exc:
                # 超时/错误重试无意义，直接回退原始正文，避免长时挂起
                logger.warning(f"polish_chapter call failed ({exc}); falling back to original text")
                return chapter_text
            # ModelRouter/LLMClient 返回 dict（含 content 字段）；统一提取为字符串
            if isinstance(raw, dict):
                raw = raw.get("content") or raw.get("reasoning_content") or ""
            resp = raw if isinstance(raw, str) else ""
            if len(resp.strip()) >= min_ok:
                return resp.strip()
            logger.warning(
                f"polish_chapter attempt {attempt + 1} returned degenerate output "
                f"(len={len(resp)}), retrying"
            )
        # 所有重试均失败：回退到未润色原始正文，保证章节完整不残缺
        logger.warning("polish_chapter: all attempts degenerate, falling back to original text")
        return chapter_text
