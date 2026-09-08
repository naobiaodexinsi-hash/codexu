import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CodexDataService } from "./data-service.js";

// Match the macOS team-scoped App Group used by the WidgetKit extension.
const appGroup = "7BF3VF2M63.local.codexu.dashboard";

function presentUsage(usage) {
  return {
    input: Number(usage?.input || 0),
    cachedInput: Number(usage?.cachedInput || 0),
    freshInput: Number(usage?.freshInput || 0),
    output: Number(usage?.output || 0),
    total: Number(usage?.total || 0)
  };
}

function widgetSnapshot(result) {
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

async function writeSnapshot(result) {
  const container = path.join(
    os.homedir(),
    "Library",
    "Group Containers",
    appGroup
  );
  await fsp.mkdir(container, { recursive: true });
  const destination = path.join(container, "usage-snapshot.json");
  const temporary = `${destination}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(widgetSnapshot(result)), "utf8");
  await fsp.rename(temporary, destination);
}

async function requestWidgetReload() {
  const host = "/Applications/codexU Widgets.app";
  try {
    await fsp.access(host);
    const launcher = spawn("/usr/bin/open", ["-g", host, "--args", "--refresh-widgets"], {
      detached: true,
      stdio: "ignore"
    });
    launcher.unref();
  } catch {
    // The WidgetKit host may not be installed yet. Its next timeline still
    // reads the saved aggregate snapshot without exposing conversation data.
  }
}

const userDataPath = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "codexu-local"
);

try {
  const service = new CodexDataService(userDataPath);
  await writeSnapshot(await service.getDashboardData({ force: true }));
  await requestWidgetReload();
} catch (error) {
  // launchd retries on the next interval; no conversation data is logged.
  process.exitCode = 1;
}
