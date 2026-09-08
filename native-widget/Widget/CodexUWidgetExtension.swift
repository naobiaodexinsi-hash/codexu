import SwiftUI
import WidgetKit
import IOKit.ps

private enum WidgetRefreshCadence {
    static var seconds: TimeInterval {
        let powerInfo = IOPSCopyPowerSourcesInfo().takeRetainedValue()
        let powerSource = IOPSGetProvidingPowerSourceType(powerInfo)?
            .takeUnretainedValue() as String?
        return powerSource == kIOPSACPowerValue
            ? 60
            : 15 * 60
    }
}

struct CodexUWidgetEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot
}

struct CodexUWidgetProvider: TimelineProvider {
    func placeholder(in context: Context) -> CodexUWidgetEntry {
        CodexUWidgetEntry(date: .now, snapshot: .preview)
    }

    func getSnapshot(in context: Context, completion: @escaping (CodexUWidgetEntry) -> Void) {
        completion(CodexUWidgetEntry(date: .now, snapshot: WidgetSnapshotStore.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<CodexUWidgetEntry>) -> Void) {
        let entry = CodexUWidgetEntry(date: .now, snapshot: WidgetSnapshotStore.load())
        let refresh = Date.now.addingTimeInterval(WidgetRefreshCadence.seconds)
        completion(Timeline(entries: [entry], policy: .after(refresh)))
    }
}

struct CodexUWidget: Widget {
    static let kind = "CodexUUsageWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: CodexUWidgetProvider()) { entry in
            CodexUWidgetView(entry: entry)
                .containerBackground(for: .widget) {
                    LinearGradient(
                        colors: [Color.indigo.opacity(0.22), Color.purple.opacity(0.10), Color.clear],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                }
        }
        .configurationDisplayName("codexU 用量")
        .description("显示 Codex 的本地额度与 Token 汇总。")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

@main
struct CodexUWidgetBundle: WidgetBundle {
    var body: some Widget {
        CodexUWidget()
    }
}

private struct CodexUWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: CodexUWidgetEntry

    var body: some View {
        switch family {
        case .systemSmall:
            SmallUsageView(snapshot: entry.snapshot)
        case .systemLarge:
            LargeUsageView(snapshot: entry.snapshot)
        default:
            MediumUsageView(snapshot: entry.snapshot)
        }
    }
}

private struct SmallUsageView: View {
    let snapshot: WidgetSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            WidgetTitle(plan: snapshot.planType)
            Spacer(minLength: 0)
            HStack(spacing: 14) {
                RingMetric(label: "5h", quota: snapshot.quota(minutes: 300), tint: .indigo)
                RingMetric(label: "7d", quota: snapshot.quota(minutes: 10_080), tint: .purple)
            }
            Spacer(minLength: 0)
            Text(snapshot.freshnessText)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding()
    }
}

private struct MediumUsageView: View {
    let snapshot: WidgetSnapshot

    var body: some View {
        HStack(spacing: 17) {
            VStack(alignment: .leading, spacing: 8) {
                WidgetTitle(plan: snapshot.planType)
                Text(TokenFormatter.compact(snapshot.windows.today.total))
                    .font(.system(size: 31, weight: .bold, design: .rounded))
                    .monospacedDigit()
                Text("今日 Token")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
                Text(snapshot.freshnessText)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            VStack(spacing: 12) {
                QuotaRow(label: "5 小时", quota: snapshot.quota(minutes: 300), tint: .indigo)
                QuotaRow(label: "7 天", quota: snapshot.quota(minutes: 10_080), tint: .purple)
            }
            .frame(maxWidth: .infinity)
        }
        .padding()
    }
}

private struct LargeUsageView: View {
    let snapshot: WidgetSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            WidgetTitle(plan: snapshot.planType)
            HStack(spacing: 16) {
                RingMetric(label: "5h", quota: snapshot.quota(minutes: 300), tint: .indigo)
                RingMetric(label: "7d", quota: snapshot.quota(minutes: 10_080), tint: .purple)
                VStack(alignment: .leading, spacing: 7) {
                    MetricValue(label: "今日", value: TokenFormatter.compact(snapshot.windows.today.total))
                    MetricValue(label: "近 7 天", value: TokenFormatter.compact(snapshot.windows.sevenDays.total))
                    MetricValue(label: "累计", value: TokenFormatter.compact(snapshot.windows.total.total))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            Text("仅汇总 Token 与额度，不包含聊天正文")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(snapshot.freshnessText)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding()
    }
}

private struct WidgetTitle: View {
    let plan: String

    var body: some View {
        HStack {
            Label("codexU", systemImage: "gauge.with.dots.needle.67percent")
                .font(.headline.weight(.bold))
            Spacer()
            Text(plan)
                .font(.caption2.weight(.bold))
                .foregroundStyle(.indigo)
        }
    }
}

private struct RingMetric: View {
    let label: String
    let quota: WidgetQuota?
    let tint: Color

    var body: some View {
        VStack(spacing: 5) {
            ZStack {
                Circle().stroke(tint.opacity(0.16), lineWidth: 8)
                Circle()
                    .trim(from: 0, to: max(0.02, min(1, (quota?.remainingPercent ?? 0) / 100)))
                    .stroke(tint, style: StrokeStyle(lineWidth: 8, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Text(quota?.remainingText ?? "—")
                    .font(.headline.weight(.bold))
                    .monospacedDigit()
            }
            .frame(width: 70, height: 70)
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
    }
}

private struct QuotaRow: View {
    let label: String
    let quota: WidgetQuota?
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(label).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                Spacer()
                Text(quota?.remainingText ?? "暂无").font(.headline.weight(.bold)).monospacedDigit()
            }
            ProgressView(value: (quota?.remainingPercent ?? 0) / 100).tint(tint)
            Text(quota?.resetText ?? "暂无有效窗口")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}

private struct MetricValue: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.headline.weight(.bold)).monospacedDigit()
        }
    }
}
