import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBackgroundSyncService } from "./background-sync-service.js";

const workerPath = fileURLToPath(import.meta.url);
const appExecutable = path.resolve(
  path.dirname(workerPath),
  "..",
  "..",
  "MacOS",
  "codexU"
);

const installed = await ensureBackgroundSyncService({
  isPackaged: true,
  executablePath: appExecutable
});

if (!installed) process.exitCode = 1;
