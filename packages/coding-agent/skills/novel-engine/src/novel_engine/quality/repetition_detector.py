"""
确定性质量检测器：重复/截断/长度异常。
用于在 POLISH 后对成品进行硬校验，命中即触发修复而非静默通过。
"""
import re
from collections import Counter


def detect_repetition(text: str, min_block: int = 200, min_repeats: int = 3) -> dict:
    """检测整块重复：若同一段落/块连续出现 ≥min_repeats 次，或最长重复子串 ≥min_block，判定为重复灾难。"""
    issues = []
    # 按段落切分（空行分隔）
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    if len(paras) >= 4:
        # 统计完全相同段落
        cnt = Counter(paras)
        for para, c in cnt.most_common(3):
            if c >= min_repeats and len(para) >= 50:
                issues.append(f"段落重复 {c} 次（≥{min_repeats}）：{para[:60]}…")
                break
        # 连续大块重复（n-gram 滑窗 200字）
        for window in [200, 400]:
            seen = set()
            for i in range(len(text) - window):
                chunk = text[i:i+window]
                if len(chunk.strip()) < window * 0.8:
                    continue
                if chunk in seen:
                    # 二次出现即判
                    if text.count(chunk) >= 2:
                        issues.append(f"检测到 {window} 字级整块重复")
                        break
                seen.add(chunk)
            if issues:
                break
        # 最长重复子串快速检测（对 8KB 以上文本，仅检查前 8KB 避免 O(n^2)）
        if not issues and len(text) > 4000:
            sample = text[:8000]
            # 使用后缀数组简化：检查是否有 200 字块在 sample 中出现 ≥3 次
            for i in range(0, len(sample) - min_block, min_block):
                block = sample[i:i+min_block]
                if sample.count(block) >= min_repeats:
                    issues.append(f"最长重复子串 ≥{min_block} 字且出现 ≥{min_repeats} 次")
                    break
    return {"has_repetition": bool(issues), "issues": issues}


def detect_truncation(text: str) -> dict:
    """检测硬截断：不能断在半句/半段，且必须含完整句读收尾。"""
    issues = []
    stripped = text.strip()
    if not stripped:
        return {"is_truncated": True, "issues": ["正文为空"]}
    # 末尾必须以句读收尾（允许 ）」等闭合符号）
    if stripped[-1] not in "。！？」”’\"…—）":
        if len(stripped) > 100 and stripped[-1] not in "。！？」”’\"…—） \n":
            issues.append(f"疑似硬截断：末字符为“{stripped[-1]}”非句读")
    # 检测半句截断（如以“的”“了”“在”等虚词结尾）
    if re.search(r"[的了在与和或但而]$", stripped[-12:]):
        issues.append("疑似半句截断：末尾为虚词收尾")
    # 检测章节长度异常：过短
    if len(stripped) < 1500:
        issues.append(f"章节过短（{len(stripped)} 字），目标 80% 未达")
    return {"is_truncated": bool(issues), "issues": issues}


def detect_length_anomaly(text: str, target: int | None) -> dict:
    """对照 scene_blueprints 目标字数校验。"""
    if not target or target <= 0:
        return {"anomaly": False, "issues": []}
    actual = len(text)
    low, high = int(target * 0.65), int(target * 1.35)
    issues = []
    if actual < low:
        issues.append(f"字数不足：实际 {actual} < 目标 {target}*0.65={low}")
    elif actual > high:
        issues.append(f"字数超标：实际 {actual} > 目标 {target}*1.35={high}")
    return {"anomaly": bool(issues), "issues": issues}


def purify_novel_for_publish(draft: str) -> str:
    """成品净化：剥离所有脚手架标记，仅保留可发布正文。P0 增强版。"""
    text = draft
    # 去除 【场景N：...】 标题行（兼容有无空格、全角/半角冒号）
    text = re.sub(r"【场景\s*\d+\s*[:：][^】]*】\s*\n*", "", text)
    # 去除所有含 元指令关键词 的 【...】 块（当前字数、节拍、拍点、本节等）
    text = re.sub(r"【[^】]*?(?:字数|节拍|拍点|当前|本节)[^】]*】\s*\n*", "", text)
    # 去除纯指令性短行（如 "场景 1：..." 单独成行）
    text = re.sub(r"^\s*场景\s*\d+\s*[:：].*$\n*", "", text, flags=re.MULTILINE)
    # 去除 ※ 分隔符（含两侧空白）
    text = re.sub(r"\n?\s*※\s*\n?", "\n\n", text)
    # 去除 --- 分隔线
    text = re.sub(r"\n?\s*---\s*\n?", "\n\n", text)
    # 保留章末钩子内容，仅剥离标记（P1 保 hook）
    text = re.sub(r"\*?\s*（章末钩子[:：]\s*([^）]*)）\s*\*?", r"\n\n\1", text)
    text = re.sub(r"（章末钩子[^）]*）", "", text)
    # 去除 （注：...）
    text = re.sub(r"（注：[^）]*）", "", text)
    text = re.sub(r"\(注：[^)]*\)", "", text)
    # 去除残留的场景标记变体
    text = re.sub(r"###\s*[一二三四五六七八九十]+\s*\n*", "", text)
    # 去除章节内残留的 "# 第四章·..." 多余标题（仅保留首个）
    lines = text.split("\n")
    seen_first_title = False
    cleaned_lines = []
    for line in lines:
        if re.match(r"^\s*#\s*第[一二三四五六七八九十\d]+章", line):
            if not seen_first_title:
                cleaned_lines.append(line)
                seen_first_title = True
            # 后续章节标题视为脚手架，丢弃
            continue
        # 过滤纯元数据行（仅含【】或节拍/字数关键词）
        if re.match(r"^\s*【[^】]*】\s*$", line):
            continue
        if any(kw in line for kw in ["节拍点完成", "当前字数", "本节拍"]):
            continue
        cleaned_lines.append(line)
    text = "\n".join(cleaned_lines)
    # 压缩多余空行
    text = re.sub(r"\n{3,}", "\n\n", text)
    # P1 保 hook：若末尾无句读收束，补句号
    stripped = text.strip()
    if stripped and stripped[-1] not in "。！？…）」”":
        text = stripped + "。"
    return text.strip()

def verify_no_scaffolding(text: str) -> list[str]:
    """发布前终检：成品不得含脚手架 token。"""
    issues = []
    if "【" in text or "】" in text:
        # 允许章节标题 "# 第X章" 含的 【】 已在上步去除，此处再出现即污染
        if re.search(r"【[^】]*】", text):
            issues.append("残留【】包裹的指令/标记")
    for tok in ["※", "（章末钩子", "（注：", "节拍点", "当前字数", "本节拍"]:
        if tok in text:
            issues.append(f"残留脚手架 token: {tok}")
    # 检查场景标记格式混乱（多种标题混用）
    if len(re.findall(r"#\s*第[一二三四五六七八九十\d]+章", text)) > 1:
        issues.append("章节内含多个 # 第X章 标题，格式混乱")
    return issues
