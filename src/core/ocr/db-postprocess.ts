// ============================================================
// VLESS — DB (Differentiable Binarization) post-processing
//
// Turns PP-OCR detection's probability map [1,1,H,W] into text-region
// quadrilaterals in *source-image* pixels. Faithful re-implementation of
// PaddleOCR's DBPostProcess.boxes_from_bitmap:
//   binarize → connected components → min-area box (get_mini_boxes) →
//   mean-probability score filter → unclip → re-fit → scale back.
//
// Connected components use flood fill (8-connectivity). We only keep each
// component's *boundary* pixels for the convex hull — the min-area rect is a
// property of the hull, so interior pixels are redundant.
// ============================================================

import type { Point, RotatedRect } from "./geometry";
import {
  minAreaRect,
  unclipRect,
  orderQuadClockwise,
  boundingBox,
} from "./geometry";

export interface DetBox {
  quad: [Point, Point, Point, Point];
  score: number;
}

export interface DbConfig {
  /** Probability threshold to binarize the map. */
  thresh: number;
  /** Minimum mean-probability inside a box to keep it. */
  boxThresh: number;
  /** Vatti-style expansion ratio applied after scoring. */
  unclipRatio: number;
  /** Minimum box side (px, in map space) to keep. */
  minSize: number;
  /** Cap on number of components examined. */
  maxCandidates: number;
}

export const DEFAULT_DB_CONFIG: DbConfig = {
  thresh: 0.3,
  boxThresh: 0.6,
  unclipRatio: 1.5,
  minSize: 3,
  maxCandidates: 1000,
};

/** Mean probability inside a convex quad (PaddleOCR box_score_fast). */
function boxScoreFast(
  prob: Float32Array,
  mapW: number,
  mapH: number,
  quad: Point[],
): number {
  const bb = boundingBox(quad);
  const x0 = Math.max(0, Math.floor(bb.x));
  const y0 = Math.max(0, Math.floor(bb.y));
  const x1 = Math.min(mapW - 1, Math.ceil(bb.x + bb.w));
  const y1 = Math.min(mapH - 1, Math.ceil(bb.y + bb.h));
  if (x1 < x0 || y1 < y0) return 0;

  // Precompute edge normals for a convex point-in-polygon test. A point is
  // inside iff the signed area of every edge→point triple shares one sign.
  const n = quad.length;
  let sum = 0;
  let count = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let sign = 0;
      let inside = true;
      for (let i = 0; i < n; i++) {
        const [ax, ay] = quad[i];
        const [bx, by] = quad[(i + 1) % n];
        const cp = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
        if (cp !== 0) {
          const s = cp > 0 ? 1 : -1;
          if (sign === 0) sign = s;
          else if (s !== sign) {
            inside = false;
            break;
          }
        }
      }
      if (inside) {
        sum += prob[y * mapW + x];
        count++;
      }
    }
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Flood-fill label the binarized map and, for each component, collect its
 * boundary pixels (a foreground pixel with at least one 4-neighbour that is
 * background or off-grid). Returns one point array per component.
 */
function connectedComponentsBoundaries(
  bin: Uint8Array,
  w: number,
  h: number,
): Point[][] {
  const labeled = new Uint8Array(w * h);
  const comps: Point[][] = [];
  const stack: number[] = [];

  for (let start = 0; start < w * h; start++) {
    if (bin[start] === 0 || labeled[start] === 1) continue;
    const boundary: Point[] = [];
    stack.push(start);
    labeled[start] = 1;

    while (stack.length > 0) {
      const idx = stack.pop() as number;
      const x = idx % w;
      const y = (idx - x) / w;

      // Boundary test on the 4-neighbourhood.
      const isBoundary =
        x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
        bin[idx - 1] === 0 || bin[idx + 1] === 0 ||
        bin[idx - w] === 0 || bin[idx + w] === 0;
      if (isBoundary) boundary.push([x, y]);

      // Enqueue 8-connected foreground neighbours.
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const nidx = ny * w + nx;
          if (bin[nidx] === 1 && labeled[nidx] === 0) {
            labeled[nidx] = 1;
            stack.push(nidx);
          }
        }
      }
    }
    if (boundary.length >= 4) comps.push(boundary);
  }
  return comps;
}

/**
 * Extract text-region quads from a detection probability map.
 * @param prob   Float32Array of length mapW*mapH, values in [0,1].
 * @param scaleX srcWidth  / mapWidth  (map→source x scale).
 * @param scaleY srcHeight / mapHeight (map→source y scale).
 */
export function boxesFromBitmap(
  prob: Float32Array,
  mapW: number,
  mapH: number,
  scaleX: number,
  scaleY: number,
  srcW: number,
  srcH: number,
  cfg: DbConfig = DEFAULT_DB_CONFIG,
): DetBox[] {
  const bin = new Uint8Array(mapW * mapH);
  for (let i = 0; i < bin.length; i++) bin[i] = prob[i] > cfg.thresh ? 1 : 0;

  const comps = connectedComponentsBoundaries(bin, mapW, mapH);
  const boxes: DetBox[] = [];

  for (const pts of comps) {
    if (boxes.length >= cfg.maxCandidates) break;

    const rect = minAreaRect(pts);
    if (!rect) continue;
    if (Math.min(rect.size[0], rect.size[1]) < cfg.minSize) continue;

    const score = boxScoreFast(prob, mapW, mapH, rect.corners);
    if (score < cfg.boxThresh) continue;

    const expanded: RotatedRect = unclipRect(rect, cfg.unclipRatio);
    if (Math.min(expanded.size[0], expanded.size[1]) < cfg.minSize + 2) continue;

    // Scale to source pixels and order TL,TR,BR,BL.
    const scaled = expanded.corners.map(
      ([x, y]) =>
        [
          Math.max(0, Math.min(srcW, Math.round(x * scaleX))),
          Math.max(0, Math.min(srcH, Math.round(y * scaleY))),
        ] as Point,
    );
    boxes.push({ quad: orderQuadClockwise(scaled), score });
  }
  return boxes;
}
