import AppKit
import ServiceManagement
import SwiftUI

// MARK: - 版本

func appVersion() -> String {
    let short = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "-"
    return "\(short) (build \(build))"
}

// MARK: - 数据链路自检

final class ResultBox: @unchecked Sendable {
    var value: Result<BalanceSnapshot, Error>?
}

func runSelfTest() -> Int32 {
    let box = ResultBox()
    let semaphore = DispatchSemaphore(value: 0)

    Task {
        do { box.value = .success(try await BalanceClient().fetch()) }
        catch { box.value = .failure(error) }
        semaphore.signal()
    }
    semaphore.wait()

    switch box.value {
    case .success(let snapshot):
        print("✓ 凭据读取成功（~/.dsh/.credentials.yaml）")
        print("✓ 接口调用成功")
        print("  充值钱包  \(snapshot.primary?.display ?? "—")")
        print("  赠送钱包  \(snapshot.bonus.first?.display ?? "—")")
        print("  累计消费  \(snapshot.costs.first?.display ?? "—")")
        print("  充值链接  \(snapshot.origin.appendingPathComponent("top_up").absoluteString)")
        return 0
    case .failure(let error):
        let text = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        print("✗ 失败：\(text)")
        return 1
    case .none:
        print("✗ 未取得结果")
        return 1
    }
}

// MARK: - 形态判定自检
//
// 用当前真实的屏幕对象构造用例：把屏幕按「有没有刘海」分组，
// 用「无刘海那一组」模拟 Mac mini / 纯外接屏场景。

@MainActor
func runModeCheck() -> Int32 {
    var failed = 0
    func check(_ name: String, _ ok: Bool, _ detail: String) {
        if !ok { failed += 1 }
        print("\(ok ? "✓" : "✗") \(name)")
        print("    \(detail)")
    }

    let all = NSScreen.screens
    let withNotch = all.filter { PresentationResolver.hasNotch($0) }
    let withoutNotch = all.filter { !PresentationResolver.hasNotch($0) }

    print("当前屏幕：共 \(all.count) 块，带刘海 \(withNotch.count) 块，无刘海 \(withoutNotch.count) 块")
    for screen in all {
        let notch = PresentationResolver.hasNotch(screen)
        print("  · \(screen.localizedName) \(Int(screen.frame.width))x\(Int(screen.frame.height)) "
              + (notch ? "有刘海" : "无刘海"))
    }
    print("")

    func resolve(_ preference: NotchSettings.Presentation, _ screens: [NSScreen]) -> (EffectivePresentation, Bool) {
        let r = PresentationResolver.resolve(preference: preference, screens: screens)
        return (r.mode, r.fellBack)
    }

    if !withNotch.isEmpty {
        let r = resolve(.automatic, withNotch)
        check("自动 + 有刘海屏 → 刘海形态", r.0 == .notch && !r.1, "\(r.0)")
    } else {
        print("· 本机没有刘海屏，跳过「自动 + 有刘海屏」用例")
    }

    let r2 = resolve(.automatic, withoutNotch)
    check("自动 + 只有无刘海屏（Mac mini 场景）→ 菜单栏形态",
          r2.0 == .menuBar && !r2.1, "\(r2.0) fellBack=\(r2.1)")

    let r3 = resolve(.automatic, [])
    check("自动 + 一块屏都没有 → 菜单栏形态", r3.0 == .menuBar, "\(r3.0)")

    let r4 = resolve(.menuBar, withNotch.isEmpty ? withoutNotch : withNotch)
    check("强制菜单栏 → 菜单栏形态", r4.0 == .menuBar && !r4.1, "\(r4.0)")

    let r5 = resolve(.notch, withoutNotch)
    check("强制刘海 + 无刘海屏 → 退回菜单栏并标记 fallback",
          r5.0 == .menuBar && r5.1, "\(r5.0) fellBack=\(r5.1)")

    if !withNotch.isEmpty {
        let r6 = resolve(.notch, withNotch)
        check("强制刘海 + 有刘海屏 → 刘海形态", r6.0 == .notch && !r6.1, "\(r6.0)")
    }

    print("")
    print(failed == 0 ? "形态判定全部通过" : "\(failed) 项失败")
    return failed == 0 ? 0 : 1
}

// MARK: - 离屏渲染
//
// 本项目没有屏幕录制权限，离屏渲染是唯一的视觉验证手段。

private func tabArgument() -> String {
    for arg in CommandLine.arguments where arg.hasPrefix("--tab=") {
        return String(arg.dropFirst("--tab=".count))
    }
    return "alerts"
}

@MainActor
func runRenderCheck() -> Int32 {
    let settings = NotchSettings()
    let model = BalanceModel(settings: settings)

    let isAlert = CommandLine.arguments.contains("--render-alert")
    let menuBarStyle = CommandLine.arguments.contains("--render-menubar")
    let unknownToday = CommandLine.arguments.contains("--render-unknown")

    model.injectPreview(normal: isAlert ? "8.4200000000000000" : "25.9813852200000000",
                        bonus: "0",
                        cost: "555.1113852200000000",
                        today: unknownToday ? "0" : "2.63",
                        todayCertain: !unknownToday)

    var state = CardState()
    state.isExpanded = true
    state.showSettings = CommandLine.arguments.contains("--render-settings")
    state.settingsTab = SettingsTab(rawValue: tabArgument()) ?? .alerts
    state.alert = isAlert
        ? BalanceAlert(kind: .lowBalance(threshold: 10), symbol: "¥", current: 8.42, at: Date())
        : nil

    let chrome: CardChrome = menuBarStyle ? .popover : .notch(topInset: 32)
    let size = NSSize(width: NotchGeometry.cardWidth,
                      height: menuBarStyle ? NotchGeometry.cardHeight
                                           : 32 + NotchGeometry.cardHeight)

    let view = CardRootView(model: model, settings: settings, chrome: chrome,
                            state: state, actions: CardActions())
        .frame(width: size.width, height: size.height)

    let renderer = ImageRenderer(content: view)
    renderer.scale = 2

    guard let image = renderer.nsImage,
          let tiff = image.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else {
        print("✗ 渲染失败")
        return 1
    }

    let name: String
    if unknownToday { name = "dsh-notch-unknown.png" }
    else if isAlert { name = "dsh-notch-alert.png" }
    else if state.showSettings { name = "dsh-notch-settings-\(state.settingsTab.rawValue).png" }
    else if menuBarStyle { name = "dsh-notch-menubar.png" }
    else { name = "dsh-notch-expanded.png" }

    let out = URL(fileURLWithPath: "/tmp/" + name)
    do { try png.write(to: out) } catch {
        print("✗ 写入失败：\(error.localizedDescription)")
        return 1
    }
    print("✓ 已渲染 \(Int(size.width))x\(Int(size.height)) pt → \(out.path)")
    return 0
}

// MARK: - 窗口定位自检
//
// 回归护栏 1：NSWindow 默认把 frame 约束进 visibleFrame（不含菜单栏），
// 窗口会被整体下推 33pt，折叠窗口就盖不到刘海。
// 回归护栏 2：窗口层级必须高于菜单栏，否则 frame 再对也看不见。

@MainActor
func runPanelCheck() -> Int32 {
    _ = NSApplication.shared
    guard let geometry = NotchGeometryResolver.resolve() else {
        print("· 本机没有刘海屏，刘海形态不适用（这正是菜单栏形态存在的理由）")
        return 0
    }

    let panel = NotchPanel.configured(contentRect: geometry.collapsedFrame)
    var failed = 0

    let levelOK = panel.level.rawValue > NSWindow.Level.mainMenu.rawValue
    if !levelOK { failed += 1 }
    print("\(levelOK ? "✓" : "✗") 窗口层级 \(panel.level.rawValue) > 菜单栏层级 \(NSWindow.Level.mainMenu.rawValue)")

    func same(_ a: NSRect, _ b: NSRect) -> Bool {
        abs(a.minX - b.minX) < 1 && abs(a.minY - b.minY) < 1
            && abs(a.width - b.width) < 1 && abs(a.height - b.height) < 1
    }

    for (name, target) in [("折叠（刘海矩形）", geometry.collapsedFrame),
                           ("展开（卡片矩形）", geometry.expandedFrame)] {
        panel.setFrame(target, display: false)
        let actual = panel.frame
        let ok = same(actual, target)
        if !ok { failed += 1 }
        print("\(ok ? "✓" : "✗") \(name)")
        print("    目标 \(target)")
        print("    实际 \(actual)")
    }

    print("")
    print("  屏幕 visibleFrame = \(geometry.screen.visibleFrame)（不含菜单栏）")
    print("  刘海矩形          = \(geometry.notch)")
    print(failed == 0 ? "窗口落点与层级正确" : "\(failed) 项失败")
    return failed == 0 ? 0 : 1
}

// MARK: - 点击交互自检
//
// 回归护栏 3（最贵的一个教训）：窗口尺寸/层级/位置全对，内容却可能是【全透明】的。
// 首帧之后发生的状态变化，SwiftUI 的 @ObservedObject 传播不一定刷新
// NSHostingView 手工托管的视图树——必须显式重设 rootView。

@MainActor
func runClickTest() -> Int32 {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)

    guard NotchGeometryResolver.resolve() != nil else {
        print("· 本机没有刘海屏，跳过刘海形态自检")
        return 0
    }

    let settings = NotchSettings()
    let model = BalanceModel(settings: settings)
    // 只测呈现层，不启动轮询：真实余额触发的额度提醒会弹开卡片，污染状态断言
    let presenter = NotchPresenter(model: model, settings: settings)
    presenter.start()

    RunLoop.main.run(until: Date().addingTimeInterval(0.5))

    guard let panel = NSApp.windows.compactMap({ $0 as? NotchPanel }).first,
          let host = panel.contentView else {
        print("✗ 找不到面板")
        return 1
    }

    var failed = 0
    func check(_ name: String, _ ok: Bool, _ detail: String) {
        if !ok { failed += 1 }
        print("\(ok ? "✓" : "✗") \(name)")
        print("    \(detail)")
    }

    dshLog("宿主视图安全区 = \(host.safeAreaInsets)，窗口高 \(host.bounds.height)")
    print("  宿主视图安全区 \(host.safeAreaInsets)，窗口高 \(host.bounds.height)")

    let collapsedPixels = opaquePixelCount(host)
    check("折叠态不画任何东西", collapsedPixels == 0, "非透明像素 \(collapsedPixels)")

    // 命中测试单独验：直接调 mouseDown 会绕过 hitTest，
    // 真实点击却要经过它——折叠窗口被安全区内缩吃光时就是在这里失败。
    let hitProbe = NSPoint(x: host.bounds.midX, y: host.bounds.height - 16)
    let hitView = host.hitTest(hitProbe)
    check("折叠态命中测试能点中面板", hitView != nil,
          hitView.map { "命中 \(type(of: $0))" } ?? "hitTest 返回 nil —— 真实点击会穿透，到不了 mouseDown")

    func click() {
        let point = NSPoint(x: host.bounds.midX, y: host.bounds.height - 3)
        if let event = NSEvent.mouseEvent(with: .leftMouseDown, location: point,
                                          modifierFlags: [],
                                          timestamp: ProcessInfo.processInfo.systemUptime,
                                          windowNumber: panel.windowNumber,
                                          context: nil, eventNumber: 0, clickCount: 1, pressure: 1) {
            host.mouseDown(with: event)
        }
    }

    click()
    let settle = settings.animationDuration + 0.5
    RunLoop.main.run(until: Date().addingTimeInterval(settle))

    let expandedPixels = opaquePixelCount(host)
    check("点击后卡片出现且有内容", expandedPixels > 0,
          "非透明像素 \(expandedPixels)（为 0 说明 SwiftUI 没刷新）")
    dumpViewContent(host, to: "/tmp/dsh-notch-card.png")

    // 动画走到一半时采样：如果收起是「瞬间消失」，这里会是 0
    click()
    let half = settings.animationDuration * 0.5
    RunLoop.main.run(until: Date().addingTimeInterval(half))
    let midPixels = opaquePixelCount(host)
    check("收起动画进行中内容仍在", midPixels > 0,
          "动画走到 \(String(format: "%.2f", half))s 时非透明像素 \(midPixels)")

    RunLoop.main.run(until: Date().addingTimeInterval(settle - half))
    let afterPixels = opaquePixelCount(host)
    check("动画结束后内容才撤掉", afterPixels == 0, "非透明像素 \(afterPixels)")

    presenter.tearDown()
    print("")
    print(failed == 0 ? "点击交互链路全部通过（含渲染刷新）" : "\(failed) 项失败")
    return failed == 0 ? 0 : 1
}

// MARK: - 额度提醒自检

@MainActor
func runAlertCheck() -> Int32 {
    var failed = 0
    func check(_ name: String, _ ok: Bool, _ detail: String) {
        if !ok { failed += 1 }
        print("\(ok ? "✓" : "✗") \(name)")
        print("    \(detail)")
    }

    let now = Date()

    var detector = AlertDetector()
    var alert = detector.evaluate(current: 20, symbol: "¥", lowThreshold: 0, burnThreshold: 2, at: now)
    check("首次查询不触发消耗提醒", alert == nil, alert.map { "误报：\($0.title)" } ?? "无提醒")

    alert = detector.evaluate(current: 17.5, symbol: "¥", lowThreshold: 0, burnThreshold: 2, at: now)
    check("消耗 ¥2.50 ≥ 阈值 ¥2 → 提醒", alert?.kind == .bigBurn(delta: Decimal(2.5)),
          alert.map { "触发：\($0.title)" } ?? "未触发")

    alert = detector.evaluate(current: 16.5, symbol: "¥", lowThreshold: 0, burnThreshold: 2, at: now)
    check("消耗 ¥1.00 < 阈值 ¥2 → 不提醒", alert == nil, alert.map { "误报：\($0.title)" } ?? "无提醒")

    detector = AlertDetector()
    alert = detector.evaluate(current: 9, symbol: "¥", lowThreshold: 10, burnThreshold: 0, at: now)
    check("余额 ¥9 跌破 ¥10 → 提醒", alert?.kind == .lowBalance(threshold: 10),
          alert.map { "触发：\($0.title)" } ?? "未触发")

    alert = detector.evaluate(current: 8, symbol: "¥", lowThreshold: 10, burnThreshold: 0, at: now)
    check("仍低于阈值 → 不重复提醒", alert == nil, alert.map { "重复响了：\($0.title)" } ?? "未重复")

    _ = detector.evaluate(current: 30, symbol: "¥", lowThreshold: 10, burnThreshold: 0, at: now)
    alert = detector.evaluate(current: 9, symbol: "¥", lowThreshold: 10, burnThreshold: 0, at: now)
    check("充值后再次跌破 → 重新提醒", alert?.kind == .lowBalance(threshold: 10),
          alert.map { "触发：\($0.title)" } ?? "未触发")

    detector = AlertDetector()
    alert = detector.evaluate(current: 1, symbol: "¥", lowThreshold: 0, burnThreshold: 0, at: now)
    check("阈值设为 0 → 该规则关闭", alert == nil, alert.map { "误报：\($0.title)" } ?? "无提醒")

    detector = AlertDetector()
    _ = detector.evaluate(current: 20, symbol: "¥", lowThreshold: 15, burnThreshold: 2, at: now)
    alert = detector.evaluate(current: 12, symbol: "¥", lowThreshold: 15, burnThreshold: 2, at: now)
    check("同时命中 → 优先余额告急", alert?.kind == .lowBalance(threshold: 15),
          alert.map { "触发：\($0.title)" } ?? "未触发")

    let low = BalanceAlert(kind: .lowBalance(threshold: 10), symbol: "¥", current: 8.42, at: now)
    let burn = BalanceAlert(kind: .bigBurn(delta: Decimal(2.5)), symbol: "¥", current: 8.42, at: now)
    check("菜单栏文案（余额告急）", low.menuBarText == "⚠ ¥8.42", "「\(low.menuBarText)」")
    check("菜单栏文案（大额消耗）", burn.menuBarText == "↓¥2.50", "「\(burn.menuBarText)」")

    print("")
    print(failed == 0 ? "提醒判定全部通过" : "\(failed) 项失败")
    return failed == 0 ? 0 : 1
}

// MARK: - 今日消耗自检

@MainActor
func runCostCheck() -> Int32 {
    var failed = 0
    func check(_ name: String, _ ok: Bool, _ detail: String) {
        if !ok { failed += 1 }
        print("\(ok ? "✓" : "✗") \(name)")
        print("    \(detail)")
    }

    let today = "2026-10-14"
    let yesterday = "2026-10-13"

    var result = DailyCost.update(DailyCostState(), cost: 500, today: today, yesterday: yesterday)
    check("当天首次读数 → 今日消耗 0", result.today == 0, "今日 \(result.today)")

    result = DailyCost.update(result.state, cost: 502.5, today: today, yesterday: yesterday)
    check("同一天再读 → 差值 ¥2.50", result.today == Decimal(2.5), "今日 \(result.today)")

    result = DailyCost.update(result.state, cost: 505, today: "2026-10-15", yesterday: today)
    check("跨天（昨天有读数）→ 用昨天末值当基线", result.today == Decimal(2.5),
          "今日 \(result.today)（505 − 502.5）")

    let stale = DailyCostState(dayKey: "2026-10-10", baseline: 480, lastCost: 490,
                               lastCostDayKey: "2026-10-10", baselineCertain: true)
    result = DailyCost.update(stale, cost: 505, today: "2026-10-15", yesterday: "2026-10-14")
    check("隔了几天没开 → 当天首读兜底（今日 0，不误报）", result.today == 0, "今日 \(result.today)")

    let mid = DailyCostState(dayKey: "2026-10-15", baseline: 505, lastCost: 505,
                             lastCostDayKey: "2026-10-15", baselineCertain: true)
    result = DailyCost.update(mid, cost: 500, today: "2026-10-15", yesterday: "2026-10-14")
    check("差值异常为负 → 钳到 0", result.today == 0, "今日 \(result.today)")

    var state = DailyCostState()
    var day1 = Decimal(0)
    var day2 = Decimal(0)
    for (cost, day, prev) in [(Decimal(100), "2026-10-20", "2026-10-19"),
                              (Decimal(103), "2026-10-20", "2026-10-19"),
                              (Decimal(106), "2026-10-21", "2026-10-20"),
                              (Decimal(107), "2026-10-21", "2026-10-20")] {
        let r = DailyCost.update(state, cost: cost, today: day, yesterday: prev)
        state = r.state
        if day == "2026-10-20" { day1 = r.today } else { day2 = r.today }
    }
    check("连续两天各自独立统计", day1 == 3 && day2 == 4, "10-20 消耗 \(day1)，10-21 消耗 \(day2)")

    result = DailyCost.update(DailyCostState(dayKey: "2026-10-14", baseline: 500, lastCost: 502.5,
                                             lastCostDayKey: "2026-10-14", baselineCertain: true),
                              cost: 505, today: "2026-10-15", yesterday: "2026-10-14")
    check("跨天且昨天有读数 → 基线可信", result.state.baselineCertain,
          "baselineCertain=\(result.state.baselineCertain)")

    result = DailyCost.update(stale, cost: 505, today: "2026-10-15", yesterday: "2026-10-14")
    check("隔了几天没开 → 基线不可信", !result.state.baselineCertain,
          "baselineCertain=\(result.state.baselineCertain)")

    let unknown = DailyCostDisplay.text(amount: 0, symbol: "¥", certain: false)
    check("基线不可信且为 0 → 显示「统计中」而非 ¥0.00", unknown == "统计中", "显示：\(unknown)")
    let lowerBound = DailyCostDisplay.text(amount: Decimal(2.5), symbol: "¥", certain: false)
    check("基线不可信但有增量 → 显示下限「≥¥2.50」", lowerBound == "≥¥2.50", "显示：\(lowerBound)")
    let exact = DailyCostDisplay.text(amount: Decimal(2.5), symbol: "¥", certain: true)
    check("基线可信 → 显示精确值", exact == "¥2.50", "显示：\(exact)")

    print("")
    print(failed == 0 ? "今日消耗推算与展示全部通过" : "\(failed) 项失败")
    return failed == 0 ? 0 : 1
}

// MARK: - 设置持久化自检

@MainActor
func runSettingsCheck() -> Int32 {
    let settings = NotchSettings()
    let original = (settings.animationDuration, settings.easing,
                    settings.lowBalanceThreshold, settings.burnThreshold,
                    settings.alertDuration, settings.presentation)
    defer {
        settings.animationDuration = original.0
        settings.easing = original.1
        settings.lowBalanceThreshold = original.2
        settings.burnThreshold = original.3
        settings.alertDuration = original.4
        settings.presentation = original.5
    }

    var failed = 0
    func check(_ name: String, _ ok: Bool, _ detail: String) {
        if !ok { failed += 1 }
        print("\(ok ? "✓" : "✗") \(name)")
        print("    \(detail)")
    }

    settings.animationDuration = 0.77
    settings.easing = .linear
    settings.lowBalanceThreshold = 25
    settings.presentation = .menuBar

    let reloaded = NotchSettings()
    check("动画时长持久化", abs(reloaded.animationDuration - 0.77) < 0.001,
          "写入 0.77，读出 \(reloaded.animationDuration)")
    check("缓动曲线持久化", reloaded.easing == .linear, "读出 \(reloaded.easing.rawValue)")
    check("提醒阈值持久化", abs(reloaded.lowBalanceThreshold - 25) < 0.001,
          "写入 25，读出 \(reloaded.lowBalanceThreshold)")
    check("呈现形态持久化", reloaded.presentation == .menuBar,
          "写入 menuBar，读出 \(reloaded.presentation.rawValue)")

    settings.reset()
    check("恢复默认", settings.isDefault,
          "动画 \(settings.animationDuration)s / 形态 \(settings.presentation.rawValue) / "
          + "余额<\(settings.lowBalanceThreshold) / 消耗>\(settings.burnThreshold)")

    print("")
    print(failed == 0 ? "设置项读写正常" : "\(failed) 项失败")
    return failed == 0 ? 0 : 1
}

// MARK: - 刷新时机自检
//
// 「点开就刷新」必须配限流，否则反复点开会打爆接口（实测触发过 HTTP 429）。

@MainActor
func runRefreshCheck() -> Int32 {
    var failed = 0
    func check(_ name: String, _ ok: Bool, _ detail: String) {
        if !ok { failed += 1 }
        print("\(ok ? "✓" : "✗") \(name)")
        print("    \(detail)")
    }

    let now = Date()
    let floor = RefreshPolicy.minimumInterval

    check("从未查询过 → 刷新",
          RefreshPolicy.shouldRefresh(lastAttemptAt: nil, now: now),
          "lastAttemptAt = nil")

    check("5 秒前查过 → 跳过（避免反复点开打爆接口）",
          !RefreshPolicy.shouldRefresh(lastAttemptAt: now.addingTimeInterval(-5), now: now),
          "间隔 5s < 下限 \(Int(floor))s")

    check("29 秒前查过 → 跳过",
          !RefreshPolicy.shouldRefresh(lastAttemptAt: now.addingTimeInterval(-29), now: now),
          "间隔 29s < 下限 \(Int(floor))s")

    check("恰好 \(Int(floor)) 秒 → 刷新（边界包含）",
          RefreshPolicy.shouldRefresh(lastAttemptAt: now.addingTimeInterval(-floor), now: now),
          "间隔 \(Int(floor))s ≥ 下限")

    check("5 分钟前查过 → 刷新",
          RefreshPolicy.shouldRefresh(lastAttemptAt: now.addingTimeInterval(-300), now: now),
          "间隔 300s")

    check("下限可覆盖（用于测试与将来做成设置）",
          RefreshPolicy.shouldRefresh(lastAttemptAt: now.addingTimeInterval(-5), now: now,
                                      minimumInterval: 3),
          "下限 3s 时，间隔 5s 应刷新")

    print("")
    print("  前台刷新下限 \(Int(floor))s ｜ 后台轮询 300s")
    print(failed == 0 ? "刷新时机判定全部通过" : "\(failed) 项失败")
    return failed == 0 ? 0 : 1
}

// MARK: - 开机自启自检
//
// 未签名应用能否注册登录项是个未知数，所以直接试一次并给出结论。
// 试完立刻撤销，避免留下指向构建目录的登录项。

@MainActor
func runLoginCheck() -> Int32 {
    print("应用路径   \(Bundle.main.bundlePath)")
    print("Bundle ID  \(Bundle.main.bundleIdentifier ?? "(无)")")
    print("签名       \(signatureDescription())")
    print("SMAppService 状态 = \(SMAppService.mainApp.status.rawValue) "
          + "(0=未注册 1=已启用 2=需批准 3=未找到)")
    print("")

    guard SMAppService.mainApp.status != .requiresApproval else {
        print("⚠️ 已注册但需要在「系统设置 → 通用 → 登录项」里批准")
        return 0
    }

    if let error = LaunchAtLogin.set(true) {
        print("✗ 注册失败：\(error)")
        print("")
        print("结论：未签名应用被系统拒绝注册登录项。")
        print("      用户仍可在「系统设置 → 通用 → 登录项」手动添加。")
        return 1
    }

    print("✓ 注册成功，isEnabled = \(LaunchAtLogin.isEnabled)")
    _ = LaunchAtLogin.set(false)
    print("  已撤销（不留登录项）")
    print("")
    print("结论：SMAppService 可用。")
    return 0
}

private func signatureDescription() -> String {
    var code: SecCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return "未知" }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return "未知" }
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let dict = info as? [String: Any] else { return "未知" }
    let identifier = dict[kSecCodeInfoIdentifier as String] as? String ?? "?"
    let flags = dict[kSecCodeInfoFlags as String] as? UInt32 ?? 0
    let adhoc = (flags & 0x2) != 0
    return "\(identifier)\(adhoc ? "（adhoc）" : "")"
}

// MARK: - 入口

if CommandLine.arguments.contains("--version") {
    print("DSHNotch \(appVersion())")
    exit(0)
}
if CommandLine.arguments.contains("--selftest") {
    exit(runSelfTest())
}
if CommandLine.arguments.contains("--render") {
    exit(MainActor.assumeIsolated { runRenderCheck() })
}
if CommandLine.arguments.contains("--panelcheck") {
    exit(MainActor.assumeIsolated { runPanelCheck() })
}
if CommandLine.arguments.contains("--clicktest") {
    exit(MainActor.assumeIsolated { runClickTest() })
}
if CommandLine.arguments.contains("--modecheck") {
    exit(MainActor.assumeIsolated { runModeCheck() })
}
if CommandLine.arguments.contains("--alertcheck") {
    exit(MainActor.assumeIsolated { runAlertCheck() })
}
if CommandLine.arguments.contains("--costcheck") {
    exit(MainActor.assumeIsolated { runCostCheck() })
}
if CommandLine.arguments.contains("--logincheck") {
    exit(MainActor.assumeIsolated { runLoginCheck() })
}
if CommandLine.arguments.contains("--refreshcheck") {
    exit(MainActor.assumeIsolated { runRefreshCheck() })
}
if CommandLine.arguments.contains("--settingscheck") {
    exit(MainActor.assumeIsolated { runSettingsCheck() })
}

// MARK: - 正常启动

/// 顶层全局引用。
///
/// Swift 的 ARC 会在「最后一次使用之后」就释放局部变量，`start()` 一返回
/// coordinator 就可能没了。刘海形态下这个问题被掩盖了——AppKit 会保留已上屏的
/// 窗口；但状态栏项没有这层保护，会连同 presenter 一起被回收，
/// 表现就是「切到菜单栏形态后菜单栏里什么都没有」。
@MainActor private var appCoordinator: AppCoordinator?

MainActor.assumeIsolated {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)  // 不占 Dock、不抢菜单栏

    let coordinator = AppCoordinator()
    appCoordinator = coordinator

    // 诊断：DSH_NOTCH_TEST_ALERT=3 表示启动 3 秒后模拟一次额度提醒
    if let raw = ProcessInfo.processInfo.environment["DSH_NOTCH_TEST_ALERT"], let delay = Double(raw) {
        dshLog("TEST_ALERT：\(delay)s 后模拟一次提醒")
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            let current = coordinator.model.snapshot?.primary?.amount ?? Decimal(8.42)
            let symbol = coordinator.model.snapshot?.primary?.symbol ?? "¥"
            coordinator.model.onAlert?(BalanceAlert(kind: .lowBalance(threshold: Decimal(10)),
                                                    symbol: symbol, current: current, at: Date()))
        }
    }

    coordinator.start()
    app.run()
}
