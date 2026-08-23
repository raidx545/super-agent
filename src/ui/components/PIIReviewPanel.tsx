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
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
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
      setState((s) => ({
        ...s,
        [f.selector]: res?.success ? "saved" : "error",
      }));
      setTimeout(() => setState((s) => ({ ...s, [f.selector]: "idle" })), 2000);
    } catch {
      setState((s) => ({ ...s, [f.selector]: "error" }));
      setTimeout(() => setState((s) => ({ ...s, [f.selector]: "idle" })), 2500);
    }
  };

  const empty = fields.filter((f) => !f.value && f.required);

  return (
    <section className="mx-4 mt-5 border-y border-stone-800 py-3">
      <div>
        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-stone-400">
          Form review
        </p>
        <p className="mt-1 text-[13px] text-stone-100">Check what was filled</p>
        <p className="mt-1 text-[10px] leading-relaxed text-stone-500">
          Read back from the page after the agent finished. Correct anything
          that is wrong — changes are typed straight into the form.
        </p>
        {empty.length > 0 && (
          <p className="mt-1.5 text-[10px] text-amber-300">
            {empty.length} required field{empty.length === 1 ? "" : "s"} still
            empty — the agent had no local value for{" "}
            {empty.length === 1 ? "it" : "them"}.
          </p>
        )}
      </div>

      {fields.some((f) => f.value) && (
        <button
          onClick={() => setRevealed((r) => !r)}
          className="mt-3 rounded-full border border-stone-700 px-2.5 py-1 text-[10px] text-stone-400 transition-colors hover:border-stone-500 hover:text-stone-200"
        >
          {revealed ? "Mask values" : "Reveal values"}
        </button>
      )}

      <div className="mt-3 divide-y divide-stone-800 border-t border-stone-800">
        {fields.map((f) => {
          const st = state[f.selector] ?? "idle";
          const dirty = isDirty(f);
          return (
            <div key={f.selector} className="py-3">
              <div className="mb-1.5 flex items-center gap-2">
                <span
                  className="flex-1 truncate text-[10px] text-stone-400"
                  title={f.label}
                >
                  {f.label}
                  {f.required && <span className="ml-0.5 text-red-300">*</span>}
                </span>
                {f.category && (
                  <span className="shrink-0 rounded-full border border-red-800/40 bg-red-900/30 px-1.5 py-0.5 text-[9px] text-red-300">
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
                    setEdits((prev) => ({
                      ...prev,
                      [f.selector]: e.target.value,
                    }))
                  }
                  className="min-w-0 flex-1 rounded-md border border-stone-700 bg-[#171716] px-2 py-1 text-[11px] font-mono text-stone-200 placeholder:text-stone-600 transition-colors focus:border-stone-400 focus:outline-none"
                />
                <button
                  onClick={() => void apply(f)}
                  disabled={!dirty || st === "saving"}
                  className="shrink-0 rounded-md border border-stone-700 px-2 py-1 text-[10px] text-stone-300 transition-colors hover:border-stone-500 hover:text-stone-100 disabled:cursor-not-allowed disabled:opacity-35"
                >
                  {st === "saving"
                    ? "…"
                    : st === "saved"
                      ? "Saved"
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
        <p className="mt-3 text-[11px] italic text-stone-500">
          No sensitive fields were written on this page.
        </p>
      )}
    </section>
  );
}
