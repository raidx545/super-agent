// ============================================================
// VLESS — Voice Control (Stub)
// Voice commands are a future feature. This is a placeholder.
// Note: Web Speech API sends audio to Google servers,
// which breaks the "on-device" privacy guarantee.
// A future implementation will use on-device Whisper.
// ============================================================

import { useState } from "react";

export function VoiceControl() {
  const [isListening] = useState(false);
  const [transcript] = useState("");

  return (
    <div className="p-4 border rounded-lg bg-gray-50">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-lg">🎙️</span>
        <span className="font-semibold text-sm">Voice Commands</span>
      </div>
      <p className="text-xs text-gray-500">
        Voice commands require on-device speech recognition (coming soon).
        Web Speech API sends audio to cloud servers, which breaks our privacy guarantee.
      </p>
      {isListening && (
        <p className="text-xs text-blue-600 mt-2">
          Listening... "{transcript}"
        </p>
      )}
    </div>
  );
}
