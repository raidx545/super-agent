// ============================================================
// VLESS — Detected PII Results
//
// Shows the user exactly what was found and protected on their page
// after any task, not just extraction. The pipeline reported "22 PII
// detected" as a bare number with no way to see what those 22 were.
//
// Values are shown in full — this is the user's own data on their own
// screen, and the point is that they can check it. Masking is a toggle
// for screen-sharing. Nothing here was ever transmitted; these regions
// are exactly what the sanitizer stripped before any provider saw it.
// ============================================================

import { useState } from "react";
import type { PIIRegion } from "../../core/privacy/pii-detector";

interface Props {
  regions: PIIRegion[];
}

const SENSITIVITY_STYLE: Record<string, string> = {
  critical: "bg-red-900/30 text-red-300 border-red-800/40",
  high: "bg-orange-900/30 text-orange-300 border-orange-800/40",
  medium: "bg-yellow-900/30 text-yellow-300 border-yellow-800/40",
  low: "bg-gray-800 text-gray-400 border-gray-700",
};

function maskValue(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "*".repeat(value.length);
  return `${value.slice(0, 2)}${"*".repeat(Math.min(value.length - 4, 12))}${value.slice(-2)}`;
}

export function PIIResultsPanel({ regions }: Props) {
  // Real values by default. This panel renders on the user's own machine,
  // showing them their own data — masking it back at them is theatre, and it
  // makes the values impossible to check, which is this panel's whole job.
  // The privacy guarantee is about what LEAVES the device, not what the owner
  // can see. The toggle exists for screen-sharing and projected demos.
  const [revealed, setRevealed] = useState(true);
  const [expanded, setExpanded] = useState(true);

  // Group by category so a 22-region result reads as a handful of rows.
  const byCategory = new Map<string, PIIRegion[]>();
  for (const region of regions) {
    const list = byCategory.get(region.category) ?? [];
    list.push(region);
    byCategory.set(region.category, list);
  }

  const withValues = regions.filter((r) => r.textValue);
  const criticalCount = regions.filter((r) => r.sensitivity === "critical").length;

  return (
    <div className="mx-4 mt-4 space-y-2">
      <div className="p-3 bg-red-900/10 rounded-lg border border-red-900/30">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="w-full flex items-center justify-between"
        >
          <div className="flex items-center gap-2">
            <span className="text-red-400">🔒</span>
            <span className="text-xs font-medium text-red-200">
              {regions.length} PII regions protected
            </span>
          </div>
          <span className="text-[10px] text-gray-500">{expanded ? "▼" : "▶"}</span>
        </button>
        <p className="text-[10px] text-gray-500 mt-1 text-left">
          {criticalCount} critical · {byCategory.size} categories · none of this
          left your device
        </p>
      </div>

      {expanded && (
        <>
          {withValues.length > 0 && (
            <button
              onClick={() => setRevealed((r) => !r)}
              className="text-[10px] px-2 py-1 bg-gray-900 border border-gray-700 rounded hover:border-gray-500 text-gray-300 transition-colors"
            >
              {revealed ? "🙈 Mask for sharing" : `👁️ Show ${withValues.length} values`}
            </button>
          )}

          {[...byCategory.entries()].map(([category, items]) => (
            <div
              key={category}
              className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden"
            >
              <div className="px-3 py-1.5 bg-gray-800/50 border-b border-gray-800 flex items-center justify-between">
                <span className="text-[11px] font-medium text-gray-300">{category}</span>
                <span
                  className={`text-[9px] px-1.5 py-0.5 rounded border ${
                    SENSITIVITY_STYLE[items[0].sensitivity] ?? SENSITIVITY_STYLE.low
                  }`}
                >
                  {items[0].sensitivity}
                </span>
              </div>
              <div className="divide-y divide-gray-800/50">
                {items.map((region, i) => (
                  <div key={`${region.id}-${i}`} className="px-3 py-1.5">
                    <div className="flex items-start gap-2">
                      <span className="text-[11px] text-gray-200 font-mono break-all flex-1">
                        {region.textValue
                          ? revealed
                            ? region.textValue
                            : maskValue(region.textValue)
                          : <span className="text-gray-600 italic font-sans">field flagged, no value</span>}
                      </span>
                      <span className="text-[9px] text-gray-600 shrink-0">
                        {Math.round(region.confidence * 100)}%
                      </span>
                    </div>
                    <p className="text-[9px] text-gray-600 mt-0.5">
                      {region.detectionMethod}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
