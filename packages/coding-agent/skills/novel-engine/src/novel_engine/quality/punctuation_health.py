# -*- coding: utf-8 -*-
"""CC round-16 P0-1：标点/断句健康门（零 LLM 纯规则）。

Agnes flash 在扩写/polish 快速补字时偶发输出"整段只有段尾一个句号、中间零逗号"的流水句。
初稿的句末校验只看最后一个字符，抓不到这类段落；本模块在扩写/polish/最终组装三处复用。
对话/引语内容豁免（语言节奏可不同）；命中后走"仅加标点"的定点 LLM 修复，并用
去标点逐字比对校验模型没有越界改写。

CC round-12 R2：新增句末口径长句检测（。！？之间，逗号不算句末）与零字改写安全断句，
阈值 48 中文字。修复在成稿组装后、评审前静态作用；残留只记软 issue 不重生。
"""
from __future__ import annotations

import re

# 句读标点（逗号也算，流水句主要缺的就是句内停顿）
_PAUSE_CHARS = "。！？!?...，,；;：:、"
# 成对引号（中英文）
Q_L, Q_R = "“", "”"
SQ_L, SQ_R = "‘", "’"
# CC round-12 R2：中文角括号也作引号处理，确保旁白/对话正确切分
CB_L, CB_R = "「", "」"
_QUOTE_PAIRS = [(Q_L, Q_R), (SQ_L, SQ_R), (CB_L, CB_R), (chr(34), chr(34))]

# 默认阈值（CC round-16，中文网文宽松下限）
MAX_UNPUNCTUATED_RUN = 60
MIN_DENSITY_PER_100 = 3.0

# CC round-12 R2：句末口径长句阈值（中文字数，含标点计字符数）
LONG_SENTENCE_HARD = 48

# CC round-12 R2：句末标点正则（。！？…）
_SENTENCE_END_PAT = re.compile(r"[。！？…]")
# CC round-12 R2：中文字符正则
_CN_RE = re.compile(r"[一-鿿]")


def remove_quoted_content(text: str) -> str:
    """剥离成对引号内的对话/引语（含引号本身），只留旁白叙事文本。

    无法成对的孤立引号按普通字符保留（不强行吞掉后续正文）。
    """
    s = text or ""
    for op, cl in _QUOTE_PAIRS:
        while True:
            i = s.find(op)
            if i == -1:
                break
            j = s.find(cl, i + len(op))
            if j == -1:
                break
            s = s[:i] + s[j + len(cl):]
    return s


def _longest_run(text: str) -> int:
    longest = cur = 0
    for ch in text:
        if ch in _PAUSE_CHARS or ch.isspace():
            cur = 0
        else:
            cur += 1
            if cur > longest:
                longest = cur
    return longest


def check_paragraph_punctuation(text: str, max_run: int = MAX_UNPUNCTUATED_RUN,
                                min_density: float = MIN_DENSITY_PER_100) -> dict:
    """单段标点健康度。返回 longest run / 每百字句读数 / 是否不健康（引号内豁免）。"""
    body = remove_quoted_content(text or "")
    n = len(body.strip())
    longest = _longest_run(body)
    punct = sum(1 for ch in body if ch in _PAUSE_CHARS)
    density = (punct / n * 100.0) if n else 0.0
    unhealthy = (longest > max_run) or (density < min_density and n >= max_run)
    return {
        "chars": n,
        "max_unpunctuated_run": longest,
        "punct_density_per_100": round(density, 2),
        "is_unhealthy": bool(unhealthy),
    }


def check_text_punctuation(text: str, max_run: int = MAX_UNPUNCTUATED_RUN,
                           min_density: float = MIN_DENSITY_PER_100) -> list[dict]:
    """对整章按自然段检查，返回所有不健康段落（含段索引与原文），供定点修复。"""
    bad = []
    for idx, para in enumerate((text or "").split(chr(10))):
        p = para.strip()
        if not p:
            continue
        r = check_paragraph_punctuation(p, max_run=max_run, min_density=min_density)
        if r["is_unhealthy"]:
            bad.append({"para_index": idx, "text": p, **r})
    return bad


_ALL_PUNCT_RE = re.compile(r"[\s，。！？!?…、；：：\"''''（）()《》〈〉,.‿~·:;、]")


def strip_all_punctuation(text: str) -> str:
    return _ALL_PUNCT_RE.sub("", text or "")


def is_punctuation_only_fix(original: str, fixed: str) -> bool:
    """校验"仅加标点"修复是否合规：去掉全部标点和空白后必须逐字相同。

    模型若顺带增删/替换/改写了任何文字，即判不合规（应改走整段重生）。
    """
    return strip_all_punctuation(original) == strip_all_punctuation(fixed)


# ============================================================================
# CC round-12 R2：句末口径长句检测 + 零字改写安全断句
# ============================================================================

_LONG_SENT_STRONG_BOUNDARY = (
    "于是", "然后", "接着", "随后", "最后", "终于", "直到", "这时", "那一刻",
    "此刻", "此时", "突然", "忽然", "霎时", "刹那", "很快", "不久", "因此",
    "所以", "但是", "可是", "然而", "不过", "紧接着", "这时候",
)
_LONG_SENT_WEAK_BOUNDARY = (
    "因为", "由于", "如果", "假如", "虽然", "尽管", "一边", "一面", "随即",
    "渐渐", "逐渐", "慢慢", "缓缓", "隐约", "似乎", "仿佛", "好像", "就在",
    "同时", "而且", "并且", "不禁", "只得", "只好", "下意识", "本能地",
)
_LONG_SENT_PRON_BOUNDARY = ("他", "她", "它", "那", "这")


def detect_long_sentences(text: str, hard: int = LONG_SENTENCE_HARD) -> list[dict]:
    """按句末口径（。！？之间）检测旁白超长句（中文字数>=hard）。引号内对话豁免。"""
    body = remove_quoted_content(text or "")
    splits = list(_SENTENCE_END_PAT.finditer(body))
    sentences: list[tuple[int, str]] = []
    last_end = 0
    for m in splits:
        sent = body[last_end:m.end()]
        if sent.strip():
            sentences.append((len(sentences), sent))
        last_end = m.end()
    tail = body[last_end:]
    if tail.strip():
        sentences.append((len(sentences), tail))
    result: list[dict] = []
    for idx, sent in sentences:
        cn_chars = len(_CN_RE.findall(sent))
        if cn_chars >= hard:
            result.append({"sentence_index": idx, "cn_chars": cn_chars, "text": sent.strip()})
    return result


# Strong-only boundaries: only these can split a long sentence (they yield independent clauses).
_LONG_SENT_BOUNDARIES_FOR_SPLIT = _LONG_SENT_STRONG_BOUNDARY


def _split_para_on_strong_boundaries(para: str, max_splits: int = 2) -> tuple[str, int]:
    """对单段做零字改写安全断句：只在强边界前插'。\\n'，引号内完全跳过。

    单趟扫描维护引号态并建立 body_offset→para_offset 映射；对每个超长句，
    在旁白区找第一个强边界，在其前方插入"。\\n"。找不到强边界则只计数不拆。
    返回 (修复后文本, 插入数)。最多 max_splits 处拆分。
    """
    if not para:
        return para, 0
    # 单趟建立 body_offset -> para_offset 映射（追踪引号态）
    body_to_para: list[int] = []
    inside = False
    body_off = 0
    for i, ch in enumerate(para):
        if ch in _QUOTE_FLIP:
            inside = not inside
            continue
        if not inside:
            body_to_para.append(i)
        body_off += 1

    body = remove_quoted_content(para)
    splits = list(_SENTENCE_END_PAT.finditer(body))
    sentences: list[tuple[int, int]] = []
    last_end = 0
    for m in splits:
        sentences.append((last_end, m.end()))
        last_end = m.end()
    tail = body[last_end:]
    if tail.strip():
        sentences.append((last_end, len(body)))

    insert_points: list[int] = []
    for sent_start, sent_end in sentences:
        cn_chars = len(_CN_RE.findall(body[sent_start:sent_end]))
        if cn_chars < LONG_SENTENCE_HARD:
            continue
        # 在旁白区找第一个强边界（严格在句子内部）
        inserted_shift = 0
        found = False
        for pos in range(sent_start + 1, sent_end):
            seg = body[pos:]
            for bound_w in _LONG_SENT_BOUNDARIES_FOR_SPLIT:
                if seg.startswith(bound_w):
                    para_pos = body_to_para[pos] + inserted_shift
                    insert_points.append(para_pos)
                    inserted_shift += 2  # "。" + "\n"
                    found = True
                    break
            if found:
                break
        if len(insert_points) >= max_splits:
            break

    if not insert_points:
        return para, 0

    out = para
    for pos in reversed(insert_points):
        out = out[:pos] + "。\n" + out[pos:]
    return out, len(insert_points)


def split_long_sentences(text: str, hard: int = LONG_SENTENCE_HARD) -> tuple[str, dict]:
    """对超长旁白句做零字改写安全断句。引号内豁免，找不到强边界只计数不拆。"""
    if not text:
        return text, {"long_sentences_detected": 0, "split_count": 0}
    paras = text.split("\n")
    total_detected = 0
    total_split = 0
    out_paras: list[str] = []
    for para in paras:
        body = remove_quoted_content(para)
        long_sents = detect_long_sentences(body, hard=hard)
        if not long_sents:
            out_paras.append(para)
            continue
        total_detected += len(long_sents)
        fixed_para, n_split = _split_para_on_strong_boundaries(para, max_splits=2)
        total_split += n_split
        out_paras.append(fixed_para)
    return "\n".join(out_paras), {
        "long_sentences_detected": total_detected,
        "split_count": total_split,
    }


def _fix_para_long_sentences(para: str, body: str,
                              long_sents: list[dict],
                              hard: int) -> str:
    """兼容旧接口：委托给 _split_para_on_strong_boundaries。"""
    fixed, _ = _split_para_on_strong_boundaries(para, max_splits=2)
    return fixed


# ============================================================================
# CC28 3a：零 LLM 确定性断句修复（PunctuationSplitRepair）
# ============================================================================

REPAIR_SOFT_RUN = 36
REPAIR_HARD_RUN = 45
REPAIR_SEG_HARD = 55
REPAIR_MIN_GAP = 20
REPAIR_MAX_INSERTS_PER_PARA = 5

_STRONG_BOUNDARY = (
    "于是", "然后", "接着", "随后", "最后", "终于", "直到", "这时", "那一刻",
    "此刻", "此时", "突然", "忽然", "霎时", "刹那", "很快", "不久", "因此",
    "所以", "但是", "可是", "然而", "不过", "紧接着", "这时候",
)
_WEAK_BOUNDARY = (
    "因为", "由于", "如果", "假如", "虽然", "尽管", "一边", "一面", "随即",
    "渐渐", "逐渐", "慢慢", "缓缓", "隐约", "似乎", "仿佛", "好像", "就在",
    "同时", "而且", "并且", "不禁", "只得", "只好", "下意识", "本能地",
)
_PRON_BOUNDARY = ("他", "她", "它", "那", "这")
_QUOTE_FLIP = set(Q_L + Q_R + SQ_L + SQ_R + chr(34) + chr(39) + chr(96))


def _match_boundary(s: str, i: int):
    """返回位置 i 处命中的边界 (length, is_strong)；无命中返回 None。"""
    for w in _STRONG_BOUNDARY:
        if s.startswith(w, i):
            return len(w), True
    for w in _WEAK_BOUNDARY:
        if s.startswith(w, i):
            return len(w), False
    for w in _PRON_BOUNDARY:
        if s.startswith(w, i):
            return len(w), False
    return None


def repair_paragraph_long_runs(paragraph: str,
                               soft_run: int = REPAIR_SOFT_RUN,
                               hard_run: int = REPAIR_HARD_RUN,
                               seg_hard: int = REPAIR_SEG_HARD,
                               min_gap: int = REPAIR_MIN_GAP,
                               max_inserts: int = REPAIR_MAX_INSERTS_PER_PARA) -> tuple[str, int]:
    """对一个自然段做零 LLM 断句。返回 (修复后文本, 插入停点数)。

    只在旁白区（成对引号之外）的安全边界插入；强边界插"。\n"，弱边界插"，"。
    绝不删除/替换任何原字符；无超长 run 时原样返回。
    """
    p = paragraph or ""
    body = remove_quoted_content(p)
    if _longest_run(body) <= hard_run:
        return p, 0
    n = len(p)
    inserts: list[tuple[int, str]] = []
    inside = False
    run_last = 0
    seg_last = 0
    count = 0
    i = 0
    while i < n:
        ch = p[i]
        if ch in _QUOTE_FLIP:
            inside = not inside
            i += 1
            continue
        if inside:
            i += 1
            continue
        if ch == "\n":
            run_last = seg_last = i
            i += 1
            continue
        if ch in _PAUSE_CHARS:
            run_last = i
            i += 1
            continue
        if ch.isspace():
            run_last = i
            i += 1
            continue
        gap_run = i - run_last
        gap_seg = i - seg_last
        if gap_run >= hard_run:
            inserts.append((i, "。\n"))
            run_last = seg_last = i
            i += 1
            continue
        if count < max_inserts and gap_run >= soft_run:
            m = _match_boundary(p, i)
            if m is not None:
                wlen, strong = m
                if strong:
                    inserts.append((i, "。\n"))
                    run_last = seg_last = i
                else:
                    inserts.append((i, "，"))
                    run_last = i
                count += 1
                i += wlen
                continue
        i += 1
    if not inserts:
        return p, 0
    out = p
    for pos, tok in sorted(inserts, key=lambda x: x[0], reverse=True):
        out = out[:pos] + tok + out[pos:]
    return out, count


def repair_text_punctuation(text: str,
                            max_run: int = MAX_UNPUNCTUATED_RUN,
                            min_density: float = MIN_DENSITY_PER_100) -> tuple[str, dict]:
    """对整章按自然段执行零 LLM 断句修复。CC round-12 R2：修复前额外执行长句安全断句。"""
    if not text:
        return text, {"changed_paragraphs": 0, "inserts": 0, "residual_unhealthy": 0,
                      "long_sentences_detected": 0, "long_sentences_resolved": 0}
    text, ls_stats = split_long_sentences(text)
    paras = text.split("\n")
    changed = 0
    inserts = 0
    residual = 0
    for idx, para in enumerate(paras):
        p = para.strip()
        if not p:
            continue
        if not check_paragraph_punctuation(p, max_run=max_run, min_density=min_density)["is_unhealthy"]:
            continue
        fixed, k = repair_paragraph_long_runs(p)
        if k > 0 and fixed != p:
            paras[idx] = fixed
            changed += 1
            inserts += k
        if check_text_punctuation(paras[idx], max_run=max_run, min_density=min_density):
            residual += 1
    return "\n".join(paras), {
        "changed_paragraphs": changed,
        "inserts": inserts,
        "residual_unhealthy": residual,
        "long_sentences_detected": ls_stats.get("long_sentences_detected", 0),
        "long_sentences_resolved": ls_stats.get("split_count", 0),
    }

