import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/components.css";
import "./styles/screen.css";
import "./styles/intake.css";
import "./styles/policy.css";
import { IntakeScreen } from "./screens/IntakeScreen";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <IntakeScreen />
  </StrictMode>,
);
