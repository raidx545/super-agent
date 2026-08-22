// ============================================================
// VLESS — OCR image preprocessing (offscreen only)
//
// Decode a captured screenshot, build the detection input tensor, and warp
// each detected quad into an upright recognition strip. Matches PaddleOCR:
//   det:  resize long side ≤ maxSide, snap both dims to a multiple of 32,
//         normalize (px/255 − mean)/std with ImageNet stats, NCHW RGB.
//   rec:  perspective-warp the quad to its natural size, rotate 90° CCW when
//         tall (vertical text), resize to a fixed height, normalize to [-1,1].
// ============================================================

import type { Point } from "./geometry";
import { solveHomography } from "./geometry";

const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];

export interface Capture {
  source: ImageData;
  width: number;
  height: number;
}

export interface DetInput {
  data: Float32Array; // [1,3,mapH,mapW]
  mapW: number;
  mapH: number;
  scaleX: number; // source/map
  scaleY: number;
}

/** Decode a data URL into full-resolution RGBA pixels via OffscreenCanvas. */
export async function loadCapture(imageDataUrl: string): Promise<Capture> {
  const blob = await (await fetch(imageDataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const width = bmp.width;
  const height = bmp.height;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2d context unavailable in offscreen document");
  ctx.drawImage(bmp, 0, 0);
  const source = ctx.getImageData(0, 0, width, height);
  bmp.close();
  return { source, width, height };
}

/** Round to the nearest positive multiple of 32 (PaddleOCR DetResizeForTest). */
function snap32(v: number): number {
  return Math.max(32, Math.round(v / 32) * 32);
}

/** Build the detection input tensor from the capture. */
export function buildDetInput(cap: Capture, maxSide: number): DetInput {
  const { width: srcW, height: srcH } = cap;
  const ratio = Math.min(1, maxSide / Math.max(srcW, srcH));
  const mapW = snap32(srcW * ratio);
  const mapH = snap32(srcH * ratio);

  // Resize the source into the det canvas (GPU-accelerated downscale).
  const canvas = new OffscreenCanvas(mapW, mapH);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2d context unavailable");
  const tmp = new OffscreenCanvas(srcW, srcH);
  const tctx = tmp.getContext("2d");
  if (!tctx) throw new Error("2d context unavailable");
  tctx.putImageData(cap.source, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(tmp, 0, 0, mapW, mapH);
  const { data } = ctx.getImageData(0, 0, mapW, mapH);

  const plane = mapW * mapH;
  const tensor = new Float32Array(3 * plane);
  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const p = (y * mapW + x) * 4;
      const o = y * mapW + x;
      tensor[o] = (data[p] / 255 - DET_MEAN[0]) / DET_STD[0]; // R
      tensor[plane + o] = (data[p + 1] / 255 - DET_MEAN[1]) / DET_STD[1]; // G
      tensor[2 * plane + o] = (data[p + 2] / 255 - DET_MEAN[2]) / DET_STD[2]; // B
    }
  }
  return { data: tensor, mapW, mapH, scaleX: srcW / mapW, scaleY: srcH / mapH };
}

const dist = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Bilinear RGB sample from RGBA source at fractional (x,y). Writes 3 bytes. */
function sampleRGB(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  x: number,
  y: number,
  out: Uint8ClampedArray,
  oi: number,
): void {
  if (x < 0) x = 0;
  else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0;
  else if (y > h - 1) y = h - 1;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0;
  const fy = y - y0;
  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4;
  const i11 = (y1 * w + x1) * 4;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  for (let c = 0; c < 3; c++) {
    out[oi + c] =
      src[i00 + c] * w00 + src[i10 + c] * w10 + src[i01 + c] * w01 + src[i11 + c] * w11;
  }
}

interface RgbBuffer {
  data: Uint8ClampedArray; // packed RGB, 3 bytes/px
  w: number;
  h: number;
}

/** Perspective-warp a source quad into an axis-aligned RGB buffer of its
 *  natural size, using the inverse homography (dst→src) with bilinear sampling. */
function warpQuad(cap: Capture, quad: Point[]): RgbBuffer | null {
  const [p0, p1, p2, p3] = quad; // TL,TR,BR,BL
  const w = Math.round(Math.max(dist(p0, p1), dist(p3, p2)));
  const h = Math.round(Math.max(dist(p0, p3), dist(p1, p2)));
  if (w < 1 || h < 1) return null;

  const dstRect: Point[] = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  // Hinv maps output-rect coords → source-image coords.
  const Hinv = solveHomography(dstRect, quad);
  if (!Hinv) return null;

  const src = cap.source.data;
  const out = new Uint8ClampedArray(w * h * 3);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const den = Hinv[6] * i + Hinv[7] * j + Hinv[8];
      const sx = (Hinv[0] * i + Hinv[1] * j + Hinv[2]) / den;
      const sy = (Hinv[3] * i + Hinv[4] * j + Hinv[5]) / den;
      sampleRGB(src, cap.width, cap.height, sx, sy, out, (j * w + i) * 3);
    }
  }
  return { data: out, w, h };
}

/** Rotate a packed-RGB buffer 90° counter-clockwise (PaddleOCR np.rot90). */
function rot90ccw(buf: RgbBuffer): RgbBuffer {
  const { data, w, h } = buf;
  const nw = h;
  const nh = w;
  const out = new Uint8ClampedArray(nw * nh * 3);
  // CCW: new[i, j] = old[j, W-1-i]  (new row i = column W-1-i of old, bottom→top)
  for (let ny = 0; ny < nh; ny++) {
    for (let nx = 0; nx < nw; nx++) {
      const ox = ny; // old column
      const oy = w - 1 - nx; // old row
      const oi = (oy * w + ox) * 3;
      const no = (ny * nw + nx) * 3;
      out[no] = data[oi];
      out[no + 1] = data[oi + 1];
      out[no + 2] = data[oi + 2];
    }
  }
  return { data: out, w: nw, h: nh };
}

/**
 * Warp a detected quad into a recognition tensor [1,3,recHeight,W], normalized
 * to [-1,1]. Returns null for degenerate quads. `W` is derived from the crop's
 * aspect ratio at the fixed height.
 */
export function cropRecStrip(
  cap: Capture,
  quad: Point[],
  recHeight: number,
): { data: Float32Array; width: number } | null {
  let crop = warpQuad(cap, quad);
  if (!crop) return null;
  if (crop.h >= crop.w * 1.5) crop = rot90ccw(crop); // vertical text → horizontal

  const outH = recHeight;
  const outW = Math.max(1, Math.round((outH * crop.w) / crop.h));
  const plane = outH * outW;
  const tensor = new Float32Array(3 * plane);

  const sx = crop.w / outW;
  const sy = crop.h / outH;
  const px = new Uint8ClampedArray(3);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      // Bilinear resize from the crop buffer (packed RGB) to (outW,outH).
      const fx = (x + 0.5) * sx - 0.5;
      const fy = (y + 0.5) * sy - 0.5;
      sampleRGBPacked(crop.data, crop.w, crop.h, fx, fy, px);
      const o = y * outW + x;
      tensor[o] = (px[0] / 255 - 0.5) / 0.5; // R
      tensor[plane + o] = (px[1] / 255 - 0.5) / 0.5; // G
      tensor[2 * plane + o] = (px[2] / 255 - 0.5) / 0.5; // B
    }
  }
  return { data: tensor, width: outW };
}

/** Bilinear sample from a packed-RGB buffer (3 bytes/px). */
function sampleRGBPacked(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  x: number,
  y: number,
  out: Uint8ClampedArray,
): void {
  if (x < 0) x = 0;
  else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0;
  else if (y > h - 1) y = h - 1;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0;
  const fy = y - y0;
  const i00 = (y0 * w + x0) * 3;
  const i10 = (y0 * w + x1) * 3;
  const i01 = (y1 * w + x0) * 3;
  const i11 = (y1 * w + x1) * 3;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  for (let c = 0; c < 3; c++) {
    out[c] = src[i00 + c] * w00 + src[i10 + c] * w10 + src[i01 + c] * w01 + src[i11 + c] * w11;
  }
}
