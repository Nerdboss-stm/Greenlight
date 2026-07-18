export type CriterionStatus = "met" | "not_met" | "unknown";
export type Verdict = "approve" | "deny" | "insufficient";

/** Resolved hex for status squares — used where we animate color directly
 *  (Motion can't reliably tween CSS custom properties). */
export const STATUS_HEX: Record<CriterionStatus, string> = {
  met: "#2e6b45",
  not_met: "#9c3230",
  unknown: "#b0761b",
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  approve: "APPROVE",
  deny: "DENY",
  insufficient: "INSUFFICIENT",
};
