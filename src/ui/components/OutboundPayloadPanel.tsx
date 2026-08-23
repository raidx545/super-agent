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
    (m) =>
      `"data:image/…;base64,<${(m.length / 1024).toFixed(0)} KB of redacted image>"`,
  );
}

export function OutboundPayloadPanel({ payloads }: Props) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  if (payloads.length === 0) {
    return (
      <section className="mx-4 mt-5 border-y border-stone-800 py-3">
        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-stone-400">
          Egress record
        </p>
        <p className="mt-1 text-[13px] text-stone-100">Nothing was sent</p>
        <p className="mt-1 text-[10px] leading-relaxed text-stone-500">
          This task completed without a single outbound request. There is no
          payload to inspect because none was produced.
        </p>
      </section>
    );
  }

  return (
    <section className="mx-4 mt-5 border-y border-stone-800 py-3">
      <div>
        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-stone-400">
          Egress record
        </p>
        <p className="mt-1 text-[13px] text-stone-100">
          {payloads.length} request{payloads.length === 1 ? "" : "s"} left the
          device
        </p>
        <p className="mt-1 text-[10px] leading-relaxed text-stone-500">
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
          <div
            key={`${p.timestamp}-${i}`}
            className="mt-3 border-t border-stone-800 pt-3"
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-stone-300">
                {p.method}
              </span>
              <span
                className="flex-1 truncate font-mono text-[10px] text-stone-400"
                title={p.url}
              >
                {p.url}
              </span>
              <span
                className={`shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[9px] ${
                  found.length === 0
                    ? "border-emerald-800/50 bg-emerald-900/20 text-emerald-300"
                    : "border-red-800/50 bg-red-900/20 text-red-300"
                }`}
              >
                {found.length === 0 ? "0 PII" : `${found.length} PII`}
              </span>
            </div>

            <div className="mt-1.5 flex items-center gap-2">
              <span className="font-mono text-[10px] text-stone-600">
                {(p.bytes / 1024).toFixed(1)} KB
                {p.truncated ? " (truncated for display)" : ""}
              </span>
              <button
                onClick={() => setOpenIndex(open ? null : i)}
                className="ml-auto rounded-full border border-stone-700 px-2.5 py-1 text-[10px] text-stone-400 transition-colors hover:border-stone-500 hover:text-stone-200"
              >
                {open ? "Hide payload" : "Read payload"}
              </button>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(pretty).then(
                    () => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1800);
                    },
                    () => undefined,
                  );
                }}
                className="rounded-full border border-stone-700 px-2.5 py-1 text-[10px] text-stone-400 transition-colors hover:border-stone-500 hover:text-stone-200"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>

            {open && (
              <>
                <pre className="mt-2 max-h-80 overflow-auto rounded-md border border-stone-800 bg-[#171716] p-2 font-mono text-[10px] leading-relaxed text-stone-300">
                  {pretty}
                </pre>
                <p className="mt-1.5 text-[10px] leading-relaxed text-stone-500">
                  {found.length === 0
                    ? "Re-scanned just now with the same checksum-gated detector used on the page. No PII found — form values appear as hasValue flags, not contents."
                    : "This payload contains matches. That should be impossible — the egress guard blocks validated PII before sending. Worth investigating."}
                </p>
              </>
            )}
          </div>
        );
      })}
    </section>
  );
}
