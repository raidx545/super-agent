// ============================================================
// VLESS — Answer
//
// The response to a question, in plain language. A question is not a
// task with steps, so it does not get a step list — it gets an answer.
// ============================================================

import type { Answer } from "../../core/agent/question-answering";

interface Props {
  answer: Answer;
}

export function AnswerPanel({ answer }: Props) {
  const onDevice = answer.source === "on-device";
  const failed = answer.source === "unanswered";

  return (
    <div className="mt-5 max-w-[94%] animate-slide-in">
      <div className="mb-2 flex items-center gap-2 text-[11px] font-medium text-stone-400">
        <span
          className={`h-1.5 w-1.5 rounded-full ${failed ? "bg-stone-600" : "bg-emerald-400"}`}
        />
        VLESS
      </div>
      <div className="rounded-[18px] rounded-tl-md bg-[#1c1c1b] px-3.5 py-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded-full border border-stone-700 px-2 py-0.5 text-[9px] text-stone-400">
            {onDevice ? "on-device" : answer.source}
          </span>
        </div>

        <p className="text-[13px] leading-relaxed text-stone-100">
          {answer.text}
        </p>

        {answer.detail && (
          <p className="mt-2 break-all text-[11px] text-stone-400">
            {answer.detail}
          </p>
        )}

        <p className="mt-2 text-[10px] text-stone-500">
          {onDevice
            ? "Determined from the page on this device — nothing was sent."
            : answer.source === "vision"
              ? "Answered from the redacted screenshot. The raw capture never left the device."
              : "Try rephrasing, or ask about a specific field."}
        </p>
      </div>
    </div>
  );
}
