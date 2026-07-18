"""Unit tests for the pure arbiter (agent/arbiter.py).

Runs under pytest, or standalone: `python tests/test_arbiter.py`.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.models import CriterionResult, PatientEvidence
from agent.arbiter import arbitrate


def _cr(cid: str, verdict: str, confidence: float = 0.9) -> CriterionResult:
    return CriterionResult(
        id=cid,
        verdict=verdict,  # type: ignore[arg-type]
        policy_clause="clause",
        patient_evidence=PatientEvidence(path="p", value=1),
        reasoning="r",
        confidence=confidence,
    )


def test_all_hard_met_approves():
    results = [_cr("a", "met"), _cr("b", "met"), _cr("soft", "unknown")]
    out = arbitrate(results, hard_ids={"a", "b"})
    assert out.verdict == "APPROVE", out
    assert out.counts["met"] == 2 and out.counts["hard_total"] == 2


def test_any_hard_not_met_denies():
    results = [_cr("a", "met"), _cr("b", "not_met"), _cr("c", "unknown")]
    out = arbitrate(results, hard_ids={"a", "b", "c"})
    # not_met takes precedence over unknown → DENY
    assert out.verdict == "DENY", out
    assert out.counts["not_met"] == 1


def test_any_hard_unknown_insufficient():
    results = [_cr("a", "met"), _cr("b", "unknown")]
    out = arbitrate(results, hard_ids={"a", "b"})
    assert out.verdict == "INSUFFICIENT", out
    assert out.counts["unknown"] == 1


def test_low_confidence_hard_treated_as_unknown():
    # a 'met' hard criterion below the confidence floor becomes unknown → INSUFFICIENT
    results = [_cr("a", "met"), _cr("b", "met", confidence=0.2)]
    out = arbitrate(results, hard_ids={"a", "b"})
    assert out.verdict == "INSUFFICIENT", out
    assert out.counts["low_confidence_downgraded"] == 1
    assert out.counts["unknown"] == 1


if __name__ == "__main__":
    tests = [
        test_all_hard_met_approves,
        test_any_hard_not_met_denies,
        test_any_hard_unknown_insufficient,
        test_low_confidence_hard_treated_as_unknown,
    ]
    for t in tests:
        t()
        print(f"PASS  {t.__name__}")
    print(f"\n{len(tests)}/{len(tests)} arbiter tests passed")
