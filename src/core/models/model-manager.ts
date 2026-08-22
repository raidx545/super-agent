// ============================================================
// VLESS — Model Manager
// Downloads, caches, and manages local ONNX models in IndexedDB
// First run: downloads models (~40MB total)
// Subsequent runs: loads from cache in <100ms
// ============================================================

import * as ort from "onnxruntime-web";

// ── Model Registry ───────────────────────────────────────────

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  url: string;
  size: number; // bytes
  type: "ocr-det" | "ocr-rec" | "ui-detector" | "layout" | "llm";
  inputShape: readonly number[];
  inputName: string;
  outputNames: string[];
  required: boolean; // required for basic operation
}

export const MODEL_REGISTRY: ModelInfo[] = [
  {
    id: "ppocr-det",
    name: "PaddleOCR Detection",
    description: "Detects text regions in screenshots (2.4MB)",
    url: "https://huggingface.co/nickmuchi/paddleocr-onnx/resolve/main/det.onnx",
    size: 2_400_000,
    type: "ocr-det",
    inputShape: [1, 3, 640, 640],
    inputName: "input",
    outputNames: ["output"],
    required: true,
  },
  {
    id: "ppocr-rec",
    name: "PaddleOCR Recognition",
    description: "Reads text from detected regions (8.5MB)",
    url: "https://huggingface.co/nickmuchi/paddleocr-onnx/resolve/main/rec.onnx",
    size: 8_500_000,
    type: "ocr-rec",
    inputShape: [1, 3, 32, 320],
    inputName: "input",
    outputNames: ["output"],
    required: true,
  },
  {
    id: "ui-detector",
    name: "UI Element Detector",
    description: "Detects buttons, inputs, links, dropdowns visually (6MB)",
    url: "https://huggingface.co/web-ui-detector/resolve/main/ui-detector-q8.onnx",
    size: 6_000_000,
    type: "ui-detector",
    inputShape: [1, 3, 640, 640],
    inputName: "images",
    outputNames: ["output"],
    required: false,
  },
];

// ── Model Manager Class ──────────────────────────────────────

export class ModelManager {
  private sessions: Map<string, ort.InferenceSession> = new Map();
  private cacheName = "vless-models-v2";
  private backend: "webgpu" | "wasm" = "wasm";
  private progressCallbacks: Map<string, (progress: ModelProgress) => void> = new Map();

  /**
   * Detect best available backend.
   */
  async detectBackend(): Promise<"webgpu" | "wasm"> {
    try {
      if (typeof navigator !== "undefined" && "gpu" in navigator) {
        const adapter = await (navigator as any).gpu?.requestAdapter();
        if (adapter) {
          this.backend = "webgpu";
          console.log("🐾 [ModelManager] WebGPU available — using GPU acceleration");
          return "webgpu";
        }
      }
    } catch {
      // WebGPU not available
    }
    this.backend = "wasm";
    console.log("🐾 [ModelManager] Using WASM backend (WebGPU not available)");
    return "wasm";
  }

  /**
   * Get download/install status for all models.
   */
  async getStatus(): Promise<ModelStatus[]> {
    const statuses: ModelStatus[] = [];

    for (const model of MODEL_REGISTRY) {
      const loaded = this.sessions.has(model.id);
      const cached = await this.isCached(model.id);

      statuses.push({
        id: model.id,
        name: model.name,
        description: model.description,
        size: model.size,
        required: model.required,
        status: loaded ? "ready" : cached ? "cached" : "not_downloaded",
        backend: this.backend,
      });
    }

    return statuses;
  }

  /**
   * Download and install a model. Returns cached version if available.
   */
  async loadModel(
    modelId: string,
    onProgress?: (progress: ModelProgress) => void
  ): Promise<ort.InferenceSession> {
    // Already loaded
    if (this.sessions.has(modelId)) {
      return this.sessions.get(modelId)!;
    }

    const modelInfo = MODEL_REGISTRY.find((m) => m.id === modelId);
    if (!modelInfo) throw new Error(`Unknown model: ${modelId}`);

    if (onProgress) {
      this.progressCallbacks.set(modelId, onProgress);
    }

    this.reportProgress(modelId, "downloading", 0);

    try {
      let modelBytes: ArrayBuffer;

      // Try cache first
      const cached = await this.loadFromCache(modelId);
      if (cached) {
        modelBytes = cached;
        this.reportProgress(modelId, "loading", 60);
      } else {
        // Download
        modelBytes = await this.downloadModel(modelInfo);
        this.reportProgress(modelId, "loading", 60);
      }

      // Create ONNX session
      const session = await this.createSession(modelBytes);
      this.sessions.set(modelId, session);

      // Cache for next time
      await this.saveToCache(modelId, modelBytes);

      this.reportProgress(modelId, "ready", 100);
      console.log(`🐾 [ModelManager] ${modelInfo.name} loaded (${this.backend})`);

      return session;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      this.reportProgress(modelId, "error", 0, msg);

      // Fallback: try WASM if WebGPU failed
      if (this.backend === "webgpu") {
        console.log(`🐾 [ModelManager] WebGPU failed, retrying with WASM...`);
        this.backend = "wasm";
        return this.loadModel(modelId, onProgress);
      }

      throw error;
    }
  }

  /**
   * Load all required models.
   */
  async loadAll(
    onProgress?: (progress: ModelProgress) => void
  ): Promise<void> {
    await this.detectBackend();

    const required = MODEL_REGISTRY.filter((m) => m.required);
    const optional = MODEL_REGISTRY.filter((m) => !m.required);

    // Load required models in parallel
    await Promise.all(
      required.map((m) => this.loadModel(m.id, onProgress))
    );

    // Load optional models (don't fail if they can't load)
    for (const m of optional) {
      try {
        await this.loadModel(m.id, onProgress);
      } catch {
        console.log(`🐾 [ModelManager] Optional model ${m.id} skipped`);
      }
    }
  }

  /**
   * Get a loaded session.
   */
  getSession(modelId: string): ort.InferenceSession | undefined {
    return this.sessions.get(modelId);
  }

  /**
   * Is a specific model loaded?
   */
  isModelReady(modelId: string): boolean {
    return this.sessions.has(modelId);
  }

  /**
   * Are all required models loaded?
   */
  areRequiredModelsReady(): boolean {
    return MODEL_REGISTRY
      .filter((m) => m.required)
      .every((m) => this.sessions.has(m.id));
  }

  /**
   * Clear all cached models.
   */
  async clearCache(): Promise<void> {
    if ("caches" in globalThis) {
      await caches.delete(this.cacheName);
    }
    this.sessions.clear();
    console.log("🐾 [ModelManager] Cache cleared");
  }

  // ── Private Methods ────────────────────────────────────

  private async downloadModel(model: ModelInfo): Promise<ArrayBuffer> {
    console.log(`🐾 [ModelManager] Downloading ${model.name} (${(model.size / 1024 / 1024).toFixed(1)}MB)...`);

    const response = await fetch(model.url);
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const contentLength = parseInt(response.headers.get("content-length") || String(model.size));
    const chunks: Uint8Array[] = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      this.reportProgress(model.id, "downloading", Math.round((received / contentLength) * 50));
    }

    // Combine chunks into single ArrayBuffer
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result.buffer;
  }

  private async createSession(modelBytes: ArrayBuffer): Promise<ort.InferenceSession> {
    const options: ort.InferenceSession.SessionOptions = {
      executionProviders: [this.backend],
      graphOptimizationLevel: "all",
    };

    return ort.InferenceSession.create(modelBytes, options);
  }

  private async isCached(modelId: string): Promise<boolean> {
    if (!("caches" in globalThis)) return false;
    try {
      const cache = await caches.open(this.cacheName);
      const response = await cache.match(`/${modelId}.onnx`);
      return !!response;
    } catch {
      return false;
    }
  }

  private async loadFromCache(modelId: string): Promise<ArrayBuffer | null> {
    if (!("caches" in globalThis)) return null;
    try {
      const cache = await caches.open(this.cacheName);
      const response = await cache.match(`/${modelId}.onnx`);
      if (response) {
        console.log(`🐾 [ModelManager] ${modelId} loaded from cache`);
        return response.arrayBuffer();
      }
    } catch {
      // Cache read failed
    }
    return null;
  }

  private async saveToCache(modelId: string, data: ArrayBuffer): Promise<void> {
    if (!("caches" in globalThis)) return;
    try {
      const cache = await caches.open(this.cacheName);
      await cache.put(`/${modelId}.onnx`, new Response(data, {
        headers: { "Content-Type": "application/octet-stream" },
      }));
    } catch {
      // Cache write failed
    }
  }

  private reportProgress(
    modelId: string,
    phase: ModelProgress["phase"],
    progress: number,
    error?: string
  ): void {
    const callback = this.progressCallbacks.get(modelId);
    if (callback) {
      callback({ modelId, phase, progress, error });
    }
  }
}

// ── Types ────────────────────────────────────────────────────

export interface ModelProgress {
  modelId: string;
  phase: "downloading" | "loading" | "ready" | "error";
  progress: number; // 0-100
  error?: string;
}

export interface ModelStatus {
  id: string;
  name: string;
  description: string;
  size: number;
  required: boolean;
  status: "ready" | "cached" | "not_downloaded";
  backend: string;
}

// ── Singleton ────────────────────────────────────────────────

let instance: ModelManager | null = null;

export function getModelManager(): ModelManager {
  if (!instance) {
    instance = new ModelManager();
  }
  return instance;
}
