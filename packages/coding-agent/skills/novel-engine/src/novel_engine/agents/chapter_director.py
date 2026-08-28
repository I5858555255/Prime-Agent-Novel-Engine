"""
章节导演 Agent：生成任务卡 JSON。
职责：
1. 读取 bible + plot_graph + constraints + author_intent
2. 确定本章在 DAG 中的节点
3. 生成任务卡（目标、冲突、情绪曲线、场景蓝图、伏笔动作）
4. 输出结构化 JSON 供缩写生成环节使用
"""
import json
import logging
import re
from pathlib import Path
from typing import Optional

from novel_engine.core.llm_client import LLMClient, call_llm
from novel_engine.agents.world_simulator import WorldSimulator
from novel_engine.core.memory_manager import MemoryManager
from novel_engine.engine.db import StateDB

logger = logging.getLogger(__name__)


class ChapterDirector:
    """章节导演：将剧情规划转化为可执行的任务卡。"""

    SYSTEM_PROMPT = """你是一位经验丰富的网络小说章节导演。你的任务是根据剧情大纲、世界观设定和人物状态，为每一章生成详细的任务卡。

任务卡必须包含：
1. 本章核心目标（必须完成）
2. 主要冲突（至少一个内部冲突、一个外部冲突）
3. 情绪曲线（起承转合）
4. 场景蓝图（3-5个场景，每个场景有 goal/conflict/emotion）
5. 伏笔动作（若有 clue_plan 需要在本章执行）
6. 人物出场与状态变化提示
7. 章末钩子

约束：
- 严格遵守 author_intent.md 中对应章节区间的 forbidden 列表
- 遵守 simulation/constraints.json 中的 realm_lock / plot_lock
- 场景顺序必须与 scene_blueprints 一致
- 每个场景的 goal 必须在缩写/正文中体现
- 文风参考 style_bible.md
"""

    def __init__(self, project_root: str | Path = None, llm_client: Optional[LLMClient] = None):
        self.root = Path(project_root or Path(__file__).parent.parent)
        self.llm = llm_client or LLMClient.from_config(self.root / "config" / "runtime_config.json")
        self.simulator = WorldSimulator(self.root)
        self.memory = MemoryManager(self.root)

        # Instantiate StateDB
        db_dir = self.root / "runtime"
        db_dir.mkdir(parents=True, exist_ok=True)
        self.db = StateDB(db_path=str(db_dir / "state.db"), project_root=self.root)

        # Parse outlines and author intents by volume
        self._outline_sections = self._parse_outline()
        self._intent_sections = self._parse_author_intent()

        # Bible cache: loaded once at init, reused for all chapters
        self._bible_cache = {}
        self._load_bible_cache()

    def _parse_outline(self) -> dict:
        """解析完整大纲，按卷拆分。"""
        outline_path = self.root / "planning" / "吸氧证道_V2_1_完整大纲.md"
        if not outline_path.exists():
            return {}

        content = outline_path.read_text(encoding="utf-8")

        volume_markers = [
            ("V01", "## 四、第一卷《昆仑遗子》"),
            ("V02", "## 五、第二卷《大乾人间》"),
            ("V03", "## 六、第三卷《仙门初渡》"),
            ("V04", "## 七、第四卷《万山寻仙》"),
            ("V05", "## 八、第五卷《人间藏仙》"),
            ("V06", "## 九、第六卷《阴阳双界》"),
            ("V07", "## 十、第七卷《天门之后》"),
            ("V08", "## 十一、第八卷《仙庭旧墟》"),
            ("V09", "## 十二、第九卷《伐天人皇》"),
            ("V10", "## 十三、第十卷《人道定仙天》"),
            ("END", "## 十四、修炼境界与道具对照表")
        ]

        sections = {}
        for i in range(len(volume_markers) - 1):
            vid, marker = volume_markers[i]

            start_idx = content.find(marker)
            if start_idx == -1:
                continue

            # Find next marker that exists
            next_marker = ""
            for j in range(i + 1, len(volume_markers)):
                m_next = volume_markers[j][1]
                if content.find(m_next) != -1:
                    next_marker = m_next
                    break

            if not next_marker:
                sections[vid] = content[start_idx:]
            else:
                end_idx = content.find(next_marker, start_idx)
                sections[vid] = content[start_idx:end_idx]

        return sections

    def _parse_author_intent(self) -> dict:
        """解析作者意图，按卷/阶段拆分。"""
        intent_path = self.root / "bible" / "author_intent.md"
        if not intent_path.exists():
            return {}

        content = intent_path.read_text(encoding="utf-8")

        markers = [
            ("V01", "## 第一阶段：昆仑遗子"),
            ("V02", "## 第二阶段：大乾人间"),
            ("V03", "## 第三阶段：仙门初渡"),
            ("V04", "## 第四阶段：万山寻仙"),
            ("V05", "## 第五阶段：人间藏仙"),
            ("V06", "## 第六阶段：阴阳双界"),
            ("V07", "## 第七阶段：天门之后"),
            ("V08", "## 第八阶段：仙庭旧墟"),
            ("V09", "## 第九阶段：伐天人皇"),
            ("V10", "## 第十阶段：人道定仙天"),
            ("END", "------")
        ]

        sections = {}
        for i in range(len(markers) - 1):
            vid, marker = markers[i]
            start_idx = content.find(marker)
            if start_idx == -1:
                continue

            # Find next marker that exists
            next_marker = ""
            for j in range(i + 1, len(markers)):
                m_next = markers[j][1]
                if content.find(m_next) != -1:
                    next_marker = m_next
                    break

            if not next_marker:
                sections[vid] = content[start_idx:]
            else:
                end_idx = content.find(next_marker, start_idx)
                sections[vid] = content[start_idx:end_idx]

        return sections

    def _get_volume_id(self, chapter_num: int, volumes: dict) -> str:
        """根据章节号获取卷 ID。"""
        for vol in volumes.get("volumes", []):
            range_start, range_end = vol.get("chapter_range", [0, 0])
            if range_start <= chapter_num <= range_end:
                return vol.get("id", "V01")
        return "V01"

    def _load_bible_cache(self):
        """一次性加载 bible 文件并缓存（永不改变）。"""
        bible_files = {
            'world': 'bible/world_bible.md',
            'character': 'bible/character_bible.md',
            'style': 'bible/style_bible.md',
            'author_intent': 'bible/author_intent.md',
        }
        for key, rel_path in bible_files.items():
            full_path = self.root / rel_path
            if full_path.exists():
                self._bible_cache[key] = full_path.read_text(encoding="utf-8")
            else:
                self._bible_cache[key] = ""

    def _load_json(self, path: Path) -> dict:
        if path.exists():
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        return {}

    def _load_text(self, path: Path) -> str:
        if path.exists():
            return path.read_text(encoding="utf-8")
        return ""

    def get_context_for_chapter(self, chapter_num: int) -> dict:
        """构建本章生成所需的完整上下文。"""
        # 使用缓存的 bible 文件（避免重复 I/O）
        bible_files = {
            "world": self._bible_cache.get("world", ""),
            "character": self._bible_cache.get("character", ""),
            "style": self._bible_cache.get("style", ""),
            "author_intent": self._bible_cache.get("author_intent", ""),
        }

        # 加载规划数据
        volumes = self._load_json(self.root / "config" / "planning" / "volumes.json")
        plot_graph = self._load_json(self.root / "config" / "planning" / "plot_graph.json")

        vid = self._get_volume_id(chapter_num, volumes)
        volume_outline = self._outline_sections.get(vid, "")
        author_intent = self._intent_sections.get(vid, "")
        if not author_intent:
            author_intent = bible_files.get("author_intent", "")[:2000]

        # 查找本章对应的 plot 节点
        relevant_nodes = []
        for node in plot_graph.get("nodes", []):
            target = node.get("chapter_target", 0)
            if abs(target - chapter_num) <= 20:  # 前后20章内的相关节点
                relevant_nodes.append(node)

        # 加载约束
        constraints_summary = self.simulator.get_constraints_summary(chapter_num)

        # 加载伏笔
        foreshadow_registry = self._load_json(self.root / "config" / "foreshadow" / "registry.json")
        relevant_foreshadows = []
        for fs in foreshadow_registry.get("foreshadows", []):
            plant_ch = fs.get("plant_chapter", 0)
            resolve_ch = fs.get("resolve_chapter", 0)
            if plant_ch <= chapter_num <= resolve_ch:
                relevant_foreshadows.append(fs)
        # 世界状态
        world_state = self.simulator.build_world_state_for_chapter(chapter_num)

        # RAG 历史检索：基于当前剧情关键词从短期记忆检索相关章节
        recent_summaries = self.memory.get_recent_summaries(chapter_num, count=5)
        keyword_history = self.memory.retrieve_by_keywords(
            [f"chapter_{chapter_num}"], limit=5,
        )

        # 质量记忆
        quality_memory = self._load_json(self.root / "memory" / "quality_memory.json")

        # Query active foreshadows from StateDB
        active_foreshadows = self.db.query_active_foreshadows(chapter_num)

        return {
            "chapter_num": chapter_num,
            "bible": bible_files,
            "volumes": volumes,
            "relevant_plot_nodes": relevant_nodes,
            "constraints": constraints_summary,
            "foreshadows": relevant_foreshadows,
            "active_foreshadows": active_foreshadows,
            "world_state": world_state,
            "quality_memory": quality_memory,
            "recent_summaries": recent_summaries,
            "keyword_history": keyword_history,
            "volume_outline": volume_outline,
            "author_intent": author_intent,
        }

    def _try_template_task_card(self, chapter_num: int, dynamic_context: dict) -> dict | None:
        """
        尝试使用模板任务卡：当 plot_graph 中存在精确匹配的节点时，
        直接返回结构化任务卡，跳过 LLM 调用以节省成本。
        返回 None 表示需要走 LLM 路径。
        """
        plot_graph = dynamic_context.get("plot_graph", {})
        foreshadow_registry = dynamic_context.get("foreshadow_registry", {})

        matching_nodes = [
            n for n in plot_graph.get("nodes", [])
            if n.get("chapter_target") == chapter_num
        ]
        if not matching_nodes:
            return None

        node = matching_nodes[0]
        node_type = node.get("type", "main_plot")
        if node_type not in ("main_plot", "character_development"):
            return None

        import os
        template_cache_dir = self.root / "cache" / "task_cards"
        template_cache_dir.mkdir(parents=True, exist_ok=True)
        template_file = template_cache_dir / f"chapter_{chapter_num}.json"

        if template_file.exists():
            try:
                cached = json.loads(template_file.read_text(encoding="utf-8"))
                if cached.get("_template") and cached.get("chapter_num") == chapter_num:
                    logger.info(f"Using cached template task card for chapter {chapter_num}")
                    cached["_from_template"] = True
                    return cached
            except (json.JSONDecodeError, OSError):
                pass

        foreshadow_ids = node.get("foreshadow_links", [])
        relevant_foreshadows = [
            fs for fs in foreshadow_registry.get("foreshadows", [])
            if fs.get("id") in foreshadow_ids
        ]

        task_card = {
            "chapter_num": chapter_num,
            "core_goal": node.get("description", ""),
            "conflicts": {
                "internal": node.get("emotional_tone", ""),
                "external": node.get("description", ""),
            },
            "emotion_curve": {
                "start": node.get("emotional_tone", "neutral"),
                "middle": "developing",
                "climax": "peak",
                "end": "hook",
            },
            "scene_blueprints": [{
                "scene_num": 1,
                "location": "unknown",
                "characters": node.get("required_characters", []),
                "goal": node.get("description", ""),
                "conflict": node.get("description", ""),
                "emotion": node.get("emotional_tone", ""),
                "word_count_target": 3000,
            }],
            "foreshadow_actions": [
                {
                    "foreshadow_id": fs.get("id", ""),
                    "action": fs.get("clue_plan", [""])[0] if fs.get("clue_plan") else "",
                    "intensity": "隐晦提示",
                }
                for fs in relevant_foreshadows
            ],
            "chapter_hook": node.get("description", "") + "...",
            "forbidden_checks": [
                "禁止出现英文词汇",
                "禁止OOC",
                "禁止场景顺序与任务卡不符",
            ],
            "_template": True,
            "_from_template": True,
        }

        try:
            template_file.write_text(
                json.dumps(task_card, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except OSError:
            pass

        logger.info(f"Generated template task card for chapter {chapter_num}")
        return task_card

    def generate_task_card_cached(self, chapter_num: int, dynamic_context: dict) -> dict:
        """
        生成任务卡（使用预计算的固定上下文）。
        dynamic_context 包含 volumes, plot_graph, foreshadow_registry 等不变数据。
        """
        # 尝试模板快捷路径
        template_card = self._try_template_task_card(chapter_num, dynamic_context)
        if template_card is not None:
            # 模板卡可能只有1个场景（如 validate_task_card 要求最少2个），
            # 校验失败时回退到 LLM 生成。
            template_errors = self.validate_task_card(template_card, chapter_num)
            if not template_errors:
                return template_card
            logger.info(f"Template task card invalid ({template_errors[0]}), falling back to LLM")

        volumes = dynamic_context.get('volumes', {})
        plot_graph = dynamic_context.get('plot_graph', {})
        foreshadow_registry = dynamic_context.get('foreshadow_registry', {})

        # 查找本章对应的 plot 节点
        relevant_nodes = []
        for node in plot_graph.get("nodes", []):
            target = node.get("chapter_target", 0)
            if abs(target - chapter_num) <= 20:
                relevant_nodes.append(node)

        vid = self._get_volume_id(chapter_num, volumes)
        volume_outline = self._outline_sections.get(vid, "")
        author_intent = self._intent_sections.get(vid, "")
        if not author_intent:
            author_intent = self._bible_cache.get("author_intent", "")[:2000]

        # 加载约束（动态）
        constraints_summary = self.simulator.get_constraints_summary(chapter_num)

        # 相关伏笔（动态）
        relevant_foreshadows = []
        for fs in foreshadow_registry.get("foreshadows", []):
            plant_ch = fs.get("plant_chapter", 0)
            resolve_ch = fs.get("resolve_chapter", 0)
            if plant_ch <= chapter_num <= resolve_ch:
                relevant_foreshadows.append(fs)

        # 世界状态（动态）
        world_state = self.simulator.build_world_state_for_chapter(chapter_num)

        # RAG 历史检索（动态）
        recent_summaries = self.memory.get_recent_summaries(chapter_num, count=20)
        keyword_history = self.memory.retrieve_by_keywords(
            [f"chapter_{chapter_num}"], limit=5,
        )

        # 质量记忆 — 从质量记忆中提取高优先级问题，生成硬约束
        quality_memory = self._load_json(self.root / "memory" / "quality_memory.json")
        hard_constraints = []
        for issue in quality_memory.get("overused_elements", []):
            if issue.get("severity") == "high":
                hard_constraints.append(f"- 禁止出现{issue.get('type', '重复元素')}类问题：{issue.get('description', '')}")
        dynamic_constraints = "\n".join(hard_constraints) if hard_constraints else "无新增动态约束"

        # Query active foreshadows from StateDB
        active_foreshadows = self.db.query_active_foreshadows(chapter_num)

        context = {
            "chapter_num": chapter_num,
            "bible": {
                "world": self._bible_cache.get("world", ""),
                "character": self._bible_cache.get("character", ""),
                "style": self._bible_cache.get("style", ""),
                "author_intent": self._bible_cache.get("author_intent", ""),
            },
            "volumes": volumes,
            "relevant_plot_nodes": relevant_nodes,
            "constraints": constraints_summary,
            "foreshadows": relevant_foreshadows,
            "active_foreshadows": active_foreshadows,
            "world_state": world_state,
            "quality_memory": quality_memory,
            "dynamic_constraints": dynamic_constraints,
            "recent_summaries": recent_summaries,
            "keyword_history": keyword_history,
            "volume_outline": volume_outline,
            "author_intent": author_intent,
        }

        prompt = f"""请为第 {chapter_num} 章生成任务卡。

## 当前上下文
- 章节号：{chapter_num}
- 相关剧情节点：{json.dumps(context['relevant_plot_nodes'], ensure_ascii=False, indent=2)}
- 活跃约束：
{context['constraints']}
- 相关伏笔：
{json.dumps([{'id': fs['id'], 'clue_plan': fs.get('clue_plan', [])} for fs in context['foreshadows']], ensure_ascii=False, indent=2)}
- 活跃伏笔线索计划 (来自 StateDB 精确时序过滤)：
{json.dumps(context['active_foreshadows'], ensure_ascii=False, indent=2)}

## 世界观摘要
{context['bible']['world'][:2000]}

## 人物设定摘要
{context['bible']['character'][:1500]}

## 文风要求
{context['bible']['style'][:1000]}

## 本卷作者意图与规划
{context.get('author_intent', '')}

## 本卷大纲规划
{context.get('volume_outline', '')[:6000]}

## 质量记忆（避免过度使用，延续成功元素）
{json.dumps(context['quality_memory'], ensure_ascii=False, indent=2)}

## 动态硬约束（来自质量记忆闭环）
{context.get('dynamic_constraints', '无')}

## 输出格式
请严格输出以下 JSON 结构：
{{
  "chapter_num": {chapter_num},
  "core_goal": "本章必须完成的核心目标",
  "conflicts": {{
    "internal": "主角内心冲突",
    "external": "外部冲突"
  }},
  "emotion_curve": {{
    "start": "起始情绪",
    "middle": "中间情绪",
    "climax": "高潮情绪",
    "end": "结尾情绪（留钩子）"
  }},
  "scene_blueprints": [
    {{
      "scene_num": 1,
      "location": "场景地点",
      "characters": ["出场人物ID"],
      "goal": "本场景目标",
      "conflict": "本场景冲突",
      "emotion": "本场景情绪",
      "word_count_target": 1000
    }}
  ],
  "foreshadow_actions": [
    {{
      "foreshadow_id": "F001",
      "action": "具体写作指令",
      "intensity": "隐晦提示/明显异样/接近揭露前兆"
    }}
  ],
  "chapter_hook": "章末钩子描述",
  "forbidden_checks": [
    "确认未违反 author_intent 中的 forbidden 项",
    "严格遵守 forbidden_checks 中的所有禁令（违反将导致章节被拒绝）",
    "确保所有 foreshadow_actions 都被执行",
    "确保场景顺序与任务卡完全一致",
    "禁止出现英文词汇"
  ]
}}"""

        try:
            task_card = call_llm(
                prompt=prompt,
                system_prompt=self.SYSTEM_PROMPT,
                client=self.llm,
                output_json=True,
            )
            logger.info(f"Task card generated for chapter {chapter_num}")
            return task_card
        except Exception as e:
            logger.error(f"Failed to generate task card for chapter {chapter_num}: {e}")
            raise

    def generate_task_card(self, chapter_num: int) -> dict:
        """
        生成章节任务卡。
        返回结构化 JSON。
        """
        context = self.get_context_for_chapter(chapter_num)

        prompt = f"""请为第 {chapter_num} 章生成任务卡。

## 当前上下文
- 章节号：{chapter_num}
- 相关剧情节点：{json.dumps(context['relevant_plot_nodes'], ensure_ascii=False, indent=2)}
- 活跃约束：
{context['constraints']}
- 相关伏笔：
{json.dumps([{'id': fs['id'], 'clue_plan': fs.get('clue_plan', [])} for fs in context['foreshadows']], ensure_ascii=False, indent=2)}
- 活跃伏笔线索计划 (来自 StateDB 精确时序过滤)：
{json.dumps(context['active_foreshadows'], ensure_ascii=False, indent=2)}

## 世界观摘要
{context['bible']['world'][:2000]}

## 人物设定摘要
{context['bible']['character'][:1500]}

## 文风要求
{context['bible']['style'][:1000]}

## 本卷作者意图与规划
{context.get('author_intent', '')}

## 本卷大纲规划
{context.get('volume_outline', '')[:6000]}

## 质量记忆（避免过度使用，延续成功元素）
{json.dumps(context['quality_memory'], ensure_ascii=False, indent=2)}

## 输出格式
请严格输出以下 JSON 结构：
{{
  "chapter_num": {chapter_num},
  "core_goal": "本章必须完成的核心目标",
  "conflicts": {{
    "internal": "主角内心冲突",
    "external": "外部冲突"
  }},
  "emotion_curve": {{
    "start": "起始情绪",
    "middle": "中间情绪",
    "climax": "高潮情绪",
    "end": "结尾情绪（留钩子）"
  }},
  "scene_blueprints": [
    {{
      "scene_num": 1,
      "location": "场景地点",
      "characters": ["出场人物ID"],
      "goal": "本场景目标",
      "conflict": "本场景冲突",
      "emotion": "本场景情绪",
      "word_count_target": 1000
    }}
  ],
  "foreshadow_actions": [
    {{
      "foreshadow_id": "F001",
      "action": "具体写作指令",
      "intensity": "隐晦提示/明显异样/接近揭露前兆"
    }}
  ],
  "chapter_hook": "章末钩子描述",
  "forbidden_checks": [
    "确认未违反 author_intent 中的 forbidden 项",
    "严格遵守 forbidden_checks 中的所有禁令（违反将导致章节被拒绝）",
    "确保所有 foreshadow_actions 都被执行",
    "确保场景顺序与任务卡完全一致",
    "禁止出现英文词汇"
  ]
}}"""

        try:
            task_card = call_llm(
                prompt=prompt,
                system_prompt=self.SYSTEM_PROMPT,
                client=self.llm,
                output_json=True,
            )
            logger.info(f"Task card generated for chapter {chapter_num}")
            return task_card
        except Exception as e:
            logger.error(f"Failed to generate task card for chapter {chapter_num}: {e}")
            raise

    def validate_task_card(self, task_card: dict, chapter_num: int) -> list[str]:
        """验证任务卡的完整性。"""
        errors = []

        required_fields = ["core_goal", "conflicts", "emotion_curve", "scene_blueprints", "chapter_hook"]
        for field in required_fields:
            if field not in task_card:
                errors.append(f"缺少必填字段: {field}")

        scenes = task_card.get("scene_blueprints", [])
        if len(scenes) < 2:
            errors.append(f"场景数量不足（最少2个），当前 {len(scenes)} 个")
        elif len(scenes) > 6:
            errors.append(f"场景数量过多（最多6个），当前 {len(scenes)} 个")

        # 检查场景编号是否连续
        scene_nums = [s.get("scene_num") for s in scenes]
        expected_nums = list(range(1, len(scenes) + 1))
        if scene_nums != expected_nums:
            errors.append(f"场景编号不连续: {scene_nums}，期望 {expected_nums}")

        # 检查 forbidden 项
        author_intent = self._bible_cache.get("author_intent", "")
        current_intent_section = ""
        for section in author_intent.split("## "):
            if f"第{chapter_num}章" in section or (
                "chapter_range" in section and
                any(str(chapter_num) in line for line in section.split("\n")[:5])
            ):
                current_intent_section = section
                break
        
        forbidden_items = re.findall(r"- \"([^\"]+)\"", current_intent_section)
        core_goal = task_card.get("core_goal", "")
        for item in forbidden_items:
            if item in core_goal:
                errors.append(f"core_goal 包含 forbidden 项: {item}")

        # 检查场景字段完整性
        for i, scene in enumerate(scenes):
            scene_required = ["scene_num", "location", "characters", "goal", "conflict", "emotion"]
            for field in scene_required:
                if field not in scene:
                    errors.append(f"场景 {i+1} 缺少字段: {field}")

        # 检查伏笔动作的章节范围
        foreshadow_actions = task_card.get("foreshadow_actions", [])
        for fa in foreshadow_actions:
            fs_id = fa.get("foreshadow_id", "")
            if not fs_id:
                errors.append("伏笔动作缺少 foreshadow_id")

        return errors
