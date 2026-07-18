"""Reviewer tools: get_patient_field, lookup_icd10, get_policy.

Two faces:
- Plain Python functions (deterministic) that operate on the bound PatientContext
  / Policy — used by the reviewer's rule engine and importable directly.
- Claude Agent SDK @tool wrappers (mcp__gl__*) so the reviewer agent MUST call
  them to ground its judgment. The wrappers emit tool_call / tool_result trace
  events via the bound Tracer.

Bind the current patient/policy/tracer with `bind(...)` before a review.
"""

from __future__ import annotations

import json
import os
from typing import Any, Optional

from api.models import PatientContext, Policy

# --- bound review context ----------------------------------------------------

_PATIENT: Optional[PatientContext] = None
_POLICY: Optional[Policy] = None
_TRACER: Any = None  # agent.trace.Tracer (avoid import cycle)


def bind(patient: PatientContext, policy: Optional[Policy], tracer: Any) -> None:
    global _PATIENT, _POLICY, _TRACER
    _PATIENT, _POLICY, _TRACER = patient, policy, tracer


# --- semantic field resolution ----------------------------------------------

# keyword → matchers for list sub-selectors (labs / meds / diagnoses / foot)
_SPO2_CODES = {"2708-6", "59408-5", "2710-2"}
_SPO2_WORDS = ("oxygen sat", "spo2", "sao2", "o2 sat", "oxygen saturation")
_A1C_WORDS = ("a1c", "hemoglobin a1c", "glycohemoglobin")


def _labs_matching(patient: PatientContext, sub: str) -> list[Any]:
    s = sub.lower()
    out = []
    for lab in patient.labs:
        disp = (lab.display or "").lower()
        code = (lab.code or "")
        if s in ("spo2", "sao2", "oxygen", "oxygen_saturation", "o2", "saturation"):
            if code in _SPO2_CODES or any(w in disp for w in _SPO2_WORDS):
                out.append(lab)
        elif s in ("a1c", "hba1c", "hemoglobin"):
            if code == "4548-4" or any(w in disp for w in _A1C_WORDS):
                out.append(lab)
        elif s and (s in disp or s in code.lower()):
            out.append(lab)
    return out


def _has_keyword(text: str, *keywords: str) -> bool:
    t = text.lower()
    return any(k in t for k in keywords)


def resolve_patient_field(patient: PatientContext, path: str) -> dict[str, Any]:
    """Navigate a PatientContext by dotted path. Returns {path, present, value, unit?}.

    Top-level fields resolve directly. For list fields a second segment is a
    semantic selector: labs.spo2, meds.insulin, diagnoses.diabetes,
    encounters.class, foot_conditions.ulcer, demographics.age.
    """
    parts = [p for p in path.split(".") if p]
    if not parts:
        return {"path": path, "present": False, "value": None}
    root = parts[0]
    sub = parts[1] if len(parts) > 1 else None

    if root == "demographics":
        d = patient.demographics
        if sub:
            val = getattr(d, sub, None)
            return {"path": path, "present": val is not None, "value": val}
        return {"path": path, "present": True, "value": {"age": d.age, "sex": d.sex}}

    if root == "labs":
        if sub:
            matches = _labs_matching(patient, sub)
            if not matches:
                return {"path": path, "present": False, "value": None}
            # numeric selector → report the most severe (min) numeric value
            nums = [m for m in matches if isinstance(m.value, (int, float))]
            chosen = min(nums, key=lambda m: m.value) if nums else matches[0]
            return {"path": path, "present": True, "value": chosen.value,
                    "unit": chosen.unit, "display": chosen.display, "date": chosen.date}
        return {"path": path, "present": bool(patient.labs),
                "value": [f"{l.display}={l.value}{l.unit}" for l in patient.labs[:8]]}

    if root == "meds":
        if sub:
            hits = [m for m in patient.meds if sub.lower() in m.name.lower()]
            return {"path": path, "present": bool(hits),
                    "value": [m.name for m in hits] or None}
        return {"path": path, "present": bool(patient.meds), "value": [m.name for m in patient.meds]}

    if root == "diagnoses":
        if sub:
            hits = [d for d in patient.diagnoses
                    if sub.lower() in d.display.lower() or d.icd10.lower().startswith(sub.lower())]
            return {"path": path, "present": bool(hits),
                    "value": [f"{d.icd10} {d.display}" for d in hits] or None}
        return {"path": path, "present": bool(patient.diagnoses),
                "value": [f"{d.icd10} {d.display}" for d in patient.diagnoses]}

    if root == "foot_conditions":
        if sub:
            hits = [f for f in patient.foot_conditions if sub.lower() in f.display.lower()]
            return {"path": path, "present": bool(hits),
                    "value": [f.display for f in hits] or None}
        return {"path": path, "present": bool(patient.foot_conditions),
                "value": [f"{f.icd10} {f.display}" for f in patient.foot_conditions]}

    if root == "encounters":
        classes = [e.encounter_class for e in patient.encounters]
        if sub == "class":
            return {"path": path, "present": bool(classes), "value": classes}
        return {"path": path, "present": bool(patient.encounters),
                "value": [{"class": e.encounter_class, "date": e.date, "reason": e.reason} for e in patient.encounters]}

    if root in ("prior_treatments", "symptoms"):
        data = getattr(patient, root)
        return {"path": path, "present": bool(data), "value": list(data)}

    return {"path": path, "present": False, "value": None}


# --- plain tool functions ----------------------------------------------------


def get_patient_field(path: str) -> dict[str, Any]:
    if _PATIENT is None:
        return {"path": path, "present": False, "value": None, "error": "no patient bound"}
    return resolve_patient_field(_PATIENT, path)


# small offline ICD-10 map for the demo procedures; connector overrides when present
_ICD10_LOCAL = {
    "E11.9": "Type 2 diabetes mellitus without complications",
    "E11.65": "Type 2 diabetes mellitus with hyperglycemia",
    "E11.621": "Type 2 diabetes mellitus with foot ulcer",
    "E11.42": "Type 2 diabetes mellitus with diabetic polyneuropathy",
    "E10.9": "Type 1 diabetes mellitus without complications",
    "J44.9": "Chronic obstructive pulmonary disease, unspecified",
    "J12.82": "Pneumonia due to coronavirus disease 2019",
    "R09.02": "Hypoxemia",
    "L97.509": "Non-pressure chronic ulcer of unspecified foot",
    "I73.9": "Peripheral vascular disease, unspecified",
    "I10": "Essential (primary) hypertension",
    "E78.5": "Hyperlipidemia, unspecified",
}


def lookup_icd10(code: str) -> dict[str, Any]:
    code = (code or "").strip().upper()
    endpoint = os.getenv("ICD10_CONNECTOR_URL")
    if endpoint:
        try:  # pragma: no cover - external connector
            import requests

            resp = requests.get(endpoint, params={"code": code}, timeout=10)
            resp.raise_for_status()
            data = resp.json()
            return {"code": code, "description": data.get("description") or data.get("name"),
                    "source": "icd10-connector"}
        except Exception:
            pass
    desc = _ICD10_LOCAL.get(code)
    return {"code": code, "description": desc, "found": desc is not None, "source": "local-map"}


def get_policy(procedure: str) -> dict[str, Any]:
    from agent import retrieve

    return retrieve.retrieve_policy(procedure).model_dump(by_alias=True)


# --- Claude Agent SDK tool wrappers ------------------------------------------


def build_sdk_server():
    """Create the in-process MCP server exposing the three tools to the agent."""
    from claude_agent_sdk import tool, create_sdk_mcp_server

    def _text(obj: Any) -> dict[str, Any]:
        return {"content": [{"type": "text", "text": json.dumps(obj, default=str)}]}

    @tool("get_patient_field", "Get a patient data field by dotted path (e.g. labs.spo2, meds.insulin, diagnoses.diabetes, encounters.class, foot_conditions.ulcer). Returns {present, value}.", {"path": str})
    async def _get_patient_field(args: dict[str, Any]) -> dict[str, Any]:
        result = get_patient_field(args["path"])
        if _TRACER is not None:
            _TRACER.tool_call("get_patient_field", {"path": args["path"]})
            _TRACER.tool_result("get_patient_field", result)
        return _text(result)

    @tool("lookup_icd10", "Look up an ICD-10 code's description.", {"code": str})
    async def _lookup_icd10(args: dict[str, Any]) -> dict[str, Any]:
        result = lookup_icd10(args["code"])
        if _TRACER is not None:
            _TRACER.tool_call("lookup_icd10", {"code": args["code"]})
            _TRACER.tool_result("lookup_icd10", result)
        return _text(result)

    @tool("get_policy", "Retrieve a decomposed policy by procedure name.", {"procedure": str})
    async def _get_policy(args: dict[str, Any]) -> dict[str, Any]:
        result = get_policy(args["procedure"])
        if _TRACER is not None:
            _TRACER.tool_call("get_policy", {"procedure": args["procedure"]})
            _TRACER.tool_result("get_policy", {"procedure": result.get("procedure"),
                                               "criteria": len(result.get("criteria", []))})
        return _text(result)

    return create_sdk_mcp_server(name="gl", version="1.0.0",
                                 tools=[_get_patient_field, _lookup_icd10, _get_policy])
