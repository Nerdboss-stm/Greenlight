import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { TraceEvent } from "../types";
import type { CriterionStatus } from "./types";
import { STATUS_HEX } from "./types";

/**
 * The centerpiece — REPLAY-FIRST. It takes the engine's `TraceEvent[]` and
 * *performs* it: one event revealed every ~320ms, sectioned as a printed
 * procedure record. The same component drives the live stream (events arrive
 * and the pacing catches up) and the fallback replay (all events present at
 * once) — the viewer cannot tell which path ran.
 *
 * Feed it a growing array; the cursor never outruns what has arrived. Pass
 * `running` while more events may still come; when it goes false and the
 * terminal `done` event has been performed, `onPerformed` fires once.
 */

const PHASE_META: Record<string, { name: string; index: string }> = {
  retrieve: { name: "Retrieve", index: "I" },
  decompose: { name: "Decompose", index: "II" },
  review: { name: "Review", index: "III" },
  argue: { name: "Argue", index: "IV" },
  arbiter: { name: "Arbiter", index: "V" },
  actions: { name: "Actions", index: "VI" },
};

const BASE_INTERVAL = 320; // ms between events at 1×
const SPEEDS = [0.5, 1, 2] as const;

interface TraceTheaterProps {
  events: TraceEvent[];
  /** true while the run may still emit events; false once the Determination resolved */
  running?: boolean;
  /** fires exactly once, when the terminal `done` event has been performed */
  onPerformed?: () => void;
  /** render the whole record at once — the collapsed "show the work" drawer */
  instant?: boolean;
}

export function TraceTheater({ events, running = false, onPerformed, instant = false }: TraceTheaterProps) {
  const reduce = useReducedMotion();
  const full = instant || !!reduce;
  const [cursor, setCursor] = useState(full ? events.length : 0);
  const [speed, setSpeed] = useState(1);
  const [skipped, setSkipped] = useState(full);
  const logRef = useRef<HTMLDivElement>(null);
  const firedRef = useRef(false);

  // Skipped / instant / reduced-motion → reveal everything, including late arrivals.
  useEffect(() => {
    if (skipped) setCursor(events.length);
  }, [skipped, events.length]);

  // Paced performance: advance one event per interval, never past what has arrived.
  useEffect(() => {
    if (skipped || cursor >= events.length) return;
    const t = setTimeout(() => setCursor((c) => c + 1), BASE_INTERVAL / speed);
    return () => clearTimeout(t);
  }, [cursor, events.length, speed, skipped]);

  // Signal completion once the done event is on screen and no more are coming.
  useEffect(() => {
    if (firedRef.current) return;
    const hasDone = events.some((e) => e.type === "done");
    if (hasDone && cursor >= events.length && !running) {
      firedRef.current = true;
      onPerformed?.();
    }
  }, [cursor, events, running, onPerformed]);

  // Keep the newest line in view while performing.
  useLayoutEffect(() => {
    if (full) return;
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [cursor, full]);

  const visible = events.slice(0, cursor);
  const performing = !skipped && cursor < events.length;

  return (
    <div className={`gl-trace${instant ? " gl-trace--static" : ""}`}>
      <div className="gl-trace__masthead">
        <span className="gl-trace__title">Procedure Record</span>
        {instant ? (
          <span className="gl-trace__live gl-trace__live--done">{events.length} events</span>
        ) : (
          <div className="gl-trace__controls">
            {performing || running ? (
              <span className="gl-trace__live">
                <motion.span
                  className="gl-trace__pulse"
                  animate={full ? undefined : { opacity: [1, 0.25, 1] }}
                  transition={full ? undefined : { duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                />
                Recording
              </span>
            ) : (
              <span className="gl-trace__live gl-trace__live--done">Complete</span>
            )}
            <div className="gl-speed" role="group" aria-label="playback speed">
              {SPEEDS.map((s) => (
                <button key={s} type="button" data-active={speed === s} onClick={() => setSpeed(s)}>
                  {s}×
                </button>
              ))}
            </div>
            <button type="button" className="gl-trace__skip" onClick={() => setSkipped(true)} disabled={!performing}>
              Skip
            </button>
          </div>
        )}
      </div>

      <div className="gl-trace__log" ref={logRef}>
        <AnimatePresence initial={false}>
          {visible.map((ev) => (
            <motion.div
              key={ev.seq}
              initial={full ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={full ? { duration: 0 } : { duration: 0.28, ease: "easeOut" }}
            >
              <Line ev={ev} reduce={full} />
            </motion.div>
          ))}
        </AnimatePresence>
        {visible.length === 0 && <div className="gl-trace__idle">awaiting the engine…</div>}
      </div>
    </div>
  );
}

const str = (v: unknown): string => (v == null ? "" : String(v));

function Line({ ev, reduce }: { ev: TraceEvent; reduce: boolean }) {
  const p = ev.payload as Record<string, unknown>;

  // --- Phase headers -------------------------------------------------------
  if (ev.type === "phase_start") {
    const meta = PHASE_META[ev.phase] ?? { name: ev.phase, index: "" };
    return (
      <div className="gl-ph">
        <span className="gl-ph__n">{meta.index}</span>
        <span className="gl-ph__label">{meta.name}</span>
        <span className="gl-ph__rule" />
        <span className="gl-ph__note">{ev.label}</span>
      </div>
    );
  }

  // --- Retrieve ------------------------------------------------------------
  if (ev.phase === "retrieve" && ev.type === "tool_result") {
    if (p.version_hash) {
      return (
        <div className="gl-led gl-led--pin">
          <span className="gl-led__mark">◆</span>
          <span className="gl-led__call">policy pinned</span>
          <span className="gl-led__arrow">→</span>
          <span className="gl-led__val">{str(p.procedure)}</span>
          <span className="gl-pin">{str(p.version_hash)}</span>
          <span className="gl-led__src">
            {str(p.source)} · {str(p.criteria)} criteria
          </span>
        </div>
      );
    }
    return (
      <div className="gl-led">
        <span className="gl-led__mark">·</span>
        <span className="gl-led__call">patient parsed</span>
        <span className="gl-led__arrow">→</span>
        <span className="gl-led__val">
          {str(p.age)}
          {p.sex ? ` ${str(p.sex)}` : ""} · {str(p.diagnoses)} dx · {str(p.labs)} labs · {str(p.meds)} meds ·{" "}
          {str(p.foot_conditions)} foot
        </span>
      </div>
    );
  }

  // --- Decompose (criterion materializing with a validator tick) -----------
  if (ev.phase === "decompose" && ev.type === "tool_result") {
    return (
      <div className="gl-led gl-led--crit">
        <span className="gl-tick" aria-hidden>
          ✓
        </span>
        <span className="gl-led__call">{str(p.id)}</span>
        <span className="gl-mini">{str(p.type)}</span>
        <span className="gl-mini">{str(p.logic)}</span>
        <span className="gl-led__src">{str(p.clause_ref)}</span>
      </div>
    );
  }

  // --- Tool calls (any phase) ---------------------------------------------
  if (ev.type === "tool_call") {
    const args = (p.args as Record<string, unknown>) ?? {};
    const argstr = Object.entries(args)
      .map(([k, v]) => `${k}=${str(v)}`)
      .join(", ");
    return (
      <div className="gl-led">
        <span className="gl-led__mark">·</span>
        <span className="gl-led__call">
          {str(p.tool ?? ev.label)}(<span className="gl-led__arg">{argstr}</span>)
        </span>
      </div>
    );
  }

  // --- Review tool results -------------------------------------------------
  if (ev.phase === "review" && ev.type === "tool_result") {
    const r = (p.result as Record<string, unknown>) ?? {};
    const present = !!r.present;
    const val = "value" in r ? str(r.value) : "";
    return (
      <div className="gl-led">
        <span className="gl-led__mark">·</span>
        <span className="gl-led__call">{str(p.tool ?? ev.label)}</span>
        <span className="gl-led__arrow">→</span>
        <span className={`gl-led__val${present ? " gl-led__val--hit" : ""}`}>
          {present ? val || "present" : "absent"}
        </span>
      </div>
    );
  }

  // --- Criterion verdict (the square stamping) -----------------------------
  if (ev.type === "criterion_verdict") {
    const status = str(p.verdict) as CriterionStatus;
    const conf = typeof p.confidence === "number" ? p.confidence : Number(p.confidence);
    return (
      <div className="gl-cv">
        <motion.span
          className="gl-square"
          style={{ backgroundColor: STATUS_HEX[status] ?? "#9aa0aa" }}
          initial={reduce ? false : { scale: 1.5, opacity: 0.35 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={reduce ? { duration: 0 } : { duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          aria-hidden
        />
        <span className="gl-cv__id">{str(p.id)}</span>
        <span className="gl-cv__verdict" data-status={status}>
          {status}
        </span>
        <span className="gl-cv__clause">{str(p.policy_clause)}</span>
        <span className="gl-cv__spacer" />
        <span className="gl-cv__conf">conf {Number.isFinite(conf) ? conf.toFixed(2) : "—"}</span>
      </div>
    );
  }

  // --- Argument turns (payer left, advocate right) -------------------------
  if (ev.type === "argument_turn") {
    const side = str(p.role) === "advocate" ? "advocate" : "payer";
    const cit = (p.citation as Record<string, unknown>) ?? {};
    return (
      <div className={`gl-arg gl-arg--${side}`}>
        <div className="gl-arg__card">
          <div className="gl-arg__role">
            {side === "payer" ? "Payer" : "Advocate"} · rd {str(p.round)}
          </div>
          <div className="gl-arg__text">{str(p.claim)}</div>
          <span className="gl-arg__chip" data-cite={str(cit.type)}>
            {str(cit.type)} · {str(cit.ref)}
          </span>
        </div>
      </div>
    );
  }

  // --- Citation check (visibly passes or is rejected) ----------------------
  if (ev.type === "citation_check") {
    let kind: "pass" | "reject" | "skip" | "warn" = "pass";
    let text = ev.label;
    if (p.skipped) {
      kind = "skip";
      text = "no candidate chart evidence — debate skipped";
    } else if (p.resolved === false) {
      kind = "reject";
      text = `citation rejected · ${str(p.path)} does not resolve`;
    } else if (p.flipped === false || p.context_unsatisfied) {
      const failed = Array.isArray(p.context_unsatisfied) ? (p.context_unsatisfied as string[]).join(", ") : "";
      kind = "warn";
      text = `citation valid but context unmet — no flip${failed ? ` · ${failed}` : ""}`;
    } else if (p.resolved === true) {
      kind = "pass";
      text = `citation validated · ${str(p.path)}${p.value ? ` = ${str(p.value)}` : ""}`;
    }
    const mark = kind === "pass" ? "✓" : kind === "reject" ? "✗" : kind === "warn" ? "△" : "—";
    return (
      <div className={`gl-cc gl-cc--${kind}`}>
        <span className="gl-cc__mark" aria-hidden>
          {mark}
        </span>
        <span className="gl-cc__text">{text}</span>
      </div>
    );
  }

  // --- Flip (highlighted) --------------------------------------------------
  if (ev.type === "flip") {
    return (
      <motion.div
        className="gl-flip"
        initial={reduce ? false : { opacity: 0, x: 6 }}
        animate={{ opacity: 1, x: 0 }}
        transition={reduce ? { duration: 0 } : { duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      >
        <span className="gl-flip__mark" aria-hidden>
          ⤷
        </span>
        <span className="gl-flip__text">
          <b>{str(p.criterion_id)}</b> {str(p.from)} → <b>met</b>
        </span>
        <span className="gl-flip__cite">{str(p.citation)}</span>
      </motion.div>
    );
  }

  // --- Arbiter arithmetic --------------------------------------------------
  if (ev.type === "arbiter_math") {
    const parts = ev.label.split("→");
    const head = parts.slice(0, -1).join("→").trim();
    const out = (parts[parts.length - 1] ?? "").trim();
    const cls = out === "APPROVE" ? "approve" : out === "DENY" ? "deny" : "insufficient";
    return (
      <div className="gl-arb">
        <span className="gl-arb__op">arbiter ·</span> {head} <span className="gl-arb__op">→</span>{" "}
        <span className={`gl-arb__out gl-arb__out--${cls}`}>{out}</span>
      </div>
    );
  }

  // --- Actions -------------------------------------------------------------
  if (ev.type === "action_drafted") {
    const lines: string[] = [];
    if (p.gap_query) lines.push(`gap query · ${str(p.gap_query)}`);
    if (p.appeal) lines.push("appeal drafted");
    if (p.review_queued) lines.push("queued for human review");
    if (!lines.length) lines.push("recorded — no action required");
    return (
      <div className="gl-act">
        {lines.map((l, i) => (
          <div className="gl-led" key={i}>
            <span className="gl-led__mark">·</span>
            <span className="gl-led__val">{l}</span>
          </div>
        ))}
      </div>
    );
  }

  if (ev.type === "done") {
    return (
      <div className="gl-done-rule">
        <span>end of record</span>
      </div>
    );
  }

  // Fallback — never drop an event silently.
  return (
    <div className="gl-led">
      <span className="gl-led__mark">·</span>
      <span className="gl-led__call">{ev.label}</span>
    </div>
  );
}
