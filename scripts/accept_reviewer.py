"""Acceptance run for the reviewer (agent/reviewer.py).

Runs three patients against their policies, prints per-criterion results with
evidence, then prints one case's full TraceEvent log. Asserts the three key
outcomes.

    python scripts/accept_reviewer.py            # oxygen case uses the Agent SDK
    python scripts/accept_reviewer.py --no-agent # deterministic only (fast)
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from adapters import fhir_adapter
from agent import retrieve, reviewer
from agent.trace import Tracer

JSONL = "data/patients/synthetic-ambient-fhir-25.jsonl"
USE_AGENT = "--no-agent" not in sys.argv


def load_patient(spec: str):
    if spec == "oxygen":
        return fhir_adapter.parse_obj(fhir_adapter.find_abridge_record(JSONL, fhir_adapter.HERO_ENCOUNTER_TITLE))
    return fhir_adapter.parse(spec)


CASES = [
    ("OXYGEN  (acute inpatient hypoxemia)", "oxygen", "home_oxygen", USE_AGENT),
    ("CGM     (insulin diabetic)", "data/patients/synthea-cgm-insulin.json", "cgm", USE_AGENT),
    ("FOOTWEAR(diabetic + foot ulcer)", "data/patients/synthea-footwear-ulcer.json", "therapeutic_footwear", USE_AGENT),
]


def fmt_ev(v):
    s = str(v)
    return s if len(s) <= 48 else s[:45] + "…"


def main() -> int:
    saved = {}
    verdicts = {}
    for label, pspec, procedure, use_agent in CASES:
        patient = load_patient(pspec)
        policy = retrieve.retrieve_policy(procedure)
        tracer = Tracer()
        results = reviewer.review(patient, policy, tracer, use_agent=use_agent)
        saved[procedure] = (results, tracer)
        verdicts.update({r.id: r.verdict for r in results})

        agent_tag = " [sonnet-4-5 · temp 0]" if use_agent else ""
        print(f"\n══ {label} → policy {procedure}{agent_tag} ══")
        for r in results:
            ev = f"{r.patient_evidence.path}={fmt_ev(r.patient_evidence.value)}"
            print(f"  {r.verdict.upper():8}  {r.id}")
            print(f"           evidence: {ev}")
            print(f"           {r.reasoning[:110]}")

    # --- one case's full event log ---
    print("\n" + "═" * 68)
    print("FULL EVENT LOG — oxygen case")
    print("═" * 68)
    _, tracer = saved["home_oxygen"]
    for e in tracer.events:
        payload = {k: fmt_ev(v) for k, v in e.payload.items()}
        print(f"  #{e.seq:<2} [{e.phase:<8}] {e.type:<18} {e.label}")
        if payload:
            print(f"        {payload}")

    # --- acceptance assertions ---
    print("\n" + "═" * 68)
    checks = [
        ("oxygen SaO2 numeric passes but context forces not_met",
         verdicts.get("oxygen_qualifying_hypoxemia") == "not_met"),
        ("insulin use is met",
         verdicts.get("cgm_insulin_treated") == "met"),
        ("footwear any_of (ulcer) is met",
         verdicts.get("footwear_qualifying_foot_condition") == "met"),
    ]
    ok = True
    for desc, passed in checks:
        print(f"  {'PASS' if passed else 'FAIL'}  {desc}")
        ok = ok and passed
    print("═" * 68)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
