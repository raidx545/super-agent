import { useState, useEffect, useCallback } from "react";
import {
  startListening,
  stopListening,
  isSupported,
  onVoiceEvent,
  getSupportedLanguages,
  getHistory,
  type VoiceCommand,
} from "../../core/voice/speech-recognition";

export function VoiceControl() {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [, setLastCommand] = useState<VoiceCommand | null>(null);
  const [history, setHistory] = useState<VoiceCommand[]>([]);
  const [language, setLanguage] = useState("hi-IN");
  const [error, setError] = useState<string | null>(null);

  const supported = isSupported();
  const languages = getSupportedLanguages();

  useEffect(() => {
    const unsub = onVoiceEvent((event, data) => {
      switch (event) {
        case "start":
          setIsListening(true);
          setError(null);
          break;
        case "end":
          setIsListening(false);
          break;
        case "transcript":
          setTranscript((data as { text: string }).text);
          break;
        case "command":
          setLastCommand(data as VoiceCommand);
          setHistory(getHistory());
          break;
        case "error":
          setError((data as { message: string }).message);
          break;
      }
    });
    return unsub;
  }, []);

  const toggleListening = useCallback(() => {
    if (isListening) {
      stopListening();
    } else {
      const started = startListening(language);
      if (!started) {
        setError("Failed to start speech recognition");
      }
    }
  }, [isListening, language]);

  if (!supported) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-8">
        <div className="text-4xl mb-4">🎙️</div>
        <h3 className="text-sm font-medium text-gray-300 mb-2">Voice Commands</h3>
        <p className="text-[11px] text-gray-500">
          Speech recognition is not supported in this browser.
          Try Chrome or Edge for voice command support.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Voice Control Header */}
      <div className="p-4 border-b border-gray-800">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-300">🎙️ Voice Commands</h2>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="text-[10px] bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-300"
          >
            {languages.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.name}
              </option>
            ))}
          </select>
        </div>

        {/* Microphone Button */}
        <div className="flex justify-center">
          <button
            onClick={toggleListening}
            className={`relative w-20 h-20 rounded-full flex items-center justify-center transition-all duration-300 ${
              isListening
                ? "bg-red-600 hover:bg-red-500 shadow-lg shadow-red-600/30"
                : "bg-gray-800 hover:bg-gray-700 border border-gray-700"
            }`}
          >
            <span className="text-3xl">{isListening ? "🔴" : "🎙️"}</span>
            {isListening && (
              <div className="absolute inset-0 rounded-full border-2 border-red-400 animate-ping opacity-30" />
            )}
          </button>
        </div>

        <p className="text-center text-[11px] text-gray-500 mt-3">
          {isListening ? "Listening... Click to stop" : "Click to start listening"}
        </p>

        {/* Transcript */}
        {transcript && (
          <div className="mt-3 p-2 bg-gray-900 rounded-lg border border-gray-800">
            <p className="text-[11px] text-gray-300 font-mono">"{transcript}"</p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mt-2 p-2 bg-red-900/20 rounded-lg border border-red-800/30">
            <p className="text-[11px] text-red-400">{error}</p>
          </div>
        )}
      </div>

      {/* Quick Commands */}
      <div className="p-4 border-b border-gray-800">
        <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Quick Commands</p>
        <div className="space-y-1.5">
          {[
            { hindi: "Form bhar do", english: "Fill this form", icon: "📝" },
            { hindi: "Page ka data nikalo", english: "Extract page data", icon: "📊" },
            { hindi: "Niche scroll karo", english: "Scroll down", icon: "⬇️" },
            { hindi: "Cancel karo", english: "Cancel task", icon: "🚫" },
          ].map((cmd) => (
            <div key={cmd.english} className="flex items-center gap-2 text-[11px]">
              <span>{cmd.icon}</span>
              <div className="flex-1">
                <span className="text-gray-300">{cmd.hindi}</span>
                <span className="text-gray-600 ml-2">/ {cmd.english}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Command History */}
      <div className="flex-1 overflow-y-auto p-4">
        <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Recent Commands</p>
        {history.length === 0 ? (
          <p className="text-[11px] text-gray-600 text-center py-4">No commands yet</p>
        ) : (
          <div className="space-y-2">
            {history.slice(-10).reverse().map((cmd) => {
              const time = new Date(cmd.timestamp).toLocaleTimeString();
              return (
                <div key={cmd.id} className="bg-gray-900 rounded-lg p-2 border border-gray-800">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-gray-500">{time}</span>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded ${
                      cmd.confidence > 0.7 ? "bg-green-900/30 text-green-400" : "bg-yellow-900/30 text-yellow-400"
                    }`}>
                      {Math.round(cmd.confidence * 100)}%
                    </span>
                  </div>
                  <p className="text-[11px] text-gray-300">"{cmd.rawText}"</p>
                  <p className="text-[10px] text-gray-500 capitalize mt-0.5">
                    Intent: {cmd.intent.type.replace("_", " ")}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
