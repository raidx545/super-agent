import { useRef, useEffect } from "react";
import type { AgentTask, ReasoningStep } from "../../types";

interface ReasoningTraceProps {
  steps: ReasoningStep[];
  task: AgentTask | null;
}

const PHASE_CONFIG: Record<
  ReasoningStep["phase"],
  { icon: string; color: string; label: string }
> = {
  observe: { icon: "👁️", color: "text-blue-400", label: "Observing" },
  think: { icon: "🧠", color: "text-purple-400", label: "Thinking" },
  act: { icon: "⚡", color: "text-yellow-400", label: "Acting" },
  verify: { icon: "✅", color: "text-green-400", label: "Verifying" },
  reflect: { icon: "🔄", color: "text-orange-400", label: "Reflecting" },
};

export function ReasoningTrace({ steps, task: _task }: ReasoningTraceProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new steps arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [steps.length]);

  if (steps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-8">
        <div className="text-4xl mb-4">🧠</div>
        <h3 className="text-sm font-medium text-gray-300 mb-2">
          Agent Reasoning Trace
        </h3>
        <p className="text-[11px] text-gray-500 leading-relaxed">
          Start a task to see the agent's thought process in real-time.
          Every decision is logged with full reasoning and confidence scores.
        </p>
        <div className="mt-6 space-y-2 text-left">
          {Object.entries(PHASE_CONFIG).map(([phase, config]) => (
            <div key={phase} className="flex items-center gap-2">
              <span>{config.icon}</span>
              <span className={`text-[11px] ${config.color}`}>{config.label}</span>
              <span className="text-[10px] text-gray-600">
                — {phase === "observe" && "What the agent sees on the page"}
                {phase === "think" && "What the agent is planning to do"}
                {phase === "act" && "What action is being executed"}
                {phase === "verify" && "Confirmation the action worked"}
                {phase === "reflect" && "Adjustments based on results"}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Stats Bar */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-gray-800 bg-gray-900/50">
        <Stat
          label="Steps"
          value={`${steps.length}`}
          icon="📋"
        />
        <Stat
          label="Confidence"
          value={`${Math.round(
            steps.reduce((sum, s) => sum + s.confidence, 0) / steps.length * 100
          )}%`}
          icon="🎯"
        />
        <Stat
          label="Time"
          value={`${(steps.reduce((sum, s) => sum + s.duration, 0) / 1000).toFixed(1)}s`}
          icon="⏱️"
        />
      </div>

      {/* Trace Steps */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {steps.map((step, i) => {
          const config = PHASE_CONFIG[step.phase];
          const time = new Date(step.timestamp).toLocaleTimeString();

          return (
            <div
              key={i}
              className="group relative pl-8"
            >
              {/* Timeline line */}
              {i < steps.length - 1 && (
                <div className="absolute left-3 top-6 bottom-0 w-px bg-gray-800" />
              )}

              {/* Phase indicator */}
              <div className="absolute left-0 top-0 w-6 h-6 flex items-center justify-center">
                <div
                  className={`w-3 h-3 rounded-full border-2 ${
                    step.phase === "observe"
                      ? "border-blue-500 bg-blue-500/20"
                      : step.phase === "think"
                        ? "border-purple-500 bg-purple-500/20"
                        : step.phase === "act"
                          ? "border-yellow-500 bg-yellow-500/20"
                          : step.phase === "verify"
                            ? "border-green-500 bg-green-500/20"
                            : "border-orange-500 bg-orange-500/20"
                  }`}
                />
              </div>

              {/* Step content */}
              <div className="bg-gray-900/50 rounded-lg p-3 border border-gray-800 group-hover:border-gray-700 transition-colors">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs">{config.icon}</span>
                    <span className={`text-[11px] font-medium ${config.color}`}>
                      {config.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-gray-500">{time}</span>
                    <ConfidenceBadge confidence={step.confidence} />
                  </div>
                </div>
                <p className="text-[11px] text-gray-300 leading-relaxed">
                  {step.reasoning}
                </p>
                {step.output && (
                  <p className="text-[10px] text-gray-500 mt-1 font-mono">
                    → {step.output}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────

function Stat({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs">{icon}</span>
      <div>
        <span className="text-[10px] text-gray-500 block">{label}</span>
        <span className="text-[11px] text-gray-300 font-medium">{value}</span>
      </div>
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const color =
    confidence > 0.9
      ? "bg-green-900/30 text-green-400 border-green-800/50"
      : confidence > 0.7
        ? "bg-yellow-900/30 text-yellow-400 border-yellow-800/50"
        : "bg-red-900/30 text-red-400 border-red-800/50";

  return (
    <span
      className={`text-[9px] px-1.5 py-0.5 rounded border ${color}`}
    >
      {Math.round(confidence * 100)}%
    </span>
  );
}
