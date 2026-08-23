// ============================================================
// VLESS — PII Tripwire (MAIN-world page monitor)
//
// Observes the page's own outbound fetch/XHR traffic and reports
// which requests carried PII. Runs in the MAIN world, because a
// content script's isolated world has its own `fetch` and
// `XMLHttpRequest` — patching those there sees nothing the page does.
//
// OBSERVE-ONLY, deliberately. Blocking the page's requests would break
// every login, checkout, and search box on the web: a site legitimately
// POSTs the user's own email and phone number to its own server. VLESS
// blocks the traffic it is responsible for — its own LLM calls — in
// `egress-guard.ts`. Here it only reports.
//
// Observations are posted to the isolated content script, which relays
// them to the background for the Privacy Ledger.
// ============================================================

import { scanTextForPII, type PIICategory } from "./pii-detector";
import { extractBodyString, sanitizeUrl } from "./egress-guard";

// ── Wire format (MAIN world → isolated content script) ───────

export const TRIPWIRE_MESSAGE = "VLESS_TRIPWIRE_OBSERVATION";

export interface TripwireObservation {
  url: string;
  method: string;
  bytes: number;
  matches: Array<{ category: PIICategory; matchedText: string; position: number }>;
}

export interface TripwireMessage {
  source: typeof TRIPWIRE_MESSAGE;
  observations: TripwireObservation[];
}

// ── State ────────────────────────────────────────────────────

let active = false;
let originalFetch: typeof fetch | null = null;
let originalXHROpen: typeof XMLHttpRequest.prototype.open | null = null;
let originalXHRSend: typeof XMLHttpRequest.prototype.send | null = null;

/** Observations are batched so a chatty page cannot flood postMessage. */
let pending: TripwireObservation[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 500;
const MAX_PENDING = 50;
/** Bodies larger than this are not scanned — a multi-MB upload would jank the page. */
const MAX_SCAN_BYTES = 256 * 1024;

// ── Activation ───────────────────────────────────────────────

/**
 * Activate the page monitor. Must be called from a MAIN-world script.
 * Never throws into page code and never delays a request: the body is
 * scanned after the original call has already been dispatched.
 */
export function activateTripwire(): void {
  if (active) return;
  if (typeof window === "undefined") return;
  active = true;

  originalFetch = window.fetch.bind(window);

  window.fetch = function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    // Dispatch first. Observation must never sit in front of the request.
    const response = originalFetch!(input, init);

    try {
      const method = (init?.method || "GET").toUpperCase();
      if (init?.body && method !== "GET" && method !== "HEAD") {
        void observe(urlOf(input), method, init.body);
      }
    } catch {
      // Monitoring is best-effort and must never surface to the page.
    }

    return response;
  };

  originalXHROpen = XMLHttpRequest.prototype.open;
  originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ) {
    try {
      (this as any)._vlessMethod = method;
      (this as any)._vlessUrl = typeof url === "string" ? url : url.href;
    } catch {
      // Ignore — some pages freeze XHR instances.
    }
    return originalXHROpen!.call(this, method, url, async ?? true, username, password);
  };

  XMLHttpRequest.prototype.send = function patchedSend(
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null
  ) {
    // Send first, observe after — identical reasoning to fetch above.
    const result = originalXHRSend!.call(this, body);

    try {
      const method = ((this as any)._vlessMethod || "GET").toUpperCase();
      const url = (this as any)._vlessUrl || "";
      if (body && method !== "GET" && method !== "HEAD") {
        void observe(url, method, body as BodyInit);
      }
    } catch {
      // Best-effort.
    }

    return result;
  };

  console.log("[VLESS Tripwire] Page monitor active (observe-only)");
}

export function deactivateTripwire(): void {
  if (!active) return;
  active = false;

  if (originalFetch) window.fetch = originalFetch;
  if (originalXHROpen) XMLHttpRequest.prototype.open = originalXHROpen;
  if (originalXHRSend) XMLHttpRequest.prototype.send = originalXHRSend;

  flush();
  console.log("[VLESS Tripwire] Page monitor deactivated");
}

export function isTripwireActive(): boolean {
  return active;
}

// ── Observation ──────────────────────────────────────────────

async function observe(url: string, method: string, body: BodyInit | Document): Promise<void> {
  if (typeof (body as Document)?.nodeType === "number") return; // Document bodies: skip.

  let bodyStr = "";
  try {
    bodyStr = await extractBodyString(body as BodyInit);
  } catch {
    return;
  }
  if (!bodyStr) return;

  const bytes = new TextEncoder().encode(bodyStr).length;
  if (bytes > MAX_SCAN_BYTES) return;

  // Checksum-gated only. Reporting every 10-digit order id as a phone
  // number would make the ledger meaningless.
  const matches = scanTextForPII(bodyStr);

  pending.push({
    url: sanitizeUrl(url),
    method,
    bytes,
    matches: matches.map((m) => ({
      category: m.category,
      matchedText: maskSample(m.matchedText),
      position: m.index,
    })),
  });

  if (pending.length >= MAX_PENDING) {
    flush();
  } else if (!flushTimer) {
    flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
  }
}

function flush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending.length === 0) return;

  const message: TripwireMessage = {
    source: TRIPWIRE_MESSAGE,
    observations: pending,
  };
  pending = [];

  try {
    window.postMessage(message, window.location.origin);
  } catch {
    // Page monitoring is best-effort.
  }
}

/** The ledger renders these — never let a real value through. */
function maskSample(value: string): string {
  if (value.length <= 4) return "*".repeat(value.length);
  return `${value.slice(0, 2)}${"*".repeat(value.length - 4)}${value.slice(-2)}`;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}
