// ============================================================
// VLESS — Answer
//
// The response to a question, in plain language. A question is not a
// task with steps, so it does not get a step list — it gets an answer.
// ============================================================

import { useState } from "react";
import type { Answer } from "../../core/agent/question-answering";

interface Props {
  answer: Answer;
}

/**
 * Open the frame in its own tab.
 *
 * Chrome blocks top-level navigation to data: URLs, so an <a href="data:...">
 * fails silently. Converting to a blob URL is what actually opens.
 */
function openFullSize(dataUrl: string): void {
  try {
    const [, mime, b64] = dataUrl.match(/^data:([^;]+);base64,(.*)$/) ?? [];
    if (!b64) return;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    window.open(url, "_blank", "noopener");
    // Give the new tab time to load before releasing the handle.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    // Inline preview above remains available regardless.
  }
}

export function AnswerPanel({ answer }: Props) {
  const [showFrame, setShowFrame] = useState(false);
  const onDevice = answer.source === "on-device";
  const failed = answer.source === "unanswered";

  return (
    <div className="mx-4 mt-4">
      <div
        className={`p-3 rounded-lg border ${
          failed
            ? "bg-gray-900 border-gray-800"
            : "bg-emerald-900/15 border-emerald-800/40"
        }`}
      >
        <div className="flex items-center gap-2 mb-1.5">
          <span className={failed ? "text-gray-500" : "text-emerald-400"}>
            {failed ? "🤷" : "💬"}
          </span>
          <span
            className={`text-xs font-medium ${
              failed ? "text-gray-400" : "text-emerald-200"
            }`}
          >
            Answer
          </span>
          <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded border border-gray-700 text-gray-400 font-mono">
            {onDevice ? "on-device" : answer.source}
          </span>
        </div>

        <p className="text-[13px] text-gray-100 leading-relaxed">{answer.text}</p>

        {answer.detail && (
          <p className="text-[11px] text-gray-400 mt-1.5 font-mono break-all">
            {answer.detail}
          </p>
        )}

        <p className="text-[10px] text-gray-500 mt-2">
          {onDevice
            ? "Determined from the page on this device — nothing was sent."
            : answer.source === "vision"
              ? "Answered from the redacted screenshot. The raw capture never left the device."
              : "Try rephrasing, or ask about a specific field."}
        </p>

        {/* The proof, not the promise: the exact bytes that were transmitted. */}
        {answer.frameSent && (
          <div className="mt-2.5 pt-2.5 border-t border-emerald-800/30">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowFrame((v) => !v)}
                className="text-[10px] px-2 py-1 rounded border border-gray-700 text-gray-300 hover:border-emerald-500 hover:text-emerald-300 transition-colors"
              >
                {showFrame ? "Hide" : "🔍 See exactly what was sent"}
              </button>
              <button
                onClick={() => openFullSize(answer.frameSent!)}
                className="text-[10px] text-gray-400 hover:text-gray-200 underline"
              >
                Open full size
              </button>
            </div>

            {showFrame && (
              <div className="mt-2">
                <img
                  src={answer.frameSent}
                  alt="The redacted frame transmitted to the provider"
                  className="w-full rounded border border-gray-700"
                />
                <p className="text-[10px] text-gray-500 mt-1.5 leading-relaxed">
                  These are the exact image bytes in the request body. Faces and
                  flagged regions are destroyed here, not merely covered — the
                  pixels behind them are gone.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
