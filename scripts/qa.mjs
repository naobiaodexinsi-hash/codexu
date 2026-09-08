import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexDataService } from "../electron/data-service.js";
import { formatTrayTitle } from "../electron/tray-status.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const service = new CodexDataService(path.join(__dirname, "..", ".qa-cache"));
const data = await service.getDashboardData();

assert.equal(data.source.parseErrors, 0, "会话日志不应出现无法解析的行");
assert.ok(data.source.threadCount > 0, "应读取到至少一个 Codex 任务");
assert.ok(data.source.projectCount > 0, "应读取到至少一个项目");
assert.equal(data.trend.length, 14, "趋势必须包含 14 个自然日");
assert.equal(data.heatmap.length, 182, "热力图必须包含 182 个自然日");
assert.ok(
  data.windows.total.total >= data.windows.sevenDays.total,
  "累计 token 不应小于近 7 天"
);
assert.ok(
  data.windows.sevenDays.total >= data.windows.today.total,
  "近 7 天 token 不应小于今日"
);

for (const [name, usage] of Object.entries(data.windows)) {
  assert.ok(usage.cachedInput <= usage.input, `${name} 缓存输入不能超过总输入`);
  assert.ok(
    Math.abs(usage.total - (usage.input + usage.output)) <= 2,
    `${name} 总 token 应与输入加输出对账`
  );
}

for (const quota of data.quotas) {
  assert.ok(quota.remainingPercent >= 0 && quota.remainingPercent <= 100);
  assert.ok(!quota.resetsAt || quota.resetsAt >= Date.now() - 60_000);
}

assert.equal(
  formatTrayTitle([
    { windowMinutes: 300, remainingPercent: 87.4 },
    { windowMinutes: 10080, remainingPercent: 92.6 }
  ]),
  "5h 87% · 7d 93%",
  "状态栏应同时显示 5 小时和 7 天余量"
);
assert.equal(
  formatTrayTitle([{ windowMinutes: 10080, remainingPercent: 92.6 }]),
  "7d 93%",
  "缺少 5 小时窗口时仍应显示 7 天余量"
);
assert.equal(formatTrayTitle([]), "余量 —", "无有效限额时应显示安全占位");

const serialized = JSON.stringify(data);
for (const forbiddenKey of ['"message":', '"content":', '"prompt":', '"preview":']) {
  assert.equal(
    serialized.includes(forbiddenKey),
    false,
    `公开给界面的结果不得包含聊天正文字段 ${forbiddenKey}`
  );
}

console.log(
  `QA PASS · ${data.source.threadCount} 任务 · ${data.source.projectCount} 项目 · ` +
    `${data.source.sessionCount} 会话 · ${data.tools.length} 种工具`
);
