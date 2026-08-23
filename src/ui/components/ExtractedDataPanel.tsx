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
      await navigator.clipboard.writeText(extractedDataToJSON(data, { includeRawValues }));
      setCopied(includeRawValues ? "raw" : "masked");
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied("error");
      setTimeout(() => setCopied(null), 2000);
    }
  };

  const { summary } = data;

  return (
    <div className="mx-4 mt-4 space-y-3">
      {/* Header */}
      <div className="p-3 bg-blue-900/20 rounded-lg border border-blue-800/30">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-blue-400">📊</span>
          <span className="text-xs font-medium text-blue-300">Extracted Data</span>
        </div>
        <p className="text-[11px] text-gray-400 truncate" title={data.title}>
          {data.title || data.url}
        </p>
        <p className="text-[10px] text-gray-500 mt-1">
          {summary.fieldCount} fields · {summary.filledFieldCount} filled ·{" "}
          {summary.maskedFieldCount} sensitive · extracted on-device
        </p>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-2">
        {summary.maskedFieldCount > 0 && (
          <button
            onClick={() => setRevealed((r) => !r)}
            className="text-[10px] px-2 py-1 bg-gray-900 border border-gray-700 rounded hover:border-gray-500 text-gray-300 transition-colors"
          >
            {revealed ? "🙈 Mask for sharing" : "👁️ Show real values"}
          </button>
        )}
        {/* Copying matches what is on screen — no surprise mismatch
            between what the user sees and what lands on the clipboard. */}
        <button
          onClick={() => copyJSON(revealed)}
          className="text-[10px] px-2 py-1 bg-gray-900 border border-gray-700 rounded hover:border-gray-500 text-gray-300 transition-colors"
        >
          {copied ? "✅ Copied" : revealed ? "📋 Copy JSON" : "📋 Copy JSON (masked)"}
        </button>
        {revealed && summary.maskedFieldCount > 0 && (
          <button
            onClick={() => copyJSON(false)}
            className="text-[10px] px-2 py-1 bg-gray-900 border border-gray-700 rounded hover:border-gray-500 text-gray-400 transition-colors"
          >
            Copy masked instead
          </button>
        )}
      </div>

      <p className="text-[10px] text-gray-500 leading-relaxed">
        Read from the page on this device. Nothing was transmitted to produce
        this view.
      </p>

      {/* Sections */}
      {data.sections.map((section, si) => (
        <div
          key={`${section.title}-${si}`}
          className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden"
        >
          <div className="px-3 py-2 bg-gray-800/50 border-b border-gray-800">
            <span className="text-[11px] font-medium text-gray-300">{section.title}</span>
            <span className="text-[10px] text-gray-500 ml-2">
              {section.fields.length} fields
            </span>
          </div>
          <div className="divide-y divide-gray-800/50">
            {section.fields.map((field, fi) => (
              <div key={`${field.label}-${fi}`} className="px-3 py-2 flex gap-3">
                <span className="text-[10px] text-gray-500 w-1/3 shrink-0 break-words">
                  {field.label}
                </span>
                <span className="text-[11px] text-gray-200 flex-1 break-all font-mono">
                  {field.value === "" ? (
                    <span className="text-gray-600 italic font-sans">empty</span>
                  ) : revealed && field.rawValue !== undefined ? (
                    field.rawValue
                  ) : (
                    field.value
                  )}
                </span>
                {field.piiCategory && (
                  <span className="text-[9px] px-1.5 py-0.5 h-fit bg-red-900/30 text-red-300 rounded border border-red-800/40 shrink-0">
                    {field.piiCategory}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      {data.sections.length === 0 && (
        <p className="text-[11px] text-gray-500 italic">
          No structured data found on this page.
        </p>
      )}
    </div>
  );
}
