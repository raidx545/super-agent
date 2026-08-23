// ============================================================
// VLESS — Question answering
//
// "Check whether I uploaded a photo or not" is a QUESTION. It is not a
// fill request, and routing it through the action planner produced the
// worst possible response: the agent started typing into unrelated
// fields to answer a yes/no question.
//
// Questions get an ANSWER. Most of them can be answered from the page
// state already captured — no model, no network, no egress. Only a
// question that genuinely needs to look at pixels goes further, and
// then only ever with the REDACTED frame.
// ============================================================

import type { PageState } from "../../types";
import type { PIIDetectionResult } from "../privacy/pii-detector";

export interface Answer {
  /** Plain-language answer for the user. */
  text: string;
  /** How it was determined. */
  source: "on-device" | "vision" | "unanswered";
  confidence: number;
  /** Optional supporting detail, e.g. the filename found. */
  detail?: string;
  /** True when the question needs pixels and could not be answered locally. */
  needsVision?: boolean;
  /**
   * The EXACT image bytes that were transmitted, when the vision path ran.
   *
   * Kept so the user can look at what left the device rather than take our
   * word for it. This is always the redacted frame — the raw capture is
   * never stored here, and never sent.
   */
  frameSent?: string;
}

// ── Intent ───────────────────────────────────────────────────

/**
 * Interrogative words. A sentence STARTING with one of these is a question
 * whatever verbs follow — "what do I have to fill here" contains "fill" but
 * is plainly not an instruction to fill anything.
 */
const WH_OPENERS = /^(what|which|where|when|why|who|whom|whose|how)\b/i;

/**
 * Auxiliaries that open a question only when followed by a subject.
 * "do i have a photo" is a question; "do this now" is an order.
 */
const AUX_OPENERS =
  /^(is|are|do|does|did|has|have|was|were|can|could|will|would|should|am)\s+(i|you|we|they|he|she|there|my|any)\b/i;

const QUESTION_PHRASES = [
  "check whether",
  "check if",
  "tell me if",
  "tell me whether",
  "let me know if",
  "verify that",
  "verify whether",
  "confirm that",
  "confirm whether",
  "is there",
  "do i have",
  "did i",
  "have i",
  "am i",
  "what do i",
  "what should i",
  "what needs",
  "what is required",
];

/**
 * True when the user is ASKING rather than instructing.
 *
 * Order matters and is the whole subtlety. An earlier version tested for
 * imperative verbs FIRST, so "what i have to fill here" was read as a fill
 * instruction and sent to the action planner, which started clicking around
 * a bank login page. Interrogative form wins; the imperative check is only
 * a tie-breaker for sentences with no question signal at all.
 */
export function isQuestionTask(taskDescription: string): boolean {
  const t = taskDescription.trim().toLowerCase();
  if (!t) return false;

  // 1. Unambiguous signals, in decreasing strength.
  if (t.endsWith("?")) return true;
  if (WH_OPENERS.test(t)) return true;
  if (AUX_OPENERS.test(t)) return true;
  if (QUESTION_PHRASES.some((p) => t.includes(p))) return true;

  // 2. No question signal: an action verb makes it an instruction.
  return false;
}

// ── Local answering ──────────────────────────────────────────

// Inflections matter: a bare \bupload\b misses "uploaded"/"uploading", and
// \bdocument\b misses "documents" — both are how people actually ask.
const FILE_WORDS =
  /\b(photos?|photographs?|images?|pictures?|files?|documents?|scans?|uploads?|uploaded|uploading|attachments?|attached)\b/i;

/** Strip the browser's fake path so the user sees just the filename. */
function fileNameOf(value: string): string {
  return value.split(/[\\/]/).pop() || value;
}

/**
 * Answer from the captured page state where possible.
 *
 * Everything here is structural: which fields exist, which hold values,
 * which are required and empty. That covers the majority of questions
 * people actually ask about a form, at zero privacy cost.
 */
export function answerFromPageState(
  question: string,
  domData: PageState,
  piiDetection: PIIDetectionResult | null
): Answer {
  const q = question.toLowerCase();
  const fields = domData.forms.flatMap((f) => f.fields);

  // ── Upload questions: "did I upload my photo?" ──
  if (FILE_WORDS.test(q)) {
    const fileFields = fields.filter((f) => (f.type || "").toLowerCase() === "file");

    if (fileFields.length > 0) {
      const filled = fileFields.filter((f) => f.value && f.value.trim() !== "");

      if (filled.length === fileFields.length && filled.length > 0) {
        const names = filled.map((f) => fileNameOf(f.value)).join(", ");
        return {
          text:
            filled.length === 1
              ? `Yes — a file is attached to "${filled[0].label || filled[0].name || "the upload field"}".`
              : `Yes — all ${filled.length} upload fields have a file attached.`,
          source: "on-device",
          confidence: 0.97,
          detail: names,
        };
      }

      if (filled.length === 0) {
        const labels = fileFields
          .map((f) => f.label || f.name || "upload field")
          .join(", ");
        return {
          text: `No — nothing is attached yet. ${fileFields.length === 1 ? "This field is" : "These fields are"} still empty: ${labels}.`,
          source: "on-device",
          confidence: 0.95,
        };
      }

      const missing = fileFields
        .filter((f) => !f.value)
        .map((f) => f.label || f.name || "upload field")
        .join(", ");
      return {
        text: `Partly — ${filled.length} of ${fileFields.length} uploads are done. Still missing: ${missing}.`,
        source: "on-device",
        confidence: 0.95,
        detail: filled.map((f) => fileNameOf(f.value)).join(", "),
      };
    }

    // No file input at all. The image may still be rendered on the page,
    // which only pixels can settle.
    return {
      text: "There is no file-upload field on this page.",
      source: "on-device",
      confidence: 0.8,
      needsVision: true,
    };
  }

  // ── "What do I have to fill here?" ──
  // The most common question on any form, and the one a login page reduces
  // to a one-line answer. Listing the fields IS the answer; planning clicks
  // is not.
  if (/\b(fill|enter|type|provide|input|complete)\b/.test(q) &&
      /^(what|which|how)\b|\bwhat (do|should|needs?|is)\b/.test(q)) {
    const inputs = fields.filter(
      (f) => !["submit", "button", "reset", "image", "hidden"].includes((f.type || "").toLowerCase())
    );
    const empty = inputs.filter((f) => !f.value);
    const required = empty.filter((f) => f.required);
    const target = required.length > 0 ? required : empty;

    if (inputs.length === 0) {
      return {
        text: "There are no input fields on this page.",
        source: "on-device",
        confidence: 0.9,
      };
    }
    if (target.length === 0) {
      return {
        text: "Nothing — every field on this page already has a value.",
        source: "on-device",
        confidence: 0.9,
      };
    }

    const names = target
      .map((f) => (f.label || f.name || "unlabelled field").replace(/\s*\*$/, "").trim())
      .filter(Boolean);
    const qualifier = required.length > 0 ? "required" : "empty";

    return {
      text:
        names.length === 1
          ? `One ${qualifier} field: "${names[0]}".`
          : `${names.length} ${qualifier} fields to fill: ${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""}.`,
      source: "on-device",
      confidence: 0.95,
      detail: target
        .map((f) => `${(f.label || f.name || "?").replace(/\s*\*$/, "").trim()} (${f.type || "text"})`)
        .slice(0, 8)
        .join(" · "),
    };
  }

  // ── Named field: "is my PAN filled in?" ──
  const named = fields.find(
    (f) => f.label && q.includes(f.label.toLowerCase().replace(/\s*\*$/, "").trim()) && f.label.length > 2
  );
  if (named) {
    return {
      text: named.value
        ? `Yes — "${named.label}" has a value.`
        : `No — "${named.label}" is empty.`,
      source: "on-device",
      confidence: 0.9,
    };
  }

  // ── Completeness: "is the form complete?", "what's missing?" ──
  if (/\b(complete|finished|done|missing|empty|filled|left|remaining)\b/.test(q)) {
    const required = fields.filter(
      (f) => f.required && !["submit", "button", "reset", "image"].includes((f.type || "").toLowerCase())
    );
    const empty = required.filter((f) => !f.value);

    if (required.length === 0) {
      return { text: "This form has no required fields.", source: "on-device", confidence: 0.9 };
    }
    if (empty.length === 0) {
      return {
        text: `Yes — all ${required.length} required fields have values.`,
        source: "on-device",
        confidence: 0.95,
      };
    }
    return {
      text: `Not yet — ${empty.length} of ${required.length} required fields are still empty.`,
      source: "on-device",
      confidence: 0.95,
      detail: empty.map((f) => f.label || f.name).filter(Boolean).slice(0, 8).join(", "),
    };
  }

  // ── Sensitivity: "is there anything private on this page?" ──
  if (/\b(pii|sensitive|private|personal|secure|safe|redact)\b/.test(q)) {
    const count = piiDetection?.summary.totalRegions ?? 0;
    if (count === 0) {
      return { text: "No sensitive fields were detected on this page.", source: "on-device", confidence: 0.85 };
    }
    const cats = Object.keys(piiDetection?.summary.byCategory ?? {}).filter(
      (c) => (piiDetection!.summary.byCategory as any)[c] > 0
    );
    return {
      text: `Yes — ${count} sensitive region${count === 1 ? "" : "s"} detected and redacted before anything left the device.`,
      source: "on-device",
      confidence: 0.9,
      detail: cats.join(", "),
    };
  }

  return {
    text: "",
    source: "unanswered",
    confidence: 0,
    needsVision: true,
  };
}

/**
 * Prompt for a question that genuinely needs pixels.
 *
 * The caller MUST pass the redacted frame. Sending the raw screenshot would
 * hand a provider the faces and values the whole pipeline just removed.
 */
export function buildVisionQuestionPrompt(question: string): {
  system: string;
  user: string;
} {
  return {
    system:
      "You answer questions about a web page from a screenshot. The image has " +
      "been redacted on the user's device: black boxes and blurred areas are " +
      "REMOVED PRIVATE DATA, not page content. Never guess at what is behind " +
      "them and never ask for it. Answer in one or two plain sentences. If the " +
      "image does not show the answer, say so plainly.",
    user: `Question: ${question}\n\nAnswer from the screenshot only.`,
  };
}
