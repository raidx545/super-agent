// ============================================================
// VLESS — Offscreen Redaction & Verification
// Runs in the offscreen document (has OffscreenCanvas + WebGPU).
// The service worker CANNOT do canvas operations — this module
// provides the redaction and re-OCR verification that the
// pipeline needs.
// ============================================================

import { runOcr } from "../ocr/ocr-engine";
import type { OcrResult } from "../../types/runtime";

// ── Types ────────────────────────────────────────────────────

interface RedactRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  strategy: "blur" | "black_box" | "pixelate" | "mask_text";
}

export async function redactScreenshot(
  imageDataUrl: string,
  regions: RedactRegion[],
  viewportWidth?: number,
  viewportHeight?: number
): Promise<{ imageDataUrl: string; regionsRedacted: number }> {
  // Decode the image
  const response = await fetch(imageDataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  const width = bitmap.width;
  const height = bitmap.height;

  // Compute High-DPI / DevicePixelRatio scaling factors
  const scaleX = viewportWidth && viewportWidth > 0 ? width / viewportWidth : 1;
  const scaleY = viewportHeight && viewportHeight > 0 ? height / viewportHeight : 1;

  // Create canvas and draw original
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  let regionsRedacted = 0;

  for (const region of regions) {
    const x = Math.max(0, Math.round(region.x * scaleX));
    const y = Math.max(0, Math.round(region.y * scaleY));
    const w = Math.min(Math.round(region.width * scaleX), width - x);
    const h = Math.min(Math.round(region.height * scaleY), height - y);

    if (w <= 0 || h <= 0) continue;

    switch (region.strategy) {
      case "black_box":
        ctx.fillStyle = "#000000";
        ctx.fillRect(x, y, w, h);
        regionsRedacted++;
        break;

      case "blur":
        applyBoxBlur(ctx, x, y, w, h, 3);
        regionsRedacted++;
        break;

      case "pixelate":
        applyPixelate(ctx, x, y, w, h, 8);
        regionsRedacted++;
        break;

      case "mask_text":
        // Text masking is handled by CSS overlay in the DOM
        // For canvas, we just black-box it
        ctx.fillStyle = "#000000";
        ctx.fillRect(x, y, w, h);
        regionsRedacted++;
        break;
    }
  }

  // Convert back to data URL
  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  const outDataUrl = await blobToDataURL(outBlob);

  return { imageDataUrl: outDataUrl, regionsRedacted };
}

/**
 * Verify a redacted screenshot contains zero PII text.
 * Re-runs OCR on the redacted image and checks for residual PII patterns.
 */
export async function verifyRedactionOffscreen(
  imageDataUrl: string
): Promise<{
  passed: boolean;
  residualPII: number;
  wordsFound: number;
  ocrTimeMs: number;
}> {
  const t0 = performance.now();

  // Run OCR on the redacted image
  let ocrResult: OcrResult;
  try {
    ocrResult = await runOcr({ imageDataUrl, lang: "auto" });
  } catch {
    return {
      passed: false,
      residualPII: -1,
      wordsFound: 0,
      ocrTimeMs: performance.now() - t0,
    };
  }

  const ocrTimeMs = performance.now() - t0;

  // Check for residual PII in OCR output
  const PII_PATTERNS: RegExp[] = [
    /\b\d{4}\s?\d{4}\s?\d{4}\b/,           // Aadhaar
    /\b[A-Z]{5}\d{4}[A-Z]\b/,              // PAN
    /\b\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\b/,   // Card number
    /\b[A-Z]{4}0[A-Z0-9]{6}\b/,            // IFSC
    /\b[6-9]\d{9}\b/,                        // Phone
  ];

  let residualPII = 0;
  for (const word of ocrResult.words) {
    for (const pattern of PII_PATTERNS) {
      if (pattern.test(word.text)) {
        residualPII++;
        break;
      }
    }
  }

  return {
    passed: residualPII === 0,
    residualPII,
    wordsFound: ocrResult.words.length,
    ocrTimeMs,
  };
}

// ── Image Processing Helpers ─────────────────────────────────

/**
 * Multi-pass box blur (Gaussian approximation).
 * 3 passes approximates a Gaussian with sigma ≈ kernel_radius.
 */
function applyBoxBlur(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  passes: number
): void {
  // Read the region pixels
  const imageData = ctx.getImageData(x, y, w, h);
  const data = imageData.data;

  // Apply box blur multiple times
  for (let p = 0; p < passes; p++) {
    const temp = new Uint8ClampedArray(data);
    const radius = 3;

    for (let cy = 0; cy < h; cy++) {
      for (let cx = 0; cx < w; cx++) {
        let r = 0, g = 0, b = 0, count = 0;

        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
              const idx = (ny * w + nx) * 4;
              r += temp[idx];
              g += temp[idx + 1];
              b += temp[idx + 2];
              count++;
            }
          }
        }

        const idx = (cy * w + cx) * 4;
        data[idx] = r / count;
        data[idx + 1] = g / count;
        data[idx + 2] = b / count;
      }
    }
  }

  ctx.putImageData(imageData, x, y);
}

/**
 * Pixelate a region by averaging blocks.
 */
function applyPixelate(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  blockSize: number
): void {
  const imageData = ctx.getImageData(x, y, w, h);
  const data = imageData.data;

  for (let by = 0; by < h; by += blockSize) {
    for (let bx = 0; bx < w; bx += blockSize) {
      let r = 0, g = 0, b = 0, count = 0;

      // Average the block
      for (let dy = 0; dy < blockSize && by + dy < h; dy++) {
        for (let dx = 0; dx < blockSize && bx + dx < w; dx++) {
          const idx = ((by + dy) * w + (bx + dx)) * 4;
          r += data[idx];
          g += data[idx + 1];
          b += data[idx + 2];
          count++;
        }
      }

      r = Math.round(r / count);
      g = Math.round(g / count);
      b = Math.round(b / count);

      // Fill the block with the average color
      for (let dy = 0; dy < blockSize && by + dy < h; dy++) {
        for (let dx = 0; dx < blockSize && bx + dx < w; dx++) {
          const idx = ((by + dy) * w + (bx + dx)) * 4;
          data[idx] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
        }
      }
    }
  }

  ctx.putImageData(imageData, x, y);
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
