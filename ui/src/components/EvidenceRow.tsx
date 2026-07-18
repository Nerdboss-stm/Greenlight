import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

interface EvidenceRowProps {
  /** left column — the policy clause */
  clauseRef: string;
  clauseText: string;
  clauseSource?: string;
  /** right column — the patient data element */
  fieldPath: string;
  patientValue: ReactNode;
  patientSource?: string;
  /** bump to replay the meeting animation */
  replayKey?: string | number;
}

/** The emotional center: the exact policy clause and the exact patient data
 *  element face each other, joined by a thin rule — a citation meeting its source. */
export function EvidenceRow({
  clauseRef,
  clauseText,
  clauseSource,
  fieldPath,
  patientValue,
  patientSource,
  replayKey,
}: EvidenceRowProps) {
  const reduce = useReducedMotion();
  const ease = [0.16, 1, 0.3, 1] as const;

  return (
    <div className="gl-evidence" key={replayKey}>
      <motion.div
        className="gl-evidence__col"
        initial={reduce ? false : { opacity: 0, x: -26 }}
        animate={{ opacity: 1, x: 0 }}
        transition={reduce ? { duration: 0 } : { duration: 0.5, ease }}
      >
        <div className="gl-evidence__eyebrow">
          <span className="gl-eyebrow">Policy clause</span>
          <span className="gl-evidence__ref">{clauseRef}</span>
        </div>
        <p className="gl-evidence__clause">{clauseText}</p>
        {clauseSource && <div className="gl-evidence__source">{clauseSource}</div>}
      </motion.div>

      <div className="gl-evidence__join" aria-hidden>
        <motion.span
          className="gl-evidence__node"
          initial={reduce ? false : { scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={reduce ? { duration: 0 } : { duration: 0.3, delay: 0.42, ease }}
        />
      </div>

      <motion.div
        className="gl-evidence__col gl-evidence__patient"
        initial={reduce ? false : { opacity: 0, x: 26 }}
        animate={{ opacity: 1, x: 0 }}
        transition={reduce ? { duration: 0 } : { duration: 0.5, ease }}
      >
        <div className="gl-evidence__eyebrow">
          <span className="gl-eyebrow">Patient data</span>
        </div>
        <div className="gl-evidence__field">{fieldPath}</div>
        <div>{patientValue}</div>
        {patientSource && <div className="gl-evidence__source">{patientSource}</div>}
      </motion.div>
    </div>
  );
}
