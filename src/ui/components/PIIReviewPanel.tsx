// ============================================================
// VLESS — Post-Action Review
//
// After the agent fills a form, the user gets the last word. Every
// sensitive field is listed with what is ACTUALLY in it now (re-read
// from the DOM after execution, not what the plan intended), and any
// of them can be corrected in place.
//
// This exists because an agent writing into a government form must not
// be the final authority on what it wrote.
// ============================================================

import { useState } from "react";
import type { PIIReviewField } from "../../core/pipeline/full-pipeline";

interface Props {
  fields: PIIReviewField[];
}

type SaveState = "idle" | "saving" | "saved" | "error";

export function PIIReviewPanel({ fields }: Props) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [state, setState] = useState<Record<string, SaveState>>({});
  // Real values by default. This panel renders on the user's own machine,
  // showing them their own data — masking it back at them is theatre, and it
  // makes the values impossible to check, which is this panel's whole job.
  // The privacy guarantee is about what LEAVES the device, not what the owner
  // can see. The toggle exists for screen-sharing and projected demos.
  const [revealed, setRevealed] = useState(true);

  const valueOf = (f: PIIReviewField) =>
    edits[f.selector] !== undefined ? edits[f.selector] : f.value;

  const isDirty = (f: PIIReviewField) =>
    edits[f.selector] !== undefined && edits[f.selector] !== f.value;

  const apply = async (f: PIIReviewField) => {
    const value = valueOf(f);
    setState((s) => ({ ...s, [f.selector]: "saving" }));
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("no active tab");
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: "EXECUTE_ACTION",
        payload: {
          id: `review-${Date.now()}`,
          type: "type",
          target: f.selector,
          value,
          retries: 0,
          maxRetries: 1,
        },
        source: "sidepanel",
        timestamp: Date.now(),
      });
      setState((s) => ({ ...s, [f.selector]: res?.success ? "saved" : "error" }));
      setTimeout(() => setState((s) => ({ ...s, [f.selector]: "idle" })), 2000);
    } catch {
      setState((s) => ({ ...s, [f.selector]: "error" }));
      setTimeout(() => setState((s) => ({ ...s, [f.selector]: "idle" })), 2500);
    }
  };

  const empty = fields.filter((f) => !f.value && f.required);

  return (
    <div className="mx-4 mt-4 space-y-2">
      <div className="p-3 bg-blue-900/15 rounded-lg border border-blue-800/30">
        <div className="flex items-center gap-2">
          <span className="text-blue-400">📝</span>
          <span className="text-xs font-medium text-blue-200">Review what was filled</span>
        </div>
        <p className="text-[10px] text-gray-400 mt-1 leading-relaxed">
          Read back from the page after the agent finished. Correct anything
          that is wrong — changes are typed straight into the form.
        </p>
        {empty.length > 0 && (
          <p className="text-[10px] text-amber-400 mt-1.5">
            {empty.length} required field{empty.length === 1 ? "" : "s"} still empty —
            the agent had no local value for {empty.length === 1 ? "it" : "them"}.
          </p>
        )}
      </div>

      {fields.some((f) => f.value) && (
        <button
          onClick={() => setRevealed((r) => !r)}
          className="text-[10px] px-2 py-1 bg-gray-900 border border-gray-700 rounded hover:border-gray-500 text-gray-300 transition-colors"
        >
          {revealed ? "🙈 Mask for sharing" : "👁️ Show real values"}
        </button>
      )}

      <div className="space-y-1.5">
        {fields.map((f) => {
          const st = state[f.selector] ?? "idle";
          const dirty = isDirty(f);
          return (
            <div
              key={f.selector}
              className="bg-gray-900 rounded-lg border border-gray-800 px-3 py-2"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] text-gray-400 flex-1 truncate" title={f.label}>
                  {f.label}
                  {f.required && <span className="text-red-400 ml-0.5">*</span>}
                </span>
                {f.category && (
                  <span className="text-[9px] px-1.5 py-0.5 bg-red-900/30 text-red-300 rounded border border-red-800/40 shrink-0">
                    {f.category}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1.5">
                <input
                  type={revealed ? "text" : "password"}
                  value={valueOf(f)}
                  placeholder={f.value ? "" : "empty — type a value"}
                  onChange={(e) =>
                    setEdits((prev) => ({ ...prev, [f.selector]: e.target.value }))
                  }
                  className="flex-1 min-w-0 text-[11px] font-mono bg-gray-950 border border-gray-700 rounded px-2 py-1 text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
                />
                <button
                  onClick={() => void apply(f)}
                  disabled={!dirty || st === "saving"}
                  className="text-[10px] px-2 py-1 rounded border transition-colors shrink-0 disabled:opacity-35 disabled:cursor-not-allowed border-gray-700 text-gray-300 hover:border-blue-500 hover:text-blue-300"
                >
                  {st === "saving"
                    ? "…"
                    : st === "saved"
                      ? "✓"
                      : st === "error"
                        ? "failed"
                        : "Apply"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {fields.length === 0 && (
        <p className="text-[11px] text-gray-500 italic">
          No sensitive fields were written on this page.
        </p>
      )}
    </div>
  );
}
