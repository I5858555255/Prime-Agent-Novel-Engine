# -*- coding: utf-8 -*-
"""CC round-9 Q1：婴儿篇“越界发挥 / 设定泄漏 / 时间锚越界”确定性门（零 LLM）。

真机证据：flash 会在任务卡外自行新增“迷雾守护者”对话、提前泄漏后期修炼体系设定
（仙门/魂魄印记/跨界），并把时间从“子时至丑时末”越界写到“天亮/黎明”。这些是评审
plot/pacing/hook 的主要扣分项。本门在 assembly 后、reviewer 前纯规则检测，命中场景由
orchestrator 做一次 E 定点重生，重生后仍命中则判 scope_block 质量重规划。

按 CC round-9 裁决：
- 词表按篇章分文件 config/leak_terms/*.json（婴儿篇禁修炼体系，后期卷可放开）。
- hard_block 只放极窄、低歧义复合词，命中即阻断；soft_warn 是通用词（修炼/境界…），
  单独出现只记录不阻断。
- 命中词前后 negation_window 字内出现否定/虚拟/传闻标记（不是/并非/如果/据说…）→
  降级为软预警（“这不是修炼”是在排除设定，不是泄漏）。
- 命中位置落在 idiom_whitelist 俗语（魂飞魄散…）内时放过。
- 任务卡 forbidden_checks 里明确列出的短词条目并入硬杀（长句不自动切词，避免误杀）。
- 时间锚越界：本章被限定在“当夜数时辰”时，非引号叙事出现天亮/黎明意象才判；
  引号对话、以及“等天亮再说”这类将来时不判。
命名实体“卡内/bible都没有”的纯规则 NER 误报率高，本轮不做，仍交 reviewer。
"""
from __future__ import annotations

import json
from pathlib import Path

_CFG_CACHE: list[dict] | None = None


def reset_config_cache() -> None:
    global _CFG_CACHE
    _CFG_CACHE = None


def load_arc_configs(root) -> list[dict]:
    """加载 config/leak_terms/*.json 全部篇章配置（带缓存）。"""
    global _CFG_CACHE
    if _CFG_CACHE is not None:
        return _CFG_CACHE
    cfgs: list[dict] = []
    d = Path(root) / "config" / "leak_terms"
    if d.is_dir():
        for p in sorted(d.glob("*.json")):
            try:
                obj = json.loads(p.read_text(encoding="utf-8"))
                if isinstance(obj, dict):
                    cfgs.append(obj)
            except Exception:
                continue
    _CFG_CACHE = cfgs
    return cfgs


def _active_cfg(cfgs: list[dict], chapter_num: int) -> dict | None:
    ch = int(chapter_num or 0)
    for c in cfgs:
        rng = c.get("chapters")
        if isinstance(rng, list) and len(rng) == 2:
            try:
                if int(rng[0]) <= ch <= int(rng[1]):
                    return c
            except (TypeError, ValueError):
                continue
    return None


def _sentences(text: str) -> list[str]:
    out, buf = [], []
    for ch in text or "":
        buf.append(ch)
        if ch in "。！？\n":
            s = "".join(buf).strip()
            if s:
                out.append(s)
            buf = []
    if "".join(buf).strip():
        out.append("".join(buf).strip())
    return out


def _term_in_whitelist(term: str, term_idx: int, sentence: str, whitelist: list[str]) -> bool:
    """命中点是否落在某条俗语白名单内部。"""
    for idiom in whitelist:
        if term in idiom:  # 白名单短语包含该词（如 魂魄∈魂飞魄散?否；魂∈吓掉魂）
            start = sentence.find(idiom)
            while start >= 0:
                if start <= term_idx < start + len(idiom):
                    return True
                start = sentence.find(idiom, start + 1)
    return False


def _has_negation_near(term_idx: int, term_len: int, sentence: str,
                       markers: list[str], window: int) -> bool:
    lo = max(0, term_idx - window)
    hi = min(len(sentence), term_idx + term_len + window)
    seg = sentence[lo:hi]
    return any(m in seg for m in markers)


def _inside_quotes(idx: int, sentence: str) -> bool:
    if sentence.rfind("“", 0, idx) > sentence.rfind("”", 0, idx):
        return True
    if sentence.rfind("「", 0, idx) > sentence.rfind("」", 0, idx):
        return True
    return False


# CC round-21：子串误伤防护——"空气感"等普通构词不命中修炼词"气感"
# "气感"前一字为"空"（形成"空气感"）时视为普通构词子串，放过；
# 其他情况（"有气感"、"体内气感"、"气感涌动"）均视为修炼词 → 命中。
_AIR_FALSE_POSITIVE_PRECH = "空"


def _is_air_sensibility_substring(term_idx: int, sentence: str) -> bool:
    """检测 term 命中是否为普通构词子串（如"空气感"含"气感"），而非修炼体感。"""
    if term_idx <= 0:
        return False  # 句首命中，正常视为修炼词
    return sentence[term_idx - 1] == _AIR_FALSE_POSITIVE_PRECH



def _anchor_text(timeline_anchor) -> str:
    if isinstance(timeline_anchor, dict):
        parts = []
        for key in ("chapter_start_marker", "max_time_progression"):
            v = timeline_anchor.get(key)
            if isinstance(v, str):
                parts.append(v)
        return "；".join(parts)
    return str(timeline_anchor or "")


def _is_night_bounded(anchor_text: str, cfg: dict) -> bool:
    if not anchor_text:
        return False
    for allow in ("次日", "第二日", "第二天", "翌日", "天亮后", "黎明后", "数日内", "数日", "当日"):
        if allow in anchor_text:
            return False
    return any(m in anchor_text for m in cfg.get("night_anchor_markers", []))


# ── D1：吐纳条件豁免（ch6 夜间，陈老根独自，陆烬旁观窥见）─────────────────────
# CC round-21：豁免从"仅吐纳"扩为"吐纳/调息同义动作"共用同一套条件。
_TUNA_EXEMPT_TERMS = frozenset({"吐纳", "调息"})
_TUNA_EXEMPT_CHAPTERS = {6}
# 仅当这些动词与 陆烬/婴儿/孩子 构成近窗共现时才算传授违规
_TUNA_PROHIBITED_COMBINATIONS = frozenset({
    "教", "让", "传", "叫", "令",  # 明确传授动词（给/帮 需看受事）
})
# 陆烬侧婴儿施为信号：主语=陆烬/婴儿/孩子/娃/他(指婴儿) + 模仿动词
_TUNA_BABY_AGENT_MARKERS = frozenset({
    "陆烬", "婴儿", "孩子", "娃", "襁褓", "小孩", "小儿",
})
# "自己"/"我"在陈老根主语上下文中是反身代词，不是模仿动词
_TUNA_MIMIC_VERBS = frozenset({
    "学", "跟着", "跟随", "模仿", "陪", "陪练", "也", "试着", "学着", "依样",
})
# 陈老根主语候选（用于跨句代词回溯）
_TUNA_PROTAGONIST = "陈老根"
_TUNA_PRONOUN_ALIASES = frozenset({"他", "其", "老人", "老者"})
# 陈老根自指/第一人称标记（内心独白 POV）
_TUNA_REFLEXIVE_MARKERS = frozenset({"自己", "我"})
# 回想/回溯标记（陈老根独坐回想昨夜）
_TUNA_RECOLLECTION_MARKERS = frozenset({"想起", "回想", "回想起来", "记得", "回忆", "浮现"})
# 旁观者合法标记
_TUNA_OBSERVER_MARKERS = frozenset({"偷看", "窥见", "窥", "望着", "看着", "悄悄睁眼", "不敢出声"})
# 与婴儿受事近窗共现才算传授（给/帮 单独不算）
_TUNA_CHILD_BENEFICIARY = frozenset({"陆烬", "婴儿", "孩子", "娃", "小孩", "小儿"})
# 教授短语：给+婴儿+讲/授/教/带
_TUNA_TEACH_PHRASES = frozenset({
    "给陆烬", "给婴儿", "给孩子", "给娃",
    "帮陆烬", "帮婴儿", "帮孩子", "帮娃",
    "叫陆烬", "叫婴儿", "叫孩子", "叫娃",
    "让陆烬", "让婴儿", "让孩子", "让娃",
})


# ── P6-1：传授违规检测（模块级，供独立扫描调用）────────────────────────────
_TEACH_VERBS = frozenset({
    "传授", "传法", "传功", "传给", "传了", "传下", "传与",
    "授予", "讲授", "讲解", "教授", "授业", "授徒",
    "教给", "教导", "教会",
})
_CULTIVATION_OBJECTS = frozenset({
    "吐纳", "呼吸", "法门", "口诀", "功法", "法诀", "调息", "行气",
})
_EXPLICIT_RECIPIENT = frozenset({"传给", "教给", "授徒"})
_FALSE_TRANSMIT = frozenset({"传来", "传说", "传递", "祖传", "外传"})


def _has_teach_violation(s: str) -> bool:
    """句子是否包含传授违规（传授语义词+修炼宾语近窗，排除传来/祖传误伤）。

    CC round-21：反诘/犹豫语境（"权衡是否传授""岂能传授""如何理解气感""谈何容易"等）
    降为非违规（soft）；真正实施的传授（传呼吸法给陆烬、教陆烬吐纳）仍 hard。
    CC round-21 GapB：既成传授短语（传给/教给/授徒、传…给、教…给）优先级最高，
    命中即 hard，不受犹豫/反问语境影响；仅在无既成传授短语时疑问犹豫才软降级。
    """
    # ── 第一优先：既成传授事实（不论犹豫/反问语境）───────────────────────────
    # 明确带受事的复合传授词 → hard
    for rv in _EXPLICIT_RECIPIENT:
        if rv not in s:
            continue
        rv_idx = s.find(rv)
        ctx = s[max(0, rv_idx - 8):rv_idx + 20]
        if any(co in ctx for co in _CULTIVATION_OBJECTS):
            return True
    # 跨字模式：传...给 / 教...给（如"传呼吸之法给陆烬"）
    if "传" in s and "给" in s:
        c_idx = s.find("传")
        g_idx = s.find("给")
        if g_idx > c_idx:
            span = s[c_idx:g_idx + 20]
            if any(co in span for co in _CULTIVATION_OBJECTS):
                return True
    if "教" in s and "给" in s:
        j_idx = s.find("教")
        g_idx = s.find("给")
        if g_idx > j_idx:
            span = s[j_idx:g_idx + 20]
            if any(co in span for co in _CULTIVATION_OBJECTS):
                return True
    # ── 第二优先：反诘/犹豫·未然语境降为非违规（仅当无既成传授事实时生效）──────
    _reversed_context_markers = {"如何", "怎会", "岂能", "怎", "难道", "岂不是"}
    _hesitant_markers = {"权衡", "犹豫", "暂不", "尚未", "没敢", "不敢", "怕是", "或许",
                         "该不该", "要不要", "还是", "也许", "恐怕", "谈何容易", "未必", "会不会",
                         "怎会", "岂能", "难道不", "莫非"}
    is_question = any(mk in s for mk in _reversed_context_markers)
    is_hesitant = any(mk in s for mk in _hesitant_markers)
    is_question_end = s.endswith("？") and ("传授" in s or "教" in s or "传" in s)
    if (is_question or is_hesitant or is_question_end) and ("传授" in s or "教" in s or "传" in s):
        return False  # 反诘/犹豫 → soft，非硬违规
    # ── 第三：其他传授语义词 + 修炼宾语近窗 → hard ───────────────────────────
    for tv in _TEACH_VERBS:
        if tv not in s:
            continue
        tv_idx = s.find(tv)
        ctx = s[max(0, tv_idx - 6):tv_idx + 18]
        if any(co in ctx for co in _CULTIVATION_OBJECTS):
            return True
    # 裸"教"+修炼宾语近窗 → hard
    if "教" in s:
        for proxy in {"教导", "教给", "教会"}:
            if proxy in s:
                p_idx = s.find(proxy)
                ctx = s[max(0, p_idx - 6):p_idx + 18]
                if any(co in ctx for co in _CULTIVATION_OBJECTS):
                    return True
                break
        jiao_idx = s.find("教")
        if jiao_idx >= 0:
            ctx = s[max(0, jiao_idx - 6):jiao_idx + 18]
            nearby = s[max(0, jiao_idx - 3):jiao_idx + 3]
            if nearby not in {"会了", "学", "请", "问"} and any(co in ctx for co in _CULTIVATION_OBJECTS):
                return True
    return False


def _tuna_exempt_sentence(sent: str, ch_num: int, cfg: dict | None,
                          prev_sents: list[str] | None = None,
                          night_bounded: bool = False) -> bool:
    """吐纳/调息句是否满足条件豁免（仅 ch6 夜间、陈老根为施为主体、无传授语义）。

    CC round-21 扩展：
    - 豁免术语从"吐纳"扩为{吐纳, 调息}（共用同一套条件）。
    - 主体识别：增列"自己"/"我"反身标记；跨句回溯窗口从 1 句扩到 3 句。
    - 支持 chapter-level night_bounded（来自 timeline_anchor）作为夜锚兜底，
      避免 scene 内未显式出现"当晚/深夜"但实际处于当夜的漏放过。
    - "自己"/"我" 与 陈老根 同现于 scene 上下文中时视为合法自指。
    """
    # 豁免术语集（吐纳/调息）——任一命中即进入豁免检查
    if not any(t in sent for t in _TUNA_EXEMPT_TERMS):
        return False
    if ch_num not in _TUNA_EXEMPT_CHAPTERS:
        return False
    night_anchors = (cfg or {}).get("night_anchor_markers", [])
    # 夜锚：句内或上下文最近 3 句内出现夜间标记；或 chapter-level night_bounded
    context_text = sent
    if prev_sents:
        context_text = " ".join(prev_sents[-3:]) + " " + sent
    has_night = any(a in context_text for a in night_anchors) or night_bounded
    if not has_night:
        return False

    # CC round-21：婴儿施为检测（统一处理，含 GapA 修复）
    baby_agent = any(m in sent for m in _TUNA_BABY_AGENT_MARKERS)
    # 提前计算 has_reflexive，避免 walrus 运算符在条件不成立时不赋值导致 NameError
    has_reflexive = any(m in sent for m in _TUNA_REFLEXIVE_MARKERS)
    # GapA：婴儿主体词（陆烬/婴儿/孩子/娃/襁褓等）与 吐纳/调息 共现时，
    # 除非是"婴儿旁观陈老根施为"的合法形态（含旁观标记 + 陈老根主语），
    # 否则一律 hard——自己/我 优先绑定婴儿，不得走自指或描述性豁免。
    if baby_agent and any(t in sent for t in _TUNA_EXEMPT_TERMS):
        is_observer_pattern = any(m in sent for m in _TUNA_OBSERVER_MARKERS)
        # 合法旁观：婴儿是旁观者，吐纳/调息的施为者是陈老根（明示 or 反身标记）
        is_baby_observer_legal = (
            is_observer_pattern
            and (_TUNA_PROTAGONIST in sent or has_reflexive)
        )
        if not is_baby_observer_legal:
            return False  # 婴儿主语+吐纳/调息 → hard

    # ── 主体解析：确认是陈老根本人施为 ──
    # 规则 A：句中明示陈老根作主语（"陈老根吐纳"/"陈老根调息"）
    has_chen_lao_explicit = _TUNA_PROTAGONIST in sent
    # 规则 B：句中"自己"/"我"作为反身自指（陈老根内心独白 POV）
    has_reflexive = any(m in sent for m in _TUNA_REFLEXIVE_MARKERS)
    # 规则 C：句首代词（他/其/老人/老者）+ 跨句回溯最近 3 句有陈老根
    pronoun_subject = False
    for pron in _TUNA_PRONOUN_ALIASES:
        if sent.startswith(pron):
            pronoun_subject = True
            break
        # "他吐纳" / "他调息" / "其吐纳" 等模式
        for et in _TUNA_EXEMPT_TERMS:
            if pron + et in sent:
                pronoun_subject = True
                break
        if pronoun_subject:
            break
    if pronoun_subject and prev_sents:
        recent_context = " ".join(prev_sents[-3:])
        if _TUNA_PROTAGONIST not in recent_context:
            return False  # 代词无法回溯到陈老根
    # 规则 D："自己"/"我" 前 3 句中有陈老根 → 视为合法自指
    # CC round-21：若句中同时含"自己/我"+ 吐纳/调息，视为陈老根自指（内心独白），
    # 无需 prev_sents 回溯确认（场景内主语已明示）
    if has_reflexive and any(t in sent for t in _TUNA_EXEMPT_TERMS):
        pass  # 句中反身标记+吐纳/调息 → 视为陈老根自指，豁免
    elif has_reflexive and prev_sents:
        recent_context = " ".join(prev_sents[-3:])
        if _TUNA_PROTAGONIST not in recent_context:
            return False  # 反身标记无法回溯到陈老根
    # 规则 E：句中无陈老根明示、无反身标记、无有效代词回溯 → 非陈老根施为
    # CC round-21：但若含描述性标记（"那"/"刚才"/"此前"/"绵长规律"等），视为旁观/描述性引用，豁免
    _descriptive_markers = {"那", "刚才", "此前", "先前", "之前", "往日", "昔日", "规律", "绵长"}
    has_descriptive_context = any(m in sent for m in _descriptive_markers)
    if not has_chen_lao_explicit and not has_reflexive and not pronoun_subject:
        if has_descriptive_context:
            pass  # 描述性引用，豁免
        else:
            return False  # 非陈老根施为 → hard

    # P4-2/P5-2/P6-1：教授形态判定
    if _has_teach_violation(sent):
        return False  # 传授违规 → hard

    return True


def _is_tuna_hard_violation(term: str, sent: str, ch_num: int, cfg: dict | None,
                             prev_sents: list[str] | None = None,
                             night_bounded: bool = False) -> bool:
    """吐纳/调息词命中是否为真正硬违规（豁免外均 hard）。"""
    if term not in _TUNA_EXEMPT_TERMS:
        return True
    return not _tuna_exempt_sentence(sent, ch_num, cfg, prev_sents, night_bounded)


def _extract_card_hard_terms(task_card: dict) -> list[str]:
    """forbidden_checks 中明确列出的短词条目（≤6字）作为硬杀；长句不切词。"""
    terms: list[str] = []
    for item in (task_card or {}).get("forbidden_checks", []) or []:
        s = str(item or "").strip()
        if 2 <= len(s) <= 6 and not any(ch in s for ch in "，。；、？！：“”\"'"):
            terms.append(s)
    return terms


def detect_scope_violations(scene_text: str, chapter_num: int, timeline_anchor, root,
                            extra_hard_terms: list[str] | None = None) -> dict:
    """返回 {"hard": [ {kind,term,sentence} ], "soft": [ ... ]}。

    hard=必须定点重生的硬伤；soft=只记录供观察/统计的软预警。
    """
    cfgs = load_arc_configs(root)
    cfg = _active_cfg(cfgs, chapter_num)
    hard: list[dict] = []
    soft: list[dict] = []
    text = scene_text or ""
    if not text.strip():
        return {"hard": hard, "soft": soft}
    sents = _sentences(text)

    hard_terms: list[str] = []
    soft_terms: list[str] = []
    whitelist: list[str] = []
    markers: list[str] = []
    window = 20
    night_bounded = False
    if cfg:
        hard_terms = [t for t in cfg.get("hard_block", []) if t]
        soft_terms = [t for t in cfg.get("soft_warn", []) if t]
        whitelist = cfg.get("idiom_whitelist", [])
        markers = cfg.get("negation_markers", [])
        window = int(cfg.get("negation_window", 20) or 20)
        night_bounded = _is_night_bounded(_anchor_text(timeline_anchor), cfg)
    # 任务卡明确禁写的短词：最高优先级并入硬杀
    for t in (extra_hard_terms or []):
        if t and t not in hard_terms:
            hard_terms.append(t)

    def _scan_terms(terms, kind):
        for term in terms:
            # CC round-21：每个禁词独立维护前 3 句上下文，互不污染
            prev_sents: list[str] = []
            for sent in sents:
                idx = sent.find(term)
                if idx < 0:
                    prev_sents.append(sent)
                    prev_sents = prev_sents[-3:]
                    continue
                # CC round-21：子串误伤防护——"空气感"等普通构词不命中"气感"
                if kind == "hard" and term == "气感":
                    from novel_engine.quality import scope_gate as _sg_mod
                    if hasattr(_sg_mod, '_is_air_sensibility_substring') and _sg_mod._is_air_sensibility_substring(idx, sent):
                        prev_sents.append(sent)
                        prev_sents = prev_sents[-3:]
                        continue
                if _term_in_whitelist(term, idx, sent, whitelist):
                    prev_sents.append(sent)
                    prev_sents = prev_sents[-3:]
                    continue
                if _has_negation_near(idx, len(term), sent, markers, window):
                    soft.append({"kind": "negated_" + kind, "term": term,
                                 "sentence": sent[:120]})
                    prev_sents.append(sent)
                    prev_sents = prev_sents[-3:]
                    break
                # CC round-21：反诘/疑问语境（如何/怎会/岂能）也降级为 soft
                _rhetorical_markers = {"如何", "怎会", "岂能", "怎", "难道", "岂不是", "谈何容易"}
                if any(mk in sent for mk in _rhetorical_markers):
                    soft.append({"kind": "negated_" + kind, "term": term,
                                 "sentence": sent[:120]})
                    prev_sents.append(sent)
                    prev_sents = prev_sents[-3:]
                    break
                # D1/P4-1/P4-2：吐纳/调息 ch6 夜间陈老根独自豁免（含跨句代词回溯）
                if kind == "hard" and term in _TUNA_EXEMPT_TERMS:
                    if not _is_tuna_hard_violation(term, sent, chapter_num, cfg, prev_sents,
                                                  night_bounded=night_bounded):
                        soft.append({"kind": "tuna_exempt", "term": term,
                                     "sentence": sent[:120]})
                    else:
                        hard.append({"kind": "hard_leak", "term": term,
                                     "sentence": sent[:120]})
                    prev_sents.append(sent)
                    prev_sents = prev_sents[-3:]
                    break
                if kind == "hard":
                    hard.append({"kind": "hard_leak", "term": term,
                                 "sentence": sent[:120]})
                else:
                    soft.append({"kind": "soft_term", "term": term,
                                 "sentence": sent[:120]})
                prev_sents.append(sent)
                prev_sents = prev_sents[-3:]
                break

    _scan_terms(hard_terms, "hard")
    _scan_terms(soft_terms, "soft")

    # P6-1：传授违规独立检测（不依赖 吐纳/调息 是否命中）
    # 避免"传呼吸之法给陆烬"等不含 吐纳 但含传授+修炼宾语的漏放
    try:
        from novel_engine.quality.scope_gate import _has_teach_violation as _htv
        for sent in sents:
            if _htv(sent):
                hard.append({"kind": "hard_leak", "term": "吐纳",
                             "sentence": sent[:120]})
                break
    except Exception:
        pass

    # 时间锚越界：仅当夜锚下、非引号叙事、非将来时
    if cfg and night_bounded:
        future = cfg.get("future_markers", [])
        for marker in cfg.get("dawn_markers", []):
            for sent in sents:
                idx = sent.find(marker)
                if idx < 0:
                    continue
                if _inside_quotes(idx, sent):
                    continue
                if any(fm in sent for fm in future):
                    continue
                hard.append({"kind": "dawn_overrun", "term": marker,
                             "sentence": sent[:120]})
                break

    # 去重（同类同词）
    def _dedup(items):
        seen, uniq = set(), []
        for v in items:
            k = (v["kind"], v["term"])
            if k not in seen:
                seen.add(k)
                uniq.append(v)
        return uniq

    return {"hard": _dedup(hard), "soft": _dedup(soft)}


def _split_sentences_keep(text: str) -> list[str]:
    """按句末标点切分并保留结束符（换行作为段落分隔，不附加到句子上）。"""
    parts: list[str] = []
    buf: list[str] = []
    for ch in text or "":
        if ch == "\n":
            if "".join(buf).strip():
                parts.append("".join(buf).strip())
            buf = []
            parts.append("\n")
            continue
        buf.append(ch)
        if ch in "。！？":
            parts.append("".join(buf).strip())
            buf = []
    if "".join(buf).strip():
        parts.append("".join(buf).strip())
    return [x for x in parts if x != ""]


def excise_dawn_overrun(scene_text: str, chapter_num: int, root, timeline_anchor=None) -> tuple[str, list[str]]:
    """CC round-12 A：确定性整句切除时间锚越界（不调用 LLM）。

    仅在当夜锚下生效；复用与 detect_scope_violations 完全一致的分句 / 引号豁免 /
    将来时豁免判定。命中 dawn_markers 的非引号、非将来时整句直接删除（保留段落
    换行分隔），其余原句不动。返回 (新文本, 被删原句列表)；非当夜锚或无配置时原样返回。
    """
    cfgs = load_arc_configs(root)
    cfg = _active_cfg(cfgs, chapter_num)
    if not cfg or not _is_night_bounded(_anchor_text(timeline_anchor), cfg):
        return scene_text, []
    dawn_markers = cfg.get("dawn_markers", []) or []
    future = cfg.get("future_markers", []) or []
    if not dawn_markers:
        return scene_text, []

    kept: list[str] = []
    removed: list[str] = []
    for token in _split_sentences_keep(scene_text or ""):
        if token == "\n":
            kept.append("\n")
            continue
        hit = False
        for marker in dawn_markers:
            idx = token.find(marker)
            if idx < 0:
                continue
            if _inside_quotes(idx, token):
                continue
            if any(fm in token for fm in future):
                continue
            hit = True
            break
        if hit:
            removed.append(token)
        else:
            kept.append(token)

    if not removed:
        return scene_text, []
    # 按换行分回段落；段落内句子直接相连（句末标点已保留），段落间空行重拼。
    paras = [[]]
    for token in kept:
        if token == "\n":
            paras.append([])
        else:
            paras[-1].append(token)
    out = "\n\n".join("".join(pg) for pg in paras if "".join(pg).strip())
    return out.strip(), removed


def scope_fix_directive(hard: list[dict]) -> str:
    leaks = sorted({v["term"] for v in hard if v["kind"] in ("hard_leak", "negated_hard")})
    dawns = sorted({v["term"] for v in hard if v["kind"] == "dawn_overrun"})
    lines = ["本场景违反了任务卡的范围/时间硬约束，必须按以下要求重写（保留本场景原有 beats 与篇幅，只做删除/收束，不改变已发生事件与人物）："]
    if leaks:
        lines.append(
            "删除一切提前泄漏后期设定、或任务卡未规划的超自然内容，正文严禁出现以下词或同义概念："
            + "、".join(leaks) + "。不得新增守护者/神秘声音对话、修炼体系、门派仙门、"
            "魂魄印记/跨界等任何体系化解释；悬念只能用环境与意象隐晦呈现，不做直白说明。")
    if dawns:
        lines.append(
            "本章时间严格限定在当夜时间锚之内，叙事本身严禁写到天明。删除包含“"
            + "、".join(dawns) + "”等天亮/黎明意象的叙述句，结尾停在时间锚允许的最晚时点；"
            "角色可以说‘等天亮再说’之类的话，但叙述不得真的演到天亮。")
    lines.append("正文写足场景目标字数，交付纯叙事成稿，不要解释你的修改。")
    return "\n".join(lines)
