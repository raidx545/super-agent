// ============================================================
// VLESS — Redaction Engine
// Pixel-level canvas manipulation to redact PII from screenshots
//
// Strategies:
// - blur: Gaussian blur (faces, backgrounds)
// - black_box: Solid black box (passwords, secrets, IDs)
// - pixelate: Pixelation (moderate sensitivity)
// - mask_text: Replace text with asterisks (for DOM text)
// - overlay: CSS overlay (for DOM elements in-page)
//
// This is 20% of the SIH evaluation score — precision matters.
// ============================================================

import type { PIIRegion, RedactionStrategy } from "./pii-detector";

// ── Types ────────────────────────────────────────────────────

export interface RedactionResult {
  redactedCanvas: HTMLCanvasElement;
  redactionMap: RedactionMapEntry[];
  stats: {
    totalRegions: number;
    redactedRegions: number;
    skippedRegions: number;
    pixelsAffected: number;
    totalPixels: number;
    redactionPercentage: number;
    strategyBreakdown: Record<RedactionStrategy, number>;
    processingTimeMs: number;
  };
}

export interface RedactionMapEntry {
  regionId: string;
  category: string;
  strategy: RedactionStrategy;
  boundingBox: { x: number; y: number; width: number; height: number };
  pixelsRedacted: number;
  wasRedacted: boolean;
  skipReason?: string;
}

// ── Main Redaction Pipeline ──────────────────────────────────

/**
 * Redact PII regions from a canvas screenshot.
 * Returns a NEW canvas (never modifies the original).
 */
export function redactPII(
  sourceCanvas: HTMLCanvasElement,
  piiRegions: PIIRegion[]
): RedactionResult {
  const startTime = performance.now();

  // Create output canvas (copy of source)
  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = sourceCanvas.width;
  outputCanvas.height = sourceCanvas.height;
  const outputCtx = outputCanvas.getContext("2d")!;

  // Draw original
  outputCtx.drawImage(sourceCanvas, 0, 0);

  const redactionMap: RedactionMapEntry[] = [];
  const strategyBreakdown: Record<RedactionStrategy, number> = {
    blur: 0,
    black_box: 0,
    pixelate: 0,
    mask_text: 0,
    overlay: 0,
    none: 0,
  };

  let totalPixelsAffected = 0;
  let skippedRegions = 0;

  // Process regions sorted by sensitivity (critical first)
  const sortedRegions = [...piiRegions].sort((a, b) => {
    const sensitivityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    return sensitivityOrder[a.sensitivity] - sensitivityOrder[b.sensitivity];
  });

  for (const region of sortedRegions) {
    if (!region.boundingBox) {
      // No bounding box — can't redact visually
      redactionMap.push({
        regionId: region.id,
        category: region.category,
        strategy: "none",
        boundingBox: { x: 0, y: 0, width: 0, height: 0 },
        pixelsRedacted: 0,
        wasRedacted: false,
        skipReason: "No bounding box — use DOM redaction instead",
      });
      skippedRegions++;
      continue;
    }

    const bb = region.boundingBox;
    const strategy = region.redactionStrategy;

    if (strategy === "none" || strategy === "overlay") {
      redactionMap.push({
        regionId: region.id,
        category: region.category,
        strategy,
        boundingBox: bb,
        pixelsRedacted: 0,
        wasRedacted: false,
        skipReason: strategy === "none" ? "Low sensitivity — no redaction" : "DOM overlay strategy",
      });
      strategyBreakdown[strategy]++;
      continue;
    }

    // Apply redaction strategy
    try {
      const pixelsRedacted = applyRedaction(outputCtx, bb, strategy);
      totalPixelsAffected += pixelsRedacted;

      redactionMap.push({
        regionId: region.id,
        category: region.category,
        strategy,
        boundingBox: bb,
        pixelsRedacted,
        wasRedacted: true,
      });

      strategyBreakdown[strategy]++;
    } catch (error) {
      redactionMap.push({
        regionId: region.id,
        category: region.category,
        strategy,
        boundingBox: bb,
        pixelsRedacted: 0,
        wasRedacted: false,
        skipReason: `Redaction failed: ${error}`,
      });
      skippedRegions++;
    }
  }

  const totalPixels = sourceCanvas.width * sourceCanvas.height;

  return {
    redactedCanvas: outputCanvas,
    redactionMap,
    stats: {
      totalRegions: piiRegions.length,
      redactedRegions: piiRegions.length - skippedRegions,
      skippedRegions,
      pixelsAffected: totalPixelsAffected,
      totalPixels,
      redactionPercentage: totalPixels > 0
        ? (totalPixelsAffected / totalPixels) * 100
        : 0,
      strategyBreakdown,
      processingTimeMs: performance.now() - startTime,
    },
  };
}

// ── Strategy Implementations ─────────────────────────────────

function applyRedaction(
  ctx: CanvasRenderingContext2D,
  bbox: { x: number; y: number; width: number; height: number },
  strategy: RedactionStrategy
): number {
  // Clamp to canvas bounds
  const x = Math.max(0, Math.round(bbox.x));
  const y = Math.max(0, Math.round(bbox.y));
  const w = Math.min(ctx.canvas.width - x, Math.round(bbox.width));
  const h = Math.min(ctx.canvas.height - y, Math.round(bbox.height));

  if (w <= 0 || h <= 0) return 0;

  switch (strategy) {
    case "blur":
      return applyGaussianBlur(ctx, x, y, w, h);
    case "black_box":
      return applyBlackBox(ctx, x, y, w, h);
    case "pixelate":
      return applyPixelate(ctx, x, y, w, h);
    case "mask_text":
      return applyTextMask(ctx, x, y, w, h);
    default:
      return 0;
  }
}

// ── Gaussian Blur ────────────────────────────────────────────

function applyGaussianBlur(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number
): number {
  const imageData = ctx.getImageData(x, y, w, h);
  const data = imageData.data;
  const radius = Math.max(3, Math.min(Math.floor(Math.min(w, h) / 4), 15));

  // Build real Gaussian kernel
  const kernelSize = radius * 2 + 1;
  const kernel = new Float32Array(kernelSize);
  const sigma = radius / 3;
  let sum = 0;
  for (let i = 0; i < kernelSize; i++) {
    const x = i - radius;
    kernel[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    sum += kernel[i];
  }
  for (let i = 0; i < kernelSize; i++) kernel[i] /= sum;

  // Separable Gaussian: horizontal then vertical
  const temp = new Uint8ClampedArray(data.length);

  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < kernelSize; k++) {
        const nx = Math.min(w - 1, Math.max(0, col + k - radius));
        const idx = (row * w + nx) * 4;
        const weight = kernel[k];
        r += data[idx] * weight;
        g += data[idx + 1] * weight;
        b += data[idx + 2] * weight;
        a += data[idx + 3] * weight;
      }
      const idx = (row * w + col) * 4;
      temp[idx] = r;
      temp[idx + 1] = g;
      temp[idx + 2] = b;
      temp[idx + 3] = a;
    }
  }

  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < kernelSize; k++) {
        const ny = Math.min(h - 1, Math.max(0, row + k - radius));
        const idx = (ny * w + col) * 4;
        const weight = kernel[k];
        r += temp[idx] * weight;
        g += temp[idx + 1] * weight;
        b += temp[idx + 2] * weight;
        a += temp[idx + 3] * weight;
      }
      const idx = (row * w + col) * 4;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = a;
    }
  }

  ctx.putImageData(imageData, x, y);
  return w * h;
}

// ── Black Box ────────────────────────────────────────────────

function applyBlackBox(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number
): number {
  ctx.fillStyle = "#000000";
  ctx.fillRect(x, y, w, h);

  // Add subtle label for debug (optional, removed in production)
  // ctx.fillStyle = "#333333";
  // ctx.font = "12px monospace";
  // ctx.fillText("[REDACTED]", x + 4, y + h / 2 + 4);

  return w * h;
}

// ── Pixelate ─────────────────────────────────────────────────

function applyPixelate(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number
): number {
  // Determine pixel size based on region size
  const pixelSize = Math.max(4, Math.min(Math.floor(Math.min(w, h) / 8), 20));

  // Get image data
  const imageData = ctx.getImageData(x, y, w, h);
  const data = imageData.data;

  // Pixelate: average each block
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

      // Fill the block with the average color
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
  return w * h;
}

// ── Text Mask (for visual text redaction) ────────────────────

function applyTextMask(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number
): number {
  // Fill with gray background
  ctx.fillStyle = "#cccccc";
  ctx.fillRect(x, y, w, h);

  // Draw asterisks over the text
  ctx.fillStyle = "#666666";
  const fontSize = Math.max(10, Math.min(h * 0.6, 24));
  ctx.font = `${fontSize}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const maskText = "*".repeat(Math.floor(w / (fontSize * 0.6)));
  ctx.fillText(maskText, x + w / 2, y + h / 2);

  return w * h;
}

// ── DOM Overlay Redaction ────────────────────────────────────

/**
 * Generate CSS to overlay on sensitive DOM elements.
 * Inject this into the page to visually redact without modifying screenshots.
 */
export function generateDOMRedactionCSS(
  piiRegions: PIIRegion[]
): string {
  const rules: string[] = [];

  for (const region of piiRegions) {
    if (!region.fieldSelector || region.redactionStrategy === "none") continue;

    const selector = region.fieldSelector;
    const strategy = region.redactionStrategy;

    switch (strategy) {
      case "blur":
        rules.push(`${selector} { filter: blur(8px); transition: filter 0.3s; }`);
        rules.push(`${selector}:hover { filter: blur(4px); }`);
        break;
      case "black_box":
        rules.push(`${selector} { 
          color: transparent !important; 
          background-color: #000 !important;
          text-shadow: none !important;
          -webkit-text-fill-color: transparent !important;
        }`);
        rules.push(`${selector}::placeholder { color: transparent !important; }`);
        break;
      case "pixelate":
        rules.push(`${selector} { filter: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><filter id='p'><feFlood x='4' y='4' height='2' width='2'/><feComposite width='8' height='8'/><feTile result='a'/><feComposite in='SourceGraphic' in2='a' operator='in'/><feMorphology operator='dilate' radius='4'/></filter></svg>#p"); }`);
        break;
      case "mask_text":
        rules.push(`${selector} { 
          color: transparent !important;
          -webkit-text-fill-color: transparent !important;
          text-shadow: 0 0 8px #666 !important;
        }`);
        break;
    }
  }

  return rules.join("\n");
}

// ── Diff Visualization ───────────────────────────────────────

/**
 * Generate a diff image showing what was redacted.
 * Green = unchanged, Red = redacted region.
 */
export function generateRedactionDiff(
  originalCanvas: HTMLCanvasElement,
  redactedCanvas: HTMLCanvasElement,
  piiRegions: PIIRegion[]
): HTMLCanvasElement {
  const width = originalCanvas.width;
  const height = originalCanvas.height;

  const diffCanvas = document.createElement("canvas");
  diffCanvas.width = width;
  diffCanvas.height = height;
  const ctx = diffCanvas.getContext("2d")!;

  // Draw redacted version as base
  ctx.drawImage(redactedCanvas, 0, 0);

  // Draw green outlines around redacted regions
  ctx.strokeStyle = "#22c55e";
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);

  for (const region of piiRegions) {
    if (!region.boundingBox || region.redactionStrategy === "none") continue;

    const bb = region.boundingBox;
    ctx.strokeRect(bb.x, bb.y, bb.width, bb.height);

    // Label
    ctx.setLineDash([]);
    ctx.fillStyle = "#22c55e";
    ctx.font = "bold 11px monospace";
    ctx.fillText(
      `${region.category.toUpperCase()} [${region.sensitivity}]`,
      bb.x + 2,
      bb.y - 4
    );
    ctx.setLineDash([4, 4]);
  }

  return diffCanvas;
}
