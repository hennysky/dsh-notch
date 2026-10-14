import SwiftUI

/// 余额状态机。
///
/// 关键约定（与 DSH 自身一致）：**查询失败绝不合成 0**。
/// 失败时保留上一次成功快照，只把 errorText 标出来，UI 显示旧值并标注「已过期」。
@MainActor
final class BalanceModel: ObservableObject {
    @Published private(set) var snapshot: BalanceSnapshot?
    @Published private(set) var errorText: String?
    @Published private(set) var isRefreshing = false
    @Published var isExpanded = false

    /// 轮询间隔：5 分钟。DSH 自身超时为 30s，不需要更频繁地打接口。
    let refreshInterval: TimeInterval = 300

    /// 触发额度提醒时的回调。控制器负责弹出卡片并定时收起。
    var onAlert: ((BalanceAlert) -> Void)?

    private let settings: NotchSettings
    private let client = BalanceClient()
    private var pollTask: Task<Void, Never>?
    private var detector = AlertDetector()

    init(settings: NotchSettings) {
        self.settings = settings
    }

    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                guard let interval = self?.refreshInterval else { return }
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let fresh = try await client.fetch()
            snapshot = fresh
            errorText = nil
            evaluateAlert(fresh)
        } catch {
            errorText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func evaluateAlert(_ fresh: BalanceSnapshot) {
        guard let wallet = fresh.primary else { return }
        let alert = detector.evaluate(current: wallet.amount,
                                      symbol: wallet.symbol,
                                      lowThreshold: settings.lowBalanceThreshold,
                                      burnThreshold: settings.burnThreshold,
                                      at: fresh.fetchedAt)
        if let alert { onAlert?(alert) }
    }

    /// 仅供 `--render` 离屏预览使用：注入一份假快照，不发起网络请求。
    func injectPreview(normal: String, bonus: String, cost: String) {
        snapshot = BalanceSnapshot(
            normal: [Wallet(currency: "CNY", balance: LooseString(normal))],
            bonus: [Wallet(currency: "CNY", balance: LooseString(bonus))],
            costs: [Cost(currency: "CNY", amount: LooseString(cost))],
            fetchedAt: Date()
        )
    }

    // MARK: - 展示

    /// 折叠胶囊与卡片主数字
    var amountText: String { snapshot?.primary?.display ?? "—" }

    var bonusText: String {
        guard let snapshot else { return "—" }
        let wallet = snapshot.bonus.first { $0.amount > 0 } ?? snapshot.bonus.first
        return wallet?.display ?? "—"
    }

    var costText: String { snapshot?.costs.first?.display ?? "—" }

    var updatedText: String {
        guard let snapshot else { return "尚未获取" }
        return "更新于 " + Self.clock.string(from: snapshot.fetchedAt)
    }

    var isStale: Bool { snapshot != nil && errorText != nil }

    enum Level {
        case unknown, healthy, low, critical, failed
    }

    var level: Level {
        guard let amount = snapshot?.primary?.amount else {
            return errorText == nil ? .unknown : .failed
        }
        if amount >= 10 { return .healthy }
        if amount >= 1 { return .low }
        return .critical
    }

    private static let clock: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()
}
