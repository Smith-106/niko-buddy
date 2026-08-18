import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "@/components/error-boundary";
import "./index.css";
import "@/i18n";
import { warmClaudeCliTimeouts } from "@/lib/claude-cli-transport";

// C-101 (GRL-008): pull configurable CLI transport timeouts from app-state at
// startup. Non-blocking — defaults remain in effect until this resolves.
void warmClaudeCliTimeouts();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
