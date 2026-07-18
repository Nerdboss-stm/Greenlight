"""Ambient transcript → PatientContext (LLM extraction).

The Abridge-modality beat: parse a clinician–patient conversation transcript
into the *same* PatientContext contract the deterministic FHIR adapter produces.
This is the one place an LLM touches patient parsing; the engine downstream
still treats the result as ordinary structured input.

We validate the model's JSON against the Pydantic contract rather than using the
API's structured-output mode — PatientContext.source_spans is an open string map,
which the strict structured-output schema validator rejects.
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional

from api.models import PatientContext

DEFAULT_MODEL = "claude-opus-4-8"

_SYSTEM = """You are a clinical information extractor. Read an ambient
clinician–patient visit transcript and extract ONLY facts stated in it into a
strict JSON object. This is deterministic extraction, not diagnosis.

Rules:
- Extract only what the transcript supports. Never infer, guess, or add codes
  that were not spoken. Absent information → empty list / empty string.
- Output ONE JSON object and nothing else. No prose, no code fences.

Shape (all keys required; use [] or "" when unknown):
{
  "demographics": {"age": <int>, "sex": "male|female|other|unknown"},
  "diagnoses": [{"icd10": "<code or ''>", "display": "<condition>"}],
  "labs": [{"code": "<loinc or ''>", "display": "<name>", "value": <number|string>, "unit": "<unit or ''>", "date": "<ISO or ''>"}],
  "meds": [{"name": "<drug>", "rxnorm": "<code or ''>"}],
  "prior_treatments": ["<free text>"],
  "symptoms": ["<free text>"],
  "foot_conditions": [{"icd10": "<code or ''>", "display": "<foot condition>"}],
  "encounters": [{"class": "<AMB|IMP|EMER or ''>", "date": "<ISO or ''>", "reason": "<text, optional>"}],
  "source_spans": {}
}

Put diabetic foot ulcers, neuropathy of the foot, amputations, calluses, and
foot deformities in foot_conditions, not diagnoses. Leave source_spans as {}."""


def parse_transcript(transcript: str, *, model: str = DEFAULT_MODEL) -> PatientContext:
    """Extract a PatientContext from a visit transcript using Claude."""
    if not transcript or not transcript.strip():
        raise ValueError("empty transcript")

    try:
        import anthropic
    except ImportError as e:  # pragma: no cover
        raise RuntimeError("anthropic SDK not installed") from e

    client = anthropic.Anthropic()
    response = client.messages.create(
        model=model,
        max_tokens=4096,
        system=_SYSTEM,
        messages=[
            {
                "role": "user",
                "content": f"Transcript:\n\n{transcript}\n\nReturn the JSON object.",
            }
        ],
    )

    text = "".join(block.text for block in response.content if getattr(block, "type", None) == "text")
    data = _extract_json(text)
    ctx = PatientContext.model_validate(data)
    return _mark_transcript_provenance(ctx)


def parse(record: dict[str, Any]) -> PatientContext:
    """Parse an Abridge record's ambient transcript into a PatientContext."""
    transcript = record.get("transcript")
    if not isinstance(transcript, str):
        raise ValueError("record has no transcript string")
    return parse_transcript(transcript)


def _extract_json(text: str) -> dict[str, Any]:
    """Pull the JSON object out of the model's reply, fences or not."""
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start >= 0 and end > start:
        return json.loads(cleaned[start : end + 1])
    raise ValueError("model did not return parseable JSON")


def _mark_transcript_provenance(ctx: PatientContext) -> PatientContext:
    """Stamp source_spans so every populated field points at the transcript."""
    spans: dict[str, str] = {
        "demographics.age": "transcript",
        "demographics.sex": "transcript",
    }
    for field_name in (
        "diagnoses",
        "labs",
        "meds",
        "prior_treatments",
        "symptoms",
        "foot_conditions",
        "encounters",
    ):
        if getattr(ctx, field_name):
            spans[field_name] = "transcript"
    ctx.source_spans = spans
    return ctx
