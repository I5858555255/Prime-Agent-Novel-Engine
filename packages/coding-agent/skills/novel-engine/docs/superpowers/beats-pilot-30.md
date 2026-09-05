# Beats Pilot (30 scenes): are model self-reported beats trustworthy?

## Question

Do model self-reported scene `beats` cover the events actually present in `scene_text`,
or do they omit / exaggerate? This pilot decides with a pre-registered rule so the
outcome needs no new discussion.

## Method

1. Sample 30 consecutive scenes from a pilot run.
2. For each scene, record the model's self-reported `beats` and the model-independent
   `extract_beats_fallback(scene_text)` beats (keyword-overlap, no LLM).
3. A human judge marks per scene:
   - `omission?`: YES if a fallback beat (real event in the text) is missing from
     the self-reported beats.
   - `exaggeration?`: YES if a self-reported beat describes something not present
     in the text.
4. Compute omission rate = omission-YES / 30.

## Pass criterion (pre-registered, omission-weighted)

- **PASS if omission rate < 10%** (i.e. at most 2 of 30 scenes omit). Accuracy of
  wording is secondary; omissions are what break cross-chapter dedup (Q13).
- Otherwise **FAIL**.

## Decision rule (pre-registered)

- **Pass** → cross-chapter dedup may read self-reported beats (spot-check fallback).
- **Fail** → cross-chapter dedup reads fallback beats only; self-reported beats are
  advisory text, never the dedup key.

## Result table

| scene_id | self-reported beats | fallback beats | omission? | exaggeration? |
|----------|--------------------|----------------|-----------|---------------|
| 01 | | | | |
| 02 | | | | |
| 03 | | | | |
| 04 | | | | |
| 05 | | | | |
| 06 | | | | |
| 07 | | | | |
| 08 | | | | |
| 09 | | | | |
| 10 | | | | |
| 11 | | | | |
| 12 | | | | |
| 13 | | | | |
| 14 | | | | |
| 15 | | | | |
| 16 | | | | |
| 17 | | | | |
| 18 | | | | |
| 19 | | | | |
| 20 | | | | |
| 21 | | | | |
| 22 | | | | |
| 23 | | | | |
| 24 | | | | |
| 25 | | | | |
| 26 | | | | |
| 27 | | | | |
| 28 | | | | |
| 29 | | | | |
| 30 | | | | |

**Omission rate:** ___ / 30 = ___% → **PASS / FAIL** (circle one, apply decision rule above).
