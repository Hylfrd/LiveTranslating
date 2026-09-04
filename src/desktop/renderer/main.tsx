import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { LogApp } from "./LogApp.js";
import { OverlayApp } from "./OverlayApp.js";
import { createPreviewBridge } from "./preview-bridge.js";
import "./styles.css";

if (!window.liveTranslating && new URLSearchParams(window.location.search).get("preview") === "1") {
  Object.defineProperty(window, "liveTranslating", {
    configurable: false,
    value: createPreviewBridge(),
  });
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing renderer root element");
}

const surface = new URLSearchParams(window.location.search).get("surface");
document.documentElement.dataset.surface = surface === "compact" ? "compact" : surface === "logs" ? "logs" : "main";
document.documentElement.dataset.preview = new URLSearchParams(window.location.search).get("preview") === "1"
  ? "true"
  : "false";

createRoot(root).render(
  <React.StrictMode>
    {surface === "compact" ? <OverlayApp /> : surface === "logs" ? <LogApp /> : <App />}
  </React.StrictMode>,
);
