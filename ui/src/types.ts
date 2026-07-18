/**
 * GreenLight — API contract types.
 *
 * Mirror of api/models.py (Pydantic v2), field for field. Documented in
 * docs/CONTRACT.md. If you change a shape, change all three together.
 *
 * Verdicts: determination = APPROVE/DENY/INSUFFICIENT (uppercase);
 * criterion = met/not_met/unknown (lowercase).
 */

// --- Shared literal unions ---------------------------------------------------

export type Sex = "male" | "female" | "other" | "unknown";
export type CriterionType = "hard" | "soft";
export type CriterionLogic = "all_of" | "any_of";
export type CriterionVerdict = "met" | "not_met" | "unknown";
export type Verdict = "APPROVE" | "DENY" | "INSUFFICIENT";
export type TurnRole = "reviewer" | "advocate";
export type CitationType = "policy" | "chart";
export type TracePhase = "retrieve" | "decompose" | "review" | "argue" | "arbiter" | "actions";
export type TraceType =
  | "phase_start"
  | "tool_call"
  | "tool_result"
  | "criterion_verdict"
  | "argument_turn"
  | "citation_check"
  | "flip"
  | "arbiter_math"
  | "action_drafted"
  | "done";
export type GoldStatus = "pending_human" | "verified" | "rejected";
export type BasketDecision = "accept" | "reject";

// --- PatientContext ----------------------------------------------------------

export interface Demographics {
  age: number;
  sex: Sex;
}

export interface Diagnosis {
  icd10: string;
  display: string;
}

export interface Lab {
  code: string;
  display: string;
  value: number | string;
  unit: string;
  date: string;
}

export interface Med {
  name: string;
  rxnorm: string;
}

export interface FootCondition {
  icd10: string;
  display: string;
}

export interface Encounter {
  class: string;
  date: string;
  reason?: string;
}

export interface PatientContext {
  demographics: Demographics;
  diagnoses: Diagnosis[];
  labs: Lab[];
  meds: Med[];
  prior_treatments: string[];
  symptoms: string[];
  foot_conditions: FootCondition[];
  encounters: Encounter[];
  source_spans: Record<string, string>;
}

// --- Policy / Criterion ------------------------------------------------------

export interface Threshold {
  op: string;
  value: number;
  unit: string;
}

export interface Criterion {
  id: string;
  text: string;
  quote: string;
  clause_ref: string;
  type: CriterionType;
  logic: CriterionLogic;
  needs: string[];
  threshold?: Threshold;
  context_conditions: string[];
  confidence: number;
}

export interface Policy {
  procedure: string;
  version_hash: string;
  source: string;
  criteria: Criterion[];
}

// --- Determination -----------------------------------------------------------

export interface PatientEvidence {
  path: string;
  value: number | string | null;
}

export interface CriterionResult {
  id: string;
  verdict: CriterionVerdict;
  policy_clause: string;
  patient_evidence: PatientEvidence;
  reasoning: string;
  confidence: number;
}

export interface Citation {
  type: CitationType;
  ref: string;
}

export interface Turn {
  criterion_id: string;
  role: TurnRole;
  round: number;
  position: string;
  claim: string;
  citation: Citation;
}

export interface Actions {
  gap_query?: string;
  appeal?: string;
  review_queued: boolean;
}

export interface TraceEvent {
  seq: number;
  ts_ms: number;
  phase: TracePhase;
  type: TraceType;
  label: string;
  payload: Record<string, unknown>;
}

export interface Determination {
  verdict: Verdict;
  criteria: CriterionResult[];
  argument_transcript?: Turn[];
  actions: Actions;
  cost_usd: number;
  latency_ms: number;
  trace: TraceEvent[];
}

// --- Evals -------------------------------------------------------------------

export interface GoldCase {
  case_id: string;
  procedure: string;
  patient: PatientContext;
  expected_criteria: Record<string, CriterionVerdict>;
  reason: string;
  status: GoldStatus;
}

export interface PerCriterionStats {
  precision: number;
  recall: number;
}

export interface Taxonomy {
  over_approval: number;
  missed_criterion: number;
  hallucinated_evidence: number;
  wrong_policy: number;
  extraction_miss: number;
}

export interface PerPolicyStat {
  procedure: string;
  case_accuracy: number;
  cases: number;
}

export interface EvalResult {
  mode: string;
  case_accuracy: number;
  per_criterion: PerCriterionStats;
  taxonomy: Taxonomy;
  delta?: number;
  calibration: number;
  decompose_f1: number;
  cost_per_case: number;
  latency_per_case: number;
  per_policy: PerPolicyStat[];
}

// --- Request bodies ----------------------------------------------------------

export interface SummarizeRequest {
  patient_file: Record<string, unknown>;
}

export interface RetrievePolicyRequest {
  procedure: string;
}

export interface DecomposePolicyRequest {
  text: string;
  procedure?: string;
}

export interface CaseRequest {
  patient_file: Record<string, unknown>;
  procedure: string;
  mode?: string;
  stream?: boolean;
}

export interface AuthorRequest {
  targets: number;
}

export interface BasketRequest {
  procedure: string;
  decisions: Record<string, BasketDecision>;
}

export interface EvalRunRequest {
  procedure: string;
  mode: string;
}

// --- Response envelopes ------------------------------------------------------

export interface BasketResponse {
  basket_size: number;
}

export interface ApiError {
  type: string;
  message: string;
}

export interface ErrorEnvelope {
  error: ApiError;
}
