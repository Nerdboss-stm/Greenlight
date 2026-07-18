import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import type { Verdict } from "./types";
import { VERDICT_LABEL } from "./types";

interface DecisionBannerProps {
  verdict: Verdict;
  /** short seal block, e.g. case id + timestamp (mono) */
  seal?: ReactNode;
  /** the deterministic arbiter's one-line rationale */
  rationale?: ReactNode;
  /** bump to re-trigger the stamp animation on re-run */
  stampKey?: string | number;
  /** delay the stamp so it settles after the criteria on a full resolve */
  delay?: number;
}

/** The determination "stamp": uppercase, letterspaced, thin double-rule frame,
 *  settling into place (scale 1.04 -> 1). */
export function DecisionBanner({ verdict, seal, rationale, stampKey, delay = 0 }: DecisionBannerProps) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      key={stampKey}
      className="gl-stamp"
      initial={reduce ? false : { opacity: 0, scale: 1.04 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={reduce ? { duration: 0 } : { duration: 0.4, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="gl-stamp__head">
        <h2 className={`gl-stamp__word gl-stamp__word--${verdict}`}>{VERDICT_LABEL[verdict]}</h2>
        {seal && <div className="gl-stamp__seal">{seal}</div>}
      </div>
      {rationale && (
        <>
          <div className="gl-stamp__rule" />
          <div className="gl-stamp__rationale">{rationale}</div>
        </>
      )}
    </motion.div>
  );
}
