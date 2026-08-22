"""SLO 回归门：把 Q1(达标) 与 Q2(稳定) 变成可度量契约。"""


def evaluate_slo(report, max_fail_rate=0.01, min_avg=88.0, min_chapter=82.0):
    passed = report.get("passed", 0)
    failed = report.get("failed", 0)
    total = passed + failed
    fail_rate = (failed / total) if total else 1.0
    scores = [r.get("score", 0) for r in report.get("results", [])]
    avg = sum(scores) / len(scores) if scores else 0.0
    min_s = min(scores) if scores else 0.0
    dims = report.get("quality", {}).get("dimension_averages", {})
    meets_stability = fail_rate <= max_fail_rate
    meets_quality = (avg >= min_avg and min_s >= min_chapter
                     and dims.get("pacing", 0) >= 9 and dims.get("innovation", 0) >= 8.5)
    verdict = "PASS" if (meets_stability and meets_quality) else "FAIL"
    return {"fail_rate": fail_rate, "avg_score": avg, "min_score": min_s,
            "meets_stability": meets_stability, "meets_quality": meets_quality,
            "verdict": verdict}
