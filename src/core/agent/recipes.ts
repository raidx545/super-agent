// ============================================================
// VLESS — Automation Recipes
// Export, import, and share browser automation scripts
// Like a clipboard for agent actions
// ============================================================

import type { AgentAction } from "../../types";

// ── Recipe Schema ────────────────────────────────────────────

export interface Recipe {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  createdAt: number;
  updatedAt: number;
  tags: string[];
  targetDomains: string[];
  steps: RecipeStep[];
  variables: RecipeVariable[];
  metadata: {
    totalSteps: number;
    estimatedTime: number;
    difficulty: "easy" | "medium" | "hard";
  };
}

export interface RecipeStep {
  id: string;
  action: AgentAction;
  description: string;
  selector?: string; // CSS selector for the target element
  waitFor?: string; // Wait for this selector before acting
  timeout?: number;
  optional: boolean;
  retryOnFail: boolean;
}

export interface RecipeVariable {
  name: string;
  description: string;
  type: "text" | "email" | "phone" | "number" | "date" | "file";
  required: boolean;
  defaultValue?: string;
  placeholder?: string;
}

// ── Built-in Recipes ─────────────────────────────────────────

export const BUILTIN_RECIPES: Recipe[] = [
  {
    id: "builtin-passport",
    name: "Passport Application",
    description: "Fill passport application form with personal data",
    version: "1.0.0",
    author: "VLESS",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tags: ["government", "passport", "form-fill"],
    targetDomains: ["passport.seva.gov.in", "passportindia.gov.in"],
    steps: [
      {
        id: "step-1",
        action: { id: "a-1", type: "scroll", value: "down", retries: 0, maxRetries: 1 },
        description: "Scroll to find the form",
        waitFor: "form",
        optional: false,
        retryOnFail: true,
      },
      {
        id: "step-2",
        action: { id: "a-2", type: "click", target: "Given Name", retries: 0, maxRetries: 3 },
        description: "Click the Given Name field",
        optional: false,
        retryOnFail: true,
      },
      {
        id: "step-3",
        action: { id: "a-3", type: "type", target: "Given Name", value: "{{firstName}}", retries: 0, maxRetries: 3 },
        description: "Type first name",
        optional: false,
        retryOnFail: true,
      },
    ],
    variables: [
      { name: "firstName", description: "First name", type: "text", required: true, placeholder: "Shashank" },
      { name: "lastName", description: "Last name", type: "text", required: true, placeholder: "Tomar" },
      { name: "email", description: "Email address", type: "email", required: true, placeholder: "email@example.com" },
      { name: "phone", description: "Phone number", type: "phone", required: true, placeholder: "9876543210" },
    ],
    metadata: {
      totalSteps: 3,
      estimatedTime: 30000,
      difficulty: "easy",
    },
  },
  {
    id: "builtin-extract-data",
    name: "Extract Page Data",
    description: "Extract all visible data from a page into structured format",
    version: "1.0.0",
    author: "VLESS",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tags: ["scraping", "data-extraction"],
    targetDomains: ["*"],
    steps: [
      {
        id: "step-1",
        action: { id: "a-1", type: "wait", timeout: 2000, retries: 0, maxRetries: 0 },
        description: "Wait for page to fully load",
        optional: false,
        retryOnFail: false,
      },
    ],
    variables: [],
    metadata: {
      totalSteps: 1,
      estimatedTime: 5000,
      difficulty: "easy",
    },
  },
];

// ── Recipe Management ────────────────────────────────────────

const STORAGE_KEY = "vless-recipes";

export async function getRecipes(): Promise<Recipe[]> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const custom = stored[STORAGE_KEY] || [];
  return [...BUILTIN_RECIPES, ...custom];
}

export async function saveRecipe(recipe: Recipe): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const recipes = stored[STORAGE_KEY] || [];
  const existing = recipes.findIndex((r: Recipe) => r.id === recipe.id);

  if (existing >= 0) {
    recipes[existing] = { ...recipe, updatedAt: Date.now() };
  } else {
    recipes.push({ ...recipe, createdAt: Date.now(), updatedAt: Date.now() });
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: recipes });
}

export async function deleteRecipe(recipeId: string): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const recipes = (stored[STORAGE_KEY] || []).filter(
    (r: Recipe) => r.id !== recipeId
  );
  await chrome.storage.local.set({ [STORAGE_KEY]: recipes });
}

// ── Export/Import ────────────────────────────────────────────

export function exportRecipe(recipe: Recipe): string {
  return JSON.stringify(recipe, null, 2);
}

export function importRecipe(jsonString: string): {
  success: boolean;
  recipe?: Recipe;
  error?: string;
} {
  try {
    const parsed = JSON.parse(jsonString);

    // Validate required fields
    if (!parsed.name || !parsed.steps || !Array.isArray(parsed.steps)) {
      return { success: false, error: "Invalid recipe format: missing name or steps" };
    }

    const recipe: Recipe = {
      id: `imported-${Date.now()}`,
      name: parsed.name,
      description: parsed.description || "",
      version: parsed.version || "1.0.0",
      author: parsed.author || "Imported",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tags: parsed.tags || [],
      targetDomains: parsed.targetDomains || ["*"],
      steps: parsed.steps.map((step: any, i: number) => ({
        id: step.id || `step-${i}`,
        action: step.action,
        description: step.description || `Step ${i + 1}`,
        selector: step.selector,
        waitFor: step.waitFor,
        timeout: step.timeout,
        optional: step.optional || false,
        retryOnFail: step.retryOnFail !== false,
      })),
      variables: parsed.variables || [],
      metadata: {
        totalSteps: parsed.steps.length,
        estimatedTime: parsed.steps.length * 3000,
        difficulty: parsed.metadata?.difficulty || "medium",
      },
    };

    return { success: true, recipe };
  } catch (error) {
    return {
      success: false,
      error: `Failed to parse recipe: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

// ── Recipe Recording ─────────────────────────────────────────

let recordingSteps: RecipeStep[] = [];
let isRecording = false;

export function startRecording(): void {
  recordingSteps = [];
  isRecording = true;
}

export function recordStep(action: AgentAction, description: string): void {
  if (!isRecording) return;

  recordingSteps.push({
    id: `rec-${Date.now()}`,
    action,
    description,
    optional: false,
    retryOnFail: true,
  });
}

export function stopRecording(): Recipe | null {
  if (!isRecording) return null;
  isRecording = false;

  if (recordingSteps.length === 0) return null;

  return {
    id: `recipe-${Date.now()}`,
    name: `Recorded Recipe ${new Date().toLocaleTimeString()}`,
    description: `Recorded ${recordingSteps.length} steps`,
    version: "1.0.0",
    author: "User",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tags: ["recorded"],
    targetDomains: ["*"],
    steps: [...recordingSteps],
    variables: [],
    metadata: {
      totalSteps: recordingSteps.length,
      estimatedTime: recordingSteps.length * 3000,
      difficulty: "medium",
    },
  };
}

export function isRecordingActive(): boolean {
  return isRecording;
}
