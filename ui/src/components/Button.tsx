import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** default = ghost (ink border) · primary = solid ink · go = solid green ("green light") */
  variant?: "default" | "primary" | "go";
  /** leading square marker (the "go" light) */
  dot?: boolean;
  children: ReactNode;
}

/** Squared button, 1px ink border. Primary/go get a confident solid fill — no gradient, no glow. */
export function Button({ variant = "default", dot = false, children, className, ...rest }: ButtonProps) {
  const classes = ["gl-btn", variant !== "default" ? `gl-btn--${variant}` : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button className={classes} {...rest}>
      {dot && <span className="gl-btn__dot" />}
      {children}
    </button>
  );
}
