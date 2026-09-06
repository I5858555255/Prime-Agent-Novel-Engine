# Quality Backlog (frozen — A–D landing first)

Rule (Q1): no local patches for single cases. Crash/data-corruption hotfixes exempt (must add a regression test).
Incoming reports use this format:

## YYYY-MM-DD — <symptom>
- Suspected module:
- Deferred to: (A/C/B/D or post-foundation)
- Notes:

## 2026-09-05 �� orchestrator Task-11 resume methods are a dormant second owner
- Suspected module: pipeline/pipeline_orchestrator.py (_resume_state_path, _mark_chapter_done, resume_from_chapter)
- Deferred to: post-foundation
- Notes: zero production callers (verified via grep in D2 fix round 1); deprecate/remove after D-series proves stable. Do NOT touch before then (freeze).

## 2026-09-05 — reviewer blocking signal is advisory-only (deferred, not done)
- Suspected module: pipeline/pipeline_orchestrator.py (_review_issue_is_blocking), pipeline/quality_gate.py (evaluate_publish)
- Deferred to: beats pilot (dimension→category mapping)
- Notes: real reviewer issues carry dimension in the 6 score dims + severity high/medium/low, neither of which are policy severity_map categories, so the reviewer check never blocks in practice. Advisory-only until the beats pilot lands the dimension→category mapping; do NOT "fix" by mapping all reviewer-high to hard.

## 2026-09-06 — force-best log wording vs actual behavior
- Suspected module: pipeline/pipeline_orchestrator.py (force-best log line)
- Deferred to: post-foundation
- Notes: log writes "publishing best X < 88 to novel" but actually writes draft/ (next line self-proves never novel/). Pure log-wording fix, no behavior involved.

## 2026-09-06 — force-note missing hard/det snapshot
- Suspected module: pipeline/pipeline_orchestrator.py (force-best note)
- Deferred to: post-foundation
- Notes: note writes "(hard gate unknown)"; if a future force carries hard issues there will be no attribution evidence. One snapshot line suffices.
