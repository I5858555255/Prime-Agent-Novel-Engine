"""Per-chapter review journal: append review data to audit/per_chapter_reviews.json.

Called at the end of each chapter generation to persist review scores,
issues, and verdicts for sliding-window quality memory.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from novel_engine.agents.reviewer_agent import DIM_MAX

logger = logging.getLogger(__name__)


def save_review_journal(root, chapter_num: int, score: float, review: dict) -> Path:
    """Append one chapter's review to per_chapter_reviews.json.

    Returns the path written (creates parent dirs as needed).
    """
    review_file = Path(root) / 'audit' / 'per_chapter_reviews.json'
    review_file.parent.mkdir(parents=True, exist_ok=True)
    if review_file.exists():
        try:
            existing = json.loads(review_file.read_text(encoding='utf-8'))
        except (json.JSONDecodeError, ValueError):
            existing = {'reviews': []}
    else:
        existing = {'reviews': []}
    existing['reviews'] = [r for r in existing.get('reviews', []) if r.get('chapter_num') != chapter_num]
    existing['reviews'].append({
        'chapter_num': chapter_num,
        'total_score': score,
        'normalized_score': review.get('normalized_score', score),
        'max_total': review.get('max_total', sum(DIM_MAX.values())),
        'score_schema': review.get('score_schema', 'v2'),
        'verdict': review.get('verdict', ''),
        'scores': review.get('scores', {}),
        'praise': review.get('praise', ''),
        'issues': review.get('issues', []),
        'dim_scores': review.get('dim_scores', {}),
    })
    review_file.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding='utf-8')
    return review_file

