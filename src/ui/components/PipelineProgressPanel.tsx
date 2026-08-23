// ============================================================
// VLESS — Live Pipeline Progress
//
// Renders the run as it happens. Previously the side panel showed
// nothing at all between "Run" and completion — the phase list existed
// only in the in-page overlay, so from the side panel the agent looked
// frozen for the whole run.
// ============================================================

import type { PipelineProgress } from "../../core/pipeline/full-pipeline";

interface Props {
  progress: PipelineProgress;
}

/** Human labels for the internal step names. */
const PHASE_LABELS: Record<string, string> = {
  capture: "Capturing page",
  vision_perception: "Visual perception",
  detect_pii: "Detecting PII",
  detect_faces: "Detecting faces",
  redact: "Redacting",
  verify_redaction: "Verifying redaction",
  init_server: "Selecting planner",
  sanitize: "Sanitizing context",
  extract: "Extracting data",
  get_plan: "Planning actions",
  execute: "Executing",
  show_status: "Reporting",
};

export function PipelineProgressPanel({ progress }: Props) {
  const { steps, elapsedMs } = progress;
  const done = steps.filter((s) => s.status === "complete").length;
  const total = Math.max(steps.length, 1);

  return (
    <section className="mx-4 mt-4 border-y border-stone-800 py-3">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse-dot" />
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-stone-300">
            Run in progress
          </span>
        </div>
        <span className="font-mono text-[10px] tabular-nums text-stone-500">
          {(elapsedMs / 1000).toFixed(1)}s
        </span>
      </div>

      <div className="mb-3 h-px w-full bg-stone-800">
        <div
          className="h-px bg-stone-200 transition-all duration-300"
          style={{ width: `${(done / total) * 100}%` }}
        />
      </div>

      <div className="space-y-2">
        {steps.map((step, i) => (
          <div
            key={`${step.name}-${i}`}
            className="flex items-start gap-2 text-[11px]"
          >
            <span
              className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${step.status === "complete" ? "bg-emerald-400" : step.status === "running" ? "bg-stone-100 animate-pulse-dot" : step.status === "error" ? "bg-red-400" : "bg-stone-700"}`}
            />
            <span
              className={
                step.status === "running"
                  ? "font-medium text-stone-100"
                  : step.status === "error"
                    ? "text-red-200"
                    : "text-stone-400"
              }
            >
              {PHASE_LABELS[step.name] ?? step.name}
            </span>
            {step.details && (
              <span className="flex-1 break-words text-right text-[10px] text-stone-500">
                {step.details}
              </span>
            )}
            {step.status === "complete" &&
              step.latencyMs > 0 &&
              !step.details && (
                <span className="ml-auto shrink-0 font-mono text-[10px] text-stone-600">
                  {step.latencyMs.toFixed(0)}ms
                </span>
              )}
          </div>
        ))}
      </div>
    </section>
  );
}
