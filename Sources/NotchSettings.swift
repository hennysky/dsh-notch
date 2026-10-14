import AppKit
import QuartzCore
import SwiftUI

/// 可调参数。写入 UserDefaults，重启后保持。
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

    static let durationRange: ClosedRange<Double> = 0.1...1.5
    static let defaultDuration: Double = 0.45
    static let defaultEasing: Easing = .smooth

    @Published var animationDuration: Double { didSet { persist() } }
    @Published var easing: Easing { didSet { persist() } }

    private static let durationKey = "dshNotch.animationDuration"
    private static let easingKey = "dshNotch.easing"

    init() {
        let stored = UserDefaults.standard.double(forKey: Self.durationKey)
        if stored > 0 {
            animationDuration = min(max(stored, Self.durationRange.lowerBound),
                                    Self.durationRange.upperBound)
        } else {
            animationDuration = Self.defaultDuration
        }
        easing = Easing(rawValue: UserDefaults.standard.string(forKey: Self.easingKey) ?? "")
            ?? Self.defaultEasing
    }

    var isDefault: Bool {
        abs(animationDuration - Self.defaultDuration) < 0.001 && easing == Self.defaultEasing
    }

    func reset() {
        animationDuration = Self.defaultDuration
        easing = Self.defaultEasing
    }

    private func persist() {
        UserDefaults.standard.set(animationDuration, forKey: Self.durationKey)
        UserDefaults.standard.set(easing.rawValue, forKey: Self.easingKey)
    }
}
