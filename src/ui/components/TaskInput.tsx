import { useState } from "react";
import type React from "react";
import type { AgentTask } from "../../types";

interface TaskInputProps {
  onStartTask: (description: string, data?: Record<string, string>) => void;
  onCancelTask: () => void;
  task: AgentTask | null;
  /** The assistant's visible reply. */
  children?: React.ReactNode;
  /** Privacy and pipeline evidence, intentionally hidden until requested. */
  details?: React.ReactNode;
  detailsLabel?: string;
}

const QUICK_TASKS = [
  {
    label: "Fill this form",
    prompt: "Fill the current form with my saved data",
  },
  {
    label: "Extract page data",
    prompt: "Extract all visible data from this page into structured format",
  },
  { label: "Navigate", prompt: "Navigate to the target URL" },
  { label: "Find and click", prompt: "Find and click the target element" },
];

function statusCopy(task: AgentTask): string {
  if (task.status === "analyzing") return "I’m reading the current page.";
  if (task.status === "planning")
    return "I’m mapping the safest way to do that.";
  if (task.status === "executing")
    return "I’m carrying out the requested action.";
  if (task.status === "verifying") return "I’m checking the result.";
  if (task.status === "recovering")
    return "I’m recovering and checking what changed.";
  if (task.status === "completed") return "I’ve finished your request.";
  return "Done.";
}

export function TaskInput({
  onStartTask,
  onCancelTask,
  task,
  children,
  details,
  detailsLabel = "Show details",
}: TaskInputProps) {
  const [input, setInput] = useState("");
  const [showDataFields, setShowDataFields] = useState(false);
  const [dataFields, setDataFields] = useState<Record<string, string>>({});
  const [showDetails, setShowDetails] = useState(false);

  const handleSubmit = () => {
    if (!input.trim()) return;
    setShowDetails(false);
    onStartTask(
      input,
      Object.keys(dataFields).length > 0 ? dataFields : undefined,
    );
    setInput("");
  };

  // Run immediately. Previously this only populated the textbox, so a
  // quick action looked like a no-op until the user noticed the input had
  // changed and pressed Run themselves.
  const handleQuickTask = (prompt: string) => {
    setInput("");
    setShowDetails(false);
    onStartTask(
      prompt,
      Object.keys(dataFields).length > 0 ? dataFields : undefined,
    );
  };

  const isRunning =
    task?.status === "executing" ||
    task?.status === "analyzing" ||
    task?.status === "planning" ||
    task?.status === "verifying";

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#111110]">
      <div className="flex-1 overflow-y-auto px-4 py-5">
        <div className="mx-auto flex min-h-full max-w-[42rem] flex-col">
          {!task && !children && (
            <div className="my-auto pb-12">
              <h2 className="max-w-[17ch] text-[25px] font-medium leading-[1.12] tracking-[-0.035em] text-stone-100">
                What would you like to do?
              </h2>
              <p className="mt-3 max-w-[32ch] text-[13px] leading-5 text-stone-500">
                I can work with the page in front of you while keeping sensitive
                data on this device.
              </p>
              <div className="mt-6 flex flex-wrap gap-2">
                {QUICK_TASKS.map((qt) => (
                  <button
                    key={qt.label}
                    onClick={() => handleQuickTask(qt.prompt)}
                    className="rounded-full border border-stone-700/80 px-3 py-1.5 text-[11px] text-stone-300 transition-colors hover:border-stone-500 hover:bg-stone-800"
                  >
                    {qt.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {task && (
            <div className="ml-auto max-w-[88%] rounded-[18px] rounded-br-md bg-[#2c2c2a] px-3.5 py-2.5 text-[13px] leading-5 text-stone-100 shadow-[0_8px_22px_rgba(0,0,0,0.16)]">
              {task.description}
            </div>
          )}

          {task && (
            <div className="mt-5 max-w-[94%] animate-slide-in">
              <div className="mb-2 flex items-center gap-2 text-[11px] font-medium text-stone-400">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${isRunning ? "bg-emerald-400 animate-pulse-dot" : task.status === "failed" ? "bg-red-400" : "bg-stone-500"}`}
                />
                VLESS
              </div>
              <div
                className={`rounded-[18px] rounded-tl-md px-3.5 py-3 text-[13px] leading-5 ${task.status === "failed" ? "bg-[#2a1c1d] text-stone-100" : "bg-[#1c1c1b] text-stone-200"}`}
              >
                <p>
                  {task.status === "failed"
                    ? task.error || "I couldn’t complete that request."
                    : statusCopy(task)}
                </p>
                {isRunning && (
                  <button
                    onClick={onCancelTask}
                    className="mt-2 text-[11px] text-stone-500 underline decoration-stone-700 underline-offset-4 hover:text-stone-300"
                  >
                    Stop
                  </button>
                )}
              </div>
            </div>
          )}

          {children}

          {details && (
            <div className="mt-5 border-t border-stone-800/80 pt-3">
              <button
                onClick={() => setShowDetails((open) => !open)}
                aria-expanded={showDetails}
                className="flex items-center gap-2 text-[11px] text-stone-500 transition-colors hover:text-stone-300"
              >
                <span className="grid h-4 w-4 place-items-center rounded-full border border-stone-700 text-[10px] text-stone-400">
                  {showDetails ? "−" : "+"}
                </span>
                {showDetails ? "Hide details" : detailsLabel}
              </button>
              {showDetails && (
                <div className="-mx-4 mt-3 animate-slide-in">{details}</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Data Fields (optional) */}
      {showDataFields && (
        <div className="mx-4 mb-2 p-3 bg-gray-900 rounded-lg border border-gray-800">
          <p className="text-[10px] text-gray-500 mb-2">Additional Data</p>
          <div className="space-y-2">
            {Object.entries(dataFields).map(([key, value]) => (
              <div key={key} className="flex gap-2">
                <input
                  value={key}
                  readOnly
                  className="flex-1 text-[11px] bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-300"
                />
                <input
                  value={value}
                  readOnly
                  className="flex-1 text-[11px] bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-300"
                />
              </div>
            ))}
            <button
              onClick={() => {
                const key = prompt("Field name:");
                const value = prompt("Field value:");
                if (key && value) {
                  setDataFields((prev) => ({ ...prev, [key]: value }));
                }
              }}
              className="text-[10px] text-blue-400 hover:text-blue-300"
            >
              + Add field
            </button>
          </div>
        </div>
      )}

      {/* Input Area */}
      <div className="border-t border-stone-800/80 bg-[#111110] px-4 pb-4 pt-3">
        <div className="mx-auto max-w-[42rem]">
          <div className="mb-2 flex items-center gap-2">
            <button
              onClick={() => setShowDataFields(!showDataFields)}
              className={`rounded-full px-2 py-1 text-[10px] transition-colors ${
                showDataFields
                  ? "bg-stone-200 text-stone-950"
                  : "text-stone-500 hover:bg-stone-800 hover:text-stone-300"
              }`}
            >
              Add context
            </button>
          </div>
          <div className="flex items-end gap-2 rounded-[18px] border border-stone-700/90 bg-[#1b1b1a] p-1.5 shadow-[0_10px_24px_rgba(0,0,0,0.18)] focus-within:border-stone-500">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              placeholder="Message VLESS…"
              rows={2}
              className="min-h-[42px] flex-1 resize-none bg-transparent px-2.5 py-2 text-[13px] leading-5 text-stone-100 placeholder:text-stone-600 focus:outline-none"
            />
            <button
              onClick={handleSubmit}
              disabled={!input.trim() || isRunning}
              aria-label="Send message"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-stone-100 text-stone-950 transition-colors hover:bg-white disabled:bg-stone-800 disabled:text-stone-600"
            >
              <svg
                viewBox="0 0 16 16"
                aria-hidden="true"
                className="h-3.5 w-3.5 fill-current"
              >
                <path d="M14.55 1.65a.75.75 0 0 0-.83-.16L1.47 6.8a.75.75 0 0 0 .05 1.4l5.07 1.73 1.73 5.07a.75.75 0 0 0 1.4.05l5.3-12.25a.75.75 0 0 0-.47-1.15ZM8 9.06 3.72 7.6l8.94-3.87L8.8 12.67 7.34 8.4l5.32-4.67L8 9.06Z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
