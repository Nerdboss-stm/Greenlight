import type { CriterionStatus } from "./types";

interface DataValueProps {
  value: string | number;
  unit?: string;
  /** large display treatment (e.g. hero metric) */
  size?: "sm" | "lg";
  /** tint by verdict/criterion status, or mute */
  tone?: CriterionStatus | "muted";
  /** for table cells that should right-align */
  className?: string;
}

/** A clinical value: monospaced, tabular figures, unit set apart. */
export function DataValue({ value, unit, size = "sm", tone, className }: DataValueProps) {
  const classes = [
    "gl-value",
    typeof value === "number" ? "gl-value--num" : "",
    size === "lg" ? "gl-value--lg" : "",
    tone ? `gl-value--${tone}` : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={classes}>
      {value}
      {unit && <span className="gl-value__unit">{unit}</span>}
    </span>
  );
}
