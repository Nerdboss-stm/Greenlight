# GreenLight

Clinical prior-authorization agent plus an eval harness: two pages sharing one engine.

## Engine pipeline (per case)

1. **Parse** — patient record → `PatientContext`. Deterministic code, **no LLM**.
2. **Policy selection** — a clinician picks the policy; the engine never chooses it.
3. **Retrieve & decompose** — fetch the CMS policy (connector → web search → fetch → cache) and decompose it into `Criterion` objects.
4. **Review** — a reviewer agent judges each criterion with tool-grounded citations.
5. **Argue (optional)** — an argument layer debates contested criteria.
6. **Arbitrate** — a **deterministic arbiter (plain code, never the model)** returns `APPROVE` / `DENY` / `INSUFFICIENT`.

The engine emits a `TraceEvent` log of everything it does so the UI can replay/show its work.

### Invariants

- **Fail-closed**: absent evidence → `INSUFFICIENT`, never a guess.
- The final decision comes only from the deterministic arbiter — model output never directly decides.
- Every judgment must carry tool-grounded citations back to source evidence.
- Patient parsing is pure code; LLMs enter only at decomposition/review/argument stages.

## Core shapes

```
PatientContext {
  demographics { age, sex },
  diagnoses      [{ icd10, display }],
  labs           [{ code, display, value, unit, date }],
  meds           [{ name, rxnorm }],
  foot_conditions[{ icd10, display }],
  encounters     [{ class, date }],
  source_spans   { field: origin }
}

Criterion {
  id, text, quote, clause_ref,
  type: hard | soft,
  logic: all_of | any_of,
  needs[],
  threshold? { op, value, unit },
  context_conditions[],
  confidence
}
```

Conform to these shapes; don't rename or restructure fields without asking.

## Data layout

- `data/patients/` — Abridge dataset (`synthetic-ambient-fhir-25.jsonl`): FHIR R4 shaped as `patient_context.patient` + `encounter_fhir.related_resources` grouped by resource type, plus a transcript per record. Two small Synthea bundles will be added here too.
- `data/policies/` — retrieved CMS policy documents.
- `data/cache/` — policy retrieval cache.
- `data/gold/` — gold labels for the eval harness.

All patient data is synthetic, but treat it as if it were PHI (no leaking into logs, commits of derived dumps, etc.).

## Working style

- Build incrementally, one piece at a time — small, testable functions.
- Wait for the user's step-by-step prompts; do not build ahead of what was asked.
