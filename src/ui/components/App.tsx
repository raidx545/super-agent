import { useState, useEffect, useCallback } from "react";
import { TaskInput } from "./TaskInput";
import { ReasoningTrace } from "./ReasoningTrace";
import { PageInspector } from "./PageInspector";
import { Onboarding } from "./Onboarding";
import { useKeyboardShortcuts, SHORTCUTS } from "../hooks/useKeyboardShortcuts";
import type {
  AgentTask,
  ReasoningStep,
  PageState,
  MessageType,
} from "../../types";

// ── App State ────────────────────────────────────────────────

type Tab = "task" | "debug" | "inspector" | "recipes" | "settings";

const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: "task", icon: "🎯", label: "Task" },
  { id: "debug", icon: "🧠", label: "Debug" },
  { id: "inspector", icon: "🔍", label: "Inspect" },
  { id: "recipes", icon: "📋", label: "Recipes" },
  { id: "settings", icon: "⚙️", label: "Settings" },
];

export function App() {
  const [activeTab, setActiveTab] = useState<Tab>("task");
  const [task, setTask] = useState<AgentTask | null>(null);
  const [reasoningTrace, setReasoningTrace] = useState<ReasoningStep[]>([]);
  const [pageState, setPageState] = useState<PageState | null>(null);
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
        case "UPDATE_DEBUG_OVERLAY":
          if (message.payload.reasoningTrace) {
            setReasoningTrace(message.payload.reasoningTrace);
          }
          break;
        case "PAGE_STATE":
          setPageState(message.payload);
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
      setPageState(response);
    },
    onFocusInput: () => {
      setActiveTab("task");
      const input = document.querySelector("textarea");
      input?.focus();
    },
  });

  // ── Actions ──────────────────────────────────────────────

  const startTask = useCallback(async (description: string, data?: Record<string, string>) => {
    const response = await chrome.runtime.sendMessage({
      type: "START_TASK",
      payload: { description, data },
      source: "sidepanel",
      timestamp: Date.now(),
    });
    setTask(response);
  }, []);

  const cancelTask = useCallback(async () => {
    await chrome.runtime.sendMessage({
      type: "CANCEL_TASK",
      source: "sidepanel",
      timestamp: Date.now(),
    });
    setTask(null);
  }, []);

  const perceivePage = useCallback(async () => {
    const response = await chrome.runtime.sendMessage({
      type: "PERCEIVE_PAGE",
      source: "sidepanel",
      timestamp: Date.now(),
    });
    setPageState(response);
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
        {activeTab === "debug" && (
          <ReasoningTrace steps={reasoningTrace} task={task} />
        )}
        {activeTab === "inspector" && (
          <PageInspector pageState={pageState} onRefresh={perceivePage} />
        )}
        {activeTab === "recipes" && <RecipesPanel />}
        {activeTab === "settings" && <SettingsPanel />}
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

// ── Recipes Panel ────────────────────────────────────────────

function RecipesPanel() {
  const [recipes, setRecipes] = useState<any[]>([]);
  const [importMode, setImportMode] = useState(false);
  const [importJson, setImportJson] = useState("");

  useEffect(() => {
    loadRecipes();
  }, []);

  async function loadRecipes() {
    const { BUILTIN_RECIPES } = await import("../../core/agent/recipes");
    setRecipes(BUILTIN_RECIPES);
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-300">Automation Recipes</h2>
        <button
          onClick={() => setImportMode(!importMode)}
          className="text-[10px] px-2 py-1 bg-gray-800 text-gray-400 hover:bg-gray-700 rounded transition-colors"
        >
          {importMode ? "Cancel" : "Import"}
        </button>
      </div>

      {importMode && (
        <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
          <p className="text-[10px] text-gray-500 mb-2">Paste recipe JSON:</p>
          <textarea
            value={importJson}
            onChange={(e) => setImportJson(e.target.value)}
            className="w-full text-[11px] bg-gray-800 border border-gray-700 rounded p-2 text-gray-300 font-mono resize-none"
            rows={4}
            placeholder='{"name": "...", "steps": [...]}'
          />
          <button className="mt-2 text-[10px] px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-500">
            Import Recipe
          </button>
        </div>
      )}

      <div className="space-y-2">
        {recipes.map((recipe) => (
          <div
            key={recipe.id}
            className="bg-gray-900 rounded-lg p-3 border border-gray-800 hover:border-gray-700 transition-colors cursor-pointer"
          >
            <div className="flex items-start justify-between mb-1">
              <h3 className="text-xs font-medium text-gray-200">{recipe.name}</h3>
              <span className="text-[9px] bg-gray-800 text-gray-500 px-1.5 py-0.5 rounded">
                {recipe.metadata.difficulty}
              </span>
            </div>
            <p className="text-[10px] text-gray-500 mb-2">{recipe.description}</p>
            <div className="flex items-center gap-3 text-[10px] text-gray-600">
              <span>📝 {recipe.steps.length} steps</span>
              <span>⏱️ ~{Math.round(recipe.metadata.estimatedTime / 1000)}s</span>
              <span>🏷️ {recipe.tags.slice(0, 2).join(", ")}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Settings Panel ───────────────────────────────────────────

function SettingsPanel() {
  return (
    <div className="p-4 space-y-4">
      <h2 className="text-sm font-semibold text-gray-300">Settings</h2>

      <div className="space-y-3">
        <SettingToggle label="Auto-perceive on page load" defaultChecked />
        <SettingToggle label="Confirm high-risk actions" defaultChecked />
        <SettingToggle label="Show visual debug overlay" defaultChecked />
        <SettingToggle label="Human-like typing delay" defaultChecked />
        <SettingToggle label="Verbose logging" />
        <SettingToggle label="Show onboarding on startup" />
      </div>

      <div className="pt-4 border-t border-gray-800">
        <h3 className="text-xs font-semibold text-gray-400 mb-2">Privacy</h3>
        <div className="text-[11px] text-gray-500 space-y-1">
          <p>✅ All inference runs on-device</p>
          <p>✅ Zero screenshots sent externally</p>
          <p>✅ Memory stored locally (encrypted)</p>
          <p>✅ No telemetry collected</p>
        </div>
      </div>

      <div className="pt-4 border-t border-gray-800">
        <h3 className="text-xs font-semibold text-gray-400 mb-2">Danger Zone</h3>
        <button className="text-[11px] text-red-400 hover:text-red-300 px-3 py-1.5 border border-red-900 rounded-lg transition-colors">
          Clear All Memory
        </button>
      </div>

      <div className="pt-4 border-t border-gray-800">
        <h3 className="text-xs font-semibold text-gray-400 mb-2">About</h3>
        <p className="text-[11px] text-gray-500">
          VLESS v0.1.0 — Privacy-preserving browser agent with on-device visual perception.
          Built for SIH 2026.
        </p>
      </div>
    </div>
  );
}

function SettingToggle({
  label,
  defaultChecked = false,
}: {
  label: string;
  defaultChecked?: boolean;
}) {
  const [checked, setChecked] = useState(defaultChecked);

  return (
    <label className="flex items-center justify-between cursor-pointer">
      <span className="text-xs text-gray-300">{label}</span>
      <div
        onClick={() => setChecked(!checked)}
        className={`relative w-9 h-5 rounded-full transition-colors ${
          checked ? "bg-blue-600" : "bg-gray-700"
        }`}
      >
        <div
          className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
            checked ? "translate-x-4" : ""
          }`}
        />
      </div>
    </label>
  );
}
