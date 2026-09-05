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
from novel_engine.core.quality_policy import load_quality_policy, derive_scene_targets
from novel_engine.agents.scene_schema import SceneOutput, parse_scene

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
- 严禁超龄认知（婴儿期出现“棋局/十年后”等未来知识直接判失败）

输出契约：
- 输出必须为严格 JSON（结构见用户指令中的“结构化输出契约”），scene_text 为纯叙事正文
- 严禁输出散文体或任何脚手架标记（【】/※/（）/章末钩子字样）"""

    def __init__(self, llm_client: Optional[LLMClient] = None, project_root: str | Path = None):
        self.llm = llm_client or LLMClient()
        self.root = Path(project_root or Path(__file__).parent.parent)
        self._bible_cache: dict[str, str] = {}
        # B2：最近一次成功生成的结构化场景（供管道做结构复核；mock/改写路径下为空）
        self.last_scenes: list[SceneOutput] = []
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

    def _scene_strict_models(self) -> list:
        """B2：strict 模型 = 所绑 phase 列表首位（B1 语义），其余 lenient。

        绑定 ModelRouter 时直接取其 models[0]；stub/mock 等无 models 属性时，
        回退读本工程 config 的 scenes phase 首位；最终兜底为已知首位模型名。
        """
        models = getattr(self.llm, "models", None)
        if models:
            return [models[0]]
        try:
            cfg = json.loads((self.root / "config" / "runtime_config.json").read_text(encoding="utf-8"))
            head = cfg.get("model_router", {}).get("phases", {}).get("scenes", [])
            if head:
                return [head[0]]
        except (OSError, ValueError, KeyError):
            pass
        return ["deepseek-ai/DeepSeek-V3.2"]

    def generate_scene(self, task_card: dict, scene_blueprint: dict, chapter_synopsis: str, previous_context: str = "", pacing_constraints: str = "", temperature_override: Optional[float] = None) -> SceneOutput:
        """生成单个场景（结构化契约）：模型只输出严格 JSON，经 parse_scene 解析为 SceneOutput。

        hook 为独立字段收集，永不与标记拼接进正文。strict 模型解析失败则再生一次，
        仍失败则抛错走补丁路径（绝不用正则清洗凑形）。
        """
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

        # 单一策略源：蓝图缺目标时的兜底来自 quality_policy（按本章场景数均分）
        _policy = load_quality_policy(self.root)
        _scenes = task_card.get("scene_blueprints", []) or [scene_blueprint]
        _targets = derive_scene_targets(_policy["chapter_target_chars"], len(_scenes))
        _idx = min(max(int(scene_blueprint.get("scene_num", 1) or 1) - 1, 0), len(_targets) - 1)
        _fallback_target = _targets[_idx]

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
目标字数：{scene_blueprint.get('word_count_target', _fallback_target)}字左右

## 结构化输出契约（强制）
只输出严格JSON {{"scene_id","scene_text","hook","beats"}}；scene_text 为纯叙事，禁任何【】括号指令；hook 为完整自然语句，可为空
- scene_id 取本场景 scene_num（{scene_num}）；beats 为本场景情节点字符串数组
- hook 为独立字段，不得拼入 scene_text，不得加任何括号/标记包装（如【】/（）/章末钩子字样）"""

        strict_models = self._scene_strict_models()

        def _call_once() -> SceneOutput:
            # 直调 chat_completion 以保留 ModelRouter 的 _model_used 戳（call_llm 会剥离它）
            result = self.llm.chat_completion(
                [{"role": "system", "content": self.SCENE_SYSTEM_PROMPT},
                 {"role": "user", "content": prompt}],
                temperature=temperature_override,
            )
            model_used = result.get("_model_used", "") if isinstance(result, dict) else ""
            raw = result.get("content", "") if isinstance(result, dict) else str(result)
            return parse_scene(raw or "", model_used, strict_models)

        try:
            out = _call_once()
        except ValueError:
            logger.warning(f"Scene {scene_num} structured parse failed, regenerating once (chapter {chapter_num})")
            out = _call_once()  # 仍失败则抛给补丁路径
        # B1 遗留：lenient 散文回退的 scene_id 为 0，此处赋真实场景号
        if not out.scene_id:
            out.scene_id = int(scene_blueprint.get("scene_num", 0) or 0)
        logger.info(f"Scene {scene_num} generated for chapter {chapter_num}")
        return out

    def _generate_scene_sync(self, task_card, scene_blueprint, chapter_synopsis, previous_context="", pacing_constraints="") -> SceneOutput:
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

    def _generate_group(self, task_card: dict, group: list[dict], synopsis_text: str, pacing_constraints: str = "", temperature_override: Optional[float] = None) -> list[tuple[dict, SceneOutput]]:
        """顺序生成一个场景组（组内场景共享人物，存在上下文依赖）。"""
        group_contents = []
        previous_context = ""
        for bp in group:
            content = self.generate_scene(task_card, bp, synopsis_text, previous_context, pacing_constraints, temperature_override)
            group_contents.append((bp, content))
            previous_context = "\n\n※\n\n".join(
                c.scene_text for _, c in group_contents[-3:]
            ) if len(group_contents) >= 3 else "\n\n".join(c.scene_text for _, c in group_contents)
        return group_contents

    def generate_scenes(self, task_card: dict, synopsis: dict, pacing_constraints: str = "",
                        temperature_override: Optional[float] = None) -> list[SceneOutput]:
        """
        并发生成本章全部结构化场景。
        P1 修复：场景并发（3 场景并行，~2-3min），共享 synopsis 与 beat 去重提示，无需前序上下文串行。
        返回按 scene_num 排序的 SceneOutput 列表；任一场景契约失败即抛错。
        成功后记 self.last_scenes 供管道结构复核。
        """
        chapter_num = task_card.get("chapter_num", 0)
        scenes = task_card.get("scene_blueprints", []) or task_card.get("scenes", [])
        synopsis_text = synopsis.get("synopsis", "")

        if not scenes:
            self.last_scenes = []
            return []

        # 跨章已用 beat 预取（仅一次，避免每场景重复 IO）
        try:
            from novel_engine.core.memory_manager import MemoryManager
            _mm = MemoryManager(self.root)
            _recent_beats = _mm.get_recent_beats(limit=5)
        except Exception:
            _recent_beats = []
        # 原子落盘：章节开始时清空旧 partial
        partial_path = self.root / "chapters" / "draft" / f"chapter_{chapter_num}_partial.txt"
        try:
            partial_path.parent.mkdir(parents=True, exist_ok=True)
            partial_path.write_text("", encoding="utf-8")
        except Exception:
            pass
        # 场景并发：独立场景组并行，组内无需上下文依赖（同任务卡，已通过 beat 去重）
        from concurrent.futures import ThreadPoolExecutor, as_completed
        max_workers = max(1, min(len(scenes), 4))
        # 预先计算 beat 去重提示（基于任务卡，非运行时）
        covered_beats = [f"场景{bp.get('scene_num')}({bp.get('location','')}:{bp.get('goal','')[:18]})" for bp in sorted(scenes, key=lambda x: x.get("scene_num", 0))]
        def _do_one(bp):
            beat_hint = f"\n已覆盖情节（避免重复）：{'; '.join(covered_beats)}\n" if len(covered_beats) > 1 else ""
            if _recent_beats:
                beat_hint += f"\n已用剧情节点（不可复用）：{'; '.join(_recent_beats)}\n"
            combined_pacing = (pacing_constraints or "") + beat_hint
            # 并发场景无需 previous_context（同章独立），传空避免串行依赖
            content = self.generate_scene(task_card, bp, synopsis_text, "", combined_pacing, temperature_override)
            return (bp, content)

        all_scene_contents: list[tuple[dict, SceneOutput]] = []
        with ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="scene") as ex:
            fut2bp = {ex.submit(_do_one, bp): bp for bp in scenes}
            for fut in as_completed(fut2bp):
                bp, content = fut.result()
                all_scene_contents.append((bp, content))
                # 原子落盘：每场景完成即追加（B2：仅存纯叙事 scene_text，无任何标记；线程安全：追加写）
                try:
                    with open(partial_path, "a", encoding="utf-8") as pf:
                        pf.write(f"{content.scene_text}\n\n")
                except Exception:
                    pass
        # 按 scene_num 排序确保顺序
        all_scene_contents.sort(key=lambda x: x[0].get("scene_num", 0))
        self.last_scenes = [content for _, content in all_scene_contents]
        return self.last_scenes

    def generate_full_chapter(self, task_card: dict, synopsis: dict, pacing_constraints: str = "",
                              temperature_override: Optional[float] = None) -> str:
        """
        生成完整章节正文：并发结构化场景 + 组装（仅拼 scene_text，末场景 hook 原样另起段落追加）。
        组装语义与 PipelineOrchestrator._assemble_chapter_text 一致（管道侧为权威实现，本处为兼容封装）。
        """
        chapter_num = task_card.get("chapter_num", 0)
        scenes = self.generate_scenes(task_card, synopsis, pacing_constraints, temperature_override)
        if not scenes:
            return ""
        chapter_text = "\n\n".join(s.scene_text for s in scenes)
        if scenes[-1].hook:
            chapter_text = chapter_text.rstrip() + "\n\n" + scenes[-1].hook
        logger.info(f"Full chapter {chapter_num} generated ({len(chapter_text)} chars)")
        return chapter_text


    def _polish_by_scenes(self, chapter_text: str, task_card: dict, client) -> str:
        """P0-单次全文 polish（1 次调用，300s），避免 4 次串行 7min 高耗低效。"""
        prompt = (
            "请润色并修正以下完整章节，保持人设、伏笔与节奏一致，仅返回润色后的完整正文，不要解释。\n\n"
            f"【任务卡】{task_card.get('title', '')}\n\n【正文】\n{chapter_text}"
        )
        max_tokens = min(16000, max(4096, int(len(chapter_text) / 1.5)))
        try:
            raw = client.chat_completion(
                [{"role": "user", "content": prompt}],
                temperature=0.7,
                max_tokens=max_tokens,
                timeout=300,
            )
            if isinstance(raw, dict):
                raw = raw.get("content") or raw.get("reasoning_content") or ""
            resp = raw if isinstance(raw, str) else ""
            if len(resp.strip()) >= max(200, int(len(chapter_text) * 0.5)):
                return resp.strip()
            logger.warning(f"polish degenerate len={len(resp)} vs orig {len(chapter_text)}, keep original")
        except Exception as exc:
            logger.warning(f"polish failed ({exc}), keep original")
        return chapter_text

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
        # P0-超时分级：POLISH 整章重写需 300s，Scene/评审保持 90s；整章一次 polish 改为分场景批处理以降低单次负载
        if len(chapter_text) > 4000:
            # 大章节按场景分批 polish，避免单次 7-10K 上下文 90s 误杀
            return self._polish_by_scenes(chapter_text, task_card, client)
        temps = [0.7, 0.85, 0.95]
        for attempt in range(len(temps)):
            try:
                raw = client.chat_completion(
                    [{"role": "user", "content": prompt}],
                    temperature=temps[attempt],
                    max_tokens=max_tokens,
                    timeout=300,
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
