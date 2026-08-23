// ============================================================
// VLESS — ONNX Runtime environment pin
//
// MUST be imported before anything that touches ORT — directly or
// through @huggingface/transformers.
//
// WHY THIS EXISTS
// transformers.js sets, at module-init time:
//
//   ONNX_ENV.wasm.wasmPaths =
//     `https://cdn.jsdelivr.net/npm/@huggingface/transformers@X/dist/`
//
// ...whenever wasmPaths is not already set. Two consequences, both bad:
//
//   1. Correctness. Under MV3 the extension may not pull WebAssembly from
//      a remote origin, so initWasm() throws. ORT caches that rejection,
//      and every later caller — including OCR and redaction verification —
//      gets the useless "previous call to 'initWasm()' failed".
//
//   2. Privacy. A tool whose entire claim is "nothing leaves the device"
//      must not fetch its own inference runtime from a CDN. That is a
//      network request to a third party on every cold start.
//
// The transformers.js default is guarded by "if not already set", so the
// fix is simply to set it first. Importing this module for its side effect
// is what guarantees "first".
// ============================================================

import * as ort from "onnxruntime-web/webgpu";

let pinned = false;

/** Local, extension-packaged runtime directory. Never a remote origin. */
export function ortRuntimeUrl(): string {
  return chrome.runtime.getURL("ort/");
}

/**
 * Point ORT at the vendored runtime and fix threading. Idempotent, and safe
 * to call from multiple entry points — the first call is the one that counts.
 */
export function pinOrtEnv(): void {
  if (pinned) return;
  pinned = true;

  try {
    ort.env.wasm.wasmPaths = ortRuntimeUrl();

    // Threads need cross-origin isolation, which extension offscreen
    // documents do not have. SIMD carries the CPU path instead.
    const coi =
      typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true;
    const cores =
      (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 1;
    ort.env.wasm.numThreads = coi ? Math.max(1, Math.min(cores, 4)) : 1;
    ort.env.wasm.simd = true;
    ort.env.logLevel = "error";
  } catch {
    // Never let environment pinning break module import.
  }
}

// Side effect on import: this module's whole purpose is to win the race
// against transformers.js's CDN default.
pinOrtEnv();

/**
 * Explain why WebAssembly could not start, in terms the user can act on.
 * ORT reports a cached "previous call to initWasm() failed" that hides the
 * original cause, so probe the two things that actually go wrong.
 */
export async function diagnoseWasm(): Promise<string> {
  const notes: string[] = [];

  if (typeof WebAssembly === "undefined") {
    return "WebAssembly is unavailable in this context.";
  }

  // 1. Can we compile WASM at all? Catches a missing 'wasm-unsafe-eval'.
  try {
    // Smallest valid module: magic + version, no sections.
    new WebAssembly.Module(
      new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
    );
  } catch (e) {
    return (
      "WebAssembly compilation is blocked — add 'wasm-unsafe-eval' to " +
      `manifest content_security_policy.extension_pages (${String((e as Error)?.message).slice(0, 80)})`
    );
  }

  // 2. Is ORT looking at a remote origin? That is the transformers.js default.
  const paths = ort.env.wasm.wasmPaths;
  const asString = typeof paths === "string" ? paths : JSON.stringify(paths ?? null);
  notes.push(`wasmPaths=${asString}`);
  if (typeof paths === "string" && /^https?:\/\//i.test(paths) && !paths.startsWith(ortRuntimeUrl())) {
    return `ORT is pointed at a remote runtime (${paths}). It must use the packaged copy — import core/runtime/ort-env before any ORT consumer.`;
  }

  // 3. Is the binary actually reachable where ORT will look?
  const base = typeof paths === "string" && paths ? paths : ortRuntimeUrl();
  const candidates = [
    "ort-wasm-simd-threaded.jsep.wasm",
    "ort-wasm-simd-threaded.asyncify.wasm",
    "ort-wasm-simd-threaded.jspi.wasm",
    "ort-wasm-simd-threaded.wasm",
  ];
  const found: string[] = [];
  const missingGlue: string[] = [];
  for (const name of candidates) {
    try {
      const res = await fetch(base + name, { method: "HEAD" });
      if (!res.ok) continue;
      found.push(name);
      // ORT loads each variant in TWO parts: the .wasm binary and a .mjs
      // loader it pulls with a dynamic import(). A binary without its glue
      // fails as "Failed to fetch dynamically imported module", which ORT
      // then reports as the far less useful "no available backend found".
      const glue = name.replace(/\.wasm$/, ".mjs");
      try {
        const g = await fetch(base + glue, { method: "HEAD" });
        if (!g.ok) missingGlue.push(glue);
      } catch {
        missingGlue.push(glue);
      }
    } catch {
      /* unreachable — treated as missing */
    }
  }
  if (found.length === 0) {
    return `No ORT runtime binary is reachable under ${base}. Run \`pnpm setup:ort\` and rebuild. (${notes.join(", ")})`;
  }
  if (missingGlue.length > 0) {
    return `Runtime binaries are present but their loader modules are missing: ${missingGlue.join(", ")}. Each .wasm needs its matching .mjs — run \`pnpm setup:ort\` and rebuild.`;
  }

  return `WebAssembly looks usable (${found.length} runtime binaries at ${base}); the failure is elsewhere. ${notes.join(", ")}`;
}
