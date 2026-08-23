#!/usr/bin/env node
// ============================================================
// VLESS — copy ORT WASM runtime into public/ort/
//
// We import `onnxruntime-web/webgpu` (the ".bundle." build inlines the
// JS loader glue), so at runtime ORT only needs to fetch the wasm binary
// from env.wasm.wasmPaths. We ship the *jsep* binary: one superset that
// runs the WebGPU EP when an adapter exists and CPU/WASM kernels otherwise
// — covering tiers A→C with a single file. Copied into public/ so WXT
// bundles it; loaded via chrome.runtime.getURL('ort/').
//
// Idempotent: skips when the destination already matches by byte size.
// ============================================================

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdirSync, existsSync, statSync, copyFileSync } from "node:fs";

const require = createRequire(import.meta.url);
// ALL wasm variants, not just jsep.
//
// We import `onnxruntime-web/webgpu` (jsep), but @huggingface/transformers
// depends on `onnxruntime-web` too, and the bundler collapses both into ONE
// ORT instance in the offscreen chunk. Whichever variant that shared instance
// resolves to — asyncify, jspi, or the plain build — is fetched from
// env.wasm.wasmPaths, which we point at `ort/`. Shipping only jsep meant that
// lookup 404'd, initWasm() rejected, ORT cached the rejection, and every later
// call reported "previous call to 'initWasm()' failed".
//
// These are fetched lazily: only the one variant actually needed is ever
// downloaded at runtime, so the cost is unpacked size, not load time.
// Resolve via the package's own export map (package.json is not exported).
const ASSETS = [
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.asyncify.wasm",
  "ort-wasm-simd-threaded.jspi.wasm",
  "ort-wasm-simd-threaded.wasm",
];
const distDir = dirname(require.resolve(`onnxruntime-web/${ASSETS[0]}`));
const outDir = join(import.meta.dirname, "..", "public", "ort");

mkdirSync(outDir, { recursive: true });

let copied = 0;
for (const name of ASSETS) {
  const src = join(distDir, name);
  const dst = join(outDir, name);
  if (!existsSync(src)) {
    // Variant sets differ across ORT releases; only the first is required.
    if (name === ASSETS[0]) {
      console.error(`  MISSING ${src} — is onnxruntime-web installed?`);
      process.exitCode = 1;
    } else {
      console.log(`  skip  ${name} (not in this ORT build)`);
    }
    continue;
  }
  const srcSize = statSync(src).size;
  if (existsSync(dst) && statSync(dst).size === srcSize) {
    console.log(`  ok    ${name} (${srcSize} B)`);
    continue;
  }
  copyFileSync(src, dst);
  console.log(`  copy  ${name} (${srcSize} B)`);
  copied++;
}
console.log(`ORT runtime ready in public/ort/ (${copied} copied)`);
