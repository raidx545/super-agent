// ============================================================
// VLESS — Offscreen ML Host (entrypoint)
// The only context allowed to touch WebGPU / OffscreenCanvas / heavy
// WASM. Exposes the ML runtime to the service worker over the RPC bus.
// ============================================================

import { serveOffscreen } from "../../core/runtime/messaging";
import { detectBackend } from "../../core/runtime/backend";
import { getModelStatuses, warmModels } from "../../core/runtime/model-host";
import { runOcr } from "../../core/ocr/ocr-engine";
import { redactScreenshot, verifyRedactionOffscreen } from "../../core/privacy/offscreen-redact";

serveOffscreen({
  ping: () => ({ pong: true as const, ts: Date.now() }),
  detectBackend: () => detectBackend(),
  getModelStatuses: () => getModelStatuses(),
  warmModels: ({ ids }) => warmModels(ids),
  runOcr: (params) => runOcr(params),
  redactScreenshot: (params) => redactScreenshot(params.imageDataUrl, params.regions),
  verifyRedaction: (params) => verifyRedactionOffscreen(params.imageDataUrl),
});

// Announce readiness in the offscreen console (visible via chrome://extensions
// → service worker "inspect views: offscreen.html").
// eslint-disable-next-line no-console
console.info("[VLESS] offscreen ML host ready");
