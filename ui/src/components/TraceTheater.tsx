import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { Verdict } from "./types";

export type TraceEvent =
  | { kind: "phase"; n: string; label: string }
  | { kind: "ledger"; call: string; value: string; hit?: boolean }
  | { kind: "argument"; side: "payer" | "advocate"; text: string; cite: string }
  | { kind: "arbiter"; expr: string; result: Verdict; resultLabel: string };

interface TraceTheaterProps {
  events: TraceEvent[];
  /** ms between events while playing */
  interval?: number;
  /** ms to hold the full record before looping */
  holdMs?: number;
  loop?: boolean;
}

/** A live log of the engine's work, styled as a surgical record — paper and
 *  hairlines, never a black console. Plays ~N events, holds, then loops. */
export function TraceTheater({
  events,
  interval = 850,
  holdMs = 2200,
  loop = true,
}: TraceTheaterProps) {
  const reduce = useReducedMotion();
  const [count, setCount] = useState(reduce ? events.length : 0);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (reduce) {
      setCount(events.length);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const step = (i: number) => {
      setCount(i);
      if (i < events.length) {
        timer = setTimeout(() => step(i + 1), interval);
      } else if (loop) {
        timer = setTimeout(() => step(0), holdMs);
      }
    };
    step(0);
    return () => clearTimeout(timer);
  }, [events, interval, holdMs, loop, reduce]);

  // keep the newest entry in view
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);

  const visible = events.slice(0, count);

  return (
    <div className="gl-trace">
      <div className="gl-trace__masthead">
        <span className="gl-trace__title">Procedure Record</span>
        <span className="gl-trace__live">
          <motion.span
            className="gl-trace__pulse"
            animate={reduce ? undefined : { opacity: [1, 0.25, 1] }}
            transition={reduce ? undefined : { duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
          />
          Recording
        </span>
      </div>
      <div className="gl-trace__log" ref={logRef}>
        <AnimatePresence initial={false}>
          {visible.map((ev, i) => (
            <motion.div
              key={i}
              initial={reduce ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={reduce ? { duration: 0 } : { duration: 0.3, ease: "easeOut" }}
            >
              <TraceLine ev={ev} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

function TraceLine({ ev }: { ev: TraceEvent }) {
  switch (ev.kind) {
    case "phase":
      return (
        <div className="gl-ph">
          <span className="gl-ph__n">{ev.n}</span>
          <span className="gl-ph__label">{ev.label}</span>
          <span className="gl-ph__rule" />
        </div>
      );
    case "ledger":
      return (
        <div className="gl-led">
          <span className="gl-led__mark">·</span>
          <span className="gl-led__call">{ev.call}</span>
          <span className="gl-led__arrow">→</span>
          <span className={`gl-led__val${ev.hit ? " gl-led__val--hit" : ""}`}>{ev.value}</span>
        </div>
      );
    case "argument":
      return (
        <div className={`gl-arg gl-arg--${ev.side}`}>
          <div className="gl-arg__card">
            <div className="gl-arg__role">{ev.side === "payer" ? "Payer" : "Advocate"}</div>
            <div className="gl-arg__text">{ev.text}</div>
            <span className="gl-arg__chip">{ev.cite}</span>
          </div>
        </div>
      );
    case "arbiter":
      return (
        <div className="gl-arb">
          <span className="gl-arb__op">arbiter ·</span> {ev.expr}{" "}
          <span className="gl-arb__op">→</span>{" "}
          <span className={`gl-arb__out gl-arb__out--${ev.result}`}>{ev.resultLabel}</span>
        </div>
      );
  }
}
