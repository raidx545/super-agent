// ============================================================
// VLESS — Screenshot Redactor
// Takes a screenshot data URL + PII regions, returns redacted version.
// Uses OffscreenCanvas for service worker compatibility.
//
// This is what actually blurs faces and blacks out passwords
// in the captured screenshot before sending to the server.
// ============================================================

import type { PIIRegion } from "./pii-detector";

// ── Types ────────────────────────────────────────────────────

export interface RedactedScreenshot {
  dataUrl: string;
  width: number;
  height: number;
  regionsRedacted: number;
  totalPixelsAffected: number;
  processingTimeMs: number;
}

// ── Main Function ────────────────────────────────────────────

/**
 * Redact PII regions from a screenshot.
 * Takes a data URL, applies blur/black-box/pixelate to PII regions,
 * returns a new data URL with redactions applied.
 */
export async function redactScreenshot(
  screenshotDataUrl: string,
  piiRegions: PIIRegion[]
): Promise<RedactedScreenshot> {
  const startTime = performance.now();

  // Filter to regions with bounding boxes and non-none strategies
  const actionableRegions = piiRegions.filter(
    (r) => r.boundingBox && r.redactionStrategy !== "none" && r.redactionStrategy !== "overlay"
  );

  if (actionableRegions.length === 0) {
    return {
      dataUrl: screenshotDataUrl,
      width: 0,
      height: 0,
      regionsRedacted: 0,
      totalPixelsAffected: 0,
      processingTimeMs: 0,
    };
  }

  // Load the screenshot into an ImageBitmap
  const response = await fetch(screenshotDataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  const width = bitmap.width;
  const height = bitmap.height;

  // Create OffscreenCanvas for redaction
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;

  // Draw original screenshot
  ctx.drawImage(bitmap, 0, 0);

  let totalPixelsAffected = 0;
  let regionsRedacted = 0;

  // Apply redaction to each region
  for (const region of actionableRegions) {
    const bb = region.boundingBox;

    // Clamp to canvas bounds (bb is guaranteed non-null by filter above)
    const bx = bb!;
    const x = Math.max(0, Math.round(bx.x));
    const y = Math.max(0, Math.round(bx.y));
    const w = Math.min(width - x, Math.round(bx.width));
    const h = Math.min(height - y, Math.round(bx.height));

    if (w <= 0 || h <= 0) continue;

    switch (region.redactionStrategy) {
      case "blur":
        applyGaussianBlur(ctx, x, y, w, h, 8);
        break;
      case "black_box":
        ctx.fillStyle = "#000000";
        ctx.fillRect(x, y, w, h);
        break;
      case "pixelate":
        applyPixelate(ctx, x, y, w, h);
        break;
      case "mask_text":
        // Gray overlay with asterisks
        ctx.fillStyle = "#cccccc";
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = "#666666";
        const fontSize = Math.max(10, Math.min(h * 0.6, 24));
        ctx.font = `${fontSize}px monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const maskText = "*".repeat(Math.max(1, Math.floor(w / (fontSize * 0.6))));
        ctx.fillText(maskText, x + w / 2, y + h / 2);
        break;
    }

    totalPixelsAffected += w * h;
    regionsRedacted++;
  }

  // Convert back to data URL
  const redactedBlob = await canvas.convertToBlob({ type: "image/png", quality: 0.9 });
  const redactedDataUrl = await blobToDataUrl(redactedBlob);

  bitmap.close();

  return {
    dataUrl: redactedDataUrl,
    width,
    height,
    regionsRedacted,
    totalPixelsAffected,
    processingTimeMs: performance.now() - startTime,
  };
}

// ── Gaussian Blur ────────────────────────────────────────────

function applyGaussianBlur(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number
): void {
  // Clamp radius
  radius = Math.min(radius, Math.max(3, Math.floor(Math.min(w, h) / 4)));

  // Get pixel data
  const imageData = ctx.getImageData(x, y, w, h);
  const data = imageData.data;

  // Apply 3-pass box blur (approximates Gaussian)
  for (let pass = 0; pass < 3; pass++) {
    boxBlur(data, w, h, radius);
  }

  // Write back
  ctx.putImageData(imageData, x, y);
}

function boxBlur(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number
): void {
  // Horizontal pass
  const temp = new Uint8ClampedArray(data.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0, count = 0;

      for (let dx = -radius; dx <= radius; dx++) {
        const nx = Math.min(width - 1, Math.max(0, x + dx));
        const idx = (y * width + nx) * 4;
        r += data[idx];
        g += data[idx + 1];
        b += data[idx + 2];
        a += data[idx + 3];
        count++;
      }

      const idx = (y * width + x) * 4;
      temp[idx] = r / count;
      temp[idx + 1] = g / count;
      temp[idx + 2] = b / count;
      temp[idx + 3] = a / count;
    }
  }

  // Vertical pass
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0, count = 0;

      for (let dy = -radius; dy <= radius; dy++) {
        const ny = Math.min(height - 1, Math.max(0, y + dy));
        const idx = (ny * width + x) * 4;
        r += temp[idx];
        g += temp[idx + 1];
        b += temp[idx + 2];
        a += temp[idx + 3];
        count++;
      }

      const idx = (y * width + x) * 4;
      data[idx] = r / count;
      data[idx + 1] = g / count;
      data[idx + 2] = b / count;
      data[idx + 3] = a / count;
    }
  }
}

// ── Pixelate ─────────────────────────────────────────────────

function applyPixelate(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const pixelSize = Math.max(4, Math.min(Math.floor(Math.min(w, h) / 8), 20));

  const imageData = ctx.getImageData(x, y, w, h);
  const data = imageData.data;

  for (let by = 0; by < h; by += pixelSize) {
    for (let bx = 0; bx < w; bx += pixelSize) {
      let r = 0, g = 0, b = 0, a = 0, count = 0;

      // Average the block
      for (let dy = 0; dy < pixelSize && by + dy < h; dy++) {
        for (let dx = 0; dx < pixelSize && bx + dx < w; dx++) {
          const idx = ((by + dy) * w + (bx + dx)) * 4;
          r += data[idx];
          g += data[idx + 1];
          b += data[idx + 2];
          a += data[idx + 3];
          count++;
        }
      }

      r = Math.round(r / count);
      g = Math.round(g / count);
      b = Math.round(b / count);
      a = Math.round(a / count);

      // Fill block
      for (let dy = 0; dy < pixelSize && by + dy < h; dy++) {
        for (let dx = 0; dx < pixelSize && bx + dx < w; dx++) {
          const idx = ((by + dy) * w + (bx + dx)) * 4;
          data[idx] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
          data[idx + 3] = a;
        }
      }
    }
  }

  ctx.putImageData(imageData, x, y);
}

// ── Utilities ────────────────────────────────────────────────

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
