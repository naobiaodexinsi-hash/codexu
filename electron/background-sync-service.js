import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const label = "local.codexu.widget-sync";
const powerCheckIntervalSeconds = 60;

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function launchAgentContents(executable, launcherPath, logPath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>${xml(launcherPath)}</string>
    <string>${xml(executable)}</string>
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>StartInterval</key>
  <integer>${powerCheckIntervalSeconds}</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

/** Installs a per-user, no-window updater for the WidgetKit extension. */
export async function ensureBackgroundSyncService({ isPackaged, executablePath }) {
  if (!isPackaged || !executablePath) return false;

  const agentDirectory = path.join(os.homedir(), "Library", "LaunchAgents");
  const logDirectory = path.join(os.homedir(), "Library", "Logs");
  const agentPath = path.join(agentDirectory, `${label}.plist`);
  const temporaryPath = `${agentPath}.tmp`;
  const launcherPath = path.join(
    process.resourcesPath,
    "codexu-background",
    "power-aware-launcher.zsh"
  );
  const uid = String(process.getuid?.() ?? "");
  if (!uid) return false;

  try {
    await fsp.access(launcherPath);
    await fsp.mkdir(agentDirectory, { recursive: true });
    await fsp.mkdir(logDirectory, { recursive: true });
    await fsp.writeFile(
      temporaryPath,
      launchAgentContents(
        executablePath,
        launcherPath,
        path.join(logDirectory, "codexu-widget-sync.log")
      ),
      "utf8"
    );
    await fsp.rename(temporaryPath, agentPath);

    // Re-registering makes upgrades use the newly installed app executable.
    await execFileAsync("/bin/launchctl", ["bootout", `gui/${uid}`, agentPath]).catch(() => {});
    await execFileAsync("/bin/launchctl", ["bootstrap", `gui/${uid}`, agentPath]);
    return true;
  } catch {
    return false;
  }
}
