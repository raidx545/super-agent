// ============================================================
// VLESS — Task Decomposer
//
// Splits a compound request ("extract the data and fill the form")
// into sub-tasks so one run can satisfy several intents.
//
// ON "SIMULTANEOUSLY"
// Reads and writes are not symmetric here. Extraction is read-only and
// runs against the already-captured page state, so it costs ~1ms and can
// happen alongside anything. Actions MUTATE the page: typing into a
// field while another step clicks Submit corrupts both. So sub-tasks
// compose, but action sub-tasks stay strictly ordered. Running them in
// parallel would be faster and wrong.
//
// The expensive stages — capture, PII detection, redaction — run ONCE
// for the whole request, not once per sub-task.
// ============================================================

import { isExtractionTask } from "../extraction/page-extractor";

export type SubTaskKind = "extract" | "action";

export interface SubTask {
  kind: SubTaskKind;
  description: string;
}

/** Strong separators — an explicit sequence, safe to split on. */
const SEQUENCE_SEPARATORS = [
  " and then ",
  " then ",
  " after that ",
  " followed by ",
  ";",
  " & then ",
];

/** Verbs that mark a clause as a task in its own right. */
const ACTION_VERBS =
  /\b(fill|submit|click|type|select|scroll|navigate|go to|open|press|check|upload|choose|enter)\b/;
const READ_VERBS =
  /\b(extract|scrape|read|list|summari[sz]e|show me|get the data|pull|copy)\b/;

/**
 * Split a request into ordered sub-tasks.
 * A request with no recognizable composition returns a single sub-task,
 * so the common path is unchanged.
 */
export function decomposeTask(description: string): SubTask[] {
  const trimmed = description.trim();
  if (!trimmed) return [];

  const clauses = splitClauses(trimmed);

  const subTasks: SubTask[] = clauses
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0)
    .map((clause) => ({
      kind: classifyClause(clause),
      description: clause,
    }));

  return subTasks.length > 0
    ? dedupeExtractions(subTasks)
    : [{ kind: classifyClause(trimmed), description: trimmed }];
}

function splitClauses(text: string): string[] {
  // Strong separators first — these always indicate a sequence.
  let parts = [text];
  for (const sep of SEQUENCE_SEPARATORS) {
    parts = parts.flatMap((part) => splitOnLiteral(part, sep));
  }

  // A bare "and" is ambiguous: "fill name and address" is one task,
  // "extract data and fill the form" is two. Only split when BOTH halves
  // carry their own verb.
  return parts.flatMap((part) => splitOnBareAnd(part));
}

function splitOnLiteral(text: string, sep: string): string[] {
  const lower = text.toLowerCase();
  const out: string[] = [];
  let cursor = 0;
  let idx = lower.indexOf(sep, cursor);
  while (idx !== -1) {
    out.push(text.slice(cursor, idx));
    cursor = idx + sep.length;
    idx = lower.indexOf(sep, cursor);
  }
  out.push(text.slice(cursor));
  return out.filter((s) => s.trim().length > 0);
}

function splitOnBareAnd(text: string): string[] {
  const lower = text.toLowerCase();
  const marker = " and ";
  let idx = lower.indexOf(marker);

  while (idx !== -1) {
    const left = text.slice(0, idx);
    const right = text.slice(idx + marker.length);
    if (hasOwnVerb(left) && hasOwnVerb(right)) {
      return [left, ...splitOnBareAnd(right)];
    }
    idx = lower.indexOf(marker, idx + marker.length);
  }
  return [text];
}

function hasOwnVerb(clause: string): boolean {
  const lower = clause.toLowerCase();
  return ACTION_VERBS.test(lower) || READ_VERBS.test(lower);
}

function classifyClause(clause: string): SubTaskKind {
  // isExtractionTask deliberately yields to actions on a mixed clause;
  // at this point the clause is already isolated, so a read verb with no
  // action verb is unambiguously a read.
  if (isExtractionTask(clause)) return "extract";
  const lower = clause.toLowerCase();
  if (READ_VERBS.test(lower) && !ACTION_VERBS.test(lower)) return "extract";
  return "action";
}

/**
 * Extraction is page-wide, so N extract clauses produce identical output.
 * Collapse them to the first, preserving order of the rest.
 */
function dedupeExtractions(subTasks: SubTask[]): SubTask[] {
  let seenExtract = false;
  return subTasks.filter((st) => {
    if (st.kind !== "extract") return true;
    if (seenExtract) return false;
    seenExtract = true;
    return true;
  });
}

/** True when the request contains more than one distinct intent. */
export function isCompoundTask(description: string): boolean {
  return decomposeTask(description).length > 1;
}

/** The action clauses, recombined into one description for the planner. */
export function actionDescription(subTasks: SubTask[]): string {
  return subTasks
    .filter((st) => st.kind === "action")
    .map((st) => st.description.trim())
    .join(", then ");
}
