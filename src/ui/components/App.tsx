import { useState, useEffect, useCallback } from "react";
import { TaskInput } from "./TaskInput";
import { ExtractedDataPanel } from "./ExtractedDataPanel";
import type { ExtractedData } from "../../core/extraction/page-extractor";
import type {
  PipelineProgress,
  PIIReviewField,
} from "../../core/pipeline/full-pipeline";
import type { RequiredInput } from "../../core/agent/requirements";
import type { Answer } from "../../core/agent/question-answering";
import type { PIIRegion } from "../../core/privacy/pii-detector";
import type { SubTask } from "../../core/agent/task-decomposer";
import { PipelineProgressPanel } from "./PipelineProgressPanel";
import { PIIResultsPanel } from "./PIIResultsPanel";
import { PIIReviewPanel } from "./PIIReviewPanel";
import { NeedsInputPanel } from "./NeedsInputPanel";
import { AnswerPanel } from "./AnswerPanel";
import { OutboundFramePanel } from "./OutboundFramePanel";
import { OutboundPayloadPanel } from "./OutboundPayloadPanel";
import { ReasoningTrace } from "./ReasoningTrace";

import { LearningLog } from "./LearningLog";
import { PrivacyMonitor } from "./PrivacyMonitor";
import { VoiceControl } from "./VoiceControl";
import { RuntimePanel } from "./RuntimePanel";
import { ProviderSettings } from "./ProviderSettings";
import { Onboarding } from "./Onboarding";
import { useKeyboardShortcuts, SHORTCUTS } from "../hooks/useKeyboardShortcuts";
import type {
  AgentTask,
  ReasoningStep,
  PageState,
  MessageType,
} from "../../types";

// ── App State ────────────────────────────────────────────────

type Tab = "task" | "ai" | "models" | "learn" | "privacy" | "voice" | "debug";

const UTILITY_TABS: { id: Tab; label: string }[] = [
  { id: "ai", label: "AI providers" },
  { id: "models", label: "Runtime" },
  { id: "learn", label: "Activity" },
  { id: "voice", label: "Voice" },
  { id: "debug", label: "Debug" },
];

export function App() {
  const [activeTab, setActiveTab] = useState<Tab>("task");
  const [task, setTask] = useState<AgentTask | null>(null);
  const [extractedData, setExtractedData] = useState<ExtractedData | null>(
    null,
  );
  const [piiRegions, setPiiRegions] = useState<PIIRegion[] | null>(null);
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [subTasks, setSubTasks] = useState<SubTask[] | null>(null);
  const [piiReview, setPiiReview] = useState<PIIReviewField[] | null>(null);
  const [needs, setNeeds] = useState<RequiredInput[] | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [frame, setFrame] = useState<{
    url: string;
    verified?: boolean;
    sent?: boolean;
  } | null>(null);
  const [payloads, setPayloads] = useState<any[] | null>(null);
  const [lastTask, setLastTask] = useState<{
    description: string;
    data?: Record<string, string>;
  } | null>(null);
  const [reasoningTrace, setReasoningTrace] = useState<ReasoningStep[]>([]);
  const [, _setPageState] = useState<PageState | null>(null);
  const [overlayActive, setOverlayActive] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showUtilities, setShowUtilities] = useState(false);
  const [historyPosition, _setHistoryPosition] = useState({
    current: 0,
    total: 0,
  });
  const [llmStatus, setLlmStatus] = useState<{
    available: boolean;
    provider?: string;
    model?: string;
  }>({ available: false });

  // ── Check First Visit & LLM Status ───────────────────────

  useEffect(() => {
    chrome.storage.local.get("onboardingComplete", (result) => {
      if (!result.onboardingComplete) {
        setShowOnboarding(true);
      }
    });

    // Check if any LLM provider is available
    const checkLLM = async () => {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "CHECK_PROVIDERS",
          source: "sidepanel",
          timestamp: Date.now(),
        });
        if (response?.statuses) {
          const active = response.statuses.find(
            (s: { available: boolean }) => s.available,
          );
          if (active) {
            setLlmStatus({
              available: true,
              provider: active.name,
              model: active.model,
            });
          } else {
            setLlmStatus({ available: false });
          }
        }
      } catch {
        setLlmStatus({ available: false });
      }
    };
    checkLLM();
  }, []);

  const handleOnboardingComplete = useCallback((openSettings?: boolean) => {
    setShowOnboarding(false);
    chrome.storage.local.set({ onboardingComplete: true });
    if (openSettings) {
      setActiveTab("ai");
    }
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
        case "PIPELINE_PROGRESS":
          setProgress(message.payload);
          break;
        case "PIPELINE_COMPLETE":
          setProgress(null);
          if (message.payload?.piiDetection?.regions) {
            setPiiRegions(message.payload.piiDetection.regions);
          }
          if (message.payload?.piiReview?.length) {
            setPiiReview(message.payload.piiReview);
          }
          if (message.payload?.needs?.length) {
            setNeeds(message.payload.needs);
          }
          if (message.payload?.answer) {
            setAnswer(message.payload.answer);
          }
          if (message.payload?.sentPayloads) {
            setPayloads(message.payload.sentPayloads);
          }
          if (message.payload?.redactedFrame) {
            setFrame({
              url: message.payload.redactedFrame,
              verified: message.payload.frameVerified,
              sent: Boolean(message.payload.answer?.frameSent),
            });
          }
          // An extraction task completes with an empty plan — it never goes
          // through the planner — so it must be handled before the plan-length
          // check below, which would otherwise drop the result silently.
          if (message.payload?.extractedData) {
            setExtractedData(message.payload.extractedData);
            const ex = message.payload.extractedData;
            setTask({
              id: `extract-${Date.now()}`,
              description: "Extract data",
              status: "completed",
              plan: {
                steps: [],
                estimatedTime: 0,
                riskLevel: "low",
                requiresConfirmation: false,
                dataMappings: [],
              },
              currentStep: 0,
              totalSteps: 0,
              startTime: Date.now(),
              endTime: Date.now(),
              result: `Extracted ${ex.summary.fieldCount} fields (${ex.summary.maskedFieldCount} masked) on-device`,
            });
            break;
          }
          setExtractedData(null);
          // Pipeline completed — update task status
          if (message.payload?.plan?.length > 0) {
            setTask({
              id: `pipeline-${Date.now()}`,
              description:
                message.payload.planResult?.reasoning || "Pipeline task",
              status: "completed",
              plan: {
                steps: message.payload.plan,
                estimatedTime: 0,
                riskLevel: "low",
                requiresConfirmation: false,
                dataMappings: [],
              },
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
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
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

  const startTask = useCallback(
    async (description: string, data?: Record<string, string>) => {
      setExtractedData(null);
      setPiiRegions(null);
      setSubTasks(null);
      setPiiReview(null);
      setNeeds(null);
      setAnswer(null);
      setFrame(null);
      setPayloads(null);
      setLastTask({ description, data });
      setProgress({ currentPhase: "capture", steps: [], elapsedMs: 0 });
      setTask({
        id: `pipeline-${Date.now()}`,
        description,
        status: "analyzing",
        plan: {
          steps: [],
          estimatedTime: 0,
          riskLevel: "low",
          requiresConfirmation: false,
          dataMappings: [],
        },
        currentStep: 0,
        totalSteps: 0,
        startTime: Date.now(),
      });

      // Use the full pipeline (PII detection + redaction + planning)
      const response = await chrome.runtime.sendMessage({
        type: "EXECUTE_PIPELINE",
        payload: { description, data },
        source: "sidepanel",
        timestamp: Date.now(),
      });

      setProgress(null);

      // Surface detected PII for the user regardless of task type.
      if (response?.piiDetection?.regions) {
        setPiiRegions(response.piiDetection.regions);
      }

      if (response?.extractedData) {
        setExtractedData(response.extractedData);
      }
      if (response?.subTasks?.length > 1) {
        setSubTasks(response.subTasks);
      }
      if (response?.piiReview?.length) {
        setPiiReview(response.piiReview);
      }
      if (response?.needs?.length) {
        setNeeds(response.needs);
      }
      if (response?.answer) {
        setAnswer(response.answer);
      }
      if (response?.sentPayloads) {
        setPayloads(response.sentPayloads);
      }
      if (response?.redactedFrame) {
        setFrame({
          url: response.redactedFrame,
          verified: response.frameVerified,
          sent: Boolean(response.answer?.frameSent),
        });
      }

      // An empty plan is a legitimate outcome — extraction tasks never
      // produce one. Only a genuine pipeline failure should fall back, or we
      // silently re-run the whole task through the legacy planner (and hit a
      // cloud provider a second time) every time extraction succeeds.
      const pipelineFailed =
        !response || response.error || response.phase === "error";

      if (!pipelineFailed) {
        const stepCount = response.plan?.length ?? 0;
        setTask({
          id: `pipeline-${Date.now()}`,
          description,
          status: "completed",
          plan: {
            steps: response.plan ?? [],
            estimatedTime: 0,
            riskLevel: "low",
            requiresConfirmation: false,
            dataMappings: [],
          },
          currentStep: stepCount,
          totalSteps: stepCount,
          startTime: Date.now(),
          endTime: Date.now(),
          result: response.answer
            ? response.answer.text
            : response.extractedData
              ? `Extracted ${response.extractedData.summary.fieldCount} fields (${response.extractedData.summary.maskedFieldCount} masked) — on-device, nothing sent`
              : `${response.piiDetection?.summary?.totalRegions || 0} PII detected, ${response.redactionSummary?.redacted || 0} redacted, ${stepCount} steps planned`,
        });
        return;
      }

      // Fallback to simple task execution
      const fallbackResponse = await chrome.runtime.sendMessage({
        type: "START_TASK",
        payload: { description, data },
        source: "sidepanel",
        timestamp: Date.now(),
      });
      setTask(fallbackResponse);
    },
    [],
  );

  const cancelTask = useCallback(async () => {
    await chrome.runtime.sendMessage({
      type: "CANCEL_TASK",
      source: "sidepanel",
      timestamp: Date.now(),
    });
    setTask(null);
  }, []);

  const toggleOverlay = useCallback(async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
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

  const hasRunDetails = Boolean(
    progress ||
    piiRegions?.length ||
    piiReview?.length ||
    extractedData ||
    payloads ||
    frame ||
    needs?.length ||
    subTasks?.length,
  );
  const protectedItemCount =
    (piiRegions?.length ?? 0) + (piiReview?.length ?? 0);

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-[#111110] text-stone-100 font-sans selection:bg-stone-300 selection:text-stone-950">
      <header className="relative flex items-center justify-between border-b border-stone-800/80 px-4 py-3">
        <button
          onClick={() => {
            setActiveTab("task");
            setShowUtilities(false);
          }}
          className="group flex items-center gap-2 text-left"
        >
          <span className="grid h-6 w-6 place-items-center rounded-lg bg-stone-100 text-[10px] font-bold tracking-[-0.08em] text-stone-950">
            V
          </span>
          <span>
            <span className="block text-[12px] font-semibold tracking-[-0.02em] text-stone-100">
              VLESS
            </span>
            <span className="block text-[9px] text-stone-500">
              private page agent
            </span>
          </span>
        </button>
        <div className="flex items-center gap-1.5">
          {historyPosition.total > 0 && (
            <span className="mr-1 text-[10px] text-stone-500">
              {historyPosition.current}/{historyPosition.total}
            </span>
          )}
          <button
            onClick={toggleOverlay}
            className={`rounded-full px-2.5 py-1 text-[10px] transition-colors ${
              overlayActive
                ? "bg-emerald-400 text-emerald-950"
                : "text-stone-400 hover:bg-stone-800 hover:text-stone-200"
            }`}
            title="Toggle visual overlay (Ctrl+Shift+V)"
          >
            {overlayActive ? "Overlay on" : "Overlay"}
          </button>
          <button
            onClick={() => setShowShortcuts(!showShortcuts)}
            className="rounded-full px-2.5 py-1 text-[10px] text-stone-400 transition-colors hover:bg-stone-800 hover:text-stone-200"
            title="Keyboard shortcuts (Ctrl+/)"
          >
            Shortcuts
          </button>
          <button
            onClick={() => setShowUtilities((open) => !open)}
            aria-expanded={showUtilities}
            className="rounded-full px-2.5 py-1 text-[10px] text-stone-400 transition-colors hover:bg-stone-800 hover:text-stone-200"
          >
            Menu
          </button>
        </div>

        {showUtilities && (
          <div className="absolute right-4 top-[calc(100%-2px)] z-30 w-40 rounded-xl border border-stone-700 bg-[#20201e] p-1.5 shadow-[0_16px_32px_rgba(0,0,0,0.36)] animate-slide-in">
            <button
              onClick={() => {
                setActiveTab("task");
                setShowUtilities(false);
              }}
              className="w-full rounded-lg px-2.5 py-2 text-left text-[11px] text-stone-300 hover:bg-stone-800"
            >
              Conversation
            </button>
            <button
              onClick={() => {
                setActiveTab("privacy");
                setShowUtilities(false);
              }}
              className="w-full rounded-lg px-2.5 py-2 text-left text-[11px] text-stone-300 hover:bg-stone-800"
            >
              Privacy monitor
            </button>
            <div className="my-1 border-t border-stone-700/80" />
            {UTILITY_TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => {
                  setActiveTab(tab.id);
                  setShowUtilities(false);
                }}
                className="w-full rounded-lg px-2.5 py-2 text-left text-[11px] text-stone-300 hover:bg-stone-800"
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}
      </header>

      {/* Keyboard Shortcuts Overlay */}
      {showShortcuts && (
        <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />
      )}

      {/* LLM Status Warning */}
      {!llmStatus.available && !showOnboarding && (
        <div className="border-b border-amber-800/40 bg-amber-950/30 px-4 py-2.5">
          <div className="flex items-start gap-2">
            <div className="flex-1">
              <p className="text-[11px] font-medium text-amber-200">
                Connect an AI provider to start a conversation
              </p>
              <p className="mt-0.5 text-[10px] text-amber-300/70">
                The agent needs an LLM to understand your requests. Configure
                one in the AI tab — it takes 30 seconds.
              </p>
              <button
                onClick={() => setActiveTab("ai")}
                className="mt-1.5 text-[10px] text-amber-200 underline decoration-amber-700 underline-offset-4 hover:text-amber-100"
              >
                Set up AI provider
              </button>
            </div>
          </div>
        </div>
      )}

      <main className="flex-1 overflow-y-auto">
        {activeTab === "task" && (
          <TaskInput
            onStartTask={startTask}
            onCancelTask={cancelTask}
            task={task}
            detailsLabel={
              protectedItemCount > 0
                ? `Show details · ${protectedItemCount} protected item${protectedItemCount === 1 ? "" : "s"}`
                : "Show run details"
            }
            details={
              hasRunDetails ? (
                <>
                  {progress && <PipelineProgressPanel progress={progress} />}
                  {!progress && subTasks && (
                    <div className="mx-4 mt-4 rounded-lg border border-gray-800 bg-gray-900 p-3">
                      <p className="mb-2 text-[10px] uppercase tracking-wider text-gray-500">
                        {subTasks.length} sub-tasks
                      </p>
                      <div className="space-y-1">
                        {subTasks.map((st, i) => (
                          <div
                            key={i}
                            className="flex items-center gap-2 text-[11px]"
                          >
                            <span className="flex-1 text-gray-300">
                              {st.description}
                            </span>
                            <span className="text-[9px] text-gray-600">
                              {st.kind}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {!progress && needs && needs.length > 0 && (
                    <NeedsInputPanel
                      needs={needs}
                      onRetry={
                        lastTask
                          ? () =>
                              void startTask(
                                lastTask.description,
                                lastTask.data,
                              )
                          : undefined
                      }
                    />
                  )}
                  {!progress && piiReview && piiReview.length > 0 && (
                    <PIIReviewPanel fields={piiReview} />
                  )}
                  {extractedData && <ExtractedDataPanel data={extractedData} />}
                  {!progress && piiRegions && piiRegions.length > 0 && (
                    <PIIResultsPanel regions={piiRegions} />
                  )}
                  {!progress && payloads && (
                    <OutboundPayloadPanel payloads={payloads} />
                  )}
                  {!progress && frame && (
                    <OutboundFramePanel
                      frame={frame.url}
                      verified={frame.verified}
                      wasSent={frame.sent}
                    />
                  )}
                </>
              ) : undefined
            }
          >
            {!progress && answer && <AnswerPanel answer={answer} />}
          </TaskInput>
        )}
        {activeTab === "ai" && <ProviderSettings />}
        {activeTab === "models" && <RuntimePanel />}
        {activeTab === "learn" && <LearningLog />}
        {activeTab === "privacy" && <PrivacyMonitor />}
        {activeTab === "voice" && <VoiceControl />}
        {activeTab === "debug" && (
          <ReasoningTrace steps={reasoningTrace} task={task} />
        )}
      </main>

      <footer className="flex items-center justify-between border-t border-stone-800/80 px-4 py-2 text-[10px] text-stone-500">
        <span>
          {task
            ? `${task.status} • Step ${task.currentStep}/${task.totalSteps}`
            : "Ready"}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
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
      <div className="mx-4 w-full max-w-xs rounded-xl border border-stone-700 bg-[#20201e] p-5">
        <h3 className="mb-3 text-sm font-semibold text-stone-100">
          Keyboard shortcuts
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
