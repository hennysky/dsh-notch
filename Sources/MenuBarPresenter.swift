import AppKit
import Combine
import SwiftUI

/// 菜单栏形态：`NSStatusItem` 直接显示余额，点开是一个 popover 卡片。
///
/// 这是无刘海机器（Mac mini、iMac、纯外接屏、合盖用外屏）的正确形态——
/// 早期版本在这些屏上会模拟一块假刘海，屏幕顶上凭空多出一条黑条。
@MainActor
final class MenuBarPresenter: NSObject, BalancePresenting {
    private let model: BalanceModel
    private let settings: NotchSettings

    private var statusItem: NSStatusItem?
    private var popover: NSPopover?
    private var hosting: NSHostingController<CardRootView>?
    private var cancellables = Set<AnyCancellable>()
    private var state = CardState()
    private var alertResetWork: DispatchWorkItem?

    init(model: BalanceModel, settings: NotchSettings) {
        self.model = model
        self.settings = settings
    }

    deinit { dshLog("!!! MenuBarPresenter deinit —— 状态栏项会被一并回收") }

    func start() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            button.target = self
            button.action = #selector(statusItemClicked)
        }
        statusItem = item

        let hosting = NSHostingController(rootView: makeRootView())
        hosting.view.frame = NSRect(x: 0, y: 0, width: Self.cardWidth, height: Self.cardHeight)

        let popover = NSPopover()
        popover.behavior = .transient
        popover.contentViewController = hosting
        popover.contentSize = NSSize(width: Self.cardWidth, height: Self.cardHeight)
        self.hosting = hosting
        self.popover = popover

        updateTitle()

        // objectWillChange 在属性写入【之前】触发，跳到下一个 runloop 周期才拿得到新值
        model.objectWillChange
            .sink { [weak self] in DispatchQueue.main.async { self?.refresh() } }
            .store(in: &cancellables)
        settings.objectWillChange
            .sink { [weak self] in DispatchQueue.main.async { self?.refresh() } }
            .store(in: &cancellables)

        // 状态栏项不通过 CGWindowList 暴露（你菜单栏里其它图标也一样），
        // 所以只能在进程内确认它真的挂上去了。
        if let button = statusItem?.button {
            let win = button.window
            dshLog("菜单栏形态已启动 title=\"\(button.attributedTitle.string)\" "
                   + "有窗口=\(win != nil) 可见=\(win?.isVisible ?? false) frame=\(win?.frame ?? .zero)")
        } else {
            dshLog("❌ 菜单栏形态启动失败：statusItem.button 为 nil")
        }
    }

    func tearDown() {
        alertResetWork?.cancel()
        cancellables.removeAll()
        if let popover, popover.isShown { popover.performClose(nil) }
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
        statusItem = nil
        popover = nil
        hosting = nil
        dshLog("菜单栏形态已拆除")
    }

    // MARK: - 尺寸

    private static var cardWidth: CGFloat { NotchGeometry.cardWidth }
    private static var cardHeight: CGFloat { NotchGeometry.cardHeight }

    private func makeRootView() -> CardRootView {
        CardRootView(model: model,
                     settings: settings,
                     chrome: .popover,
                     state: state,
                     actions: CardActions(toggleSettings: { [weak self] in self?.toggleSettings() },
                                          selectTab: { [weak self] tab in self?.select(tab) },
                                          topUp: { [weak self] in self?.openTopUpPage() },
                                          quit: { NSApp.terminate(nil) }))
    }

    private func refresh() {
        updateTitle()
        hosting?.rootView = makeRootView()
    }

    // MARK: - 菜单栏标题

    private func updateTitle() {
        guard let button = statusItem?.button else { return }
        let font = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize - 1, weight: .regular)

        let text: String
        let color: NSColor
        if let alert = state.alert {
            text = alert.menuBarText
            color = NSColor(alert.color)
        } else {
            text = model.amountText
            color = .labelColor
        }
        button.attributedTitle = NSAttributedString(string: text,
                                                    attributes: [.font: font, .foregroundColor: color])
        button.toolTip = "DSHNotch \(appVersion())"
        let windowVisible = button.window?.isVisible ?? false
        dshLog("菜单栏标题=\"\(text)\" 可见=\(windowVisible) 宽=\(button.window?.frame.width ?? 0)")
    }

    // MARK: - 交互

    @objc private func statusItemClicked() {
        togglePopover()
    }

    func togglePopover() {
        guard let popover, let button = statusItem?.button else { return }

        // 用户一旦动手，提醒就交还给他
        alertResetWork?.cancel()
        alertResetWork = nil
        if state.alert != nil { state.alert = nil }

        if popover.isShown {
            popover.performClose(nil)
        } else {
            state.isExpanded = true
            updateTitle()
            hosting?.rootView = makeRootView()
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    private func select(_ tab: SettingsTab) {
        state.settingsTab = tab
        hosting?.rootView = makeRootView()
    }

    private func toggleSettings() {
        state.showSettings.toggle()
        dshLog("设置页 \(state.showSettings ? "打开" : "关闭")（菜单栏）")
        hosting?.rootView = makeRootView()
    }

    private func openTopUpPage() {
        let url = model.topUpURL
        dshLog("打开充值页：\(url.absoluteString)")
        NSWorkspace.shared.open(url)
    }

    // MARK: - 提醒

    /// 菜单栏形态没有「卡片弹出来」这个动作——popover 会抢焦点，
    /// 正在打字的用户会被打断。改成菜单栏标题临时变成提醒内容，
    /// 停留设定时长后恢复。
    func presentAlert(_ alert: BalanceAlert) {
        dshLog("额度提醒（菜单栏）：\(alert.title) → 标题临时变为「\(alert.menuBarText)」")
        state.alert = alert
        refresh()

        alertResetWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.state.alert = nil
            self.refresh()
            dshLog("菜单栏提醒结束，标题恢复为「\(self.model.amountText)」")
        }
        alertResetWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + settings.alertDuration, execute: work)
    }
}
