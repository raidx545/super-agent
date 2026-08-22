// ============================================================
// VLESS — Runtime Panel
// Surfaces the on-device ML runtime to the user: detected hardware
// tier, per-model load/cache state, live download progress, and a
// one-click warm-up. This is the visible end of the SW → offscreen
// → backend-detect → Cache-API loader → progress-stream chain.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { onModelProgress } from "../../core/runtime/messaging";
import type {
  BackendProfile,
  ModelId,
  ModelProgress,
  ModelStatus,
} from "../../types/runtime";

function send<T = unknown>(type: string, payload?: unknown): Promise<T> {
  return chrome.runtime.sendMessage({
    type,
    payload,
    source: "sidepanel",
    timestamp: Date.now(),
  }) as Promise<T>;
}

function fmtBytes(n: number): string {
  if (!n) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

const TIER_META: Record<string, { label: string; cls: string }> = {
  A: { label: "GPU accelerated", cls: "bg-emerald-600/20 text-emerald-300 border-emerald-600/40" },
  B: { label: "CPU · SIMD", cls: "bg-sky-600/20 text-sky-300 border-sky-600/40" },
  C: { label: "CPU baseline", cls: "bg-amber-600/20 text-amber-300 border-amber-600/40" },
};

const STATE_META: Record<
  ModelStatus["state"],
  { label: string; dot: string; text: string }
> = {
  ready: { label: "ready", dot: "bg-emerald-400", text: "text-emerald-300" },
  cached: { label: "cached", dot: "bg-emerald-400", text: "text-emerald-300" },
  downloading: { label: "downloading", dot: "bg-sky-400 animate-pulse", text: "text-sky-300" },
  loading: { label: "loading", dot: "bg-sky-400 animate-pulse", text: "text-sky-300" },
  not_loaded: { label: "not loaded", dot: "bg-gray-600", text: "text-gray-400" },
  skipped: { label: "later phase", dot: "bg-gray-700", text: "text-gray-500" },
  error: { label: "error", dot: "bg-red-500", text: "text-red-300" },
};

export function RuntimePanel() {
  const [backend, setBackend] = useState<BackendProfile | null>(null);
  const [statuses, setStatuses] = useState<ModelStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [be, st] = await Promise.all([
        send<BackendProfile>("GET_BACKEND"),
        send<ModelStatus[]>("GET_MODEL_STATUSES"),
      ]);
      setBackend(be);
      setStatuses(st);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Live-patch rows as the offscreen host streams progress.
    const off = onModelProgress((p: ModelProgress) => {
      setStatuses((prev) =>
        prev.map((s) =>
          s.id === p.id
            ? { ...s, state: p.state, progress: p.progress, error: p.error }
            : s,
        ),
      );
    });
    return off;
  }, [refresh]);

  const warm = useCallback(async (ids: ModelId[]) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await send<ModelStatus[]>("WARM_MODELS", { ids });
      setStatuses((prev) =>
        prev.map((s) => updated.find((u) => u.id === s.id) ?? s),
      );
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, []);

  const ocrIds = statuses
    .filter((s) => s.id.startsWith("ocr-"))
    .map((s) => s.id);
  const allEligible = statuses
    .filter((s) => s.state !== "skipped")
    .map((s) => s.id);

  return (
    <div className="p-4 space-y-4">
      {/* ── Backend / tier card ── */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-semibold text-gray-300 uppercase tracking-wide">
            On-Device Runtime
          </h2>
          <button
            onClick={() => void refresh()}
            className="text-[10px] px-2 py-1 bg-gray-800 text-gray-400 hover:bg-gray-700 rounded transition-colors"
          >
            ↻ Refresh
          </button>
        </div>

        {backend ? (
          <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-3">
            <div className="flex items-center gap-2 mb-2">
              <span
                className={`text-[11px] font-bold px-2 py-0.5 rounded border ${
                  TIER_META[backend.tier]?.cls ?? ""
                }`}
              >
                Tier {backend.tier}
              </span>
              <span className="text-[11px] text-gray-400">
                {TIER_META[backend.tier]?.label}
              </span>
            </div>
            <p className="text-[11px] text-gray-500 font-mono leading-relaxed">
              {backend.summary}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Cap on={backend.webgpu} label="WebGPU" />
              <Cap on={backend.wasmSimd} label="WASM SIMD" />
              <Cap on={backend.wasmThreads} label="Threads" />
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-3 text-[11px] text-gray-500">
            Detecting backend…
          </div>
        )}
      </section>

      {/* ── Warm-up actions ── */}
      <section className="flex gap-2">
        <button
          disabled={busy || ocrIds.length === 0}
          onClick={() => void warm(ocrIds)}
          className="flex-1 text-[11px] py-2 rounded bg-blue-600/80 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium transition-colors"
        >
          {busy ? "Working…" : "Warm OCR models"}
        </button>
        <button
          disabled={busy || allEligible.length === 0}
          onClick={() => void warm(allEligible)}
          className="flex-1 text-[11px] py-2 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed text-gray-300 font-medium transition-colors"
        >
          Warm all eligible
        </button>
      </section>

      {error && (
        <p className="text-[11px] text-red-300 bg-red-950/40 border border-red-800/40 rounded px-2 py-1.5">
          {error}
        </p>
      )}

      {/* ── Model list ── */}
      <section className="space-y-2">
        {statuses.map((s) => (
          <ModelRow key={s.id} s={s} />
        ))}
      </section>

      <p className="text-[10px] text-gray-600 leading-relaxed">
        Models are fetched once and cached on-device (Cache API). Nothing here
        leaves your machine. Heavy models (Florence-2, GLiNER, WebLLM) initialize
        in later stages and appear as “later phase”.
      </p>
    </div>
  );
}

function Cap({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded border ${
        on
          ? "border-emerald-600/40 text-emerald-300 bg-emerald-600/10"
          : "border-gray-700 text-gray-600 bg-gray-800/40"
      }`}
    >
      {on ? "✓" : "✕"} {label}
    </span>
  );
}

function ModelRow({ s }: { s: ModelStatus }) {
  const meta = STATE_META[s.state];
  const pct = Math.round((s.progress ?? 0) * 100);
  const showBar = s.state === "downloading" || s.state === "loading";

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full shrink-0 ${meta.dot}`} />
          <span className="text-[11px] text-gray-200 truncate">{s.name}</span>
        </div>
        <span className={`text-[10px] shrink-0 ${meta.text}`}>{meta.label}</span>
      </div>
      <div className="flex items-center justify-between mt-1">
        <span className="text-[10px] text-gray-600">{fmtBytes(s.sizeBytes)}</span>
        {s.required && (
          <span className="text-[9px] text-gray-500 uppercase tracking-wide">
            required
          </span>
        )}
      </div>
      {showBar && (
        <div className="mt-1.5 h-1 bg-gray-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-sky-500 transition-all duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {s.error && (
        <p className="mt-1 text-[10px] text-red-400 truncate" title={s.error}>
          {s.error}
        </p>
      )}
    </div>
  );
}
