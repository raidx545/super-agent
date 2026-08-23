// ============================================================
// VLESS — What the agent needs from you
//
// The other half of a run's output. Actions taken are only half the
// story; the fields the agent could not complete are the half that
// decides whether the task actually finished.
//
// Selects render as real dropdowns so a required State field can be
// answered here rather than guessed at by the agent.
// ============================================================

import { useState } from "react";
import type { RequiredInput } from "../../core/agent/requirements";

interface Props {
  needs: RequiredInput[];
  /** Re-run the last task once values have been supplied. */
  onRetry?: () => void;
}

type Status = "idle" | "saving" | "saved" | "error";

export function NeedsInputPanel({ needs, onRetry }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [applyingAll, setApplyingAll] = useState(false);

  const answered = needs.filter((n) => (values[n.selector] ?? "").trim() !== "");

  const applyOne = async (need: RequiredInput): Promise<boolean> => {
    const value = (values[need.selector] ?? "").trim();
    if (!value) return false;
    setStatus((s) => ({ ...s, [need.selector]: "saving" }));
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("no active tab");
      const isSelect = (need.type || "").toLowerCase() === "select";
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: "EXECUTE_ACTION",
        payload: {
          id: `need-${Date.now()}`,
          type: isSelect ? "select" : "type",
          target: need.selector,
          value,
          retries: 0,
          maxRetries: 2,
        },
        source: "sidepanel",
        timestamp: Date.now(),
      });
      const ok = !!res?.success;
      setStatus((s) => ({ ...s, [need.selector]: ok ? "saved" : "error" }));
      return ok;
    } catch {
      setStatus((s) => ({ ...s, [need.selector]: "error" }));
      return false;
    }
  };

  const applyAll = async () => {
    setApplyingAll(true);
    for (const need of answered) {
      await applyOne(need);
    }
    setApplyingAll(false);
  };

  const missing = needs.filter((n) => n.reason === "no_local_value").length;

  return (
    <div className="mx-4 mt-4 space-y-2">
      <div className="p-3 bg-amber-900/15 rounded-lg border border-amber-800/40">
        <div className="flex items-center gap-2">
          <span className="text-amber-400">✋</span>
          <span className="text-xs font-medium text-amber-200">
            The agent needs {needs.length} value{needs.length === 1 ? "" : "s"} from you
          </span>
        </div>
        <p className="text-[10px] text-gray-400 mt-1 leading-relaxed">
          {missing > 0
            ? "These are required fields with no saved value. The agent will not guess at them — supply them here and it will fill them in."
            : "These required fields are still empty after the run."}
        </p>
      </div>

      <div className="space-y-1.5">
        {needs.map((need) => {
          const st = status[need.selector] ?? "idle";
          const value = values[need.selector] ?? "";
          const isSelect = (need.type || "").toLowerCase() === "select";
          return (
            <div key={need.selector} className="bg-gray-900 rounded-lg border border-gray-800 px-3 py-2">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] text-gray-300 flex-1 truncate" title={need.label}>
                  {need.label}<span className="text-red-400 ml-0.5">*</span>
                </span>
                {need.category && (
                  <span className="text-[9px] px-1.5 py-0.5 bg-red-900/30 text-red-300 rounded border border-red-800/40 shrink-0">
                    {need.category}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1.5">
                {isSelect && need.options ? (
                  <select
                    value={value}
                    onChange={(e) => setValues((v) => ({ ...v, [need.selector]: e.target.value }))}
                    className="flex-1 min-w-0 text-[11px] bg-gray-950 border border-gray-700 rounded px-2 py-1 text-gray-200 focus:outline-none focus:border-blue-500"
                  >
                    <option value="">— choose —</option>
                    {need.options.map((o) => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={value}
                    placeholder={need.hint}
                    onChange={(e) => setValues((v) => ({ ...v, [need.selector]: e.target.value }))}
                    className="flex-1 min-w-0 text-[11px] font-mono bg-gray-950 border border-gray-700 rounded px-2 py-1 text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
                  />
                )}
                <button
                  onClick={() => void applyOne(need)}
                  disabled={!value.trim() || st === "saving"}
                  className="text-[10px] px-2 py-1 rounded border border-gray-700 text-gray-300 hover:border-amber-500 hover:text-amber-300 transition-colors shrink-0 disabled:opacity-35 disabled:cursor-not-allowed"
                >
                  {st === "saving" ? "…" : st === "saved" ? "✓" : st === "error" ? "failed" : "Fill"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {answered.length > 1 && (
        <div className="flex gap-2">
          <button
            onClick={() => void applyAll()}
            disabled={applyingAll}
            className="text-[10px] px-2.5 py-1.5 rounded bg-amber-700/40 border border-amber-700/60 text-amber-200 hover:bg-amber-700/60 transition-colors disabled:opacity-50"
          >
            {applyingAll ? "Filling…" : `Fill all ${answered.length}`}
          </button>
          {onRetry && (
            <button
              onClick={onRetry}
              className="text-[10px] px-2.5 py-1.5 rounded border border-gray-700 text-gray-300 hover:border-gray-500 transition-colors"
            >
              Re-run task
            </button>
          )}
        </div>
      )}
    </div>
  );
}
