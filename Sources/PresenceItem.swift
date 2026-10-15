import AppKit

/// 刘海形态下的菜单栏存在感。
///
/// 应用是 accessory（不占 Dock），刘海形态下屏幕上什么也不显示——
/// 启动之后没有任何东西表明它活着，也没有退出的入口。这个图标就是为了解决这件事：
///
/// - **左键**：展开刘海卡片
/// - **右键**：菜单（刷新 / 充值 / 开机自启 / 退出）
///
/// 菜单栏形态下不需要它——那边的状态栏项本身就是显示金额和打开卡片的入口。
@MainActor
final class PresenceItem: NSObject {
    private let model: BalanceModel
    private let settings: NotchSettings
    private let onShowCard: () -> Void
    private let onOpenSettings: () -> Void

    private var statusItem: NSStatusItem?

    init(model: BalanceModel,
         settings: NotchSettings,
         onShowCard: @escaping () -> Void,
         onOpenSettings: @escaping () -> Void) {
        self.model = model
        self.settings = settings
        self.onShowCard = onShowCard
        self.onOpenSettings = onOpenSettings
    }

    deinit { dshLog("!!! PresenceItem deinit —— 菜单栏图标会消失") }

    func start() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            let image = NSImage(systemSymbolName: "creditcard.fill", accessibilityDescription: "DSHNotch")
            image?.isTemplate = true      // 跟随菜单栏明暗
            button.image = image
            button.target = self
            button.action = #selector(clicked)
            // 左键走 action，右键要拿来做菜单，所以两种都要接
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        statusItem = item
        updateTooltip()
        dshLog("菜单栏图标已显示（刘海形态下的存在感与退出入口）")
    }

    func stop() {
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
        statusItem = nil
    }

    func updateTooltip() {
        statusItem?.button?.toolTip = "DSHNotch \(appVersion()) · 余额 \(model.amountText)\n左键展开卡片，右键更多"
    }

    @objc private func clicked() {
        let isRightClick = NSApp.currentEvent?.type == .rightMouseUp
        if isRightClick {
            showMenu()
        } else {
            onShowCard()
        }
    }

    /// 临时把菜单挂上去再点开，用完立刻摘掉——
    /// 否则左键也会去开菜单，拿不回 action。
    private func showMenu() {
        guard let statusItem else { return }
        let menu = NSMenu()

        let show = menu.addItem(withTitle: "显示余额卡片", action: #selector(showCard), keyEquivalent: "")
        show.target = self
        let refresh = menu.addItem(withTitle: "立即刷新", action: #selector(refreshNow), keyEquivalent: "r")
        refresh.target = self
        let topUp = menu.addItem(withTitle: "打开充值页", action: #selector(openTopUp), keyEquivalent: "")
        topUp.target = self
        let settingsItem = menu.addItem(withTitle: "设置…", action: #selector(openSettings), keyEquivalent: ",")
        settingsItem.target = self

        menu.addItem(.separator())

        let login = menu.addItem(withTitle: "开机自启", action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
        login.target = self

        menu.addItem(.separator())

        let quit = menu.addItem(withTitle: "退出 DSHNotch", action: #selector(quit), keyEquivalent: "q")
        quit.target = self

        menu.delegate = self          // 弹出前刷新勾选状态
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    @objc private func showCard() { onShowCard() }

    @objc private func refreshNow() {
        Task { await model.refresh() }
    }

    @objc private func openTopUp() {
        NSWorkspace.shared.open(model.topUpURL)
    }

    @objc private func openSettings() { onOpenSettings() }

    @objc private func toggleLaunchAtLogin() {
        settings.launchAtLogin.toggle()
    }

    @objc private func quit() { NSApp.terminate(nil) }

}

extension PresenceItem: NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) {
        for item in menu.items where item.action == #selector(toggleLaunchAtLogin) {
            item.state = settings.launchAtLogin ? .on : .off
        }
    }
}
