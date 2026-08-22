// ============================================================
// VLESS — OCR geometry primitives (pure, dependency-free)
//
// Everything DB post-processing needs to turn a blob of pixels into a
// tight, unclipped text quadrilateral, plus the homography solver used
// to warp a rotated quad into an upright recognition strip.
//
// Faithful to PaddleOCR's DBPostProcess: get_mini_boxes (min-area rect
// via rotating calipers) and unclip (offset a box outward by
// d = area * ratio / perimeter).
// ============================================================

export type Point = [number, number];

/** A rotated rectangle described by its centre, orthonormal axis (u; v is
 *  u rotated +90°) and full side lengths along each axis. */
export interface RotatedRect {
  center: Point;
  /** Unit vector of the first (width) axis. */
  axis: Point;
  /** Full side lengths [alongU, alongV]. */
  size: [number, number];
  /** Corners ordered as produced by rotating calipers (not yet TL-first). */
  corners: [Point, Point, Point, Point];
}

export function polygonArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export function polygonPerimeter(pts: Point[]): number {
  let p = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    p += Math.hypot(x2 - x1, y2 - y1);
  }
  return p;
}

const cross = (o: Point, a: Point, b: Point): number =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Andrew's monotone-chain convex hull. Returns CCW, no repeated endpoint. */
export function convexHull(points: Point[]): Point[] {
  const pts = points.slice().sort((p, q) => (p[0] - q[0]) || (p[1] - q[1]));
  if (pts.length < 3) return pts;

  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Minimum-area enclosing rectangle via rotating calipers over the hull edges.
 * The optimal rectangle is always collinear with a hull edge, so we test each
 * edge as the width axis and keep the smallest-area bounding box.
 */
export function minAreaRect(points: Point[]): RotatedRect | null {
  const hull = convexHull(points);
  if (hull.length < 2) return null;

  let best: RotatedRect | null = null;
  let bestArea = Infinity;

  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    let ex = b[0] - a[0];
    let ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) continue;
    ex /= len;
    ey /= len; // unit edge (width axis u)
    // normal v = u rotated +90°
    const nx = -ey;
    const ny = ex;

    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const du = p[0] * ex + p[1] * ey;
      const dv = p[0] * nx + p[1] * ny;
      if (du < minU) minU = du;
      if (du > maxU) maxU = du;
      if (dv < minV) minV = dv;
      if (dv > maxV) maxV = dv;
    }
    const w = maxU - minU;
    const h = maxV - minV;
    const area = w * h;
    if (area >= bestArea) continue;
    bestArea = area;

    // Reconstruct corners: an orthonormal basis {u, v} means a point with
    // projections (pu, pv) is pu*u + pv*v.
    const corner = (pu: number, pv: number): Point => [pu * ex + pv * nx, pu * ey + pv * ny];
    best = {
      center: corner((minU + maxU) / 2, (minV + maxV) / 2),
      axis: [ex, ey],
      size: [w, h],
      corners: [
        corner(minU, minV),
        corner(maxU, minV),
        corner(maxU, maxV),
        corner(minU, maxV),
      ],
    };
  }
  return best;
}

/** Order four points clockwise starting from the top-left corner —
 *  the layout PaddleOCR's get_rotate_crop_image expects: [TL, TR, BR, BL]. */
export function orderQuadClockwise(pts: Point[]): [Point, Point, Point, Point] {
  const s = pts.slice().sort((a, b) => a[0] - b[0]);
  const left = s.slice(0, 2).sort((a, b) => a[1] - b[1]); // by y: top, bottom
  const right = s.slice(2, 4).sort((a, b) => a[1] - b[1]);
  const [tl, bl] = left;
  const [tr, br] = right;
  return [tl, tr, br, bl];
}

/**
 * Expand a rotated rectangle outward by the PaddleOCR unclip distance
 * d = area * ratio / perimeter. For a rectangle this pushes every edge out by
 * d (each side length grows by 2d), which matches pyclipper's offset followed
 * by a re-fit of the min-area rect.
 */
export function unclipRect(rect: RotatedRect, ratio: number): RotatedRect {
  const [w, h] = rect.size;
  const area = w * h;
  const perimeter = 2 * (w + h);
  if (perimeter < 1e-9) return rect;
  const d = (area * ratio) / perimeter;
  const w2 = w + 2 * d;
  const h2 = h + 2 * d;
  const [ex, ey] = rect.axis;
  const nx = -ey;
  const ny = ex;
  const [cx, cy] = rect.center;
  const hw = w2 / 2;
  const hh = h2 / 2;
  const corner = (su: number, sv: number): Point => [
    cx + su * hw * ex + sv * hh * nx,
    cy + su * hw * ey + sv * hh * ny,
  ];
  return {
    center: rect.center,
    axis: rect.axis,
    size: [w2, h2],
    corners: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
  };
}

/**
 * Solve the 3×3 homography H mapping src[i] → dst[i] for 4 correspondences,
 * returning the 9 row-major entries (h22 fixed at 1). Gaussian elimination on
 * the 8×8 system. Used to perspective-warp a text quad into an upright strip.
 */
export function solveHomography(src: Point[], dst: Point[]): number[] | null {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    }
    if (Math.abs(A[pivot][col]) < 1e-12) return null;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    const pv = A[col][col];
    for (let j = col; j < 8; j++) A[col][j] /= pv;
    b[col] /= pv;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (f === 0) continue;
      for (let j = col; j < 8; j++) A[r][j] -= f * A[col][j];
      b[r] -= f * b[col];
    }
  }
  return [b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], 1];
}

export function boundingBox(pts: Point[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
