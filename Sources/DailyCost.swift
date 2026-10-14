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
            next.baseline = (state.lastCostDayKey == yesterday) ? state.lastCost : cost
        }

        next.lastCost = cost
        next.lastCostDayKey = today

        let spent = cost - next.baseline
        return (spent < 0 ? 0 : spent, next)
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
