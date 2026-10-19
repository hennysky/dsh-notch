import AppKit
import Combine

/// 刘海形态下的菜单栏存在感。
///
/// 应用是 accessory（不占 Dock），刘海形态下屏幕上什么也不显示——
/// 启动之后没有任何东西表明它活着，也没有退出的入口。这个图标就是为了解决这件事：
///
/// - **左键**：展开刘海卡片（同时清掉未读红点）
/// - **右键**：菜单（刷新 / 充值 / 开机自启 / 退出）
///
/// 有未读通知时图标右上角带一个红点：系统横幅会自己消失，这个红点不会，
/// 直到用户打开卡片。这就是「有没有新消息要处理」的持久答案。
///
/// 菜单栏形态下不需要它——那边的状态栏项本身就是显示金额和打开卡片的入口。
@MainActor
final class PresenceItem: NSObject {
    private let model: BalanceModel
    private let settings: NotchSettings
    private let unread: UnreadStore
    private let onShowCard: () -> Void
    private let onOpenSettings: () -> Void

    private var statusItem: NSStatusItem?
    private var cancellables = Set<AnyCancellable>()

    init(model: BalanceModel,
         settings: NotchSettings,
         unread: UnreadStore,
         onShowCard: @escaping () -> Void,
         onOpenSettings: @escaping () -> Void) {
        self.model = model
        self.settings = settings
        self.unread = unread
        self.onShowCard = onShowCard
        self.onOpenSettings = onOpenSettings
    }

    deinit { dshLog("!!! PresenceItem deinit —— 菜单栏图标会消失") }

    func start() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            button.target = self
            button.action = #selector(clicked)
            // 左键走 action，右键要拿来做菜单，所以两种都要接
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        statusItem = item
        updateIcon()
        updateTooltip()
        unread.objectWillChange
            .sink { [weak self] in
                DispatchQueue.main.async {
                    self?.updateIcon()
                    self?.updateTooltip()
                }
            }
            .store(in: &cancellables)
        dshLog("菜单栏图标已显示（刘海形态下的存在感与退出入口）")
    }

    func stop() {
        cancellables.removeAll()
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
        statusItem = nil
    }

    /// 红点画在图标右上角。注意 `isTemplate` 必须关掉——
    /// 模板图会被系统染成单色，红点就变成灰点了。
    ///
    /// 做成 static 是为了让 `--unreadcheck` 能直接验证「图标里真有红色像素」，
    /// 而不是只相信「某处调用了设置 image 的代码」。
    static func iconImage(unread: Bool) -> NSImage? {
        let base = NSImage(systemSymbolName: "creditcard.fill", accessibilityDescription: "DSHNotch")
        guard unread else {
            base?.isTemplate = true      // 跟随菜单栏明暗
            return base
        }
        let size = base?.size ?? NSSize(width: 18, height: 18)
        let badge = NSImage(size: size)
        badge.lockFocus()
        base?.draw(in: NSRect(origin: .zero, size: size))
        let diameter: CGFloat = 5
        let dot = NSRect(x: size.width - diameter - 1,
                         y: size.height - diameter - 1,
                         width: diameter, height: diameter)
        NSColor.systemRed.setFill()
        NSBezierPath(ovalIn: dot).fill()
        badge.unlockFocus()
        badge.isTemplate = false
        return badge
    }

    private func updateIcon() {
        guard let button = statusItem?.button else { return }
        button.image = Self.iconImage(unread: unread.hasUnread)
        dshLog("未读红点 \(unread.hasUnread ? "显示（\(unread.count) 条）" : "隐藏")")
    }

    func updateTooltip() {
        let unreadNote = unread.hasUnread ? " · \(unread.count) 条未读通知" : ""
        statusItem?.button?.toolTip =
            "DSHNotch \(appVersion()) · 余额 \(model.amountText)\(unreadNote)\n左键展开卡片，右键更多"
    }

    @objc private func clicked() {
        let isRightClick = NSApp.currentEvent?.type == .rightMouseUp
        if isRightClick {
            showMenu()
        } else {
            // 打开卡片 = 已读
            unread.clear()
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

    @objc private func showCard() {
        unread.clear()
        onShowCard()
    }

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
