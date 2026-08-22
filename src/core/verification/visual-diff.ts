// ============================================================
// VLESS — Visual Diff Engine
// Pixel-level comparison of screenshots before/after actions
// Proves the agent's action worked — or detects failures
// ============================================================

export interface VisualDiffResult {
  changed: boolean;
  changedRegions: ChangedRegion[];
  totalChangedPixels: number;
  changePercentage: number;
  unexpectedChanges: string[];
  verificationPassed: boolean;
}

export interface ChangedRegion {
  boundingBox: { x: number; y: number; width: number; height: number };
  beforeHash: string;
  afterHash: string;
  expected: boolean; // Was this change expected?
  confidence: number;
}

// ── Visual Diff Engine ───────────────────────────────────────

export class VisualDiffEngine {
  private pixelThreshold = 30; // Min RGB difference to count as changed
  private regionMinSize = 20; // Min region size in pixels

  /**
   * Compare two canvas screenshots and return what changed.
   */
  async compare(
    before: HTMLCanvasElement,
    after: HTMLCanvasElement,
    expectedChanges?: { regions: { x: number; y: number; width: number; height: number }[] }
  ): Promise<VisualDiffResult> {
    // Ensure same dimensions
    if (before.width !== after.width || before.height !== after.height) {
      return {
        changed: true,
        changedRegions: [],
        totalChangedPixels: -1,
        changePercentage: 100,
        unexpectedChanges: ["Screenshots have different dimensions"],
        verificationPassed: false,
      };
    }

    // Get pixel data
    const beforeCtx = before.getContext("2d")!;
    const afterCtx = after.getContext("2d")!;
    const width = before.width;
    const height = before.height;

    const beforeData = beforeCtx.getImageData(0, 0, width, height);
    const afterData = afterCtx.getImageData(0, 0, width, height);

    // Create diff map
    const diffMap = new Uint8Array(width * height);
    let totalChangedPixels = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;

        const rDiff = Math.abs(beforeData.data[idx] - afterData.data[idx]);
        const gDiff = Math.abs(beforeData.data[idx + 1] - afterData.data[idx + 1]);
        const bDiff = Math.abs(beforeData.data[idx + 2] - afterData.data[idx + 2]);

        if (rDiff > this.pixelThreshold || gDiff > this.pixelThreshold || bDiff > this.pixelThreshold) {
          diffMap[y * width + x] = 1;
          totalChangedPixels++;
        }
      }
    }

    // Find connected regions of change
    const regions = this.findChangedRegions(diffMap, width, height);

    // Mark expected vs unexpected
    const changedRegions: ChangedRegion[] = regions.map((region) => {
      const expected = expectedChanges?.regions.some((ec) =>
        this.regionsOverlap(region.boundingBox, ec)
      ) ?? false;

      return {
        boundingBox: region.boundingBox,
        beforeHash: region.beforeHash,
        afterHash: region.afterHash,
        expected,
        confidence: expected ? 0.95 : 0.7,
      };
    });

    const totalPixels = width * height;
    const changePercentage = (totalChangedPixels / totalPixels) * 100;

    // Determine unexpected changes
    const unexpectedChanges: string[] = [];
    const unexpectedRegions = changedRegions.filter((r) => !r.expected);

    if (unexpectedRegions.length > 0) {
      unexpectedChanges.push(
        `${unexpectedRegions.length} unexpected change(s) detected`
      );
    }

    // New modals/dialogs
    if (changePercentage > 30 && changePercentage < 80) {
      unexpectedChanges.push("Significant page change — possible navigation or modal");
    }

    // Page went blank
    if (changePercentage > 90) {
      unexpectedChanges.push("Page appears to have cleared or navigated");
    }

    // Verification passes if: changes occurred AND no unexpected changes
    const verificationPassed = totalChangedPixels > 0 && unexpectedChanges.length === 0;

    return {
      changed: totalChangedPixels > 0,
      changedRegions,
      totalChangedPixels,
      changePercentage,
      unexpectedChanges,
      verificationPassed,
    };
  }

  /**
   * Generate a visual diff image (for debug overlay).
   */
  async generateDiffImage(
    before: HTMLCanvasElement,
    after: HTMLCanvasElement
  ): Promise<HTMLCanvasElement> {
    const width = before.width;
    const height = before.height;

    const diffCanvas = document.createElement("canvas");
    diffCanvas.width = width;
    diffCanvas.height = height;
    const ctx = diffCanvas.getContext("2d")!;

    const beforeCtx = before.getContext("2d")!;
    const afterCtx = after.getContext("2d")!;
    const beforeData = beforeCtx.getImageData(0, 0, width, height);
    const afterData = afterCtx.getImageData(0, 0, width, height);
    const diffData = ctx.createImageData(width, height);

    for (let i = 0; i < beforeData.data.length; i += 4) {
      const rDiff = Math.abs(beforeData.data[i] - afterData.data[i]);
      const gDiff = Math.abs(beforeData.data[i + 1] - afterData.data[i + 1]);
      const bDiff = Math.abs(beforeData.data[i + 2] - afterData.data[i + 2]);
      const totalDiff = rDiff + gDiff + bDiff;

      if (totalDiff > this.pixelThreshold * 3) {
        // Changed pixel — show in red
        diffData.data[i] = 255;
        diffData.data[i + 1] = 50;
        diffData.data[i + 2] = 50;
        diffData.data[i + 3] = 200;
      } else {
        // Unchanged pixel — show as dimmed
        diffData.data[i] = afterData.data[i] * 0.3;
        diffData.data[i + 1] = afterData.data[i + 1] * 0.3;
        diffData.data[i + 2] = afterData.data[i + 2] * 0.3;
        diffData.data[i + 3] = 100;
      }
    }

    ctx.putImageData(diffData, 0, 0);
    return diffCanvas;
  }

  // ── Region Detection ──────────────────────────────────

  private findChangedRegions(
    diffMap: Uint8Array,
    width: number,
    height: number
  ): {
    boundingBox: { x: number; y: number; width: number; height: number };
    beforeHash: string;
    afterHash: string;
  }[] {
    const visited = new Uint8Array(width * height);
    const regions: {
      boundingBox: { x: number; y: number; width: number; height: number };
      beforeHash: string;
      afterHash: string;
    }[] = [];

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (diffMap[idx] && !visited[idx]) {
          // Flood fill to find connected region
          const region = this.floodFill(diffMap, visited, x, y, width, height);

          if (region.width >= this.regionMinSize && region.height >= this.regionMinSize) {
            regions.push({
              boundingBox: region,
              beforeHash: `hash-${region.x}-${region.y}`,
              afterHash: `hash-${region.x}-${region.y}-changed`,
            });
          }
        }
      }
    }

    return regions;
  }

  private floodFill(
    diffMap: Uint8Array,
    visited: Uint8Array,
    startX: number,
    startY: number,
    width: number,
    height: number
  ): { x: number; y: number; width: number; height: number } {
    const stack = [{ x: startX, y: startY }];
    let minX = startX, maxX = startX, minY = startY, maxY = startY;

    while (stack.length > 0) {
      const { x, y } = stack.pop()!;
      const idx = y * width + x;

      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      if (visited[idx] || !diffMap[idx]) continue;

      visited[idx] = 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);

      stack.push({ x: x + 1, y });
      stack.push({ x: x - 1, y });
      stack.push({ x, y: y + 1 });
      stack.push({ x, y: y - 1 });
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    };
  }

  private regionsOverlap(
    a: { x: number; y: number; width: number; height: number },
    b: { x: number; y: number; width: number; height: number }
  ): boolean {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width);
    const y2 = Math.min(a.y + a.height, b.y + b.height);

    const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const minArea = Math.min(a.width * a.height, b.width * b.height);

    return minArea > 0 && intersection / minArea > 0.3;
  }
}

// ── Singleton ────────────────────────────────────────────────

let instance: VisualDiffEngine | null = null;

export function getVisualDiffEngine(): VisualDiffEngine {
  if (!instance) {
    instance = new VisualDiffEngine();
  }
  return instance;
}
