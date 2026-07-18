"""FHIR R4 → PatientContext (pure parsing, NO LLM).

Handles two input shapes, both mapped into the exact PatientContext contract
(see docs/CONTRACT.md):

1. A standard FHIR R4 **Bundle** (`resourceType: "Bundle"`, `entry[].resource`)
   — how the two Synthea demo bundles are shaped.
2. The Abridge **ambient encounter record** — `patient_context.patient` plus
   `encounter_fhir.encounter` and `encounter_fhir.related_resources` grouped by
   resource type (Condition / Observation / MedicationRequest / Procedure /
   DiagnosticReport). Not a flat Bundle.entry[], so it gets a thin walker.

Every populated field records where it came from in `source_spans`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Optional, Union

from api.models import (
    Demographics,
    Diagnosis,
    Encounter,
    FootCondition,
    Lab,
    Med,
    PatientContext,
)

# Hero over-approval trap: acute inpatient hypoxemia that looks like a Home
# Oxygen qualifier but is an ACUTE inpatient stay, not chronic stable disease.
HERO_ENCOUNTER_TITLE = "Inpatient admission — COVID-19 isolation with pneumonia and hypoxemia"

# Canonical FHIR system URIs.
ICD10_SYSTEMS = (
    "http://hl7.org/fhir/sid/icd-10-cm",
    "http://hl7.org/fhir/sid/icd-10",
)
LOINC_SYSTEM = "http://loinc.org"
RXNORM_SYSTEM = "http://www.nlm.nih.gov/research/umls/rxnorm"

# Keywords that route a Condition into foot_conditions instead of diagnoses.
_FOOT_KEYWORDS = (
    "foot",
    "feet",
    "ulcer",
    "neuropath",
    "amputation",
    "callus",
    "charcot",
    "plantar",
    "toe",
    "hallux",
    "diabetic foot",
)


@dataclass
class _Origin:
    """Where each field group came from, for source_spans."""

    birth: str
    gender: str
    conditions: str
    observations: str
    meds: str
    encounter: str
    procedures: str


# --- public API --------------------------------------------------------------


def parse(bundle_path: str) -> PatientContext:
    """Parse a FHIR bundle *or* Abridge record file into a PatientContext."""
    with open(bundle_path, "r", encoding="utf-8") as fh:
        return parse_obj(json.load(fh))


def parse_obj(record: dict[str, Any]) -> PatientContext:
    """Parse an in-memory FHIR bundle or Abridge record into a PatientContext."""
    if "patient_context" in record or "encounter_fhir" in record:
        return _parse_abridge(record)
    if record.get("resourceType") == "Bundle":
        return _parse_bundle(record)
    # A bare Patient-centric object with related_resources also works.
    if "related_resources" in record and "patient" in record:
        return _parse_abridge({"patient_context": {"patient": record["patient"]},
                               "encounter_fhir": record})
    raise ValueError("unrecognized shape: expected a FHIR Bundle or an Abridge encounter record")


def find_abridge_record(jsonl_path: str, title: str) -> dict[str, Any]:
    """Load the Abridge record whose metadata.visit_title matches `title`."""
    with open(jsonl_path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            if rec.get("metadata", {}).get("visit_title") == title:
                return rec
    raise KeyError(f"no Abridge record with visit_title={title!r}")


# --- shape 1: Abridge encounter record ---------------------------------------


def _parse_abridge(record: dict[str, Any]) -> PatientContext:
    pc = record.get("patient_context", {}) or {}
    enc_fhir = record.get("encounter_fhir", {}) or {}
    patient = pc.get("patient", {}) or {}
    encounter = enc_fhir.get("encounter", {}) or {}
    grouped = enc_fhir.get("related_resources", {}) or {}
    longitudinal = pc.get("longitudinal_summary", {}) or {}

    ref_date = _reference_date(
        [encounter], record.get("metadata", {}).get("date")
    )
    origin = _Origin(
        birth="patient_context.patient.birthDate",
        gender="patient_context.patient.gender",
        conditions="encounter_fhir.related_resources.Condition",
        observations="encounter_fhir.related_resources.Observation",
        meds="patient_context.longitudinal_summary.medication_labels",
        encounter="encounter_fhir.encounter",
        procedures="encounter_fhir.related_resources.Procedure",
    )
    return _build(
        patient=patient,
        encounters=[encounter] if encounter else [],
        conditions=grouped.get("Condition", []) or [],
        observations=grouped.get("Observation", []) or [],
        med_requests=grouped.get("MedicationRequest", []) or [],
        procedures=grouped.get("Procedure", []) or [],
        med_labels=longitudinal.get("medication_labels") or [],
        ref_date=ref_date,
        origin=origin,
    )


# --- shape 2: standard FHIR Bundle -------------------------------------------


def _parse_bundle(bundle: dict[str, Any]) -> PatientContext:
    by_type: dict[str, list[dict[str, Any]]] = {}
    for entry in bundle.get("entry", []) or []:
        resource = entry.get("resource") or {}
        rtype = resource.get("resourceType")
        if rtype:
            by_type.setdefault(rtype, []).append(resource)

    patients = by_type.get("Patient", [])
    patient = patients[0] if patients else {}
    encounters = by_type.get("Encounter", [])
    ref_date = _reference_date(encounters, None)

    origin = _Origin(
        birth="Bundle.entry[Patient].birthDate",
        gender="Bundle.entry[Patient].gender",
        conditions="Bundle.entry[Condition]",
        observations="Bundle.entry[Observation]",
        meds="Bundle.entry[MedicationRequest]",
        encounter="Bundle.entry[Encounter]",
        procedures="Bundle.entry[Procedure]",
    )
    return _build(
        patient=patient,
        encounters=encounters,
        conditions=by_type.get("Condition", []),
        observations=by_type.get("Observation", []),
        med_requests=by_type.get("MedicationRequest", []),
        procedures=by_type.get("Procedure", []),
        med_labels=[],
        ref_date=ref_date,
        origin=origin,
    )


# --- shared builder ----------------------------------------------------------


def _build(
    *,
    patient: dict[str, Any],
    encounters: list[dict[str, Any]],
    conditions: list[dict[str, Any]],
    observations: list[dict[str, Any]],
    med_requests: list[dict[str, Any]],
    procedures: list[dict[str, Any]],
    med_labels: list[str],
    ref_date: date,
    origin: _Origin,
) -> PatientContext:
    demographics = _demographics(patient, ref_date)

    diagnoses: list[Diagnosis] = []
    foot_conditions: list[FootCondition] = []
    for cond in conditions:
        icd10, display = _coded(cond.get("code"))
        if not display:
            continue
        if _is_foot(display, cond.get("code")):
            foot_conditions.append(FootCondition(icd10=icd10, display=display))
        else:
            diagnoses.append(Diagnosis(icd10=icd10, display=display))

    labs = _labs(observations)
    meds = _meds(med_requests, med_labels)
    enc_out = _encounters(encounters)
    prior_treatments = _procedures(procedures)

    source_spans: dict[str, str] = {
        "demographics.age": origin.birth,
        "demographics.sex": origin.gender,
    }
    if diagnoses:
        source_spans["diagnoses"] = origin.conditions
    if foot_conditions:
        source_spans["foot_conditions"] = origin.conditions
    if labs:
        source_spans["labs"] = origin.observations
    if meds:
        source_spans["meds"] = origin.meds
    if enc_out:
        source_spans["encounters"] = origin.encounter
    if prior_treatments:
        source_spans["prior_treatments"] = origin.procedures

    return PatientContext(
        demographics=demographics,
        diagnoses=diagnoses,
        labs=labs,
        meds=meds,
        prior_treatments=prior_treatments,
        symptoms=[],  # not derivable from structured FHIR; see doc_adapter (transcript)
        foot_conditions=foot_conditions,
        encounters=enc_out,
        source_spans=source_spans,
    )


# --- field mappers -----------------------------------------------------------


def _demographics(patient: dict[str, Any], ref_date: date) -> Demographics:
    gender = patient.get("gender")
    sex = gender if gender in ("male", "female", "other", "unknown") else "unknown"
    age = _age(patient.get("birthDate"), ref_date)
    return Demographics(age=age, sex=sex)  # type: ignore[arg-type]


def _labs(observations: list[dict[str, Any]]) -> list[Lab]:
    out: list[Lab] = []
    for obs in observations:
        when = _effective(obs)
        # Panels (hasMember) carry no value themselves; skip the wrapper.
        if "hasMember" in obs and "valueQuantity" not in obs and "component" not in obs:
            continue
        if "valueQuantity" in obs:
            lab = _lab_from(obs.get("code"), obs["valueQuantity"], when)
            if lab:
                out.append(lab)
        elif "valueString" in obs:
            code, display = _coded(obs.get("code"))
            out.append(Lab(code=code, display=display, value=str(obs["valueString"]), unit="", date=when))
        for comp in obs.get("component", []) or []:
            if "valueQuantity" in comp:
                lab = _lab_from(comp.get("code"), comp["valueQuantity"], when)
                if lab:
                    out.append(lab)
    return out


def _lab_from(code_cc: Optional[dict[str, Any]], vq: dict[str, Any], when: str) -> Optional[Lab]:
    code, display = _coded(code_cc, prefer_system=LOINC_SYSTEM)
    if not display and not code:
        return None
    value = vq.get("value")
    if value is None:
        return None
    return Lab(
        code=code,
        display=display or code,
        value=value,
        unit=vq.get("unit") or vq.get("code") or "",
        date=when,
    )


def _meds(med_requests: list[dict[str, Any]], med_labels: list[str]) -> list[Med]:
    out: list[Med] = []
    for mr in med_requests:
        cc = mr.get("medicationCodeableConcept")
        if not cc:
            continue  # medicationReference-only requests can't be resolved here
        rxnorm, display = _coded(cc, prefer_system=RXNORM_SYSTEM)
        if display or rxnorm:
            out.append(Med(name=display or rxnorm, rxnorm=rxnorm if _has_system(cc, RXNORM_SYSTEM) else ""))
    # Fall back to chart medication labels (Abridge requests are reference-only).
    if not out and med_labels:
        for label in med_labels:
            out.append(Med(name=str(label), rxnorm=""))
    return out


def _encounters(encounters: list[dict[str, Any]]) -> list[Encounter]:
    out: list[Encounter] = []
    for enc in encounters:
        klass = enc.get("class")
        # R4: class is a single Coding; be tolerant of an R5-style list.
        if isinstance(klass, list):
            klass = klass[0] if klass else {}
        class_code = ""
        if isinstance(klass, dict):
            class_code = klass.get("code") or (klass.get("coding", [{}])[0].get("code") if klass.get("coding") else "") or ""
        period = enc.get("period") or {}
        when = period.get("start") or period.get("end") or ""
        reason = _encounter_reason(enc)
        out.append(Encounter(**{"class": class_code, "date": when, "reason": reason}))
    return out


def _encounter_reason(enc: dict[str, Any]) -> Optional[str]:
    for tp in enc.get("type", []) or []:
        text = tp.get("text") or _first_display(tp.get("coding"))
        if text:
            return text
    for rc in enc.get("reasonCode", []) or []:
        text = rc.get("text") or _first_display(rc.get("coding"))
        if text:
            return text
    return None


def _procedures(procedures: list[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for proc in procedures:
        _, display = _coded(proc.get("code"))
        if display and display not in seen:
            seen.add(display)
            out.append(display)
    return out


# --- coding / date helpers ---------------------------------------------------


def _coded(cc: Optional[dict[str, Any]], prefer_system: Optional[str] = None) -> tuple[str, str]:
    """Return (code, display) from a CodeableConcept.

    ICD-10 coding wins for `code` when present; otherwise a preferred system, then
    the first coding. `display` prefers CodeableConcept.text.
    """
    if not cc:
        return "", ""
    codings = cc.get("coding", []) or []
    text = cc.get("text")

    icd = next((c for c in codings if c.get("system") in ICD10_SYSTEMS), None)
    if icd:
        return icd.get("code", ""), text or icd.get("display", "") or ""
    if prefer_system:
        pref = next((c for c in codings if c.get("system") == prefer_system), None)
        if pref:
            return pref.get("code", ""), text or pref.get("display", "") or ""
    if codings:
        first = codings[0]
        return first.get("code", ""), text or first.get("display", "") or ""
    return "", text or ""


def _has_system(cc: dict[str, Any], system: str) -> bool:
    return any(c.get("system") == system for c in cc.get("coding", []) or [])


def _first_display(codings: Optional[list[dict[str, Any]]]) -> str:
    for c in codings or []:
        if c.get("display"):
            return c["display"]
    return ""


def _is_foot(display: str, code_cc: Optional[dict[str, Any]]) -> bool:
    haystack = display.lower()
    for c in (code_cc or {}).get("coding", []) or []:
        haystack += " " + (c.get("display") or "").lower()
    return any(kw in haystack for kw in _FOOT_KEYWORDS)


def _effective(obs: dict[str, Any]) -> str:
    if obs.get("effectiveDateTime"):
        return obs["effectiveDateTime"]
    period = obs.get("effectivePeriod") or {}
    return period.get("start") or period.get("end") or obs.get("issued") or ""


def _reference_date(encounters: list[dict[str, Any]], meta_date: Optional[str]) -> date:
    for enc in encounters:
        start = (enc.get("period") or {}).get("start")
        if start:
            parsed = _parse_date(start)
            if parsed:
                return parsed
    if meta_date:
        parsed = _parse_date(meta_date)
        if parsed:
            return parsed
    return date.today()


def _parse_date(value: str) -> Optional[date]:
    if not value:
        return None
    text = value.strip()
    # Accept 'YYYY-MM-DD', full ISO datetimes, and trailing 'Z'.
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
    except ValueError:
        pass
    try:
        return datetime.strptime(text[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def _age(birth_date: Optional[str], ref: date) -> int:
    born = _parse_date(birth_date or "")
    if not born:
        return 0
    years = ref.year - born.year - ((ref.month, ref.day) < (born.month, born.day))
    return max(years, 0)
