import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/components.css";
import "./styles/screen.css";
import { DemoScreen } from "./DemoScreen";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DemoScreen />
  </StrictMode>,
);
