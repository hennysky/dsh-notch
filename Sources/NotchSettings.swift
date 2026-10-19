import AppKit
import QuartzCore
import SwiftUI

/// 可调参数。写入 UserDefaults，重启后保持。阈值 0 表示关闭该项提醒。
@MainActor
final class NotchSettings: ObservableObject {
    /// 展开/收起的缓动曲线
    enum Easing: String, CaseIterable, Identifiable {
        case smooth, easeOut, easeIn, linear

        var id: String { rawValue }

        var label: String {
            switch self {
            case .smooth: return "平滑"
            case .easeOut: return "缓出"
            case .easeIn: return "缓入"
            case .linear: return "线性"
            }
        }

        var timingFunction: CAMediaTimingFunction {
            switch self {
            case .smooth: return CAMediaTimingFunction(name: .easeInEaseOut)
            case .easeOut: return CAMediaTimingFunction(name: .easeOut)
            case .easeIn: return CAMediaTimingFunction(name: .easeIn)
            case .linear: return CAMediaTimingFunction(name: .linear)
            }
        }
    }

    /// 呈现形态。自动 = 有刘海屏用刘海，没有就用菜单栏。
    enum Presentation: String, CaseIterable, Identifiable {
        case automatic, notch, menuBar

        var id: String { rawValue }

        var label: String {
            switch self {
            case .automatic: return "自动"
            case .notch: return "刘海"
            case .menuBar: return "菜单栏"
            }
        }
    }

    static let durationRange: ClosedRange<Double> = 0.1...1.5
    static let defaultDuration: Double = 0.45
    static let defaultEasing: Easing = .smooth

    /// 余额低于该值（元）时提醒；0 = 关闭
    static let lowBalanceRange: ClosedRange<Double> = 0...50
    static let defaultLowBalance: Double = 10
    /// 单次消耗超过该值（元）时提醒；0 = 关闭
    static let burnRange: ClosedRange<Double> = 0...20
    static let defaultBurn: Double = 2
    /// 提醒卡片自动停留时长（秒）
    static let alertDurationRange: ClosedRange<Double> = 2...20
    static let defaultAlertDuration: Double = 6

    @Published var animationDuration: Double { didSet { persist() } }
    @Published var easing: Easing { didSet { persist() } }
    @Published var lowBalanceThreshold: Double { didSet { persist() } }
    @Published var burnThreshold: Double { didSet { persist() } }
    @Published var alertDuration: Double { didSet { persist() } }
    @Published var presentation: Presentation { didSet { persist() } }
    @Published var launchAtLogin: Bool { didSet { persist() } }
    /// 刘海形态下是否显示菜单栏图标（存在感与退出入口）
    @Published var showMenuBarIcon: Bool { didSet { persist() } }
    /// 任务结束时发系统通知（kind = turn-end）
    @Published var notifyTaskDone: Bool { didSet { persist() } }
    /// 需要用户处理时发系统通知（kind = attention）
    @Published var notifyAttention: Bool { didSet { persist() } }

    private enum Key {
        static let duration = "dshNotch.animationDuration"
        static let easing = "dshNotch.easing"
        static let lowBalance = "dshNotch.lowBalanceThreshold"
        static let burn = "dshNotch.burnThreshold"
        static let alertDuration = "dshNotch.alertDuration"
        static let presentation = "dshNotch.presentation"
        static let launchAtLogin = "dshNotch.launchAtLogin"
        static let showMenuBarIcon = "dshNotch.showMenuBarIcon"
        static let notifyTaskDone = "dshNotch.notifyTaskDone"
        static let notifyAttention = "dshNotch.notifyAttention"
    }

    init() {
        let defaults = UserDefaults.standard

        animationDuration = Self.stored(defaults, Key.duration,
                                        fallback: Self.defaultDuration, range: Self.durationRange)
        easing = Easing(rawValue: defaults.string(forKey: Key.easing) ?? "") ?? Self.defaultEasing
        lowBalanceThreshold = Self.stored(defaults, Key.lowBalance,
                                          fallback: Self.defaultLowBalance, range: Self.lowBalanceRange)
        burnThreshold = Self.stored(defaults, Key.burn,
                                    fallback: Self.defaultBurn, range: Self.burnRange)
        alertDuration = Self.stored(defaults, Key.alertDuration,
                                    fallback: Self.defaultAlertDuration, range: Self.alertDurationRange)
        presentation = Presentation(rawValue: defaults.string(forKey: Key.presentation) ?? "") ?? .automatic
        launchAtLogin = defaults.bool(forKey: Key.launchAtLogin)
        // 默认开：没有它，刘海形态下应用启动了也看不出任何迹象
        showMenuBarIcon = defaults.object(forKey: Key.showMenuBarIcon) as? Bool ?? true
        // 通知两项默认都开：用户装这个应用就是为了「不知道的时候能被告知」，
        // 默认关掉等于新功能不存在。
        notifyTaskDone = defaults.object(forKey: Key.notifyTaskDone) as? Bool ?? true
        notifyAttention = defaults.object(forKey: Key.notifyAttention) as? Bool ?? true
    }

    private static func stored(_ defaults: UserDefaults, _ key: String,
                               fallback: Double, range: ClosedRange<Double>) -> Double {
        guard defaults.object(forKey: key) != nil else { return fallback }
        return min(max(defaults.double(forKey: key), range.lowerBound), range.upperBound)
    }

    var isDefault: Bool {
        abs(animationDuration - Self.defaultDuration) < 0.001
            && easing == Self.defaultEasing
            && abs(lowBalanceThreshold - Self.defaultLowBalance) < 0.001
            && abs(burnThreshold - Self.defaultBurn) < 0.001
            && abs(alertDuration - Self.defaultAlertDuration) < 0.001
            && presentation == .automatic
            && !launchAtLogin
            && showMenuBarIcon
            && notifyTaskDone
            && notifyAttention
    }

    func reset() {
        animationDuration = Self.defaultDuration
        easing = Self.defaultEasing
        lowBalanceThreshold = Self.defaultLowBalance
        burnThreshold = Self.defaultBurn
        alertDuration = Self.defaultAlertDuration
        presentation = .automatic
        showMenuBarIcon = true
        notifyTaskDone = true
        notifyAttention = true
    }

    private func persist() {
        let defaults = UserDefaults.standard
        defaults.set(animationDuration, forKey: Key.duration)
        defaults.set(easing.rawValue, forKey: Key.easing)
        defaults.set(lowBalanceThreshold, forKey: Key.lowBalance)
        defaults.set(burnThreshold, forKey: Key.burn)
        defaults.set(alertDuration, forKey: Key.alertDuration)
        defaults.set(presentation.rawValue, forKey: Key.presentation)
        defaults.set(launchAtLogin, forKey: Key.launchAtLogin)
        defaults.set(showMenuBarIcon, forKey: Key.showMenuBarIcon)
        defaults.set(notifyTaskDone, forKey: Key.notifyTaskDone)
        defaults.set(notifyAttention, forKey: Key.notifyAttention)
    }

    // MARK: - 展示

    static func money(_ value: Double) -> String {
        value <= 0 ? "已关闭" : "¥" + AmountFormat.string(Decimal(value))
    }

    static func seconds(_ value: Double) -> String {
        "\(Int(value)) 秒"
    }

    static func duration(_ value: Double) -> String {
        String(format: "%.2f 秒", value)
    }
}
