import Foundation

struct WidgetUsage: Codable {
    let input: Double
    let cachedInput: Double
    let freshInput: Double
    let output: Double
    let total: Double

    static let empty = WidgetUsage(input: 0, cachedInput: 0, freshInput: 0, output: 0, total: 0)
}

struct WidgetWindows: Codable {
    let today: WidgetUsage
    let sevenDays: WidgetUsage
    let total: WidgetUsage

    static let empty = WidgetWindows(today: .empty, sevenDays: .empty, total: .empty)
}

struct WidgetQuota: Codable {
    let windowMinutes: Int
    let remainingPercent: Double
    let usedPercent: Double
    let resetsAt: Double

    var remainingText: String { "\(Int(remainingPercent.rounded()))%" }

    var resetText: String {
        guard resetsAt > 0 else { return "暂无有效窗口" }
        let resetDate = Date(timeIntervalSince1970: resetsAt / 1_000)
        let minutes = max(0, Int(resetDate.timeIntervalSinceNow / 60))
        if minutes < 60 { return "\(minutes) 分钟后重置" }
        if minutes < 1_440 { return "\(minutes / 60) 小时后重置" }
        return resetDate.formatted(.dateTime.month().day().hour().minute()) + " 重置"
    }
}

struct WidgetSnapshot: Codable {
    let schemaVersion: Int
    let generatedAt: String
    let planType: String
    let quotas: [WidgetQuota]
    let windows: WidgetWindows

    static let preview = WidgetSnapshot(
        schemaVersion: 1,
        generatedAt: ISO8601DateFormatter().string(from: .now),
        planType: "PLUS",
        quotas: [
            WidgetQuota(windowMinutes: 300, remainingPercent: 87, usedPercent: 13, resetsAt: Date.now.addingTimeInterval(2 * 3_600).timeIntervalSince1970 * 1_000),
            WidgetQuota(windowMinutes: 10_080, remainingPercent: 81, usedPercent: 19, resetsAt: Date.now.addingTimeInterval(6 * 86_400).timeIntervalSince1970 * 1_000)
        ],
        windows: WidgetWindows(
            today: WidgetUsage(input: 1_700_000, cachedInput: 1_300_000, freshInput: 396_000, output: 14_900, total: 1_714_900),
            sevenDays: WidgetUsage(input: 9_500_000, cachedInput: 7_700_000, freshInput: 1_800_000, output: 84_900, total: 9_584_900),
            total: WidgetUsage(input: 171_000_000, cachedInput: 151_400_000, freshInput: 18_800_000, output: 883_200, total: 171_883_200)
        )
    )

    func quota(minutes: Int) -> WidgetQuota? {
        quotas.first { $0.windowMinutes == minutes }
    }

    var freshnessText: String {
        guard let date = ISO8601DateFormatter().date(from: generatedAt) else {
            return "等待 codexU 写入本地快照"
        }
        return "刷新 \(date.formatted(.dateTime.hour().minute()))"
    }
}

enum WidgetSnapshotStore {
    // macOS supports team-scoped App Groups without a provisioning profile.
    // This is important for a locally signed Personal Team build.
    static let appGroup = "7BF3VF2M63.local.codexu.dashboard"
    static let filename = "usage-snapshot.json"

    static func load() -> WidgetSnapshot {
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroup
        ) else { return .preview }
        let url = container.appendingPathComponent(filename)
        guard
            let data = try? Data(contentsOf: url),
            let snapshot = try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
        else { return .preview }
        return snapshot
    }

    static func recordReloadRequest() {
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroup
        ) else { return }
        let marker = container.appendingPathComponent("widget-reload-requested.txt")
        try? ISO8601DateFormatter().string(from: .now).write(
            to: marker,
            atomically: true,
            encoding: .utf8
        )
    }
}

enum TokenFormatter {
    static func compact(_ value: Double) -> String {
        switch value {
        case 1_000_000_000...:
            return String(format: "%.1fB", value / 1_000_000_000)
        case 1_000_000...:
            return String(format: "%.1fM", value / 1_000_000)
        case 1_000...:
            return String(format: "%.1fK", value / 1_000)
        default:
            return String(Int(value))
        }
    }
}
