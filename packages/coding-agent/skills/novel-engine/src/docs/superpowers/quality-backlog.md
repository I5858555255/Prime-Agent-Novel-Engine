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
