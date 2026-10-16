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
    /// 今日消耗（本地用累计消费的差值推算）
    @Published private(set) var todayCost: Decimal?
    /// 首次使用的引导态。凭据类失败单独呈现，不当作普通错误甩给用户。
    @Published private(set) var setupIssue: SetupIssue?

    /// 轮询间隔：5 分钟。DSH 自身超时为 30s，不需要更频繁地打接口。
    let refreshInterval: TimeInterval = 300

    /// 触发额度提醒时的回调。控制器负责弹出卡片并定时收起。
    var onAlert: ((BalanceAlert) -> Void)?

    private let settings: NotchSettings
    private let client = BalanceClient()
    private var pollTask: Task<Void, Never>?
    private var detector = AlertDetector()
    private var costState = DailyCostStore.load()
    /// 上一次**发起**查询的时间（成败都记）。用于「点开时补一次」的限流。
    private var lastAttemptAt: Date?

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

    /// 点开卡片 / 菜单栏时调用：只在数据够旧时才真的打接口。
    ///
    /// 用户的预期是「点开就看到最新余额」，但无脑刷新会在反复点开时打爆接口
    /// （实测触发过 HTTP 429），所以配一个下限。
    func refreshIfStale() {
        let now = Date()
        guard RefreshPolicy.shouldRefresh(lastAttemptAt: lastAttemptAt, now: now) else {
            let age = lastAttemptAt.map { Int(now.timeIntervalSince($0)) } ?? -1
            dshLog("余额 \(age)s 前刚查过，跳过刷新")
            return
        }
        dshLog("点开触发刷新")
        Task { await refresh() }
    }

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        lastAttemptAt = Date()
        defer { isRefreshing = false }
        do {
            let fresh = try await client.fetch()
            snapshot = fresh
            errorText = nil
            setupIssue = nil
            updateDailyCost(fresh)
            evaluateAlert(fresh)
        } catch {
            errorText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            setupIssue = Self.setupIssue(from: error)
        }
    }

    /// 凭据类失败的分类。发给别人时这是第一个会撞上的场景，
    /// 不能只显示一行文件路径——用户不知道该怎么办。
    enum SetupIssue: Equatable {
        /// 这台机器上没有 DSH 的凭据文件：没装 DSH，或装了没登录
        case notConnected
        /// 有凭据文件，但里面没有登录记录
        case notSignedIn

        var title: String {
            switch self {
            case .notConnected: return "还没有找到 DSH 的登录凭据"
            case .notSignedIn: return "DSH 还没有登录"
            }
        }

        var detail: String {
            switch self {
            case .notConnected:
                return "请先安装并登录 DeepSeek Harness，再回来点「重新检查」。"
            case .notSignedIn:
                return "打开 DeepSeek Harness 登录一次，再回来点「重新检查」。"
            }
        }
    }

    /// internal 而非 private：`--setupcheck` 要直接验证分类结果。
    static func setupIssue(from error: Error) -> SetupIssue? {
        guard let balanceError = error as? BalanceError,
              case .credential(let inner) = balanceError,
              let credentialError = inner as? CredentialError else { return nil }
        switch credentialError {
        case .fileMissing: return .notConnected
        case .recordMissing: return .notSignedIn
        default: return nil
        }
    }

    private func updateDailyCost(_ fresh: BalanceSnapshot) {
        guard let cost = fresh.costs.first?.amount.decimal else { return }
        let today = DailyCost.dayKey(for: fresh.fetchedAt)
        let yesterday = DailyCost.dayKey(for: fresh.fetchedAt.addingTimeInterval(-86_400))
        let result = DailyCost.update(costState, cost: cost, today: today, yesterday: yesterday)
        costState = result.state
        DailyCostStore.save(result.state)
        todayCost = result.today
    }

    /// 充值入口。链接由凭据里的平台来源派生，不带任何授权信息——
    /// 打开的是浏览器自己的登录态，和 DSH 的做法一致。
    var topUpURL: URL {
        let origin = snapshot?.origin ?? URL(string: "https://platform.deepseek.com")!
        return origin.appendingPathComponent("top_up")
    }

    /// 今日消耗文案。
    ///
    /// 基线不可信时（首次运行、或隔了多天才开应用）只显示「≥ 值」或「统计中」，
    /// 不能显示成 ¥0.00 —— 那是把「不知道」伪装成「没消耗」。
    var todayCostText: String {
        guard let todayCost else { return "—" }
        let symbol = snapshot?.costs.first.map { AmountFormat.symbol(for: $0.currency) } ?? "¥"
        return DailyCostDisplay.text(amount: todayCost, symbol: symbol, certain: costState.baselineCertain)
    }

    /// 今日消耗是否为精确值（供界面加脚注）
    var todayCostIsExact: Bool { costState.baselineCertain }

    private func evaluateAlert(_ fresh: BalanceSnapshot) {
        guard let wallet = fresh.primary else { return }
        let alert = detector.evaluate(current: wallet.amount,
                                      symbol: wallet.symbol,
                                      lowThreshold: settings.lowBalanceThreshold,
                                      burnThreshold: settings.burnThreshold,
                                      at: fresh.fetchedAt)
        if let alert { onAlert?(alert) }
    }

    /// 仅供 `--render` 离屏预览使用：注入引导态。
    func injectSetupIssue(_ issue: SetupIssue?) { setupIssue = issue }

    /// 仅供 `--render` 离屏预览使用：注入一份假快照，不发起网络请求。
    func injectPreview(normal: String, bonus: String, cost: String,
                       today: String = "2.63", todayCertain: Bool = true) {
        snapshot = BalanceSnapshot(
            normal: [Wallet(currency: "CNY", balance: LooseString(normal))],
            bonus: [Wallet(currency: "CNY", balance: LooseString(bonus))],
            costs: [Cost(currency: "CNY", amount: LooseString(cost))],
            fetchedAt: Date(),
            origin: URL(string: "https://platform.deepseek.com")!
        )
        todayCost = Decimal(string: today)
        let key = DailyCost.dayKey(for: Date())
        costState = DailyCostState(dayKey: key, baseline: 0, lastCost: 0,
                                   lastCostDayKey: key, baselineCertain: todayCertain)
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
