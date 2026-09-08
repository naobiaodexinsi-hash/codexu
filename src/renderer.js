const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const loadingState = $("#loadingState");
const dashboard = $("#dashboard");
const errorState = $("#errorState");
const overview = $("#overview");
const tabContent = $("#tabContent");
const freshness = $("#freshness");
const sourceNote = $("#sourceNote");
const coverageLabel = $("#coverageLabel");
const planBadge = $("#planBadge");
const refreshButton = $("#refreshButton");

let data = null;
let activeTab = "trend";
let autoRefreshTimer = null;

function formatTokens(value, digits = 1) {
  const number = Number(value || 0);
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(digits)}B`;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(digits)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(digits)}K`;
  return Math.round(number).toLocaleString("zh-CN");
}

function formatCount(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function formatDateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatWindow(minutes) {
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "7d";
  if (minutes === 43200) return "30d";
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}d`;
  return `${Math.round(minutes / 60)}h`;
}

function quotaFor(minutes) {
  return data.quotas.find((quota) => quota.windowMinutes === minutes);
}

function ringCircle(radius, quota, className) {
  const circumference = 2 * Math.PI * radius;
  const remaining = Math.max(0, Math.min(100, quota?.remainingPercent ?? 0));
  const offset = circumference * (1 - remaining / 100);
  return `
    <circle class="quota-track" cx="88" cy="88" r="${radius}"></circle>
    <circle
      class="quota-progress ${className}"
      cx="88"
      cy="88"
      r="${radius}"
      stroke-dasharray="${circumference}"
      stroke-dashoffset="${offset}"
    ></circle>
  `;
}

function metricCard(title, icon, usage, note) {
  const denominator = Math.max(
    usage.freshInput + usage.cachedInput + usage.output,
    1
  );
  const freshWidth = (usage.freshInput / denominator) * 100;
  const cachedWidth = (usage.cachedInput / denominator) * 100;
  const outputWidth = (usage.output / denominator) * 100;
  return `
    <article class="metric-card">
      <div class="metric-header">
        <div class="metric-title"><span>${icon}</span>${title}</div>
        <div class="metric-note">${note}</div>
      </div>
      <div class="metric-value">${formatTokens(usage.total)}</div>
      <div class="metric-bar" aria-label="Token 构成">
        <span class="fresh-segment" style="width:${freshWidth}%"></span>
        <span class="cached-segment" style="width:${cachedWidth}%"></span>
        <span class="output-segment" style="width:${outputWidth}%"></span>
      </div>
      <div class="metric-legend">
        <div><i class="fresh-segment"></i><span>未缓存输入</span><strong>${formatTokens(usage.freshInput)}</strong></div>
        <div><i class="cached-segment"></i><span>缓存输入</span><strong>${formatTokens(usage.cachedInput)}</strong></div>
        <div><i class="output-segment"></i><span>输出</span><strong>${formatTokens(usage.output)}</strong></div>
      </div>
    </article>
  `;
}

function renderOverview() {
  const fiveHour = quotaFor(300);
  const sevenDay = quotaFor(10080);
  const primaryQuota = fiveHour || sevenDay;
  const plan =
    data.quotas.find((quota) => quota.planType)?.planType?.toUpperCase() || "LOCAL";
  planBadge.textContent = plan;

  overview.innerHTML = `
    <article class="quota-panel">
      <div class="quota-ring">
        <svg viewBox="0 0 176 176" aria-label="额度剩余">
          ${ringCircle(67, fiveHour, "five-hour")}
          ${ringCircle(48, sevenDay, "seven-day")}
        </svg>
        <div class="quota-center">
          <div class="quota-value"><span>5h</span>${fiveHour ? Math.round(fiveHour.remainingPercent) : "—"}%</div>
          <div class="quota-value"><span>7d</span>${sevenDay ? Math.round(sevenDay.remainingPercent) : "—"}%</div>
          <div class="quota-caption">剩余额度</div>
        </div>
      </div>
      <div class="quota-legend">
        <div class="legend-row">
          <i style="background:var(--blue)"></i><span>5h 重置</span>
          <strong>${fiveHour ? formatDateTime(fiveHour.resetsAt) : "暂无"}</strong>
        </div>
        <div class="legend-row">
          <i style="background:var(--purple-light)"></i><span>7d 重置</span>
          <strong>${sevenDay ? formatDateTime(sevenDay.resetsAt) : "暂无"}</strong>
        </div>
      </div>
    </article>
    ${metricCard("今日", "☀", data.windows.today, "本地日界线")}
    ${metricCard("近 7 天", "▣", data.windows.sevenDays, "滚动窗口")}
    ${metricCard("累计", "Σ", data.windows.total, `${data.source.sessionCount} 个任务`)}
    <article class="status-strip">
      <div class="status-header">
        <div class="status-title"><span>◎</span>本地记录覆盖</div>
        <div class="status-main">${formatCount(data.source.threadCount)}<small>任务</small> · ${formatCount(data.source.projectCount)}<small>项目</small></div>
      </div>
      <div class="coverage-bar"><span></span></div>
      <div class="coverage-labels">
        <span>${data.source.privacy}</span>
        <span>${data.source.activeDays} 个活跃日${primaryQuota ? ` · 当前 ${formatWindow(primaryQuota.windowMinutes)} 已用 ${Math.round(primaryQuota.usedPercent)}%` : ""}</span>
      </div>
    </article>
  `;
}

function heatLevel(value, thresholds) {
  if (!value) return 0;
  if (value <= thresholds[0]) return 1;
  if (value <= thresholds[1]) return 2;
  if (value <= thresholds[2]) return 3;
  return 4;
}

function renderHeatmap() {
  const nonZero = data.heatmap
    .map((row) => row.tokens)
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  const quantile = (fraction) =>
    nonZero[Math.min(nonZero.length - 1, Math.floor(nonZero.length * fraction))] || 1;
  const thresholds = [quantile(0.25), quantile(0.5), quantile(0.75)];
  const cells = data.heatmap
    .map(
      (row) => `
        <div
          class="heat-cell"
          data-level="${heatLevel(row.tokens, thresholds)}"
          title="${row.date} · ${formatTokens(row.tokens)} token · ${row.turns} 次提问"
        ></div>
      `
    )
    .join("");
  return `
    <article class="panel">
      <div class="panel-header">
        <div>
          <div class="panel-title">最近半年活跃度</div>
          <div class="panel-subtitle">每日新增处理 token，按本机时区汇总</div>
        </div>
        <div class="panel-value">${data.source.activeDays} 活跃日</div>
      </div>
      <div class="heatmap-wrap">
        <div class="heatmap">${cells}</div>
        <div class="heatmap-scale">
          <span>少</span>
          <i style="background:var(--line)"></i>
          <i style="background:var(--purple-open)"></i>
          <i style="background:#c8bdf9"></i>
          <i style="background:var(--purple-light)"></i>
          <i style="background:var(--purple)"></i>
          <span>多</span>
        </div>
      </div>
    </article>
  `;
}

function renderLineChart() {
  const rows = data.trend;
  const width = 520;
  const height = 220;
  const padding = { top: 24, right: 18, bottom: 30, left: 18 };
  const max = Math.max(...rows.map((row) => row.tokens), 1);
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const points = rows.map((row, index) => ({
    ...row,
    x: padding.left + (index / Math.max(rows.length - 1, 1)) * innerWidth,
    y: padding.top + innerHeight - (row.tokens / max) * innerHeight
  }));
  const pointString = points.map((point) => `${point.x},${point.y}`).join(" ");
  const dots = points
    .map(
      (point, index) => `
        <circle class="chart-dot" cx="${point.x}" cy="${point.y}" r="3.8">
          <title>${point.date} · ${formatTokens(point.tokens)} token</title>
        </circle>
        ${
          index === points.length - 1
            ? `<text class="chart-value" x="${point.x - 8}" y="${Math.max(12, point.y - 10)}" text-anchor="end">${formatTokens(point.tokens)}</text>`
            : ""
        }
      `
    )
    .join("");
  const labels = points
    .filter((_point, index) => index % 2 === 0 || index === points.length - 1)
    .map(
      (point) => `
        <text class="chart-label" x="${point.x}" y="${height - 8}" text-anchor="middle">
          ${point.date.slice(5).replace("-", "/")}
        </text>
      `
    )
    .join("");
  const grids = [0, 0.5, 1]
    .map((ratio) => {
      const y = padding.top + innerHeight * ratio;
      return `<line class="chart-grid" x1="${padding.left}" x2="${width - padding.right}" y1="${y}" y2="${y}" />`;
    })
    .join("");

  return `
    <article class="panel">
      <div class="panel-header">
        <div>
          <div class="panel-title">最近 14 日用量</div>
          <div class="panel-subtitle">每天新增处理 token；包含缓存上下文</div>
        </div>
        <div class="panel-value">${formatTokens(rows.reduce((sum, row) => sum + row.tokens, 0))}</div>
      </div>
      <svg class="line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="最近14日用量折线图">
        ${grids}
        <polyline class="chart-line" points="${pointString}"></polyline>
        ${dots}
        ${labels}
      </svg>
    </article>
  `;
}

function leaderboard(items, options) {
  if (!items.length) {
    return `<div class="empty-state"><strong>${options.emptyTitle}</strong><span>${options.emptyText}</span></div>`;
  }
  const max = Math.max(...items.map(options.value), 1);
  return `
    <div class="leaderboard">
      ${items
        .map((item, index) => {
          const value = options.value(item);
          return `
            <div class="leader-row" title="${options.title?.(item) || ""}">
              <div class="leader-top">
                <div class="rank">${index + 1}</div>
                <div class="leader-name">
                  <strong>${options.name(item)}</strong>
                  <small>${options.subtitle(item)}</small>
                </div>
                <div class="leader-number">
                  ${options.number(item)}
                  <small>${options.numberNote(item)}</small>
                </div>
              </div>
              <div class="leader-bar"><span style="width:${Math.max(2, (value / max) * 100)}%"></span></div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderTrend() {
  tabContent.innerHTML = `
    <div class="content-grid">
      ${renderHeatmap()}
      ${renderLineChart()}
    </div>
  `;
}

function renderProjects() {
  tabContent.innerHTML = `
    <div class="content-grid equal">
      <article class="panel">
        <div class="panel-header">
          <div>
            <div class="panel-title">项目处理量排行</div>
            <div class="panel-subtitle">按 Codex 任务累计 token 汇总</div>
          </div>
          <div class="panel-value">${data.source.projectCount} 个项目</div>
        </div>
        ${leaderboard(data.projects.slice(0, 8), {
          value: (item) => item.tokens,
          name: (item) => item.name,
          subtitle: (item) => `${item.threads} 个任务 · 最近 ${formatDateTime(item.latestAt)}`,
          number: (item) => formatTokens(item.tokens),
          numberNote: () => "累计 token",
          title: (item) => item.path,
          emptyTitle: "暂无项目数据",
          emptyText: "创建 Codex 任务后会自动出现"
        })}
      </article>
      <article class="panel">
        <div class="panel-header">
          <div>
            <div class="panel-title">模型使用构成</div>
            <div class="panel-subtitle">按任务记录的累计 token 排序</div>
          </div>
          <div class="panel-value">${data.models.length} 个模型</div>
        </div>
        ${leaderboard(data.models.slice(0, 8), {
          value: (item) => item.tokens,
          name: (item) => item.model,
          subtitle: (item) => `${item.threads} 个任务`,
          number: (item) => formatTokens(item.tokens),
          numberNote: () => "累计 token",
          emptyTitle: "暂无模型数据",
          emptyText: "模型信息尚未写入本地任务库"
        })}
      </article>
    </div>
  `;
}

function renderSkills() {
  tabContent.innerHTML = `
    <div class="content-grid equal">
      <article class="panel">
        <div class="panel-header">
          <div>
            <div class="panel-title">Skill 使用痕迹 TOP20</div>
            <div class="panel-subtitle">依据 SKILL.md 读取事件；隐式注入可能未计入</div>
          </div>
          <div class="panel-value">${data.skills.length} 个 Skill</div>
        </div>
        ${leaderboard(data.skills.slice(0, 7), {
          value: (item) => item.count,
          name: (item) => item.name,
          subtitle: (item) => `说明文件估算 ${formatTokens(item.instructionTokensEstimate)} token`,
          number: (item) => `${formatCount(item.count)} 次`,
          numberNote: () => "使用痕迹",
          emptyTitle: "暂未发现 Skill 使用痕迹",
          emptyText: "使用 Skill 后会根据本地读取事件统计"
        })}
      </article>
      <article class="panel">
        <div class="panel-header">
          <div>
            <div class="panel-title">工具调用 TOP20</div>
            <div class="panel-subtitle">函数调用准确计数；输出 token 为字符数估算</div>
          </div>
          <div class="panel-value">${data.tools.length} 种工具</div>
        </div>
        ${leaderboard(data.tools.slice(0, 7), {
          value: (item) => item.count,
          name: (item) => item.name,
          subtitle: (item) => `输出估算 ${formatTokens(item.outputTokensEstimate)} token`,
          number: (item) => `${formatCount(item.count)} 次`,
          numberNote: () => "调用次数",
          emptyTitle: "暂无工具调用",
          emptyText: "运行工具后会自动统计"
        })}
      </article>
    </div>
  `;
}

function renderToday() {
  const todayTasks = data.recentTasks.filter((task) => {
    const taskDate = new Date(task.updatedAt);
    const now = new Date();
    return taskDate.toDateString() === now.toDateString();
  });
  const rows = (todayTasks.length ? todayTasks : data.recentTasks.slice(0, 8))
    .slice(0, 8)
    .map(
      (task) => `
        <div class="task-row" title="${task.path}">
          <div class="task-project">
            <strong>${task.project}</strong>
            <small>任务 ${task.id} · ${formatTokens(task.tokens)} token</small>
          </div>
          <div class="model-pill">${task.model}</div>
          <div class="task-time">${formatDateTime(task.updatedAt)}</div>
        </div>
      `
    )
    .join("");
  tabContent.innerHTML = `
    <div class="content-grid equal">
      <article class="panel">
        <div class="panel-header">
          <div>
            <div class="panel-title">${todayTasks.length ? "今日活跃任务" : "最近任务"}</div>
            <div class="panel-subtitle">只显示项目、模型和统计元数据</div>
          </div>
          <div class="panel-value">${todayTasks.length || data.recentTasks.length} 个</div>
        </div>
        <div class="task-list">${rows || `<div class="empty-state"><strong>今天还没有任务</strong><span>开始使用 Codex 后会自动更新</span></div>`}</div>
      </article>
      <article class="panel">
        <div class="panel-header">
          <div>
            <div class="panel-title">今日 token 构成</div>
            <div class="panel-subtitle">缓存输入占比越高，表示上下文复用越充分</div>
          </div>
          <div class="panel-value">${formatTokens(data.windows.today.total)}</div>
        </div>
        ${leaderboard(
          [
            { name: "缓存输入", value: data.windows.today.cachedInput, note: "已复用上下文" },
            { name: "未缓存输入", value: data.windows.today.freshInput, note: "新增上下文" },
            { name: "模型输出", value: data.windows.today.output, note: "含回答与工具编排" }
          ],
          {
            value: (item) => item.value,
            name: (item) => item.name,
            subtitle: (item) => item.note,
            number: (item) => formatTokens(item.value),
            numberNote: () => "token",
            emptyTitle: "暂无今日用量",
            emptyText: "开始新任务后会自动更新"
          }
        )}
      </article>
    </div>
  `;
}

function renderActiveTab() {
  $$(".tabs button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === activeTab);
  });
  if (activeTab === "today") renderToday();
  else if (activeTab === "projects") renderProjects();
  else if (activeTab === "skills") renderSkills();
  else renderTrend();
}

function renderDashboard() {
  renderOverview();
  renderActiveTab();
  coverageLabel.textContent = `${data.source.activeDays} 活跃日 · ${data.source.sessionCount} 本地会话`;
  sourceNote.textContent =
    data.source.parseErrors > 0
      ? `有 ${data.source.parseErrors} 行损坏记录已安全跳过`
      : "数据源：Codex 本地会话与任务元数据";
  freshness.textContent = `刷新 ${new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(data.generatedAt))}`;
  loadingState.classList.add("hidden");
  errorState.classList.add("hidden");
  dashboard.classList.remove("hidden");
  requestAnimationFrame(() => window.codexU.notifyRendered());
}

async function loadDashboard(force = false) {
  document.documentElement.classList.toggle("is-refreshing", force);
  if (!data) {
    loadingState.classList.remove("hidden");
    dashboard.classList.add("hidden");
    errorState.classList.add("hidden");
  }
  try {
    data = force
      ? await window.codexU.refreshDashboard()
      : await window.codexU.getDashboard();
    renderDashboard();
  } catch (error) {
    loadingState.classList.add("hidden");
    dashboard.classList.add("hidden");
    errorState.classList.remove("hidden");
    $("#errorMessage").textContent = error?.message || "未知错误";
  } finally {
    document.documentElement.classList.remove("is-refreshing");
  }
}

function scheduleAutoRefresh() {
  clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => loadDashboard(false), 30_000);
}

$$(".tabs button").forEach((button) => {
  button.addEventListener("click", () => {
    activeTab = button.dataset.tab;
    renderActiveTab();
  });
});

$("#themeButton").addEventListener("click", () => {
  const root = document.documentElement;
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  localStorage.setItem("codexu-theme", next);
});

$("#closeButton").addEventListener("click", () => window.codexU.windowControl("close"));
$("#pinButton").addEventListener("click", async (event) => {
  const pinned = await window.codexU.windowControl("pin");
  event.currentTarget.classList.toggle("active", Boolean(pinned));
});
refreshButton.addEventListener("click", () => loadDashboard(true));
$("#retryButton").addEventListener("click", () => loadDashboard(true));

const savedTheme = localStorage.getItem("codexu-theme");
const darkPreferred = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
document.documentElement.dataset.theme = savedTheme || (darkPreferred ? "dark" : "light");

loadDashboard();
scheduleAutoRefresh();
