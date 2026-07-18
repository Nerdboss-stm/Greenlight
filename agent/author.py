"""Case-author agent + deterministic branch validator + gold store.

Given a Policy and a target count, a case-author agent (strongest available
model, claude-opus-4-8) emits synthetic GoldCases — a PatientContext aimed at a
specific (label × OR-branch × trap) combination, each seeded with 2–3 irrelevant
comorbidities/meds as realistic noise.

A deterministic validator then REJECTS any candidate whose patient does not
actually trigger the intended branch when the engine runs (e.g. a footwear
'approve' candidate carrying only bare peripheral neuropathy — which does not
qualify). Accepted cases are stored append-only in data/gold/cases.json with
status 'pending_human'; their expected_criteria are the engine's own per-criterion
verdicts (the rule-consistent ground truth a human then verifies).
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any, Optional

from api.models import CriterionResult, GoldCase, PatientContext, Policy
from agent import arbiter, retrieve, reviewer
from agent.trace import Tracer

AUTHOR_MODEL = "claude-opus-4-8"  # strongest widely-available model

GOLD_PATH = Path(__file__).resolve().parents[1] / "data" / "gold" / "cases.json"

_LABEL_TO_VERDICT = {"approve": "APPROVE", "deny": "DENY", "insufficient": "INSUFFICIENT"}


# --- target enumeration ------------------------------------------------------


def _targets_for(policy: Policy, n: int) -> list[dict[str, Any]]:
    """Enumerate (label × branch × trap) combinations for a policy.

    Each combo carries a `gap` = the criterion id that is NOT met (unknown for
    insufficient, not_met for deny); expected_criteria are derived from this
    design, independent of the engine.
    """
    combos: list[dict[str, Any]] = []
    any_of = next((c for c in policy.criteria if c.logic == "any_of" and c.context_conditions and not c.threshold), None)
    insulin = next((c for c in policy.criteria if "insulin" in c.text.lower()), None)

    if any_of is not None:  # footwear-style: one branch per qualifier arm + a trap
        for arm in any_of.context_conditions:
            combos.append({
                "label": "approve", "branch": arm, "gap": None, "trap": None,
                "evidence_hint": _arm_evidence(arm),
                "reason": f"Diabetes + {arm.replace('_', ' ')} → qualifying condition met → APPROVE.",
            })
        combos.append({
            "label": "insufficient", "branch": "no_qualifying_condition", "gap": any_of.id, "trap": None,
            "evidence_hint": "no documented foot condition at all",
            "reason": "Diabetes but no documented qualifying foot condition → INSUFFICIENT (fail-closed).",
        })
        combos.append({
            "label": "approve", "branch": "bare_neuropathy", "gap": None,
            "trap": "bare peripheral neuropathy without callus does NOT qualify",
            "evidence_hint": "foot_conditions containing ONLY 'Peripheral neuropathy' (no callus, no ulcer, no amputation)",
            "reason": "TRAP: looks qualifying but bare neuropathy without callus should not approve.",
        })

    if insulin is not None:  # CGM-style: insulin naming stress + a gap
        combos.append({
            "label": "approve", "branch": "insulin_generic", "gap": None, "trap": None,
            "evidence_hint": 'insulin named explicitly, e.g. "insulin glargine" and "insulin lispro"',
            "reason": "Diabetes + insulin (named) → APPROVE.",
        })
        combos.append({
            "label": "approve", "branch": "insulin_brand", "gap": None,
            "trap": "insulin given ONLY under brand names the naive reviewer misses",
            "evidence_hint": 'insulin ONLY under brand names "Lantus" (basal) and "Humalog" (mealtime); do NOT write the word insulin in any med name',
            "reason": "Diabetes + BRAND-named insulin → APPROVE, but only the adversarial layer recovers it.",
        })
        combos.append({
            "label": "insufficient", "branch": "no_meds", "gap": insulin.id, "trap": None,
            "evidence_hint": "diabetes but NO medications documented at all (empty med list)",
            "reason": "Diabetes, medications undocumented → insulin status unknown → INSUFFICIENT.",
        })

    if not combos:  # generic policy: one case per outcome
        hard0 = next((c.id for c in policy.criteria if c.type == "hard"), None)
        combos = [
            {"label": "approve", "branch": "all_criteria_met", "gap": None, "trap": None,
             "evidence_hint": "satisfy every hard criterion", "reason": "All hard criteria met → APPROVE."},
            {"label": "insufficient", "branch": "missing_evidence", "gap": hard0, "trap": None,
             "evidence_hint": "omit the evidence for the first hard criterion", "reason": "A hard criterion unverifiable → INSUFFICIENT."},
        ]
    return combos[:n]


def _expected_from_design(policy: Policy, combo: dict[str, Any]) -> dict[str, str]:
    """Independent ground truth from the case design — NOT the engine's output."""
    gap = combo.get("gap")
    exp: dict[str, str] = {}
    for c in policy.criteria:
        if c.type == "soft":
            exp[c.id] = "met"
        elif combo["label"] == "approve":
            exp[c.id] = "met"
        elif combo["label"] == "insufficient":
            exp[c.id] = "unknown" if c.id == gap else "met"
        elif combo["label"] == "deny":
            exp[c.id] = "not_met" if c.id == gap else "met"
        else:
            exp[c.id] = "met"
    return exp


def _arm_evidence(arm: str) -> str:
    return {
        "amputation": "foot_conditions containing a partial foot amputation",
        "ulcer_history": "foot_conditions containing a diabetic foot ulcer",
        "pre_ulcerative_callus": "foot_conditions containing a pre-ulcerative callus",
        "neuropathy_with_callus": "foot_conditions containing peripheral neuropathy WITH callus formation",
        "foot_deformity": "foot_conditions containing a foot deformity (e.g. Charcot foot, hammertoe)",
        "poor_circulation": "foot_conditions containing poor circulation / peripheral arterial disease of the foot",
    }.get(arm, arm.replace("_", " "))


# --- LLM patient generation --------------------------------------------------

_AUTHOR_SYSTEM = """You author SYNTHETIC clinical test patients for evaluating a
prior-authorization engine. Everything is fictional — never a real patient.
Output ONE JSON object matching this PatientContext shape and nothing else:

{
  "demographics": {"age": <int>, "sex": "male|female|other|unknown"},
  "diagnoses": [{"icd10": "<code>", "display": "<text>"}],
  "labs": [{"code": "<loinc>", "display": "<name>", "value": <number|string>, "unit": "<unit>", "date": "<ISO>"}],
  "meds": [{"name": "<drug>", "rxnorm": "<code>"}],
  "prior_treatments": ["<text>"],
  "symptoms": ["<text>"],
  "foot_conditions": [{"icd10": "<code>", "display": "<text>"}],
  "encounters": [{"class": "AMB|IMP|EMER", "date": "<ISO>", "reason": "<text>"}],
  "source_spans": {}
}

Rules:
- Build the patient so the requested branch is triggered EXACTLY as described.
- Add 2–3 IRRELEVANT comorbidities (diagnoses) and 2–3 irrelevant medications as
  realistic noise that must NOT affect the coverage decision (e.g. hypertension,
  hyperlipidemia, GERD; lisinopril, atorvastatin, omeprazole).
- Diabetic-foot qualifiers belong in foot_conditions, not diagnoses."""


def _generate_patient(policy: Policy, combo: dict[str, Any]) -> Optional[PatientContext]:
    import anthropic

    client = anthropic.Anthropic()
    crit_lines = "\n".join(
        f"- {c.id} ({c.type}, logic={c.logic}) needs={c.needs} context={c.context_conditions} "
        f"threshold={c.threshold.model_dump() if c.threshold else None}"
        for c in policy.criteria
    )
    trap = f" TRAP: {combo['trap']}." if combo.get("trap") else ""
    user = (
        f"Policy '{policy.procedure}' criteria:\n{crit_lines}\n\n"
        f"Author a patient whose engine result should be {combo['label'].upper()} by way of branch "
        f"'{combo['branch']}'. Branch evidence to include: {combo['evidence_hint']}.{trap}\n"
        f"Return the PatientContext JSON."
    )
    try:
        resp = client.messages.create(
            model=AUTHOR_MODEL, max_tokens=2048, system=_AUTHOR_SYSTEM,
            messages=[{"role": "user", "content": user}],
        )
        text = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")
        data = _extract_json(text)
        return PatientContext.model_validate(data)
    except Exception:
        return None


def _extract_json(text: str) -> dict[str, Any]:
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.IGNORECASE).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        s, e = cleaned.find("{"), cleaned.rfind("}")
        if s < 0 or e <= s:
            raise ValueError("author returned no JSON object")
        return json.loads(cleaned[s : e + 1])


# --- deterministic branch validator -----------------------------------------


def _engine_verdict(policy: Policy, patient: PatientContext) -> str:
    """Run the full (adversarial) engine and return its verdict."""
    from agent import pipeline

    import json as _json
    pf = _json.loads(patient.model_dump_json(by_alias=True))
    return pipeline.run_case(pf, policy.procedure, "adversarial", use_agent=False).verdict


def validate_candidate(policy: Policy, patient: PatientContext, combo: dict[str, Any]) -> tuple[bool, str]:
    """Reject a candidate whose patient does not trigger the intended branch
    under the full engine (so a brand-insulin approve is only valid if the
    adversarial layer actually recovers it)."""
    verdict = _engine_verdict(policy, patient)
    return verdict == _LABEL_TO_VERDICT[combo["label"]], verdict


# --- public API --------------------------------------------------------------


def author_cases(policy: Policy, targets: int) -> tuple[list[GoldCase], list[dict[str, Any]]]:
    """Return (accepted GoldCases, rejected candidate summaries)."""
    accepted: list[GoldCase] = []
    rejected: list[dict[str, Any]] = []
    for i, combo in enumerate(_targets_for(policy, targets)):
        patient = _generate_patient(policy, combo)
        if patient is None:
            rejected.append({"branch": combo["branch"], "reason": "generation failed"})
            continue
        ok, verdict = validate_candidate(policy, patient, combo)
        if not ok:
            rejected.append({
                "branch": combo["branch"], "intended": combo["label"], "engine_verdict": verdict,
                "reason": f"patient did not trigger intended branch (engine said {verdict})",
                "trap": combo.get("trap"),
            })
            continue
        accepted.append(GoldCase(
            case_id=_case_id(policy.procedure, combo, i),
            procedure=policy.procedure,
            patient=patient,
            expected_criteria=_expected_from_design(policy, combo),  # independent ground truth
            reason=combo["reason"],
            status="pending_human",
        ))
    return accepted, rejected


def author_and_store(procedure: str, targets: int) -> tuple[list[GoldCase], list[dict[str, Any]]]:
    policy = retrieve.retrieve_policy(procedure)
    accepted, rejected = author_cases(policy, targets)
    append_cases(accepted)
    return accepted, rejected


def _case_id(procedure: str, combo: dict[str, Any], i: int) -> str:
    h = hashlib.sha256(f"{procedure}:{combo['branch']}:{combo['label']}:{i}".encode()).hexdigest()[:8]
    return f"gold-{procedure}-{combo['branch']}-{h}"


# --- append-only gold store --------------------------------------------------


def load_cases() -> list[dict[str, Any]]:
    if not GOLD_PATH.exists():
        return []
    try:
        return json.loads(GOLD_PATH.read_text(encoding="utf-8"))
    except Exception:
        return []


def append_cases(cases: list[GoldCase]) -> None:
    GOLD_PATH.parent.mkdir(parents=True, exist_ok=True)
    existing = load_cases()
    known = {c.get("case_id") for c in existing}
    for gc in cases:
        if gc.case_id not in known:
            existing.append(json.loads(gc.model_dump_json(by_alias=True)))
            known.add(gc.case_id)
    GOLD_PATH.write_text(json.dumps(existing, indent=2), encoding="utf-8")


def set_status(procedure: str, decisions: dict[str, str]) -> int:
    """Apply accept/reject decisions; return the count of verified cases for the procedure."""
    cases = load_cases()
    for c in cases:
        if c.get("procedure") == procedure and c.get("case_id") in decisions:
            c["status"] = "verified" if decisions[c["case_id"]] == "accept" else "rejected"
    GOLD_PATH.write_text(json.dumps(cases, indent=2), encoding="utf-8")
    return sum(1 for c in cases if c.get("procedure") == procedure and c.get("status") == "verified")


def verified_cases(procedure: str) -> list[GoldCase]:
    return [
        GoldCase.model_validate(c)
        for c in load_cases()
        if c.get("procedure") == procedure and c.get("status") == "verified"
    ]
