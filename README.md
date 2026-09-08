# codexU

macOS 本地 Codex 用量看板。应用以只读方式汇总 `~/.codex` 中的任务、
token、限额、工具和 Skill 使用痕迹，不保存聊天正文。

> 这是源码仓库。它不包含任何本机 Codex 数据、聊天内容、登录凭据、测试缓存或已打包应用。

应用启动后常驻 macOS 状态栏，状态栏文字直接显示可用的 5 小时和
7 天剩余百分比。左键点击图标展开或收起看板，右键菜单可刷新或退出。

0.4.0 增加完整看板桌面小组件：保留主看板的所有内容和页签，以约
68% 比例缩放成较小的桌面窗口。小组件位置与显示状态会保存在本机偏好中。

0.5.0 新增 `native-widget/` 原生 SwiftUI + WidgetKit 工程。它提供小、
中、大三种真正出现在 macOS “编辑小组件”中的系统组件。Electron 主应用
只将额度与 Token 汇总写入 App Group 快照；组件不会读取或保存聊天正文。

## 本地运行

```bash
pnpm install
pnpm start
```

## 打包

```bash
pnpm pack:mac
```

输出位于项目工作区的 `outputs/release/`。

## 原生系统小组件

先在 Xcode 的 Settings → Accounts 登录 Apple ID，然后打开
`native-widget/CodexUWidgetHost.xcodeproj`，为两个 Target 选择同一个 Team，
确认 Signing & Capabilities 中的 App Groups 为
`你的 Team ID.local.codexu.dashboard`，最后运行 `CodexUWidgetHost`。

本仓库目前保留了开发时使用的 Team ID，以便原始开发环境可以继续构建。其他
开发者在构建前，需要将源码与 Xcode 工程中的
`7BF3VF2M63.local.codexu.dashboard` 替换为自己 Team 的同名 App Group，并为
两个 Target 选择同一个 Team。

首次运行后，在桌面右键 → 编辑小组件 → `codexU Widgets`，选择小、中或大
尺寸即可。系统组件会按 WidgetKit 调度刷新。

### 后台更新

安装 0.5.0 及以上版本后，首次正常打开 `codexU` 会注册一个只属于当前用户的
后台同步器。之后无需打开主窗口：接通电源时每分钟更新，电池供电时每 15 分钟
更新。同步器不显示 Dock 图标、窗口或悬浮面板，也不读取或保存聊天正文。小组件
由 macOS 按系统策略刷新，显示最近一次后台同步的数据。

## 统计口径

- token：按每个会话的累计 `token_count` 事件计算相邻增量。
- 今日和近 7 天：按本机时区的事件日期汇总。
- 项目：按任务数据库中的 `cwd` 汇总。
- 工具：按结构化函数调用事件计数。
- Skill：按读取 `SKILL.md` 的使用痕迹统计；隐式注入可能未被记录。
- 金额：首版不计算，避免把 Plus 订阅误标为按 token 账单。
