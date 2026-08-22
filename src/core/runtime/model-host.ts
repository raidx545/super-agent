// ============================================================
// VLESS — Model Host (offscreen only)
// Tracks per-model load state and warms models on demand. In P0 it
// downloads + caches the ONNX weights (proving the loader/cache path);
// library-managed models (Florence/GLiNER-tokenizer/WebLLM/MediaPipe)
// are initialized in their respective phases and reported as pending.
// ============================================================

import type {
  BackendProfile,
  ModelId,
  ModelStatus,
  ModelProgress,
} from "../../types/runtime";
import { detectBackend } from "./backend";
import { MODEL_REGISTRY, modelEligibleAtTier } from "./model-registry";
import {
  fetchArrayBufferWithProgress,
  isUrlCached,
  resolveModelUrl,
} from "./model-loader";
import { emitModelProgress } from "./messaging";

// In-memory status table for this offscreen lifetime.
const statuses = new Map<ModelId, ModelStatus>();

let backendPromise: Promise<BackendProfile> | null = null;
function backend(): Promise<BackendProfile> {
  if (!backendPromise) backendPromise = detectBackend();
  return backendPromise;
}

function seed(id: ModelId): ModelStatus {
  const e = MODEL_REGISTRY[id];
  const s: ModelStatus = {
    id: e.id,
    name: e.name,
    kind: e.kind,
    sizeBytes: e.sizeBytes,
    required: e.required,
    state: "not_loaded",
    progress: 0,
  };
  statuses.set(id, s);
  return s;
}

function get(id: ModelId): ModelStatus {
  return statuses.get(id) ?? seed(id);
}

function update(id: ModelId, patch: Partial<ModelStatus>): ModelStatus {
  const next = { ...get(id), ...patch };
  statuses.set(id, next);
  return next;
}

function publish(id: ModelId, p: Omit<ModelProgress, "id">): void {
  update(id, { state: p.state, progress: p.progress, error: p.error });
  emitModelProgress({ id, ...p });
}

/** Snapshot every model's state, reflecting on-device cache presence. */
export async function getModelStatuses(): Promise<ModelStatus[]> {
  const be = await backend();
  const ids = Object.keys(MODEL_REGISTRY) as ModelId[];
  for (const id of ids) {
    const e = MODEL_REGISTRY[id];
    const cur = get(id);
    if (cur.state === "ready" || cur.state === "downloading" || cur.state === "loading") {
      continue; // don't clobber an in-flight/finished state
    }
    if (!modelEligibleAtTier(id, be.tier)) {
      update(id, { state: "skipped", progress: 0 });
      continue;
    }
    if (e.kind === "onnx-local") {
      // Bundled in the extension — bytes are always on-device.
      update(id, { state: "cached", progress: 1 });
    } else if (e.kind === "onnx-remote") {
      try {
        const url = resolveModelUrl(e, be);
        update(id, { state: (await isUrlCached(url)) ? "cached" : "not_loaded" });
      } catch {
        update(id, { state: "not_loaded" });
      }
    }
  }
  return (Object.keys(MODEL_REGISTRY) as ModelId[]).map((id) => get(id));
}

/**
 * Warm a set of models. P0: fetch+cache ONNX weights (real download with
 * progress). Library-managed kinds are marked "loading→skipped(pending)"
 * until their phase lands, so the HUD never lies about readiness.
 */
export async function warmModels(ids: ModelId[]): Promise<ModelStatus[]> {
  const be = await backend();

  await Promise.all(
    ids.map(async (id) => {
      const e = MODEL_REGISTRY[id];
      if (!e) return;

      if (!modelEligibleAtTier(id, be.tier)) {
        publish(id, { state: "skipped", progress: 0 });
        return;
      }

      if (e.kind === "onnx-local" || e.kind === "onnx-remote") {
        try {
          const url = resolveModelUrl(e, be);
          await fetchArrayBufferWithProgress(url, (p) => publish(id, p));
          // Bytes are on-device. ORT session creation happens in P1.
          update(id, { state: "cached", progress: 1 });
        } catch (err) {
          publish(id, {
            state: "error",
            progress: 0,
            error: String((err as Error)?.message ?? err),
          });
        }
        return;
      }

      // transformersjs / webllm / mediapipe — initialized in later phases.
      publish(id, { state: "skipped", progress: 0 });
    }),
  );

  return ids.map((id) => get(id));
}
