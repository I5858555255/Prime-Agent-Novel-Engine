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
- **Resolved**: 2026-09-27. Added 9 dimension→category mappings to `quality_policy.DEFAULT_POLICY["severity_map"]`:
  - `plot_consistency` → hard (core plot issues block)
  - `foreshadow_execution` → hard (missed foreshadow beats block)
  - `character_consistency` → note (character issues shown as repetition)
  - `style_match` → note (style issues shown as repetition)
  - `pacing` → note (affects length/flow)
  - `innovation` → note (weak hooks)
  - `hook_strength` → note (maps to hook_missing)
  - `reader_retention` → note (tied to pacing/length)
  - `cliffhensity` → note (affects pacing)
- Trigger note: beats pilot 30-scene result table is still empty (docs/superpowers/beats-pilot-30.md), so the 10% omission gate has NOT been empirically met; the 9 mappings were landed on domain judgment (plot/foreshadow=hard, others=note) and are covered by tests. TODO: fill the 30-scene result table; if omission >= 10%, re-review mapping severity.
- Notes: preserves 3-level severity signal — only plot/foreshadow are hard; others remain note to avoid collapsing into binary.

## 2026-09-06 — force-best log wording vs actual behavior
- Suspected module: pipeline/pipeline_orchestrator.py (force-best log line, L1219)
- **Resolved**: 2026-09-25, commit `1972ab8`. Changed "publishing best ... to novel" → "force-best to draft ... (never novel/)" to match actual behavior (writes to `chapters/draft/`, never `chapters/novel/`).

## 2026-09-06 — force-note missing hard/det snapshot
- Suspected module: pipeline/pipeline_orchestrator.py (force-best note, L1220-1225)
- **Resolved**: 2026-09-25, commit `1972ab8`. Added `_snapshot_det = list(final_det.get("issues") or [])` and updated note to reference snapshot instead of conditional `"unknown"`.
- Notes: prevents future force-bests from having no attribution evidence for which hard/det issues were present.
