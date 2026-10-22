import Foundation

/// DSH 插件写出的「当前会话花费」快照（docs/session-cost.md）。
///
/// 插件监听会话事件，按每条 assistant/message 的时间与模型计价，原子写到
/// `~/.dsh/notch/session-cost.json`；这里只负责读和展示，不做任何网络请求。
struct SessionCostSnapshot: Codable, Equatable {
    struct Usage: Codable, Equatable {
        let uncachedInputTokens: Int
        let cacheReadTokens: Int
        let cacheWriteTokens: Int
        let outputTokens: Int
        let requests: Int
    }

    struct Cost: Codable, Equatable {
        let cny: Double
        let priced: Bool
        let peak: Bool
        let estimated: Bool
        let note: String?
    }

    let schema: Int
    let sessionId: String
    let title: String
    let model: String
    let models: [String]?
    let source: String
    /// 毫秒时间戳
    let updatedAt: Double
    let usage: Usage
    let cost: Cost

    /// 超过 24 小时的快照不再显示：可能已经是另一台机器/很久以前的会话。
    static let freshness: TimeInterval = 24 * 60 * 60

    var updatedDate: Date { Date(timeIntervalSince1970: updatedAt / 1000) }

    var isFresh: Bool { Date().timeIntervalSince(updatedDate) < Self.freshness }

    /// 金额不可用（未收录模型 / 没有用量）时返回 nil，界面整块隐藏金额。
    var moneyText: String? {
        guard cost.priced else { return nil }
        return "≈¥" + Self.formatCny(cost.cny)
    }

    var titleText: String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "未命名会话" : trimmed
    }

    var modelText: String {
        let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "—" : trimmed
    }

    var tokensText: String {
        let hit = Self.compactCount(usage.cacheReadTokens)
        let miss = Self.compactCount(usage.uncachedInputTokens + usage.cacheWriteTokens)
        let output = Self.compactCount(usage.outputTokens)
        return "输入 \(miss)（缓存 \(hit)）· 输出 \(output)"
    }

    /// 只读 `~/.dsh/notch/session-cost.json`；缺失/损坏/过期/schema 不符都返回 nil。
    static func load(home: URL = SessionCostSnapshot.defaultHome()) -> SessionCostSnapshot? {
        let url = home.appendingPathComponent(".dsh/notch/session-cost.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return parse(data)
    }

    static func defaultHome() -> URL {
        if let override = ProcessInfo.processInfo.environment["DSH_HOME"], !override.isEmpty {
            return URL(fileURLWithPath: override).deletingLastPathComponent()
        }
        return FileManager.default.homeDirectoryForCurrentUser
    }

    static func parse(_ data: Data) -> SessionCostSnapshot? {
        guard let snapshot = try? JSONDecoder().decode(SessionCostSnapshot.self, from: data) else { return nil }
        guard snapshot.schema == 1, !snapshot.sessionId.isEmpty, snapshot.isFresh else { return nil }
        return snapshot
    }

    /// 人民币展示：大额两位、小额三到四位。
    static func formatCny(_ value: Double) -> String {
        guard value.isFinite, value > 0 else { return "0" }
        if value >= 1 { return String(format: "%.2f", value) }
        if value >= 0.01 {
            var text = String(format: "%.3f", value)
            while text.hasSuffix("0") { text.removeLast() }
            return text
        }
        let fixed = String(format: "%.4f", value)
        return fixed == "0.0000" ? "<0.0001" : fixed
    }

    /// token 数：123 / 12.3k / 1.24M
    static func compactCount(_ value: Int) -> String {
        guard value > 0 else { return "0" }
        if value >= 1_000_000 {
            return String(format: "%.2fM", Double(value) / 1_000_000)
        }
        if value >= 1_000 {
            return String(format: "%.1fk", Double(value) / 1_000)
        }
        return String(value)
    }
}
