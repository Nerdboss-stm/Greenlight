"""TraceEvent instrumentation (per docs/CONTRACT.md).

A Tracer accumulates TraceEvents with a monotonic `seq` and epoch-ms `ts_ms`.
`emit(...)` builds one event; the phase/type helpers are thin wrappers the
reviewer (and later stages) call as they work.
"""

from __future__ import annotations

import time
from typing import Any, Optional

from api.models import CriterionResult, TraceEvent, TracePhase, TraceType


class Tracer:
    def __init__(self) -> None:
        self.events: list[TraceEvent] = []
        self._seq = 0

    def emit(self, phase: TracePhase, type: TraceType, label: str,
             payload: Optional[dict[str, Any]] = None) -> TraceEvent:
        self._seq += 1
        event = TraceEvent(
            seq=self._seq,
            ts_ms=int(time.time() * 1000),
            phase=phase,
            type=type,
            label=label,
            payload=payload or {},
        )
        self.events.append(event)
        return event

    # --- convenience helpers -------------------------------------------------

    def phase_start(self, phase: TracePhase, label: str) -> TraceEvent:
        return self.emit(phase, "phase_start", label, {})

    def tool_call(self, name: str, args: dict[str, Any], *, phase: TracePhase = "review") -> TraceEvent:
        return self.emit(phase, "tool_call", name, {"tool": name, "args": args})

    def tool_result(self, name: str, result: Any, *, phase: TracePhase = "review") -> TraceEvent:
        return self.emit(phase, "tool_result", name, {"tool": name, "result": result})

    def criterion_verdict(self, cr: CriterionResult, *, phase: TracePhase = "review") -> TraceEvent:
        return self.emit(
            phase,
            "criterion_verdict",
            f"{cr.id} → {cr.verdict}",
            {
                "id": cr.id,
                "verdict": cr.verdict,
                "policy_clause": cr.policy_clause,
                "patient_evidence": cr.patient_evidence.model_dump(),
                "confidence": cr.confidence,
            },
        )


def emit(tracer: Tracer, phase: TracePhase, type: TraceType, label: str,
         payload: Optional[dict[str, Any]] = None) -> TraceEvent:
    """Functional form of Tracer.emit — builds and records one TraceEvent."""
    return tracer.emit(phase, type, label, payload)
