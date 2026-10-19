import AppKit
import Combine
import Foundation
import ServiceManagement

/// 开机自启。macOS 13+ 的 `SMAppService`。
enum LaunchAtLogin {
    static var isEnabled: Bool { SMAppService.mainApp.status == .enabled }

    /// 返回 nil 表示成功，否则返回失败原因。
    static func set(_ enabled: Bool) -> String? {
        do {
            if enabled {
                if SMAppService.mainApp.status != .enabled { try SMAppService.mainApp.register() }
            } else {
                if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            }
            return nil
        } catch {
            return error.localizedDescription
        }
    }
}

/// 形态与生命周期协调器。
///
/// 它只做一件事：**决定现在该用刘海形态还是菜单栏形态**，其余交给具体呈现层。
/// 判定是运行时的，不是安装时的——显示配置随时会变（接外屏、合盖、拔线），
/// 安装时问一次就定死，之后全是错的。
@MainActor
final class AppCoordinator {
    let settings = NotchSettings()
    lazy var model = BalanceModel(settings: settings)
    /// 本地通知桥（DSH 插件 POST 进来，转成系统通知）。
    /// 设置项由桥在每次请求时实时读取，所以用户在设置里一关就立刻生效。
    lazy var notifications = NotificationBridge(settings: settings)
    /// 未读通知计数：横幅会消失，红点不会。
    let unread = UnreadStore()

    private var active: (any BalancePresenting)?
    private var presence: PresenceItem?
    private var activeMode: EffectivePresentation?
    private var cancellables = Set<AnyCancellable>()
    private var terminateObserver: NSObjectProtocol?

    deinit { dshLog("!!! AppCoordinator deinit —— 协调器被释放，形态会消失") }

    func start() {
        dshLog("start() 形态偏好=\(settings.presentation.rawValue) "
               + "动画=\(settings.animationDuration)s "
               + "提醒 余额<\(settings.lowBalanceThreshold)/消耗>\(settings.burnThreshold)")

        // 开机自启以系统实际状态为准，避免设置项与事实不符
        settings.launchAtLogin = LaunchAtLogin.isEnabled

        model.onAlert = { [weak self] alert in self?.active?.presentAlert(alert) }
        applyMode()
        model.start()
        // 通知桥独立于形态：端口被占用只记日志，不阻塞余额轮询
        // 投递成功 → 未读 +1（菜单栏红点）；点开通知 → 未读清零
        notifications.onDelivered = { [weak self] in self?.unread.markUnread() }
        notifications.onNotificationClicked = { [weak self] in self?.unread.clear() }
        notifications.start()

        // 正常退出（菜单栏/卡片里的「退出应用」）时先收掉监听端口。
        // 进程被杀时系统会回收 socket，这里覆盖的是走 NSApp.terminate 的路径。
        terminateObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.stop() }
        }

        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.applyMode() }
        }

        // 用户在设置里改形态
        settings.$presentation
            .removeDuplicates()
            .sink { [weak self] _ in DispatchQueue.main.async { self?.applyMode() } }
            .store(in: &cancellables)

        settings.$launchAtLogin
            .removeDuplicates()
            .sink { [weak self] _ in DispatchQueue.main.async { self?.applyLaunchAtLogin() } }
            .store(in: &cancellables)

        settings.$showMenuBarIcon
            .removeDuplicates()
            .dropFirst()
            .sink { [weak self] _ in DispatchQueue.main.async { self?.applyMode(force: true) } }
            .store(in: &cancellables)
    }

    /// 退出前收尾：停桥、停轮询、撤掉呈现层。
    func stop() {
        notifications.stop()
        model.stop()
        active?.tearDown()
        active = nil
        presence?.stop()
        presence = nil
        if let terminateObserver {
            NotificationCenter.default.removeObserver(terminateObserver)
            self.terminateObserver = nil
        }
    }

    /// 按偏好与当前屏幕决定形态
    func applyMode(force: Bool = false) {
        let resolution = PresentationResolver.resolve(preference: settings.presentation,
                                                      screens: NSScreen.screens)
        if resolution.fellBack {
            dshLog("⚠️ 偏好「仅刘海」但当前没有刘海屏，退回菜单栏形态")
        }
        guard force || resolution.mode != activeMode || active == nil else { return }

        active?.tearDown()
        active = nil
        activeMode = nil
        presence?.stop()
        presence = nil
        model.isExpanded = false

        let presenter: any BalancePresenting
        switch resolution.mode {
        case .notch:
            presenter = NotchPresenter(model: model, settings: settings, unread: unread)
        case .menuBar:
            presenter = MenuBarPresenter(model: model, settings: settings, unread: unread)
        }
        presenter.start()
        active = presenter
        activeMode = resolution.mode

        // 刘海形态下屏幕上什么都不显示，需要一个菜单栏图标作为存在感与退出入口。
        // 菜单栏形态不需要——那边的状态栏项本身就是入口，再来一个就重复了。
        if resolution.mode == .notch, settings.showMenuBarIcon {
            let item = PresenceItem(model: model, settings: settings, unread: unread,
                                    onShowCard: { [weak self] in self?.active?.showCard() },
                                    onOpenSettings: { [weak self] in self?.active?.openSettings() })
            item.start()
            presence = item
        }

        dshLog("当前形态 = \(resolution.mode.rawValue)")
    }

    /// 幂等：与系统实际状态一致就什么都不做，避免与设置项的发布回调互相触发。
    private func applyLaunchAtLogin() {
        let desired = settings.launchAtLogin
        guard desired != LaunchAtLogin.isEnabled else { return }
        if let error = LaunchAtLogin.set(desired) {
            dshLog("⚠️ 开机自启设置失败：\(error)")
            // 设置项不能撒谎：失败就退回系统实际状态
            settings.launchAtLogin = LaunchAtLogin.isEnabled
        } else {
            dshLog("开机自启 = \(desired)")
        }
    }
}
