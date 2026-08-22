import { useState, useEffect, useCallback } from "react";
import { TaskInput } from "./TaskInput";
import { ReasoningTrace } from "./ReasoningTrace";

import { LearningLog } from "./LearningLog";
import { PrivacyMonitor } from "./PrivacyMonitor";
import { VoiceControl } from "./VoiceControl";
import { ModelManagerUI } from "./ModelManagerUI";
import { Onboarding } from "./Onboarding";
import { useKeyboardShortcuts, SHORTCUTS } from "../hooks/useKeyboardShortcuts";
import type {
  AgentTask,
  ReasoningStep,
  PageState,
  MessageType,
} from "../../types";

// ── App State ────────────────────────────────────────────────

type Tab = "task" | "models" | "learn" | "privacy" | "voice" | "debug";

const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: "task", icon: "🎯", label: "Task" },
  { id: "models", icon: "👁️", label: "Models" },
  { id: "learn", icon: "🧠", label: "Learn" },
  { id: "privacy", icon: "🔒", label: "Privacy" },
  { id: "voice", icon: "🎙️", label: "Voice" },
  { id: "debug", icon: "📋", label: "Debug" },
];

export function App() {
  const [activeTab, setActiveTab] = useState<Tab>("task");
  const [task, setTask] = useState<AgentTask | null>(null);
  const [reasoningTrace, setReasoningTrace] = useState<ReasoningStep[]>([]);
  const [, _setPageState] = useState<PageState | null>(null);
  const [overlayActive, setOverlayActive] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [historyPosition, _setHistoryPosition] = useState({ current: 0, total: 0 });

  // ── Check First Visit ────────────────────────────────────

  useEffect(() => {
    chrome.storage.local.get("onboardingComplete", (result) => {
      if (!result.onboardingComplete) {
        setShowOnboarding(true);
      }
    });
  }, []);

  const handleOnboardingComplete = useCallback(() => {
    setShowOnboarding(false);
    chrome.storage.local.set({ onboardingComplete: true });
  }, []);

  // ── Message Handling ─────────────────────────────────────

  useEffect(() => {
    const listener = (message: { type: MessageType; payload: any }) => {
      switch (message.type) {
        case "TASK_STATUS":
          setTask(message.payload);
          break;
        case "TASK_COMPLETE":
          setTask(message.payload.task);
          break;
        case "PIPELINE_COMPLETE":
          // Pipeline completed — update task status
          if (message.payload?.plan?.length > 0) {
            setTask({
              id: `pipeline-${Date.now()}`,
              description: message.payload.planResult?.reasoning || "Pipeline task",
              status: "completed",
              plan: { steps: message.payload.plan, estimatedTime: 0, riskLevel: "low", requiresConfirmation: false, dataMappings: [] },
              currentStep: message.payload.plan.length,
              totalSteps: message.payload.plan.length,
              startTime: Date.now(),
              endTime: Date.now(),
              result: `Pipeline: ${message.payload.piiDetection?.summary?.totalRegions || 0} PII detected, ${message.payload.redactionSummary?.redacted || 0} redacted`,
            });
          }
          break;
        case "UPDATE_DEBUG_OVERLAY":
          if (message.payload.reasoningTrace) {
            setReasoningTrace(message.payload.reasoningTrace);
          }
          break;
        case "PAGE_STATE":
          _setPageState(message.payload);
          break;
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  // ── Keyboard Shortcuts ───────────────────────────────────

  useKeyboardShortcuts({
    onNewTask: () => setActiveTab("task"),
    onCancelTask: () => {
      chrome.runtime.sendMessage({
        type: "CANCEL_TASK",
        source: "sidepanel",
        timestamp: Date.now(),
      });
      setTask(null);
    },
    onToggleOverlay: async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: "TOGGLE_OVERLAY",
          payload: { active: !overlayActive },
        });
        setOverlayActive(response?.active ?? false);
      }
    },
    onUndo: () => {
      // TODO: Integrate with action history
      console.log("Undo");
    },
    onRedo: () => {
      // TODO: Integrate with action history
      console.log("Redo");
    },
    onScanPage: async () => {
      const response = await chrome.runtime.sendMessage({
        type: "PERCEIVE_PAGE",
        source: "sidepanel",
        timestamp: Date.now(),
      });
      _setPageState(response);
    },
    onFocusInput: () => {
      setActiveTab("task");
      const input = document.querySelector("textarea");
      input?.focus();
    },
  });

  // ── Actions ──────────────────────────────────────────────

  const startTask = useCallback(async (description: string, data?: Record<string, string>) => {
    // Use the full pipeline (PII detection + redaction + planning)
    const response = await chrome.runtime.sendMessage({
      type: "EXECUTE_PIPELINE",
      payload: { description, data },
      source: "sidepanel",
      timestamp: Date.now(),
    });

    if (response?.plan?.length > 0) {
      setTask({
        id: `pipeline-${Date.now()}`,
        description,
        status: "completed",
        plan: { steps: response.plan, estimatedTime: 0, riskLevel: "low", requiresConfirmation: false, dataMappings: [] },
        currentStep: response.plan.length,
        totalSteps: response.plan.length,
        startTime: Date.now(),
        endTime: Date.now(),
        result: `${response.piiDetection?.summary?.totalRegions || 0} PII detected, ${response.redactionSummary?.redacted || 0} redacted, ${response.plan.length} steps planned`,
      });
    } else {
      // Fallback to simple task execution
      const fallbackResponse = await chrome.runtime.sendMessage({
        type: "START_TASK",
        payload: { description, data },
        source: "sidepanel",
        timestamp: Date.now(),
      });
      setTask(fallbackResponse);
    }
  }, []);

  const cancelTask = useCallback(async () => {
    await chrome.runtime.sendMessage({
      type: "CANCEL_TASK",
      source: "sidepanel",
      timestamp: Date.now(),
    });
    setTask(null);
  }, []);



  const toggleOverlay = useCallback(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: "TOGGLE_OVERLAY",
        payload: { active: !overlayActive },
      });
      setOverlayActive(response?.active ?? false);
    }
  }, [overlayActive]);

  // ── Onboarding ───────────────────────────────────────────

  if (showOnboarding) {
    return <Onboarding onComplete={handleOnboardingComplete} />;
  }

  // ── Render ───────────────────────────────────────────────

  return (
    <div className="h-screen flex flex-col bg-gray-950 text-gray-100 font-sans">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <span className="text-lg">🐾</span>
          <h1 className="text-sm font-bold tracking-wide">VLESS</h1>
          <span className="text-[10px] text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded">
            v0.1.0
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* History position */}
          {historyPosition.total > 0 && (
            <span className="text-[10px] text-gray-500">
              {historyPosition.current}/{historyPosition.total}
            </span>
          )}

          {/* Overlay toggle */}
          <button
            onClick={toggleOverlay}
            className={`text-xs px-2 py-1 rounded transition-colors ${
              overlayActive
                ? "bg-green-600 text-white"
                : "bg-gray-800 text-gray-400 hover:bg-gray-700"
            }`}
            title="Toggle visual overlay (Ctrl+Shift+V)"
          >
            {overlayActive ? "🔍 On" : "🔍 Off"}
          </button>

          {/* Shortcuts */}
          <button
            onClick={() => setShowShortcuts(!showShortcuts)}
            className="text-[10px] px-1.5 py-1 bg-gray-800 text-gray-400 hover:bg-gray-700 rounded transition-colors"
            title="Keyboard shortcuts (Ctrl+/)"
          >
            ⌨️
          </button>

          {/* Status dot */}
          <div
            className={`w-2 h-2 rounded-full ${
              task?.status === "executing"
                ? "bg-green-400 animate-pulse"
                : task?.status === "failed"
                  ? "bg-red-400"
                  : "bg-gray-600"
            }`}
          />
        </div>
      </header>

      {/* Keyboard Shortcuts Overlay */}
      {showShortcuts && (
        <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />
      )}

      {/* Tab Navigation */}
      <nav className="flex border-b border-gray-800">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 text-xs py-2.5 transition-colors ${
              activeTab === tab.id
                ? "text-white border-b-2 border-blue-500 bg-gray-900"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            <span className="block text-sm mb-0.5">{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </nav>

      {/* Content */}
      <main className="flex-1 overflow-y-auto">
        {activeTab === "task" && (
          <TaskInput
            onStartTask={startTask}
            onCancelTask={cancelTask}
            task={task}
          />
        )}
        {activeTab === "models" && <ModelManagerUI />}
        {activeTab === "learn" && <LearningLog />}
        {activeTab === "privacy" && <PrivacyMonitor />}
        {activeTab === "voice" && <VoiceControl />}
        {activeTab === "debug" && (
          <ReasoningTrace steps={reasoningTrace} task={task} />
        )}
      </main>

      {/* Status Bar */}
      <footer className="flex items-center justify-between px-4 py-2 border-t border-gray-800 text-[10px] text-gray-500">
        <span>
          {task
            ? `${task.status} • Step ${task.currentStep}/${task.totalSteps}`
            : "Ready"}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-1.5 h-1.5 bg-green-500 rounded-full" />
          On-Device
        </span>
      </footer>
    </div>
  );
}

// ── Shortcuts Overlay ────────────────────────────────────────

function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 max-w-xs w-full mx-4">
        <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
          ⌨️ Keyboard Shortcuts
        </h3>
        <div className="space-y-2">
          {Object.entries(SHORTCUTS).map(([key, desc]) => (
            <div key={key} className="flex items-center justify-between">
              <span className="text-[11px] text-gray-400">{desc}</span>
              <kbd className="text-[10px] bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-gray-300 font-mono">
                {key}
              </kbd>
            </div>
          ))}
        </div>
        <button
          onClick={onClose}
          className="mt-4 w-full text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
        >
          Close (Esc)
        </button>
      </div>
    </div>
  );
}
