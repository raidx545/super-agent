// ============================================================
// VLESS — Egress Guard
//
// The last line of defence on the extension's OWN outbound traffic.
// Every request VLESS makes to an LLM provider goes through
// `guardedFetch`, which scans the serialized body with the same
// checksum-gated detectors used for page analysis. If validated PII
// is present, the request never reaches the network.
//
// Why here and not in the page: a content script runs in an isolated
// world, so patching its `fetch` cannot see page traffic at all, and
// patching the page's `fetch` to *block* would break every login form
// on the web. Blocking belongs on traffic we own and are responsible
// for. Page traffic is observed, not blocked — see `tripwire.ts`.
//
// This is DevTools-verifiable: a blocked call produces no network
// entry, and the ledger records why.
// ============================================================

import { scanTextForPII, type PIICategory, type PIITextMatch } from "./pii-detector";

// ── Types ────────────────────────────────────────────────────

export type EgressOrigin = "extension" | "page";

export interface TripwireEvent {
  id: string;
  timestamp: number;
  url: string;
  method: string;
  blocked: boolean;
  /** "extension" = our own LLM call (blocked). "page" = site traffic (observed). */
  origin: EgressOrigin;
  detectedPatterns: Array<{
    category: PIICategory;
    matchedText: string;
    position: number;
  }>;
  bytesBlocked: number;
}

export interface TripwireStats {
  totalRequests: number;
  blockedRequests: number;
  cleanRequests: number;
  totalBytesInspected: number;
  totalBytesBlocked: number;
  events: TripwireEvent[];
}

/** Thrown when an outbound request is refused. Callers treat it as a hard failure. */
export class EgressBlockedError extends Error {
  readonly categories: PIICategory[];
  constructor(url: string, categories: PIICategory[]) {
    super(
      `VLESS egress guard blocked a request to ${url} — outbound payload contained ${categories.join(", ")}`
    );
    this.name = "EgressBlockedError";
    this.categories = categories;
  }
}

// ── Ledger ───────────────────────────────────────────────────

const MAX_EVENTS = 100;

let stats: TripwireStats = emptyStats();

function emptyStats(): TripwireStats {
  return {
    totalRequests: 0,
    blockedRequests: 0,
    cleanRequests: 0,
    totalBytesInspected: 0,
    totalBytesBlocked: 0,
    events: [],
  };
}

function pushEvent(event: TripwireEvent): void {
  stats.events.push(event);
  if (stats.events.length > MAX_EVENTS) {
    stats.events = stats.events.slice(-MAX_EVENTS);
  }
}

function newEventId(): string {
  return `tw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── Guarded fetch ────────────────────────────────────────────

/**
 * Drop-in `fetch` replacement for every outbound call VLESS makes.
 * Scans request bodies for checksum-validated PII and refuses to send
 * when any is found.
 *
 * Email is deliberately excluded from the block decision: it has no
 * checksum, and a false positive here silently breaks planning. It is
 * still surfaced in the ledger via `scanForAudit`.
 */
export async function guardedFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const url = urlOf(input);
  const method = (init?.method || "GET").toUpperCase();

  stats.totalRequests++;

  const body = init?.body;
  if (!body || !METHODS_WITH_BODY.has(method)) {
    stats.cleanRequests++;
    return fetch(input, init);
  }

  const bodyStr = await extractBodyString(body);
  if (!bodyStr) {
    stats.cleanRequests++;
    return fetch(input, init);
  }

  const bodyBytes = byteLength(bodyStr);
  stats.totalBytesInspected += bodyBytes;

  const matches = scanTextForPII(bodyStr);

  if (matches.length > 0) {
    stats.blockedRequests++;
    stats.totalBytesBlocked += bodyBytes;

    pushEvent({
      id: newEventId(),
      timestamp: Date.now(),
      url: sanitizeUrl(url),
      method,
      blocked: true,
      origin: "extension",
      detectedPatterns: matches.map(toPattern),
      bytesBlocked: bodyBytes,
    });

    const categories = [...new Set(matches.map((m) => m.category))];
    console.error(
      `[VLESS Egress Guard] BLOCKED ${method} ${sanitizeUrl(url)} — ${categories.join(", ")} in payload`
    );
    throw new EgressBlockedError(sanitizeUrl(url), categories);
  }

  stats.cleanRequests++;
  return fetch(input, init);
}

const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// ── Page-monitor intake ──────────────────────────────────────

/**
 * Record observations relayed from the MAIN-world page monitor.
 * These are never blocked — the page's traffic is the site's business.
 * They exist so the Privacy Ledger can show what the page itself sent
 * alongside what VLESS sent.
 */
export function recordPageObservations(
  observations: Array<{
    url: string;
    method: string;
    bytes: number;
    matches: Array<{ category: PIICategory; matchedText: string; position: number }>;
  }>
): void {
  for (const obs of observations) {
    stats.totalRequests++;
    stats.totalBytesInspected += obs.bytes;
    if (obs.matches.length > 0) {
      pushEvent({
        id: newEventId(),
        timestamp: Date.now(),
        url: sanitizeUrl(obs.url),
        method: obs.method,
        blocked: false,
        origin: "page",
        detectedPatterns: obs.matches,
        bytesBlocked: 0,
      });
    } else {
      stats.cleanRequests++;
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────

function toPattern(m: PIITextMatch): {
  category: PIICategory;
  matchedText: string;
  position: number;
} {
  return {
    category: m.category,
    // Never store the raw value in the ledger — the ledger is rendered in
    // the side panel and would otherwise re-expose what we just blocked.
    matchedText: redactSample(m.matchedText),
    position: m.index,
  };
}

function redactSample(value: string): string {
  if (value.length <= 4) return "*".repeat(value.length);
  return `${value.slice(0, 2)}${"*".repeat(value.length - 4)}${value.slice(-2)}`;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function byteLength(str: string): number {
  return new TextEncoder().encode(str).length;
}

export async function extractBodyString(body: BodyInit): Promise<string> {
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof FormData) {
    const parts: string[] = [];
    body.forEach((value, key) => {
      parts.push(`${key}=${typeof value === "string" ? value : "[file]"}`);
    });
    return parts.join("&");
  }
  if (body instanceof Blob) {
    try { return await body.text(); } catch { return ""; }
  }
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body as Uint8Array);
  }
  // ReadableStream bodies cannot be inspected without consuming them,
  // which would make the request unsendable. VLESS never uses them for
  // LLM calls; report empty so the caller falls through to a plain send.
  return "";
}

/** Strip query and hash — they routinely carry PII. */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split("?")[0].split("#")[0];
  }
}

// ── Public API ───────────────────────────────────────────────

export function getEgressStats(): TripwireStats {
  return { ...stats, events: [...stats.events] };
}

export function resetEgressStats(): void {
  stats = emptyStats();
}
