import AppKit
import SwiftUI

// MARK: - 自检模式
//
// 只验证数据层（凭据读取 + 接口调用 + 解析），不创建任何窗口。
// 用法：DSHNotch --selftest

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

// MARK: - 离屏渲染
//
// 把展开态按窗口真实尺寸渲染成 PNG，用来检查布局有没有被裁掉。

@MainActor
func runRenderCheck() -> Int32 {
    let settings = NotchSettings()
    let model = BalanceModel(settings: settings)
    // 提醒态用低余额做夹具，否则画面自相矛盾（余额充足却提示低于阈值）
    let previewBalance = CommandLine.arguments.contains("--render-alert")
        ? "8.4200000000000000"
        : "25.9813852200000000"
    model.injectPreview(normal: previewBalance,
                        bonus: "0",
                        cost: "555.1113852200000000",
                        today: CommandLine.arguments.contains("--render-unknown") ? "0" : "2.63",
                        todayCertain: !CommandLine.arguments.contains("--render-unknown"))
    model.isExpanded = true

    guard let geometry = NotchGeometryResolver.resolve() else {
        print("✗ 取不到屏幕几何")
        return 1
    }

    let showSettings = CommandLine.arguments.contains("--render-settings")
    let showAlert = CommandLine.arguments.contains("--render-alert")
    let size = NSSize(width: NotchGeometry.expandedWidth,
                      height: geometry.notch.height + geometry.cardHeight(showSettings: showSettings))
    let alert = showAlert
        ? BalanceAlert(kind: .lowBalance(threshold: 10), symbol: "¥", current: 8.42, at: Date())
        : nil
    let view = NotchRootView(model: model,
                             settings: settings,
                             geometry: geometry,
                             isExpanded: true,
                             showSettings: showSettings,
                             alert: alert,
                             onToggleSettings: {},
                             onTopUp: {})
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
    if CommandLine.arguments.contains("--render-unknown") { name = "dsh-notch-unknown.png" }
    else if showAlert { name = "dsh-notch-alert.png" }
    else if showSettings { name = "dsh-notch-settings.png" }
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
        print("✗ 取不到屏幕几何")
        return 1
    }

    let panel = NotchPanel.configured(contentRect: geometry.collapsedFrame)
    var failed = 0

    let levelOK = panel.level.rawValue > NSWindow.Level.mainMenu.rawValue
    if !levelOK { failed += 1 }
    print("\(levelOK ? "✓" : "✗") 窗口层级 \(panel.level.rawValue) > 菜单栏层级 \(NSWindow.Level.mainMenu.rawValue)")

    // 容差 1pt：窗口 frame 会对齐到 2x 像素网格
    func same(_ a: NSRect, _ b: NSRect) -> Bool {
        abs(a.minX - b.minX) < 1 && abs(a.minY - b.minY) < 1
            && abs(a.width - b.width) < 1 && abs(a.height - b.height) < 1
    }

    for (name, target) in [("折叠（刘海矩形）", geometry.collapsedFrame),
                           ("展开·余额页", geometry.expandedFrame(showSettings: false)),
                           ("展开·设置页", geometry.expandedFrame(showSettings: true))] {
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
// 这个自检直接合成一次点击，然后数窗口内容的非透明像素。

@MainActor
func runClickTest() -> Int32 {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)

    guard let geometry = NotchGeometryResolver.resolve() else {
        print("✗ 取不到屏幕几何")
        return 1
    }

    let controller = NotchController()
    controller.start()

    // 收起动画走完才撤内容，所以等待时间必须覆盖动画时长
    let settle = controller.settings.animationDuration + 0.5

    // 让面板建起来、渲染出第一帧
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

    // 1. 折叠态：不画任何东西
    let collapsedPixels = opaquePixelCount(host)
    check("折叠态不画任何东西", collapsedPixels == 0, "非透明像素 \(collapsedPixels)")

    // 2. 合成一次对刘海带的点击（走真实的 mouseDown 路径）
    let clickPoint = NSPoint(x: host.bounds.midX, y: host.bounds.height - 3)
    let clickEvent = NSEvent.mouseEvent(with: .leftMouseDown,
                                        location: clickPoint,
                                        modifierFlags: [],
                                        timestamp: ProcessInfo.processInfo.systemUptime,
                                        windowNumber: panel.windowNumber,
                                        context: nil,
                                        eventNumber: 0,
                                        clickCount: 1,
                                        pressure: 1)
    if let clickEvent {
        host.mouseDown(with: clickEvent)
    } else {
        check("合成点击事件", false, "NSEvent.mouseEvent 返回 nil")
    }
    RunLoop.main.run(until: Date().addingTimeInterval(settle))

    let expandedPixels = opaquePixelCount(host)
    check("点击后卡片出现且有内容", expandedPixels > 0,
          "非透明像素 \(expandedPixels)（为 0 说明 SwiftUI 没刷新）")
    dumpViewContent(host, to: "/tmp/dsh-notch-card.png")

    // 3. 再点一次收起
    if let clickEvent2 = NSEvent.mouseEvent(with: .leftMouseDown,
                                            location: clickPoint,
                                            modifierFlags: [],
                                            timestamp: ProcessInfo.processInfo.systemUptime,
                                            windowNumber: panel.windowNumber,
                                            context: nil,
                                            eventNumber: 0,
                                            clickCount: 1,
                                            pressure: 1) {
        // 收起后刘海带仍在窗口顶端，用面板当前尺寸重新算一次
        let local = NSPoint(x: panel.contentView?.bounds.midX ?? 100,
                            y: (panel.contentView?.bounds.height ?? 32) - 3)
        if let e = NSEvent.mouseEvent(with: .leftMouseDown, location: local, modifierFlags: [],
                                      timestamp: ProcessInfo.processInfo.systemUptime,
                                      windowNumber: panel.windowNumber, context: nil,
                                      eventNumber: 0, clickCount: 1, pressure: 1) {
            host.mouseDown(with: e)
        } else {
            host.mouseDown(with: clickEvent2)
        }
    }
    // 动画走到一半时采样：内容应当还在。
    // 如果收起是「瞬间消失」，这里会是 0——那正是「消失没有动画」的成因。
    let half = controller.settings.animationDuration * 0.5
    RunLoop.main.run(until: Date().addingTimeInterval(half))
    let midPixels = opaquePixelCount(host)
    check("收起动画进行中内容仍在", midPixels > 0,
          "动画走到 \(String(format: "%.2f", half))s 时非透明像素 \(midPixels)")

    RunLoop.main.run(until: Date().addingTimeInterval(settle - half))

    let afterPixels = opaquePixelCount(host)
    check("动画结束后内容才撤掉", afterPixels == 0,
          "非透明像素 \(afterPixels)，共等待 \(String(format: "%.2f", settle))s")

    panel.orderOut(nil)
    print("")
    print(failed == 0 ? "点击交互链路全部通过（含渲染刷新）" : "\(failed) 项失败")
    return failed == 0 ? 0 : 1
}

// MARK: - 设置持久化自检

@MainActor
func runSettingsCheck() -> Int32 {
    let settings = NotchSettings()
    let originalDuration = settings.animationDuration
    let originalEasing = settings.easing
    defer {
        settings.animationDuration = originalDuration
        settings.easing = originalEasing
    }

    var failed = 0
    func check(_ name: String, _ ok: Bool, _ detail: String) {
        if !ok { failed += 1 }
        print("\(ok ? "✓" : "✗") \(name)")
        print("    \(detail)")
    }

    settings.animationDuration = 0.77
    settings.easing = .linear

    let reloaded = NotchSettings()
    check("动画时长写入后能被重新读出",
          abs(reloaded.animationDuration - 0.77) < 0.001,
          "写入 0.77，读出 \(reloaded.animationDuration)")
    check("缓动曲线写入后能被重新读出",
          reloaded.easing == .linear,
          "写入 linear，读出 \(reloaded.easing.rawValue)")

    settings.reset()
    check("恢复默认",
          settings.isDefault && abs(settings.animationDuration - NotchSettings.defaultDuration) < 0.001,
          "时长 \(settings.animationDuration)s / \(settings.easing.rawValue)")

    print("")
    print("  取值范围 \(NotchSettings.durationRange)")
    print(failed == 0 ? "设置项读写正常" : "\(failed) 项失败")
    return failed == 0 ? 0 : 1
}

// MARK: - 版本

func appVersion() -> String {
    let short = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "-"
    return "\(short) (build \(build))"
}

// MARK: - 额度提醒自检
//
// 提醒的判定必须能自动验证：什么时候该响、什么时候不该重复响，
// 靠肉眼盯着余额掉是验不出来的。

@MainActor
func runAlertCheck() -> Int32 {
    var failed = 0
    func check(_ name: String, _ ok: Bool, _ detail: String) {
        if !ok { failed += 1 }
        print("\(ok ? "✓" : "✗") \(name)")
        print("    \(detail)")
    }

    let now = Date()

    // 1. 首次查询没有参照，不判定消耗
    var detector = AlertDetector()
    var alert = detector.evaluate(current: 20, symbol: "¥", lowThreshold: 0, burnThreshold: 2, at: now)
    check("首次查询不触发消耗提醒", alert == nil,
          alert.map { "误报：\($0.title)" } ?? "无提醒")

    // 2. 消耗达到阈值
    alert = detector.evaluate(current: 17.5, symbol: "¥", lowThreshold: 0, burnThreshold: 2, at: now)
    check("消耗 ¥2.50 ≥ 阈值 ¥2 → 提醒", alert?.kind == .bigBurn(delta: Decimal(2.5)),
          alert.map { "触发：\($0.title)" } ?? "未触发")

    // 3. 消耗未达阈值
    alert = detector.evaluate(current: 16.5, symbol: "¥", lowThreshold: 0, burnThreshold: 2, at: now)
    check("消耗 ¥1.00 < 阈值 ¥2 → 不提醒", alert == nil,
          alert.map { "误报：\($0.title)" } ?? "无提醒")

    // 4. 余额跌破阈值
    detector = AlertDetector()
    alert = detector.evaluate(current: 9, symbol: "¥", lowThreshold: 10, burnThreshold: 0, at: now)
    check("余额 ¥9 跌破 ¥10 → 提醒", alert?.kind == .lowBalance(threshold: 10),
          alert.map { "触发：\($0.title)" } ?? "未触发")

    // 5. 持续低于阈值时不重复响
    alert = detector.evaluate(current: 8, symbol: "¥", lowThreshold: 10, burnThreshold: 0, at: now)
    check("仍低于阈值 → 不重复提醒", alert == nil,
          alert.map { "重复响了：\($0.title)" } ?? "未重复")

    // 6. 充回阈值之上后重新武装
    _ = detector.evaluate(current: 30, symbol: "¥", lowThreshold: 10, burnThreshold: 0, at: now)
    alert = detector.evaluate(current: 9, symbol: "¥", lowThreshold: 10, burnThreshold: 0, at: now)
    check("充值后再次跌破 → 重新提醒", alert?.kind == .lowBalance(threshold: 10),
          alert.map { "触发：\($0.title)" } ?? "未触发")

    // 7. 阈值 0 = 关闭
    detector = AlertDetector()
    alert = detector.evaluate(current: 1, symbol: "¥", lowThreshold: 0, burnThreshold: 0, at: now)
    check("阈值设为 0 → 该规则关闭", alert == nil,
          alert.map { "误报：\($0.title)" } ?? "无提醒")

    // 8. 两条同时命中时优先余额告急
    detector = AlertDetector()
    _ = detector.evaluate(current: 20, symbol: "¥", lowThreshold: 15, burnThreshold: 2, at: now)
    alert = detector.evaluate(current: 12, symbol: "¥", lowThreshold: 15, burnThreshold: 2, at: now)
    check("同时命中 → 优先余额告急", alert?.kind == .lowBalance(threshold: 15),
          alert.map { "触发：\($0.title)" } ?? "未触发")

    print("")
    print(failed == 0 ? "提醒判定全部通过" : "\(failed) 项失败")
    return failed == 0 ? 0 : 1
}

// MARK: - 今日消耗自检
//
// 平台只给累计消费，今日消耗是本地用差值推的。跨天、隔几天、异常值这些分支
// 靠肉眼是验不出来的，必须逐条验。

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

    // 1. 当天第一次读数：没有基线，今日消耗为 0（不虚报）
    var result = DailyCost.update(DailyCostState(), cost: 500, today: today, yesterday: yesterday)
    check("当天首次读数 → 今日消耗 0", result.today == 0,
          "今日 \(result.today)")

    // 2. 同一天再读，取差值
    result = DailyCost.update(result.state, cost: 502.5, today: today, yesterday: yesterday)
    check("同一天再读 → 差值 ¥2.50", result.today == Decimal(2.5),
          "今日 \(result.today)")

    // 3. 跨天且昨天有读数：拿昨天末值当基线
    result = DailyCost.update(result.state, cost: 505, today: "2026-10-15", yesterday: today)
    check("跨天（昨天有读数）→ 用昨天末值当基线", result.today == Decimal(2.5),
          "今日 \(result.today)（505 − 502.5）")

    // 4. 跨天但上次读数是好几天前：只能用当天首读兜底
    let stale = DailyCostState(dayKey: "2026-10-10", baseline: 480, lastCost: 490, lastCostDayKey: "2026-10-10")
    result = DailyCost.update(stale, cost: 505, today: "2026-10-15", yesterday: "2026-10-14")
    check("隔了几天没开 → 当天首读兜底（今日 0，不误报）", result.today == 0,
          "今日 \(result.today)")

    // 5. 差值异常为负时钳到 0
    let mid = DailyCostState(dayKey: "2026-10-15", baseline: 505, lastCost: 505, lastCostDayKey: "2026-10-15")
    result = DailyCost.update(mid, cost: 500, today: "2026-10-15", yesterday: "2026-10-14")
    check("差值异常为负 → 钳到 0", result.today == 0, "今日 \(result.today)")

    // 6. 连续多天各自独立统计
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
    check("连续两天各自独立统计", day1 == 3 && day2 == 4,
          "10-20 消耗 \(day1)，10-21 消耗 \(day2)")

    // 7. 基线可信性：昨天有读数才算得到精确的当天起点
    result = DailyCost.update(DailyCostState(dayKey: "2026-10-14", baseline: 500,
                                             lastCost: 502.5, lastCostDayKey: "2026-10-14",
                                             baselineCertain: true),
                              cost: 505, today: "2026-10-15", yesterday: "2026-10-14")
    check("跨天且昨天有读数 → 基线可信", result.state.baselineCertain,
          "baselineCertain=\(result.state.baselineCertain)")

    let staleState = DailyCostState(dayKey: "2026-10-10", baseline: 480, lastCost: 490,
                                    lastCostDayKey: "2026-10-10", baselineCertain: true)
    result = DailyCost.update(staleState, cost: 505, today: "2026-10-15", yesterday: "2026-10-14")
    check("隔了几天没开 → 基线不可信", !result.state.baselineCertain,
          "baselineCertain=\(result.state.baselineCertain)")

    // 8. 展示：不可信时不许伪装成精确的 ¥0.00
    let unknown = DailyCostDisplay.text(amount: 0, symbol: "¥", certain: false)
    check("基线不可信且为 0 → 显示「统计中」而非 ¥0.00", unknown == "统计中",
          "显示：\(unknown)")
    let lowerBound = DailyCostDisplay.text(amount: Decimal(2.5), symbol: "¥", certain: false)
    check("基线不可信但有增量 → 显示下限「≥¥2.50」", lowerBound == "≥¥2.50",
          "显示：\(lowerBound)")
    let exact = DailyCostDisplay.text(amount: Decimal(2.5), symbol: "¥", certain: true)
    check("基线可信 → 显示精确值", exact == "¥2.50", "显示：\(exact)")

    print("")
    print(failed == 0 ? "今日消耗推算与展示全部通过" : "\(failed) 项失败")
    return failed == 0 ? 0 : 1
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

if CommandLine.arguments.contains("--costcheck") {
    exit(MainActor.assumeIsolated { runCostCheck() })
}

if CommandLine.arguments.contains("--alertcheck") {
    exit(MainActor.assumeIsolated { runAlertCheck() })
}

if CommandLine.arguments.contains("--settingscheck") {
    exit(MainActor.assumeIsolated { runSettingsCheck() })
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)  // 不占 Dock、不抢菜单栏

MainActor.assumeIsolated {
    let controller = NotchController()
    controller.start()
    _ = controller   // 保持强引用
    app.run()
}
