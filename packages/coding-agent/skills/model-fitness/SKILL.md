---
name: model-fitness
description: Recommend a scoped, authenticated subagent model for a delegated task using generation-time benchmark annotations, task requirements, declared cost, and recorded local outcomes. Use when delegating work with rlm(...) and a model other than the parent may be more capable or cost-effective for the task.
---

# Model Fitness

Recommendations are advisory. This skill does not spawn subagents and never changes
the parent model. Use the returned exact selector explicitly:

```python
recommendation = await model_fitness.recommend(
    "Review the authentication refactor for regressions",
    task_family="code_review",
)
selector = recommendation["recommended"]["selector"]
child = await rlm("Review the authentication refactor", model=selector)
```

If `recommended` is `None`, omit the `model` argument and keep normal parent-model
inheritance. Spawn admission remains authoritative and rechecks scope, credentials,
and executable availability.

## API

- `await model_fitness.recommend(task, task_family=None, requirements=None, limit=3)`
  ranks currently scoped, authenticated, executable models. Requirements may include
  `image`, `reasoning`, `min_context_tokens`, `min_output_tokens`, `max_cost_usd`,
  `quality_floor`, `expected_input_tokens`, `expected_output_tokens`, and `explore`.
- `await model_fitness.record_outcome(selector, task_family, verdict, score=None,
  task=None, duration_ms=None, cost_usd=None, evidence=None)` records an independently
  verified outcome in the local continual-harness memory. Verdicts are
  `validated_pass`, `validated_fail`, `accepted`, `rejected`, and `unknown`.
- `await model_fitness.explain(selector, task_family=None, task=None)` shows the
  benchmark prior, local evidence, hard-filter status, and score breakdown.

## Data provenance and missing metadata

Benchmark scores are baked into the generated model catalog at build time by
`packages/ai/scripts/generate-models.ts`, from the OpenRouter catalog's embedded
Artificial Analysis intelligence/coding/agentic indices. Coverage is partial:
a candidate without benchmark data is scored with a neutral, low-confidence prior
(absence means "unknown", never zero) and reported in `warnings`. Declared cost
comes from the same catalog; a model with all-zero pricing is treated as unpriced
(no cost penalty), not free. Local outcomes recorded via `record_outcome` refine
the prior with a decaying Bayesian posterior; ordinary child completion is not
evidence of correctness.
