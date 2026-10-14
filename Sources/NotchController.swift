import AppKit
import Combine
import SwiftUI

/// 诊断日志。设置环境变量 DSH_NOTCH_DEBUG=1 后输出到 stderr。
private let dshLogFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "HH:mm:ss.SSS"
    return f
}()

func dshLog(_ message: String) {
    guard ProcessInfo.processInfo.environment["DSH_NOTCH_DEBUG"] == "1" else { return }
    let line = "[dsh-notch \(dshLogFormatter.string(from: Date()))] " + message + "\n"
    FileHandle.standardError.write(Data(line.utf8))
}

// MARK: - 面板

/// 覆盖刘海的无边框面板。
final class NotchPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    /// 关键：NSWindow 默认会把 frame 约束在屏幕的 visibleFrame 内，而 visibleFrame
    /// **不包含菜单栏**。结果窗口被系统整体下推 33pt，折叠窗口落在 y 917–949，
    /// 而刘海在 y 950–982——鼠标根本进不到窗口里。
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        frameRect
    }

    /// 面向菜单栏的窗口层级。菜单栏是 .mainMenu(24)。
    static let aboveMenuBarLevel = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 2)

    /// 统一的面板配置入口。控制器与 `--panelcheck` 共用同一份，自检才有意义。
    static func configured(contentRect: NSRect) -> NotchPanel {
        let panel = NotchPanel(contentRect: contentRect,
                               styleMask: [.borderless, .nonactivatingPanel],
                               backing: .buffered,
                               defer: false)

        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.isMovable = false
        panel.isMovableByWindowBackground = false
        panel.hidesOnDeactivate = false
        panel.animationBehavior = .none
        panel.becomesKeyOnlyIfNeeded = true
        panel.ignoresMouseEvents = false

        // 不要设 isFloatingPanel = true —— 它会把窗口层级强制改回 floating(3)，
        // 把下面这行覆盖掉。层级 3 低于菜单栏(24)，窗口会被压在菜单栏底下看不见。
        panel.level = aboveMenuBarLevel
        return panel
    }
}

// MARK: - 承担点击的视图

/// 接管「刘海带」上的点击：折叠时点它展开，展开时点它收起。
/// 其余区域的点击照常交给 SwiftUI（刷新按钮、设置按钮要能按）。
final class ClickHostingView<Content: View>: NSHostingView<Content> {
    var onNotchBandClick: (() -> Void)?
    /// 窗口顶端那一条刘海带的高度
    var notchBandHeight: CGFloat = 32

    override func mouseDown(with event: NSEvent) {
        // locationInWindow 的原点在窗口左下角；刘海带贴窗口顶端
        let local = event.locationInWindow
        if local.y >= bounds.height - notchBandHeight {
            dshLog("点击刘海带 (y=\(Int(local.y)) / 窗口高 \(Int(bounds.height)))")
            onNotchBandClick?()
            return
        }
        super.mouseDown(with: event)
    }
}

// MARK: - 可见性诊断

/// 让应用把自己视图层级画进位图并统计非透明像素（不需要屏幕录制权限）。
/// 返回 -1 表示无法渲染。
func opaquePixelCount(_ view: NSView, sampleStride: Int = 4) -> Int {
    guard view.bounds.width > 1, view.bounds.height > 1,
          let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return -1 }
    view.cacheDisplay(in: view.bounds, to: rep)
    var count = 0
    for y in stride(from: 0, to: rep.pixelsHigh, by: sampleStride) {
        for x in stride(from: 0, to: rep.pixelsWide, by: sampleStride) {
            if let color = rep.colorAt(x: x, y: y), color.alphaComponent > 0.05 { count += 1 }
        }
    }
    return count
}

func dumpViewContent(_ view: NSView, to path: String) {
    guard view.bounds.width > 1, view.bounds.height > 1,
          let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
    view.cacheDisplay(in: view.bounds, to: rep)
    guard let png = rep.representation(using: .png, properties: [:]) else { return }
    try? png.write(to: URL(fileURLWithPath: path))
}

/// 窗口服务器眼里的真实情况。frame 正确不代表真的显示在屏幕上。
func windowServerReport(pid: pid_t) -> String {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                                kCGNullWindowID) as? [[String: Any]] else {
        return "读不到窗口列表"
    }
    let mine = list.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid }
    guard !mine.isEmpty else { return "❌ 窗口服务器里没有本进程的窗口" }
    return mine.map { dict in
        let bounds = dict[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
        let layer = dict[kCGWindowLayer as String] as? Int ?? -999
        return "layer=\(layer) bounds=[x:\(bounds["X"] ?? 0) y:\(bounds["Y"] ?? 0) w:\(bounds["Width"] ?? 0) h:\(bounds["Height"] ?? 0)]"
    }.joined(separator: " || ")
}

// MARK: - 控制器

@MainActor
final class NotchController {
    let settings = NotchSettings()
    /// 依赖 settings，所以用 lazy
    lazy var model = BalanceModel(settings: settings)

    private var panel: NotchPanel?
    private var host: ClickHostingView<NotchRootView>?
    private var geometry: NotchGeometry?
    private var cancellables = Set<AnyCancellable>()
    private var clickOutsideMonitor: Any?
    private var showSettings = false
    /// 正在展示的提醒。非 nil 时卡片上会显示提醒文案。
    private var pendingAlert: BalanceAlert?
    /// 提醒卡片的自动收起任务
    private var alertCollapseWork: DispatchWorkItem?
    /// 内容的展开状态，故意滞后于窗口状态：
    /// 展开时立刻置 true（让窗口把卡片「拉」出来），
    /// 收起时要等动画走完才置 false，否则卡片会在动画一开始就消失，看不到收起过程。
    private var contentExpanded = false

    deinit { dshLog("!!! NotchController deinit") }

    func start() {
        dshLog("start() 动画 \(settings.animationDuration)s / \(settings.easing.rawValue)"
               + " 提醒 余额<\(settings.lowBalanceThreshold)/消耗>\(settings.burnThreshold) 停留\(settings.alertDuration)s")
        model.onAlert = { [weak self] alert in self?.presentAlert(alert) }
        model.start()

        // 窗口 frame：用发布出来的新值（willSet 时机，值本身是对的）
        model.$isExpanded
            .removeDuplicates()
            .sink { [weak self] expanded in self?.applyExpansion(expanded) }
            .store(in: &cancellables)

        // 视图内容：objectWillChange 在属性【写入之前】触发，必须跳到下一个
        // runloop 周期，等值真正落定后再重建视图树，否则拿到的永远是旧值。
        model.objectWillChange
            .sink { [weak self] in
                DispatchQueue.main.async { self?.refreshContent() }
            }
            .store(in: &cancellables)

        settings.objectWillChange
            .sink { [weak self] in
                DispatchQueue.main.async { self?.refreshContent() }
            }
            .store(in: &cancellables)

        rebuild()
        installClickOutsideMonitor()

        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.rebuild() }
        }

        // 调试用：DSH_NOTCH_TEST_ALERT=5 表示启动 5 秒后模拟一次额度提醒，
        // 用来即时验证「弹出 → 停留 → 自动收起」这套动作，不用等余额真的跌破。
        if let raw = ProcessInfo.processInfo.environment["DSH_NOTCH_TEST_ALERT"],
           let delay = Double(raw) {
            dshLog("TEST_ALERT：\(delay)s 后模拟一次提醒")
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self else { return }
                let current = self.model.snapshot?.primary?.amount ?? Decimal(8.42)
                let symbol = self.model.snapshot?.primary?.symbol ?? "¥"
                self.presentAlert(BalanceAlert(kind: .lowBalance(threshold: Decimal(10)),
                                               symbol: symbol,
                                               current: current,
                                               at: Date()))
            }
        }

        if ProcessInfo.processInfo.environment["DSH_NOTCH_FORCE_EXPAND"] == "1" {
            dshLog("FORCE_EXPAND：强制常驻展开")
            model.isExpanded = true
        }
    }

    func rebuild() {
        guard let geometry = NotchGeometryResolver.resolve() else { return }
        self.geometry = geometry
        dshLog("rebuild 折叠=\(geometry.collapsedFrame) 展开=\(geometry.expandedFrame)")

        panel?.orderOut(nil)
        panel?.contentView = nil

        let panel = NotchPanel.configured(contentRect: geometry.collapsedFrame)
        dshLog("面板层级 = \(panel.level.rawValue)（菜单栏是 \(NSWindow.Level.mainMenu.rawValue)）")

        let host = ClickHostingView(rootView: makeRootView(geometry))
        host.sizingOptions = []          // 不让 SwiftUI 内容反过来约束窗口尺寸
        host.notchBandHeight = geometry.notch.height
        host.onNotchBandClick = { [weak self] in self?.toggle() }
        panel.contentView = host

        panel.setFrame(geometry.collapsedFrame, display: true)
        panel.orderFrontRegardless()

        self.panel = panel
        self.host = host
    }

    private func makeRootView(_ geometry: NotchGeometry) -> NotchRootView {
        NotchRootView(model: model,
                      settings: settings,
                      geometry: geometry,
                      isExpanded: contentExpanded,
                      showSettings: showSettings,
                      alert: pendingAlert,
                      onToggleSettings: { [weak self] in self?.toggleSettings() },
                      onTopUp: { [weak self] in self?.openTopUpPage() })
    }

    /// 强制重建视图树。SwiftUI 的 @ObservedObject 传播不会刷新这棵由
    /// NSHostingView 手工托管的树，所以每次状态变化都显式重建一次。
    private func refreshContent() {
        guard let geometry, let host else { return }
        host.rootView = makeRootView(geometry)
    }

    // MARK: - 交互

    /// 点击刘海带：折叠 → 展开；展开 → 收起。
    func toggle() {
        // 用户一旦动手，就撤掉提醒的自动收起，让手动操作说了算
        cancelAlertAutoCollapse()
        setExpanded(!model.isExpanded)
    }

    func setExpanded(_ expanded: Bool) {
        dshLog("setExpanded(\(expanded))")
        model.isExpanded = expanded
    }

    /// 打开平台充值页。用系统浏览器，沿用那边的登录态；链接不含任何 token。
    func openTopUpPage() {
        let url = model.topUpURL
        dshLog("打开充值页：\(url.absoluteString)")
        NSWorkspace.shared.open(url)
    }

    func toggleSettings() {
        cancelAlertAutoCollapse()
        showSettings.toggle()
        dshLog("设置页 \(showSettings ? "打开" : "关闭")")
        refreshContent()
        // 两个页面的卡片高度不同，展开状态下要跟着变
        if model.isExpanded { applyExpansion(true) }
    }

    // MARK: - 额度提醒

    /// 弹出卡片展示提醒，停留设定时长后自动收起。
    /// 如果卡片本来就是展开的（用户正在看），只更新内容，不动窗口。
    private func presentAlert(_ alert: BalanceAlert) {
        let wasExpanded = model.isExpanded
        dshLog("额度提醒：\(alert.title)（卡片原本\(wasExpanded ? "已展开" : "折叠")）")

        pendingAlert = alert
        refreshContent()

        guard !wasExpanded else { return }

        setExpanded(true)

        alertCollapseWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pendingAlert = nil
            self.refreshContent()
            if self.model.isExpanded { self.setExpanded(false) }
            dshLog("提醒展示结束，自动收起")
        }
        alertCollapseWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + settings.alertDuration, execute: work)
    }

    private func cancelAlertAutoCollapse() {
        guard alertCollapseWork != nil || pendingAlert != nil else { return }
        alertCollapseWork?.cancel()
        alertCollapseWork = nil
        pendingAlert = nil
        refreshContent()
    }

    private func applyExpansion(_ expanded: Bool) {
        guard let panel, let geometry else { return }
        let target = expanded ? geometry.expandedFrame(showSettings: showSettings) : geometry.collapsedFrame
        let duration = settings.animationDuration

        dshLog("applyExpansion \(expanded) 目标=\(target) 时长=\(duration)s 缓动=\(settings.easing.rawValue)")

        // 展开：内容先就位，由窗口动画把它「拉」出来
        if expanded {
            contentExpanded = true
            refreshContent()
        }

        // 收起：内容留到动画结束后再撤，这样才看得到卡片收进刘海的过程
        animate(panel: panel, to: target, duration: duration) { [weak self] in
            guard let self, self.model.isExpanded == expanded else { return }  // 期间又切换了就不管
            self.contentExpanded = expanded
            self.refreshContent()
            dshLog("动画结束，内容状态=\(expanded ? "展开" : "折叠")")
        }

        // 检查窗口落点要等动画真正走完
        let delay = max(0.6, duration + 0.35)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, let panel = self.panel, let host = self.host else { return }
            let actual = panel.frame
            let ok = abs(actual.minX - target.minX) < 1 && abs(actual.minY - target.minY) < 1
                && abs(actual.width - target.width) < 1 && abs(actual.height - target.height) < 1
            let stamp = String(format: "%.2f", delay)
            dshLog("\(stamp)s 后 frame=\(actual) \(ok ? "✓" : "✗ 与目标不一致") 内容非透明像素=\(opaquePixelCount(host))")
            if expanded {
                dumpViewContent(host, to: "/tmp/dsh-notch-card.png")
            }
        }
    }

    /// 动画时长/曲线由设置页决定，用 NSAnimationContext 才能控制到具体数值
    /// （`setFrame(_:display:animate:)` 的时长是系统固定的，改不了）。
    private func animate(panel: NSPanel, to target: NSRect, duration: Double, completion: (() -> Void)? = nil) {
        guard duration > 0.01 else {
            panel.setFrame(target, display: true)
            completion?()
            return
        }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = duration
            context.timingFunction = settings.easing.timingFunction
            panel.animator().setFrame(target, display: true)
        }, completionHandler: {
            MainActor.assumeIsolated { completion?() }
        })
    }

    /// 点卡片外面也收起（best effort：鼠标事件的全局监听不需要辅助功能权限，
    /// 万一系统不给，点刘海带依然能收起）。
    private func installClickOutsideMonitor() {
        clickOutsideMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.model.isExpanded, let panel = self.panel else { return }
                if !panel.frame.contains(NSEvent.mouseLocation) {
                    dshLog("点击卡片外部 → 收起")
                    self.setExpanded(false)
                }
            }
        }
        let state = clickOutsideMonitor == nil ? "未安装（可能缺权限）" : "已安装"
        dshLog("点击外部收起监听：\(state)")
    }
}
