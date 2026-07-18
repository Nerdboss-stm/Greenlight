"""Deterministic arbiter — the final decision, plain code, never the model.

    all hard met            → APPROVE
    any hard not_met        → DENY
    any hard unknown        → INSUFFICIENT   (fail-closed)
    low-confidence hard      → treated as unknown

Soft criteria never change the verdict. `arbitrate` is a pure function.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from api.models import CriterionResult, Verdict

LOW_CONFIDENCE = 0.5


@dataclass
class ArbiterResult:
    verdict: Verdict
    counts: dict[str, Any] = field(default_factory=dict)

    def expression(self) -> str:
        c = self.counts
        return (
            f"hard_met({c['met']}/{c['hard_total']}) ∧ "
            f"hard_not_met({c['not_met']}) ∧ hard_unknown({c['unknown']}) → {self.verdict}"
        )


def arbitrate(
    results: list[CriterionResult],
    hard_ids: set[str],
    *,
    low_confidence: float = LOW_CONFIDENCE,
) -> ArbiterResult:
    """Pure decision over the reviewed criteria. No LLM."""
    hard = [r for r in results if r.id in hard_ids]

    downgraded = 0
    effective: list[str] = []
    for r in hard:
        v = r.verdict
        if v == "met" and r.confidence < low_confidence:
            v = "unknown"  # low-confidence hard is not trustworthy → unknown
            downgraded += 1
        effective.append(v)

    met = effective.count("met")
    not_met = effective.count("not_met")
    unknown = effective.count("unknown")

    if hard and met == len(hard):
        verdict: Verdict = "APPROVE"
    elif not_met > 0:
        verdict = "DENY"
    elif unknown > 0 or not hard:
        verdict = "INSUFFICIENT"  # fail-closed (also when there are no hard criteria)
    else:
        verdict = "INSUFFICIENT"

    counts = {
        "hard_total": len(hard),
        "met": met,
        "not_met": not_met,
        "unknown": unknown,
        "low_confidence_downgraded": downgraded,
        "soft_total": len(results) - len(hard),
    }
    return ArbiterResult(verdict=verdict, counts=counts)
