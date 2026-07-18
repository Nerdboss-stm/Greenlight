interface PlaneNavProps {
  active: "live" | "evals";
}

/** The plane switcher in the rail — Live ↔ Evals, styled as a squared toggle. */
export function PlaneNav({ active }: PlaneNavProps) {
  return (
    <nav className="gl-planenav" aria-label="planes">
      <a href="#" data-active={active === "live"}>
        Live
      </a>
      <a href="#evals" data-active={active === "evals"}>
        Evals
      </a>
    </nav>
  );
}
