// ============================================================
// VLESS — Voice Commands
// Hindi + English speech recognition for the browser agent
// India-first: supports 22 Indian languages via Web Speech API
// ============================================================

export interface VoiceCommand {
  id: string;
  timestamp: number;
  rawText: string;
  normalizedText: string;
  language: string;
  intent: VoiceIntent;
  confidence: number;
  executed: boolean;
}

export interface VoiceIntent {
  type: "fill_form" | "navigate" | "extract" | "click" | "scroll" | "help" | "cancel" | "unknown";
  parameters: Record<string, string>;
  originalCommand: string;
}

// ── Configuration ────────────────────────────────────────────

const SUPPORTED_LANGUAGES = [
  { code: "hi-IN", name: "Hindi", shortcuts: ["bhar do", "fill", "bharkar"] },
  { code: "en-US", name: "English", shortcuts: ["fill", "click", "go to"] },
  { code: "bn-IN", name: "Bengali", shortcuts: ["bharun", "fill"] },
  { code: "ta-IN", name: "Tamil", shortcuts: ["niraikka", "fill"] },
  { code: "te-IN", name: "Telugu", shortcuts: ["nimpindi", "fill"] },
  { code: "mr-IN", name: "Marathi", shortcuts: ["bhara", "fill"] },
  { code: "gu-IN", name: "Gujarati", shortcuts: ["bharo", "fill"] },
  { code: "kn-IN", name: "Kannada", shortcuts: ["thurisi", "fill"] },
  { code: "ml-IN", name: "Malayalam", shortcuts: ["nirakkuka", "fill"] },
  { code: "pa-IN", name: "Punjabi", shortcuts: ["bharo", "fill"] },
];

// ── State ────────────────────────────────────────────────────

interface VoiceState {
  isListening: boolean;
  isSupported: boolean;
  language: string;
  transcript: string;
  lastCommand: VoiceCommand | null;
  commandHistory: VoiceCommand[];
}

const state: VoiceState = {
  isListening: false,
  isSupported: typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window),
  language: "hi-IN", // Default to Hindi for India-first
  transcript: "",
  lastCommand: null,
  commandHistory: [],
};

let recognition: any = null;
let listeners: Array<(event: string, data: unknown) => void> = [];

// ── Public API ───────────────────────────────────────────────

/**
 * Start listening for voice commands.
 */
export function startListening(language?: string): boolean {
  if (!state.isSupported) {
    notify("error", { message: "Speech recognition not supported in this browser" });
    return false;
  }

  if (state.isListening) {
    return true;
  }

  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  recognition = new SpeechRecognition();

  recognition.lang = language || state.language;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 3;

  recognition.onstart = () => {
    state.isListening = true;
    notify("start", { language: recognition.lang });
  };

  recognition.onresult = (event: any) => {
    let interimTranscript = "";
    let finalTranscript = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        finalTranscript += result[0].transcript;
      } else {
        interimTranscript += result[0].transcript;
      }
    }

    state.transcript = finalTranscript || interimTranscript;
    notify("transcript", { text: state.transcript, isFinal: !!finalTranscript });

    if (finalTranscript) {
      const command = processCommand(finalTranscript, recognition.lang);
      state.lastCommand = command;
      state.commandHistory.push(command);

      // Keep last 50 commands
      if (state.commandHistory.length > 50) {
        state.commandHistory = state.commandHistory.slice(-50);
      }

      notify("command", command);
    }
  };

  recognition.onerror = (event: any) => {
    if (event.error === "no-speech") return; // Normal, ignore
    notify("error", { error: event.error, message: getErrorMessage(event.error) });
  };

  recognition.onend = () => {
    state.isListening = false;
    // Auto-restart if still in listening mode
    if (state.isListening) {
      try { recognition.start(); } catch { /* ignore */ }
    }
    notify("end", {});
  };

  try {
    recognition.start();
    return true;
  } catch {
    notify("error", { message: "Failed to start speech recognition" });
    return false;
  }
}

/**
 * Stop listening.
 */
export function stopListening(): void {
  if (recognition) {
    recognition.stop();
    recognition = null;
  }
  state.isListening = false;
  notify("end", {});
}

/**
 * Get current state.
 */
export function getState(): VoiceState {
  return { ...state };
}

/**
 * Check if voice is supported.
 */
export function isSupported(): boolean {
  return state.isSupported;
}

/**
 * Set language.
 */
export function setLanguage(code: string): void {
  state.language = code;
  if (recognition) {
    recognition.lang = code;
  }
}

/**
 * Get supported languages.
 */
export function getSupportedLanguages() {
  return SUPPORTED_LANGUAGES;
}

/**
 * Get command history.
 */
export function getHistory(): VoiceCommand[] {
  return [...state.commandHistory];
}

// ── Command Processing ───────────────────────────────────────

function processCommand(text: string, lang: string): VoiceCommand {
  const normalized = text.toLowerCase().trim();
  const intent = classifyIntent(normalized);

  return {
    id: `vc-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    timestamp: Date.now(),
    rawText: text,
    normalizedText: normalized,
    language: lang,
    intent,
    confidence: intent.type === "unknown" ? 0.3 : 0.85,
    executed: false,
  };
}

function classifyIntent(text: string): VoiceIntent {
  // Hindi patterns
  if (/bhar do|bhar de|fill|bharkar|form bhar/.test(text)) {
    return {
      type: "fill_form",
      parameters: extractFormParams(text),
      originalCommand: text,
    };
  }

  if (/jaao|go to|open|kholo|navigate/.test(text)) {
    return {
      type: "navigate",
      parameters: { url: extractUrl(text) || extractSearchQuery(text) || "" },
      originalCommand: text,
    };
  }

  if (/click|karo|dabao|press/.test(text)) {
    return {
      type: "click",
      parameters: { target: extractTarget(text) },
      originalCommand: text,
    };
  }

  if (/scroll|niche|upar|neeche|top|bottom/.test(text)) {
    return {
      type: "scroll",
      parameters: { direction: extractScrollDirection(text) },
      originalCommand: text,
    };
  }

  if (/extract|nikalo|data|copy|save/.test(text)) {
    return {
      type: "extract",
      parameters: {},
      originalCommand: text,
    };
  }

  if (/cancel|radd|band|stop|bas/.test(text)) {
    return {
      type: "cancel",
      parameters: {},
      originalCommand: text,
    };
  }

  if (/help|madad|kya kar sakte|what can/.test(text)) {
    return {
      type: "help",
      parameters: {},
      originalCommand: text,
    };
  }

  return {
    type: "unknown",
    parameters: {},
    originalCommand: text,
  };
}

// ── Parameter Extraction ─────────────────────────────────────

function extractFormParams(text: string): Record<string, string> {
  const params: Record<string, string> = {};

  // Pattern: "name as Shashank" or "name: Shashank"
  const patterns = [
    /(\w+)\s+(?:as|ko|se|mein|ka|ki)\s+(.+?)(?:\s+(?:and|aur|,)|$)/gi,
    /(\w+)\s*[:=]\s*(.+?)(?:\s+(?:and|aur|,)|$)/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      params[match[1].toLowerCase()] = match[2].trim();
    }
  }

  return params;
}

function extractUrl(text: string): string | null {
  // Look for URL pattern
  const urlMatch = text.match(/(https?:\/\/[^\s]+|[a-z0-9-]+\.[a-z]{2,}[^\s]*)/i);
  return urlMatch ? urlMatch[1] : null;
}

function extractSearchQuery(text: string): string | null {
  // Remove command words and return the rest as query
  const cleaned = text
    .replace(/jaao|go to|open|kholo|navigate|pe|par|to/gi, "")
    .trim();
  return cleaned || null;
}

function extractTarget(text: string): string {
  // Try to extract a target element from the command
  const patterns = [
    /click\s+(?:on\s+)?(.+)/i,
    /dabao\s+(.+)/i,
    /karo\s+(.+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }

  return text;
}

function extractScrollDirection(text: string): string {
  if (/upar|up|top|upar.jao/.test(text)) return "up";
  if (/niche|down|bottom|neeche/.test(text)) return "down";
  return "down";
}

// ── Helpers ──────────────────────────────────────────────────

function getErrorMessage(error: string): string {
  switch (error) {
    case "no-speech": return "No speech detected. Please try again.";
    case "audio-capture": return "No microphone found. Please connect a microphone.";
    case "not-allowed": return "Microphone access denied. Please allow microphone access.";
    case "network": return "Network error. Speech recognition requires internet.";
    case "aborted": return "Speech recognition was aborted.";
    default: return `Speech recognition error: ${error}`;
  }
}

function notify(event: string, data: unknown): void {
  for (const listener of listeners) {
    try {
      listener(event, data);
    } catch {
      // Listener error
    }
  }
}

/**
 * Subscribe to voice events.
 */
export function onVoiceEvent(callback: (event: string, data: unknown) => void): () => void {
  listeners.push(callback);
  return () => {
    listeners = listeners.filter((l) => l !== callback);
  };
}
