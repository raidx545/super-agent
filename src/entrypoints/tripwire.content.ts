// ============================================================
// VLESS — Tripwire injector (MAIN world)
//
// Separate entrypoint purely because of the execution world. The main
// content script runs ISOLATED, where `window.fetch` is a different
// object from the page's — patching it there observes nothing. This
// script runs in MAIN, so it patches the same `fetch` the page calls.
//
// It only observes. Blocking lives in `egress-guard.ts`, on traffic
// VLESS itself originates.
// ============================================================

import { defineContentScript } from "wxt/utils/define-content-script";
import { activateTripwire } from "../core/privacy/tripwire";

export default defineContentScript({
  matches: ["<all_urls>"],
  world: "MAIN",
  runAt: "document_start",

  main() {
    try {
      activateTripwire();
    } catch {
      // Never let monitoring break the host page.
    }
  },
});
