import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/components.css";
import "./styles/screen.css";
import "./styles/intake.css";
import "./styles/policy.css";
import "./styles/live.css";
import { LiveScreen } from "./screens/LiveScreen";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LiveScreen />
  </StrictMode>,
);
