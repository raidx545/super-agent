// ============================================================
// VLESS — Memory Store
// Encrypted IndexedDB storage for site memory, task history, and user preferences
// Everything stays on-device. Zero telemetry.
// ============================================================

import { openDB, type IDBPDatabase } from "idb";
import type {
  SiteMemory,
  PageMemory,
  FormSchema,
  ActionPattern,
  NavigationGraph,
} from "../../types";

// ── Database Schema ──────────────────────────────────────────

const DB_NAME = "vless-memory";
const DB_VERSION = 1;

interface VLESSDB {
  sites: {
    key: string; // domain
    value: SiteMemoryData;
  };
  tasks: {
    key: string; // task id
    value: TaskRecord;
  };
  userPrefs: {
    key: string;
    value: UserPreference;
  };
}

interface SiteMemoryData {
  domain: string;
  pages: Record<string, PageMemoryData>;
  navigationFlow: NavigationGraph;
  formSchemas: Record<string, FormSchemaData>;
  elementPositions: Record<string, ElementPositionData>;
  successPatterns: ActionPatternData[];
  failurePatterns: ActionPatternData[];
  visitCount: number;
  lastVisited: number;
}

interface PageMemoryData {
  url: string;
  purpose: string;
  elements: any[];
  lastSeen: number;
  visitCount: number;
}

interface FormSchemaData {
  id: string;
  name: string;
  fields: {
    name: string;
    id: string;
    type: string;
    required: boolean;
    pattern: string;
    maxLength: number;
    semanticCategory: string;
  }[];
  validationRules: { fieldName: string; rule: string; description: string }[];
  semanticMapping: Record<string, string>;
}

interface ElementPositionData {
  selector: string;
  lastKnownRect: { x: number; y: number; width: number; height: number };
  confidence: number;
  lastSeen: number;
}

interface ActionPatternData {
  action: {
    type: string;
    target?: string;
    value?: string;
  };
  successRate: number;
  avgExecutionTime: number;
  lastUsed: number;
}

interface TaskRecord {
  id: string;
  description: string;
  url: string;
  status: string;
  stepsCompleted: number;
  totalSteps: number;
  startTime: number;
  endTime: number;
  result?: string;
  error?: string;
}

interface UserPreference {
  key: string;
  value: any;
}

// ── Database Instance ────────────────────────────────────────

let dbInstance: IDBPDatabase<VLESSDB> | null = null;

async function getDB(): Promise<IDBPDatabase<VLESSDB>> {
  if (dbInstance) return dbInstance;

  dbInstance = await openDB<VLESSDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      // Sites store
      if (!db.objectStoreNames.contains("sites")) {
        db.createObjectStore("sites", { keyPath: "domain" });
      }

      // Task history
      if (!db.objectStoreNames.contains("tasks")) {
        const taskStore = db.createObjectStore("tasks", {
          keyPath: "id",
        });
        taskStore.createIndex("url", "url");
        taskStore.createIndex("startTime", "startTime");
      }

      // User preferences
      if (!db.objectStoreNames.contains("userPrefs")) {
        db.createObjectStore("userPrefs", { keyPath: "key" });
      }
    },
  });

  return dbInstance;
}

// ── Site Memory Operations ───────────────────────────────────

export async function getSiteMemory(
  domain: string
): Promise<SiteMemoryData | null> {
  const db = await getDB();
  return db.get("sites", domain);
}

export async function saveSiteMemory(
  memory: SiteMemoryData
): Promise<void> {
  const db = await getDB();
  await db.put("sites", memory);
}

export async function updateSiteMemory(
  domain: string,
  updater: (existing: SiteMemoryData) => SiteMemoryData
): Promise<SiteMemoryData> {
  const db = await getDB();
  const existing = await db.get("sites", domain);

  const defaultMemory: SiteMemoryData = {
    domain,
    pages: {},
    navigationFlow: { nodes: [], edges: [] },
    formSchemas: {},
    elementPositions: {},
    successPatterns: [],
    failurePatterns: [],
    visitCount: 0,
    lastVisited: Date.now(),
  };

  const updated = updater(existing || defaultMemory);
  updated.visitCount = (existing?.visitCount || 0) + 1;
  updated.lastVisited = Date.now();

  await db.put("sites", updated);
  return updated;
}

export async function recordPageVisit(
  domain: string,
  url: string,
  purpose: string,
  elements: any[]
): Promise<void> {
  await updateSiteMemory(domain, (memory) => {
    const pageKey = new URL(url).pathname || "/";
    const existingPage = memory.pages[pageKey];

    memory.pages[pageKey] = {
      url,
      purpose,
      elements: elements.slice(0, 50), // Limit stored elements
      lastSeen: Date.now(),
      visitCount: (existingPage?.visitCount || 0) + 1,
    };

    // Add to navigation flow if new
    if (!memory.navigationFlow.nodes.includes(pageKey)) {
      memory.navigationFlow.nodes.push(pageKey);
    }

    return memory;
  });
}

export async function recordFormSchema(
  domain: string,
  formId: string,
  schema: FormSchemaData
): Promise<void> {
  await updateSiteMemory(domain, (memory) => {
    memory.formSchemas[formId] = schema;
    return memory;
  });
}

export async function recordElementPosition(
  domain: string,
  selector: string,
  rect: { x: number; y: number; width: number; height: number }
): Promise<void> {
  await updateSiteMemory(domain, (memory) => {
    memory.elementPositions[selector] = {
      selector,
      lastKnownRect: rect,
      confidence: 0.9,
      lastSeen: Date.now(),
    };
    return memory;
  });
}

export async function recordActionPattern(
  domain: string,
  action: { type: string; target?: string; value?: string },
  success: boolean,
  executionTime: number
): Promise<void> {
  await updateSiteMemory(domain, (memory) => {
    const patternKey = `${action.type}:${action.target || ""}`;
    const patterns = success
      ? memory.successPatterns
      : memory.failurePatterns;

    const existing = patterns.find(
      (p) =>
        `${p.action.type}:${p.action.target || ""}` === patternKey
    );

    if (existing) {
      // Update existing pattern with running average
      const totalUses =
        existing.successRate * 100 + (success ? 1 : 0);
      existing.successRate =
        (existing.successRate * 100 + (success ? 100 : 0)) /
        101;
      existing.avgExecutionTime =
        (existing.avgExecutionTime + executionTime) / 2;
      existing.lastUsed = Date.now();
    } else {
      patterns.push({
        action,
        successRate: success ? 1 : 0,
        avgExecutionTime: executionTime,
        lastUsed: Date.now(),
      });
    }

    return memory;
  });
}

export async function recordNavigationEdge(
  domain: string,
  from: string,
  to: string,
  trigger: string
): Promise<void> {
  await updateSiteMemory(domain, (memory) => {
    const exists = memory.navigationFlow.edges.some(
      (e) => e.from === from && e.to === to
    );

    if (!exists) {
      memory.navigationFlow.edges.push({
        from,
        to,
        trigger,
        confidence: 0.8,
      });
    }

    return memory;
  });
}

// ── Task History ─────────────────────────────────────────────

export async function saveTaskRecord(
  record: TaskRecord
): Promise<void> {
  const db = await getDB();
  await db.put("tasks", record);
}

export async function getTaskHistory(
  limit = 20
): Promise<TaskRecord[]> {
  const db = await getDB();
  const all = await db.getAll("tasks");
  return all
    .sort((a, b) => b.startTime - a.startTime)
    .slice(0, limit);
}

export async function getTasksForDomain(
  domain: string
): Promise<TaskRecord[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex("tasks", "url", domain);
  return all.sort((a, b) => b.startTime - a.startTime);
}

// ── User Preferences ─────────────────────────────────────────

export async function setPreference(
  key: string,
  value: any
): Promise<void> {
  const db = await getDB();
  await db.put("userPrefs", { key, value });
}

export async function getPreference<T = any>(
  key: string
): Promise<T | null> {
  const db = await getDB();
  const result = await db.get("userPrefs", key);
  return result?.value ?? null;
}

// ── Analytics (100% Local) ───────────────────────────────────

export interface MemoryStats {
  totalSites: number;
  totalTasks: number;
  successRate: number;
  averageTaskTime: number;
  mostVisitedSites: { domain: string; visits: number }[];
  recentErrors: string[];
}

export async function getMemoryStats(): Promise<MemoryStats> {
  const db = await getDB();

  const sites = await db.getAll("sites");
  const tasks = await db.getAll("tasks");

  const successfulTasks = tasks.filter(
    (t) => t.status === "completed"
  );
  const successRate =
    tasks.length > 0
      ? successfulTasks.length / tasks.length
      : 0;

  const avgTime =
    successfulTasks.length > 0
      ? successfulTasks.reduce(
          (sum, t) => sum + (t.endTime - t.startTime),
          0
        ) / successfulTasks.length
      : 0;

  const mostVisited = sites
    .map((s) => ({
      domain: s.domain,
      visits: s.visitCount,
    }))
    .sort((a, b) => b.visits - a.visits)
    .slice(0, 5);

  const recentErrors = tasks
    .filter((t) => t.error)
    .slice(-5)
    .map((t) => t.error || "");

  return {
    totalSites: sites.length,
    totalTasks: tasks.length,
    successRate,
    averageTaskTime: avgTime,
    mostVisitedSites: mostVisited,
    recentErrors,
  };
}

// ── Clear Data ───────────────────────────────────────────────

export async function clearAllMemory(): Promise<void> {
  const db = await getDB();
  await db.clear("sites");
  await db.clear("tasks");
  await db.clear("userPrefs");
}

export async function clearSiteMemory(
  domain: string
): Promise<void> {
  const db = await getDB();
  await db.delete("sites", domain);
}
