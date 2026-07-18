import { motion, useReducedMotion } from "motion/react";
import type { CriterionStatus } from "./types";
import { STATUS_HEX } from "./types";

interface TagProps {
  label: string;
  status: CriterionStatus;
  /** clause reference, e.g. "NCD 240.2 §A" */
  clauseRef?: string;
  /** hard | soft — printed to the right */
  kind?: "hard" | "soft";
  active?: boolean;
  onClick?: () => void;
}

/** A criterion: bordered tag with a small status square (NOT a pill, NOT emoji).
 *  The square cross-fades color when a counterfactual re-run flips the status. */
export function Tag({ label, status, clauseRef, kind, active, onClick }: TagProps) {
  const reduce = useReducedMotion();
  return (
    <button
      type="button"
      className="gl-tag"
      data-status={status}
      data-active={active ? "true" : "false"}
      onClick={onClick}
    >
      <motion.span
        className="gl-square"
        aria-hidden
        animate={{ backgroundColor: STATUS_HEX[status] }}
        transition={reduce ? { duration: 0 } : { duration: 0.45, ease: "easeInOut" }}
      />
      <span className="gl-tag__body">
        <span className="gl-tag__label">{label}</span>
        {clauseRef && <span className="gl-tag__ref">{clauseRef}</span>}
      </span>
      {kind && <span className="gl-tag__kind">{kind}</span>}
    </button>
  );
}
