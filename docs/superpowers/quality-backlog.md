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
- Trigger met: beats pilot PASSED (2/30 = 6.7% omission < 10% threshold; docs/superpowers/beats-pilot-30.md, 2026-09-06 batch ch1-10, 3 batches x 10 scenes; exaggeration 0/30). Concrete mapping documented above.
- Notes: preserves 3-level severity signal — only plot/foreshadow are hard; others remain note to avoid collapsing into binary.

## 2026-09-06 — force-best log wording vs actual behavior
- Suspected module: pipeline/pipeline_orchestrator.py (force-best log line, L1219)
- **Resolved**: 2026-09-25, commit `1972ab8`. Changed "publishing best ... to novel" → "force-best to draft ... (never novel/)" to match actual behavior (writes to `chapters/draft/`, never `chapters/novel/`).

## 2026-09-06 — force-note missing hard/det snapshot
- Suspected module: pipeline/pipeline_orchestrator.py (force-best note, L1220-1225)
- **Resolved**: 2026-09-25, commit `1972ab8`. Added `_snapshot_det = list(final_det.get("issues") or [])` and updated note to reference snapshot instead of conditional `"unknown"`.
- Notes: prevents future force-bests from having no attribution evidence for which hard/det issues were present.

## 2026-09-28 — severity-gated blocking: low-severity hard-dimension issues no longer block publish
- Suspected module: pipeline/pipeline_orchestrator.py (_review_issue_is_blocking), pipeline/quality_gate.py (evaluate_publish)
- **Resolved**: 2026-09-28. `_review_issue_is_blocking` now returns `(blocking, advisory_high)` tuple. Hard-dimension issues (plot_consistency, foreshadow_execution) only block when severity is `high` or `medium`; `low` severity on hard dimensions is advisory only. Note-dimension issues never block but `high` severity generates `advisory_high` signal.
- Shadow comparison (scripts/audit_trend_severity.py on per_chapter_reviews.json, 5 chapters):
  - Old rule blocked 3/5 chapters (3 blocking issues); new rule blocks 1/5 chapters (1 blocking issue)
  - 2 chapters unblocked: Ch1 (`foreshadow_execution/low` → advisory), Ch3 (`foreshadow_execution/low` → advisory)
  - 1 advisory_high tracked: Ch1 `style_match/high`
  - Estimated forced_draft_rate drop: 60.0% → 20.0%
- Tests added: `test_hard_dimension_low_severity_not_blocking`, `test_note_dimension_high_severity_advisory_only`, `test_category_takes_priority_over_dimension`, `test_mixed_issues_blocking_and_advisory`, `test_evaluate_publish_with_note_high_dimension_allows_pass`
- Test result: 15 passed, 0 failed (up from 10 passed)
