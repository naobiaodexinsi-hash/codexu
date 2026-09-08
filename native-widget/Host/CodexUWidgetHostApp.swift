import AppKit
import SwiftUI
import WidgetKit

@main
struct CodexUWidgetHostApp: App {
    init() {
        guard ProcessInfo.processInfo.arguments.contains("--refresh-widgets") else { return }
        WidgetSnapshotStore.recordReloadRequest()
        WidgetCenter.shared.reloadAllTimelines()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            NSApp.terminate(nil)
        }
    }

    var body: some Scene {
        WindowGroup("codexU Widgets") {
            HostView()
                .frame(minWidth: 430, minHeight: 340)
        }
        .windowResizability(.contentSize)
    }
}

private struct HostView: View {
    @State private var snapshot = WidgetSnapshotStore.load()

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 12) {
                Image(systemName: "gauge.with.dots.needle.67percent")
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(.indigo)
                VStack(alignment: .leading, spacing: 3) {
                    Text("codexU 原生小组件")
                        .font(.title3.weight(.bold))
                    Text("已注册到 macOS 小组件库")
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(snapshot.planType)
                    .font(.caption.weight(.bold))
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(.indigo.opacity(0.13), in: Capsule())
            }

            HStack(spacing: 12) {
                HostMetric(label: "5 小时余量", value: snapshot.quota(minutes: 300)?.remainingText ?? "—")
                HostMetric(label: "7 天余量", value: snapshot.quota(minutes: 10_080)?.remainingText ?? "—")
                HostMetric(label: "今日 Token", value: TokenFormatter.compact(snapshot.windows.today.total))
            }

            Divider()

            Text(snapshot.freshnessText)
                .font(.caption)
                .foregroundStyle(.secondary)

            HStack {
                Button("刷新小组件") {
                    snapshot = WidgetSnapshotStore.load()
                    WidgetCenter.shared.reloadAllTimelines()
                }
                .keyboardShortcut("r")

                Button("打开 codexU") {
                    let appURL = URL(fileURLWithPath: "/Applications/codexU.app")
                    NSWorkspace.shared.openApplication(at: appURL, configuration: .init())
                }
                Spacer()
                Text("桌面右键 → 编辑小组件 → codexU Widgets")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(28)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

private struct HostMetric: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.title3.weight(.bold))
                .monospacedDigit()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(13)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 14))
    }
}
