import { motion, useReducedMotion } from "motion/react";
import type { Criterion, Policy } from "../types";
import { SectionRule } from "./SectionRule";

interface PolicyViewProps {
  policy: Policy;
  /** human label for the procedure (e.g. "Home Oxygen (NCD 240.2)") */
  label?: string;
}

/** Renders a retrieved, decomposed policy: each criterion as an auditable
 *  clause card with its verbatim quote, threshold, and measurement context. */
export function PolicyView({ policy, label }: PolicyViewProps) {
  const reduce = useReducedMotion();
  const hard = policy.criteria.filter((c) => c.type === "hard").length;
  const soft = policy.criteria.length - hard;

  return (
    <motion.div
      className="gl-read__inner"
      initial={reduce ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0 } : { duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
    >
      <header>
        <div className="gl-eyebrow gl-doc__eyebrow">Policy · pinned {policy.version_hash}</div>
        <h1 className="gl-doc__title">{label ?? policy.procedure}</h1>
        <div className="gl-doc__sub">{policy.source}</div>
        <div className="gl-pc__chips">
          <span className="gl-chip">{policy.criteria.length} criteria</span>
          <span className="gl-chip">{hard} hard</span>
          <span className="gl-chip">{soft} soft</span>
        </div>
      </header>

      <div className="gl-block">
        <SectionRule label="Criteria" index="§1" meta={policy.procedure} />
        <div className="gl-crits">
          {policy.criteria.map((c, i) => (
            <CriterionCard key={c.id} c={c} n={i + 1} reduce={!!reduce} />
          ))}
        </div>
      </div>
    </motion.div>
  );
}

function CriterionCard({ c, n, reduce }: { c: Criterion; n: number; reduce: boolean }) {
  const low = c.confidence < 0.5;
  const ctxLabel = c.logic === "any_of" ? "Any of" : "Context";
  return (
    <motion.div
      className="gl-crit"
      data-type={c.type}
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0 } : { duration: 0.28, delay: Math.min(n * 0.03, 0.3), ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="gl-crit__head">
        <span className={`gl-crit__type gl-crit__type--${c.type}`}>
          <span className="gl-crit__sq" aria-hidden />
          {c.type}
        </span>
        <span className="gl-crit__logic">{c.logic}</span>
        <span className="gl-crit__ref">{c.clause_ref}</span>
        <span className="gl-crit__spacer" />
        {low && <span className="gl-crit__flag">low confidence</span>}
      </div>

      <p className="gl-crit__text">{c.text}</p>

      <blockquote className="gl-crit__quote">“{c.quote}”</blockquote>

      <div className="gl-crit__facts">
        {c.threshold && (
          <span className="gl-crit__threshold">
            threshold {c.threshold.op} {c.threshold.value}
            {c.threshold.unit && <span className="gl-value__unit"> {c.threshold.unit}</span>}
          </span>
        )}
        {c.needs.length > 0 && <span className="gl-crit__needs">needs: {c.needs.join(" · ")}</span>}
      </div>

      {c.context_conditions.length > 0 && (
        <div className="gl-ctx">
          <span className="gl-ctx__label">{ctxLabel}</span>
          {c.context_conditions.map((cond) => (
            <span key={cond} className="gl-chip gl-chip--accent">
              {cond}
            </span>
          ))}
        </div>
      )}
    </motion.div>
  );
}
