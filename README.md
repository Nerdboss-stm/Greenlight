# GreenLight

**Live hackathon build — New Work.** All code in this repository is being written live during the hackathon.

GreenLight is a clinical prior-authorization agent plus an eval harness: two pages sharing one engine. Per case, the engine parses a patient into a `PatientContext` (deterministic, no LLM), retrieves the clinician-selected CMS policy and decomposes it into criteria, has a reviewer agent judge each criterion with tool-grounded citations, optionally debates contested criteria, and hands the result to a deterministic arbiter that returns **APPROVE / DENY / INSUFFICIENT** — fail-closed, never a guess.

## Layout

```
adapters/   FHIR → PatientContext parsing (pure code)
agent/      Claude Agent SDK engine: policy decomposition, reviewer, argument layer, arbiter
api/        FastAPI backend — /case runs the engine and streams TraceEvents over SSE
evals/      Eval harness against data/gold/
data/       patients (synthetic FHIR), policies, retrieval cache, gold labels
ui/         Vite + React frontend (Motion animations)
```

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cd ui && npm install
```

All patient data is synthetic.
