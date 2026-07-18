"""Argument layer — a bounded, citation-grounded debate over contested criteria.

For each criterion the reviewer left not_met or unknown that has *candidate chart
evidence*, a bounded debate (max 2 rounds) runs:

  - payer (role=reviewer): every objection cites a policy clause_ref.
  - advocate: every claim cites a chart path+value.

validate_citation is enforced in CODE — the cited path must resolve in the
PatientContext or the claim is rejected. A criterion may flip to met ONLY via a
validated citation, and only if the criterion's measurement context is satisfied
(so a validated SpO2 citation still cannot flip an acute-inpatient oxygen
criterion — its chronic_stable context fails).

If a contested criterion has no candidate chart evidence, the debate is skipped
and the reason is emitted. Emits argument_turn, citation_check, and flip events.
"""

from __future__ import annotations

from typing import Any, Optional

from api.models import Citation, CriterionResult, PatientContext, PatientEvidence, Policy, Turn
from agent import tools
from agent.reviewer import _context_satisfied, _evidence_value, _suggested_paths
from agent.trace import Tracer

MAX_ROUNDS = 2


def _short(value: Any, limit: int = 60) -> str:
    s = str(value)
    return s if len(s) <= limit else s[:limit] + "…"


def validate_citation(patient: PatientContext, path: str) -> tuple[bool, Any]:
    """CODE-enforced: the path must resolve to present, non-empty evidence."""
    r = tools.resolve_patient_field(patient, path)
    ok = bool(r.get("present")) and r.get("value") not in (None, [], "", {})
    return ok, r.get("value")


def _candidate_paths(patient: PatientContext, crit) -> list[tuple[str, Any]]:
    """Resolvable, non-empty chart paths the advocate could cite for this criterion."""
    out: list[tuple[str, Any]] = []
    seen: set[str] = set()
    for p in _suggested_paths(crit) + list(crit.needs):
        if p in seen:
            continue
        seen.add(p)
        ok, value = validate_citation(patient, p)
        if ok:
            out.append((p, value))
    return out


def _context_ok(patient: PatientContext, crit) -> tuple[bool, list[str]]:
    """Whether the criterion's measurement context is satisfied (for a flip)."""
    # any_of-without-threshold uses context_conditions as qualifier arms, not
    # measurement context — the citation itself carries the qualifier, so no block.
    if crit.threshold is None and crit.logic == "any_of":
        return True, []
    failed = []
    for c in crit.context_conditions:
        if _context_satisfied(patient, c) is not True:  # False or None
            failed.append(c)
    return (len(failed) == 0), failed


def argue(patient: PatientContext, results: list[CriterionResult], policy: Policy,
          tracer: Tracer) -> list[Turn]:
    """Debate contested criteria; flip via validated citations. Mutates `results`."""
    tracer.phase_start("argue", f"Argument layer · {policy.procedure}")
    cmap = {c.id: c for c in policy.criteria}
    transcript: list[Turn] = []

    for cr in results:
        if cr.verdict not in ("not_met", "unknown"):
            continue
        crit = cmap.get(cr.id)
        if crit is None:
            continue

        candidates = _candidate_paths(patient, crit)
        if not candidates:
            tracer.emit("argue", "citation_check", f"{cr.id}: no candidate chart evidence — debate skipped",
                        {"criterion_id": cr.id, "skipped": True,
                         "reason": "no resolvable supporting chart field for this criterion"})
            continue

        path, value = candidates[0]

        # Round 1 — payer objection (must cite a policy clause_ref)
        payer = Turn(criterion_id=cr.id, role="reviewer", round=1, position="objection",
                     claim=f"{cr.id} is {cr.verdict} under {crit.clause_ref}: {cr.reasoning}",
                     citation=Citation(type="policy", ref=crit.clause_ref))
        transcript.append(payer)
        tracer.emit("argue", "argument_turn", f"payer objects · {cr.id}", payer.model_dump())

        # Round 1 — advocate rebuttal (must cite a chart path+value)
        advocate = Turn(criterion_id=cr.id, role="advocate", round=1, position="rebuttal",
                        claim=f"The chart supports this at {path} = {_short(value)}.",
                        citation=Citation(type="chart", ref=f"{path}={_short(value)}"))
        transcript.append(advocate)
        tracer.emit("argue", "argument_turn", f"advocate rebuts · {cr.id}", advocate.model_dump())

        # validate_citation (CODE) — path must resolve
        ok, rval = validate_citation(patient, path)
        tracer.emit("argue", "citation_check", f"{path} → {'resolved' if ok else 'unresolved'}",
                    {"criterion_id": cr.id, "path": path, "resolved": ok, "value": _short(rval)})
        if not ok:
            continue

        # a criterion flips ONLY with a validated citation AND satisfied context
        ctx_ok, failed = _context_ok(patient, crit)
        if ctx_ok:
            old = cr.verdict
            cr.verdict = "met"  # type: ignore[assignment]
            cr.patient_evidence = PatientEvidence(path=path, value=_evidence_value(value))
            cr.reasoning = f"Flipped {old}→met via validated chart citation {path}={_short(value)} ({crit.clause_ref})."
            tracer.emit("argue", "flip", f"{cr.id}: {old} → met",
                        {"criterion_id": cr.id, "from": old, "to": "met", "citation": f"{path}={_short(value)}"})
        else:
            # Round 2 — the advocate cannot satisfy the measurement context from the chart.
            tracer.emit("argue", "citation_check", f"{cr.id}: citation valid but context unmet — no flip",
                        {"criterion_id": cr.id, "path": path, "resolved": True, "flipped": False,
                         "context_unsatisfied": failed})

    return transcript
