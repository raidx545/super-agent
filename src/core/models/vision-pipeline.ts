// ============================================================
// VLESS — Vision Pipeline (Service Worker Compatible)
// Processes screenshots through ONNX models to extract text.
// Uses OffscreenCanvas for image processing (works in service workers).
//
// Pipeline: Screenshot -> Preprocess -> PaddleOCR Det -> Crop -> PaddleOCR Rec -> Text Blocks
// Falls back gracefully when models aren't loaded.
// ============================================================

import { getModelManager, type ModelProgress } from "./model-manager";

// ── Types ────────────────────────────────────────────────────

export interface VisionResult {
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

// ── Lazy ORT import ──────────────────────────────────────────

let ort: typeof import("onnxruntime-web") | null = null;

async function getOrt(): Promise<typeof import("onnxruntime-web")> {
  if (!ort) {
    ort = await import("onnxruntime-web");
  }
  return ort;
}

// ── Vision Pipeline ──────────────────────────────────────────

export class VisionPipeline {
  private manager = getModelManager();
  private modelsReady = false;

  /**
   * Initialize models. Call once on startup.
   */
  async initialize(onProgress?: (progress: ModelProgress) => void): Promise<void> {
    try {
      await this.manager.loadAll(onProgress);
      this.modelsReady = true;
      console.log("[VLESS] Vision models loaded");
    } catch (error) {
      console.warn("[VLESS] Vision model loading failed:", error);
      this.modelsReady = false;
    }
  }

  /**
   * Check if models are ready for inference.
   */
  isReady(): boolean {
    return this.modelsReady && this.manager.areRequiredModelsReady();
  }

  /**
   * Process a screenshot data URL through OCR.
   * Accepts a data URL string (from tabCapture).
   * Returns detected text blocks with bounding boxes.
   */
  async processScreenshot(dataUrl: string): Promise<VisionResult> {
    if (!this.isReady()) {
      return { textBlocks: [], inferenceTime: 0, modelsUsed: [], confidence: 0 };
    }

    const startTime = performance.now();
    const textBlocks: TextBlock[] = [];
    const modelsUsed: string[] = [];

    try {
      // Convert data URL to ImageBitmap (works in service workers)
      const bitmap = await dataUrlToImageBitmap(dataUrl);

      // Step 1: Run text detection
      const detSession = this.manager.getSession("ppocr-det-v3");
      if (!detSession) {
        return { textBlocks: [], inferenceTime: performance.now() - startTime, modelsUsed: [], confidence: 0 };
      }

      const detTensor = await this.preprocessForDetection(bitmap, 640, 640);
      const detResults = await detSession.run({ input: detTensor });
      const detOutput = Object.values(detResults)[0];
      const detData = detOutput.data as Float32Array;

      // Parse detection boxes
      const boxes = this.parseDetectionBoxes(detData, bitmap.width, bitmap.height);
      modelsUsed.push("ppocr-det");

      // Step 2: Run text recognition on each detected region
      const recSession = this.manager.getSession("ppocr-rec-en") || this.manager.getSession("ppocr-rec-hi");
      if (!recSession) {
        // Detection worked but no recognition model
        return {
          textBlocks: boxes.map((b) => ({
            text: `[detected region ${Math.round(b.x)},${Math.round(b.y)}]`,
            confidence: b.confidence,
            boundingBox: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) },
          })),
          inferenceTime: performance.now() - startTime,
          modelsUsed,
          confidence: 0.5,
        };
      }

      modelsUsed.push("ppocr-rec");

      // Process top 30 detected regions
      for (const box of boxes.slice(0, 30)) {
        try {
          // Crop the detected region from the bitmap
          const croppedBitmap = await cropImageBitmap(
            bitmap,
            Math.max(0, Math.round(box.x)),
            Math.max(0, Math.round(box.y)),
            Math.min(Math.round(box.width), bitmap.width - Math.round(box.x)),
            Math.min(Math.round(box.height), bitmap.height - Math.round(box.y))
          );

          if (croppedBitmap.width < 2 || croppedBitmap.height < 2) continue;

          // Preprocess for recognition
          const recTensor = await this.preprocessForRecognition(croppedBitmap, 32, 320);

          // Run recognition
          const recResults = await recSession.run({ input: recTensor });
          const recOutput = Object.values(recResults)[0];
          const text = this.decodeCTCOutput(recOutput.data as Float32Array);

          if (text.trim().length > 0) {
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
          // Skip failed region
        }
      }
    } catch (error) {
      console.error("[VLESS] Vision pipeline error:", error);
    }

    const inferenceTime = performance.now() - startTime;

    return {
      textBlocks,
      inferenceTime,
      modelsUsed,
      confidence: textBlocks.length > 0 ? 0.8 : 0.3,
    };
  }

  // ── Preprocessing ──────────────────────────────────────

  private async preprocessForDetection(
    bitmap: ImageBitmap,
    targetW: number,
    targetH: number
  ): Promise<any> {
    const ortModule = await getOrt();

    // Use OffscreenCanvas for preprocessing
    const canvas = new OffscreenCanvas(targetW, targetH);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);

    const imageData = ctx.getImageData(0, 0, targetW, targetH);
    const pixels = imageData.data;

    // NCHW format with PaddleOCR normalization (0-1 range, no ImageNet mean/std)
    const tensorData = new Float32Array(3 * targetH * targetW);

    for (let y = 0; y < targetH; y++) {
      for (let x = 0; x < targetW; x++) {
        const idx = (y * targetW + x) * 4;
        const r = pixels[idx] / 255;
        const g = pixels[idx + 1] / 255;
        const b = pixels[idx + 2] / 255;

        tensorData[0 * targetH * targetW + y * targetW + x] = r;
        tensorData[1 * targetH * targetW + y * targetW + x] = g;
        tensorData[2 * targetH * targetW + y * targetW + x] = b;
      }
    }

    return new ortModule.Tensor("float32", tensorData, [1, 3, targetH, targetW]) as any;
  }

  private async preprocessForRecognition(
    bitmap: ImageBitmap,
    targetH: number,
    targetW: number
  ): Promise<any> {
    const ortModule = await getOrt();

    const canvas = new OffscreenCanvas(targetW, targetH);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);

    const imageData = ctx.getImageData(0, 0, targetW, targetH);
    const pixels = imageData.data;

    const tensorData = new Float32Array(3 * targetH * targetW);

    for (let y = 0; y < targetH; y++) {
      for (let x = 0; x < targetW; x++) {
        const idx = (y * targetW + x) * 4;
        const r = pixels[idx] / 255;
        const g = pixels[idx + 1] / 255;
        const b = pixels[idx + 2] / 255;

        tensorData[0 * targetH * targetW + y * targetW + x] = r;
        tensorData[1 * targetH * targetW + y * targetW + x] = g;
        tensorData[2 * targetH * targetW + y * targetW + x] = b;
      }
    }

    return new ortModule.Tensor("float32", tensorData, [1, 3, targetH, targetW]) as any;
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

    // PaddleOCR detection output format varies by version
    // Try standard format: [x1, y1, x2, y2, confidence]
    const valuesPerBox = 5;
    for (let i = 0; i + valuesPerBox <= data.length; i += valuesPerBox) {
      const confidence = data[i + 4];
      if (confidence < 0.3) continue;

      boxes.push({
        x: data[i] * scaleX,
        y: data[i + 1] * scaleY,
        width: (data[i + 2] - data[i]) * scaleX,
        height: (data[i + 3] - data[i + 1]) * scaleY,
        confidence,
      });
    }

    // Sort by confidence descending
    boxes.sort((a, b) => b.confidence - a.confidence);

    // Non-maximum suppression
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
    // PaddleOCR character set
    const vocab = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ .,;:!?-()[]{}'\"/\\@#$%^&*";
    let text = "";
    let lastIdx = -1;

    // data shape: [1, num_classes, seq_len] or [num_classes * seq_len]
    // For CTC output, we take argmax along the class dimension
    const numClasses = vocab.length + 1; // +1 for blank token

    // Determine if output is [1, num_classes, seq_len] or flat
    let seqLen: number;
    let stride: number;

    if (data.length % numClasses === 0) {
      // [num_classes, seq_len] format
      seqLen = data.length / numClasses;
      stride = numClasses;
    } else {
      // Flat format — assume sequential
      seqLen = data.length;
      stride = 1;
    }

    for (let t = 0; t < seqLen; t++) {
      // Find argmax
      let maxIdx = 0;
      let maxVal = -Infinity;

      for (let c = 0; c < numClasses && t * stride + c < data.length; c++) {
        const val = data[t * stride + c];
        if (val > maxVal) {
          maxVal = val;
          maxIdx = c;
        }
      }

      // Skip blank (index 0) and repeated characters
      if (maxIdx === 0 || maxIdx === lastIdx) continue;
      lastIdx = maxIdx;

      // Map to character
      if (maxIdx - 1 < vocab.length) {
        text += vocab[maxIdx - 1];
      }
    }

    return text.trim();
  }
}

// ── Image Utilities ──────────────────────────────────────────

async function dataUrlToImageBitmap(dataUrl: string): Promise<ImageBitmap> {
  // Convert data URL to Blob, then to ImageBitmap
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return createImageBitmap(blob);
}

async function cropImageBitmap(
  source: ImageBitmap,
  x: number,
  y: number,
  width: number,
  height: number
): Promise<ImageBitmap> {
  const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(source, x, y, width, height, 0, 0, width, height);
  return createImageBitmap(canvas);
}

// ── Singleton ────────────────────────────────────────────────

let instance: VisionPipeline | null = null;

export function getVisionPipeline(): VisionPipeline {
  if (!instance) {
    instance = new VisionPipeline();
  }
  return instance;
}
