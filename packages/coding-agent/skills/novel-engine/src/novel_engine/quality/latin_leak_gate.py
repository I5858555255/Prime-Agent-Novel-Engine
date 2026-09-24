# -*- coding: utf-8 -*-
"""CC round-18 P0-1：非中文字符（拉丁字母）泄漏检测（零 LLM）。

Agnes flash 偶发在中文正文里吐出英文残片（真机 ch2 scene4 “he decision 不对外透露”）。
本项目为纯中文古风，对拉丁单词零白名单；阿拉伯数字放行，单个拉丁字母不判（避免误伤
孤立排版残留）。对话内不豁免——古风人物说英文本身即错误。
"""
from __future__ import annotations

import re

# 连续 ≥2 个拉丁字母才算英文单词残片（单字母不判）
_LATIN_RUN_RE = re.compile(r"[A-Za-z]{2,}")


def detect_latin_leak(text: str) -> dict:
    runs = _LATIN_RUN_RE.findall(text or "")
    return {"has_leak": bool(runs), "leaked_tokens": runs}


def latin_leaks_by_scene(scenes: list) -> list[dict]:
    """对 [{scene_id, scene_text}] 顺序检测，返回每个命中场景的明细。"""
    out = []
    for sc in scenes or []:
        sid = sc.get("scene_id") if isinstance(sc, dict) else getattr(sc, "scene_id", None)
        txt = sc.get("scene_text", "") if isinstance(sc, dict) else getattr(sc, "scene_text", "") or ""
        r = detect_latin_leak(txt)
        if r["has_leak"]:
            out.append({"scene_id": sid, **r})
    return out
