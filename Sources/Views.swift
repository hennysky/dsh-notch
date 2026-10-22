import AppKit
import SwiftUI

// MARK: - 卡片状态与外观

/// 设置页的分页。设置项变多之后一屏放不下，分页比加高卡片好。
enum SettingsTab: String, CaseIterable, Identifiable {
    case alerts, animation, general, notifications

    var id: String { rawValue }

    var label: String {
        switch self {
        case .alerts: return "提醒"
        case .animation: return "动画"
        case .general: return "通用"
        case .notifications: return "通知"
        }
    }
}

/// 卡片的呈现形态。刘海形态顶部与屏幕齐平、顶角不圆；popover 形态四角统一圆角。
enum CardChrome: Equatable {
    case notch(topInset: CGFloat)
    case popover

    /// 卡片内容要往下让出的高度（刘海那一条）
    var topInset: CGFloat {
        switch self {
        case .notch(let inset): return inset
        case .popover: return 0
        }
    }
}

/// 卡片的一次性状态。放在呈现层而不是 SwiftUI 的 @State：
/// SwiftUI 的观察者传播在这棵手工托管的视图树里不可靠，状态由外部显式驱动。
struct CardState: Equatable {
    var isExpanded = false
    var showSettings = false
    var showCalendar = false
    var calendarMetric: ActivityMetric = .tokens
    var settingsTab: SettingsTab = .alerts
    var alert: BalanceAlert?
}

struct CardActions {
    var toggleSettings: () -> Void = {}
    var toggleCalendar: () -> Void = {}
    var selectMetric: (ActivityMetric) -> Void = { _ in }
    var selectTab: (SettingsTab) -> Void = { _ in }
    var topUp: () -> Void = {}
    var quit: () -> Void = {}
}

/// 状态色
extension BalanceModel.Level {
    var color: Color {
        switch self {
        case .healthy: return Color(red: 0.29, green: 0.87, blue: 0.50)
        case .low: return Color(red: 1.00, green: 0.78, blue: 0.25)
        case .critical: return Color(red: 1.00, green: 0.42, blue: 0.38)
        case .failed: return Color(red: 0.60, green: 0.60, blue: 0.65)
        case .unknown: return Color(red: 0.45, green: 0.45, blue: 0.50)
        }
    }
}

private extension CardChrome {
    /// 用 AnyShape 而不是 `some Shape`：分支返回不同类型，`some Shape` 装不下
    /// （会退化成 _ConditionalContent，既不是 Shape 也没有 strokeBorder）。
    var shape: AnyShape {
        switch self {
        case .notch:
            AnyShape(UnevenRoundedRectangle(topLeadingRadius: 0, bottomLeadingRadius: 18,
                                            bottomTrailingRadius: 18, topTrailingRadius: 0,
                                            style: .continuous))
        case .popover:
            AnyShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
    }
}

// MARK: - 自绘控件
//
// 一律不用 AppKit 支撑的控件（Slider / Toggle / Picker(.segmented)）：
// 本项目没有屏幕录制权限，离屏渲染是唯一的视觉验证手段，而 ImageRenderer
// 画不出 AppKit 控件（渲染出来是一块带禁止符号的黄条）。自绘才能验证到真实效果。

/// 标题栏图标按钮。图标只有 ~11pt，命中区几乎等于笔画本身，
/// 所以把可点区域扩到 26×26，视觉大小不变。
private struct HeaderIconButton: View {
    let systemName: String
    let opacity: Double
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(.white.opacity(opacity))
                .frame(width: 26, height: 26)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// 滑杆：Capsule 轨道 + Circle 旋钮 + 拖拽手势，点轨道也能跳过去。
private struct SettingSlider: View {
    @Binding var value: Double
    let range: ClosedRange<Double>
    var step: Double = 0

    private let knob: CGFloat = 11
    private let trackHeight: CGFloat = 3
    private let rowHeight: CGFloat = 16

    var body: some View {
        GeometryReader { geo in
            let width = max(geo.size.width, 1)
            let span = range.upperBound - range.lowerBound
            let fraction = CGFloat(min(max((value - range.lowerBound) / span, 0), 1))

            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.16))
                    .frame(width: width, height: trackHeight)
                Capsule().fill(Color.white.opacity(0.80))
                    .frame(width: width * fraction, height: trackHeight)
                Circle().fill(Color.white)
                    .frame(width: knob, height: knob)
                    .offset(x: width * fraction - knob / 2)
            }
            .frame(width: width, height: rowHeight)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0).onChanged { gesture in
                    let ratio = min(max(gesture.location.x / width, 0), 1)
                    var raw = range.lowerBound + Double(ratio) * span
                    if step > 0 { raw = (raw / step).rounded() * step }
                    value = min(max(raw, range.lowerBound), range.upperBound)
                }
            )
        }
        .frame(height: rowHeight)
        .padding(.top, 1)
    }
}

/// 开关：自绘胶囊 + 圆点
private struct SettingToggle: View {
    @Binding var isOn: Bool

    var body: some View {
        Button { isOn.toggle() } label: {
            ZStack(alignment: isOn ? .trailing : .leading) {
                Capsule()
                    .fill(isOn ? Color.white.opacity(0.88) : Color.white.opacity(0.16))
                    .frame(width: 30, height: 17)
                Circle()
                    .fill(isOn ? Color.black.opacity(0.85) : Color.white.opacity(0.65))
                    .frame(width: 13, height: 13)
                    .padding(.horizontal, 2)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// 分段控件
private struct SegmentedRow<T: Hashable & Identifiable>: View {
    let options: [T]
    let label: (T) -> String
    let selected: T
    let onSelect: (T) -> Void

    var body: some View {
        HStack(spacing: 4) {
            ForEach(options) { option in
                let isSelected = option == selected
                Button { onSelect(option) } label: {
                    Text(label(option))
                        .font(.system(size: 9.5, weight: .medium))
                        .foregroundStyle(isSelected ? Color.black.opacity(0.85) : Color.white.opacity(0.7))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 3.5)
                        .background(
                            RoundedRectangle(cornerRadius: 5, style: .continuous)
                                .fill(isSelected ? Color.white.opacity(0.88) : Color.white.opacity(0.10))
                        )
                }
                .buttonStyle(.plain)
            }
        }
    }
}

private struct SettingRow: View {
    let title: String
    var value: String?

    var body: some View {
        HStack {
            Text(title)
                .font(.system(size: 10.5))
                .foregroundStyle(.white.opacity(0.48))
            Spacer(minLength: 0)
            if let value {
                Text(value)
                    .font(.system(size: 10.5, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.88))
            }
        }
    }
}

// MARK: - 卡片

/// 余额卡片。刘海形态与菜单栏 popover 形态共用同一份实现，只有 chrome 不同。
struct BalanceCard: View {
    @ObservedObject var model: BalanceModel
    @ObservedObject var settings: NotchSettings
    let chrome: CardChrome
    let state: CardState
    let actions: CardActions

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if state.showSettings {
                settingsBody
            } else if state.showCalendar {
                calendarBody
            } else if let issue = model.setupIssue {
                setupBody(issue)
            } else {
                balanceBody
            }
            if state.showCalendar {
                Spacer(minLength: 0)
            } else {
                Spacer(minLength: 6)
                footer
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, chrome.topInset + 10)
        .padding(.bottom, 13)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background {
            // 纯黑会在深色窗口上糊成一片，加一条极细描边把卡片边缘勾出来。
            // 有提醒时描边换成提醒色，一眼能看出这次是它自己弹出来的。
            chrome.shape
                .fill(Color.black)
                .overlay {
                    chrome.shape.stroke(state.alert?.color.opacity(0.75) ?? Color.white.opacity(0.10),
                                        lineWidth: state.alert == nil ? 0.5 : 1)
                }
        }
    }

    // MARK: 头部

    private var header: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(state.alert?.color ?? model.level.color)
                .frame(width: 6, height: 6)
            Text(cardTitle)
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(.white.opacity(0.85))
            Spacer(minLength: 0)

            if state.showSettings {
                HeaderIconButton(systemName: "chevron.left", opacity: 0.95,
                                 action: actions.toggleSettings)
            } else if state.showCalendar {
                HeaderIconButton(systemName: "chevron.left", opacity: 0.95,
                                 action: actions.toggleCalendar)
            } else {
                HeaderIconButton(systemName: "calendar", opacity: 0.65,
                                 action: actions.toggleCalendar)
                HeaderIconButton(systemName: "slider.horizontal.3", opacity: 0.65,
                                 action: actions.toggleSettings)
                HeaderIconButton(systemName: "arrow.clockwise",
                                 opacity: model.isRefreshing ? 0.3 : 0.65) {
                    Task { await model.refresh() }
                }
                .disabled(model.isRefreshing)
            }
        }
    }

    private var cardTitle: String {
        if state.showSettings { return "设置" }
        if state.showCalendar { return state.calendarMetric.title }
        return "DeepSeek Harness"
    }

    // MARK: 用量日历

    private var calendarBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                metricToggle
                Spacer(minLength: 0)
                Text("近 6 个月")
                    .font(.system(size: 11))
                    .foregroundStyle(.white.opacity(0.38))
            }
            .padding(.top, 8)

            if let activity = model.activity, !activity.days.isEmpty {
                CalendarHeatmapView(activity: activity, metric: state.calendarMetric)
                    .padding(.top, 8)

                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text(activityTotalText(activity))
                        .font(.system(size: 27, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white.opacity(0.95))
                    Text(state.calendarMetric == .tokens ? "tokens · 近 6 个月" : "· 近 6 个月")
                        .font(.system(size: 11))
                        .foregroundStyle(.white.opacity(0.35))
                    Spacer(minLength: 4)
                    activityLegend
                }
                .padding(.top, 10)
            } else {
                Text("还没有用量数据")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.white.opacity(0.55))
                    .padding(.top, 14)
                Text("跑一次对话后，插件会按天生成")
                    .font(.system(size: 8.5))
                    .foregroundStyle(.white.opacity(0.30))
                    .padding(.top, 3)
            }
        }
    }

    private var metricToggle: some View {
        HStack(spacing: 0) {
            ForEach(ActivityMetric.allCases, id: \.self) { metric in
                Button {
                    actions.selectMetric(metric)
                } label: {
                    Text(metric.label)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(metric == state.calendarMetric
                                         ? Color.black.opacity(0.85)
                                         : Color.white.opacity(0.55))
                        .padding(.horizontal, 13)
                        .padding(.vertical, 5)
                        .background(Capsule().fill(metric == state.calendarMetric
                                                   ? Color.white.opacity(0.88)
                                                   : Color.clear))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(Capsule().fill(Color.white.opacity(0.10)))
    }

    private func activityTotalText(_ activity: TokenActivity) -> String {
        // 只合计当前展示的 6 个月；快照里还有更早的数据，不能一起加。
        let cells = TokenActivityCalendar.build(days: activity.days).allCells
        switch state.calendarMetric {
        case .tokens:
            return TokenActivityCalendar.compactCount(cells.reduce(0) { $0 + $1.tokens })
        case .money:
            return "≈¥" + SessionCostSnapshot.formatCny(cells.reduce(0) { $0 + $1.cost })
        }
    }

    private var activityLegend: some View {
        HStack(spacing: 2) {
            ForEach(1...4, id: \.self) { level in
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(TokenActivityCalendar.color(level: level, metric: state.calendarMetric))
                    .frame(width: 7, height: 7)
            }
        }
    }

    // MARK: 余额页

    private var balanceBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 1) {
                Text(model.amountText)
                    .font(.system(size: 27, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
                    .opacity(model.isStale ? 0.6 : 1)
                Text("充值钱包余额")
                    .font(.system(size: 9.5))
                    .foregroundStyle(.white.opacity(0.42))
            }
            .padding(.top, 10)

            Divider().overlay(Color.white.opacity(0.10)).padding(.vertical, 8)

            detail("赠送钱包", model.bonusText)
            detail("累计消费", model.costText)
            detail("今日消耗", model.todayCostText)

            if let session = model.sessionCost, session.isFresh {
                Divider().overlay(Color.white.opacity(0.10)).padding(.vertical, 6)
                sessionCostRow(session)
            }
        }
    }

    /// 当前会话花费：标题 + 模型/tokens + 预估金额。
    /// 数据来自 DSH 插件写的本地快照；没有快照/过期/金额不可用时整块隐藏金额。
    private func sessionCostRow(_ session: SessionCostSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 5) {
                Text(session.source == "client" ? "当前会话" : "最近会话")
                    .font(.system(size: 9.5))
                    .foregroundStyle(.white.opacity(0.42))
                Text(session.titleText)
                    .font(.system(size: 9.5))
                    .foregroundStyle(.white.opacity(0.62))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 4)
                if let money = session.moneyText {
                    Text(money)
                        .font(.system(size: 10.5, weight: .medium, design: .rounded))
                        .foregroundStyle(.white.opacity(0.9))
                } else {
                    Text("金额待估")
                        .font(.system(size: 9))
                        .foregroundStyle(.white.opacity(0.35))
                }
            }
            HStack(spacing: 4) {
                Text("\(session.modelText) · \(session.tokensText) tokens")
                    .font(.system(size: 8.5))
                    .foregroundStyle(.white.opacity(0.28))
                    .lineLimit(1)
                Spacer(minLength: 0)
                if session.cost.estimated {
                    Text("预估")
                        .font(.system(size: 8))
                        .foregroundStyle(.white.opacity(0.22))
                }
            }
        }
    }

    /// 首次使用引导。发给别人时这是第一个会撞上的场景：
    /// 对方没装过 DSH，之前只会看到一行文件路径，不知道该怎么办。
    private func setupBody(_ issue: BalanceModel.SetupIssue) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(Color(red: 1.00, green: 0.78, blue: 0.25))
                Text(issue.title)
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(.white.opacity(0.92))
            }
            .padding(.top, 12)

            Text(issue.detail)
                .font(.system(size: 10))
                .foregroundStyle(.white.opacity(0.5))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 6)

            Button {
                Task { await model.refresh() }
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 8.5, weight: .bold))
                    Text(model.isRefreshing ? "检查中…" : "重新检查")
                        .font(.system(size: 10, weight: .medium))
                }
                .foregroundStyle(.white.opacity(model.isRefreshing ? 0.4 : 0.9))
                .padding(.horizontal, 9)
                .padding(.vertical, 3)
                .background(Capsule().fill(Color.white.opacity(0.14)))
            }
            .buttonStyle(.plain)
            .disabled(model.isRefreshing)
            .padding(.top, 10)
        }
    }

    private func detail(_ title: String, _ value: String) -> some View {
        HStack {
            Text(title)
                .font(.system(size: 10.5))
                .foregroundStyle(.white.opacity(0.48))
            Spacer(minLength: 0)
            Text(value)
                .font(.system(size: 10.5, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.88))
        }
        .padding(.vertical, 3)
    }

    // MARK: 设置页

    private var settingsBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            SegmentedRow(options: SettingsTab.allCases,
                         label: { $0.label },
                         selected: state.settingsTab,
                         onSelect: actions.selectTab)
                .padding(.top, 8)

            Group {
                switch state.settingsTab {
                case .alerts:
                    alertsTab
                case .animation:
                    animationTab
                case .general:
                    generalTab
                case .notifications:
                    notificationsTab
                }
            }
            .padding(.top, 12)
        }
    }

    private var alertsTab: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingRow(title: "余额低于", value: NotchSettings.money(settings.lowBalanceThreshold))
            SettingSlider(value: $settings.lowBalanceThreshold,
                          range: NotchSettings.lowBalanceRange, step: 1)
            SettingRow(title: "单次消耗", value: NotchSettings.money(settings.burnThreshold))
                .padding(.top, 8)
            SettingSlider(value: $settings.burnThreshold,
                          range: NotchSettings.burnRange, step: 0.5)
            SettingRow(title: "弹出停留", value: NotchSettings.seconds(settings.alertDuration))
                .padding(.top, 8)
            SettingSlider(value: $settings.alertDuration,
                          range: NotchSettings.alertDurationRange, step: 1)
        }
    }

    private var animationTab: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingRow(title: "动画时长", value: NotchSettings.duration(settings.animationDuration))
            SettingSlider(value: $settings.animationDuration, range: NotchSettings.durationRange)
            SettingRow(title: "缓动曲线").padding(.top, 12)
            SegmentedRow(options: NotchSettings.Easing.allCases,
                         label: { $0.label },
                         selected: settings.easing,
                         onSelect: { settings.easing = $0 })
                .padding(.top, 4)
        }
    }

    private var generalTab: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingRow(title: "呈现形态").padding(.bottom, 4)
            SegmentedRow(options: NotchSettings.Presentation.allCases,
                         label: { $0.label },
                         selected: settings.presentation,
                         onSelect: { settings.presentation = $0 })
            HStack {
                Text("开机自启")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.white.opacity(0.48))
                Spacer(minLength: 0)
                SettingToggle(isOn: $settings.launchAtLogin)
            }
            .padding(.top, 12)

            HStack {
                Text("菜单栏图标")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.white.opacity(0.48))
                Spacer(minLength: 0)
                SettingToggle(isOn: $settings.showMenuBarIcon)
            }
            .padding(.top, 10)
            Text("刘海形态下用它确认应用在运行，右键可刷新、充值、退出。")
                .font(.system(size: 9))
                .foregroundStyle(.white.opacity(0.28))
                .padding(.top, 4)
                .fixedSize(horizontal: false, vertical: true)
            Text("「自动」会用刘海形态（有刘海屏时），否则用菜单栏形态。切换显示器后自动重判。")
                .font(.system(size: 9))
                .foregroundStyle(.white.opacity(0.28))
                .padding(.top, 10)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// 通知页。说明文字刻意压短：卡片高度是固定的（NotchGeometry.cardHeight），
    /// 多一个 tab 也不能把内容挤出卡片底部。
    private var notificationsTab: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("任务完成通知")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.white.opacity(0.48))
                Spacer(minLength: 0)
                SettingToggle(isOn: $settings.notifyTaskDone)
            }
            Text("DSH 跑完一轮时通知（失败、阻塞、中断也走这里）。")
                .font(.system(size: 9))
                .foregroundStyle(.white.opacity(0.28))
                .padding(.top, 3)
                .fixedSize(horizontal: false, vertical: true)

            HStack {
                Text("需要处理通知")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.white.opacity(0.48))
                Spacer(minLength: 0)
                SettingToggle(isOn: $settings.notifyAttention)
            }
            .padding(.top, 10)
            Text("agent 等你审批或回答时通知。点通知切回 DeepSeek Harness。")
                .font(.system(size: 9))
                .foregroundStyle(.white.opacity(0.28))
                .padding(.top, 3)
                .fixedSize(horizontal: false, vertical: true)

            Text("首次使用需在系统弹窗中允许 DSH Notch 发通知。")
                .font(.system(size: 9))
                .foregroundStyle(.white.opacity(0.28))
                .padding(.top, 8)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: 底部

    private var footer: some View {
        VStack(alignment: .leading, spacing: 2) {
            if state.showSettings {
                HStack(spacing: 12) {
                    Button("恢复默认") { settings.reset() }
                        .buttonStyle(.plain)
                        .font(.system(size: 10))
                        .foregroundStyle(.white.opacity(settings.isDefault ? 0.25 : 0.7))
                        .disabled(settings.isDefault)
                    Spacer(minLength: 0)
                    Button("退出应用") { actions.quit() }
                        .buttonStyle(.plain)
                        .font(.system(size: 10))
                        .foregroundStyle(Color(red: 1.0, green: 0.55, blue: 0.5).opacity(0.85))
                }
            } else {
                if let alert = state.alert {
                    HStack(spacing: 5) {
                        Image(systemName: "bell.fill")
                            .font(.system(size: 8))
                            .foregroundStyle(alert.color)
                        Text(alert.title)
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(alert.color)
                    }
                } else if let errorText = model.errorText, model.setupIssue == nil {
                    // 引导态下不重复显示原始错误——那是给开发者看的，不是给用户看的
                    Text(errorText)
                        .font(.system(size: 9.5))
                        .foregroundStyle(Color(red: 1.0, green: 0.5, blue: 0.45))
                        .lineLimit(1)
                }

                HStack(spacing: 8) {
                    Text(footerStatusText)
                        .font(.system(size: 9.5))
                        .foregroundStyle(.white.opacity(0.32))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    // 引导态下不显示充值入口——账号都没连上，点了也没用
                    if model.setupIssue == nil { topUpButton }
                }
            }
        }
    }

    private var footerStatusText: String {
        if model.setupIssue != nil { return "尚未连接账号" }
        if model.isStale && state.alert == nil { return "显示的是上次成功获取的数据" }
        return model.updatedText
    }

    private var topUpButton: some View {
        Button(action: actions.topUp) {
            HStack(spacing: 2) {
                Text("充值")
                    .font(.system(size: 9.5, weight: .medium))
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 7.5, weight: .bold))
            }
            .foregroundStyle(.white.opacity(0.85))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Capsule().fill(Color.white.opacity(0.13)))
        }
        .buttonStyle(.plain)
    }
}

/// 用量日历热力格：53 列 × 7 行。悬停时显示当天具体数值。
private struct CalendarHeatmapView: View {
    let activity: TokenActivity
    let metric: ActivityMetric

    @State private var hovered: HoveredCell?

    private let cellSize: CGFloat = 14.5
    private let gap: CGFloat = 1.3
    private var pitch: CGFloat { cellSize + gap }
    private var gridWidth: CGFloat { CGFloat(ActivityCalendar.weeks) * pitch - gap }
    private var gridHeight: CGFloat { CGFloat(ActivityCalendar.daysPerWeek) * pitch - gap }

    private struct HoveredCell: Equatable {
        let column: Int
        let row: Int
        let cell: ActivityCell
    }

    var body: some View {
        let calendar = TokenActivityCalendar.build(days: activity.days)
        let maxValue = calendar.maxValue(for: metric)
        ZStack(alignment: .topLeading) {
            Canvas { context, _ in
                for (column, rows) in calendar.columns.enumerated() {
                    for (row, optionalCell) in rows.enumerated() {
                        guard let cell = optionalCell else { continue }
                        let rect = CGRect(x: CGFloat(column) * pitch,
                                          y: CGFloat(row) * pitch,
                                          width: cellSize, height: cellSize)
                        let level = TokenActivityCalendar.level(for: cell.value(for: metric), maxValue: maxValue)
                        context.fill(Path(roundedRect: rect, cornerRadius: 1.2),
                                     with: .color(TokenActivityCalendar.color(level: level, metric: metric)))
                    }
                }
                if let hovered {
                    let rect = CGRect(x: CGFloat(hovered.column) * pitch,
                                      y: CGFloat(hovered.row) * pitch,
                                      width: cellSize, height: cellSize)
                    context.stroke(Path(roundedRect: rect, cornerRadius: 1.2),
                                   with: .color(.white.opacity(0.9)), lineWidth: 1)
                }
            }
            .frame(width: gridWidth, height: gridHeight)
            .contentShape(Rectangle())
            .onContinuousHover { phase in
                switch phase {
                case .active(let point):
                    let column = Int(point.x / pitch)
                    let row = Int(point.y / pitch)
                    if column >= 0, column < ActivityCalendar.weeks,
                       row >= 0, row < ActivityCalendar.daysPerWeek,
                       let cell = calendar.columns[column][row] {
                        hovered = HoveredCell(column: column, row: row, cell: cell)
                    } else {
                        hovered = nil
                    }
                case .ended:
                    hovered = nil
                }
            }

            ForEach(calendar.monthLabels) { label in
                Text(label.label)
                    .font(.system(size: 11))
                    .foregroundStyle(.white.opacity(0.40))
                    .offset(x: CGFloat(label.column) * pitch, y: gridHeight + 6)
            }

            // 悬停详情放在色块下方固定一行：卡片太小，浮层气泡会盖住数字。
            Text(hovered.map { TokenActivityCalendar.hoverText(for: $0.cell, metric: metric) }
                 ?? "悬停色块查看每天")
                .font(.system(size: 12.5, weight: .medium))
                .foregroundStyle(.white.opacity(hovered == nil ? 0.32 : 0.95))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(width: gridWidth, alignment: .leading)
                .offset(y: gridHeight + 30)
        }
        .frame(width: gridWidth, height: gridHeight + 52, alignment: .topLeading)
    }
}

/// 根视图。折叠态什么都不画——刘海保持原样，点击它才展开。
struct CardRootView: View {
    @ObservedObject var model: BalanceModel
    @ObservedObject var settings: NotchSettings
    let chrome: CardChrome
    let state: CardState
    let actions: CardActions

    var body: some View {
        ZStack(alignment: .top) {
            Color.clear
            if state.isExpanded {
                BalanceCard(model: model, settings: settings,
                            chrome: chrome, state: state, actions: actions)
            }
        }
        // 窗口刻意压在菜单栏区域上，这里声明忽略安全区，避免系统将来给这块内容
        // 加内缩时把卡片顶下去。实测本机安全区为 0，属于防御性写法。
        .ignoresSafeArea()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}
