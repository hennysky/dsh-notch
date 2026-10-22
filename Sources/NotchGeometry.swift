import AppKit
import Foundation

/// 刘海几何。坐标为 AppKit 屏幕坐标（原点在左下角）。
///
/// **只在真的有刘海时才会被构造。** 早期版本在没有刘海的屏上会模拟一块假刘海，
/// 结果 Mac mini、iMac、纯外接屏用户屏幕顶上凭空多出一条黑条——
/// 那些机器改用菜单栏形态（见 `MenuBarPresenter`）。
struct NotchGeometry {
    let screen: NSScreen
    /// 刘海矩形
    let notch: NSRect

    var screenTop: CGFloat { screen.frame.maxY }

    static let cardWidth: CGFloat = 300
    /// 余额页与设置页统一高度。设置页分页之后两页内容都能装下，
    /// 统一高度省掉了「切页要改窗口尺寸」这一层状态。
    static let cardHeight: CGFloat = 224

    /// 日历页把同一张卡片拉大：300×224 里 13 周的格子只有几 pt，放大才看得清。
    static let calendarWidth: CGFloat = 380
    static let calendarHeight: CGFloat = 390

    static func cardSize(calendar: Bool) -> NSSize {
        calendar
            ? NSSize(width: calendarWidth, height: calendarHeight)
            : NSSize(width: cardWidth, height: cardHeight)
    }

    /// 折叠态窗口 = 刘海本身（左右各外扩 4pt）。
    /// 平时不画任何东西，刘海就是鼠标进入的触发区；外扩一点是为了
    /// ① 覆盖窗口对齐到 2x 像素网格时的 0.5pt 取整误差
    /// ② 让鼠标更容易命中——刘海只有 185×32pt，太窄会很难戳中。
    var collapsedFrame: NSRect { notch.insetBy(dx: -4, dy: 0) }

    /// 展开态窗口：从屏幕顶端向下铺开，顶部与刘海连成一体，底部圆角。
    var expandedFrame: NSRect { expandedFrame(calendar: false) }

    /// 日历页用更大的窗口；余额/设置页保持原尺寸。
    func expandedFrame(calendar: Bool) -> NSRect {
        let size = Self.cardSize(calendar: calendar)
        return NSRect(x: notch.midX - size.width / 2,
                      y: screenTop - notch.height - size.height,
                      width: size.width,
                      height: notch.height + size.height)
    }

    var chrome: CardChrome { .notch(topInset: notch.height) }
}

enum NotchGeometryResolver {
    /// 当前可用的刘海屏。合盖用外屏时内置屏不在 `NSScreen.screens` 里，自然为 nil。
    static func resolve() -> NotchGeometry? {
        guard let screen = PresentationResolver.notchedScreen(among: NSScreen.screens) else { return nil }
        return geometry(for: screen)
    }

    static func geometry(for screen: NSScreen) -> NotchGeometry? {
        guard let left = screen.auxiliaryTopLeftArea,
              let right = screen.auxiliaryTopRightArea else { return nil }
        let width = screen.frame.width - left.width - right.width
        let height = screen.safeAreaInsets.top
        guard width > 1, height > 1 else { return nil }
        let rect = NSRect(x: screen.frame.minX + left.width,
                          y: screen.frame.maxY - height,
                          width: width, height: height)
        return NotchGeometry(screen: screen, notch: rect)
    }
}
