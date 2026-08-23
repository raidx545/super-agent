// ============================================================
// VLESS — Outbound payload
//
// The literal request bodies that left the device, taken from the egress
// guard rather than reconstructed. This is the text counterpart to the
// redacted-frame preview: you can see the pixels, and now you can read
// the JSON the planner actually received.
//
// Each payload is re-scanned here, in the panel, with the same
// checksum-gated detector used everywhere else. A "0 PII found" badge you
// can watch being computed is worth more than a promise in a README.
// ============================================================

import { useState } from "react";
import type { OutboundPayload } from "../../core/privacy/egress-guard";
import { scanTextForPII } from "../../core/privacy/pii-detector";

interface Props {
  payloads: OutboundPayload[];
}

/** Pretty-print JSON bodies; leave anything else alone. */
function formatBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/** Base64 image blobs are unreadable and swamp the view. */
function elideDataUrls(text: string): string {
  return text.replace(
    /"data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]{40,}"/g,
    (m) => `"data:image/…;base64,<${(m.length / 1024).toFixed(0)} KB of redacted image>"`
  );
}

export function OutboundPayloadPanel({ payloads }: Props) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  if (payloads.length === 0) {
    return (
      <div className="mx-4 mt-4">
        <div className="rounded-lg border border-emerald-800/40 bg-emerald-900/15 p-3">
          <div className="flex items-center gap-2">
            <span className="text-emerald-400">📡</span>
            <span className="text-xs font-medium text-emerald-200">
              Nothing was sent
            </span>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-gray-400">
            This task completed without a single outbound request. There is no
            payload to inspect because none was produced.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-4 mt-4 space-y-2">
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-3">
        <div className="flex items-center gap-2">
          <span className="text-gray-400">📡</span>
          <span className="text-xs font-medium text-gray-200">
            {payloads.length} request{payloads.length === 1 ? "" : "s"} left the device
          </span>
        </div>
        <p className="mt-1 text-[10px] leading-relaxed text-gray-500">
          Exact request bodies, captured at the egress guard. This is what the
          provider received.
        </p>
      </div>

      {payloads.map((p, i) => {
        const pretty = elideDataUrls(formatBody(p.body));
        // Re-scan in the panel so the badge is computed, not asserted.
        const found = scanTextForPII(p.body, { includeUnvalidated: true });
        const open = openIndex === i;

        return (
          <div key={`${p.timestamp}-${i}`} className="rounded-lg border border-gray-800 bg-gray-900 p-3">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-gray-300">{p.method}</span>
              <span className="flex-1 truncate font-mono text-[10px] text-gray-400" title={p.url}>
                {p.url}
              </span>
              <span
                className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] ${
                  found.length === 0
                    ? "border-emerald-800/50 bg-emerald-900/20 text-emerald-300"
                    : "border-red-800/50 bg-red-900/20 text-red-300"
                }`}
              >
                {found.length === 0 ? "0 PII" : `${found.length} PII`}
              </span>
            </div>

            <div className="mt-1.5 flex items-center gap-2">
              <span className="font-mono text-[10px] text-gray-600">
                {(p.bytes / 1024).toFixed(1)} KB{p.truncated ? " (truncated for display)" : ""}
              </span>
              <button
                onClick={() => setOpenIndex(open ? null : i)}
                className="ml-auto rounded border border-gray-700 px-2 py-1 text-[10px] text-gray-300 transition-colors hover:border-emerald-500 hover:text-emerald-300"
              >
                {open ? "Hide" : "🔍 Read the payload"}
              </button>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(pretty).then(
                    () => { setCopied(true); setTimeout(() => setCopied(false), 1800); },
                    () => undefined
                  );
                }}
                className="rounded border border-gray-700 px-2 py-1 text-[10px] text-gray-400 transition-colors hover:border-gray-500"
              >
                {copied ? "✓" : "Copy"}
              </button>
            </div>

            {open && (
              <>
                <pre className="mt-2 max-h-80 overflow-auto rounded border border-gray-800 bg-gray-950 p-2 font-mono text-[10px] leading-relaxed text-gray-300">
                  {pretty}
                </pre>
                <p className="mt-1.5 text-[10px] leading-relaxed text-gray-500">
                  {found.length === 0
                    ? "Re-scanned just now with the same checksum-gated detector used on the page. No PII found — form values appear as hasValue flags, not contents."
                    : "This payload contains matches. That should be impossible — the egress guard blocks validated PII before sending. Worth investigating."}
                </p>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
