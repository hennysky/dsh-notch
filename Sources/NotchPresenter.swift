import AppKit
import Combine
import SwiftUI

/// 呈现形态的公共接口。协调器只认这个，不关心底下是刘海还是菜单栏。
@MainActor
protocol BalancePresenting: AnyObject {
    func start()
    /// 额度提醒
    func presentAlert(_ alert: BalanceAlert)
    /// 从菜单栏图标唤出卡片
    func showCard()
    /// 从菜单栏图标直接进设置
    func openSettings()
    func tearDown()
}

// MARK: - 刘海形态

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

/// 接管「刘海带」上的点击：折叠时点它展开，展开时点它收起。
/// 其余区域的点击照常交给 SwiftUI（刷新、设置、充值按钮要能按）。
final class ClickHostingView<Content: View>: NSHostingView<Content> {
    var onNotchBandClick: (() -> Void)?
    /// 窗口顶端那一条刘海带的高度
    var notchBandHeight: CGFloat = 32

    /// 刘海带永远可点。
    ///
    /// 折叠态窗口只有 32pt 高，里面除了一层 `Color.clear` 什么都没有；
    /// `NSHostingView.hitTest` 在这种状态下返回 nil，真实点击会直接穿透到下层，
    /// 到不了 `mouseDown` —— 表现就是「点刘海没反应」，而展开态因为更高而正常。
    /// 这里显式把这条带子判给自己，不再依赖 SwiftUI 的命中语义。
    ///
    /// 这个 bug 在 v1.0 上线后才被发现，因为当时的 `--clicktest` 是直接调
    /// `mouseDown(for:)`，**绕过了命中测试**。现在自检里加了 hitTest 断言。
    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        if local.y >= bounds.height - notchBandHeight, bounds.contains(local) {
            return self
        }
        return super.hitTest(point)
    }

    override func mouseDown(with event: NSEvent) {
        let local = event.locationInWindow
        if local.y >= bounds.height - notchBandHeight {
            dshLog("点击刘海带 (y=\(Int(local.y)) / 窗口高 \(Int(bounds.height)))")
            onNotchBandClick?()
            return
        }
        super.mouseDown(with: event)
    }
}

@MainActor
final class NotchPresenter: BalancePresenting {
    private let model: BalanceModel
    private let settings: NotchSettings

    private var panel: NotchPanel?
    private var host: ClickHostingView<CardRootView>?
    private var geometry: NotchGeometry?
    private var cancellables = Set<AnyCancellable>()
    private var clickOutsideMonitor: Any?
    private var state = CardState()
    private var alertCollapseWork: DispatchWorkItem?

    private let unread: UnreadStore

    init(model: BalanceModel, settings: NotchSettings, unread: UnreadStore) {
        self.model = model
        self.settings = settings
        self.unread = unread
    }

    func start() {
        state = CardState()
        rebuild()
        installClickOutsideMonitor()

        // 视图内容：objectWillChange 在属性【写入之前】触发，必须跳到下一个
        // runloop 周期，等值真正落定后再重建视图树，否则拿到的永远是旧值。
        model.objectWillChange
            .sink { [weak self] in DispatchQueue.main.async { self?.refreshContent() } }
            .store(in: &cancellables)

        settings.objectWillChange
            .sink { [weak self] in DispatchQueue.main.async { self?.refreshContent() } }
            .store(in: &cancellables)

        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.rebuild() }
        }
    }

    func tearDown() {
        alertCollapseWork?.cancel()
        clickOutsideMonitor.map { NSEvent.removeMonitor($0) }
        clickOutsideMonitor = nil
        cancellables.removeAll()
        panel?.orderOut(nil)
        panel?.contentView = nil
        panel = nil
        host = nil
        geometry = nil
        dshLog("刘海形态已拆除")
    }

    /// 屏幕变化（插拔显示器、改分辨率）时重建面板
    func rebuild() {
        guard let geometry = NotchGeometryResolver.resolve() else {
            dshLog("⚠️ 没有可用的刘海屏，刘海形态无法呈现")
            return
        }
        self.geometry = geometry
        dshLog("rebuild 折叠=\(geometry.collapsedFrame) 展开=\(geometry.expandedFrame)")

        panel?.orderOut(nil)
        panel?.contentView = nil

        let panel = NotchPanel.configured(contentRect: geometry.collapsedFrame)
        dshLog("面板层级 = \(panel.level.rawValue)（菜单栏是 \(NSWindow.Level.mainMenu.rawValue)）")

        let host = ClickHostingView(rootView: makeRootView(geometry))
        host.sizingOptions = []
        host.notchBandHeight = geometry.notch.height
        host.onNotchBandClick = { [weak self] in self?.toggle() }
        panel.contentView = host

        panel.setFrame(state.isExpanded ? geometry.expandedFrame(calendar: state.showCalendar) : geometry.collapsedFrame, display: true)
        panel.orderFrontRegardless()

        self.panel = panel
        self.host = host

        // 诊断：沿用 SafeArea 的值确认 ignoresSafeArea 是否必要
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak host] in
            guard let host else { return }
            dshLog("宿主视图 安全区=\(host.safeAreaInsets) bounds=\(host.bounds)")
        }
    }

    private func makeRootView(_ geometry: NotchGeometry) -> CardRootView {
        CardRootView(model: model,
                     settings: settings,
                     chrome: geometry.chrome,
                     state: state,
                     actions: makeActions())
    }

    private func makeActions() -> CardActions {
        CardActions(toggleSettings: { [weak self] in self?.toggleSettings() },
                    toggleCalendar: { [weak self] in self?.toggleCalendar() },
                    selectMetric: { [weak self] metric in self?.selectMetric(metric) },
                    selectTab: { [weak self] tab in self?.select(tab) },
                    topUp: { [weak self] in self?.openTopUpPage() },
                    quit: { NSApp.terminate(nil) })
    }

    /// 强制重建视图树。SwiftUI 的 @ObservedObject 传播不会刷新这棵由
    /// NSHostingView 手工托管的树，所以每次状态变化都显式重建一次。
    private func refreshContent() {
        guard let geometry, let host else { return }
        host.rootView = makeRootView(geometry)
    }

    // MARK: - 交互

    func toggle() {
        cancelAlertAutoCollapse()
        // 打开卡片 = 用户来看结果了，未读红点没有继续存在的理由
        unread.clear()
        setExpanded(!model.isExpanded)
    }

    func showCard() {
        cancelAlertAutoCollapse()
        unread.clear()
        setExpanded(true)
    }

    func openSettings() {
        cancelAlertAutoCollapse()
        unread.clear()
        state.showSettings = true
        setExpanded(true)
    }

    func setExpanded(_ expanded: Bool) {
        dshLog("setExpanded(\(expanded))")
        model.isExpanded = expanded
        // 点开时就该看到最新余额，不能等下一次 5 分钟轮询
        if expanded { model.refreshIfStale() }

        // 内容状态故意滞后于窗口状态：
        // 展开时立刻置位，让窗口动画把卡片「拉」出来；
        // 收起时留到动画结束后再撤，否则卡片会在动画一开始就消失，
        // 只剩一个空窗口在缩小——表现就是「收起没有动画」。
        if expanded {
            state.isExpanded = true
            refreshContent()
        }

        guard let panel, let geometry else { return }
        animate(panel: panel,
                to: expanded ? geometry.expandedFrame(calendar: state.showCalendar) : geometry.collapsedFrame,
                duration: settings.animationDuration,
                completion: { [weak self] in
                    guard let self, self.model.isExpanded == expanded else { return }
                    self.state.isExpanded = expanded
                    self.refreshContent()
                })
    }

    private func select(_ tab: SettingsTab) {
        state.settingsTab = tab
        refreshContent()
    }

    func toggleCalendar() {
        cancelAlertAutoCollapse()
        unread.clear()
        state.showCalendar.toggle()
        if state.showCalendar { state.showSettings = false }
        dshLog("用量日历 \(state.showCalendar ? "打开" : "关闭")（刘海）")
        refreshContent()
        resizeForCurrentMode()
    }

    func selectMetric(_ metric: ActivityMetric) {
        state.calendarMetric = metric
        dshLog("用量日历口径：\(metric.label)（刘海）")
        refreshContent()
    }

    /// 日历页/余额页窗口尺寸不同：切页时把窗口补间到新尺寸。
    private func resizeForCurrentMode() {
        guard let panel, let geometry, model.isExpanded else { return }
        animate(panel: panel,
                to: geometry.expandedFrame(calendar: state.showCalendar),
                duration: settings.animationDuration)
    }

    func toggleSettings() {
        cancelAlertAutoCollapse()
        state.showSettings.toggle()
        dshLog("设置页 \(state.showSettings ? "打开" : "关闭")")
        refreshContent()
    }

    /// 打开平台充值页。用系统浏览器，沿用那边的登录态；链接不含任何 token。
    func openTopUpPage() {
        let url = model.topUpURL
        dshLog("打开充值页：\(url.absoluteString)")
        NSWorkspace.shared.open(url)
    }

    // MARK: - 提醒

    /// 弹出卡片展示提醒，停留设定时长后自动收起。
    /// 如果卡片本来就是展开的（用户正在看），只更新内容，不动窗口。
    func presentAlert(_ alert: BalanceAlert) {
        let wasExpanded = model.isExpanded
        dshLog("额度提醒：\(alert.title)（卡片原本\(wasExpanded ? "已展开" : "折叠")）")

        state.alert = alert
        refreshContent()

        guard !wasExpanded else { return }
        setExpanded(true)

        alertCollapseWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.state.alert = nil
            self.refreshContent()
            if self.model.isExpanded { self.setExpanded(false) }
            dshLog("提醒展示结束，自动收起")
        }
        alertCollapseWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + settings.alertDuration, execute: work)
    }

    private func cancelAlertAutoCollapse() {
        guard alertCollapseWork != nil || state.alert != nil else { return }
        alertCollapseWork?.cancel()
        alertCollapseWork = nil
        state.alert = nil
        refreshContent()
    }

    // MARK: - 动画

    /// 动画时长/曲线由设置页决定，用 NSAnimationContext 才能控制到具体数值
    /// （`setFrame(_:display:animate:)` 的时长是系统固定的，改不了）。
    private func animate(panel: NSPanel, to target: NSRect, duration: Double,
                         completion: (() -> Void)? = nil) {
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
