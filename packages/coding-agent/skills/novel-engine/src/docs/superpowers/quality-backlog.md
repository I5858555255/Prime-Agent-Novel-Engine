# Quality Backlog

## CC round-27 follow-ups

### 1. Hermetic test inventory (tests depending on real generated artifacts)

Rule (from docs/superpowers/orchestrator-boundaries.md): any new test that
needs a real generated artifact for regression must ship a minimal synthetic
fixture as fallback; it must never depend on "this machine happened to run a
real generation before".

Status as of CC round-27:

- `test_round18_gates_wiring` (3 cases): reads `chapters/novel/chapter_4.txt`.
  **Hermetic** since fixtures_real_data.py synthesizes minimal text when the
  real file is absent.
- `test_round19_reaction_consistency` (4 cases): reads
  `chapters/novel/chapter_5.txt`. **Hermetic** (same fixture fallback).
- `test_data_dir_contains_real_state_db` (in test_memory_health.py): asserts
  `audit/per_chapter_reviews.json` presence. **Hermetic** (assertion relaxed +
  synthetic fixture).
- `test_force_best_checkpoint.py::test_force_best_draft_checkpoint_skips_resume`:
  was reading production ROOT checkpoint; **fixed in CC round-27** by adding
  `root` param to `_get_committed_chapters` (run_volume.py) — test now passes
  the injected tmp_path project. **Hermetic now**.
- `mini_test_runner.py` / `medium_test_runner.py`: tool scripts that read the
  real `audit/per_chapter_reviews.json`; they are helpers, not assertions.
  **Not hermetic by design** — acceptable; keep outside pytest suite or guard
  with existence checks.
- `test_memory_health.py::test_main_defaults_root_to_data_dir` /
  `test_data_dir_resolves_to_package_root`: only assert path resolution
  (`DATA_DIR.is_dir()`, config/ core/ exist), not artifact content.
  **Hermetic**.

### 2. Postmortem known-limitation note

ch6-ch9-failure-postmortem.md should carry a "known limitations" section:
the keyword-blacklist (hard_block 51 terms + night/negation/dawn markers +
code-level contextual exemptions) grows with each new arc; concept_unlocks is
the mechanism intended to replace per-term whack-a-mole, but its unlock tiers
(ch15/20/25) are all beyond the current 10-chapter run, so within the infant
arc it changes no interception behavior (verified old-vs-new byte-level).
Also note legacy behavior: some hard_block terms (e.g. 丹田 in a bare
sentence) are not blocked by the legacy path either; that is pre-existing
behavior, not a round-27 regression.

## 20-chapter real-generation test (2026-10-01)

Run: `run_volume --chapters 20 --resume` (real LLM, ~5.8h). 1-10 were already
COMMITTED; chapters 11-20 were generated, of which **6 COMMITTED / 4 FAILED**.

| ch | result | score | terminal cause |
|----|--------|-------|----------------|
| 11 | FAILED | 71.4 | scope_hard_leak 吐纳 (陆烬练呼吸法, subject not 陈老根 → concept lock + infant red-line) |
| 12 | FAILED | 83.25 | scope_hard_leak 吐纳 (same pattern, "他昨日夜里静坐…陈老根教的呼吸节奏") |
| 13 | COMMITTED | 89.9 | force-publish (det clean, plot_consistency advisory only) |
| 14 | COMMITTED | 79.2 | force-best (hard gate []) |
| 15 | FAILED | 88.4 | scope_hard_leak 吐纳 + naming conflict (活井/枯井 co-occur) |
| 16 | FAILED | 89.4 | non-scope (draft has 0 hard terms; high score; terminal det/reviewer hard block) |
| 17 | COMMITTED | 86.0 | — |
| 18 | COMMITTED | 84.7 | — |
| 19 | COMMITTED | 79.7 | — |
| 20 | COMMITTED | 82.1 | — |

Checkpoint after run: 16/20 COMMITTED (1-10 + 13/14/17/18/19/20).

### Findings

1. **concept_unlocks works as designed within infant arc (ch1-10)** — ch6 陈老根
   吐纳 releases without night anchor; infant agent (陆烬) remains hard. No
   regression vs pre-concept behavior.
2. **ch11+ exposes the intended-but-unconfigured tier**: director keeps
   generating "陆烬练呼吸法" scenes (continuation of the ch9 呼吸法残篇 plot),
   but cultivation_system unlocks 陈老根 only (applies_to=陈老根, ch6).
   Any sentence whose subject is 陆烬 ("他/我…陈老根教的呼吸节奏") hits the
   infant red line → hard block → fix loop exhausts → FINAL GATE BLOCK. The
   gate is correct per design; the plot momentum is the friction. Chapters
   where the plot moves off cultivation (13/14/17-20) pass at 75% (6/8).
3. **Transition chapters (ch15/16) are multi-gate hot spots**: timeline jump
   ("长大了"), POV interiority excise, naming consistency (活井/枯井), density
   — several gates fire at once; ch16 failed at 89.4 without any scope term.
4. **fact_changes ledger carries one dangling reference**: target
   'C001(陆烬)' (character_realm, unknown_ch) not found in characters/factions
   — memory_health HARD. Pre-existing normalize gap (the d5fcb8817 normalize
   covers most targets; this entry predates/escapes it).
5. API instability observed (multiple "peer closed connection" retries,
   handled by existing retry).

### Recommended next steps (design decision, not yet implemented)

- **Concept unlock for 陆烬 practicing**: either unlock cultivation_system for
  陆烬 at a chosen chapter (e.g. after the ch15 growth transition), or exempt
  "陈老根教的那套呼吸法" as a taught-method (child practicing the taught
  method is not cultivation display). Requires storyline owner decision on
  when 陆烬 may visibly cultivate.
- **Quarantine review**: inspect draft/needs_human artifacts of ch11/12/15/16
  to confirm whether any should be salvaged (ch15/16 scores 88-89 are
  close to the 88 threshold; a relaxed/unlocked rule could recover them).
- **normalize fact_changes target** for 'C001(陆烬)' style IDs in the
  fact_changes writer.
- Re-run with unlocked policy once the 陆烬-unlock decision is made; track
  forced-draft rate change as the phase-4 weighted-retrieve eval baseline.

## A-route decision: stage-1 cultivation-action ban (2026-10-01)

**Decision (storyline owner, confirmed by user)**: stage 1 (ch1-316) 陆烬 must
NOT appear in any cultivation-style action (静坐吐纳/引气/气流流转/暖意灌注/气感).
呼吸法 may only be practiced/mentioned by 陈老根; 陆烬 at most watches or is
told the result. Route B (allow 陆烬 "强身健体呼吸法" without cultivation
imagery) is deferred; it may only start after concrete positive/negative
example sentences are defined as acceptance criteria.

**Implemented**:
- `bible/author_intent.md` V01 forbidden extended with the explicit
  cultivation-action ban (bible is the setting source; director reads it).
- `chapter_director.py`: `_extract_forbidden_list()` parses the current-volume
  forbidden block; `forbidden_list` is injected into all three director prompts
  (skeleton/craft/metadata). Previously skeleton/craft had NO author_intent and
  metadata truncated at 300 chars (V01 is 328 chars → last forbidden line cut).

**ch16 root cause (separate from ch11/12/15)**: ch16 was NOT a scope leak
(draft has 0 hard terms). Evidence: no `final_gate_reject.txt` for ch16; draft
published at 00:17:40 (same timestamp as END); success=False with empty errors;
not in failed/ dir. Path: fix loop aborted by exception (likely API
"peer closed connection", observed repeatedly this run) → pre-fix text kept
(pre_fix_score=89.4 ≥ 88) → `_decide_publish` returns False because the pre-fix
text still carries review high or deterministic hard items → L1215 "score>=88
dim-gate blocked" branch: draft + pending_human_review + success=False.
The precise high/det items were not persisted (stdout-side warnings only);
attribution enhanced: human_review_note now includes high_list/det_issues, and
run_volume END line now prints note → next run will capture exact cause.

**Mojibake status (planning JSONs)**: the f43b6ad73 "fix mojibake" commit was
incomplete — systematic mojibake affected many fields. This round fixed all
stage-1-relevant fields: plot_graph nodes ch1/2/5/9/17/43/50 clean, volumes V01
outline/description clean, plus 筑基突破/太上养魂经/太虚仙门 and ~30 more words.
Remaining (NOT stage-1, tracked for a separate recovery task): volumes.json
volumes[4-9] core_conflicts/climax_description (~10 spots), plot_graph
nodes[17-44] descriptions (~24 unique bad chars, e.g. 碎Ƭ→碎片, 组֯→组织,
沈֪΢→沈知微, ѡ择→选择, ɢ→真?, ҹ→趁, ָ责→指责, 平А→平安, 封װ→封装,
ԭ核→原核, 八Ԫ→八元). Recovery needs per-word context confirmation; not
blocking stage-1 reruns (only affects ch317+ generation quality).

## A-route rerun result + ch11 root cause (2026-10-01)

Rerun (run_volume_20261001T052016Z.log, 13:20-14:37, ~77min): ch12/15/16 all
COMMITTED (87.3 / 88.7 / 86.2), only ch11 FAILED. **A-route director
constraint verified effective**: ch12/15 scope-leak 吐纳 was repaired in 1
targeted regen each and released (previously exhausted fix loop and failed);
ch16 pipeline ran cleanly (previous failure was fix-loop abort + pre-fix
high/det).

ch11 root cause (deterministic, 3/3 retries): MANDATORY HARD BLOCK "foreshadow
beats unresolved" — the F001 mandatory beat "猎户赵老四讲述传说时，陈老根恰好路过
并沉默驻足片刻" is an implicit-hint foreshadow with NO abnormal-object term
(浊气/瘴气/气感 etc.). outline_coverage_gate R15-1 tightened rule (infant-arc
specific: beat must contain abnormal-object word AND scene must show infant
reaction near subject) was misapplied to a normal implicit foreshadow →
`no_abnormal_object_in_beat` always failed; 1 targeted-regen budget exhausted
then MANDATORY HARD BLOCK, same at pre-review on retries.

Fix (committed with this record): outline_coverage_gate `_check_foreshadow_coverage`
relaxes to keyword-weak check when beat has no abnormal-object terms
(implicit foreshadow: any jieba term present in scene_text = covered). Tight
rule (abnormal term + infant reaction) fully preserved for beats WITH
abnormal terms. Verified: 4-case unit sim (implicit-pass / no-keyword-fail /
tight-pass / tight-fail) + full suite 1 failed/1048 passed (known pre-existing)
+ pyflakes 0 undefined name.
