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
  const criticalCount = regions.filter(
    (r) => r.sensitivity === "critical",
  ).length;

  return (
    <section className="mx-4 mt-5 border-y border-stone-800 py-3">
      <div>
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex w-full items-center justify-between text-left"
        >
          <div>
            <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-stone-400">
              Redaction record
            </p>
            <p className="mt-1 text-[13px] text-stone-100">
              {regions.length} protected region{regions.length === 1 ? "" : "s"}
            </p>
          </div>
          <span className="text-[10px] text-stone-500">
            {expanded ? "Hide" : "Inspect"}
          </span>
        </button>
        <p className="mt-1 text-[10px] text-stone-500">
          {criticalCount} critical · {byCategory.size} categories · none of this
          left your device
        </p>
      </div>

      {expanded && (
        <div className="mt-3">
          {withValues.length > 0 && (
            <button
              onClick={() => setRevealed((r) => !r)}
              className="mb-3 rounded-full border border-stone-700 px-2.5 py-1 text-[10px] text-stone-400 transition-colors hover:border-stone-500 hover:text-stone-200"
            >
              {revealed ? "Mask values" : `Reveal ${withValues.length} values`}
            </button>
          )}

          {[...byCategory.entries()].map(([category, items]) => (
            <div
              key={category}
              className="border-t border-stone-800 py-2.5 first:border-t-0 first:pt-0"
            >
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-stone-300">
                  {category}
                </span>
                <span
                  className={`rounded-full border px-1.5 py-0.5 text-[9px] ${
                    SENSITIVITY_STYLE[items[0].sensitivity] ??
                    SENSITIVITY_STYLE.low
                  }`}
                >
                  {items[0].sensitivity}
                </span>
              </div>
              <div className="mt-2 divide-y divide-stone-800/80">
                {items.map((region, i) => (
                  <div key={`${region.id}-${i}`} className="py-2 first:pt-0">
                    <div className="flex items-start gap-2">
                      <span className="flex-1 break-all font-mono text-[11px] text-stone-200">
                        {region.textValue ? (
                          revealed ? (
                            region.textValue
                          ) : (
                            maskValue(region.textValue)
                          )
                        ) : (
                          <span className="font-sans italic text-stone-600">
                            field flagged, no value
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-[9px] text-stone-600">
                        {Math.round(region.confidence * 100)}%
                      </span>
                    </div>
                    <p className="mt-0.5 text-[9px] text-stone-600">
                      {region.detectionMethod}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
