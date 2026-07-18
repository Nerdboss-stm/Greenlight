import { useEffect, useState } from "react";
import { LiveScreen } from "./screens/LiveScreen";
import { EvalScreen } from "./screens/EvalScreen";

/** Two planes sharing one engine. Hash routing keeps it dependency-free:
 *  `#evals` → the Eval Plane, anything else → the Live Plane. */
export function App() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const plane = hash.replace(/^#\/?/, "");
  return plane === "evals" ? <EvalScreen /> : <LiveScreen />;
}
