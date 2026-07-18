"""Actions — what to draft from the determination.

  INSUFFICIENT → gap_query naming exactly the missing fields, + review_queued
  DENY (with supportive evidence) → appeal citing the satisfied criteria
  APPROVE → record (no query, no appeal, no queue)
"""

from __future__ import annotations

from typing import Any

from api.models import Actions, CriterionResult, Verdict


def build_actions(
    verdict: Verdict,
    results: list[CriterionResult],
    hard_ids: set[str],
    criteria_map: dict[str, Any],
) -> Actions:
    if verdict == "INSUFFICIENT":
        missing: list[str] = []
        for r in results:
            if r.id in hard_ids and r.verdict == "unknown":
                field = r.patient_evidence.path or ", ".join(criteria_map[r.id].needs)
                if field and field not in missing:
                    missing.append(field)
        gap = (
            "Insufficient documentation to adjudicate. Please provide evidence for: "
            + "; ".join(missing) + "."
            if missing
            else "Insufficient documentation to adjudicate."
        )
        return Actions(gap_query=gap, review_queued=True)

    if verdict == "DENY":
        satisfied = [r.id for r in results if r.verdict == "met"]
        if satisfied:
            appeal = (
                "Appeal basis — the following criteria are satisfied and support reconsideration: "
                + ", ".join(satisfied) + "."
            )
            return Actions(appeal=appeal, review_queued=False)
        return Actions(review_queued=False)

    # APPROVE → record only
    return Actions(review_queued=False)
