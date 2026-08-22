#!/usr/bin/env node
// ============================================================
// VLESS — Model Downloader
// Downloads real PaddleOCR ONNX models for on-device vision
//
// Models from: https://huggingface.co/monkt/paddleocr-onnx
// License: Apache 2.0
//
// Run: node scripts/download-models.mjs
// ============================================================

import { mkdirSync, existsSync, statSync, writeFileSync } from "fs";
import { join } from "path";

const MODEL_DIR = join(import.meta.dirname, "..", "public", "models");

const MODELS = [
  {
    name: "PaddleOCR Detection v3 (2.3MB)",
    filename: "ppocr-det-v3.onnx",
    url: "https://huggingface.co/monkt/paddleocr-onnx/resolve/main/detection/v3/det.onnx",
    sizeMB: 2.3,
  },
  {
    name: "PaddleOCR English Recognition (7.5MB)",
    filename: "ppocr-rec-en.onnx",
    url: "https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/english/rec.onnx",
    sizeMB: 7.5,
  },
  {
    name: "PaddleOCR Hindi Recognition (8.6MB)",
    filename: "ppocr-rec-hi.onnx",
    url: "https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/hindi/rec.onnx",
    sizeMB: 8.6,
  },
];

async function downloadFile(url, dest) {
  console.log(`   Downloading from ${url}...`);

  // Follow redirects (HuggingFace LFS uses 302 redirects)
  let response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(dest, buffer);
  return buffer.length;
}

async function downloadModel(model) {
  const dest = join(MODEL_DIR, model.filename);

  if (existsSync(dest)) {
    const stat = statSync(dest);
    if (stat.size > 100_000) {
      console.log(`✅ ${model.name} — cached (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
      return true;
    }
  }

  console.log(`⬇️  ${model.name}...`);

  try {
    const bytes = await downloadFile(model.url, dest);
    console.log(`✅ ${model.name} — downloaded (${(bytes / 1024 / 1024).toFixed(1)}MB)`);
    return true;
  } catch (error) {
    console.error(`❌ ${model.name} — FAILED: ${error.message}`);
    console.log(`   Manual download: ${model.url}`);
    console.log(`   Place at: ${dest}\n`);
    return false;
  }
}

async function main() {
  console.log("🐾 VLESS — Model Downloader\n");
  console.log("Source: https://huggingface.co/monkt/paddleocr-onnx");
  console.log("License: Apache 2.0\n");

  mkdirSync(MODEL_DIR, { recursive: true });

  let success = 0;
  let total = MODELS.length;

  for (const model of MODELS) {
    const ok = await downloadModel(model);
    if (ok) success++;
  }

  console.log(`\n📦 Models: ${success}/${total} ready`);
  console.log(`   Location: ${MODEL_DIR}/`);

  if (success < total) {
    console.log("\n⚠️  Some models failed. The extension will work without them:");
    console.log("   - DOM extraction handles 95% of web pages");
    console.log("   - Vision models are only needed for canvas apps, PDFs, image-heavy pages");
  } else {
    console.log("\n🎉 All models ready! Full hybrid DOM+Vision perception available.");
  }
}

main().catch(console.error);
