// ============================================================
// VLESS — Extracted Data Panel
//
// Renders the result of a read/extract task.
//
// Values are shown as they are. This is the user looking at their own
// page on their own machine; hiding it from them would defeat the point
// of extracting it. Masking is a toggle for screen-sharing, and the JSON
// export follows whatever is currently on screen.
// ============================================================

import { useState } from "react";
import type { ExtractedData } from "../../core/extraction/page-extractor";
import { extractedDataToJSON } from "../../core/extraction/page-extractor";

interface Props {
  data: ExtractedData;
}

export function ExtractedDataPanel({ data }: Props) {
  // Real values by default. This panel renders on the user's own machine,
  // showing them their own data — masking it back at them is theatre, and it
  // makes the values impossible to check, which is this panel's whole job.
  // The privacy guarantee is about what LEAVES the device, not what the owner
  // can see. The toggle exists for screen-sharing and projected demos.
  const [revealed, setRevealed] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);

  const copyJSON = async (includeRawValues: boolean) => {
    try {
      await navigator.clipboard.writeText(
        extractedDataToJSON(data, { includeRawValues }),
      );
      setCopied(includeRawValues ? "raw" : "masked");
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied("error");
      setTimeout(() => setCopied(null), 2000);
    }
  };

  const { summary } = data;

  return (
    <section className="mx-4 mt-5 border-y border-stone-800 py-3">
      <div>
        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-stone-400">
          Extracted data
        </p>
        <p
          className="mt-1 truncate text-[13px] text-stone-100"
          title={data.title}
        >
          {data.title || data.url}
        </p>
        <p className="mt-1 text-[10px] text-stone-500">
          {summary.fieldCount} fields · {summary.filledFieldCount} filled ·{" "}
          {summary.maskedFieldCount} sensitive · extracted on-device
        </p>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {summary.maskedFieldCount > 0 && (
          <button
            onClick={() => setRevealed((r) => !r)}
            className="rounded-full border border-stone-700 px-2.5 py-1 text-[10px] text-stone-400 transition-colors hover:border-stone-500 hover:text-stone-200"
          >
            {revealed ? "Mask values" : "Reveal values"}
          </button>
        )}
        {/* Copying matches what is on screen — no surprise mismatch
            between what the user sees and what lands on the clipboard. */}
        <button
          onClick={() => copyJSON(revealed)}
          className="rounded-full border border-stone-700 px-2.5 py-1 text-[10px] text-stone-400 transition-colors hover:border-stone-500 hover:text-stone-200"
        >
          {copied ? "Copied" : revealed ? "Copy JSON" : "Copy masked JSON"}
        </button>
        {revealed && summary.maskedFieldCount > 0 && (
          <button
            onClick={() => copyJSON(false)}
            className="rounded-full border border-stone-700 px-2.5 py-1 text-[10px] text-stone-400 transition-colors hover:border-stone-500 hover:text-stone-200"
          >
            Copy masked instead
          </button>
        )}
      </div>

      <p className="mt-3 text-[10px] leading-relaxed text-stone-500">
        Read from the page on this device. Nothing was transmitted to produce
        this view.
      </p>

      {/* Sections */}
      {data.sections.map((section, si) => (
        <div
          key={`${section.title}-${si}`}
          className="mt-3 border-t border-stone-800 pt-2.5"
        >
          <div>
            <span className="text-[11px] font-medium text-stone-300">
              {section.title}
            </span>
            <span className="ml-2 text-[10px] text-stone-500">
              {section.fields.length} fields
            </span>
          </div>
          <div className="mt-2 divide-y divide-stone-800/80">
            {section.fields.map((field, fi) => (
              <div
                key={`${field.label}-${fi}`}
                className="flex gap-3 py-2 first:pt-0"
              >
                <span className="w-1/3 shrink-0 break-words text-[10px] text-stone-500">
                  {field.label}
                </span>
                <span className="flex-1 break-all font-mono text-[11px] text-stone-200">
                  {field.value === "" ? (
                    <span className="font-sans italic text-stone-600">
                      empty
                    </span>
                  ) : revealed && field.rawValue !== undefined ? (
                    field.rawValue
                  ) : (
                    field.value
                  )}
                </span>
                {field.piiCategory && (
                  <span className="h-fit shrink-0 rounded-full border border-red-800/40 bg-red-900/30 px-1.5 py-0.5 text-[9px] text-red-300">
                    {field.piiCategory}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      {data.sections.length === 0 && (
        <p className="mt-3 text-[11px] italic text-stone-500">
          No structured data found on this page.
        </p>
      )}
    </section>
  );
}
