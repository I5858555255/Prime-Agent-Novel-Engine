# Quality Backlog (frozen — A–D landing first)

Rule (Q1): no local patches for single cases. Crash/data-corruption hotfixes exempt (must add a regression test).
Incoming reports use this format:

## YYYY-MM-DD — <symptom>
- Suspected module:
- Deferred to: (A/C/B/D or post-foundation)
- Notes:

## 2026-09-05 — orchestrator Task-11 resume methods are a dormant second owner
- Suspected module: pipeline/pipeline_orchestrator.py (_resume_state_path, _mark_chapter_done, resume_from_chapter)
- **Resolved**: 2026-09-25, commit `1972ab8`. Deleted 3 dormant methods; callers migrated to `save_resume_state` from `production_runner`.
- Regression test: `tests/test_task11_deletion.py`.
- Notes: zero production callers (verified via grep in D2 fix round 1); deprecate/remove after D-series proves stable.

## 2026-09-05 — reviewer blocking signal is advisory-only (deferred, not done)
- Suspected module: pipeline/pipeline_orchestrator.py (_review_issue_is_blocking), pipeline/quality_gate.py (evaluate_publish)
- **Status**: Still deferred. Verified root cause: reviewer issues carry `dimension` (9 values from `DIM_MAX`) + `severity` (high/medium/low), **zero `category` field**. Policy `severity_map` has none of those 9 dimensions → every check returns `False` → advisory-only by construction.
- Deferred to: **beats pilot dimension→category mapping spec** (not just pilot completion — the *spec* that says which dimension maps to which policy category).
- Trigger: when a concrete mapping like `hook_strength → hook_missing`, `pacing → beat_repetition_thematic`, etc. is documented (even tentatively). Then land in `quality_policy.DEFAULT_POLICY["severity_map"]`.
- **Do NOT** map all reviewer-high to hard — that collapses the 3-level severity signal into a binary one and breaks the remediation loop's prioritization.
- Notes: the fix is 9 lines in `quality_policy.py` once the spec lands. Do not touch before then.

## 2026-09-06 — force-best log wording vs actual behavior
- Suspected module: pipeline/pipeline_orchestrator.py (force-best log line, L1219)
- **Resolved**: 2026-09-25, commit `1972ab8`. Changed "publishing best ... to novel" → "force-best to draft ... (never novel/)" to match actual behavior (writes to `chapters/draft/`, never `chapters/novel/`).

## 2026-09-06 — force-note missing hard/det snapshot
- Suspected module: pipeline/pipeline_orchestrator.py (force-best note, L1220-1225)
- **Resolved**: 2026-09-25, commit `1972ab8`. Added `_snapshot_det = list(final_det.get("issues") or [])` and updated note to reference snapshot instead of conditional `"unknown"`.
- Notes: prevents future force-bests from having no attribution evidence for which hard/det issues were present.
