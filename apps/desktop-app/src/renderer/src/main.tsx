import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { createPreviewApi, createShellApi } from "./lib/shell-api";
import "./styles/global.css";

// `pnpm dev:web` alone has no Tauri host; render a preview instead of failing.
const isTauri = "__TAURI_INTERNALS__" in window;
window.voltoShell = isTauri ? createShellApi() : createPreviewApi();

const container = document.getElementById("root");
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// Diagnostics for the smoke harness: report what this surface rendered so the
// desktop evidence can show the settings UI really mounted. Harmless outside a
// smoke run (the report just stays in memory).
if (isTauri) {
  window.setTimeout(() => {
    void import("@tauri-apps/api/core")
      .then(({ invoke }) =>
        invoke("report_ui", {
          report: {
            title: document.title,
            text: document.body.innerText.slice(0, 800),
            buttons: [...document.querySelectorAll("button")]
              .map((button) => (button.textContent ?? "").trim())
              .filter(Boolean)
              .slice(0, 30),
          },
        }),
      )
      .catch((error: unknown) => console.error("report_ui", error));
  }, 1200);
}