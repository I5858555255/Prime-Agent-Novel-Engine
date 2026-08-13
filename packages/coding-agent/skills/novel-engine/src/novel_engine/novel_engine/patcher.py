"""
IncrementalPatcher: 实现增量式高阶自修复与自改进。
不再简单全量重写，而是定位特定“病灶”段落，执行精确热插拔拼接（Hot-Swap Patching）。
"""
import re
import logging
from typing import Optional

logger = logging.getLogger(__name__)


class IncrementalPatcher:
    """增量修复器：根据 Reviewer 提供的局部修复病灶（fix_scope）和修改后内容，进行高精度合并。"""

    @staticmethod
    def extract_scene(full_text: str, scene_num: int) -> Optional[str]:
        """从章节文本中精准抠出特定场景的文本（利用场景标记 【场景N：...】）。"""
        pattern = r"(【场景" + str(scene_num) + r"：[^】]*】.*?)(?=【场景" + str(scene_num + 1) + r"：|---|\Z)"
        match = re.search(pattern, full_text, re.DOTALL)
        if match:
            return match.group(1).strip()
        return None

    @staticmethod
    def apply_scene_patch(full_text: str, scene_num: int, patched_scene_content: str) -> str:
        """
        对特定场景执行增量热插拔：将修改后的场景文本精准缝合回原有大章节中，
        避免 LLM 在全量生成中误删、吃字、或产生格式遗失，大幅提升千万字流水线下的事实一致性。
        """
        # 如果 patch 文本没有前缀场景名，可以自动加上，或者使用更灵活的替换
        header_pattern = r"【场景" + str(scene_num) + r"：[^】]*】"
        header_match = re.search(header_pattern, full_text)

        # 提取目标场景头部，保持原场景标记不变
        header_text = header_match.group() if header_match else f"【场景{scene_num}】"
        if not patched_scene_content.startswith("【场景"):
            patched_scene_content = f"{header_text}\n\n{patched_scene_content.strip()}"

        pattern = r"(【场景" + str(scene_num) + r"：[^】]*】.*?)(?=【场景" + str(scene_num + 1) + r"：|---|\Z)"

        # 执行精准的正则缝合
        new_text, count = re.subn(pattern, patched_scene_content, full_text, flags=re.DOTALL)
        if count > 0:
            logger.info(f"Successfully hot-swapped Scene {scene_num} patch in chapter text.")
            return new_text

        logger.warning(f"Scene {scene_num} marker not found. Appending patch as fallback.")
        return full_text + f"\n\n※\n\n{patched_scene_content}"

    @staticmethod
    def apply_regex_patch(full_text: str, target_keyword: str, patched_text: str) -> str:
        """根据关键字范围（如角色名、特定武功）进行近距离语义缝合。"""
        lines = full_text.splitlines()
        for idx, line in enumerate(lines):
            if target_keyword in line:
                # 局部替换第 idx 行为新生成的 patched_text
                lines[idx] = patched_text
                logger.info(f"Applied semantic keyword patch on line {idx + 1}")
                return "\n".join(lines)
        return full_text
