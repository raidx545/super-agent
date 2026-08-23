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
    <div className="p-4 border border-stone-800 bg-[#171716]">
      <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-stone-400">
        Voice
      </p>
      <p className="mt-1 text-sm font-semibold text-stone-100">
        Voice commands
      </p>
      <p className="mt-2 text-xs text-stone-500">
        Voice commands require on-device speech recognition (coming soon). Web
        Speech API sends audio to cloud servers, which breaks our privacy
        guarantee.
      </p>
      {isListening && (
        <p className="mt-2 text-xs text-stone-300">
          Listening... "{transcript}"
        </p>
      )}
    </div>
  );
}
