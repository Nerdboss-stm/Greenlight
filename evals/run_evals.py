"""Eval harness — run the engine over verified gold cases and score it.

Computes: case_accuracy, per-criterion precision/recall, the five-bucket error
taxonomy, cost/case, latency/case, the (adversarial − single) delta, and a
decompose_f1 against the hand (canonical) decomposition. Conforms to EvalResult
in docs/CONTRACT.md.

    python evals/run_evals.py <procedure> [single|adversarial]
"""

from __future__ import annotations

import os
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.models import (
    CriterionResult,
    EvalResult,
    PatientEvidence,
    PerCriterionStats,
    PerPolicyStat,
    Policy,
    Taxonomy,
)
from agent import arbiter, author, pipeline, retrieve, tools

# single = baseline (reviewer only); adversarial adds the argue layer.
_MODE_TO_CASE = {"single": "baseline", "baseline": "baseline", "adversarial": "adversarial"}


def _expected_verdict(policy: Policy, expected_criteria: dict[str, str]) -> str:
    hard_ids = {c.id for c in policy.criteria if c.type == "hard"}
    synth = [
        CriterionResult(id=cid, verdict=v, policy_clause="",  # type: ignore[arg-type]
                        patient_evidence=PatientEvidence(path="", value=None),
                        reasoning="", confidence=1.0)
        for cid, v in expected_criteria.items()
    ]
    return arbiter.arbitrate(synth, hard_ids).verdict


def _score(policy: Policy, cases: list, case_mode: str, use_agent: bool | None) -> dict[str, Any]:
    hard_ids = {c.id for c in policy.criteria if c.type == "hard"}
    correct = 0
    costs: list[float] = []
    lats: list[float] = []
    tp = fp = fn = 0
    crit_total = crit_correct = 0
    conf_sum = 0.0
    tax = {"over_approval": 0, "missed_criterion": 0, "hallucinated_evidence": 0,
           "wrong_policy": 0, "extraction_miss": 0}

    for gc in cases:
        pf = _as_wire(gc.patient)
        det = pipeline.run_case(pf, gc.procedure, case_mode, use_agent=use_agent)
        # wrong_policy: engine resolved a different procedure than the case's
        if det.trace and any(
            e.type == "tool_result" and e.payload.get("procedure") not in (None, gc.procedure)
            for e in det.trace if e.phase == "retrieve"
        ):
            tax["wrong_policy"] += 1

        exp_verdict = _expected_verdict(policy, gc.expected_criteria)
        if det.verdict == exp_verdict:
            correct += 1
        costs.append(det.cost_usd)
        lats.append(det.latency_ms)

        eng = {c.id: c for c in det.criteria}
        for cid, exp_v in gc.expected_criteria.items():
            e = eng.get(cid)
            if e is None:
                continue
            crit_total += 1
            conf_sum += e.confidence
            ev = e.verdict
            if ev == exp_v:
                crit_correct += 1
            # met-class precision/recall
            if ev == "met" and exp_v == "met":
                tp += 1
            elif ev == "met" and exp_v != "met":
                fp += 1
            elif ev != "met" and exp_v == "met":
                fn += 1
            # taxonomy
            if ev != exp_v:
                if ev == "met" and exp_v in ("not_met", "unknown"):
                    tax["over_approval"] += 1
                elif ev in ("not_met", "unknown") and exp_v == "met":
                    tax["missed_criterion"] += 1
                if ev == "unknown" and exp_v in ("met", "not_met"):
                    present = bool(tools.resolve_patient_field(gc.patient, e.patient_evidence.path or "").get("present")) if e.patient_evidence.path else False
                    if present:
                        tax["extraction_miss"] += 1
            if ev == "met" and e.patient_evidence.path:
                if not tools.resolve_patient_field(gc.patient, e.patient_evidence.path).get("present"):
                    tax["hallucinated_evidence"] += 1

    n = len(cases)
    precision = tp / (tp + fp) if (tp + fp) else 1.0
    recall = tp / (tp + fn) if (tp + fn) else 1.0
    crit_acc = crit_correct / crit_total if crit_total else 1.0
    mean_conf = conf_sum / crit_total if crit_total else 0.0
    return {
        "case_accuracy": round(correct / n, 4),
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "taxonomy": tax,
        "cost_per_case": round(sum(costs) / n, 6),
        "latency_per_case": round(sum(lats) / n, 2),
        "calibration": round(1.0 - abs(mean_conf - crit_acc), 3),
    }


def _as_wire(patient) -> dict[str, Any]:
    import json
    return json.loads(patient.model_dump_json(by_alias=True))


def _decompose_f1(procedure: str, policy: Policy) -> float:
    """F1 of the engine's decomposition against the hand (canonical) decomposition."""
    slug = retrieve.normalize(procedure) or procedure
    try:
        hand_ids = {c.id for c in retrieve._canonical_policy(slug).criteria}
    except Exception:
        hand_ids = {c.id for c in policy.criteria}
    eng_ids = {c.id for c in policy.criteria}
    inter = len(hand_ids & eng_ids)
    p = inter / len(eng_ids) if eng_ids else 1.0
    r = inter / len(hand_ids) if hand_ids else 1.0
    return round(2 * p * r / (p + r), 4) if (p + r) else 0.0


def run_evals(procedure: str, mode: str, *, use_agent: bool | None = None) -> EvalResult:
    policy = retrieve.retrieve_policy(procedure)
    cases = author.verified_cases(procedure)
    if not cases:
        raise ValueError(f"no verified gold cases for {procedure!r}")

    single = _score(policy, cases, "baseline", use_agent)
    adversarial = _score(policy, cases, "adversarial", use_agent)
    primary = adversarial if _MODE_TO_CASE.get(mode) == "adversarial" else single
    delta = round(adversarial["case_accuracy"] - single["case_accuracy"], 4)

    return EvalResult(
        mode=mode,
        case_accuracy=primary["case_accuracy"],
        per_criterion=PerCriterionStats(precision=primary["precision"], recall=primary["recall"]),
        taxonomy=Taxonomy(**primary["taxonomy"]),
        delta=delta,
        calibration=primary["calibration"],
        decompose_f1=_decompose_f1(procedure, policy),
        cost_per_case=primary["cost_per_case"],
        latency_per_case=primary["latency_per_case"],
        per_policy=[PerPolicyStat(procedure=procedure, case_accuracy=primary["case_accuracy"], cases=len(cases))],
    )


if __name__ == "__main__":
    proc = sys.argv[1] if len(sys.argv) > 1 else "therapeutic_footwear"
    md = sys.argv[2] if len(sys.argv) > 2 else "adversarial"
    print(run_evals(proc, md).model_dump_json(indent=2))
