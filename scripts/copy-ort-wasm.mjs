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
import { mkdirSync, existsSync, statSync, copyFileSync, readdirSync } from "node:fs";

const require = createRequire(import.meta.url);
// Every runtime variant, and BOTH files each one needs.
//
// ORT loads a variant in two parts: the .wasm binary AND a .mjs loader glue
// module that it fetches with a dynamic import() from env.wasm.wasmPaths.
// Shipping only the .wasm produced:
//
//   TypeError: Failed to fetch dynamically imported module:
//   chrome-extension://<id>/ort/ort-wasm-simd-threaded.asyncify.mjs
//
// ...which surfaced as "no available backend found", because every execution
// provider needs that glue before it can register.
//
// We import `onnxruntime-web/webgpu` (jsep), but @huggingface/transformers
// depends on plain `onnxruntime-web`, and the bundler collapses both into one
// ORT instance. Which variant that instance asks for is not ours to predict,
// so ship them all. They are fetched lazily — only the pair actually used is
// ever read at runtime, so the cost is unpacked size, not startup time.
const VARIANTS = [
  "ort-wasm-simd-threaded.jsep",
  "ort-wasm-simd-threaded.asyncify",
  "ort-wasm-simd-threaded.jspi",
  "ort-wasm-simd-threaded",
];
const ASSETS = VARIANTS.flatMap((v) => [`${v}.wasm`, `${v}.mjs`]);
// Resolve via the package's own export map (package.json is not exported).
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

// A .wasm without its .mjs registers no execution provider at all, and the
// resulting error names neither file. Fail the build instead.
const shipped = new Set(readdirSync(outDir));
for (const name of shipped) {
  if (!name.endsWith(".wasm")) continue;
  const glue = name.replace(/\.wasm$/, ".mjs");
  if (!shipped.has(glue)) {
    console.error(`  FAIL  ${name} shipped without its loader glue ${glue}`);
    process.exitCode = 1;
  }
}
