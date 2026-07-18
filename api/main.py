"""GreenLight API — contract surface.

Every route's request/response is pinned to api/models.py. Handlers are stubs
for now (feature work lands later); each raises the one error envelope so the
shape is enforced from day one. CORS is open to the Vite dev origin.
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from adapters import doc_adapter, fhir_adapter
from agent import retrieve

from .models import (
    AuthorRequest,
    BasketRequest,
    BasketResponse,
    CaseRequest,
    DecomposePolicyRequest,
    Determination,
    EvalResult,
    EvalRunRequest,
    GoldCase,
    Policy,
    RetrievePolicyRequest,
    SummarizeRequest,
    PatientContext,
)

app = FastAPI(title="GreenLight", version="0.1.0")

# Vite dev server origins.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ApiException(Exception):
    """Raised anywhere in a handler; rendered as the single error envelope."""

    def __init__(self, type: str, message: str, status_code: int = 400) -> None:
        self.type = type
        self.message = message
        self.status_code = status_code
        super().__init__(message)


@app.exception_handler(ApiException)
async def api_exception_handler(_: Request, exc: ApiException) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"type": exc.type, "message": exc.message}},
    )


def _todo(endpoint: str) -> "ApiException":
    return ApiException("not_implemented", f"{endpoint} is not implemented yet", 501)


# --- Endpoints ---------------------------------------------------------------


@app.post("/summarize", response_model=PatientContext)
def summarize(body: SummarizeRequest) -> PatientContext:
    """Parse a patient record into a PatientContext.

    Default is the deterministic FHIR path (Bundle or Abridge record). The
    transcript modality (LLM) is used only when explicitly requested via
    ``modality: "transcript"`` or when the payload is transcript-only.
    """
    pf = body.patient_file
    modality = pf.get("modality") or pf.get("_modality")
    has_structured = "patient_context" in pf or "encounter_fhir" in pf or pf.get("resourceType") == "Bundle"

    try:
        if modality == "transcript" or (not has_structured and isinstance(pf.get("transcript"), str)):
            transcript = pf.get("transcript")
            if not isinstance(transcript, str) or not transcript.strip():
                raise ApiException("bad_request", "transcript modality requires a non-empty 'transcript'", 400)
            return doc_adapter.parse_transcript(transcript)
        return fhir_adapter.parse_obj(pf)
    except ApiException:
        raise
    except Exception as exc:  # parsing/validation failure → one envelope
        raise ApiException("parse_error", f"could not parse patient_file: {exc}", 422)


@app.get("/policies", response_model=list[Policy])
def list_policies() -> list[Policy]:
    """Return the pinned policy set."""
    try:
        return retrieve.list_policies()
    except Exception as exc:
        raise ApiException("policy_error", f"could not list policies: {exc}", 500)


@app.post("/policies/retrieve", response_model=Policy)
def retrieve_policy(body: RetrievePolicyRequest) -> Policy:
    """Run the connector → search → fetch → cache fallback chain, then pin."""
    try:
        return retrieve.retrieve_policy(body.procedure)
    except KeyError as exc:
        raise ApiException("not_found", f"no policy for procedure {body.procedure!r}", 404) from exc
    except Exception as exc:
        raise ApiException("policy_error", f"retrieval failed: {exc}", 500)


@app.post("/policies/decompose", response_model=Policy)
def decompose_policy(body: DecomposePolicyRequest) -> Policy:
    """Decompose free-text policy language into a Policy (one LLM call → validate)."""
    if not body.text or not body.text.strip():
        raise ApiException("bad_request", "policy text is required", 400)
    try:
        return retrieve.decompose_text(body.text, body.procedure)
    except ApiException:
        raise
    except Exception as exc:
        raise ApiException("decompose_error", f"could not decompose policy: {exc}", 502)


@app.post("/case")
async def run_case(body: CaseRequest):
    """Adjudicate a case. Returns a Determination (always with trace[]).

    When ``stream: true``, returns SSE (EventSourceResponse) emitting each
    TraceEvent as it happens; the final ``done`` event carries the full
    Determination in its payload.
    """
    raise _todo("POST /case")


@app.post("/policies/{procedure}/author", response_model=list[GoldCase])
async def author_gold(procedure: str, body: AuthorRequest) -> list[GoldCase]:
    """Author candidate gold cases (status pending_human)."""
    raise _todo("POST /policies/{procedure}/author")


@app.post("/basket", response_model=BasketResponse)
async def submit_basket(body: BasketRequest) -> BasketResponse:
    """Record human accept/reject decisions; return the verified basket size."""
    raise _todo("POST /basket")


@app.post("/evals/run", response_model=EvalResult)
async def run_evals(body: EvalRunRequest) -> EvalResult:
    """Run the eval harness for a procedure/mode."""
    raise _todo("POST /evals/run")
