// ============================================================
// VLESS — Keyboard Shortcuts Hook
// Power user mode with Vim-like navigation
// ============================================================

import { useEffect, useCallback } from "react";

interface ShortcutHandlers {
  onNewTask?: () => void;
  onCancelTask?: () => void;
  onToggleOverlay?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onScanPage?: () => void;
  onToggleTab?: (direction: "next" | "prev") => void;
  onFocusInput?: () => void;
}

// ── Shortcut Definitions ─────────────────────────────────────

const SHORTCUTS: Record<string, string> = {
  "ctrl+n": "New task",
  "ctrl+enter": "Run current task",
  "escape": "Cancel / close",
  "ctrl+z": "Undo last action",
  "ctrl+shift+z": "Redo action",
  "ctrl+shift+v": "Toggle visual overlay",
  "ctrl+shift+s": "Scan current page",
  "ctrl+1": "Switch to Task tab",
  "ctrl+2": "Switch to Debug tab",
  "ctrl+3": "Switch to Inspector tab",
  "ctrl+4": "Switch to Settings tab",
  "ctrl+/": "Show keyboard shortcuts",
};

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in input fields
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.contentEditable === "true"
      ) {
        // Allow Escape even in inputs
        if (e.key !== "Escape") return;
      }

      const key = [
        e.ctrlKey || e.metaKey ? "ctrl" : "",
        e.shiftKey ? "shift" : "",
        e.key.toLowerCase(),
      ]
        .filter(Boolean)
        .join("+");

      switch (key) {
        case "ctrl+n":
          e.preventDefault();
          handlers.onNewTask?.();
          break;

        case "escape":
          e.preventDefault();
          handlers.onCancelTask?.();
          break;

        case "ctrl+z":
          e.preventDefault();
          handlers.onUndo?.();
          break;

        case "ctrl+shift+z":
          e.preventDefault();
          handlers.onRedo?.();
          break;

        case "ctrl+shift+v":
          e.preventDefault();
          handlers.onToggleOverlay?.();
          break;

        case "ctrl+shift+s":
          e.preventDefault();
          handlers.onScanPage?.();
          break;

        case "ctrl+1":
          e.preventDefault();
          handlers.onToggleTab?.("prev");
          break;

        case "ctrl+2":
        case "ctrl+3":
        case "ctrl+4":
          e.preventDefault();
          handlers.onToggleTab?.("next");
          break;

        case "ctrl+/":
          e.preventDefault();
          showShortcutHelp();
          break;
      }
    },
    [handlers]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);
}

function showShortcutHelp(): void {
  // Create a temporary overlay showing all shortcuts
  const overlay = document.createElement("div");
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.8);
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  `;

  const content = document.createElement("div");
  content.style.cssText = `
    background: #111;
    border: 1px solid #333;
    border-radius: 12px;
    padding: 24px;
    max-width: 400px;
    width: 90%;
    color: #e5e5e5;
  `;

  content.innerHTML = `
    <h3 style="margin: 0 0 16px; font-size: 16px; color: white;">
      ⌨️ Keyboard Shortcuts
    </h3>
    <div style="display: grid; gap: 8px;">
      ${Object.entries(SHORTCUTS)
        .map(
          ([key, desc]) => `
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-size: 13px; color: #a3a3a3;">${desc}</span>
          <kbd style="
            background: #1f1f1f;
            border: 1px solid #333;
            border-radius: 4px;
            padding: 2px 8px;
            font-size: 11px;
            font-family: monospace;
            color: #d4d4d4;
          ">${key}</kbd>
        </div>
      `
        )
        .join("")}
    </div>
    <p style="margin: 16px 0 0; font-size: 11px; color: #525252; text-align: center;">
      Press Escape to close
    </p>
  `;

  overlay.appendChild(content);
  document.body.appendChild(overlay);

  // Close on click or Escape
  const close = () => {
    overlay.remove();
    window.removeEventListener("keydown", close);
  };

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
}

export { SHORTCUTS };
