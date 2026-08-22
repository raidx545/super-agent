import React from "react";
import type { AgentTask, AgentStatus } from "../../types";

interface AgentStatusPanelProps {
  task: AgentTask | null;
}

const STATUS_CONFIG: Record<
  AgentStatus,
  { icon: string; color: string; bgColor: string; label: string }
> = {
  idle: { icon: "💤", color: "text-gray-400", bgColor: "bg-gray-800", label: "Idle" },
  analyzing: { icon: "👁️", color: "text-blue-400", bgColor: "bg-blue-900/20", label: "Analyzing Page" },
  planning: { icon: "🧠", color: "text-purple-400", bgColor: "bg-purple-900/20", label: "Planning Actions" },
  executing: { icon: "⚡", color: "text-yellow-400", bgColor: "bg-yellow-900/20", label: "Executing" },
  verifying: { icon: "✅", color: "text-green-400", bgColor: "bg-green-900/20", label: "Verifying" },
  recovering: { icon: "🔄", color: "text-orange-400", bgColor: "bg-orange-900/20", label: "Recovering" },
  completed: { icon: "🎉", color: "text-green-400", bgColor: "bg-green-900/20", label: "Completed" },
  failed: { icon: "❌", color: "text-red-400", bgColor: "bg-red-900/20", label: "Failed" },
  paused: { icon: "⏸️", color: "text-yellow-400", bgColor: "bg-yellow-900/20", label: "Paused" },
  waiting_for_user: { icon: "🙋", color: "text-cyan-400", bgColor: "bg-cyan-900/20", label: "Waiting for Input" },
};

export function AgentStatusPanel({ task }: AgentStatusPanelProps) {
  if (!task) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center">
        <div className="text-4xl mb-3">🐾</div>
        <p className="text-xs text-gray-500">
          No active task. Start one from the Task tab.
        </p>
      </div>
    );
  }

  const config = STATUS_CONFIG[task.status];
  const progress = task.totalSteps > 0
    ? Math.round((task.currentStep / task.totalSteps) * 100)
    : 0;

  return (
    <div className="p-4 space-y-4">
      {/* Status Header */}
      <div className={`${config.bgColor} rounded-lg p-4 border border-gray-800`}>
        <div className="flex items-center gap-3 mb-3">
          <span className="text-2xl">{config.icon}</span>
          <div>
            <h3 className={`text-sm font-semibold ${config.color}`}>
              {config.label}
            </h3>
            <p className="text-[11px] text-gray-500">
              {task.description}
            </p>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="w-full bg-gray-800 rounded-full h-2 mb-2">
          <div
            className="bg-blue-500 h-2 rounded-full transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="flex justify-between text-[10px] text-gray-500">
          <span>Step {task.currentStep} / {task.totalSteps}</span>
          <span>{progress}%</span>
        </div>
      </div>

      {/* Step Details */}
      {task.status === "executing" && task.plan.steps.length > 0 && (
        <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
          <h4 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">
            Current Step
          </h4>
          {task.plan.steps[task.currentStep] && (
            <div className="space-y-1">
              <p className="text-[11px] text-gray-300">
                {task.plan.steps[task.currentStep].reasoning}
              </p>
              <div className="flex items-center gap-3 text-[10px] text-gray-500">
                <span>
                  Action: {task.plan.steps[task.currentStep].action.type}
                </span>
                <span>
                  Confidence: {Math.round(task.plan.steps[task.currentStep].confidence * 100)}%
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error Details */}
      {task.status === "failed" && task.error && (
        <div className="bg-red-900/20 rounded-lg p-3 border border-red-800/30">
          <h4 className="text-[10px] text-red-400 uppercase tracking-wider mb-1">
            Error
          </h4>
          <p className="text-[11px] text-gray-400 font-mono">{task.error}</p>
        </div>
      )}

      {/* Result */}
      {task.status === "completed" && task.result && (
        <div className="bg-green-900/20 rounded-lg p-3 border border-green-800/30">
          <h4 className="text-[10px] text-green-400 uppercase tracking-wider mb-1">
            Result
          </h4>
          <p className="text-[11px] text-gray-400">{task.result}</p>
        </div>
      )}

      {/* Timing */}
      <div className="text-center text-[10px] text-gray-600">
        {task.startTime && (
          <span>
            Started {new Date(task.startTime).toLocaleTimeString()}
            {task.endTime && (
              <> • Duration {((task.endTime - task.startTime) / 1000).toFixed(1)}s</>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
