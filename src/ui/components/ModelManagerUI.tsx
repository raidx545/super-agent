import { useState, useEffect, useCallback } from "react";
import { getModelManager, MODEL_REGISTRY, type ModelStatus, type ModelProgress } from "../../core/models/model-manager";

export function ModelManagerUI() {
  const [statuses, setStatuses] = useState<ModelStatus[]>([]);
  const [progress, setProgress] = useState<Record<string, ModelProgress>>({});
  const [backend, setBackend] = useState<string>("detecting...");

  const manager = getModelManager();

  useEffect(() => {
    loadStatus();
  }, []);

  async function loadStatus() {
    const detected = await manager.detectBackend();
    setBackend(detected);
    const s = await manager.getStatus();
    setStatuses(s);
  }

  const loadModel = useCallback(async (modelId: string) => {
    try {
      setProgress((prev) => ({ ...prev, [modelId]: { modelId, phase: "downloading", progress: 0 } }));

      await manager.loadModel(modelId, (p) => {
        setProgress((prev) => ({ ...prev, [modelId]: p }));
      });

      await loadStatus();
    } catch (error) {
      setProgress((prev) => ({
        ...prev,
        [modelId]: { modelId, phase: "error", progress: 0, error: error instanceof Error ? error.message : "Failed" },
      }));
    }
  }, [manager]);

  const loadAll = useCallback(async () => {
    await manager.loadAll((p) => {
      setProgress((prev) => ({ ...prev, [p.modelId]: p }));
    });
    await loadStatus();
  }, [manager]);

  const clearCache = useCallback(async () => {
    await manager.clearCache();
    await loadStatus();
  }, [manager]);

  const allRequiredReady = statuses.filter((s) => s.required).every((s) => s.status === "ready");
  const totalSize = MODEL_REGISTRY.reduce((sum, m) => sum + m.size, 0);
  const loadedSize = statuses.filter((s) => s.status === "ready").reduce((sum, s) => sum + s.size, 0);

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-300">🧠 Vision Models</h2>
        <span className="text-[10px] px-2 py-0.5 rounded bg-gray-800 text-gray-400 font-mono">
          {backend}
        </span>
      </div>

      {/* Overall Status */}
      <div className={`rounded-lg p-3 border ${
        allRequiredReady
          ? "bg-green-900/20 border-green-800/30"
          : "bg-yellow-900/20 border-yellow-800/30"
      }`}>
        <div className="flex items-center gap-2 mb-1">
          <span>{allRequiredReady ? "✅" : "⏳"}</span>
          <span className={`text-xs font-medium ${allRequiredReady ? "text-green-400" : "text-yellow-400"}`}>
            {allRequiredReady ? "All required models loaded" : "Models needed for visual perception"}
          </span>
        </div>
        <div className="flex items-center gap-3 mt-2">
          <div className="flex-1 bg-gray-800 rounded-full h-1.5">
            <div
              className="bg-blue-500 h-1.5 rounded-full transition-all duration-500"
              style={{ width: `${(loadedSize / totalSize) * 100}%` }}
            />
          </div>
          <span className="text-[10px] text-gray-500">
            {(loadedSize / 1024 / 1024).toFixed(1)}/{(totalSize / 1024 / 1024).toFixed(1)} MB
          </span>
        </div>
      </div>

      {/* Model List */}
      <div className="space-y-2">
        {MODEL_REGISTRY.map((model) => {
          const status = statuses.find((s) => s.id === model.id);
          const prog = progress[model.id];

          return (
            <div key={model.id} className="bg-gray-900 rounded-lg p-3 border border-gray-800">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm">
                    {status?.status === "ready" ? "✅" : status?.status === "cached" ? "📦" : "⬇️"}
                  </span>
                  <span className="text-xs text-gray-300 font-medium">{model.name}</span>
                  {model.required && (
                    <span className="text-[9px] px-1 py-0.5 bg-blue-900/30 text-blue-400 rounded">
                      required
                    </span>
                  )}
                </div>
                <span className="text-[10px] text-gray-500">
                  {(model.size / 1024 / 1024).toFixed(1)}MB
                </span>
              </div>

              <p className="text-[10px] text-gray-500 mb-2">{model.description}</p>

              {/* Progress Bar */}
              {prog && prog.phase !== "ready" && prog.phase !== "error" && (
                <div className="mb-2">
                  <div className="w-full bg-gray-800 rounded-full h-1.5">
                    <div
                      className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
                      style={{ width: `${prog.progress}%` }}
                    />
                  </div>
                  <p className="text-[9px] text-gray-500 mt-1">
                    {prog.phase === "downloading" ? `Downloading... ${prog.progress}%` : "Loading model..."}
                  </p>
                </div>
              )}

              {/* Error */}
              {prog?.phase === "error" && (
                <p className="text-[10px] text-red-400 mb-2">❌ {prog.error}</p>
              )}

              {/* Action Button */}
              {status?.status !== "ready" && (
                <button
                  onClick={() => loadModel(model.id)}
                  disabled={prog?.phase === "downloading" || prog?.phase === "loading"}
                  className="text-[10px] px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white rounded transition-colors"
                >
                  {prog?.phase === "downloading" || prog?.phase === "loading"
                    ? "Loading..."
                    : "Download"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={loadAll}
          className="flex-1 text-[11px] py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
        >
          Download All
        </button>
        <button
          onClick={clearCache}
          className="text-[11px] px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg transition-colors"
        >
          Clear Cache
        </button>
      </div>

      {/* Info */}
      <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
        <h4 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">How It Works</h4>
        <div className="space-y-1 text-[11px] text-gray-400">
          <p>🔍 <strong>DOM path</strong> (default): Extracts page structure from HTML — fast (~10ms)</p>
          <p>👁️ <strong>Vision path</strong> (with models): Processes screenshots via ONNX — universal (~200ms)</p>
          <p>🔗 <strong>Hybrid path</strong>: DOM structure + vision text — most accurate</p>
        </div>
        <p className="text-[10px] text-gray-600 mt-2">
          Models run entirely in your browser. Zero data leaves your device.
        </p>
      </div>
    </div>
  );
}
