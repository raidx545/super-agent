// ============================================================
// VLESS — Requirements
//
// What the agent still needs FROM THE USER to finish the task.
//
// An agent that silently leaves a required government-form field
// blank has not completed the task, it has abandoned it quietly. The
// honest output of a run is two things: what was done, and what is
// still missing. This module computes the second.
//
// It deliberately does NOT invent values. A required State dropdown
// with no local data is reported as a question, not guessed at.
// ============================================================

import type { PageState } from "../../types";
import type { PIIDetectionResult } from "../privacy/pii-detector";

export interface RequiredInput {
  /** Label as the form shows it. */
  label: string;
  /** Selector the client uses to write the answer back. */
  selector: string;
  /** input type — drives which control the panel renders. */
  type: string;
  /** PII category when the field was flagged, so the UI can mark it. */
  category: string | null;
  /** For a <select>: the options the user must choose between. */
  options?: string[];
  reason: "no_local_value" | "still_empty_after_run";
  /** Short, plain explanation shown to the user. */
  hint: string;
}

const CONTROL_TYPES = new Set([
  "submit", "button", "reset", "image", "hidden", "checkbox", "radio",
]);

/** Normalize for tolerant key matching between form labels and user data. */
function norm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hasLocalValue(
  dataContext: Record<string, string> | undefined,
  field: { name?: string; id?: string; label?: string }
): boolean {
  if (!dataContext) return false;
  const candidates = [field.name, field.id, field.label].filter(Boolean) as string[];
  const keys = Object.keys(dataContext);
  for (const c of candidates) {
    if (dataContext[c]) return true;
    const wanted = norm(c);
    if (wanted && keys.some((k) => norm(k) === wanted && dataContext[k])) return true;
  }
  return false;
}

/**
 * Required fields the run could not complete.
 *
 * `domData` should be read AFTER execution, so this reflects the real state
 * of the page rather than what the plan intended.
 */
export function computeRequirements(
  domData: PageState,
  piiDetection: PIIDetectionResult | null,
  dataContext?: Record<string, string>
): RequiredInput[] {
  const categoryBySelector = new Map<string, string>();
  for (const region of piiDetection?.regions ?? []) {
    if (region.fieldSelector) categoryBySelector.set(region.fieldSelector, region.category);
  }

  const out: RequiredInput[] = [];

  for (const form of domData.forms) {
    for (const field of form.fields) {
      const type = (field.type || "").toLowerCase();
      if (CONTROL_TYPES.has(type)) continue;
      if (!field.required) continue;

      // A select still sitting on its placeholder counts as empty — this is
      // exactly the case the browser rejects with "Please select an item".
      const isUnsetSelect =
        type === "select" && (!field.value || isPlaceholderOption(field.value));
      const isEmpty = !field.value || isUnsetSelect;
      if (!isEmpty) continue;

      const selector = field.id
        ? `#${field.id}`
        : field.name
          ? `[name="${field.name}"]`
          : "";
      if (!selector) continue;

      const known = hasLocalValue(dataContext, field);

      out.push({
        label: field.label || field.name || field.id || "(unlabeled)",
        selector,
        type: field.type || "text",
        category: categoryBySelector.get(selector) ?? null,
        options: field.options && field.options.length > 0
          ? field.options.filter((o) => !isPlaceholderOption(o))
          : undefined,
        reason: known ? "still_empty_after_run" : "no_local_value",
        hint: known
          ? "You have a value saved for this, but it did not get applied. Check and re-apply."
          : type === "select"
            ? "Choose an option — the agent will not guess on your behalf."
            : "No saved value for this field.",
      });
    }
  }

  return out;
}

/** "-- Select State --", "Choose…", "" and friends are not real choices. */
export function isPlaceholderOption(option: string): boolean {
  const t = option.trim().toLowerCase();
  if (!t) return true;
  return /^(--.*--|-+|select\b.*|choose\b.*|please\s+select.*|none)$/.test(t);
}

/**
 * One line summarising the run for the user, covering both halves:
 * what happened, and what is still outstanding.
 */
export function summarizeOutcome(
  completed: number,
  total: number,
  needs: RequiredInput[]
): string {
  const done = total > 0 ? `${completed}/${total} steps done` : "nothing to do";
  if (needs.length === 0) return `${done} — nothing outstanding.`;
  const missing = needs.filter((n) => n.reason === "no_local_value").length;
  if (missing > 0) {
    return `${done} — ${needs.length} required field${needs.length === 1 ? "" : "s"} still need${needs.length === 1 ? "s" : ""} a value from you.`;
  }
  return `${done} — ${needs.length} required field${needs.length === 1 ? "" : "s"} still empty.`;
}
