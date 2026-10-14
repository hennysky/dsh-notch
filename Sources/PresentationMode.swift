import AppKit
import Foundation

/// 应用该用哪种形态呈现。
enum EffectivePresentation: String {
    case notch
    case menuBar
}

/// 形态判定。纯逻辑，便于 `--modecheck` 自检。
///
/// 关键：**不在安装时问用户，运行时判断**。
/// 显示配置会变——接外屏、合盖用外屏（内置屏会从 NSScreen.screens 消失）、拔线——
/// 安装时写死一次，之后全是错的。
enum PresentationResolver {
    /// 某块屏幕是否真的有刘海：辅助区域存在且宽度 > 0。
    static func hasNotch(_ screen: NSScreen) -> Bool {
        guard let left = screen.auxiliaryTopLeftArea,
              let right = screen.auxiliaryTopRightArea else { return false }
        return screen.frame.width - left.width - right.width > 1
            && screen.safeAreaInsets.top > 1
    }

    /// 当前可用的刘海屏。合盖时内置屏不在列表里，自然为 nil。
    static func notchedScreen(among screens: [NSScreen]) -> NSScreen? {
        screens.first(where: hasNotch)
    }

    /// 决定最终形态。
    ///
    /// - 手动指定「仅刘海」但没有刘海屏时，退回菜单栏形态而不是什么都不显示
    ///   （用户此刻正看着一块没有刘海的屏，什么都不显示等于功能消失）。
    static func resolve(preference: NotchSettings.Presentation,
                        screens: [NSScreen]) -> (mode: EffectivePresentation, fellBack: Bool) {
        let notched = notchedScreen(among: screens) != nil
        switch preference {
        case .notch:
            return notched ? (.notch, false) : (.menuBar, true)
        case .menuBar:
            return (.menuBar, false)
        case .automatic:
            return notched ? (.notch, false) : (.menuBar, false)
        }
    }
}
