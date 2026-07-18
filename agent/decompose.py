"""Policy text → criteria (Criterion schema), with a deterministic validator.

Pipeline:
1. One LLM call (temperature 0) converts raw policy text into a list of
   Criterion objects.
2. A **deterministic** validator (no LLM) enforces the hard invariants:
   - every `quote` is a verbatim substring of the policy text,
   - every `needs[]` entry is rooted at a known PatientContext field,
   - every `threshold.op` is a recognized comparison operator,
   - if there are zero hard criteria, the whole policy is flagged.
   Anything ambiguous or unquotable is emitted with confidence: low.
3. A short critic pass (second LLM call) lists any requirement present in the
   text but missing from the criteria, and any criterion the text does not
   support.

The LLM steps need ANTHROPIC_API_KEY; the validator is pure and always runs.
`claude-sonnet-4-5` is used for the LLM steps because it accepts
``temperature=0`` (the Opus 4.7+/Sonnet 5 family rejects sampling params).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Optional

from api.models import Criterion, Threshold

# Model that still honors temperature=0 (deterministic extraction).
DECOMPOSE_MODEL = "claude-sonnet-4-5"

# Roots that a Criterion.needs entry may reference (PatientContext fields).
KNOWN_FIELDS: frozenset[str] = frozenset(
    {
        "demographics",
        "diagnoses",
        "labs",
        "meds",
        "prior_treatments",
        "symptoms",
        "foot_conditions",
        "encounters",
        "source_spans",
    }
)

VALID_OPS: frozenset[str] = frozenset({"<=", ">=", "<", ">", "==", "!=", "="})

LOW_CONFIDENCE = 0.3
AMBIGUOUS_BELOW = 0.5


@dataclass
class ValidationReport:
    ok: bool
    policy_flagged: bool
    criteria: list[Criterion]
    issues: list[str] = field(default_factory=list)
    ambiguous_ids: list[str] = field(default_factory=list)


def _norm_ws(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _root(need: str) -> str:
    return need.split(".", 1)[0].strip()


def validate_criteria(criteria: list[Criterion], policy_text: str) -> ValidationReport:
    """Deterministically enforce the hard invariants. Never calls an LLM.

    Returns adjusted criteria: unquotable / ambiguous criteria are downgraded to
    confidence: low rather than dropped, so the reviewer sees them flagged.
    """
    haystack = _norm_ws(policy_text)
    adjusted: list[Criterion] = []
    issues: list[str] = []
    ambiguous: list[str] = []
    hard_count = 0

    for crit in criteria:
        c = crit.model_copy(deep=True)

        # 1. quote must be a verbatim substring of the policy text.
        if not c.quote or _norm_ws(c.quote) not in haystack:
            issues.append(f"{c.id}: quote is not a verbatim substring of the policy text")
            c.confidence = min(c.confidence, LOW_CONFIDENCE)

        # 2. needs[] must be rooted at a known PatientContext field.
        for need in c.needs:
            if _root(need) not in KNOWN_FIELDS:
                issues.append(f"{c.id}: need '{need}' is not a known PatientContext field")
                c.confidence = min(c.confidence, LOW_CONFIDENCE)

        # 3. threshold operator must be recognized (value already parsed by pydantic).
        if c.threshold is not None and c.threshold.op not in VALID_OPS:
            issues.append(f"{c.id}: threshold op '{c.threshold.op}' is not a recognized operator")
            c.confidence = min(c.confidence, LOW_CONFIDENCE)

        if c.type == "hard":
            hard_count += 1
        if c.confidence < AMBIGUOUS_BELOW:
            ambiguous.append(c.id)

        adjusted.append(c)

    # 4. zero hard criteria → flag the whole policy.
    policy_flagged = hard_count == 0
    if policy_flagged:
        issues.append("policy has zero hard criteria — flagged for human review")

    return ValidationReport(
        ok=not policy_flagged,
        policy_flagged=policy_flagged,
        criteria=adjusted,
        issues=issues,
        ambiguous_ids=ambiguous,
    )


# --- LLM steps (need ANTHROPIC_API_KEY) --------------------------------------

_DECOMPOSE_SYSTEM = """You convert a payer coverage policy into a list of
machine-checkable criteria. Output ONE JSON array and nothing else.

Each element must match exactly:
{
  "id": "<snake_case>",
  "text": "<plain-language restatement>",
  "quote": "<VERBATIM substring of the policy text — copy exactly, no paraphrase>",
  "clause_ref": "<section/citation>",
  "type": "hard" | "soft",
  "logic": "all_of" | "any_of",
  "needs": ["<PatientContext field: demographics|diagnoses|labs|meds|prior_treatments|symptoms|foot_conditions|encounters>"],
  "threshold": {"op": "<= | >= | < | > | == | !=", "value": <number>, "unit": "<unit>"} | null,
  "context_conditions": ["<machine token, e.g. at_rest, room_air, chronic_stable>"],
  "confidence": <0..1>
}

Rules:
- `quote` MUST be copied verbatim from the policy text. If you cannot quote a
  requirement exactly, still emit it but set confidence <= 0.3.
- `needs` entries must be rooted at the PatientContext fields listed above.
- Encode MEASUREMENT CONTEXT in context_conditions. For oxygen/blood-gas
  thresholds, include the conditions under which the measurement must be taken
  (e.g. at_rest, room_air, chronic_stable). Do not drop them.
- When a requirement is satisfied by ANY of several alternatives, use
  logic "any_of" and list each alternative as a token in context_conditions.
- Anything ambiguous → confidence <= 0.3."""

_CRITIC_SYSTEM = """You audit a set of extracted criteria against the original
policy text. Output ONE JSON object and nothing else:
{
  "missing": ["<requirement present in the policy text but absent from the criteria>"],
  "unsupported": ["<criterion id that the policy text does not actually support>"]
}
Be terse and specific. Empty arrays if none."""


def decompose_policy(
    policy_text: str, *, procedure: Optional[str] = None, model: str = DECOMPOSE_MODEL
) -> ValidationReport:
    """LLM-extract criteria from policy text (temperature 0), then validate."""
    import anthropic

    client = anthropic.Anthropic()
    user = f"Policy{f' for {procedure}' if procedure else ''}:\n\n{policy_text}\n\nReturn the JSON array."
    resp = client.messages.create(
        model=model,
        max_tokens=4096,
        temperature=0,
        system=_DECOMPOSE_SYSTEM,
        messages=[{"role": "user", "content": user}],
    )
    text = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")
    raw = _extract_json_array(text)
    criteria = [Criterion.model_validate(item) for item in raw]
    return validate_criteria(criteria, policy_text)


def critic(policy_text: str, criteria: list[Criterion], *, model: str = DECOMPOSE_MODEL) -> dict[str, list[str]]:
    """Second pass: list requirements missing from the criteria / unsupported criteria."""
    import anthropic

    client = anthropic.Anthropic()
    payload = json.dumps([c.model_dump(by_alias=True) for c in criteria], indent=2)
    user = f"Policy text:\n\n{policy_text}\n\nExtracted criteria:\n\n{payload}\n\nReturn the JSON audit object."
    resp = client.messages.create(
        model=model,
        max_tokens=2048,
        temperature=0,
        system=_CRITIC_SYSTEM,
        messages=[{"role": "user", "content": user}],
    )
    text = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")
    obj = _extract_json_object(text)
    return {"missing": obj.get("missing", []), "unsupported": obj.get("unsupported", [])}


def _extract_json_array(text: str) -> list[Any]:
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.IGNORECASE).strip()
    try:
        value = json.loads(cleaned)
    except json.JSONDecodeError:
        start, end = cleaned.find("["), cleaned.rfind("]")
        if start < 0 or end <= start:
            raise ValueError("no JSON array in decompose output")
        value = json.loads(cleaned[start : end + 1])
    if not isinstance(value, list):
        raise ValueError("decompose output was not a JSON array")
    return value


def _extract_json_object(text: str) -> dict[str, Any]:
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.IGNORECASE).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("no JSON object in critic output")
        return json.loads(cleaned[start : end + 1])
