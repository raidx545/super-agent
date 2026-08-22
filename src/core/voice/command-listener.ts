// ============================================================
// VLESS — Voice Command Listener
// Hands-free browser automation via voice commands.
// Supports English and Hindi (Devanagari).
//
// Usage:
//   "Fill this form with my resume data"
//   "Click the submit button"
//   "Scroll down"
//   "Go to google.com"
//   "Yeh form bhar do" (Hindi: Fill this form)
// ============================================================

// ── Types ────────────────────────────────────────────────────

export interface VoiceCommand {
  id: string;
  rawTranscript: string;
  normalizedTranscript: string;
  language: "en" | "hi" | "unknown";
  intent: VoiceIntent;
  confidence: number;
  timestamp: number;
}

export type VoiceIntent =
  | { type: "fill_form"; dataContext?: Record<string, string> }
  | { type: "click"; target: string }
  | { type: "type"; target: string; value: string }
  | { type: "scroll"; direction: "up" | "down" | "top" | "bottom" }
  | { type: "navigate"; url: string }
  | { type: "select"; target: string; value: string }
  | { type: "go_back" }
  | { type: "start_agent" }
  | { type: "stop_agent" }
  | { type: "undo" }
  | { type: "help" }
  | { type: "unknown"; rawText: string };

export interface VoiceListenerConfig {
  language: "en-US" | "hi-IN" | "auto";
  continuous: boolean;
  interimResults: boolean;
  onCommand: (command: VoiceCommand) => void;
  onListening: (listening: boolean) => void;
  onError: (error: string) => void;
}

// ── Command Patterns ─────────────────────────────────────────

const ENGLISH_PATTERNS: Array<{ pattern: RegExp; intent: (match: RegExpMatchArray) => VoiceIntent }> = [
  { pattern: /(?:fill|complete|submit)\s+(?:this\s+)?(?:form|page)/i, intent: () => ({ type: "fill_form" }) },
  { pattern: /fill\s+(?:this\s+)?form\s+(?:with|using)\s+(.+)/i, intent: (m) => ({ type: "fill_form", dataContext: { source: m[1] } }) },
  { pattern: /click\s+(?:on\s+)?(?:the\s+)?["']?([^"']+)["']?/i, intent: (m) => ({ type: "click", target: m[1].trim() }) },
  { pattern: /press\s+(?:the\s+)?["']?([^"']+)["']?/i, intent: (m) => ({ type: "click", target: m[1].trim() }) },
  { pattern: /type\s+["']([^"']+)["']\s+(?:in|into)\s+(?:the\s+)?["']?([^"']+)["']?/i, intent: (m) => ({ type: "type", value: m[1], target: m[2].trim() }) },
  { pattern: /(?:enter|input)\s+["']([^"']+)["']$/i, intent: (m) => ({ type: "type", value: m[1], target: "active field" }) },
  { pattern: /scroll\s+(down|up|to\s+top|to\s+bottom)/i, intent: (m) => {
    const dir = m[1].toLowerCase();
    return { type: "scroll", direction: dir.includes("top") ? "top" : dir.includes("bottom") ? "bottom" : dir as "up" | "down" };
  }},
  { pattern: /(?:go\s+to|open|navigate\s+to|visit)\s+(.+)/i, intent: (m) => ({ type: "navigate", url: m[1].trim() }) },
  { pattern: /select\s+["']([^"']+)["']\s+(?:in|from)\s+(?:the\s+)?["']?([^"']+)["']?/i, intent: (m) => ({ type: "select", value: m[1], target: m[2].trim() }) },
  { pattern: /go\s+back/i, intent: () => ({ type: "go_back" }) },
  { pattern: /(?:start|run|execute)\s+(?:the\s+)?agent/i, intent: () => ({ type: "start_agent" }) },
  { pattern: /(?:stop|cancel|halt)\s+(?:the\s+)?agent/i, intent: () => ({ type: "stop_agent" }) },
  { pattern: /undo/i, intent: () => ({ type: "undo" }) },
  { pattern: /help|what can you do/i, intent: () => ({ type: "help" }) },
];

const HINDI_PATTERNS: Array<{ pattern: RegExp; intent: (match: RegExpMatchArray) => VoiceIntent }> = [
  { pattern: /(?:यह|इस)\s+फॉर्म\s+(?:भर\s+दो|fill\s+करो)/i, intent: () => ({ type: "fill_form" }) },
  { pattern: /फॉर्म\s+भर\s+दो/i, intent: () => ({ type: "fill_form" }) },
  { pattern: /(?:पर|पे)\s+क्लिक\s+(?:करो|करें)\s+(.+)/i, intent: (m) => ({ type: "click", target: m[1].trim() }) },
  { pattern: /क्लिक\s+(?:करो|करें)\s+(?:पर\s+)?(.+)/i, intent: (m) => ({ type: "click", target: m[1].trim() }) },
  { pattern: /(?:नीचे|up)\s+स्क्रॉल\s+(?:करो|करें)/i, intent: () => ({ type: "scroll", direction: "down" }) },
  { pattern: /(?:ऊपर|नीचे)\s+स्क्रॉल\s+(?:करो|करें)/i, intent: (m) => ({
    type: "scroll",
    direction: m[0].includes("ऊपर") ? "up" : "down",
  }) },
  { pattern: /(?:जाओ|खोलो)\s+(.+)/i, intent: (m) => ({ type: "navigate", url: m[1].trim() }) },
  { pattern: /(?:रोको|बंद\s+करो)/i, intent: () => ({ type: "stop_agent" }) },
  { pattern: /(?:शुरू\s+करो|चलाओ)/i, intent: () => ({ type: "start_agent" }) },
];

// ── Normalization ────────────────────────────────────────────

function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function detectLanguage(text: string): "en" | "hi" | "unknown" {
  // Check for Devanagari characters
  const devanagariRange = /[\u0900-\u097F]/;
  if (devanagariRange.test(text)) return "hi";

  // Check for common English words
  const englishWords = /\b(the|is|are|click|fill|form|scroll|go|type|select)\b/i;
  if (englishWords.test(text)) return "en";

  return "unknown";
}

function matchIntent(
  text: string,
  language: "en" | "hi" | "unknown"
): VoiceIntent {
  const patterns = language === "hi" ? HINDI_PATTERNS : ENGLISH_PATTERNS;

  for (const { pattern, intent } of patterns) {
    const match = text.match(pattern);
    if (match) return intent(match);
  }

  // Try the other language if first doesn't match
  const otherPatterns = language === "hi" ? ENGLISH_PATTERNS : HINDI_PATTERNS;
  for (const { pattern, intent } of otherPatterns) {
    const match = text.match(pattern);
    if (match) return intent(match);
  }

  return { type: "unknown", rawText: text };
}

// ── Voice Listener ───────────────────────────────────────────

export class VoiceCommandListener {
  private recognition: any = null;
  private config: VoiceListenerConfig;
  private isListening = false;
  private commandHistory: VoiceCommand[] = [];

  constructor(config: VoiceListenerConfig) {
    this.config = config;
  }

  /**
   * Start listening for voice commands.
   */
  start(): boolean {
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      this.config.onError("Speech recognition not supported in this browser");
      return false;
    }

    this.recognition = new SpeechRecognition();
    this.recognition.lang = this.config.language === "auto" ? "en-US" : this.config.language;
    this.recognition.continuous = this.config.continuous;
    this.recognition.interimResults = this.config.interimResults;

    this.recognition.onresult = (event: any) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          const transcript = event.results[i][0].transcript;
          const confidence = event.results[i][0].confidence;
          this.processTranscript(transcript, confidence);
        }
      }
    };

    this.recognition.onstart = () => {
      this.isListening = true;
      this.config.onListening(true);
    };

    this.recognition.onend = () => {
      this.isListening = false;
      this.config.onListening(false);

      // Auto-restart if continuous mode
      if (this.config.continuous && this.isListening) {
        setTimeout(() => this.start(), 100);
      }
    };

    this.recognition.onerror = (event: any) => {
      if (event.error !== "no-speech") {
        this.config.onError(`Voice error: ${event.error}`);
      }
    };

    try {
      this.recognition.start();
      return true;
    } catch {
      this.config.onError("Failed to start speech recognition");
      return false;
    }
  }

  /**
   * Stop listening.
   */
  stop(): void {
    if (this.recognition) {
      this.recognition.stop();
      this.recognition = null;
    }
    this.isListening = false;
    this.config.onListening(false);
  }

  /**
   * Get command history.
   */
  getHistory(): VoiceCommand[] {
    return [...this.commandHistory];
  }

  /**
   * Check if listening.
   */
  getIsListening(): boolean {
    return this.isListening;
  }

  // ── Private ──────────────────────────────────────────

  private processTranscript(rawTranscript: string, confidence: number): void {
    const normalized = normalizeTranscript(rawTranscript);
    const language = detectLanguage(rawTranscript);
    const intent = matchIntent(normalized, language);

    const command: VoiceCommand = {
      id: `vc-${Date.now()}`,
      rawTranscript,
      normalizedTranscript: normalized,
      language,
      intent,
      confidence,
      timestamp: Date.now(),
    };

    this.commandHistory.push(command);

    // Keep last 50 commands
    if (this.commandHistory.length > 50) {
      this.commandHistory = this.commandHistory.slice(-50);
    }

    this.config.onCommand(command);
  }
}

// ── Convenience ──────────────────────────────────────────────

/**
 * Create a voice command listener with sensible defaults.
 */
export function createVoiceListener(
  onCommand: (command: VoiceCommand) => void,
  language: "en-US" | "hi-IN" | "auto" = "auto"
): VoiceCommandListener {
  return new VoiceCommandListener({
    language,
    continuous: true,
    interimResults: false,
    onCommand,
    onListening: () => {},
    onError: (err) => console.warn("[VLESS Voice]", err),
  });
}
