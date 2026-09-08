import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray
} from "electron";
import fsp from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CodexDataService } from "./data-service.js";
import { ensureBackgroundSyncService } from "./background-sync-service.js";
import { formatTrayTitle } from "./tray-status.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
let mainWindow;
let widgetWindow;
let tray;
let dataService;
let screenshotCaptured = false;
let widgetScreenshotCaptured = false;
let isQuitting = false;
let trayRefreshTimer;
let powerCheckTimer;
let refreshIntervalMilliseconds;
let preferencesPath;
let preferences = {
  widgetVisible: true,
  widgetBounds: null
};
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const widgetAppGroup = "7BF3VF2M63.local.codexu.dashboard";
const backgroundSyncMode = process.argv.includes("--background-sync");
const installBackgroundSyncMode = process.argv.includes("--install-background-sync");

if (backgroundSyncMode) {
  // A snapshot refresh has no UI or graphics work. Avoid starting Chromium's GPU
  // path, and never let an unanswered macOS privacy prompt pin this process.
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-background-networking");
}

if (!hasSingleInstanceLock) {
  app.quit();
}

function createTrayImage() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36">
      <path fill="#000" d="M11.2 28.4h14.7c4.7 0 8.5-3.7 8.5-8.3 0-4.3-3.4-7.9-7.7-8.3C24.9 6 19.5 1.8 13.1 1.8 6 1.8.1 6.9-1.1 13.6c-4.5.7-8 4.5-8 9.2 0 5.1 4.2 9.3 9.4 9.3h10.9Z" transform="translate(8 2) scale(.74)"/>
      <path fill="none" stroke="#000" stroke-linecap="round" stroke-width="3.2" d="M12.5 22.4c3.8-5.2 7.7-5.5 12.4-1.9"/>
      <circle cx="11.2" cy="23" r="1.7" fill="#000"/>
      <circle cx="26.1" cy="20.9" r="1.7" fill="#000"/>
    </svg>`;
  const image = nativeImage
    .createFromDataURL(
      `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
    )
    .resize({ width: 18, height: 18 });
  image.setTemplateImage(true);
  return image;
}

function showWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function toggleWindow() {
  if (mainWindow?.isVisible()) {
    mainWindow.hide();
  } else {
    showWindow();
  }
}

async function isUsingExternalPower() {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/pmset",
      ["-g", "batt"],
      { timeout: 5_000 }
    );
    return stdout.includes("AC Power");
  } catch {
    // If macOS does not report a power source, favor the conservative cadence.
    return false;
  }
}

async function requestWidgetTimelineReload() {
  try {
    await execFileAsync(
      "/usr/bin/open",
      ["-g", "/Applications/codexU Widgets.app", "--args", "--refresh-widgets"],
      { timeout: 5_000 }
    );
  } catch {
    // The native host is optional; the widget keeps its own timeline if absent.
  }
}

async function configurePowerAwareRefresh() {
  const interval = (await isUsingExternalPower())
    ? 60_000
    : 15 * 60_000;
  if (refreshIntervalMilliseconds === interval) return;

  const powerModeChanged = refreshIntervalMilliseconds !== undefined;
  clearInterval(trayRefreshTimer);
  refreshIntervalMilliseconds = interval;
  trayRefreshTimer = setInterval(() => refreshTrayStatus(true), interval);
  if (powerModeChanged) void requestWidgetTimelineReload();
}

async function loadPreferences() {
  preferencesPath = path.join(app.getPath("userData"), "preferences.json");
  try {
    const saved = JSON.parse(await fsp.readFile(preferencesPath, "utf8"));
    preferences = {
      ...preferences,
      ...saved
    };
  } catch {
    // 首次启动或旧版本没有偏好文件时使用安全默认值。
  }
}

async function savePreferences() {
  if (!preferencesPath) return;
  try {
    await fsp.writeFile(
      preferencesPath,
      JSON.stringify(preferences, null, 2),
      "utf8"
    );
  } catch {
    // 偏好保存失败不应影响实时用量读取。
  }
}

function defaultWidgetBounds() {
  const width = 820;
  const height = 598;
  const { workArea } = screen.getPrimaryDisplay();
  return {
    width,
    height,
    x: Math.round(workArea.x + workArea.width - width - 24),
    y: Math.round(workArea.y + workArea.height - height - 24)
  };
}

function safeWidgetBounds() {
  const saved = preferences.widgetBounds;
  if (!saved) return defaultWidgetBounds();
  if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) {
    return defaultWidgetBounds();
  }
  const width = 820;
  const height = 598;
  const { workArea } = screen.getDisplayNearestPoint({
    x: saved.x,
    y: saved.y
  });
  return {
    width,
    height,
    x: Math.round(
      Math.max(
        workArea.x,
        Math.min(saved.x, workArea.x + workArea.width - width)
      )
    ),
    y: Math.round(
      Math.max(
        workArea.y,
        Math.min(saved.y, workArea.y + workArea.height - height)
      )
    )
  };
}

function setWidgetVisible(visible) {
  preferences.widgetVisible = Boolean(visible);
  if (visible) {
    if (!widgetWindow) createWidgetWindow();
    widgetWindow.showInactive();
  } else {
    widgetWindow?.hide();
  }
  savePreferences();
}

function toggleWidget() {
  setWidgetVisible(!widgetWindow?.isVisible());
}

function trayContextMenu() {
  return Menu.buildFromTemplate([
    {
      label: mainWindow?.isVisible() ? "隐藏 codexU" : "打开 codexU",
      click: toggleWindow
    },
    {
      label: "刷新余量",
      click: () => refreshTrayStatus(true)
    },
    {
      label: "桌面小组件",
      type: "checkbox",
      checked: Boolean(widgetWindow?.isVisible()),
      click: toggleWidget
    },
    { type: "separator" },
    {
      label: "退出 codexU",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
}

function createTray() {
  tray = new Tray(createTrayImage());
  tray.setTitle("余量 —");
  tray.setToolTip("codexU · 正在读取本机 Codex 余量");
  tray.on("click", toggleWindow);
  tray.on("right-click", () => tray.popUpContextMenu(trayContextMenu()));
}

function updateTrayStatus(result) {
  if (!tray) return;
  const title = formatTrayTitle(result?.quotas);
  tray.setTitle(title, { fontType: "monospacedDigit" });
  tray.setToolTip(`codexU · 剩余额度 ${title}`);
}

function widgetSnapshot(result) {
  const presentUsage = (usage) => ({
    input: Number(usage?.input || 0),
    cachedInput: Number(usage?.cachedInput || 0),
    freshInput: Number(usage?.freshInput || 0),
    output: Number(usage?.output || 0),
    total: Number(usage?.total || 0)
  });
  return {
    schemaVersion: 1,
    generatedAt: result.generatedAt,
    planType:
      result.quotas.find((quota) => quota.planType)?.planType?.toUpperCase() ||
      "LOCAL",
    quotas: result.quotas.map((quota) => ({
      windowMinutes: Number(quota.windowMinutes || 0),
      remainingPercent: Math.max(0, Math.min(100, Number(quota.remainingPercent || 0))),
      usedPercent: Math.max(0, Math.min(100, Number(quota.usedPercent || 0))),
      resetsAt: Number(quota.resetsAt || 0)
    })),
    windows: {
      today: presentUsage(result.windows.today),
      sevenDays: presentUsage(result.windows.sevenDays),
      total: presentUsage(result.windows.total)
    }
  };
}

async function writeWidgetSnapshot(result) {
  try {
    const container = path.join(
      app.getPath("home"),
      "Library",
      "Group Containers",
      widgetAppGroup
    );
    await fsp.mkdir(container, { recursive: true });
    const destination = path.join(container, "usage-snapshot.json");
    const temporary = path.join(container, "usage-snapshot.json.tmp");
    await fsp.writeFile(temporary, JSON.stringify(widgetSnapshot(result)), "utf8");
    await fsp.rename(temporary, destination);
  } catch {
    // 组件未安装或 App Group 尚未被系统创建时，不影响主看板。
  }
}

async function getDashboardData(force = false) {
  const result = await dataService.getDashboardData({ force });
  updateTrayStatus(result);
  await writeWidgetSnapshot(result);
  return result;
}

async function refreshTrayStatus(force = false) {
  try {
    await getDashboardData(force);
  } catch {
    if (tray) tray.setToolTip("codexU · 暂时无法读取本机余量");
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 960,
    minHeight: 700,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    vibrancy: "under-window",
    visualEffectState: "active",
    titleBarStyle: "hidden",
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, "..", "src", "index.html"));
  mainWindow.once("ready-to-show", () => {
    if (process.env.CODEXU_SCREENSHOT) mainWindow.show();
  });
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createWidgetWindow() {
  if (widgetWindow) return widgetWindow;
  const bounds = safeWidgetBounds();
  widgetWindow = new BrowserWindow({
    ...bounds,
    minWidth: 820,
    minHeight: 598,
    maxWidth: 820,
    maxHeight: 598,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    vibrancy: "under-window",
    visualEffectState: "active",
    resizable: false,
    movable: true,
    hasShadow: true,
    roundedCorners: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  widgetWindow.setAlwaysOnTop(true, "floating");
  widgetWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: false
  });
  widgetWindow.webContents.setZoomFactor(0.68);
  widgetWindow.loadFile(path.join(__dirname, "..", "src", "index.html"));
  widgetWindow.once("ready-to-show", () => {
    if (preferences.widgetVisible || process.env.CODEXU_WIDGET_SCREENSHOT) {
      widgetWindow.showInactive();
    }
  });
  widgetWindow.on("moved", () => {
    if (!widgetWindow) return;
    preferences.widgetBounds = widgetWindow.getBounds();
    savePreferences();
  });
  widgetWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    setWidgetVisible(false);
  });
  widgetWindow.on("closed", () => {
    widgetWindow = null;
  });
  return widgetWindow;
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  dataService = new CodexDataService(app.getPath("userData"));

  if (backgroundSyncMode) {
    // Invoked by launchd: update the aggregate-only snapshot, then quit.
    const timeout = setTimeout(() => app.exit(0), 45_000);
    try {
      await getDashboardData(true);
      await requestWidgetTimelineReload();
    } finally {
      clearTimeout(timeout);
      app.quit();
    }
    return;
  }

  if (installBackgroundSyncMode) {
    try {
      await ensureBackgroundSyncService({
        isPackaged: app.isPackaged,
        executablePath: process.execPath
      });
      await getDashboardData(true);
    } finally {
      app.quit();
    }
    return;
  }

  app.dock?.hide();
  await loadPreferences();
  await ensureBackgroundSyncService({
    isPackaged: app.isPackaged,
    executablePath: process.execPath
  });
  createTray();

  ipcMain.handle("dashboard:get", () => getDashboardData(false));
  ipcMain.handle("dashboard:refresh", () => getDashboardData(true));
  ipcMain.on("dashboard:rendered", async (event) => {
    const renderedWindow = BrowserWindow.fromWebContents(event.sender);
    const isWidgetRender = renderedWindow === widgetWindow;
    if (isWidgetRender) {
      const destination = process.env.CODEXU_WIDGET_SCREENSHOT;
      if (
        !destination ||
        widgetScreenshotCaptured ||
        !widgetWindow
      ) return;
      widgetScreenshotCaptured = true;
      const requestedTheme = process.env.CODEXU_WIDGET_SCREENSHOT_THEME;
      const requestedTab = process.env.CODEXU_WIDGET_SCREENSHOT_TAB;
      if (requestedTheme) {
        await widgetWindow.webContents.executeJavaScript(
          `document.documentElement.dataset.theme = ${JSON.stringify(requestedTheme)}`
        );
      }
      if (requestedTab) {
        const selector = `[data-tab="${requestedTab}"]`;
        await widgetWindow.webContents.executeJavaScript(
          `document.querySelector(${JSON.stringify(selector)})?.click()`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      const image = await widgetWindow.webContents.capturePage();
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.writeFile(destination, image.toPNG());
      app.quit();
      return;
    }

    const destination = process.env.CODEXU_SCREENSHOT;
    if (
      !destination ||
      screenshotCaptured ||
      !mainWindow ||
      renderedWindow !== mainWindow
    ) return;
    screenshotCaptured = true;
    const requestedTheme = process.env.CODEXU_SCREENSHOT_THEME;
    const requestedTab = process.env.CODEXU_SCREENSHOT_TAB;
    if (requestedTheme) {
      await mainWindow.webContents.executeJavaScript(
        `document.documentElement.dataset.theme = ${JSON.stringify(requestedTheme)}`
      );
    }
    if (requestedTab) {
      const selector = `[data-tab="${requestedTab}"]`;
      await mainWindow.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(selector)})?.click()`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    const image = await mainWindow.webContents.capturePage();
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, image.toPNG());
    app.quit();
  });
  ipcMain.handle("window:control", (event, action) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (!targetWindow) return null;
    if (action === "close") {
      if (targetWindow === widgetWindow) setWidgetVisible(false);
      else targetWindow.hide();
    }
    if (action === "minimize") targetWindow.minimize();
    if (action === "pin") {
      const next = !targetWindow.isAlwaysOnTop();
      targetWindow.setAlwaysOnTop(next, "floating");
      return next;
    }
    return null;
  });

  createWindow();
  createWidgetWindow();
  refreshTrayStatus();
  void configurePowerAwareRefresh();
  // This only checks a tiny system status. The actual Codex data refresh follows
  // the selected cadence above, so battery operation remains quiet.
  powerCheckTimer = setInterval(() => {
    void configurePowerAwareRefresh();
  }, 60_000);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  showWindow();
});

app.on("second-instance", (_event, commandLine) => {
  // launchd invokes the same app binary for a headless snapshot update. When
  // codexU is already open, Electron forwards that invocation here instead of
  // starting another process; it must not be mistaken for a user opening it.
  if (commandLine.includes("--background-sync")) {
    void refreshTrayStatus(true);
    return;
  }
  if (commandLine.includes("--install-background-sync")) return;
  showWindow();
});

app.on("before-quit", () => {
  isQuitting = true;
  clearInterval(trayRefreshTimer);
  clearInterval(powerCheckTimer);
});
