# Quality Backlog (frozen â€” Aâ€“D landing first)

Rule (Q1): no local patches for single cases. Crash/data-corruption hotfixes exempt (must add a regression test).
Incoming reports use this format:

## YYYY-MM-DD â€” <symptom>
- Suspected module:
- Deferred to: (A/C/B/D or post-foundation)
- Notes:

## 2026-09-05 ¡ª orchestrator Task-11 resume methods are a dormant second owner
- Suspected module: pipeline/pipeline_orchestrator.py (_resume_state_path, _mark_chapter_done, resume_from_chapter)
- Deferred to: post-foundation
- Notes: zero production callers (verified via grep in D2 fix round 1); deprecate/remove after D-series proves stable. Do NOT touch before then (freeze).
