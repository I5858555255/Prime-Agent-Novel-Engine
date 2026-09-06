# Quality Backlog (frozen â€” Aâ€“D landing first)

Rule (Q1): no local patches for single cases. Crash/data-corruption hotfixes exempt (must add a regression test).
Incoming reports use this format:

## YYYY-MM-DD â€” <symptom>
- Suspected module:
- Deferred to: (A/C/B/D or post-foundation)
- Notes:

## 2026-09-05 ï¿½ï¿½ orchestrator Task-11 resume methods are a dormant second owner
- Suspected module: pipeline/pipeline_orchestrator.py (_resume_state_path, _mark_chapter_done, resume_from_chapter)
- Deferred to: post-foundation
- Notes: zero production callers (verified via grep in D2 fix round 1); deprecate/remove after D-series proves stable. Do NOT touch before then (freeze).

## 2026-09-05 â€” reviewer blocking signal is advisory-only (deferred, not done)
- Suspected module: pipeline/pipeline_orchestrator.py (_review_issue_is_blocking), pipeline/quality_gate.py (evaluate_publish)
- Deferred to: beats pilot (dimensionâ†’category mapping)
- Notes: real reviewer issues carry dimension in the 6 score dims + severity high/medium/low, neither of which are policy severity_map categories, so the reviewer check never blocks in practice. Advisory-only until the beats pilot lands the dimensionâ†’category mapping; do NOT "fix" by mapping all reviewer-high to hard.

## 2026-09-06 ¡ª force-best ÈÕÖ¾ÎÄ°¸ÓëÐÐÎª²»Ò»ÖÂ
- Suspected module: pipeline/pipeline_orchestrator.py (force-best log line)
- Deferred to: post-foundation
- Notes: ÈÕÖ¾Ð´ "publishing best X < 88 to novel"£¬Êµ¼ÊÐ´µÄÊÇ draft/£¨ÏÂÒ»ÐÐ×ÔÖ¤ never novel/£©¡£´¿ÎÄ°¸ÐÞÕý£¬²»Éæ¼°ÐÐÎª¡£

## 2026-09-06 ¡ª force Ê±¿Ì note È± hard/det ×´Ì¬¿ìÕÕ
- Suspected module: pipeline/pipeline_orchestrator.py (force-best note)
- Deferred to: post-foundation
- Notes: note Ð´ "(hard gate unknown)"£»Èô½«À´Ä³´Î´øÓ²ÎÊÌâ force£¬½«È±¹éÒòÖ¤¾Ý¡£¼ÓÒ»ÐÐ¿ìÕÕ¼´¿É¡£
