import AppKit
import Foundation

/// 刘海几何。坐标为 AppKit 屏幕坐标（原点在左下角）。
struct NotchGeometry {
    let screen: NSScreen
    /// 刘海矩形（无刘海屏时为模拟出来的顶部中央区域）
    let notch: NSRect
    /// 这块屏幕是否真的有刘海
    let hasRealNotch: Bool

    var screenTop: CGFloat { screen.frame.maxY }

    /// 折叠态窗口 = 刘海本身（左右各外扩 4pt）。
    /// 平时不画任何东西，刘海就是鼠标进入的触发区；外扩一点是为了
    /// ① 覆盖窗口对齐到 2x 像素网格时的 0.5pt 取整误差
    /// ② 让鼠标更容易命中——刘海只有 185×32pt，太窄会很难戳中。
    var collapsedFrame: NSRect { notch.insetBy(dx: -4, dy: 0) }

    static let expandedWidth: CGFloat = 300
    /// 余额页高度
    static let balanceCardHeight: CGFloat = 186
    /// 设置页要放 3 个滑杆 + 分段控件，比余额页高
    static let settingsCardHeight: CGFloat = 236

    func cardHeight(showSettings: Bool) -> CGFloat {
        showSettings ? Self.settingsCardHeight : Self.balanceCardHeight
    }

    /// 展开态窗口：从屏幕顶端向下铺开，顶部与刘海连成一体，底部圆角。
    func expandedFrame(showSettings: Bool) -> NSRect {
        let card = cardHeight(showSettings: showSettings)
        return NSRect(x: notch.midX - Self.expandedWidth / 2,
                      y: screenTop - notch.height - card,
                      width: Self.expandedWidth,
                      height: notch.height + card)
    }
}

enum NotchGeometryResolver {
    /// 优先选带刘海的内置屏；都没有就在主屏顶部中央模拟一个。
    static func resolve() -> NotchGeometry? {
        if let notched = NSScreen.screens.first(where: isNotched) {
            return geometry(for: notched, real: true)
        }
        guard let fallback = NSScreen.main ?? NSScreen.screens.first else { return nil }
        return geometry(for: fallback, real: false)
    }

    static func isNotched(_ screen: NSScreen) -> Bool {
        guard let left = screen.auxiliaryTopLeftArea,
              let right = screen.auxiliaryTopRightArea else { return false }
        let width = screen.frame.width - left.width - right.width
        return width > 1 && screen.safeAreaInsets.top > 1
    }

    static func geometry(for screen: NSScreen, real: Bool) -> NotchGeometry {
        let top = screen.frame.maxY
        if real, let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
            let width = screen.frame.width - left.width - right.width
            let height = screen.safeAreaInsets.top
            let rect = NSRect(x: screen.frame.minX + left.width, y: top - height,
                              width: width, height: height)
            return NotchGeometry(screen: screen, notch: rect, hasRealNotch: true)
        }
        // 无刘海屏：模拟一个顶部居中的刘海，尺寸取内置屏实测值
        let width: CGFloat = 185
        let height: CGFloat = 24
        let rect = NSRect(x: screen.frame.midX - width / 2, y: top - height,
                          width: width, height: height)
        return NotchGeometry(screen: screen, notch: rect, hasRealNotch: false)
    }
}
