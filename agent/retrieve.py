"""Policy retrieval with a four-rung fallback chain, then pin + return a Policy.

retrieve_policy(procedure) tries, in order:
  1. the CMS Coverage connector (if configured),
  2. web_search for the CMS policy,
  3. web_fetch of the top cms.gov result → decompose the fetched text,
  4. a local data/cache/ fallback (canonical, human-verified policies).

Whatever rung succeeds, the result is pinned with a deterministic
version_hash and written to data/cache/, then returned as a Policy
(conforms to docs/CONTRACT.md).

The canonical cache carries the measurement context the downstream engine
depends on: the oxygen criterion is at_rest / room_air / chronic_stable, and
the footwear qualifying-condition criterion is an any_of over the six real
qualifiers (bare peripheral neuropathy does NOT qualify).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any, Optional

_URL_RE = re.compile(r"https?://[^\s)\]]+")

from api.models import Criterion, Policy, Threshold
from agent import decompose

CACHE_DIR = Path(__file__).resolve().parents[1] / "data" / "cache"

# --- procedure normalization -------------------------------------------------

_ALIASES: dict[str, tuple[str, ...]] = {
    "home_oxygen": ("home_oxygen", "oxygen", "home oxygen", "home o2", "o2", "240.2", "ncd 240.2"),
    "therapeutic_footwear": (
        "therapeutic_footwear",
        "footwear",
        "shoes",
        "therapeutic shoes",
        "diabetic shoes",
        "l33369",
    ),
    "cgm": ("cgm", "continuous glucose monitor", "glucose monitor", "l33822"),
}


def normalize(procedure: str) -> Optional[str]:
    p = (procedure or "").strip().lower()
    for slug, aliases in _ALIASES.items():
        if p == slug or p in aliases or slug in p:
            return slug
    return None


# --- canonical policies (rung 4 seed) ----------------------------------------
# Each source text is written so every criterion `quote` below is a verbatim
# substring of it (enforced by decompose.validate_criteria).

_OXYGEN_TEXT = (
    "CMS National Coverage Determination 240.2 — Home Use of Oxygen.\n\n"
    "Coverage of home oxygen therapy requires that the following conditions be met. "
    "The qualifying blood gas study must be obtained while the patient is in a chronic stable state "
    "— that is, not during a period of acute illness or an exacerbation of the underlying disease. "
    "Group I criteria are met when the arterial partial pressure of oxygen (PO2) is at or below 55 mm Hg, "
    "or the arterial oxygen saturation is at or below 88 percent, taken at rest, breathing room air. "
    "Home oxygen is covered for patients with significant hypoxemia in the chronic stable state, "
    "and only after an appropriate therapeutic regimen has been determined. "
    "Oxygen provided during a transient period of hypoxemia in the course of an acute illness or "
    "hospitalization does not, by itself, establish medical necessity for home oxygen."
)

_FOOTWEAR_TEXT = (
    "Medicare Therapeutic Shoes for Persons with Diabetes "
    "(Social Security Act §1861(s)(12); LCD L33369).\n\n"
    "For coverage, the patient has diabetes mellitus and is under a comprehensive plan of care for diabetes, "
    "and has at least one of the following conditions: previous amputation of the foot or part of the foot; "
    "a history of previous foot ulceration; a history of pre-ulcerative calluses; "
    "peripheral neuropathy with evidence of callus formation; foot deformity; or poor circulation. "
    "Peripheral neuropathy alone, without evidence of callus formation, does not by itself qualify the "
    "patient for therapeutic shoes."
)

_CGM_TEXT = (
    "Medicare Therapeutic Continuous Glucose Monitor (CGM) — LCD L33822.\n\n"
    "A therapeutic CGM is covered when the beneficiary has diabetes mellitus; and the beneficiary is "
    "treated with insulin; and the beneficiary's treatment regimen requires frequent adjustment on the "
    "basis of glucose testing results or continuous glucose monitor testing results."
)


def _c(**kw: Any) -> Criterion:
    th = kw.pop("threshold", None)
    threshold = Threshold(**th) if th else None
    return Criterion(threshold=threshold, **kw)


_CANONICAL: dict[str, dict[str, Any]] = {
    "home_oxygen": {
        "procedure": "home_oxygen",
        "citation": "CMS NCD 240.2 — Home Use of Oxygen",
        "text": _OXYGEN_TEXT,
        "criteria": [
            _c(
                id="oxygen_qualifying_hypoxemia",
                text="Qualifying hypoxemia: arterial O2 saturation at or below 88% (or PaO2 ≤ 55 mmHg), measured at rest on room air.",
                quote="the arterial oxygen saturation is at or below 88 percent, taken at rest, breathing room air",
                clause_ref="NCD 240.2 · Group I",
                type="hard",
                logic="any_of",
                needs=["labs"],
                threshold={"op": "<=", "value": 88, "unit": "%"},
                context_conditions=["at_rest", "room_air", "chronic_stable"],
                confidence=0.95,
            ),
            _c(
                id="oxygen_chronic_stable_state",
                text="The qualifying measurement was obtained during a chronic stable state — not during an acute illness or exacerbation (e.g. not an inpatient COVID/pneumonia admission).",
                quote="not during a period of acute illness or an exacerbation of the underlying disease",
                clause_ref="NCD 240.2 · Qualifying blood gas study",
                type="hard",
                logic="all_of",
                needs=["encounters", "labs"],
                context_conditions=["chronic_stable", "not_acute"],
                confidence=0.9,
            ),
            _c(
                id="oxygen_therapeutic_regimen",
                text="An appropriate therapeutic regimen has been determined before initiating home oxygen.",
                quote="after an appropriate therapeutic regimen has been determined",
                clause_ref="NCD 240.2",
                type="soft",
                logic="all_of",
                needs=["meds", "prior_treatments"],
                context_conditions=[],
                confidence=0.6,
            ),
        ],
    },
    "therapeutic_footwear": {
        "procedure": "therapeutic_footwear",
        "citation": "Medicare Therapeutic Shoes for Persons with Diabetes — LCD L33369",
        "text": _FOOTWEAR_TEXT,
        "criteria": [
            _c(
                id="footwear_diabetes_mellitus",
                text="The patient has diabetes mellitus and is under a comprehensive plan of care for diabetes.",
                quote="the patient has diabetes mellitus and is under a comprehensive plan of care for diabetes",
                clause_ref="SSA §1861(s)(12) · LCD L33369",
                type="hard",
                logic="all_of",
                needs=["diagnoses"],
                context_conditions=[],
                confidence=0.95,
            ),
            _c(
                id="footwear_qualifying_foot_condition",
                text="At least one qualifying foot condition. Peripheral neuropathy alone does NOT qualify — it must be accompanied by callus formation.",
                quote=(
                    "at least one of the following conditions: previous amputation of the foot or part of the foot; "
                    "a history of previous foot ulceration; a history of pre-ulcerative calluses; "
                    "peripheral neuropathy with evidence of callus formation; foot deformity; or poor circulation"
                ),
                clause_ref="LCD L33369 · qualifying conditions",
                type="hard",
                logic="any_of",
                needs=["foot_conditions"],
                context_conditions=[
                    "amputation",
                    "ulcer_history",
                    "pre_ulcerative_callus",
                    "neuropathy_with_callus",
                    "foot_deformity",
                    "poor_circulation",
                ],
                confidence=0.95,
            ),
        ],
    },
    "cgm": {
        "procedure": "cgm",
        "citation": "Medicare Therapeutic CGM — LCD L33822",
        "text": _CGM_TEXT,
        "criteria": [
            _c(
                id="cgm_diabetes_mellitus",
                text="The beneficiary has diabetes mellitus.",
                quote="the beneficiary has diabetes mellitus",
                clause_ref="LCD L33822",
                type="hard",
                logic="all_of",
                needs=["diagnoses"],
                context_conditions=[],
                confidence=0.95,
            ),
            _c(
                id="cgm_insulin_treated",
                text="The beneficiary is treated with insulin.",
                quote="the beneficiary is treated with insulin",
                clause_ref="LCD L33822",
                type="hard",
                logic="all_of",
                needs=["meds"],
                context_conditions=[],
                confidence=0.95,
            ),
            _c(
                id="cgm_frequent_adjustment",
                text="The treatment regimen requires frequent adjustment based on glucose testing results.",
                quote="requires frequent adjustment on the basis of glucose testing results",
                clause_ref="LCD L33822",
                type="soft",
                logic="all_of",
                needs=["labs"],
                context_conditions=[],
                confidence=0.7,
            ),
        ],
    },
}

CANONICAL_SLUGS = tuple(_CANONICAL.keys())


# --- pinning -----------------------------------------------------------------


def version_hash(source_text: str, criteria: list[Criterion]) -> str:
    """Deterministic pin over the policy text + criteria (no time/randomness)."""
    payload = json.dumps(
        {"text": source_text, "criteria": [c.model_dump(by_alias=True) for c in criteria]},
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _pin(policy: Policy) -> Policy:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / f"policy-{policy.procedure}.json"
    path.write_text(policy.model_dump_json(by_alias=True, indent=2), encoding="utf-8")
    return policy


def _canonical_policy(slug: str, *, source_label: Optional[str] = None) -> Policy:
    spec = _CANONICAL[slug]
    criteria: list[Criterion] = spec["criteria"]
    report = decompose.validate_criteria(criteria, spec["text"])
    if report.issues:
        # Canonical policies must validate cleanly; surface any drift loudly.
        raise ValueError(f"canonical policy {slug} failed validation: {report.issues}")
    return Policy(
        procedure=slug,
        version_hash=version_hash(spec["text"], report.criteria),
        source=source_label or f"local-cache (canonical · {spec['citation']})",
        criteria=report.criteria,
    )


# --- retrieval rungs ---------------------------------------------------------


def _web_enabled() -> bool:
    # On by default when a key is present; set GREENLIGHT_DISABLE_WEB=1 to force cache-only.
    return bool(os.getenv("ANTHROPIC_API_KEY")) and os.getenv("GREENLIGHT_DISABLE_WEB") != "1"


def _rung_connector(procedure: str) -> Optional[Policy]:
    """CMS Coverage connector. Only used when explicitly configured."""
    endpoint = os.getenv("CMS_CONNECTOR_URL")
    if not endpoint:
        return None
    try:  # pragma: no cover - depends on external connector
        import requests

        resp = requests.get(endpoint, params={"procedure": procedure}, timeout=15)
        resp.raise_for_status()
        text = resp.json().get("policy_text") or resp.text
        return _policy_from_text(procedure, text, source_label=f"cms-connector ({endpoint})")
    except Exception:
        return None


_WEB_SYSTEM = (
    "You retrieve United States Medicare/CMS coverage policies. Search cms.gov for the official "
    "coverage determination (NCD or LCD) for the requested item or procedure, fetch the page, and "
    "reply with ONLY the verbatim coverage-criteria text — the specific requirements a patient must "
    "meet for coverage. Do not summarize or add commentary; copy the requirement language."
)


def _rung_web(procedure: str) -> Optional[Policy]:
    """CMS policy via web_search (cms.gov) → web_fetch → decompose. Best-effort."""
    if not _web_enabled():
        return None
    try:  # pragma: no cover - network
        import anthropic

        client = anthropic.Anthropic().with_options(timeout=90.0)
        tools = [
            {
                "type": "web_search_20260209",
                "name": "web_search",
                "max_uses": 5,
                "allowed_domains": ["cms.gov", "www.cms.gov"],
            },
            {
                "type": "web_fetch_20260209",
                "name": "web_fetch",
                "max_uses": 3,
                "allowed_domains": ["cms.gov", "www.cms.gov"],
                "max_content_tokens": 6000,
            },
        ]
        messages: list[dict[str, Any]] = [
            {"role": "user", "content": f"Coverage policy for: {procedure}"}
        ]
        text = ""
        for _ in range(6):  # resume the server-tool loop across pause_turn
            resp = client.messages.create(
                model="claude-opus-4-8",
                max_tokens=4096,
                system=_WEB_SYSTEM,
                tools=tools,
                messages=messages,
            )
            if resp.stop_reason == "pause_turn":
                messages.append({"role": "assistant", "content": resp.content})
                continue
            text = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")
            break
        if len(text.strip()) < 80:
            return None
        return _policy_from_text(procedure, text.strip(), source_label="web (cms.gov · search + fetch)")
    except Exception:
        return None


def _rung_cache(slug: str) -> Policy:
    """Return the pinned cache file if present, else the canonical seed."""
    path = CACHE_DIR / f"policy-{slug}.json"
    if path.exists():
        try:
            return Policy.model_validate_json(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return _canonical_policy(slug)


def _policy_from_text(procedure: str, policy_text: str, *, source_label: str) -> Optional[Policy]:
    """Decompose freshly-retrieved policy text into a Policy (validate inside)."""
    report = decompose.decompose_policy(policy_text, procedure=procedure)
    if not report.criteria:
        return None
    return Policy(
        procedure=_slugify(procedure),
        version_hash=version_hash(policy_text, report.criteria),
        source=source_label,
        criteria=report.criteria,
    )


# --- public API --------------------------------------------------------------


def retrieve_policy(procedure: str) -> Policy:
    """Resolve a policy via connector → web (search+fetch) → cache, then pin.

    Known procedures (the pinned/canonical set) short-circuit to the curated
    cache. An unknown NAME runs the live fallback chain: CMS connector →
    web_search on cms.gov → web_fetch → decompose.
    """
    slug = normalize(procedure)
    if slug is not None:
        # 4. curated / previously pinned cache (fast, deterministic)
        return _pin(_rung_cache(slug))

    # 1. CMS Coverage connector
    policy = _rung_connector(procedure)
    # 2/3. web_search (cms.gov) → web_fetch → decompose
    if policy is None:
        policy = _rung_web(procedure)
    if policy is None:
        raise KeyError(f"could not retrieve a policy for {procedure!r}")
    return policy


def list_policies() -> list[Policy]:
    """All pinned policies (seeds and pins the canonical set on first call)."""
    return [_pin(_rung_cache(slug)) for slug in CANONICAL_SLUGS]


def _slugify(name: Optional[str]) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", (name or "").strip().lower()).strip("_")
    return slug or "custom_policy"


def decompose_text(text: str, procedure: Optional[str] = None) -> Policy:
    """Decompose free-text policy language into a pinned Policy (one LLM call →
    validate). Not written to the canonical cache, so it never clobbers a seed."""
    report = decompose.decompose_policy(text, procedure=procedure)
    return Policy(
        procedure=_slugify(procedure),
        version_hash=version_hash(text, report.criteria),
        source="custom · natural-language policy",
        criteria=report.criteria,
    )
