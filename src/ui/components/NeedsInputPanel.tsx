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

  const answered = needs.filter(
    (n) => (values[n.selector] ?? "").trim() !== "",
  );

  const applyOne = async (need: RequiredInput): Promise<boolean> => {
    const value = (values[need.selector] ?? "").trim();
    if (!value) return false;
    setStatus((s) => ({ ...s, [need.selector]: "saving" }));
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
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
    <section className="mx-4 mt-5 border-y border-stone-800 py-3">
      <div>
        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-stone-400">
          Input required
        </p>
        <p className="mt-1 text-[13px] text-stone-100">
          {needs.length} value{needs.length === 1 ? "" : "s"} needed to continue
        </p>
        <p className="mt-1 text-[10px] leading-relaxed text-stone-500">
          {missing > 0
            ? "These are required fields with no saved value. The agent will not guess at them — supply them here and it will fill them in."
            : "These required fields are still empty after the run."}
        </p>
      </div>

      <div className="mt-3 divide-y divide-stone-800 border-t border-stone-800">
        {needs.map((need) => {
          const st = status[need.selector] ?? "idle";
          const value = values[need.selector] ?? "";
          const isSelect = (need.type || "").toLowerCase() === "select";
          return (
            <div key={need.selector} className="py-3">
              <div className="mb-1.5 flex items-center gap-2">
                <span
                  className="flex-1 truncate text-[10px] text-stone-300"
                  title={need.label}
                >
                  {need.label}
                  <span className="ml-0.5 text-red-300">*</span>
                </span>
                {need.category && (
                  <span className="shrink-0 rounded-full border border-red-800/40 bg-red-900/30 px-1.5 py-0.5 text-[9px] text-red-300">
                    {need.category}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1.5">
                {isSelect && need.options ? (
                  <select
                    value={value}
                    onChange={(e) =>
                      setValues((v) => ({
                        ...v,
                        [need.selector]: e.target.value,
                      }))
                    }
                    className="min-w-0 flex-1 rounded-md border border-stone-700 bg-[#171716] px-2 py-1 text-[11px] text-stone-200 focus:border-stone-400 focus:outline-none"
                  >
                    <option value="">— choose —</option>
                    {need.options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={value}
                    placeholder={need.hint}
                    onChange={(e) =>
                      setValues((v) => ({
                        ...v,
                        [need.selector]: e.target.value,
                      }))
                    }
                    className="min-w-0 flex-1 rounded-md border border-stone-700 bg-[#171716] px-2 py-1 text-[11px] font-mono text-stone-200 placeholder:text-stone-600 focus:border-stone-400 focus:outline-none"
                  />
                )}
                <button
                  onClick={() => void applyOne(need)}
                  disabled={!value.trim() || st === "saving"}
                  className="shrink-0 rounded-md border border-stone-700 px-2 py-1 text-[10px] text-stone-300 transition-colors hover:border-stone-500 hover:text-stone-100 disabled:cursor-not-allowed disabled:opacity-35"
                >
                  {st === "saving"
                    ? "Saving"
                    : st === "saved"
                      ? "Saved"
                      : st === "error"
                        ? "Failed"
                        : "Apply"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {answered.length > 1 && (
        <div className="mt-3 flex gap-2">
          <button
            onClick={() => void applyAll()}
            disabled={applyingAll}
            className="rounded-md bg-stone-100 px-2.5 py-1.5 text-[10px] text-stone-950 transition-colors hover:bg-white disabled:opacity-50"
          >
            {applyingAll ? "Filling…" : `Fill all ${answered.length}`}
          </button>
          {onRetry && (
            <button
              onClick={onRetry}
              className="rounded-md border border-stone-700 px-2.5 py-1.5 text-[10px] text-stone-300 transition-colors hover:border-stone-500"
            >
              Re-run task
            </button>
          )}
        </div>
      )}
    </section>
  );
}
