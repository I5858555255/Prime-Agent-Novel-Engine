"""Single publish arbitrator (Q4). Only reader of severity_map for publish decisions."""

def evaluate_publish(*, score, reviewer_issues, det_hard, leak, violations, policy):
    from novel_engine.core.quality_policy import is_blocking
    reasons, notes = [], []
    hard_hits = [i for i in (reviewer_issues or []) if is_blocking(policy, i.get("category", i.get("severity", "")))]
    hard_hits += [f"det:{d}" for d in (det_hard or []) if "长度" not in d and "套话" not in d]
    hard_hits += [f"leak:{x}" for x in (leak or [])]
    hard_hits += [v for v in (violations or []) if is_blocking(policy, "forbidden_block")]
    if hard_hits:
        reasons.extend(hard_hits)
        return {"publish": False, "reasons": reasons, "note": ""}
    if int(score or 0) < int(policy["publication_line"]):
        reasons.append(f"score {score} < {policy['publication_line']}")
        return {"publish": False, "reasons": reasons, "note": ""}
    notes = [d for d in (det_hard or []) if "长度" in d or "套话" in d]
    return {"publish": True, "reasons": [], "note": "; ".join(notes)}
