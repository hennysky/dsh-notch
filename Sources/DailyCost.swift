import Foundation

/// 「今日消耗」的本地推算状态。
///
/// 平台只提供累计消费（`total_costs`），没有按天维度，所以只能自己记基线：
/// 今日消耗 = 当前累计消费 − 当日基线。
struct DailyCostState: Codable, Equatable {
    /// 基线所属日期（yyyy-MM-dd）
    var dayKey: String = ""
    /// 当天起点时的累计消费
    var baseline: Decimal = 0
    /// 最近一次读到的累计消费
    var lastCost: Decimal = 0
    /// 最近一次读数所属日期
    var lastCostDayKey: String = ""
    /// 当日基线是否可信。
    /// false 表示当天起点的累计值无从得知（首次运行、或隔了多天才开），
    /// 此时今日消耗只能算「至少这么多」，不能当成精确值展示。
    var baselineCertain: Bool = false
}

/// 纯逻辑，便于 `--costcheck` 自检。
enum DailyCost {
    static func dayKey(for date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// 用一次新读数推算出今日消耗。
    ///
    /// 跨天时基线的取法：
    /// - 上一次读数就在昨天 → 拿它当基线，最接近午夜的真实值
    /// - 上一次读数是更早（应用关了几天）→ 只能用今天第一次读数兜底，会少算一部分
    static func update(_ state: DailyCostState,
                       cost: Decimal,
                       today: String,
                       yesterday: String) -> (today: Decimal, state: DailyCostState) {
        var next = state

        if state.dayKey != today {
            next.dayKey = today
            if state.lastCostDayKey == yesterday {
                // 昨天有读数，这就是最接近午夜的真实基线
                next.baseline = state.lastCost
                next.baselineCertain = true
            } else {
                // 无从得知当天起点，只能用当前读数兜底 —— 会少算，标记为不可信
                next.baseline = cost
                next.baselineCertain = false
            }
        }

        next.lastCost = cost
        next.lastCostDayKey = today

        let spent = cost - next.baseline
        return (spent < 0 ? 0 : spent, next)
    }
}

/// 今日消耗的展示文案。抽成纯函数，好让「不可信时不许显示成 ¥0.00」这条被自检守住。
enum DailyCostDisplay {
    static func text(amount: Decimal, symbol: String, certain: Bool) -> String {
        guard certain else {
            // 不知道 ≠ 没消耗。显示下限或「统计中」，不伪装成精确的 0。
            return amount <= 0 ? "统计中" : "≥" + symbol + AmountFormat.string(amount)
        }
        return symbol + AmountFormat.string(amount)
    }
}

/// 落盘。跨重启保留，否则每次开应用今日消耗都会归零。
enum DailyCostStore {
    private static let key = "dshNotch.dailyCost"

    static func load() -> DailyCostState {
        guard let data = UserDefaults.standard.data(forKey: key),
              let state = try? JSONDecoder().decode(DailyCostState.self, from: data) else {
            return DailyCostState()
        }
        return state
    }

    static func save(_ state: DailyCostState) {
        guard let data = try? JSONEncoder().encode(state) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }
}
