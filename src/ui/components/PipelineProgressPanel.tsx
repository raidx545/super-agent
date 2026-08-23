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
    <div className="mx-4 mt-4 p-3 bg-blue-900/20 rounded-lg border border-blue-800/30">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
          <span className="text-xs font-medium text-blue-300">Running…</span>
        </div>
        <span className="text-[10px] text-gray-500 font-mono">
          {(elapsedMs / 1000).toFixed(1)}s
        </span>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-gray-800 rounded-full h-1.5 mb-3">
        <div
          className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
          style={{ width: `${(done / total) * 100}%` }}
        />
      </div>

      {/* Phase list */}
      <div className="space-y-1">
        {steps.map((step, i) => (
          <div key={`${step.name}-${i}`} className="flex items-start gap-2 text-[11px]">
            <span className="w-3 shrink-0 text-center">
              {step.status === "complete"
                ? "✅"
                : step.status === "running"
                  ? "⏳"
                  : step.status === "error"
                    ? "❌"
                    : "·"}
            </span>
            <span
              className={
                step.status === "running"
                  ? "text-blue-300 font-medium"
                  : step.status === "error"
                    ? "text-red-300"
                    : "text-gray-400"
              }
            >
              {PHASE_LABELS[step.name] ?? step.name}
            </span>
            {step.details && (
              <span className="text-[10px] text-gray-500 flex-1 text-right break-words">
                {step.details}
              </span>
            )}
            {step.status === "complete" && step.latencyMs > 0 && !step.details && (
              <span className="text-[10px] text-gray-600 ml-auto font-mono shrink-0">
                {step.latencyMs.toFixed(0)}ms
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
