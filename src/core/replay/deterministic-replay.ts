// ============================================================
// VLESS — Deterministic Replay Engine
// Record actions once, replay faster without ML inference.
// ============================================================

import type { AgentAction } from "../../types";

export interface RecordedAction {
  id: string;
  action: AgentAction;
  pageUrl: string;
  pageTitle: string;
  timestamp: number;
  executionTimeMs: number;
  verificationPassed: boolean;
  retryCount: number;
  primarySelector: string;
  fallbackSelectors: string[];
  pageContextHash: string;
}

export interface ReplaySession {
  id: string;
  name: string;
  domain: string;
  recordedAt: number;
  actions: RecordedAction[];
  metadata: {
    totalActions: number;
    originalDurationMs: number;
    successRate: number;
  };
}

export interface ReplayResult {
  sessionId: string;
  success: boolean;
  actionsCompleted: number;
  actionsTotal: number;
  finalDurationMs: number;
  originalDurationMs: number;
  speedupFactor: number;
  errors: string[];
  adaptations: string[];
}

class ReplayRecorder {
  private recording = false;
  private actions: RecordedAction[] = [];
  private startTime = 0;

  start(): void {
    this.recording = true;
    this.actions = [];
    this.startTime = Date.now();
  }

  record(
    action: AgentAction,
    pageUrl: string,
    pageTitle: string,
    execTimeMs: number,
    verified: boolean,
    retries: number
  ): RecordedAction | null {
    if (!this.recording) return null;

    const rec: RecordedAction = {
      id: `ra-${Date.now()}`,
      action: { ...action },
      pageUrl,
      pageTitle,
      timestamp: Date.now(),
      executionTimeMs: execTimeMs,
      verificationPassed: verified,
      retryCount: retries,
      primarySelector: buildSelector(action),
      fallbackSelectors: buildFallbacks(action),
      pageContextHash: hashStr(`${pageUrl}|${pageTitle}`),
    };

    this.actions.push(rec);
    return rec;
  }

  stop(name?: string): ReplaySession | null {
    if (!this.recording || this.actions.length === 0) {
      this.recording = false;
      return null;
    }

    const session: ReplaySession = {
      id: `rs-${Date.now()}`,
      name: name || `Recording ${new Date().toLocaleTimeString()}`,
      domain: extractDomain(this.actions[0].pageUrl),
      recordedAt: Date.now(),
      actions: [...this.actions],
      metadata: {
        totalActions: this.actions.length,
        originalDurationMs: Date.now() - this.startTime,
        successRate: this.actions.filter((a) => a.verificationPassed).length / this.actions.length,
      },
    };

    this.recording = false;
    this.actions = [];
    return session;
  }

  isActive(): boolean {
    return this.recording;
  }
}

class ReplayExecutor {
  async replay(
    session: ReplaySession,
    exec: (action: AgentAction) => Promise<{ success: boolean; error?: string }>,
    find: (target: string) => Element | null,
    onProgress?: (step: number, total: number) => void
  ): Promise<ReplayResult> {
    const t0 = Date.now();
    const result: ReplayResult = {
      sessionId: session.id,
      success: true,
      actionsCompleted: 0,
      actionsTotal: session.actions.length,
      finalDurationMs: 0,
      originalDurationMs: session.metadata.originalDurationMs,
      speedupFactor: 1,
      errors: [],
      adaptations: [],
    };

    for (let i = 0; i < session.actions.length; i++) {
      const rec = session.actions[i];
      onProgress?.(i, session.actions.length);

      let ok = false;

      // Try primary selector
      if (find(rec.primarySelector)) {
        const r = await exec({ ...rec.action, target: rec.primarySelector });
        ok = r.success;
      }

      // Try fallbacks
      if (!ok) {
        for (const fb of rec.fallbackSelectors) {
          if (find(fb)) {
            const r = await exec({ ...rec.action, target: fb });
            if (r.success) {
              ok = true;
              result.adaptations.push(`Fallback "${fb}" for step ${i}`);
              break;
            }
          }
        }
      }

      // Try by text
      if (!ok && rec.action.target) {
        const r = await exec({ ...rec.action, target: rec.action.target });
        if (r.success) {
          ok = true;
          result.adaptations.push(`Text match for step ${i}`);
        }
      }

      if (ok) {
        result.actionsCompleted++;
      } else {
        result.errors.push(`Step ${i} failed: ${rec.primarySelector}`);
        result.success = false;
        break;
      }

      await sleep(50);
    }

    result.finalDurationMs = Date.now() - t0;
    result.speedupFactor = result.originalDurationMs > 0
      ? result.originalDurationMs / result.finalDurationMs
      : 1;

    return result;
  }
}

function buildSelector(action: AgentAction): string {
  const t = action.target || "";
  if (t.includes(".") || t.includes("[") || t.includes("#")) return t;
  if (/^[a-zA-Z][\w-]*$/.test(t)) return `#${t}`;
  return `[name="${t}"]`;
}

function buildFallbacks(action: AgentAction): string[] {
  const t = action.target || "";
  const fb: string[] = [];
  if (t) fb.push(`[aria-label="${t}"]`, `[placeholder="${t}"]`);
  return fb;
}

function hashStr(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h.toString(36);
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const SESSIONS_KEY = "vless_replay_sessions";

export function saveSession(session: ReplaySession): void {
  try {
    const all = loadAllSessions();
    all.push(session);
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(all.slice(-50)));
  } catch { /* ignore */ }
}

export function loadAllSessions(): ReplaySession[] {
  try {
    return JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]");
  } catch { return []; }
}

export function loadSessionsForDomain(domain: string): ReplaySession[] {
  return loadAllSessions().filter((s) => s.domain === domain);
}

export function deleteSession(id: string): void {
  const s = loadAllSessions().filter((s) => s.id !== id);
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(s));
}

let recInst: ReplayRecorder | null = null;
let execInst: ReplayExecutor | null = null;

export function getReplayRecorder(): ReplayRecorder {
  if (!recInst) recInst = new ReplayRecorder();
  return recInst;
}

export function getReplayExecutor(): ReplayExecutor {
  if (!execInst) execInst = new ReplayExecutor();
  return execInst;
}
