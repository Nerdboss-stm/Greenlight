"""GreenLight API — contract surface.

Every route's request/response is pinned to api/models.py. Handlers are stubs
for now (feature work lands later); each raises the one error envelope so the
shape is enforced from day one. CORS is open to the Vite dev origin.
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .models import (
    AuthorRequest,
    BasketRequest,
    BasketResponse,
    CaseRequest,
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
async def summarize(body: SummarizeRequest) -> PatientContext:
    """Parse a patient record into a PatientContext (deterministic, no LLM)."""
    raise _todo("POST /summarize")


@app.get("/policies", response_model=list[Policy])
async def list_policies() -> list[Policy]:
    """Return the pinned policy set."""
    raise _todo("GET /policies")


@app.post("/policies/retrieve", response_model=Policy)
async def retrieve_policy(body: RetrievePolicyRequest) -> Policy:
    """Run the connector → search → fetch → cache fallback chain, then pin."""
    raise _todo("POST /policies/retrieve")


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
