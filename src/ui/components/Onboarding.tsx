import { useState } from "react";

interface OnboardingProps {
  onComplete: (openSettings?: boolean) => void;
}

const STEPS = [
  {
    icon: "🐾",
    title: "Welcome to VLESS",
    description:
      "A privacy-preserving browser agent that sees your screen, understands your intent, and automates web tasks — without sending a single pixel to the cloud.",
    color: "from-blue-600 to-purple-600",
  },
  {
    icon: "🔒",
    title: "100% On-Device",
    description:
      "Every AI model runs in your browser. Screenshots never leave your device. Form data stays local. Zero network requests during operation.",
    color: "from-green-600 to-emerald-600",
  },
  {
    icon: "🧠",
    title: "Connect an AI Provider",
    description:
      "VLESS needs an LLM to understand your requests. Choose one:\n\n• Ollama (free, local) — install Ollama + pull qwen2.5:1.5b\n• Claude / OpenAI / OpenRouter — paste your API key\n\nTakes 30 seconds. Without this, only basic rules work.",
    color: "from-purple-600 to-pink-600",
  },
  {
    icon: "👁️",
    title: "Visual Debug",
    description:
      "See exactly what the agent perceives — bounding boxes, confidence scores, and a full reasoning trace. Complete transparency.",
    color: "from-orange-600 to-red-600",
  },
  {
    icon: "⚡",
    title: "Ready to Go",
    description:
      "Click the extension icon to open the side panel. Describe any task in natural language and the AI will plan and execute it. Try: 'Fill this form with my data'.",
    color: "from-cyan-600 to-blue-600",
  },
];

export function Onboarding({ onComplete }: OnboardingProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [isExiting, setIsExiting] = useState(false);

  const step = STEPS[currentStep];
  const isLast = currentStep === STEPS.length - 1;

  const handleNext = () => {
    if (isLast) {
      setIsExiting(true);
      setTimeout(() => onComplete(true), 300);
    } else {
      setCurrentStep((s) => s + 1);
    }
  };

  const handleSkip = () => {
    setIsExiting(true);
    setTimeout(onComplete, 300);
  };

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-gray-950 transition-opacity duration-300 ${
        isExiting ? "opacity-0" : "opacity-100"
      }`}
    >
      {/* Background gradient */}
      <div
        className={`absolute inset-0 bg-gradient-to-br ${step.color} opacity-10 transition-all duration-500`}
      />

      <div className="relative max-w-sm w-full mx-4">
        {/* Skip button */}
        {!isLast && (
          <button
            onClick={handleSkip}
            className="absolute -top-12 right-0 text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            Skip →
          </button>
        )}

        {/* Step content */}
        <div className="text-center">
          {/* Icon */}
          <div className="text-6xl mb-6 animate-bounce">{step.icon}</div>

          {/* Title */}
          <h1 className="text-xl font-bold text-white mb-3">{step.title}</h1>

          {/* Description */}
          <p className="text-sm text-gray-400 leading-relaxed mb-8">
            {step.description}
          </p>

          {/* Progress dots */}
          <div className="flex justify-center gap-2 mb-6">
            {STEPS.map((_, i) => (
              <div
                key={i}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  i === currentStep
                    ? "w-6 bg-white"
                    : i < currentStep
                      ? "w-1.5 bg-white/50"
                      : "w-1.5 bg-gray-700"
                }`}
              />
            ))}
          </div>

          {/* Next button */}
          <button
            onClick={handleNext}
            className={`w-full py-3 rounded-xl font-medium text-sm transition-all duration-200 ${
              isLast
                ? "bg-white text-gray-900 hover:bg-gray-100"
                : "bg-gray-800 text-white hover:bg-gray-700 border border-gray-700"
            }`}
          >
            {isLast ? "Get Started 🚀" : "Next →"}
          </button>
        </div>
      </div>
    </div>
  );
}
