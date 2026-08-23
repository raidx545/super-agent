// ============================================================
// VLESS — Page Data Extractor
//
// "Extract data" is a read task, not an action task. It must never go
// through the action planner: the planner only knows click/type/scroll,
// so an LLM handed an extraction request invents dozens of clicks and
// fails most of them. Extraction runs entirely locally from the already
// captured PageState and returns structured data to the user.
//
// PRIVACY BOUNDARY
// This is the one place values are read rather than stripped, because
// the destination is the user's own side panel on their own machine.
// The rules that keep that safe:
//   1. Extraction output NEVER enters a prompt. It is not part of
//      SanitizedContext and is not passed to any provider.
//   2. Values matching a detected PII region are masked by default.
//      The real value is carried alongside so the user can reveal it
//      locally, and nothing else can.
// ============================================================

import type { PageState } from "../../types";
import type { PIIDetectionResult } from "../privacy/pii-detector";
import { scanTextForPII } from "../privacy/pii-detector";

// ── Types ────────────────────────────────────────────────────

export interface ExtractedField {
  label: string;
  value: string;
  /** Present only when the value is withheld; the user can reveal it locally. */
  rawValue?: string;
  type: string;
  /** Set when this field was flagged by PII detection or the text scanner. */
  piiCategory: string | null;
  /** True when `value` is masked and `rawValue` holds the original. */
  masked: boolean;
}

export interface ExtractedSection {
  title: string;
  fields: ExtractedField[];
}

export interface ExtractedData {
  url: string;
  title: string;
  extractedAt: number;
  sections: ExtractedSection[];
  links: Array<{ text: string; href: string }>;
  headings: string[];
  summary: {
    sectionCount: number;
    fieldCount: number;
    filledFieldCount: number;
    maskedFieldCount: number;
    linkCount: number;
  };
}

// ── Intent detection ─────────────────────────────────────────

const EXTRACTION_PHRASES = [
  "extract",
  "scrape",
  "read this page",
  "read the page",
  "get the data",
  "get all data",
  "list all",
  "summarize this page",
  "what's on this page",
  "what is on this page",
  "show me the data",
  "pull the data",
  "copy the data",
];

/**
 * True when the task is a read/extract request rather than an action.
 * Checked before planning so extraction never reaches the action planner.
 */
export function isExtractionTask(taskDescription: string): boolean {
  const lower = taskDescription.toLowerCase().trim();
  if (!lower) return false;

  // "fill" and "submit" win outright — "extract the data then fill the form"
  // is an action task with an extraction preamble, and the action matters.
  if (/\b(fill|submit|click|type into|complete the form)\b/.test(lower)) {
    return false;
  }

  return EXTRACTION_PHRASES.some((phrase) => lower.includes(phrase));
}

// ── Extraction ───────────────────────────────────────────────

/**
 * Build structured data from the captured page state.
 *
 * `piiDetection` is used to decide what to mask. When a field's value is
 * flagged — either by the region detectors or by a direct checksum scan
 * of the value itself — it is masked in `value` and preserved in
 * `rawValue` for local reveal.
 */
export function extractPageData(
  domData: PageState,
  piiDetection: PIIDetectionResult | null
): ExtractedData {
  const piiSelectors = new Set(
    (piiDetection?.regions ?? [])
      .filter((r) => r.fieldSelector)
      .map((r) => r.fieldSelector!)
  );
  const piiCategoryBySelector = new Map<string, string>();
  for (const region of piiDetection?.regions ?? []) {
    if (region.fieldSelector) {
      piiCategoryBySelector.set(region.fieldSelector, region.category);
    }
  }

  const sections: ExtractedSection[] = [];

  // ── Form fields, grouped per form ──
  domData.forms.forEach((form, formIndex) => {
    const fields: ExtractedField[] = [];

    // Radio/checkbox groups: every member reports the SAME `.value` (its
    // option token, e.g. "uid"/"eid"/"vid"), selected or not. Listing each
    // member separately shows four rows of meaningless tokens, and masking
    // one because its label matched a PII rule produces "***" for a value
    // that was never PII. Collapse a group into its selected option.
    const radioGroups = new Map<string, typeof form.fields>();
    const scalarFields: typeof form.fields = [];

    for (const field of form.fields) {
      const type = (field.type || "").toLowerCase();
      if (type === "radio") {
        const key = field.name || field.id || field.label;
        const group = radioGroups.get(key) ?? [];
        group.push(field);
        radioGroups.set(key, group);
      } else {
        scalarFields.push(field);
      }
    }

    for (const [groupName, members] of radioGroups) {
      const selected = members.find((m) => m.checked);
      fields.push({
        label: groupName || members[0]?.label || "(radio group)",
        // The option's human label, not its internal token.
        value: selected ? selected.label || selected.value : "(none selected)",
        type: "radio",
        piiCategory: null,
        masked: false,
      });
    }

    for (const field of scalarFields) {
      const label = field.label || field.name || field.id || "(unlabeled)";
      const selector = field.id
        ? `#${field.id}`
        : field.name
          ? `[name="${field.name}"]`
          : null;

      // Never surface a password value, revealable or not.
      if (field.type === "password") {
        fields.push({
          label,
          value: field.value ? "(password withheld)" : "",
          type: field.type,
          piiCategory: "password",
          masked: true,
        });
        continue;
      }

      const type = (field.type || "").toLowerCase();
      if (type === "checkbox") {
        fields.push({
          label,
          value: field.checked ? "checked" : "unchecked",
          type,
          piiCategory: null,
          masked: false,
        });
        continue;
      }

      const declaredCategory = selector ? piiCategoryBySelector.get(selector) ?? null : null;
      // A value can be PII even when its field was not flagged — scan it too.
      const scanned = field.value ? scanTextForPII(field.value) : [];
      const valueIsPII = scanned.length > 0;
      const category = declaredCategory ?? scanned[0]?.category ?? null;

      // Mask when the VALUE is sensitive, or when a flagged field holds
      // something long enough to be real user input. A flagged field whose
      // value is a short control token is not a secret.
      const fieldFlagged =
        declaredCategory !== null || Boolean(selector && piiSelectors.has(selector));
      const shouldMask = Boolean(
        field.value && (valueIsPII || (fieldFlagged && field.value.length > 4))
      );

      fields.push({
        label,
        value: shouldMask ? maskValue(field.value) : field.value,
        rawValue: shouldMask ? field.value : undefined,
        type: field.type,
        piiCategory: shouldMask ? category : valueIsPII ? category : null,
        masked: shouldMask,
      });
    }

    if (fields.length > 0) {
      sections.push({
        title: form.id ? `Form: ${form.id}` : `Form ${formIndex + 1}`,
        fields,
      });
    }
  });

  // ── Non-form readable content: selects, checkboxes, and labeled text ──
  const standalone: ExtractedField[] = [];
  const seenLabels = new Set(
    sections.flatMap((s) => s.fields.map((f) => f.label.toLowerCase()))
  );

  for (const el of domData.elements) {
    const label = (el.label || el.ariaLabel || el.text || "").trim();
    if (!label) continue;
    if (seenLabels.has(label.toLowerCase())) continue;
    if (el.tag === "a" || el.tag === "button") continue;

    const scanned = scanTextForPII(label);
    const category = scanned[0]?.category ?? null;
    standalone.push({
      label: el.role || el.tag,
      value: category ? maskValue(label) : label,
      rawValue: category ? label : undefined,
      type: el.type || el.tag,
      piiCategory: category,
      masked: category !== null,
    });
    seenLabels.add(label.toLowerCase());
  }

  if (standalone.length > 0) {
    sections.push({ title: "Page content", fields: standalone.slice(0, 100) });
  }

  // ── Links ──
  const links = domData.elements
    .filter((el) => el.tag === "a" && el.text)
    .map((el) => ({ text: el.text.trim().slice(0, 120), href: "" }))
    .filter((l) => l.text.length > 0)
    .slice(0, 100);

  // ── Headings, from the captured text content ──
  const headings = extractHeadings(domData.textContent);

  const allFields = sections.flatMap((s) => s.fields);

  return {
    url: domData.url,
    title: domData.title,
    extractedAt: Date.now(),
    sections,
    links,
    headings,
    summary: {
      sectionCount: sections.length,
      fieldCount: allFields.length,
      filledFieldCount: allFields.filter((f) => f.value !== "").length,
      maskedFieldCount: allFields.filter((f) => f.masked).length,
      linkCount: links.length,
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────

function maskValue(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "*".repeat(value.length);
  return `${value.slice(0, 2)}${"*".repeat(Math.min(value.length - 4, 12))}${value.slice(-2)}`;
}

function extractHeadings(textContent: string): string[] {
  if (!textContent) return [];
  // The DOM extractor flattens text; treat short standalone lines as headings.
  return textContent
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 2 && line.length < 80)
    .slice(0, 30);
}

/**
 * Render extracted data as JSON for copy/download.
 * Masked values stay masked — `rawValue` is dropped unless the user
 * explicitly asked to include real values.
 */
export function extractedDataToJSON(
  data: ExtractedData,
  options: { includeRawValues?: boolean } = {}
): string {
  const sections = data.sections.map((section) => ({
    title: section.title,
    fields: section.fields.map((f) => ({
      label: f.label,
      type: f.type,
      value: options.includeRawValues && f.rawValue !== undefined ? f.rawValue : f.value,
      piiCategory: f.piiCategory,
      masked: options.includeRawValues ? false : f.masked,
    })),
  }));

  return JSON.stringify(
    {
      url: data.url,
      title: data.title,
      extractedAt: new Date(data.extractedAt).toISOString(),
      summary: data.summary,
      sections,
      headings: data.headings,
    },
    null,
    2
  );
}
