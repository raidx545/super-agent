import { useState, useEffect, useRef } from "react";
import {
  getEntries,
  onLogEntry,
  clearEntries,
  type LogEntry,
} from "../../core/agent/learning-log";

const PHASE_COLORS: Record<LogEntry["phase"], string> = {
  discovery: "text-blue-400",
  analysis: "text-purple-400",
  action: "text-yellow-400",
  success: "text-green-400",
  warning: "text-orange-400",
  error: "text-red-400",
  learning: "text-cyan-400",
};

const PHASE_BG: Record<LogEntry["phase"], string> = {
  discovery: "border-blue-800/30",
  analysis: "border-purple-800/30",
  action: "border-yellow-800/30",
  success: "border-green-800/30",
  warning: "border-orange-800/30",
  error: "border-red-800/30",
  learning: "border-cyan-800/30",
};

const PHASE_DOT: Record<LogEntry["phase"], string> = {
  discovery: "bg-blue-400",
  analysis: "bg-purple-400",
  action: "bg-yellow-400",
  success: "bg-green-400",
  warning: "bg-orange-400",
  error: "bg-red-400",
  learning: "bg-cyan-400",
};

export function LearningLog() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEntries(getEntries());
    const unsub = onLogEntry((newEntries) => {
      setEntries([...newEntries]);
    });
    return unsub;
  }, []);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries.length]);

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-8">
        <h3 className="text-sm font-medium text-gray-300 mb-2">
          Agent Learning Log
        </h3>
        <p className="text-[11px] text-gray-500 leading-relaxed">
          Watch the agent discover and learn about pages in real-time. Every
          thought, analysis, and decision is logged here.
        </p>
        <div className="mt-4 space-y-1 text-left">
          {Object.entries(PHASE_COLORS).map(([phase, color]) => (
            <div key={phase} className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              <span className={`text-[11px] ${color} capitalize`}>{phase}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const recentEntries = entries.slice(-100); // Show last 100
  const phaseCount = entries.reduce(
    (acc, e) => {
      acc[e.phase] = (acc[e.phase] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <div className="flex flex-col h-full">
      {/* Stats Bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800 bg-gray-900/50">
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-gray-500">
            {entries.length} entries
          </span>
          {phaseCount["learning"] && (
            <span className="text-[10px] text-cyan-400">
              {phaseCount["learning"]} learned
            </span>
          )}
          {phaseCount["warning"] && (
            <span className="text-[10px] text-orange-400">
              {phaseCount["warning"]} warnings
            </span>
          )}
        </div>
        <button
          onClick={() => {
            clearEntries();
            setEntries([]);
          }}
          className="text-[10px] text-gray-500 hover:text-gray-300"
        >
          Clear
        </button>
      </div>

      {/* Log Entries */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-1.5">
        {recentEntries.map((entry) => {
          const time = new Date(entry.timestamp).toLocaleTimeString();
          return (
            <div
              key={entry.id}
              className={`flex items-start gap-2 py-1.5 px-2 rounded border ${PHASE_BG[entry.phase]} bg-gray-900/30`}
            >
              <span
                className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${PHASE_DOT[entry.phase]}`}
              />
              <div className="flex-1 min-w-0">
                <p
                  className={`text-[11px] ${PHASE_COLORS[entry.phase]} leading-relaxed`}
                >
                  {entry.message}
                </p>
                {entry.details && (
                  <p className="text-[10px] text-gray-600 mt-0.5">
                    {entry.details}
                  </p>
                )}
                {entry.confidence !== undefined && (
                  <span className="text-[9px] text-gray-600">
                    {Math.round(entry.confidence * 100)}% confidence
                  </span>
                )}
              </div>
              <span className="text-[9px] text-gray-600 shrink-0">{time}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
