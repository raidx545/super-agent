// ============================================================
// VLESS — Offscreen ML Host (entrypoint)
// The only context allowed to touch WebGPU / OffscreenCanvas / heavy
// WASM. Exposes the ML runtime to the service worker over the RPC bus.
// ============================================================

// FIRST import, deliberately. Pins ORT's wasm path to the packaged runtime
// before @huggingface/transformers can default it to a jsdelivr CDN URL.
// Moving this below any ORT consumer re-introduces the initWasm failure.
import "../../core/runtime/ort-env";

import { serveOffscreen } from "../../core/runtime/messaging";
import { detectBackend } from "../../core/runtime/backend";
import { getModelStatuses, warmModels } from "../../core/runtime/model-host";
import { runOcr } from "../../core/ocr/ocr-engine";
import { redactScreenshot, verifyRedactionOffscreen, detectFacesOffscreen } from "../../core/privacy/offscreen-redact";
import { perceiveScreen, groundPhrase } from "../../core/perception/florence2-engine";

serveOffscreen({
  ping: () => ({ pong: true as const, ts: Date.now() }),
  detectBackend: () => detectBackend(),
  getModelStatuses: () => getModelStatuses(),
  warmModels: ({ ids }) => warmModels(ids),
  runOcr: (params) => runOcr(params),
  redactScreenshot: (params) => redactScreenshot(params.imageDataUrl, params.regions),
  detectFaces: (params) =>
    detectFacesOffscreen(params.imageDataUrl, params.viewportWidth, params.viewportHeight),
  verifyRedaction: (params) => verifyRedactionOffscreen(params.imageDataUrl),
  perceiveScreen: (params) => perceiveScreen(params.imageDataUrl),
  groundPhrase: (params) => groundPhrase(params.imageDataUrl, params.phrase),
});

// Announce readiness in the offscreen console (visible via chrome://extensions
// → service worker "inspect views: offscreen.html").
// eslint-disable-next-line no-console
console.info("[VLESS] offscreen ML host ready");
