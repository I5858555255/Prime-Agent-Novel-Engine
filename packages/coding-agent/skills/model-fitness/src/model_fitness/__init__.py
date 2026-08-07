"""Advisory model selection for Prime Agent delegation.

The skill combines two bounded inputs:

1. Prime Agent's current scoped, authenticated, executable model candidates,
   including generation-time benchmark annotations and declared costs; and
2. independently verified local outcome observations stored in harness memory.

Benchmark scores come from the generated model catalog (`models.generated.ts`),
which `packages/ai/scripts/generate-models.ts` annotates from the OpenRouter
catalog's embedded Artificial Analysis indices. A candidate without benchmark
coverage is scored with a neutral, low-confidence prior — absence is unknown,
not zero.

The skill returns exact Prime Agent selectors and explanations. It never spawns
a child; the caller decides whether to pass the returned selector to ``rlm``.
"""

from __future__ import annotations

import math
import os
import time
from dataclasses import dataclass
from hashlib import sha256
from typing import Any, Literal, TypedDict

import rlm

SchemaVersion = "prime-agent.model-fitness/v1"
OutcomeVerdict = Literal["validated_pass", "validated_fail", "accepted", "rejected", "unknown"]
MEMORY_PATH_PREFIX = "model-fitness/v1"
BENCHMARK_PRIOR_STRENGTH = 6.0
OUTCOME_HALF_LIFE_DAYS = 45.0
MAX_OBSERVATIONS_READ = 500
NEUTRAL_QUALITY_PRIOR = 0.5
BENCHMARK_SOURCE = "generated-catalog:openrouter/artificial-analysis"

TASK_PROFILES: dict[str, dict[str, Any]] = {
    "code_review": {
        "quality_floor": 0.60,
        "weights": {"coding": 0.45, "intelligence": 0.30, "agentic": 0.25},
        "expected_input_tokens": 12_000,
        "expected_output_tokens": 2_500,
    },
    "code_write": {
        "quality_floor": 0.62,
        "weights": {"coding": 0.55, "agentic": 0.30, "intelligence": 0.15},
        "expected_input_tokens": 20_000,
        "expected_output_tokens": 5_000,
    },
    "planning": {
        "quality_floor": 0.58,
        "weights": {"agentic": 0.45, "intelligence": 0.40, "coding": 0.15},
        "expected_input_tokens": 16_000,
        "expected_output_tokens": 4_000,
    },
    "research": {
        "quality_floor": 0.56,
        "weights": {"intelligence": 0.55, "agentic": 0.25, "coding": 0.20},
        "expected_input_tokens": 24_000,
        "expected_output_tokens": 4_000,
    },
    "execution": {
        "quality_floor": 0.54,
        "weights": {"agentic": 0.50, "coding": 0.35, "intelligence": 0.15},
        "expected_input_tokens": 18_000,
        "expected_output_tokens": 4_000,
    },
    "transform": {
        "quality_floor": 0.45,
        "weights": {"coding": 0.45, "intelligence": 0.35, "agentic": 0.20},
        "expected_input_tokens": 8_000,
        "expected_output_tokens": 3_000,
    },
}


class Requirements(TypedDict, total=False):
    image: bool
    reasoning: bool
    min_context_tokens: int
    min_output_tokens: int
    quality_floor: float
    max_cost_usd: float
    expected_input_tokens: int
    expected_output_tokens: int
    explore: bool


@dataclass(frozen=True)
class ScoreParts:
    benchmark_quality: float
    local_quality: float
    confidence: float
    cost_usd: float | None
    fitness: float
    evidence_count: int
    prior_only: bool
    benchmarked: bool


def _now() -> float:
    return time.time()


def _utc_timestamp(epoch: float | None = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch or _now()))


def _validate_str(name: str, value: Any, *, allow_none: bool = False) -> str | None:
    if value is None and allow_none:
        return None
    if not isinstance(value, str):
        raise TypeError(f"{name} must be str" + (" or None" if allow_none else "") + f", got {type(value).__name__}")
    if not value.strip():
        raise ValueError(f"{name} must not be empty")
    return value


def _validate_requirements(requirements: Requirements | None) -> dict[str, Any]:
    if requirements is None:
        return {}
    if not isinstance(requirements, dict):
        raise TypeError(f"requirements must be dict or None, got {type(requirements).__name__}")
    normalized = dict(requirements)
    for key in ("image", "reasoning", "explore"):
        if key in normalized and not isinstance(normalized[key], bool):
            raise TypeError(f"requirements.{key} must be bool, got {type(normalized[key]).__name__}")
    for key in ("min_context_tokens", "min_output_tokens", "expected_input_tokens", "expected_output_tokens"):
        if key in normalized and (not isinstance(normalized[key], int) or isinstance(normalized[key], bool)):
            raise TypeError(f"requirements.{key} must be int, got {type(normalized[key]).__name__}")
    for key in ("quality_floor", "max_cost_usd"):
        if key in normalized and not isinstance(normalized[key], (int, float)):
            raise TypeError(f"requirements.{key} must be a number, got {type(normalized[key]).__name__}")
    unknown = sorted(set(normalized) - set(Requirements.__annotations__))
    if unknown:
        raise ValueError(f"unsupported requirements: {', '.join(unknown)}")
    return normalized


def _safe_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number >= 0 else None


def _candidate_benchmarks(candidate: dict[str, Any]) -> dict[str, float] | None:
    raw = candidate.get("benchmarks")
    if not isinstance(raw, dict):
        return None
    benchmarks: dict[str, float] = {}
    for key in ("intelligence", "coding", "agentic"):
        value = raw.get(key)
        if isinstance(value, (int, float)) and math.isfinite(value) and 0 <= value <= 100:
            benchmarks[key] = float(value)
    return benchmarks or None


def _weighted_benchmark(benchmarks: dict[str, float] | None, weights: dict[str, float]) -> tuple[float | None, list[str]]:
    if benchmarks is None:
        return None, []
    terms: list[tuple[float, float, str]] = []
    for key, weight in weights.items():
        value = benchmarks.get(key)
        if value is not None:
            terms.append((value / 100.0, float(weight), f"{key}={value:.1f}"))
    total_weight = sum(weight for _, weight, _ in terms)
    if total_weight <= 0:
        return None, []
    return sum(value * weight for value, weight, _ in terms) / total_weight, [label for _, _, label in terms]


def _parse_observed_at(metadata: dict[str, Any]) -> float | None:
    value = metadata.get("observedAt")
    if not isinstance(value, str):
        return None
    try:
        return time.mktime(time.strptime(value, "%Y-%m-%dT%H:%M:%SZ"))
    except (TypeError, ValueError, OverflowError):
        return None


def _local_observations(selector: str, task_family: str) -> list[dict[str, Any]]:
    observations: list[dict[str, Any]] = []
    try:
        memories = list(rlm.get_harness_state().list("memory"))
    except Exception:
        return []
    for entry in memories:
        metadata = getattr(entry, "metadata", None)
        if not isinstance(metadata, dict) or metadata.get("schema") != SchemaVersion:
            continue
        if metadata.get("type") != "outcome":
            continue
        if metadata.get("model", {}).get("selector") != selector:
            continue
        if metadata.get("task", {}).get("family") != task_family:
            continue
        signal = metadata.get("signal") if isinstance(metadata.get("signal"), dict) else {}
        verdict = signal.get("verdict")
        score = signal.get("score")
        weight = signal.get("weight", 1.0)
        if verdict not in {"validated_pass", "validated_fail", "accepted", "rejected", "unknown"}:
            continue
        if score is not None and (not isinstance(score, (int, float)) or not 0 <= score <= 1):
            continue
        if not isinstance(weight, (int, float)) or weight <= 0:
            continue
        observations.append(
            {
                "id": getattr(entry, "id", ""),
                "verdict": verdict,
                "score": float(score) if isinstance(score, (int, float)) else None,
                "weight": float(weight),
                "observed_at": _parse_observed_at(metadata),
            }
        )
    observations.sort(key=lambda item: item.get("observed_at") or 0, reverse=True)
    return observations[:MAX_OBSERVATIONS_READ]


def _quality(candidate: dict[str, Any], task_family: str, weights: dict[str, float]) -> ScoreParts:
    benchmarks = _candidate_benchmarks(candidate)
    benchmark_quality, _terms = _weighted_benchmark(benchmarks, weights)
    observations = _local_observations(str(candidate["selector"]), task_family)
    benchmarked = benchmark_quality is not None
    prior = benchmark_quality if benchmarked else NEUTRAL_QUALITY_PRIOR
    alpha = BENCHMARK_PRIOR_STRENGTH * prior
    beta = BENCHMARK_PRIOR_STRENGTH * (1.0 - prior)
    evidence_weight = 0.0
    now = _now()
    for observation in observations:
        if observation["verdict"] == "unknown" or observation["score"] is None:
            continue
        age_days = max(0.0, (now - (observation.get("observed_at") or now)) / 86_400)
        weight = observation["weight"] * (0.5 ** (age_days / OUTCOME_HALF_LIFE_DAYS))
        score = float(observation["score"])
        alpha += weight * score
        beta += weight * (1.0 - score)
        evidence_weight += weight
    # A conservative 10% lower credible bound; for alpha+beta >= 2 this normal
    # approximation is adequate for ranking and avoids a scipy dependency.
    total = alpha + beta
    mean = alpha / total
    variance = (alpha * beta) / ((total * total) * (total + 1.0))
    conservative_quality = max(0.0, min(1.0, mean - 1.2815515655446004 * math.sqrt(max(variance, 0.0))))
    effective_count = max(0, len([o for o in observations if o["verdict"] != "unknown" and o["score"] is not None]))
    # A catalog benchmark is a population-level prior: use it directly until
    # repository-specific verified outcomes exist. Blend the posterior mean once
    # sparse evidence arrives; use the conservative lower bound only after
    # several observations so one pass/fail cannot dominate the prior.
    local_quality = prior if evidence_weight == 0 else mean if effective_count < 3 else conservative_quality
    confidence = min(1.0, total / (BENCHMARK_PRIOR_STRENGTH + 12.0)) * (0.75 if benchmarked else 0.5)
    return ScoreParts(
        benchmark_quality=prior,
        local_quality=local_quality,
        confidence=confidence,
        cost_usd=None,
        fitness=0.0,
        evidence_count=effective_count,
        prior_only=evidence_weight == 0,
        benchmarked=benchmarked,
    )


def _estimated_cost(candidate: dict[str, Any], requirements: dict[str, Any], profile: dict[str, Any]) -> float | None:
    """Estimated task cost in USD from declared route pricing. None means unpriced, not free."""
    expected_input = requirements.get("expected_input_tokens", profile["expected_input_tokens"])
    expected_output = requirements.get("expected_output_tokens", profile["expected_output_tokens"])
    cost = candidate.get("cost") if isinstance(candidate.get("cost"), dict) else {}
    input_price = _safe_float(cost.get("input"))
    output_price = _safe_float(cost.get("output"))
    if input_price is None or output_price is None or (input_price == 0 and output_price == 0):
        return None
    return (expected_input * input_price + expected_output * output_price) / 1_000_000


def _hard_filter(candidate: dict[str, Any], requirements: dict[str, Any], profile: dict[str, Any]) -> list[str]:
    reasons: list[str] = []
    required_tokens = requirements.get("min_context_tokens")
    if required_tokens is not None and candidate.get("contextWindow", 0) < required_tokens:
        reasons.append(f"contextWindow {candidate.get('contextWindow')} < required {required_tokens}")
    required_output = requirements.get("min_output_tokens")
    if required_output is not None and candidate.get("maxTokens", 0) < required_output:
        reasons.append(f"maxTokens {candidate.get('maxTokens')} < required {required_output}")
    if requirements.get("image") is True and "image" not in (candidate.get("input") or []):
        reasons.append("image input required")
    if requirements.get("reasoning") is True and candidate.get("reasoning") is not True:
        reasons.append("reasoning required")
    expected_total = requirements.get("expected_input_tokens", profile["expected_input_tokens"]) + requirements.get(
        "expected_output_tokens", profile["expected_output_tokens"]
    )
    if candidate.get("contextWindow", 0) < expected_total:
        reasons.append(f"contextWindow {candidate.get('contextWindow')} < expected task tokens {expected_total}")
    return reasons


def _score(candidate: dict[str, Any], task_family: str, requirements: dict[str, Any]) -> tuple[ScoreParts, list[str]]:
    profile = TASK_PROFILES[task_family]
    parts = _quality(candidate, task_family, profile["weights"])
    cost = _estimated_cost(candidate, requirements, profile)
    quality_floor = float(requirements.get("quality_floor", profile["quality_floor"]))
    reasons = [
        f"benchmark_prior={parts.benchmark_quality:.3f}" if parts.benchmarked else "benchmark_prior=unknown(neutral 0.5)",
        f"local_quality={parts.local_quality:.3f}",
        f"evidence={parts.evidence_count}",
    ]
    if parts.local_quality < quality_floor:
        return parts, [f"quality {parts.local_quality:.3f} < floor {quality_floor:.3f}"]
    max_cost = requirements.get("max_cost_usd")
    if max_cost is not None and cost is None:
        return parts, ["unpriced model cannot satisfy a strict max_cost_usd budget"]
    if max_cost is not None and cost is not None and cost > float(max_cost):
        return parts, [f"estimated cost ${cost:.4f} > budget ${float(max_cost):.4f}"]
    # Cost is a soft denominator so quality still dominates. Unpriced models get
    # no cost penalty (factor 1.0) and are flagged rather than treated as free.
    reference_cost = 0.05
    cost_factor = 1.0 + math.log1p(cost / reference_cost) if cost is not None else 1.0
    fitness = parts.local_quality / cost_factor
    if cost is None:
        reasons.append("unpriced: no cost penalty applied")
    if candidate.get("featured"):
        fitness *= 1.01
        reasons.append("featured tie preference")
    return ScoreParts(
        benchmark_quality=parts.benchmark_quality,
        local_quality=parts.local_quality,
        confidence=parts.confidence,
        cost_usd=cost,
        fitness=fitness,
        evidence_count=parts.evidence_count,
        prior_only=parts.prior_only,
        benchmarked=parts.benchmarked,
    ), reasons


def _candidate_result(
    candidate: dict[str, Any],
    parts: ScoreParts,
    reasons: list[str],
    rejected: list[str],
) -> dict[str, Any]:
    return {
        "selector": candidate["selector"],
        "provider": candidate["provider"],
        "id": candidate["id"],
        "name": candidate.get("name") or candidate["id"],
        "score": round(parts.fitness, 6),
        "quality": round(parts.local_quality, 4),
        "benchmark_prior": round(parts.benchmark_quality, 4),
        "confidence": round(parts.confidence, 3),
        "estimated_cost_usd": round(parts.cost_usd, 6) if parts.cost_usd is not None else None,
        "evidence_count": parts.evidence_count,
        "prior_only": parts.prior_only,
        "reasons": reasons,
        "rejected_reasons": rejected,
        "benchmark_source": BENCHMARK_SOURCE if parts.benchmarked else None,
        "metadata": {
            "reasoning": bool(candidate.get("reasoning")),
            "input": candidate.get("input") or [],
            "contextWindow": candidate.get("contextWindow"),
            "maxTokens": candidate.get("maxTokens"),
            "cost": candidate.get("cost"),
            "featured": bool(candidate.get("featured")),
            "benchmarks": candidate.get("benchmarks"),
        },
    }


def _project_key() -> str:
    cwd = os.environ.get("PWD", "")
    return sha256(cwd.encode("utf-8")).hexdigest()[:12] if cwd else "unknown"


async def _candidates() -> list[dict[str, Any]]:
    payload = await rlm.host_request("model_fitness.candidates")
    models = payload.get("models")
    if not isinstance(models, list):
        raise RuntimeError("model_fitness.candidates response did not contain a model list")
    return [model for model in models if isinstance(model, dict)]


def _infer_task_family(task: str) -> str:
    normalized = task.lower()
    if any(term in normalized for term in ("review", "audit", "critique", "regression")):
        return "code_review"
    if any(term in normalized for term in ("implement", "write", "fix", "edit", "refactor", "test")):
        return "code_write"
    if any(term in normalized for term in ("plan", "architect", "design", "decompose")):
        return "planning"
    if any(term in normalized for term in ("research", "investigate", "compare", "explain")):
        return "research"
    if any(term in normalized for term in ("run", "execute", "terminal", "shell", "command")):
        return "execution"
    return "transform"


async def recommend(
    task: str,
    task_family: str | None = None,
    requirements: Requirements | None = None,
    limit: int = 3,
) -> dict[str, Any]:
    """Rank currently eligible subagent models for a delegated task.

    Returns a dict with `recommended` (None when no model clears the hard
    filters/quality floor), `alternatives`, `warnings`, and `assumptions`. The
    recommendation is advisory; pass `recommended["selector"]` explicitly to
    `rlm(..., model=selector)` or omit `model` to inherit the parent model.
    """
    _validate_str("task", task)
    if task_family is None:
        task_family = _infer_task_family(task)
    _validate_str("task_family", task_family)
    if task_family not in TASK_PROFILES:
        raise ValueError(f"task_family must be one of: {', '.join(sorted(TASK_PROFILES))}")
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 20:
        raise TypeError("limit must be an integer from 1 to 20")
    requirements_dict = _validate_requirements(requirements)
    candidates = await _candidates()
    profile = TASK_PROFILES[task_family]
    warnings: list[str] = []
    assumptions = [
        "recommendation is advisory; spawn admission rechecks scope and authentication",
        "benchmark scores are build-time priors, not guarantees for this repository or task",
        "completion is not treated as a quality signal until an independent verdict is recorded",
    ]
    unbenchmarked = sum(1 for candidate in candidates if _candidate_benchmarks(candidate) is None)
    if unbenchmarked:
        warnings.append(f"{unbenchmarked} of {len(candidates)} candidates have no benchmark coverage and use a neutral prior")

    ranked: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for candidate in candidates:
        hard_reasons = _hard_filter(candidate, requirements_dict, profile)
        if hard_reasons:
            rejected.append(
                _candidate_result(candidate, ScoreParts(0.0, 0.0, 0.0, None, 0.0, 0, True, False), [], hard_reasons)
            )
            continue
        parts, reasons = _score(candidate, task_family, requirements_dict)
        floor_failures = [reason for reason in reasons if reason.startswith(("quality ", "estimated cost ", "unpriced model"))]
        if floor_failures:
            rejected.append(_candidate_result(candidate, parts, reasons, floor_failures))
            continue
        ranked.append(_candidate_result(candidate, parts, reasons, []))
    ranked.sort(key=lambda item: (-item["score"], item["estimated_cost_usd"] if item["estimated_cost_usd"] is not None else math.inf, item["selector"]))
    exploration = next((item for item in ranked if item["evidence_count"] < 3 and item["confidence"] < 0.7), None)
    recommended = ranked[0] if ranked else None
    if not candidates:
        warnings.append("no scoped, authenticated, executable models are available")
    elif not ranked:
        warnings.append("no eligible model cleared the task requirements and quality floor")
    return {
        "task_family": task_family,
        "recommended": recommended,
        "alternatives": ranked[1 : max(1, limit)],
        "candidates": ranked[: max(1, limit)],
        "rejected": rejected[: max(1, limit)],
        "exploration_candidate": exploration if requirements_dict.get("explore") else None,
        "warnings": warnings,
        "assumptions": assumptions,
    }


async def explain(selector: str, task_family: str | None = None, task: str | None = None) -> dict[str, Any]:
    """Explain benchmark and local evidence for one exact candidate selector."""
    _validate_str("selector", selector)
    if task_family is None:
        task_family = _infer_task_family(task or "")
    if task_family not in TASK_PROFILES:
        raise ValueError(f"task_family must be one of: {', '.join(sorted(TASK_PROFILES))}")
    candidates = await _candidates()
    candidate = next((item for item in candidates if item.get("selector") == selector), None)
    if candidate is None:
        raise ValueError(f"model {selector!r} is not currently scoped, authenticated, and executable")
    profile = TASK_PROFILES[task_family]
    benchmarks = _candidate_benchmarks(candidate)
    benchmark_quality, benchmark_terms = _weighted_benchmark(benchmarks, profile["weights"])
    return {
        "selector": selector,
        "task_family": task_family,
        "candidate": candidate,
        "benchmark": {
            "source": BENCHMARK_SOURCE if benchmarks else None,
            "quality_prior": benchmark_quality,
            "terms": benchmark_terms,
            "indices": benchmarks,
        },
        "local_observations": _local_observations(selector, task_family),
    }


async def record_outcome(
    selector: str,
    task_family: str,
    verdict: OutcomeVerdict,
    score: float | None = None,
    task: str | None = None,
    duration_ms: int | None = None,
    cost_usd: float | None = None,
    evidence: str | None = None,
) -> dict[str, Any]:
    """Record an independently verified outcome for a selected model.

    The outcome is stored as an immutable local harness memory entry. Use it only
    after checking the child's work (tests, review, diff inspection, or explicit
    acceptance). Ordinary child completion is not evidence of correctness.
    """
    _validate_str("selector", selector)
    _validate_str("task_family", task_family)
    if task_family not in TASK_PROFILES:
        raise ValueError(f"task_family must be one of: {', '.join(sorted(TASK_PROFILES))}")
    if verdict not in {"validated_pass", "validated_fail", "accepted", "rejected", "unknown"}:
        raise ValueError("verdict must be validated_pass, validated_fail, accepted, rejected, or unknown")
    if score is None:
        score = {"validated_pass": 1.0, "accepted": 1.0, "validated_fail": 0.0, "rejected": 0.0}.get(verdict)
    if score is not None and (not isinstance(score, (int, float)) or not 0 <= score <= 1):
        raise TypeError("score must be a number between 0 and 1")
    if duration_ms is not None and (not isinstance(duration_ms, int) or isinstance(duration_ms, bool) or duration_ms < 0):
        raise TypeError("duration_ms must be a non-negative integer or None")
    if cost_usd is not None and (not isinstance(cost_usd, (int, float)) or cost_usd < 0):
        raise TypeError("cost_usd must be a non-negative number or None")
    _validate_str("task", task, allow_none=True)
    _validate_str("evidence", evidence, allow_none=True)
    observed_at = _utc_timestamp()
    event_id = sha256(f"{selector}\0{task_family}\0{verdict}\0{observed_at}\0{time.time_ns()}".encode()).hexdigest()[:16]
    project_key = _project_key()
    title = f"Model fitness: {task_family} {verdict} on {selector}"
    content = evidence or title
    metadata = {
        "schema": SchemaVersion,
        "type": "outcome",
        "project": {"key": project_key},
        "task": {"family": task_family, **({"summary": task[:300]} if task else {})},
        "model": {"selector": selector},
        "source": {"kind": "field_outcome"},
        "signal": {"verdict": verdict, **({"score": float(score)} if score is not None else {}), "weight": 1.0},
        "telemetry": {
            **({"durationMs": duration_ms} if duration_ms is not None else {}),
            **({"costUsd": cost_usd} if cost_usd is not None else {}),
        },
        "observedAt": observed_at,
    }
    entry = rlm.harness.create_memory(
        title,
        content,
        id=f"mf-v1-{project_key}-{event_id}",
        path=f"{MEMORY_PATH_PREFIX}/{project_key}/{task_family}",
        metadata=metadata,
    )
    return {"recorded": True, "id": entry.id, "metadata": metadata}


async def run(task: str, task_family: str | None = None, requirements: Requirements | None = None, limit: int = 3) -> dict[str, Any]:
    """Alias for recommend(), used by the skill CLI wrapper."""
    return await recommend(task, task_family=task_family, requirements=requirements, limit=limit)


__all__ = ["TASK_PROFILES", "explain", "recommend", "record_outcome", "run"]
