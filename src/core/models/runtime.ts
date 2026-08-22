// ============================================================
// VLESS — On-Device Model Runtime
// Runs Florence-2 and PaddleOCR in-browser via ONNX Runtime Web
// This is the "on-device visual perception" that makes us unique
// ============================================================

import * as ort from "onnxruntime-web";

// ── Configuration ────────────────────────────────────────────

const MODEL_CONFIG = {
  paddleOcr: {
    det: {
      url: "/models/ppocr/det.onnx",
      size: 2_400_000, // ~2.4MB
      inputName: "input",
      inputShape: [1, 3, 640, 640] as const,
    },
    rec: {
      url: "/models/ppocr/rec.onnx",
      size: 8_500_000, // ~8.5MB
      inputName: "input",
      inputShape: [1, 3, 32, 320] as const,
    },
  },
  uiDetection: {
    url: "/models/ui-detector.onnx",
    size: 25_000_000, // ~25MB
    inputName: "images",
    inputShape: [1, 3, 640, 640] as const,
  },
};

// ── Runtime State ────────────────────────────────────────────

interface ModelState {
  session: ort.InferenceSession | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  backend: "webgpu" | "wasm" | null;
}

const models: Record<string, ModelState> = {
  paddleOcrDet: { session: null, loaded: false, loading: false, error: null, backend: null },
  paddleOcrRec: { session: null, loaded: false, loading: false, error: null, backend: null },
  uiDetector: { session: null, loaded: false, loading: false, error: null, backend: null },
};

// ── Backend Detection ────────────────────────────────────────

export async function detectBackend(): Promise<"webgpu" | "wasm"> {
  try {
    if (typeof navigator !== "undefined" && "gpu" in navigator) {
      const adapter = await (navigator as any).gpu?.requestAdapter();
      if (adapter) {
        return "webgpu";
      }
    }
  } catch {
    // WebGPU not available
  }
  return "wasm";
}

// ── Model Loading ────────────────────────────────────────────

export interface ModelLoadProgress {
  model: string;
  phase: "downloading" | "loading" | "ready" | "error";
  progress: number; // 0-100
  error?: string;
}

/**
 * Load a model from URL with progress tracking.
 * Models are cached in the browser's Cache API after first download.
 */
export async function loadModel(
  modelName: keyof typeof MODEL_CONFIG | "all",
  onProgress?: (progress: ModelLoadProgress) => void
): Promise<void> {
  const backend = await detectBackend();

  const log = (msg: string) => console.log(`🐾 [ModelRuntime] ${msg}`);

  // Configure ONNX Runtime
  ort.env.wasm.numThreads = navigator.hardwareConcurrency || 4;

  if (backend === "webgpu") {
    log("Using WebGPU backend");
  } else {
    log("Using WASM backend (WebGPU not available)");
  }

  if (modelName === "all") {
    await Promise.all([
      loadSingleModel("paddleOcrDet", MODEL_CONFIG.paddleOcr.det as any, backend, onProgress),
      loadSingleModel("paddleOcrRec", MODEL_CONFIG.paddleOcr.rec as any, backend, onProgress),
      loadSingleModel("uiDetector", MODEL_CONFIG.uiDetection, backend, onProgress),
    ]);
  } else {
    const configMap = {
      paddleOcrDet: MODEL_CONFIG.paddleOcr.det as any,
      paddleOcrRec: MODEL_CONFIG.paddleOcr.rec as any,
      uiDetector: MODEL_CONFIG.uiDetection,
    };
    await loadSingleModel(modelName, configMap[modelName as keyof typeof configMap] || MODEL_CONFIG.uiDetection, backend, onProgress);
  }

  log("All requested models loaded");
}

async function loadSingleModel(
  key: string,
  config: { url: string; size: number },
  backend: "webgpu" | "wasm",
  onProgress?: (progress: ModelLoadProgress) => void
): Promise<void> {
  if (models[key]?.loaded) return;
  if (models[key]?.loading) return;

  models[key].loading = true;
  models[key].error = null;

  const log = (msg: string) => console.log(`🐾 [${key}] ${msg}`);

  try {
    onProgress?.({
      model: key,
      phase: "downloading",
      progress: 0,
    });

    // Try to load from cache first
    let modelBytes: ArrayBuffer | null = null;

    if ("caches" in globalThis) {
      try {
        const cache = await caches.open("vless-models-v1");
        const cachedResponse = await cache.match(config.url);
        if (cachedResponse) {
          modelBytes = await cachedResponse.arrayBuffer();
          log("Loaded from cache");
        }
      } catch {
        // Cache API not available
      }
    }

    // Download if not cached
    if (!modelBytes) {
      log(`Downloading ${config.url}...`);
      const response = await fetch(config.url);
      if (!response.ok) {
        throw new Error(`Failed to download: ${response.status}`);
      }
      modelBytes = await response.arrayBuffer();

      // Cache for next time
      if ("caches" in globalThis) {
        try {
          const cache = await caches.open("vless-models-v1");
          await cache.put(config.url, new Response(modelBytes));
          log("Cached for future use");
        } catch {
          // Cache write failed
        }
      }
    }

    onProgress?.({
      model: key,
      phase: "loading",
      progress: 50,
    });

    // Create ONNX session
    const sessionOptions: ort.InferenceSession.SessionOptions = {};

    if (backend === "webgpu") {
      sessionOptions.executionProviders = ["webgpu"];
    } else {
      sessionOptions.executionProviders = ["wasm"];
    }

    sessionOptions.graphOptimizationLevel = "all";
    sessionOptions.executionMode = "parallel";

    const session = await ort.InferenceSession.create(
      modelBytes,
      sessionOptions
    );

    models[key].session = session;
    models[key].loaded = true;
    models[key].loading = false;
    models[key].backend = backend;

    onProgress?.({
      model: key,
      phase: "ready",
      progress: 100,
    });

    log(`Loaded successfully (${backend})`);
  } catch (error) {
    models[key].loading = false;
    models[key].error =
      error instanceof Error ? error.message : "Unknown error";

    onProgress?.({
      model: key,
      phase: "error",
      progress: 0,
      error: models[key].error,
    });

    log(`Failed to load: ${models[key].error}`);

    // Fallback to WASM if WebGPU failed
    if (backend === "webgpu") {
      log("Retrying with WASM backend...");
      await loadSingleModel(key, config, "wasm", onProgress);
    }
  }
}

// ── Inference ────────────────────────────────────────────────

export interface DetectionResult {
  boundingBoxes: {
    x: number;
    y: number;
    width: number;
    height: number;
    confidence: number;
    label: string;
  }[];
  inferenceTime: number;
}

/**
 * Run UI element detection on a screenshot.
 * Returns bounding boxes for all detected interactive elements.
 */
export async function detectUIElements(
  screenshotCanvas: HTMLCanvasElement
): Promise<DetectionResult> {
  const startTime = performance.now();

  const session = models.uiDetector?.session;
  if (!session) {
    return {
      boundingBoxes: [],
      inferenceTime: 0,
    };
  }

  try {
    // Preprocess image to model input format
    const inputTensor = preprocessImage(screenshotCanvas, [1, 3, 640, 640]);

    // Run inference
    const results = await session.run({
      [MODEL_CONFIG.uiDetection.inputName]: inputTensor,
    });

    // Parse output
    const output = results[Object.keys(results)[0]];
    const boxes = parseDetectionOutput(output.data as Float32Array);

    return {
      boundingBoxes: boxes,
      inferenceTime: performance.now() - startTime,
    };
  } catch (error) {
    console.error("UI detection failed:", error);
    return {
      boundingBoxes: [],
      inferenceTime: performance.now() - startTime,
    };
  }
}

/**
 * Run OCR on a cropped region of the page.
 * Returns detected text with bounding boxes.
 */
export async function runOCR(
  regionCanvas: HTMLCanvasElement
): Promise<{
  text: string;
  confidence: number;
  boundingBox: { x: number; y: number; width: number; height: number };
  inferenceTime: number;
}> {
  const startTime = performance.now();

  const detSession = models.paddleOcrDet?.session;
  const recSession = models.paddleOcrRec?.session;

  if (!detSession || !recSession) {
    return {
      text: "",
      confidence: 0,
      boundingBox: { x: 0, y: 0, width: 0, height: 0 },
      inferenceTime: 0,
    };
  }

  try {
    // Detect text regions
    const detInput = preprocessImage(regionCanvas, MODEL_CONFIG.paddleOcr.det.inputShape as unknown as number[]);
    const detResults = await detSession.run({
      [MODEL_CONFIG.paddleOcr.det.inputName]: detInput,
    });

    // For each detected region, recognize text
    const regions = parseDetectionOutput(
      detResults[Object.keys(detResults)[0]].data as Float32Array
    );

    let fullText = "";
    let totalConfidence = 0;

    for (const region of regions.slice(0, 10)) {
      // Crop region from canvas
      const cropped = cropCanvas(
        regionCanvas,
        region.x,
        region.y,
        region.width,
        region.height
      );

      // Recognize text
      const recInput = preprocessImage(cropped, MODEL_CONFIG.paddleOcr.rec.inputShape as unknown as number[]);
      const recResults = await recSession.run({
        [MODEL_CONFIG.paddleOcr.rec.inputName]: recInput,
      });

      const textResult = decodeOCROutput(
        recResults[Object.keys(recResults)[0]].data as Float32Array
      );

      if (textResult.text) {
        fullText += textResult.text + " ";
        totalConfidence += textResult.confidence;
      }
    }

    return {
      text: fullText.trim(),
      confidence: regions.length > 0 ? totalConfidence / regions.length : 0,
      boundingBox: {
        x: 0,
        y: 0,
        width: regionCanvas.width,
        height: regionCanvas.height,
      },
      inferenceTime: performance.now() - startTime,
    };
  } catch (error) {
    console.error("OCR failed:", error);
    return {
      text: "",
      confidence: 0,
      boundingBox: { x: 0, y: 0, width: 0, height: 0 },
      inferenceTime: performance.now() - startTime,
    };
  }
}

// ── Model Status ─────────────────────────────────────────────

export function getModelStatus(): Record<
  string,
  {
    loaded: boolean;
    loading: boolean;
    backend: string | null;
    error: string | null;
  }
> {
  const status: Record<string, any> = {};
  for (const [key, model] of Object.entries(models)) {
    status[key] = {
      loaded: model.loaded,
      loading: model.loading,
      backend: model.backend,
      error: model.error,
    };
  }
  return status;
}

export function areModelsReady(): boolean {
  return Object.values(models).some((m) => m.loaded);
}

// ── Preprocessing Helpers ────────────────────────────────────

function preprocessImage(
  canvas: HTMLCanvasElement,
  targetShape: number[]
): ort.Tensor {
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

  // Convert to NCHW format (normalized to 0-1)
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

  return new ort.Tensor("float32", tensorData, targetShape);
}

function parseDetectionOutput(
  data: Float32Array
): DetectionResult["boundingBoxes"] {
  const boxes: DetectionResult["boundingBoxes"] = [];

  // Standard detection output format: [batch, num_detections, 6]
  // Each detection: [x1, y1, x2, y2, confidence, class_id]
  const stride = 6;

  for (let i = 0; i < data.length; i += stride) {
    const confidence = data[i + 4];
    if (confidence < 0.5) continue; // Confidence threshold

    boxes.push({
      x: data[i],
      y: data[i + 1],
      width: data[i + 2] - data[i],
      height: data[i + 3] - data[i + 1],
      confidence,
      label: `element-${Math.round(data[i + 5])}`,
    });
  }

  // Sort by confidence
  boxes.sort((a, b) => b.confidence - a.confidence);

  return boxes.slice(0, 20); // Top 20 detections
}

function decodeOCROutput(
  data: Float32Array
): { text: string; confidence: number } {
  // Decode CTC output from PaddleOCR recognition model
  // This is a simplified decoder — real implementation would use CTC beam search
  const vocab =
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ .,;:!?-()[]{}'\"/\\@#$%^&*";
  let text = "";
  let maxConfidence = 0;
  let lastIdx = -1;

  for (let i = 0; i < data.length; i++) {
    const charIdx = data[i];
    if (charIdx === 0 || charIdx === lastIdx) continue; // CTC blank or repeat
    lastIdx = charIdx;
    if (charIdx > 0 && charIdx <= vocab.length) {
      text += vocab[Math.round(charIdx) - 1];
      maxConfidence = Math.max(maxConfidence, data[i + 1] || 0);
    }
  }

  return {
    text: text.trim(),
    confidence: maxConfidence,
  };
}

function cropCanvas(
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
  ctx.drawImage(
    source,
    Math.round(x),
    Math.round(y),
    cropped.width,
    cropped.height,
    0,
    0,
    cropped.width,
    cropped.height
  );
  return cropped;
}
