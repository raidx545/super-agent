#!/usr/bin/env node
// ============================================================
// VLESS — vendor the MediaPipe vision runtime + BlazeFace model
//
// Face detection must not depend on a CDN. The registry's model URL
// points at storage.googleapis.com, and MediaPipe's FilesetResolver
// defaults to jsdelivr — either would mean a third-party request on
// every cold start, in a tool whose claim is that nothing leaves the
// device. Both are copied into public/ and served from the extension.
//
// The .tflite is fetched once at setup time (build machine, not user
// machine) and committed to public/models/ by the download step.
// ============================================================

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdirSync, existsSync, statSync, copyFileSync, readdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve("@mediapipe/tasks-vision"));
const wasmDir = join(pkgDir, "wasm");
const outDir = join(import.meta.dirname, "..", "public", "mediapipe");

if (!existsSync(wasmDir)) {
  console.error("  MISSING @mediapipe/tasks-vision/wasm — is the package installed?");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

let copied = 0;
for (const name of readdirSync(wasmDir)) {
  const src = join(wasmDir, name);
  const dst = join(outDir, name);
  const size = statSync(src).size;
  if (existsSync(dst) && statSync(dst).size === size) {
    console.log(`  ok    ${name} (${size} B)`);
    continue;
  }
  copyFileSync(src, dst);
  copied++;
  console.log(`  copy  ${name} (${size} B)`);
}

console.log(`MediaPipe vision runtime ready in public/mediapipe/ (${copied} copied)`);
