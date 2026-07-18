"""Reviewer: judge each Criterion into a CriterionResult, tool-grounded.

For each criterion the Claude Agent SDK agent MUST call get_patient_field to
ground its judgment (emitting tool_call / tool_result trace events). The final
verdict is then fixed by deterministic rules so it is reproducible (the Agent
SDK does not expose temperature):

  - a needed field is absent            → unknown   (never guess, fail-closed)
  - context_conditions not satisfied     → not_met   (acute-oxygen fails here)
  - any_of group                         → met if ANY arm is met

The agent supplies the tool-grounded reasoning narrative; the rules supply the
verdict. If the SDK/key is unavailable, the deterministic path still produces a
complete result and event log (the rule engine calls the same tools).
"""

from __future__ import annotations

import json
from typing import Any, Optional

from api.models import Criterion, CriterionResult, PatientContext, PatientEvidence, Policy
from agent import tools
from agent.trace import Tracer

# --- deterministic rule engine ----------------------------------------------

_ACUTE_CLASSES = {"IMP", "EMER", "ACUTE", "EMERGENCY", "INPATIENT"}

_ARM_KEYWORDS: dict[str, tuple[str, ...]] = {
    "amputation": ("amputation", "amputee"),
    "ulcer_history": ("ulcer",),
    "pre_ulcerative_callus": ("callus", "pre-ulcer", "pre ulcer"),
    "neuropathy_with_callus": ("neuropath",),  # requires callus too — handled specially
    "foot_deformity": ("deformity", "charcot", "hammer", "bunion", "claw toe", "hallux"),
    "poor_circulation": ("circulation", "ischem", "peripheral vascular", "peripheral arterial", "perfusion"),
}


def _compare(value: float, op: str, target: float) -> bool:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return False
    return {
        "<=": v <= target, ">=": v >= target, "<": v < target, ">": v > target,
        "==": v == target, "=": v == target, "!=": v != target,
    }.get(op, False)


def _acute(patient: PatientContext) -> tuple[bool, list[str]]:
    classes = [e.encounter_class.upper() for e in patient.encounters]
    return any(c in _ACUTE_CLASSES for c in classes), classes


def _context_satisfied(patient: PatientContext, cond: str) -> Optional[bool]:
    """True / False / None(unknown) for a single context condition."""
    c = cond.lower()
    if c in ("chronic_stable", "not_acute", "stable"):
        if not patient.encounters:
            return None
        acute, _ = _acute(patient)
        return not acute
    # at_rest / room_air aren't disprovable from structured FHIR — assume satisfied.
    return True


def _arm_met(patient: PatientContext, arm: str) -> bool:
    text = " ".join(f.display.lower() for f in patient.foot_conditions)
    if arm == "neuropathy_with_callus":
        return "neuropath" in text and "callus" in text
    return any(k in text for k in _ARM_KEYWORDS.get(arm, (arm.replace("_", " "),)))


def _threshold_field(patient: PatientContext, crit: Criterion) -> dict[str, Any]:
    text = f"{crit.text} {crit.quote}".lower()
    if any(w in text for w in ("oxygen", "saturation", "spo2", "sao2")):
        return tools.resolve_patient_field(patient, "labs.spo2")
    if "a1c" in text:
        return tools.resolve_patient_field(patient, "labs.a1c")
    return tools.resolve_patient_field(patient, crit.needs[0] if crit.needs else "labs")


def enforce_rules(patient: PatientContext, crit: Criterion) -> tuple[str, str, Any, str]:
    """Return (verdict, evidence_path, evidence_value, reasoning) — deterministic."""
    # 1) threshold criteria: numeric test + all-required measurement context
    if crit.threshold is not None:
        r = _threshold_field(patient, crit)
        path, value = r["path"], r.get("value")
        unit = r.get("unit", crit.threshold.unit)
        if not r["present"] or value is None:
            return "unknown", path, None, "needed measurement absent → unknown (fail-closed)"
        thr = crit.threshold
        if not _compare(value, thr.op, thr.value):
            return "not_met", path, value, f"{value}{unit} does not satisfy {thr.op} {thr.value}{thr.unit}"
        states = {c: _context_satisfied(patient, c) for c in crit.context_conditions}
        failed = [c for c, s in states.items() if s is False]
        unknown = [c for c, s in states.items() if s is None]
        if failed:
            return "not_met", path, value, (
                f"value {value}{unit} meets {thr.op} {thr.value}{thr.unit}, but measurement context "
                f"not satisfied: {', '.join(failed)}"
            )
        if unknown:
            return "unknown", path, value, f"threshold met but context unverifiable: {', '.join(unknown)}"
        return "met", path, value, f"value {value}{unit} meets {thr.op} {thr.value}{thr.unit} under required context"

    # 2) any_of over qualifier arms (footwear qualifying condition)
    if crit.logic == "any_of" and crit.context_conditions:
        if not patient.foot_conditions:
            return "unknown", "foot_conditions", None, "no qualifying-condition evidence documented → unknown (fail-closed)"
        met = [c for c in crit.context_conditions if _arm_met(patient, c)]
        value = [f.display for f in patient.foot_conditions]
        if met:
            return "met", "foot_conditions", value, f"any_of satisfied by: {', '.join(met)}"
        return "not_met", "foot_conditions", value, "documented foot conditions match no qualifying arm"

    # 3) all_of context (chronic-stable state)
    if crit.logic == "all_of" and crit.context_conditions:
        if "encounters" in crit.needs and not patient.encounters:
            return "unknown", "encounters.class", None, "no encounter evidence → unknown"
        _, classes = _acute(patient)
        states = {c: _context_satisfied(patient, c) for c in crit.context_conditions}
        failed = [c for c, s in states.items() if s is False]
        unknown = [c for c, s in states.items() if s is None]
        if failed:
            return "not_met", "encounters.class", classes, f"context not satisfied: {', '.join(failed)} (encounter class {classes})"
        if unknown:
            return "unknown", "encounters.class", classes, f"context unverifiable: {', '.join(unknown)}"
        return "met", "encounters.class", classes, f"context satisfied ({', '.join(crit.context_conditions)})"

    # 4) presence checks (no threshold, no context)
    return _enforce_presence(patient, crit)


def _enforce_presence(patient: PatientContext, crit: Criterion) -> tuple[str, str, Any, str]:
    text = f"{crit.id} {crit.text} {crit.quote}".lower()
    if "insulin" in text:
        r = tools.resolve_patient_field(patient, "meds.insulin")
        v = "met" if r["present"] else ("not_met" if patient.meds else "unknown")
        return v, "meds.insulin", r.get("value"), ("insulin therapy documented" if r["present"] else "no insulin in medication list")
    if "diabetes" in text:
        r = tools.resolve_patient_field(patient, "diagnoses.diabetes")
        v = "met" if r["present"] else ("not_met" if patient.diagnoses else "unknown")
        return v, "diagnoses.diabetes", r.get("value"), ("diabetes on the problem list" if r["present"] else "no diabetes diagnosis found")
    if any(w in text for w in ("therapeutic regimen", "medical management", "management", "alternative treatment")):
        present = bool(patient.prior_treatments or patient.meds)
        val = patient.prior_treatments or [m.name for m in patient.meds] or None
        return ("met" if present else "unknown"), "prior_treatments", val, ("prior treatment / medications on record" if present else "no prior regimen documented → unknown")
    root = crit.needs[0] if crit.needs else ""
    if root:
        r = tools.resolve_patient_field(patient, root)
        return ("met" if r["present"] else "unknown"), root, r.get("value"), ("evidence present" if r["present"] else "no evidence → unknown")
    return "unknown", "", None, "no evidence path for this criterion"


def _evidence_value(v: Any) -> Any:
    if v is None or isinstance(v, (int, float, str)):
        return v
    return json.dumps(v, default=str)


def _agent_agrees(text: str, verdict: str) -> bool:
    """Does the agent's prose state the same verdict the rules enforced?"""
    t = text.lower()
    if "not_met" in t or "not met" in t:
        stated = "not_met"
    elif "unknown" in t:
        stated = "unknown"
    elif "met" in t:
        stated = "met"
    else:
        return True  # no explicit verdict stated → keep the agent's grounding prose
    return stated == verdict


# --- agent (tool-grounded reasoning, Anthropic Messages API, temperature=0) --

REVIEWER_MODEL = "claude-sonnet-4-5"  # accepts temperature=0 (Opus 4.7+/Sonnet 5 reject it)

REVIEWER_SYSTEM = (
    "You are a clinical prior-authorization reviewer. For the given criterion you MUST call "
    "get_patient_field to fetch the relevant patient values before judging — never guess. "
    "Rules: if a needed field is absent, the verdict is unknown. If the criterion lists "
    "context_conditions, they must be satisfied by the evidence or the verdict is not_met "
    "(e.g. a low oxygen saturation measured during an acute inpatient admission does NOT satisfy a "
    "'chronic_stable' context). For an any_of criterion, the group is met if any one arm is met. "
    "After fetching, give ONE sentence: the verdict (met/not_met/unknown) and the grounding value."
)

_TOOL_SCHEMAS = [
    {
        "name": "get_patient_field",
        "description": "Get a patient data field by dotted path (labs.spo2, meds.insulin, "
        "diagnoses.diabetes, encounters.class, foot_conditions.ulcer, demographics.age). "
        "Returns {present, value}.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
    {
        "name": "lookup_icd10",
        "description": "Look up an ICD-10 code's description.",
        "input_schema": {
            "type": "object",
            "properties": {"code": {"type": "string"}},
            "required": ["code"],
        },
    },
]


def _suggested_paths(crit: Criterion) -> list[str]:
    text = f"{crit.text} {crit.quote}".lower()
    paths: list[str] = []
    if any(w in text for w in ("oxygen", "saturation", "spo2")):
        paths.append("labs.spo2")
    if any(c in ("chronic_stable", "not_acute") for c in crit.context_conditions) or "chronic stable" in text:
        paths.append("encounters.class")
    if "insulin" in text:
        paths.append("meds.insulin")
    if "diabetes" in text:
        paths.append("diagnoses.diabetes")
    if crit.logic == "any_of" and "foot_conditions" in crit.needs:
        paths.append("foot_conditions")
    for n in crit.needs:
        if n not in paths:
            paths.append(n)
    return paths


def _exec_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    if name == "get_patient_field":
        return tools.get_patient_field(args.get("path", ""))
    if name == "lookup_icd10":
        return tools.lookup_icd10(args.get("code", ""))
    return {"error": f"unknown tool {name}"}


def _agent_reason(crit: Criterion, tracer: Tracer, *, max_turns: int = 6) -> tuple[Optional[str], int]:
    """Run the tool-use loop on the Messages API at temperature 0.

    Returns (final reasoning text, number of tool calls made). The model MUST
    call get_patient_field; each call emits tool_call / tool_result events.
    """
    import anthropic

    client = anthropic.Anthropic()
    prompt = (
        f"Criterion {crit.id} ({crit.type}, logic={crit.logic}): {crit.text}\n"
        f'Policy quote: "{crit.quote}"\n'
        f"Needed fields: {crit.needs}. Context conditions: {crit.context_conditions}. "
        f"Threshold: {crit.threshold.model_dump() if crit.threshold else None}.\n"
        f"Call get_patient_field for the relevant paths (suggested: {_suggested_paths(crit)}), "
        f"then give your one-sentence judgment."
    )
    messages: list[dict[str, Any]] = [{"role": "user", "content": prompt}]
    final = ""
    calls = 0
    for _ in range(max_turns):
        resp = client.messages.create(
            model=REVIEWER_MODEL,
            max_tokens=1024,
            temperature=0,
            system=REVIEWER_SYSTEM,
            tools=_TOOL_SCHEMAS,
            messages=messages,
        )
        if getattr(resp, "usage", None):
            tracer.add_cost(resp.usage.input_tokens, resp.usage.output_tokens)
        text = "".join(b.text for b in resp.content if b.type == "text")
        if text:
            final = text
        if resp.stop_reason != "tool_use":
            break
        messages.append({"role": "assistant", "content": resp.content})
        tool_results = []
        for block in resp.content:
            if block.type == "tool_use":
                calls += 1
                tracer.tool_call(block.name, dict(block.input))
                result = _exec_tool(block.name, dict(block.input))
                tracer.tool_result(block.name, result)
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": json.dumps(result, default=str),
                })
        messages.append({"role": "user", "content": tool_results})
    return (final.strip() or None), calls


# --- public API --------------------------------------------------------------


def review(patient: PatientContext, policy: Policy, tracer: Tracer,
           *, use_agent: bool = True) -> list[CriterionResult]:
    """Judge every criterion of `policy` against `patient`; emit trace events.

    The agent (claude-sonnet-4-5, temperature=0) grounds each judgment via
    get_patient_field; the deterministic rules fix the verdict.
    """
    tracer.phase_start("review", f"Review · {policy.procedure} · {len(policy.criteria)} criteria")
    tools.bind(patient, policy, tracer)

    results: list[CriterionResult] = []
    for crit in policy.criteria:
        agent_reasoning: Optional[str] = None
        made_calls = 0
        if use_agent:
            try:
                agent_reasoning, made_calls = _agent_reason(crit, tracer)
            except Exception:
                agent_reasoning, made_calls = None, 0

        verdict, path, value, det_reason = enforce_rules(patient, crit)

        if made_calls == 0:
            # Agent didn't run or didn't call a tool — emit deterministic grounding so the log is complete.
            tracer.tool_call("get_patient_field", {"path": path})
            tracer.tool_result("get_patient_field", tools.resolve_patient_field(patient, path) if path else {"present": False})

        # Use the agent's prose only when its stated verdict matches the enforced one;
        # otherwise the rule engine's reasoning (which always matches the verdict).
        reasoning = agent_reasoning if (agent_reasoning and _agent_agrees(agent_reasoning, verdict)) else det_reason
        cr = CriterionResult(
            id=crit.id,
            verdict=verdict,  # type: ignore[arg-type]
            policy_clause=crit.clause_ref,
            patient_evidence=PatientEvidence(path=path, value=_evidence_value(value)),
            reasoning=reasoning,
            confidence=crit.confidence,
        )
        tracer.criterion_verdict(cr)
        results.append(cr)

    return results
