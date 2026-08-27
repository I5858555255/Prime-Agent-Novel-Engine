import json
import re
from pathlib import Path


class ForbiddenScanner:
    def __init__(self, rules_path: str):
        self.rules = json.loads(Path(rules_path).read_text(encoding="utf-8")).get("rules", [])

    def scan(self, text: str) -> list[dict]:
        hits = []
        for rule in self.rules:
            try:
                rx = re.compile(rule["pattern"])
            except re.error:
                continue
            for m in rx.finditer(text or ""):
                hits.append({
                    "name": rule.get("name") or rule.get("id", "rule"),
                    "severity": rule.get("severity", "medium"),
                    "match": m.group(0),
                    "description": rule.get("description", ""),
                })
        return hits

    def scan_review(self, review: dict) -> list[dict]:
        blobs = []
        for issue in (review.get("issues") or []):
            blobs.append(str(issue.get("description", "")))
            blobs.append(str(issue.get("suggested_fix", "")))
        return self.scan(" \n ".join(blobs))
