const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { processSubtitleDocx } = require("./core/rearranger");
const { checkForAppUpdate } = require("./core/updateCheck");

const DEFAULT_APP_SETTINGS = {
  mode: "offline",
  aiProvider: "gemini",
  outputSuffix: "_rearranged_byApp",
  geminiModel: "gemini-2.5-flash-lite",
  openaiModel: "gpt-5.2",
  geminiApiKey: "",
  openaiApiKey: "",
  writeReport: false
};

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function getAppRootDir() {
  if (app.isPackaged) {
    return path.dirname(process.execPath);
  }

  return path.resolve(__dirname, "..");
}

function getRuntimeRootDir() {
  if (app.isPackaged) {
    const localAppData =
      process.env.LOCALAPPDATA ||
      path.join(app.getPath("appData"), "..", "Local");
    return path.join(localAppData, "SMTV Translation Editor");
  }

  return path.join(getAppRootDir(), ".runtime");
}

function latestModifiedTime(targetPath) {
  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }

  let latest = stat.mtimeMs;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    latest = Math.max(latest, latestModifiedTime(path.join(targetPath, entry.name)));
  }
  return latest;
}

function configureAppStorage() {
  const runtimeRoot = ensureDirectory(getRuntimeRootDir());
  const userDataPath = ensureDirectory(path.join(runtimeRoot, "user-data"));
  const sessionDataPath = ensureDirectory(path.join(runtimeRoot, "session-data"));
  const cachePath = ensureDirectory(path.join(runtimeRoot, "cache"));
  const gpuCachePath = ensureDirectory(path.join(cachePath, "gpu"));

  app.setPath("userData", userDataPath);

  try {
    app.setPath("sessionData", sessionDataPath);
  } catch (_error) {
    // Older Electron builds may not expose sessionData; userData remains the safe fallback.
  }

  app.commandLine.appendSwitch("disk-cache-dir", cachePath);
  app.commandLine.appendSwitch("gpu-disk-cache-dir", gpuCachePath);
  app.commandLine.appendSwitch("disable-http-cache");
  app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
  app.commandLine.appendSwitch("media-cache-size", "0");
  app.commandLine.appendSwitch("disk-cache-size", "0");
}

configureAppStorage();
app.disableHardwareAcceleration();

function getSettingsPath() {
  return path.join(app.getPath("userData"), "app-settings.json");
}

function normalizeSettings(input = {}) {
  const normalizedMode = input.mode === "ai" || input.mode === "gemini" ? "ai" : DEFAULT_APP_SETTINGS.mode;
  const normalizedProvider = input.aiProvider === "openai" ? "openai" : DEFAULT_APP_SETTINGS.aiProvider;
  return {
    mode: normalizedMode,
    aiProvider: normalizedProvider,
    outputSuffix:
      typeof input.outputSuffix === "string" && input.outputSuffix.trim()
        ? input.outputSuffix.trim()
        : DEFAULT_APP_SETTINGS.outputSuffix,
    geminiModel:
      typeof input.geminiModel === "string" && input.geminiModel.trim()
        ? input.geminiModel.trim()
        : DEFAULT_APP_SETTINGS.geminiModel,
    geminiApiKey:
      typeof input.geminiApiKey === "string" ? input.geminiApiKey.trim() : DEFAULT_APP_SETTINGS.geminiApiKey,
    openaiModel:
      typeof input.openaiModel === "string" && input.openaiModel.trim()
        ? input.openaiModel.trim()
        : DEFAULT_APP_SETTINGS.openaiModel,
    openaiApiKey:
      typeof input.openaiApiKey === "string" ? input.openaiApiKey.trim() : DEFAULT_APP_SETTINGS.openaiApiKey,
    writeReport: Boolean(input.writeReport)
  };
}

function loadAppSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getSettingsPath(), "utf8"));
    return normalizeSettings(parsed);
  } catch (_error) {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

function saveAppSettings(nextSettings = {}) {
  const merged = normalizeSettings({
    ...loadAppSettings(),
    ...nextSettings
  });
  fs.writeFileSync(getSettingsPath(), JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 920,
    minHeight: 720,
    backgroundColor: "#f2eadf",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  window.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("pick-input-file", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "Word Documents", extensions: ["docx"] }]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle("run-rearrangement", async (_event, payload) => {
  return processSubtitleDocx(payload.inputPath, payload.options);
});

ipcMain.handle("get-app-settings", async () => {
  return loadAppSettings();
});

ipcMain.handle("save-app-settings", async (_event, settings) => {
  return saveAppSettings(settings);
});

ipcMain.handle("get-app-meta", async () => {
  const rootDir = getAppRootDir();
  const packageJsonPath = path.join(rootDir, "package.json");
  let buildStamp = null;

  try {
    if (app.isPackaged) {
      // In packaged builds, use the executable timestamp. app.asar can report
      // misleading values in some environments and appear to "change" on launch.
      buildStamp = new Date(fs.statSync(process.execPath).mtimeMs).toISOString();
    } else {
      const latestSourceMtime = Math.max(
        latestModifiedTime(packageJsonPath),
        latestModifiedTime(path.join(rootDir, "src"))
      );
      buildStamp = new Date(latestSourceMtime).toISOString();
    }
  } catch (_error) {
    buildStamp = null;
  }

  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron || null,
    chromeVersion: process.versions.chrome || null,
    buildStamp
  };
});

ipcMain.handle("check-for-app-update", async () => {
  return checkForAppUpdate(app.getVersion());
});
