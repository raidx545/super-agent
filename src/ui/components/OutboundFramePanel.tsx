// ============================================================
// VLESS — Outbound frame
//
// The redacted screenshot: what WOULD be transmitted if a task needed
// pixels. Shown after every run, whether or not anything was sent,
// because "is the blur actually working?" is a question the user should
// be able to answer by looking rather than by trusting.
//
// This is always the redacted frame. The raw capture is never surfaced
// here and never leaves the device.
// ============================================================

import { useState } from "react";

interface Props {
  frame: string;
  /** Did re-OCR confirm no readable PII survived? */
  verified?: boolean;
  /** True when this frame was actually transmitted, not merely prepared. */
  wasSent?: boolean;
}

/**
 * Open the frame full size in its own tab.
 * Chrome blocks top-level navigation to data: URLs, so this converts to a
 * blob URL — an <a href="data:..."> would fail silently.
 */
function openFullSize(dataUrl: string): void {
  try {
    const [, mime, b64] = dataUrl.match(/^data:([^;]+);base64,(.*)$/) ?? [];
    if (!b64) return;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    /* the inline preview still works */
  }
}

export function OutboundFramePanel({ frame, verified, wasSent }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <section className="mx-4 mt-5 border-y border-stone-800 py-3">
      <div>
        <div className="flex items-center gap-2">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-stone-400">
              Redacted frame
            </p>
            <p className="mt-1 text-[13px] text-stone-100">
              {wasSent
                ? "Frame sent to the provider"
                : "Frame prepared for sending"}
            </p>
          </div>
          <span
            className={`ml-auto rounded-full border px-1.5 py-0.5 font-mono text-[9px] ${
              verified
                ? "border-emerald-800/50 text-emerald-300 bg-emerald-900/20"
                : "border-amber-800/50 text-amber-300 bg-amber-900/20"
            }`}
          >
            {verified ? "re-OCR verified" : "unverified"}
          </span>
        </div>

        <p className="mt-1 text-[10px] leading-relaxed text-stone-500">
          {wasSent
            ? "These are the exact bytes that went into the request body."
            : "Nothing was transmitted for this task. This is the redacted frame that would be used if it were."}
        </p>

        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => setOpen((v) => !v)}
            className="rounded-full border border-stone-700 px-2.5 py-1 text-[10px] text-stone-400 transition-colors hover:border-stone-500 hover:text-stone-200"
          >
            {open ? "Hide frame" : "Inspect frame"}
          </button>
          <button
            onClick={() => openFullSize(frame)}
            className="text-[10px] text-stone-500 underline decoration-stone-700 underline-offset-4 hover:text-stone-200"
          >
            Open full size
          </button>
        </div>

        {open && (
          <div className="mt-3">
            <img
              src={frame}
              alt="Redacted frame prepared for transmission"
              className="w-full rounded-md border border-stone-700"
            />
            <p className="mt-1.5 text-[10px] leading-relaxed text-stone-500">
              Faces and flagged regions are destroyed here, not covered — the
              pixels behind them are gone, which is why re-OCR can confirm it.
              Compare against the live page to see the difference.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
