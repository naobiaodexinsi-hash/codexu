import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CACHE_VERSION = 3;
const TOKEN_KEYS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens"
];

function emptyUsage() {
  return Object.fromEntries(TOKEN_KEYS.map((key) => [key, 0]));
}

function addUsage(target, source) {
  for (const key of TOKEN_KEYS) target[key] += Number(source?.[key] || 0);
  return target;
}

function deltaUsage(current, previous) {
  const result = emptyUsage();
  for (const key of TOKEN_KEYS) {
    const value = Number(current?.[key] || 0);
    const prior = Number(previous?.[key] || 0);
    result[key] = value >= prior ? value - prior : value;
  }
  return result;
}

function dayKey(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function recentDayKeys(count) {
  const result = [];
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const value = new Date(now);
    value.setDate(now.getDate() - offset);
    result.push(dayKey(value));
  }
  return result;
}

function safeBasename(value) {
  if (!value) return "未知项目";
  return path.basename(value) || value;
}

function outputLength(output) {
  if (typeof output === "string") return output.length;
  try {
    return JSON.stringify(output ?? "").length;
  } catch {
    return 0;
  }
}

function findSkillPaths(text) {
  if (!text || typeof text !== "string") return [];
  const matches = text.match(/\/Users\/[^"'`\s]+\/SKILL\.md/g) || [];
  return [...new Set(matches.filter((value) => !/[{}*]/.test(value)))];
}

async function listJsonlFiles(root) {
  const files = [];
  async function walk(folder) {
    let entries;
    try {
      entries = await fsp.readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
    }
  }
  await walk(root);
  return files;
}

async function sqliteJson(databasePath, sql) {
  try {
    const { stdout } = await execFileAsync("/usr/bin/sqlite3", [
      "-json",
      databasePath,
      sql
    ], { maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim() ? JSON.parse(stdout) : [];
  } catch {
    return [];
  }
}

export class CodexDataService {
  constructor(userDataPath) {
    this.codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    this.userDataPath = userDataPath;
    this.cachePath = path.join(userDataPath, "usage-cache.json");
    this.inFlight = null;
    this.lastResult = null;
  }

  async getDashboardData({ force = false } = {}) {
    if (this.inFlight) return this.inFlight;
    if (!force && this.lastResult && Date.now() - this.lastResult.generatedAtMs < 15000) {
      return this.lastResult;
    }
    this.inFlight = this.#collect(force).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async #loadCache() {
    try {
      const cache = JSON.parse(await fsp.readFile(this.cachePath, "utf8"));
      if (cache.version === CACHE_VERSION && cache.files) return cache;
    } catch {
      // A missing or stale cache is expected on first launch.
    }
    return { version: CACHE_VERSION, files: {} };
  }

  async #saveCache(cache) {
    await fsp.mkdir(this.userDataPath, { recursive: true });
    const temporary = `${this.cachePath}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(cache), "utf8");
    await fsp.rename(temporary, this.cachePath);
  }

  async #collect(force) {
    const [sessionFiles, archivedFiles, threads] = await Promise.all([
      listJsonlFiles(path.join(this.codexHome, "sessions")),
      listJsonlFiles(path.join(this.codexHome, "archived_sessions")),
      sqliteJson(
        path.join(this.codexHome, "state_5.sqlite"),
        `SELECT id, cwd, created_at, updated_at, tokens_used, archived,
                COALESCE(model, '') AS model,
                COALESCE(reasoning_effort, '') AS reasoning_effort,
                COALESCE(source, '') AS source
         FROM threads`
      )
    ]);

    const cache = await this.#loadCache();
    const allPaths = [...sessionFiles, ...archivedFiles];
    const currentPaths = new Set(allPaths);
    for (const cachedPath of Object.keys(cache.files)) {
      if (!currentPaths.has(cachedPath)) delete cache.files[cachedPath];
    }

    let reparsedFiles = 0;
    for (const filePath of allPaths) {
      let stat;
      try {
        stat = await fsp.stat(filePath);
      } catch {
        continue;
      }
      const cached = cache.files[filePath];
      if (
        !cached ||
        cached.size !== stat.size ||
        Math.abs(cached.mtimeMs - stat.mtimeMs) > 1
      ) {
        cache.files[filePath] = {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          summary: await this.#parseSession(filePath)
        };
        reparsedFiles += 1;
      }
    }
    await this.#saveCache(cache);

    const bySession = new Map();
    for (const [filePath, cached] of Object.entries(cache.files)) {
      const summary = cached.summary;
      if (!summary?.sessionId) continue;
      const previous = bySession.get(summary.sessionId);
      if (!previous || cached.mtimeMs > previous.mtimeMs || cached.size > previous.size) {
        bySession.set(summary.sessionId, {
          ...cached,
          filePath
        });
      }
    }

    const summaries = [...bySession.values()].map((entry) => entry.summary);
    const dailyMap = {};
    const totals = emptyUsage();
    const tools = {};
    const skills = {};
    const ratesByWindow = {};
    let parseErrors = 0;
    let userMessages = 0;

    for (const summary of summaries) {
      parseErrors += summary.parseErrors || 0;
      userMessages += summary.userMessages || 0;
      addUsage(totals, summary.totals);

      for (const [day, usage] of Object.entries(summary.daily || {})) {
        dailyMap[day] ||= { ...emptyUsage(), userMessages: 0 };
        addUsage(dailyMap[day], usage);
        dailyMap[day].userMessages += usage.userMessages || 0;
      }

      for (const [name, stat] of Object.entries(summary.tools || {})) {
        tools[name] ||= { name, count: 0, outputChars: 0 };
        tools[name].count += stat.count || 0;
        tools[name].outputChars += stat.outputChars || 0;
      }

      for (const [name, stat] of Object.entries(summary.skills || {})) {
        skills[name] ||= { name, count: 0, instructionChars: 0 };
        skills[name].count += stat.count || 0;
        skills[name].instructionChars += stat.instructionChars || 0;
      }

      for (const [window, rate] of Object.entries(summary.ratesByWindow || {})) {
        if (!ratesByWindow[window] || rate.timestamp > ratesByWindow[window].timestamp) {
          ratesByWindow[window] = rate;
        }
      }
    }

    const todayKey = recentDayKeys(1)[0];
    const sevenDayKeys = new Set(recentDayKeys(7));
    const today = dailyMap[todayKey] || emptyUsage();
    const sevenDays = emptyUsage();
    for (const key of sevenDayKeys) addUsage(sevenDays, dailyMap[key]);

    const heatmap = recentDayKeys(182).map((date) => ({
      date,
      tokens: Number(dailyMap[date]?.total_tokens || 0),
      turns: Number(dailyMap[date]?.userMessages || 0)
    }));
    const trend = recentDayKeys(14).map((date) => ({
      date,
      tokens: Number(dailyMap[date]?.total_tokens || 0),
      freshInput: Math.max(
        Number(dailyMap[date]?.input_tokens || 0) -
          Number(dailyMap[date]?.cached_input_tokens || 0),
        0
      ),
      cachedInput: Number(dailyMap[date]?.cached_input_tokens || 0),
      output: Number(dailyMap[date]?.output_tokens || 0),
      turns: Number(dailyMap[date]?.userMessages || 0)
    }));

    const projectMap = {};
    for (const thread of threads) {
      const cwd = thread.cwd || "未知项目";
      projectMap[cwd] ||= {
        path: cwd,
        name: safeBasename(cwd),
        tokens: 0,
        threads: 0,
        latestAt: 0
      };
      projectMap[cwd].tokens += Number(thread.tokens_used || 0);
      projectMap[cwd].threads += 1;
      projectMap[cwd].latestAt = Math.max(
        projectMap[cwd].latestAt,
        Number(thread.updated_at || 0) * 1000
      );
    }

    const recentTasks = [...threads]
      .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0))
      .slice(0, 12)
      .map((thread) => ({
        id: String(thread.id || "").slice(0, 8),
        project: safeBasename(thread.cwd),
        path: thread.cwd,
        model: thread.model || "未知模型",
        reasoning: thread.reasoning_effort || "",
        tokens: Number(thread.tokens_used || 0),
        updatedAt: Number(thread.updated_at || 0) * 1000
      }));

    const modelMap = {};
    for (const thread of threads) {
      const model = thread.model || "未知模型";
      modelMap[model] ||= { model, threads: 0, tokens: 0 };
      modelMap[model].threads += 1;
      modelMap[model].tokens += Number(thread.tokens_used || 0);
    }

    const currentTime = Date.now();
    const quotaRows = Object.values(ratesByWindow);
    const latestQuotaPlan = quotaRows
      .slice()
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .find((rate) => rate.planType)?.planType;

    const result = {
      generatedAt: new Date().toISOString(),
      generatedAtMs: Date.now(),
      source: {
        codexHome: this.codexHome,
        privacy: "仅汇总元数据、token 与工具事件；不保存聊天正文",
        sessionCount: summaries.length,
        threadCount: threads.length,
        projectCount: Object.keys(projectMap).length,
        activeDays: Object.values(dailyMap).filter((value) => value.total_tokens > 0).length,
        parseErrors,
        reparsedFiles
      },
      windows: {
        today: this.#presentUsage(today),
        sevenDays: this.#presentUsage(sevenDays),
        total: this.#presentUsage(totals)
      },
      quotas: quotaRows
        .filter((rate) => {
          const observedAt = new Date(rate.timestamp).getTime();
          const resetAt = Number(rate.resetsAt || 0) * 1000;
          const windowAge = Number(rate.windowMinutes || 0) * 60 * 1000;
          const planMatches =
            !latestQuotaPlan || !rate.planType || rate.planType === latestQuotaPlan;
          return (
            planMatches &&
            observedAt >= currentTime - windowAge &&
            (!resetAt || resetAt >= currentTime - 60_000)
          );
        })
        .sort((a, b) => Number(a.windowMinutes) - Number(b.windowMinutes))
        .map((rate) => ({
          windowMinutes: Number(rate.windowMinutes),
          usedPercent: Number(rate.usedPercent || 0),
          remainingPercent: Math.max(0, 100 - Number(rate.usedPercent || 0)),
          resetsAt: Number(rate.resetsAt || 0) * 1000,
          planType: rate.planType || ""
        })),
      heatmap,
      trend,
      projects: Object.values(projectMap)
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 20),
      tools: Object.values(tools)
        .map((tool) => ({
          ...tool,
          outputTokensEstimate: Math.round(tool.outputChars / 4)
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20),
      skills: Object.values(skills)
        .map((skill) => ({
          ...skill,
          instructionTokensEstimate: Math.round(skill.instructionChars / 4)
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20),
      recentTasks,
      models: Object.values(modelMap).sort((a, b) => b.tokens - a.tokens),
      userMessages
    };

    this.lastResult = result;
    return result;
  }

  #presentUsage(usage) {
    const input = Number(usage?.input_tokens || 0);
    const cached = Number(usage?.cached_input_tokens || 0);
    return {
      total: Number(usage?.total_tokens || 0),
      input,
      cachedInput: cached,
      freshInput: Math.max(input - cached, 0),
      output: Number(usage?.output_tokens || 0),
      reasoningOutput: Number(usage?.reasoning_output_tokens || 0)
    };
  }

  async #skillIdentity(skillPath) {
    let content = "";
    try {
      content = await fsp.readFile(skillPath, "utf8");
    } catch {
      return null;
    }
    const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/);
    const nameMatch = frontmatter?.[1]?.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m);
    return {
      name: nameMatch?.[1]?.trim() || path.basename(path.dirname(skillPath)),
      instructionChars: content.length
    };
  }

  async #parseSession(filePath) {
    const summary = {
      sessionId: null,
      cwd: null,
      model: null,
      totals: emptyUsage(),
      daily: {},
      tools: {},
      skills: {},
      ratesByWindow: {},
      userMessages: 0,
      parseErrors: 0
    };
    const calls = new Map();
    const skillCache = new Map();
    let previousTotal = emptyUsage();

    const input = fs.createReadStream(filePath, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });

    for await (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        summary.parseErrors += 1;
        continue;
      }

      if (event.type === "session_meta") {
        summary.sessionId = event.payload?.id || event.payload?.session_id || summary.sessionId;
        summary.cwd = event.payload?.cwd || summary.cwd;
      }

      if (event.type === "turn_context") {
        summary.model = event.payload?.model || summary.model;
      }

      if (event.type === "event_msg" && event.payload?.type === "user_message") {
        summary.userMessages += 1;
        const date = dayKey(event.timestamp);
        if (date) {
          summary.daily[date] ||= { ...emptyUsage(), userMessages: 0 };
          summary.daily[date].userMessages += 1;
        }
      }

      if (event.type === "event_msg" && event.payload?.type === "token_count") {
        const total = event.payload?.info?.total_token_usage;
        if (total) {
          const delta = deltaUsage(total, previousTotal);
          addUsage(summary.totals, delta);
          const date = dayKey(event.timestamp);
          if (date) {
            summary.daily[date] ||= { ...emptyUsage(), userMessages: 0 };
            addUsage(summary.daily[date], delta);
          }
          previousTotal = Object.fromEntries(
            TOKEN_KEYS.map((key) => [key, Number(total[key] || 0)])
          );
        }

        const limits = event.payload?.rate_limits;
        for (const limit of [limits?.primary, limits?.secondary]) {
          const window = Number(limit?.window_minutes || 0);
          if (!window) continue;
          summary.ratesByWindow[String(window)] = {
            timestamp: event.timestamp,
            windowMinutes: window,
            usedPercent: Number(limit.used_percent || 0),
            resetsAt: Number(limit.resets_at || 0),
            planType: limits?.plan_type || ""
          };
        }
      }

      const payload = event.payload || {};
      const isCall =
        event.type === "response_item" &&
        (payload.type === "function_call" || payload.type === "custom_tool_call");
      if (isCall) {
        const name = payload.name || "unknown_tool";
        const callId = payload.call_id || payload.id;
        if (callId) calls.set(callId, name);
        summary.tools[name] ||= { count: 0, outputChars: 0 };
        summary.tools[name].count += 1;

        const rawInput =
          typeof payload.arguments === "string"
            ? payload.arguments
            : typeof payload.input === "string"
              ? payload.input
              : JSON.stringify(payload.arguments ?? payload.input ?? "");
        for (const skillPath of findSkillPaths(rawInput)) {
          let identity = skillCache.get(skillPath);
          if (identity === undefined) {
            identity = await this.#skillIdentity(skillPath);
            skillCache.set(skillPath, identity);
          }
          if (!identity) continue;
          summary.skills[identity.name] ||= {
            count: 0,
            instructionChars: 0
          };
          summary.skills[identity.name].count += 1;
          summary.skills[identity.name].instructionChars += identity.instructionChars;
        }
      }

      const isOutput =
        event.type === "response_item" &&
        (payload.type === "function_call_output" ||
          payload.type === "custom_tool_call_output");
      if (isOutput) {
        const name = calls.get(payload.call_id);
        if (name && summary.tools[name]) {
          summary.tools[name].outputChars += outputLength(payload.output);
        }
      }
    }

    summary.sessionId ||= path.basename(filePath, ".jsonl");
    return summary;
  }
}
