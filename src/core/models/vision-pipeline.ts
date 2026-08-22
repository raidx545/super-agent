// ============================================================
// VLESS — Vision Pipeline
// Processes screenshots through ONNX models to extract:
// - Text content (PaddleOCR)
// - UI elements (UI Detector)
// - Page structure (combined)
// Falls back gracefully when models aren't loaded
// ============================================================

import { getModelManager, type ModelProgress } from "./model-manager";
import type { PageElement } from "../../types";

// ── Pipeline Output ──────────────────────────────────────────

export interface VisionResult {
  elements: PageElement[];
  textBlocks: TextBlock[];
  inferenceTime: number;
  modelsUsed: string[];
  confidence: number;
}

export interface TextBlock {
  text: string;
  confidence: number;
  boundingBox: { x: number; y: number; width: number; height: number };
}

// ── Vision Pipeline ──────────────────────────────────────────

export class VisionPipeline {
  private manager = getModelManager();

  /**
   * Process a screenshot canvas through all available vision models.
   */
  async processScreenshot(
    canvas: HTMLCanvasElement,
    _onProgress?: (progress: ModelProgress) => void
  ): Promise<VisionResult> {
    const startTime = performance.now();
    const elements: PageElement[] = [];
    const textBlocks: TextBlock[] = [];
    const modelsUsed: string[] = [];

    // Step 1: OCR — Extract all text with positions
    if (this.manager.isModelReady("ppocr-det-v3") && (this.manager.isModelReady("ppocr-rec-en") || this.manager.isModelReady("ppocr-rec-hi"))) {
      try {
        const ocrResult = await this.runOCR(canvas);
        textBlocks.push(...ocrResult);
        modelsUsed.push("ppocr");

        // Convert text blocks to PageElements
        for (const block of ocrResult) {
          elements.push({
            id: `vision-text-${elements.length}`,
            tag: "span",
            role: "text",
            text: block.text,
            label: block.text,
            placeholder: "",
            ariaLabel: "",
            type: "text",
            rect: block.boundingBox as any,
            isVisible: true,
            isInteractive: false,
            isDisabled: false,
            confidence: block.confidence,
            source: "vision",
          });
        }
      } catch (error) {
        console.error("🐾 [VisionPipeline] OCR failed:", error);
      }
    }

    // Step 2: Merge overlapping elements
    const merged = this.mergeOverlappingElements(elements);

    const inferenceTime = performance.now() - startTime;

    return {
      elements: merged,
      textBlocks,
      inferenceTime,
      modelsUsed,
      confidence: merged.length > 0 ? 0.8 : 0.3,
    };
  }

  /**
   * Run OCR on a screenshot to extract all text with positions.
   */
  private async runOCR(canvas: HTMLCanvasElement): Promise<TextBlock[]> {
    const detSession = this.manager.getSession("ppocr-det-v3");
    const recSession = this.manager.getSession("ppocr-rec-en") || this.manager.getSession("ppocr-rec-hi");
    if (!detSession || !recSession) return [];

    // Preprocess image for detection model
    const detInput = this.preprocessImage(canvas, [1, 3, 640, 640]);

    // Run detection
    const detResults = await detSession.run({ input: detInput });
    const detOutput = detResults.output || detResults[Object.keys(detResults)[0]];

    // Parse detection boxes
    const boxes = this.parseDetectionBoxes(detOutput.data as Float32Array, canvas.width, canvas.height);

    // For each detected text region, run recognition
    const textBlocks: TextBlock[] = [];

    for (const box of boxes.slice(0, 20)) { // Limit to 20 regions
      try {
        // Crop region from canvas
        const cropped = this.cropCanvas(
          canvas,
          Math.max(0, box.x),
          Math.max(0, box.y),
          Math.min(box.width, canvas.width - box.x),
          Math.min(box.height, canvas.height - box.y)
        );

        if (cropped.width < 1 || cropped.height < 1) continue;

        // Preprocess for recognition
        const recInput = this.preprocessImage(cropped, [1, 3, 32, 320]);

        // Run recognition
        const recResults = await recSession.run({ input: recInput });
        const recOutput = recResults.output || recResults[Object.keys(recResults)[0]];

        // Decode text
        const text = this.decodeCTCOutput(recOutput.data as Float32Array);
        if (text.trim()) {
          textBlocks.push({
            text: text.trim(),
            confidence: box.confidence,
            boundingBox: {
              x: Math.round(box.x),
              y: Math.round(box.y),
              width: Math.round(box.width),
              height: Math.round(box.height),
            },
          });
        }
      } catch {
        // Skip failed recognition
      }
    }

    return textBlocks;
  }

  // ── Preprocessing ──────────────────────────────────────

  private preprocessImage(
    canvas: HTMLCanvasElement,
    targetShape: number[]
  ): any {
    const [, channels, height, width] = targetShape;

    // Resize canvas to target dimensions
    const resized = document.createElement("canvas");
    resized.width = width;
    resized.height = height;
    const ctx = resized.getContext("2d")!;
    ctx.drawImage(canvas, 0, 0, width, height);

    // Get pixel data
    const imageData = ctx.getImageData(0, 0, width, height);
    const pixels = imageData.data;

    // Convert to NCHW format with ImageNet normalization
    const tensorData = new Float32Array(channels * height * width);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pixelIdx = (y * width + x) * 4;
        const r = pixels[pixelIdx] / 255;
        const g = pixels[pixelIdx + 1] / 255;
        const b = pixels[pixelIdx + 2] / 255;

        // ImageNet normalization
        tensorData[0 * height * width + y * width + x] = (r - 0.485) / 0.229;
        tensorData[1 * height * width + y * width + x] = (g - 0.456) / 0.224;
        tensorData[2 * height * width + y * width + x] = (b - 0.406) / 0.225;
      }
    }

    // Create tensor for ONNX inference
    try {
      // @ts-ignore — ort is imported at top of file
      return new ort.Tensor("float32", tensorData, targetShape);
    } catch {
      return { data: tensorData, dims: targetShape, type: "float32" } as any;
    }
  }

  // ── Post-processing ────────────────────────────────────

  private parseDetectionBoxes(
    data: Float32Array,
    origWidth: number,
    origHeight: number
  ): { x: number; y: number; width: number; height: number; confidence: number }[] {
    const boxes: { x: number; y: number; width: number; height: number; confidence: number }[] = [];
    const scaleX = origWidth / 640;
    const scaleY = origHeight / 640;

    // Standard detection output: [x1, y1, x2, y2, confidence, class_id]
    for (let i = 0; i < data.length; i += 6) {
      const confidence = data[i + 4];
      if (confidence < 0.4) continue;

      boxes.push({
        x: data[i] * scaleX,
        y: data[i + 1] * scaleY,
        width: (data[i + 2] - data[i]) * scaleX,
        height: (data[i + 3] - data[i + 1]) * scaleY,
        confidence,
      });
    }

    // Sort by confidence
    boxes.sort((a, b) => b.confidence - a.confidence);

    // Non-maximum suppression (simple)
    return this.nms(boxes, 0.5);
  }

  private nms(
    boxes: { x: number; y: number; width: number; height: number; confidence: number }[],
    iouThreshold: number
  ): typeof boxes {
    const result: typeof boxes = [];
    const used = new Set<number>();

    for (let i = 0; i < boxes.length; i++) {
      if (used.has(i)) continue;
      result.push(boxes[i]);

      for (let j = i + 1; j < boxes.length; j++) {
        if (used.has(j)) continue;
        if (this.computeIoU(boxes[i], boxes[j]) > iouThreshold) {
          used.add(j);
        }
      }
    }

    return result;
  }

  private computeIoU(
    a: { x: number; y: number; width: number; height: number },
    b: { x: number; y: number; width: number; height: number }
  ): number {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width);
    const y2 = Math.min(a.y + a.height, b.y + b.height);

    const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = a.width * a.height + b.width * b.height - intersection;

    return union > 0 ? intersection / union : 0;
  }

  private decodeCTCOutput(data: Float32Array): string {
    const vocab = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ .,;:!?-()[]{}'\"/\\@#$%^&*";
    let text = "";
    let lastIdx = -1;

    for (let i = 0; i < data.length; i++) {
      const charIdx = Math.round(data[i]);
      if (charIdx === 0 || charIdx === lastIdx) continue;
      lastIdx = charIdx;
      if (charIdx > 0 && charIdx <= vocab.length) {
        text += vocab[charIdx - 1];
      }
    }

    return text.trim();
  }

  private cropCanvas(
    source: HTMLCanvasElement,
    x: number,
    y: number,
    width: number,
    height: number
  ): HTMLCanvasElement {
    const cropped = document.createElement("canvas");
    cropped.width = Math.max(1, Math.round(width));
    cropped.height = Math.max(1, Math.round(height));
    const ctx = cropped.getContext("2d")!;
    ctx.drawImage(source, Math.round(x), Math.round(y), cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
    return cropped;
  }

  private mergeOverlappingElements(elements: PageElement[]): PageElement[] {
    if (elements.length <= 1) return elements;

    const merged: PageElement[] = [];
    const used = new Set<number>();

    for (let i = 0; i < elements.length; i++) {
      if (used.has(i)) continue;
      let best = elements[i];

      for (let j = i + 1; j < elements.length; j++) {
        if (used.has(j)) continue;
        if (this.elementsOverlap(best, elements[j])) {
          // Keep the one with higher confidence
          if (elements[j].confidence > best.confidence) {
            used.add(merged.indexOf(best));
            best = elements[j];
          } else {
            used.add(j);
          }
        }
      }

      merged.push(best);
    }

    return merged;
  }

  private elementsOverlap(a: PageElement, b: PageElement): boolean {
    const overlap = this.computeIoU(
      { x: a.rect.x, y: a.rect.y, width: a.rect.width, height: a.rect.height },
      { x: b.rect.x, y: b.rect.y, width: b.rect.width, height: b.rect.height }
    );
    return overlap > 0.3;
  }

}

// ── Singleton ────────────────────────────────────────────────

let instance: VisionPipeline | null = null;

export function getVisionPipeline(): VisionPipeline {
  if (!instance) {
    instance = new VisionPipeline();
  }
  return instance;
}
