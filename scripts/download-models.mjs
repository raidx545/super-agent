#!/usr/bin/env node
// ============================================================
// VLESS — Model Downloader (PP-OCR, provenance-locked)
//
// Source: https://huggingface.co/monkt/paddleocr-onnx  (Apache-2.0)
// Verified against the repo tree on 2026-08-22. Each entry pins the
// exact upstream byte size; a size mismatch aborts (the previously
// bundled det.onnx was a truncated 1.21 MB copy of the 2.43 MB file).
//
// Model choices (see REBUILD_PLAN P1):
//   det   PP-OCRv3_mobile_det  2.43 MB  — script-agnostic, light-weight
//                                          (v5 det is 88 MB server → rejected)
//   rec-en en_PP-OCRv5_mobile_rec 7.5 MB — output 438 classes
//   rec-hi devanagari_PP-OCRv3_mobile_rec 8.6 MB — output 169 classes
// Recognition input height is 48 (the model graph; the repo config.json
// says 32 and is WRONG — the ONNX input dim is a fixed 48).
// ============================================================

import { mkdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MODEL_DIR = join(import.meta.dirname, "..", "public", "models");
const BASE = "https://huggingface.co/monkt/paddleocr-onnx/resolve/main";

/** @type {{name:string, out:string, url:string, bytes:number, kind:"onnx"|"dict"}[]} */
const FILES = [
  {
    name: "PP-OCRv3 mobile detection",
    out: "ppocr-det-v3.onnx",
    url: `${BASE}/detection/v3/det.onnx`,
    bytes: 2429873,
    kind: "onnx",
  },
  {
    name: "PP-OCRv5 English recognition",
    out: "ppocr-rec-en.onnx",
    url: `${BASE}/languages/english/rec.onnx`,
    bytes: 7830888,
    kind: "onnx",
  },
  {
    name: "PP-OCRv3 Devanagari recognition",
    out: "ppocr-rec-hi.onnx",
    url: `${BASE}/languages/hindi/rec.onnx`,
    bytes: 8980224,
    kind: "onnx",
  },
  {
    name: "English char dictionary (ppocrv5_en_dict)",
    out: "ppocr-rec-en.dict.txt",
    url: `${BASE}/languages/english/dict.txt`,
    bytes: 1416,
    kind: "dict",
  },
  {
    name: "Devanagari char dictionary",
    out: "ppocr-rec-hi.dict.txt",
    url: `${BASE}/languages/hindi/dict.txt`,
    bytes: 508,
    kind: "dict",
  },
];

async function fetchBytes(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

async function getOne(f, force) {
  const dest = join(MODEL_DIR, f.out);
  if (!force && existsSync(dest) && statSync(dest).size === f.bytes) {
    console.log(`  ok    ${f.out} — present & correct (${f.bytes} B)`);
    return true;
  }
  process.stdout.write(`  get   ${f.out} … `);
  try {
    const buf = await fetchBytes(f.url);
    if (buf.length !== f.bytes) {
      console.log(`SIZE MISMATCH got ${buf.length} B, expected ${f.bytes} B — NOT written`);
      return false;
    }
    writeFileSync(dest, buf);
    console.log(`done (${buf.length} B)`);
    return true;
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    return false;
  }
}

async function main() {
  const force = process.argv.includes("--force");
  console.log("VLESS model downloader — source: monkt/paddleocr-onnx (Apache-2.0)");
  mkdirSync(MODEL_DIR, { recursive: true });
  let ok = 0;
  for (const f of FILES) if (await getOne(f, force)) ok++;
  console.log(`\n${ok}/${FILES.length} files ready in public/models/`);
  if (ok < FILES.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
