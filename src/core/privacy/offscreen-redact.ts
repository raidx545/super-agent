// ============================================================
// VLESS — Offscreen Redaction & Verification
// Runs in the offscreen document (has OffscreenCanvas + WebGPU).
// The service worker CANNOT do canvas operations — this module
// provides the redaction and re-OCR verification that the
// pipeline needs.
// ============================================================

import { runOcr } from "../ocr/ocr-engine";
import { scanTextForPII } from "./pii-detector";
import { detectFaces, type FaceMethod } from "./face-detector";
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
  ran: boolean;
  unavailableReason?: string;
}> {
  const t0 = performance.now();

  // Run OCR on the redacted image
  let ocrResult: OcrResult;
  try {
    ocrResult = await runOcr({ imageDataUrl, lang: "auto" });
  } catch (err) {
    // OCR unavailable (models not downloaded, backend init failed) means
    // verification could not be ATTEMPTED. That is not the same as
    // verification failing, and must not be reported as residual PII —
    // the old `-1` rendered in the UI as "-1 PII regions residual".
    return {
      passed: false,
      residualPII: 0,
      wordsFound: 0,
      ocrTimeMs: performance.now() - t0,
      ran: false,
      unavailableReason: err instanceof Error ? err.message : "OCR unavailable",
    };
  }

  const ocrTimeMs = performance.now() - t0;

  // Check for residual PII using the same checksum-gated scanner as the
  // rest of the system. Bare regex here reported any 12-digit number left
  // on the page as a redaction failure.
  let residualPII = 0;
  for (const word of ocrResult.words) {
    if (scanTextForPII(word.text).length > 0) residualPII++;
  }

  return {
    passed: residualPII === 0,
    residualPII,
    wordsFound: ocrResult.words.length,
    ocrTimeMs,
    ran: true,
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

// ── Face detection (offscreen only) ──────────────────────────

/**
 * Find faces in a screenshot.
 *
 * This has to live offscreen: the service worker has no canvas and no
 * FaceDetector, which is why the pipeline previously called detectAllPII
 * with an undefined canvas and silently detected no faces at all — the
 * applicant photo on a government form went out unredacted.
 *
 * Boxes are returned in VIEWPORT (CSS) coordinates, because that is what
 * redactScreenshot expects; it re-applies the devicePixelRatio scale itself.
 */
export async function detectFacesOffscreen(
  imageDataUrl: string,
  viewportWidth?: number,
  viewportHeight?: number
): Promise<{
  faces: Array<{ x: number; y: number; width: number; height: number; confidence: number }>;
  method: FaceMethod;
  reason?: string;
}> {
  const response = await fetch(imageDataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  // A real <canvas>, not OffscreenCanvas: FaceDetector.detect() accepts
  // canvas elements across more Chrome builds than it does OffscreenCanvas.
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const { faces, method, reason } = await detectFaces(canvas);

  // Image pixels → viewport pixels.
  const sx = viewportWidth && viewportWidth > 0 ? canvas.width / viewportWidth : 1;
  const sy = viewportHeight && viewportHeight > 0 ? canvas.height / viewportHeight : 1;

  return {
    faces: faces.map((f) => ({
      x: f.x / sx,
      y: f.y / sy,
      width: f.width / sx,
      height: f.height / sy,
      confidence: f.confidence,
    })),
    method,
    reason,
  };
}
