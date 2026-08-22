// ============================================================
// VLESS — Backend / Tier Detection
// Runs in the OFFSCREEN document (needs navigator.gpu). Decides the
// degradation-ladder tier the whole pipeline adapts to.
// ============================================================

import type { BackendProfile, Tier } from "../../types/runtime";

// Canonical WASM-SIMD feature-detection module (from wasm-feature-detect).
// WebAssembly.validate returns true iff SIMD is supported.
const SIMD_TEST_BYTES = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8,
  0, 65, 0, 253, 15, 253, 98, 11,
]);

function detectWasmSimd(): boolean {
  try {
    return WebAssembly.validate(SIMD_TEST_BYTES);
  } catch {
    return false;
  }
}

function detectWasmThreads(): boolean {
  try {
    return (
      typeof SharedArrayBuffer !== "undefined" &&
      // cross-origin isolation is required for threads in most contexts
      (typeof crossOriginIsolated === "undefined" || crossOriginIsolated === true)
    );
  } catch {
    return false;
  }
}

// Minimal structural shape of the WebGPU entry points we touch here.
// Full @webgpu/types are introduced when we write GPU compute (P2+).
interface GpuAdapterLike {
  info?: { description?: string; vendor?: string };
}
interface GpuLike {
  requestAdapter(): Promise<GpuAdapterLike | null>;
}

async function detectWebGpu(): Promise<{ ok: boolean; adapter?: string }> {
  try {
    const gpu = (navigator as unknown as { gpu?: GpuLike }).gpu;
    if (!gpu) return { ok: false };
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { ok: false };
    // adapter.info is not universally available; guard it.
    const info = adapter.info;
    const desc = info?.description || info?.vendor || "webgpu";
    return { ok: true, adapter: desc };
  } catch {
    return { ok: false };
  }
}

function chooseTier(
  webgpu: boolean,
  wasmSimd: boolean,
  cores: number,
  memGb: number,
): Tier {
  // A: real GPU acceleration + enough memory for a 360MB ViT / ~900MB LLM.
  if (webgpu && (memGb === 0 || memGb >= 4)) return "A";
  // B: no GPU but a capable CPU (SIMD + cores + memory) → Florence q4 on WASM.
  if (wasmSimd && cores >= 4 && (memGb === 0 || memGb >= 4)) return "B";
  // C: everything else → OCR + tightened DOM, deterministic/Ollama planner.
  return "C";
}

export async function detectBackend(): Promise<BackendProfile> {
  const { ok: webgpu, adapter } = await detectWebGpu();
  const wasmSimd = detectWasmSimd();
  const wasmThreads = detectWasmThreads();
  const cores =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;
  const deviceMemoryGb =
    typeof navigator !== "undefined" &&
    (navigator as unknown as { deviceMemory?: number }).deviceMemory
      ? (navigator as unknown as { deviceMemory: number }).deviceMemory
      : 0;

  const tier = chooseTier(webgpu, wasmSimd, cores, deviceMemoryGb);
  const executionProviders: Array<"webgpu" | "wasm"> = webgpu
    ? ["webgpu", "wasm"]
    : ["wasm"];

  const summary =
    `Tier ${tier} · ` +
    (webgpu ? `WebGPU (${adapter ?? "gpu"})` : "WASM") +
    (wasmSimd ? " · SIMD" : "") +
    ` · ${cores} cores` +
    (deviceMemoryGb ? ` · ~${deviceMemoryGb}GB` : "");

  return {
    webgpu,
    wasmSimd,
    wasmThreads,
    cores,
    deviceMemoryGb,
    adapter,
    tier,
    executionProviders,
    summary,
  };
}
