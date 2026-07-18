"""GreenLight — canonical API contract (Pydantic v2).

Single source of truth for every shape crossing the wire. Mirrored exactly,
field for field, by ui/src/types.ts and documented in docs/CONTRACT.md.

Conventions
-----------
- Wire field ``class`` (a Python keyword) is modeled as ``encounter_class`` with
  ``alias="class"``. FastAPI serializes responses ``by_alias`` by default and
  ``populate_by_name`` accepts either key on input, so the wire is always ``class``.
- Verdicts: determination = APPROVE/DENY/INSUFFICIENT (uppercase);
  criterion = met/not_met/unknown (lowercase).
"""

from __future__ import annotations

from typing import Any, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

# --- Shared literal unions ---------------------------------------------------

Sex = Literal["male", "female", "other", "unknown"]
CriterionType = Literal["hard", "soft"]
CriterionLogic = Literal["all_of", "any_of"]
CriterionVerdict = Literal["met", "not_met", "unknown"]
Verdict = Literal["APPROVE", "DENY", "INSUFFICIENT"]
TurnRole = Literal["reviewer", "advocate"]
CitationType = Literal["policy", "chart"]
TracePhase = Literal["retrieve", "decompose", "review", "argue", "arbiter", "actions"]
TraceType = Literal[
    "phase_start",
    "tool_call",
    "tool_result",
    "criterion_verdict",
    "argument_turn",
    "citation_check",
    "flip",
    "arbiter_math",
    "action_drafted",
    "done",
]
GoldStatus = Literal["pending_human", "verified", "rejected"]
BasketDecision = Literal["accept", "reject"]

# --- PatientContext ----------------------------------------------------------


class Demographics(BaseModel):
    age: int
    sex: Sex


class Diagnosis(BaseModel):
    icd10: str
    display: str


class Lab(BaseModel):
    code: str
    display: str
    value: Union[float, str]
    unit: str
    date: str


class Med(BaseModel):
    name: str
    rxnorm: str


class FootCondition(BaseModel):
    icd10: str
    display: str


class Encounter(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    encounter_class: str = Field(alias="class")
    date: str
    reason: Optional[str] = None


class PatientContext(BaseModel):
    demographics: Demographics
    diagnoses: list[Diagnosis]
    labs: list[Lab]
    meds: list[Med]
    prior_treatments: list[str]
    symptoms: list[str]
    foot_conditions: list[FootCondition]
    encounters: list[Encounter]
    source_spans: dict[str, str]


# --- Policy / Criterion ------------------------------------------------------


class Threshold(BaseModel):
    op: str
    value: float
    unit: str


class Criterion(BaseModel):
    id: str
    text: str
    quote: str
    clause_ref: str
    type: CriterionType
    logic: CriterionLogic
    needs: list[str]
    threshold: Optional[Threshold] = None
    context_conditions: list[str]
    confidence: float


class Policy(BaseModel):
    procedure: str
    version_hash: str
    source: str
    criteria: list[Criterion]


# --- Determination -----------------------------------------------------------


class PatientEvidence(BaseModel):
    path: str
    # Required key, but null when evidence is absent (fail-closed).
    value: Union[float, str, None]


class CriterionResult(BaseModel):
    id: str
    verdict: CriterionVerdict
    policy_clause: str
    patient_evidence: PatientEvidence
    reasoning: str
    confidence: float


class Citation(BaseModel):
    type: CitationType
    ref: str


class Turn(BaseModel):
    criterion_id: str
    role: TurnRole
    round: int
    position: str
    claim: str
    citation: Citation


class Actions(BaseModel):
    gap_query: Optional[str] = None
    appeal: Optional[str] = None
    review_queued: bool


class TraceEvent(BaseModel):
    seq: int
    ts_ms: int
    phase: TracePhase
    type: TraceType
    label: str
    payload: dict[str, Any]


class Determination(BaseModel):
    verdict: Verdict
    criteria: list[CriterionResult]
    argument_transcript: Optional[list[Turn]] = None
    actions: Actions
    cost_usd: float
    latency_ms: int
    trace: list[TraceEvent]


# --- Evals -------------------------------------------------------------------


class GoldCase(BaseModel):
    case_id: str
    procedure: str
    patient: PatientContext
    expected_criteria: dict[str, CriterionVerdict]
    reason: str
    status: GoldStatus


class PerCriterionStats(BaseModel):
    precision: float
    recall: float


class Taxonomy(BaseModel):
    over_approval: int
    missed_criterion: int
    hallucinated_evidence: int
    wrong_policy: int
    extraction_miss: int


class PerPolicyStat(BaseModel):
    procedure: str
    case_accuracy: float
    cases: int


class ModeStats(BaseModel):
    """One mode's metrics, so the panel can show single vs adversarial side by side."""
    case_accuracy: float
    precision: float
    recall: float
    taxonomy: Taxonomy
    calibration: float
    cost_per_case: float
    latency_per_case: float


class EvalResult(BaseModel):
    mode: str
    case_accuracy: float
    per_criterion: PerCriterionStats
    taxonomy: Taxonomy
    delta: Optional[float] = None
    calibration: float
    decompose_f1: float
    cost_per_case: float
    latency_per_case: float
    per_policy: list[PerPolicyStat]
    # Both modes' metrics (the eval runs both regardless of `mode`) for the
    # single-vs-adversarial comparison. Optional for backward compatibility.
    single: Optional[ModeStats] = None
    adversarial: Optional[ModeStats] = None


# --- Request bodies ----------------------------------------------------------


class SummarizeRequest(BaseModel):
    patient_file: dict[str, Any]


class RetrievePolicyRequest(BaseModel):
    procedure: str


class DecomposePolicyRequest(BaseModel):
    text: str
    procedure: Optional[str] = None


class CaseRequest(BaseModel):
    patient_file: dict[str, Any]
    procedure: str
    mode: Optional[str] = None
    stream: Optional[bool] = False


class AuthorRequest(BaseModel):
    targets: int


class BasketRequest(BaseModel):
    procedure: str
    decisions: dict[str, BasketDecision]


class EvalRunRequest(BaseModel):
    procedure: str
    mode: str


# --- Response envelopes ------------------------------------------------------


class RejectedCandidate(BaseModel):
    """A candidate the deterministic validator killed — shown struck-through with its reason."""
    branch: str
    intended: Optional[str] = None
    engine_verdict: Optional[str] = None
    reason: str
    trap: Optional[str] = None


class AuthorResponse(BaseModel):
    accepted: list[GoldCase]
    rejected: list[RejectedCandidate]


class BasketResponse(BaseModel):
    basket_size: int


class ApiError(BaseModel):
    type: str
    message: str


class ErrorEnvelope(BaseModel):
    error: ApiError
