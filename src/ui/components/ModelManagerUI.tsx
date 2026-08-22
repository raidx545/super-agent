// ============================================================
// VLESS — Model Manager UI
// Shows on-device ML model status, download progress, and backend info.
// Uses the offscreen RPC bus for model operations.
// ============================================================

import { useState, useEffect, useCallback } from "react";
import { callOffscreen, onModelProgress } from "../../core/runtime/messaging";
import type {
  ModelStatus,
  ModelProgress,
  BackendProfile,
  ModelId,
} from "../../types/runtime";

export function ModelManagerUI() {
  const [statuses, setStatuses] = useState<ModelStatus[]>([]);
  const [progress, setProgress] = useState<Record<string, ModelProgress>>({});
  const [backend, setBackend] = useState<string>("detecting...");
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  useEffect(() => {
    loadStatus();
    const unsub = onModelProgress((p: ModelProgress) => {
      setProgress((prev) => ({ ...prev, [p.id]: p }));
    });
    return unsub;
  }, []);

  async function loadStatus() {
    try {
      const be: BackendProfile = await callOffscreen("detectBackend", undefined);
      setBackend(be.summary);
      const s: ModelStatus[] = await callOffscreen("getModelStatuses", undefined);
      setStatuses(s);
    } catch (err) {
      setBackend("offline");
      console.warn("[VLESS] Failed to load model statuses:", err);
    }
  }

  const warmModel = useCallback(async (id: ModelId) => {
    setLoading((prev) => ({ ...prev, [id]: true }));
    try {
      await callOffscreen("warmModels", { ids: [id] });
      await loadStatus();
    } catch (err) {
      console.warn(`[VLESS] Failed to warm ${id}:`, err);
    } finally {
      setLoading((prev) => ({ ...prev, [id]: false }));
    }
  }, []);

  const warmAll = useCallback(async () => {
    const allIds = statuses.map((s) => s.id);
    setLoading((prev) => {
      const next = { ...prev };
      for (const id of allIds) next[id] = true;
      return next;
    });
    try {
      await callOffscreen("warmModels", { ids: allIds });
      await loadStatus();
    } catch (err) {
      console.warn("[VLESS] Failed to warm all models:", err);
    } finally {
      setLoading({});
    }
  }, [statuses]);

  const allRequiredReady = statuses
    .filter((s) => s.required)
    .every((s) => s.state === "ready" || s.state === "cached");
  const totalSize = statuses.reduce((sum, s) => sum + s.sizeBytes, 0);
  const loadedSize = statuses
    .filter((s) => s.state === "ready" || s.state === "cached")
    .reduce((sum, s) => sum + s.sizeBytes, 0);

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-300">🧠 Vision Models</h2>
        <span className="text-[10px] px-2 py-0.5 rounded bg-gray-800 text-gray-400 font-mono">
          {backend}
        </span>
      </div>

      {/* Overall Status */}
      <div
        className={`rounded-lg p-3 border ${
          allRequiredReady
            ? "bg-green-900/20 border-green-800/30"
            : "bg-yellow-900/20 border-yellow-800/30"
        }`}
      >
        <div className="flex items-center gap-2 mb-1">
          <span>{allRequiredReady ? "✅" : "⏳"}</span>
          <span
            className={`text-xs font-medium ${
              allRequiredReady ? "text-green-400" : "text-yellow-400"
            }`}
          >
            {allRequiredReady
              ? "All required models loaded"
              : "Models needed for visual perception"}
          </span>
        </div>
        <div className="flex items-center gap-3 mt-2">
          <div className="flex-1 bg-gray-800 rounded-full h-1.5">
            <div
              className="bg-blue-500 h-1.5 rounded-full transition-all duration-500"
              style={{ width: `${totalSize > 0 ? (loadedSize / totalSize) * 100 : 0}%` }}
            />
          </div>
          <span className="text-[10px] text-gray-500">
            {(loadedSize / 1024 / 1024).toFixed(1)}/{(totalSize / 1024 / 1024).toFixed(1)} MB
          </span>
        </div>
      </div>

      {/* Model List */}
      <div className="space-y-2">
        {statuses.map((status) => {
          const prog = progress[status.id];
          const isLoading = loading[status.id];

          return (
            <div key={status.id} className="bg-gray-900 rounded-lg p-3 border border-gray-800">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm">
                    {status.state === "ready"
                      ? "✅"
                      : status.state === "cached"
                        ? "📦"
                        : status.state === "downloading"
                          ? "⬇️"
                          : status.state === "loading"
                            ? "⚙️"
                            : status.state === "error"
                              ? "❌"
                              : "⬜"}
                  </span>
                  <span className="text-xs text-gray-300 font-medium">{status.name}</span>
                  {status.required && (
                    <span className="text-[9px] px-1 py-0.5 bg-blue-900/30 text-blue-400 rounded">
                      required
                    </span>
                  )}
                </div>
                <span className="text-[10px] text-gray-500">
                  {(status.sizeBytes / 1024 / 1024).toFixed(1)}MB
                </span>
              </div>

              <p className="text-[10px] text-gray-500 mb-2">{status.kind}</p>

              {/* Progress Bar */}
              {prog && prog.state !== "ready" && prog.state !== "error" && (
                <div className="mb-2">
                  <div className="w-full bg-gray-800 rounded-full h-1.5">
                    <div
                      className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
                      style={{ width: `${Math.round(prog.progress * 100)}%` }}
                    />
                  </div>
                  <p className="text-[9px] text-gray-500 mt-1">
                    {prog.state === "downloading"
                      ? `Downloading... ${Math.round(prog.progress * 100)}%`
                      : "Loading model..."}
                  </p>
                </div>
              )}

              {/* Error */}
              {prog?.state === "error" && (
                <p className="text-[10px] text-red-400 mb-2">❌ {prog.error}</p>
              )}

              {/* Action Button */}
              {status.state !== "ready" && status.state !== "cached" && (
                <button
                  onClick={() => warmModel(status.id)}
                  disabled={isLoading}
                  className="text-[10px] px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white rounded transition-colors"
                >
                  {isLoading ? "Loading..." : "Download"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={warmAll}
          className="flex-1 text-[11px] py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
        >
          Download All
        </button>
        <button
          onClick={loadStatus}
          className="text-[11px] px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Info */}
      <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
        <h4 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">How It Works</h4>
        <div className="space-y-1 text-[11px] text-gray-400">
          <p>
            🔍 <strong>DOM path</strong> (default): Extracts page structure from HTML — fast (~10ms)
          </p>
          <p>
            👁️ <strong>Vision path</strong> (with models): Processes screenshots via ONNX —
            universal (~200ms)
          </p>
          <p>
            🔗 <strong>Hybrid path</strong>: DOM structure + vision text — most accurate
          </p>
        </div>
        <p className="text-[10px] text-gray-600 mt-2">
          Models run entirely in your browser via the offscreen ML host. Zero data leaves your
          device.
        </p>
      </div>
    </div>
  );
}
