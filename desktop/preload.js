// ============================================================
// VLESS Desktop — Preload Script
// Secure bridge between main process and renderer (contextIsolation)
// ============================================================

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vless", {
  // ── System ──────────────────────────────────────────────
  getSystemInfo: () => ipcRenderer.invoke("get-system-info"),

  // ── File System ─────────────────────────────────────────
  readFile: (path) => ipcRenderer.invoke("read-file", path),
  writeFile: (path, content) => ipcRenderer.invoke("write-file", path, content),
  listDirectory: (path) => ipcRenderer.invoke("list-directory", path),
  openFileDialog: () => ipcRenderer.invoke("open-file-dialog"),
  saveFileDialog: (defaultName) => ipcRenderer.invoke("save-file-dialog", defaultName),

  // ── Clipboard ───────────────────────────────────────────
  clipboardRead: () => ipcRenderer.invoke("clipboard-read"),
  clipboardWrite: (text) => ipcRenderer.invoke("clipboard-write", text),

  // ── Shell ───────────────────────────────────────────────
  executeCommand: (cmd) => ipcRenderer.invoke("execute-command", cmd),
  openUrl: (url) => ipcRenderer.invoke("open-url", url),
  openPath: (path) => ipcRenderer.invoke("open-path", path),

  // ── Screen ──────────────────────────────────────────────
  captureScreen: () => ipcRenderer.invoke("capture-screen"),
  captureWindow: () => ipcRenderer.invoke("capture-window"),

  // ── Notifications ───────────────────────────────────────
  showNotification: (opts) => ipcRenderer.invoke("show-notification", opts),

  // ── Voice ───────────────────────────────────────────────
  startVoice: () => ipcRenderer.invoke("start-speech-recognition"),

  // ── Scheduling ──────────────────────────────────────────
  scheduleTask: (opts) => ipcRenderer.invoke("schedule-task", opts),

  // ── Extension Communication ─────────────────────────────
  sendToExtension: (msg) => ipcRenderer.invoke("send-to-extension", msg),

  // ── Window Controls ─────────────────────────────────────
  minimize: () => ipcRenderer.invoke("minimize-window"),
  maximize: () => ipcRenderer.invoke("maximize-window"),
  close: () => ipcRenderer.invoke("close-window"),

  // ── Event Listeners ─────────────────────────────────────
  on: (channel, callback) => {
    const validChannels = [
      "toggle-overlay",
      "show-quick-task",
      "start-voice",
      "toggle-recording",
      "extension-message",
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => callback(...args));
    }
  },

  off: (channel, callback) => {
    ipcRenderer.removeListener(channel, callback);
  },
});
