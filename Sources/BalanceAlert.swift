import Foundation
import SwiftUI

/// 一次额度提醒。
struct BalanceAlert: Equatable {
    enum Kind: Equatable {
        /// 余额跌破设定值
        case lowBalance(threshold: Decimal)
        /// 两次查询之间消耗超过设定值
        case bigBurn(delta: Decimal)
    }

    let kind: Kind
    let symbol: String
    let current: Decimal
    let at: Date

    var title: String {
        switch kind {
        case .lowBalance(let threshold):
            return "余额已低于 \(symbol)\(AmountFormat.string(threshold))"
        case .bigBurn(let delta):
            return "本次消耗 \(symbol)\(AmountFormat.string(delta))"
        }
    }

    var color: Color {
        switch kind {
        case .lowBalance: return Color(red: 1.00, green: 0.62, blue: 0.30)
        case .bigBurn: return Color(red: 0.45, green: 0.72, blue: 1.00)
        }
    }
}

/// 提醒判定。纯逻辑，不碰网络与 UI，便于 `--alertcheck` 自检。
///
/// 两条规则：
/// 1. **余额跌破阈值**：只在「跌破」那一刻提醒一次；余额回到阈值之上后重新武装，
///    下次再跌破才会再提醒。否则每轮询一次就响一次，会变成骚扰。
/// 2. **单次消耗超阈值**：比较相邻两次查询的余额差值。首次查询没有参照，不判定。
///
/// 阈值设为 0 表示关闭该条规则。
struct AlertDetector {
    /// 上一次成功查询的余额
    private(set) var previousAmount: Decimal?
    /// 余额是否还处于「已跌破」状态。true 表示可以再次触发。
    private(set) var lowBalanceArmed = true

    mutating func reset() {
        previousAmount = nil
        lowBalanceArmed = true
    }

    mutating func evaluate(current: Decimal,
                           symbol: String,
                           lowThreshold: Double,
                           burnThreshold: Double,
                           at: Date) -> BalanceAlert? {
        defer { previousAmount = current }

        // 规则 1：单次消耗
        var burnAlert: BalanceAlert?
        if burnThreshold > 0, let previous = previousAmount {
            let delta = previous - current
            if delta >= Decimal(burnThreshold) {
                burnAlert = BalanceAlert(kind: .bigBurn(delta: delta),
                                         symbol: symbol,
                                         current: current,
                                         at: at)
            }
        }

        // 规则 2：跌破阈值（回落即重新武装）
        var lowAlert: BalanceAlert?
        if lowThreshold > 0 {
            let threshold = Decimal(lowThreshold)
            if current < threshold {
                if lowBalanceArmed {
                    lowBalanceArmed = false
                    lowAlert = BalanceAlert(kind: .lowBalance(threshold: threshold),
                                            symbol: symbol,
                                            current: current,
                                            at: at)
                }
            } else {
                lowBalanceArmed = true
            }
        }

        // 两条同时命中时，余额告急更需要动作
        return lowAlert ?? burnAlert
    }
}
