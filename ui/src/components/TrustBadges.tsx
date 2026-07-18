import { motion, useReducedMotion } from "motion/react";
import type { Determination, TraceEvent } from "../types";

interface TrustBadgesProps {
  events: TraceEvent[];
  determination: Determination;
  /** bump to replay the entrance on re-run */
  replayKey?: string | number;
}

/** Credibility line beneath the stamp: the receipts for the verdict — tool
 *  calls made, argument rounds run, citations validated vs. rejected, and the
 *  real cost + latency. Every number is derived from the trace, not asserted. */
export function TrustBadges({ events, determination, replayKey }: TrustBadgesProps) {
  const reduce = useReducedMotion();

  const toolCalls = events.filter((e) => e.type === "tool_call").length;
  const rounds = new Set((determination.argument_transcript ?? []).map((t) => t.round)).size;
  const checks = events.filter((e) => e.type === "citation_check");
  const validated = checks.filter((e) => (e.payload as { resolved?: unknown }).resolved === true).length;
  const rejected = checks.filter((e) => (e.payload as { resolved?: unknown }).resolved === false).length;

  const cost = `$${determination.cost_usd.toFixed(4)}`;
  const latency =
    determination.latency_ms >= 1000
      ? `${(determination.latency_ms / 1000).toFixed(1)}s`
      : `${determination.latency_ms}ms`;

  const badges: { k: string; v: string }[] = [
    { k: "tool calls", v: String(toolCalls) },
    { k: "argument rounds", v: String(rounds) },
    { k: "citations", v: `${validated} ✓ / ${rejected} ✗` },
    { k: "cost", v: cost },
    { k: "latency", v: latency },
  ];

  return (
    <motion.div
      className="gl-badges"
      key={replayKey}
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0 } : { duration: 0.4, delay: 0.25, ease: [0.16, 1, 0.3, 1] }}
    >
      {badges.map((b) => (
        <span className="gl-badge" key={b.k}>
          <span className="gl-badge__v">{b.v}</span>
          <span className="gl-badge__k">{b.k}</span>
        </span>
      ))}
    </motion.div>
  );
}
