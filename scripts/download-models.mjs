#!/usr/bin/env node
// ============================================================
// VLESS — Model Downloader
// Downloads ONNX models for on-device visual perception
// Run: node scripts/download-models.mjs
// ============================================================

import { mkdirSync, existsSync, statSync } from "fs";
import { join } from "path";

const MODEL_DIR = join(import.meta.dirname, "..", "public", "models");
const PP OCR_DIR = join(MODEL_DIR, "ppocr");

const MODELS = [
  {
    name: "PaddleOCR Detection",
    dir: PP_OCR_DIR,
    filename: "det.onnx",
    url: "https://github.com/nickmuchi/paddleocr-onnx/raw/main/models/det.onnx",
    size: "~2.4MB",
  },
  {
    name: "PaddleOCR Recognition",
    dir: PP_OCR_DIR,
    filename: "rec.onnx",
    url: "https://github.com/nickmuchi/paddleocr-onnx/raw/main/models/rec.onnx",
    size: "~8.5MB",
  },
  {
    name: "UI Element Detector",
    dir: MODEL_DIR,
    filename: "ui-detector.onnx",
    url: null, // Custom model — placeholder
    size: "~25MB",
  },
];

async function downloadModel(model) {
  if (!model.url) {
    console.log(`⏭️  ${model.name} — custom model, place manually at ${join(model.dir, model.filename)}`);
    return;
  }

  const dest = join(model.dir, model.filename);

  if (existsSync(dest)) {
    const stat = statSync(dest);
    if (stat.size > 1000) {
      console.log(`✅ ${model.name} — already downloaded (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
      return;
    }
  }

  console.log(`⬇️  Downloading ${model.name} (${model.size})...`);

  try {
    const response = await fetch(model.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const { writeFileSync } = await import("fs");
    writeFileSync(dest, buffer);

    console.log(`✅ ${model.name} — downloaded (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);
  } catch (error) {
    console.error(`❌ ${model.name} — download failed: ${error.message}`);
    console.log(`   Manual download: ${model.url}`);
    console.log(`   Place at: ${dest}`);
  }
}

async function main() {
  console.log("🐾 VLESS — Model Downloader\n");

  // Create directories
  mkdirSync(MODEL_DIR, { recursive: true });
  mkdirSync(PP_OCR_DIR, { recursive: true });

  for (const model of MODELS) {
    await downloadModel(model);
  }

  console.log("\n📦 Model directory structure:");
  console.log(`   public/models/`);
  console.log(`   ├── ppocr/`);
  console.log(`   │   ├── det.onnx`);
  console.log(`   │   └── rec.onnx`);
  console.log(`   └── ui-detector.onnx`);
  console.log("\n💡 For the demo, DOM extraction handles 90% of pages.");
  console.log("   Models are only needed for visual fallback (canvas apps, PDFs).");
}

main().catch(console.error);
