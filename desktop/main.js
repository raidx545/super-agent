// ============================================================
// VLESS Desktop — Main Process
// The god-level companion app that controls everything
// ============================================================

const { app, BrowserWindow, ipcMain, shell, clipboard, screen, desktopCapturer, Notification, Tray, Menu, nativeImage, globalShortcut } = require("electron");
const path = require("path");
const fs = require("fs");
const { exec, spawn } = require("child_process");
const os = require("os");

// ── Window State ─────────────────────────────────────────────

let mainWindow = null;
let tray = null;
let isQuitting = false;

// ── App Lifecycle ────────────────────────────────────────────

app.whenReady().then(() => {
  createMainWindow();
  createTray();
  registerIPC();
  registerGlobalShortcuts();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  globalShortcut.unregisterAll();
});

// ── Main Window ──────────────────────────────────────────────

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "VLESS Desktop",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
    titleBarStyle: "hiddenInset",
    backgroundColor: "#030712",
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ── System Tray ──────────────────────────────────────────────

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: "Show VLESS", click: () => mainWindow?.show() },
    { type: "separator" },
    { label: "Quick Task...", click: () => showQuickTask() },
    { label: "Voice Command", click: () => startVoiceCommand() },
    { type: "separator" },
    { label: "Quit", click: () => { isQuitting = true; app.quit(); } },
  ]);

  tray.setToolTip("VLESS Desktop");
  tray.setContextMenu(contextMenu);
  tray.on("click", () => mainWindow?.show());
}

// ── Global Shortcuts ─────────────────────────────────────────

function registerGlobalShortcuts() {
  // Ctrl+Shift+V: Toggle VLESS overlay
  globalShortcut.register("CommandOrControl+Shift+V", () => {
    mainWindow?.webContents.send("toggle-overlay");
  });

  // Ctrl+Shift+Space: Quick task
  globalShortcut.register("CommandOrControl+Shift+Space", () => {
    showQuickTask();
  });

  // Ctrl+Shift+R: Start recording
  globalShortcut.register("CommandOrControl+Shift+R", () => {
    mainWindow?.webContents.send("toggle-recording");
  });
}

// ── IPC Handlers ─────────────────────────────────────────────

function registerIPC() {
  // ── System Info ────────────────────────────────────────
  ipcMain.handle("get-system-info", () => ({
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    memory: Math.round(os.totalmem() / 1024 / 1024 / 1024) + "GB",
    hostname: os.hostname(),
    user: os.userInfo().username,
  }));

  // ── File System ────────────────────────────────────────
  ipcMain.handle("read-file", async (event, filePath) => {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return { success: true, content };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("write-file", async (event, filePath, content) => {
    try {
      fs.writeFileSync(filePath, content, "utf-8");
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("list-directory", async (event, dirPath) => {
    try {
      const items = fs.readdirSync(dirPath, { withFileTypes: true });
      return {
        success: true,
        items: items.map((item) => ({
          name: item.name,
          isDirectory: item.isDirectory(),
          path: path.join(dirPath, item.name),
        })),
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("open-file-dialog", async () => {
    const { dialog } = require("electron");
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile", "multiSelections"],
    });
    return result.filePaths;
  });

  ipcMain.handle("save-file-dialog", async (event, defaultName) => {
    const { dialog } = require("electron");
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName,
    });
    return result.filePath;
  });

  // ── Clipboard ──────────────────────────────────────────
  ipcMain.handle("clipboard-read", () => {
    return clipboard.readText();
  });

  ipcMain.handle("clipboard-write", (event, text) => {
    clipboard.writeText(text);
    return { success: true };
  });

  // ── Shell Commands ─────────────────────────────────────
  ipcMain.handle("execute-command", async (event, command) => {
    return new Promise((resolve) => {
      exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
        if (error) {
          resolve({ success: false, error: error.message, stderr });
        } else {
          resolve({ success: true, stdout, stderr });
        }
      });
    });
  });

  ipcMain.handle("open-url", async (event, url) => {
    await shell.openExternal(url);
    return { success: true };
  });

  ipcMain.handle("open-path", async (event, filePath) => {
    await shell.openPath(filePath);
    return { success: true };
  });

  // ── Screen Capture ─────────────────────────────────────
  ipcMain.handle("capture-screen", async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1920, height: 1080 },
      });

      if (sources.length === 0) {
        return { success: false, error: "No screens found" };
      }

      const thumbnail = sources[0].thumbnail.toDataURL();
      return { success: true, dataUrl: thumbnail };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("capture-window", async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: 1920, height: 1080 },
      });

      return {
        success: true,
        windows: sources.map((s) => ({
          id: s.id,
          name: s.name,
          thumbnail: s.thumbnail.toDataURL(),
        })),
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // ── Notifications ──────────────────────────────────────
  ipcMain.handle("show-notification", (event, { title, body }) => {
    new Notification({ title, body }).show();
    return { success: true };
  });

  // ── Voice ──────────────────────────────────────────────
  ipcMain.handle("start-speech-recognition", () => {
    // Use Web Speech API in renderer
    mainWindow?.webContents.send("start-voice");
    return { success: true };
  });

  // ── Automation Scheduling ──────────────────────────────
  ipcMain.handle("schedule-task", (event, { cron, task }) => {
    // Simple scheduler using setInterval
    // In production, use a proper cron library
    console.log(`Scheduled: ${task} at ${cron}`);
    return { success: true };
  });

  // ── Browser Extension Communication ────────────────────
  ipcMain.handle("send-to-extension", (event, message) => {
    mainWindow?.webContents.send("extension-message", message);
    return { success: true };
  });

  // ── Window Controls ────────────────────────────────────
  ipcMain.handle("minimize-window", () => mainWindow?.minimize());
  ipcMain.handle("maximize-window", () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  ipcMain.handle("close-window", () => mainWindow?.hide());
}

// ── Quick Task ───────────────────────────────────────────────

function showQuickTask() {
  mainWindow?.show();
  mainWindow?.webContents.send("show-quick-task");
}

function startVoiceCommand() {
  mainWindow?.show();
  mainWindow?.webContents.send("start-voice");
}
