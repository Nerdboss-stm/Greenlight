# GreenLight — API Contract

**Single source of truth.** Every shape below is defined once in
`api/models.py` (Pydantic v2) and mirrored field-for-field in
`ui/src/types.ts`. The frontend only touches the backend through
`ui/src/api.ts` — there are **no `fetch()` calls anywhere else**. If a shape
changes, all three files change in the same commit.

## Conventions

- **JSON** everywhere. Snake_case field names on the wire.
- **Verdicts** have two vocabularies, never mixed:
  - Determination verdict: `APPROVE` · `DENY` · `INSUFFICIENT` (uppercase).
  - Criterion verdict: `met` · `not_met` · `unknown` (lowercase).
- The wire field **`class`** (a Python keyword) is modeled in Python as
  `encounter_class` with `alias="class"`; FastAPI serializes by alias, so the
  wire is always `class`. TypeScript uses `class` directly.
- **Optional** fields are marked `?` (TS) / `Optional[...] = None` (Py) and may
  be omitted or `null`.
- Fail-closed: absent evidence yields `INSUFFICIENT`, never a guess.

---

## Core shapes

### PatientContext

| Field | Type | Notes |
|---|---|---|
| `demographics` | `Demographics` | |
| `diagnoses` | `Diagnosis[]` | |
| `labs` | `Lab[]` | |
| `meds` | `Med[]` | |
| `prior_treatments` | `string[]` | |
| `symptoms` | `string[]` | |
| `foot_conditions` | `FootCondition[]` | |
| `encounters` | `Encounter[]` | |
| `source_spans` | `Record<string,string>` | `field → origin` provenance map |

- **Demographics** `{ age: int, sex: "male"|"female"|"other"|"unknown" }`
- **Diagnosis** `{ icd10: string, display: string }`
- **Lab** `{ code: string, display: string, value: number|string, unit: string, date: string }`
- **Med** `{ name: string, rxnorm: string }`
- **FootCondition** `{ icd10: string, display: string }`
- **Encounter** `{ class: string, date: string, reason?: string }`

### Criterion

`{ id, text, quote, clause_ref, type, logic, needs, threshold?, context_conditions, confidence }`

| Field | Type |
|---|---|
| `id` | `string` |
| `text` | `string` |
| `quote` | `string` |
| `clause_ref` | `string` |
| `type` | `"hard" \| "soft"` |
| `logic` | `"all_of" \| "any_of"` |
| `needs` | `string[]` |
| `threshold?` | `{ op: string, value: number, unit: string }` |
| `context_conditions` | `string[]` |
| `confidence` | `number` (0–1) |

### Policy

`{ procedure: string, version_hash: string, source: string, criteria: Criterion[] }`

### CriterionResult

`{ id, verdict, policy_clause, patient_evidence, reasoning, confidence }`

| Field | Type |
|---|---|
| `id` | `string` |
| `verdict` | `"met" \| "not_met" \| "unknown"` |
| `policy_clause` | `string` |
| `patient_evidence` | `{ path: string, value: number \| string \| null }` |
| `reasoning` | `string` |
| `confidence` | `number` (0–1) |

### Turn

`{ criterion_id, role, round, position, claim, citation }`

| Field | Type |
|---|---|
| `criterion_id` | `string` |
| `role` | `"reviewer" \| "advocate"` |
| `round` | `number` |
| `position` | `string` |
| `claim` | `string` |
| `citation` | `{ type: "policy" \| "chart", ref: string }` |

### Determination

`{ verdict, criteria, argument_transcript?, actions, cost_usd, latency_ms, trace }`

| Field | Type |
|---|---|
| `verdict` | `"APPROVE" \| "DENY" \| "INSUFFICIENT"` |
| `criteria` | `CriterionResult[]` |
| `argument_transcript?` | `Turn[]` |
| `actions` | `{ gap_query?: string, appeal?: string, review_queued: boolean }` |
| `cost_usd` | `number` |
| `latency_ms` | `number` (int) |
| `trace` | `TraceEvent[]` (always present) |

### TraceEvent

`{ seq, ts_ms, phase, type, label, payload }`

| Field | Type |
|---|---|
| `seq` | `number` (int, monotonic) |
| `ts_ms` | `number` (int, epoch ms) |
| `phase` | `"retrieve" \| "decompose" \| "review" \| "argue" \| "arbiter" \| "actions"` |
| `type` | `"phase_start" \| "tool_call" \| "tool_result" \| "criterion_verdict" \| "argument_turn" \| "citation_check" \| "flip" \| "arbiter_math" \| "action_drafted" \| "done"` |
| `label` | `string` |
| `payload` | `Record<string, unknown>` (event-specific) |

The terminal event of a stream is `type: "done"`; its `payload` is the full
`Determination`.

### GoldCase

`{ case_id, procedure, patient, expected_criteria, reason, status }`

| Field | Type |
|---|---|
| `case_id` | `string` |
| `procedure` | `string` |
| `patient` | `PatientContext` |
| `expected_criteria` | `Record<string, "met"\|"not_met"\|"unknown">` (criterion id → verdict) |
| `reason` | `string` |
| `status` | `"pending_human" \| "verified" \| "rejected"` |

### EvalResult

`{ mode, case_accuracy, per_criterion, taxonomy, delta?, calibration, decompose_f1, cost_per_case, latency_per_case, per_policy }`

| Field | Type |
|---|---|
| `mode` | `string` |
| `case_accuracy` | `number` |
| `per_criterion` | `{ precision: number, recall: number }` |
| `taxonomy` | `{ over_approval: int, missed_criterion: int, hallucinated_evidence: int, wrong_policy: int, extraction_miss: int }` |
| `delta?` | `number` (vs. baseline) |
| `calibration` | `number` |
| `decompose_f1` | `number` |
| `cost_per_case` | `number` |
| `latency_per_case` | `number` |
| `per_policy` | `PerPolicyStat[]` = `{ procedure: string, case_accuracy: number, cases: int }[]` |

---

## Error envelope

Every non-2xx response uses exactly one shape:

```json
{ "error": { "type": "string", "message": "string" } }
```

`ui/src/api.ts` surfaces this as `ApiClientError` (`.type`, `.message`,
`.status`). Client-only failures use the types `network_error` and
`parse_error`.

---

## Endpoints

| Method | Path | Request | Response |
|---|---|---|---|
| `POST` | `/summarize` | `{ patient_file }` | `PatientContext` |
| `GET` | `/policies` | — | `Policy[]` (pinned) |
| `POST` | `/policies/retrieve` | `{ procedure }` | `Policy` (runs fallback chain, pins) |
| `POST` | `/case` | `{ patient_file, procedure, mode? }` | `Determination` (always includes `trace[]`) |
| `POST` | `/case` (stream) | `{ patient_file, procedure, mode?, stream: true }` | **SSE** — one `TraceEvent` per `data:` frame; final `done` event carries the full `Determination` |
| `POST` | `/policies/{procedure}/author` | `{ targets }` | `GoldCase[]` (`status: pending_human`) |
| `POST` | `/basket` | `{ procedure, decisions }` | `{ basket_size }` |
| `POST` | `/evals/run` | `{ procedure, mode }` | `EvalResult` |

`decisions` on `/basket` is `Record<string, "accept"|"reject">` (case id → decision).

### Streaming semantics (`/case` with `stream: true`)

- Content-Type `text/event-stream`. Each SSE frame is a JSON `TraceEvent` on a
  `data:` line, frames separated by a blank line.
- Events arrive in `seq` order; `phase` walks `retrieve → decompose → review →
  argue → arbiter → actions`.
- The final frame is `type: "done"` with `payload` = the complete
  `Determination` (identical to what the non-stream endpoint returns).

### Fallback guarantee

`streamCase(req, onEvent)` in `api.ts` **must** be indistinguishable from a
successful stream on failure: any network error, non-OK status, missing body,
malformed SSE, or a stream that ends without `done` transparently falls back to
`runCase(req)`, then replays the returned `trace[]` through `onEvent`. Callers
receive the same `Determination` and never learn which path ran.

---

## CORS

The API allows the Vite dev origins `http://localhost:5173` and
`http://127.0.0.1:5173` (all methods, all headers).

---

## Client surface (`ui/src/api.ts`)

One typed async function per endpoint, all returning the shapes above:

```ts
summarize(patientFile)              // → PatientContext
getPolicies()                       // → Policy[]
retrievePolicy(procedure)           // → Policy
runCase(req)                        // → Determination
streamCase(req, onEvent)            // → Determination (streams TraceEvents; falls back)
authorGold(procedure, targets)      // → GoldCase[]
submitBasket(req)                   // → { basket_size }
runEval(req)                        // → EvalResult
```

Plus `useAsync(fn)` — a `{ data, error, loading, run, reset }` hook for a
consistent loading pattern across screens.
