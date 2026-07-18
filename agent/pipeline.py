"""The /case engine: adapters → retrieve → decompose → review →
(argue when adversarial) → arbiter → actions → Determination.

LLM-grounded reviewer by default (claude-sonnet-4-5, temperature 0; real
cost_usd). Set GREENLIGHT_CASE_AGENT=0 to force the deterministic reviewer
(fast, no LLM, cost_usd 0).
"""

from __future__ import annotations

import os
import time
from typing import Any

from adapters import doc_adapter, fhir_adapter
from agent import actions, argue, arbiter, retrieve, reviewer
from agent.trace import Tracer
from api.models import Determination, PatientContext

_CASE_AGENT = os.getenv("GREENLIGHT_CASE_AGENT", "1") != "0"


def _parse_patient(pf: dict[str, Any]) -> PatientContext:
    modality = pf.get("modality") or pf.get("_modality")
    has_structured = "patient_context" in pf or "encounter_fhir" in pf or pf.get("resourceType") == "Bundle"
    if modality == "transcript" or (not has_structured and isinstance(pf.get("transcript"), str)):
        return doc_adapter.parse_transcript(pf["transcript"])
    return fhir_adapter.parse_obj(pf)


def run_case(patient_file: dict[str, Any], procedure: str, mode: str = "baseline") -> Determination:
    t0 = time.monotonic()
    tracer = Tracer()

    # 1) adapters + retrieve
    tracer.phase_start("retrieve", "Parse patient · retrieve policy")
    patient = _parse_patient(patient_file)
    tracer.emit("retrieve", "tool_result", "patient parsed",
                {"age": patient.demographics.age, "sex": patient.demographics.sex,
                 "diagnoses": len(patient.diagnoses), "labs": len(patient.labs),
                 "meds": len(patient.meds), "foot_conditions": len(patient.foot_conditions)})
    policy = retrieve.retrieve_policy(procedure)
    tracer.emit("retrieve", "tool_result", f"policy {policy.procedure} ({policy.version_hash})",
                {"procedure": policy.procedure, "version_hash": policy.version_hash,
                 "source": policy.source, "criteria": len(policy.criteria)})

    # 2) decompose (retrieve returns a decomposed, validated policy)
    tracer.phase_start("decompose", f"{len(policy.criteria)} criteria")
    for c in policy.criteria:
        tracer.emit("decompose", "tool_result", f"criterion {c.id}",
                    {"id": c.id, "type": c.type, "logic": c.logic, "clause_ref": c.clause_ref})

    # 3) review
    results = reviewer.review(patient, policy, tracer, use_agent=_CASE_AGENT)

    # 4) argue (adversarial mode only)
    transcript = None
    if mode == "adversarial":
        transcript = argue.argue(patient, results, policy, tracer)

    # 5) arbiter (pure)
    tracer.phase_start("arbiter", "Deterministic arbitration")
    hard_ids = {c.id for c in policy.criteria if c.type == "hard"}
    arb = arbiter.arbitrate(results, hard_ids)
    tracer.emit("arbiter", "arbiter_math", arb.expression(), arb.counts)

    # 6) actions
    tracer.phase_start("actions", f"Draft actions · {arb.verdict}")
    cmap = {c.id: c for c in policy.criteria}
    acts = actions.build_actions(arb.verdict, results, hard_ids, cmap)
    tracer.emit("actions", "action_drafted", arb.verdict,
                {"gap_query": acts.gap_query, "appeal": acts.appeal, "review_queued": acts.review_queued})

    latency_ms = int((time.monotonic() - t0) * 1000)
    cost_usd = round(tracer.cost_usd, 6)
    tracer.emit("actions", "done", "determination",
                {"verdict": arb.verdict, "cost_usd": cost_usd, "latency_ms": latency_ms})

    return Determination(
        verdict=arb.verdict,
        criteria=results,
        argument_transcript=transcript,
        actions=acts,
        cost_usd=cost_usd,
        latency_ms=latency_ms,
        trace=tracer.events,
    )
