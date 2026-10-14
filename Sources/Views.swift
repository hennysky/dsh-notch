import AppKit
import SwiftUI

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

    var label: String {
        switch self {
        case .healthy: return "余额充足"
        case .low: return "余额偏低"
        case .critical: return "余额不足"
        case .failed: return "查询失败"
        case .unknown: return "读取中"
        }
    }
}

/// 标题栏图标按钮。
///
/// 图标只有 ~11pt，命中区几乎等于图标本身，很难点中。
/// 这里把可点区域扩到 26×26，图标视觉大小不变——只有 `.contentShape`
/// 把整个 frame 变成命中区，才不是只有笔画本身可点。
private struct HeaderIconButton: View {
    let systemName: String
    let opacity: Double
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(.white.opacity(opacity))
                .frame(width: Self.hitSize, height: Self.hitSize)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    static let hitSize: CGFloat = 26
}

/// 卡片外形：顶部与屏幕边缘齐平（与刘海连成一体），底部圆角。
private var cardShape: UnevenRoundedRectangle {
    UnevenRoundedRectangle(topLeadingRadius: 0,
                           bottomLeadingRadius: 18,
                           bottomTrailingRadius: 18,
                           topTrailingRadius: 0,
                           style: .continuous)
}

/// 展开态：点击刘海后向下展开的卡片。两页内容：余额 / 设置。
struct ExpandedCard: View {
    @ObservedObject var model: BalanceModel
    @ObservedObject var settings: NotchSettings
    let topInset: CGFloat
    let showSettings: Bool
    let alert: BalanceAlert?
    let onToggleSettings: () -> Void
    let onTopUp: () -> Void
    let onQuit: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if showSettings {
                SettingsPage(settings: settings, onQuit: onQuit)
                    .padding(.top, 10)
            } else {
                amount
                Divider().overlay(Color.white.opacity(0.10)).padding(.vertical, 8)
                detail(title: "赠送钱包", value: model.bonusText)
                detail(title: "累计消费", value: model.costText)
                detail(title: "今日消耗", value: model.todayCostText)
            }
            Spacer(minLength: 6)
            footer
        }
        .padding(.horizontal, 16)
        .padding(.top, topInset + 10)
        .padding(.bottom, 13)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background {
            // 纯黑会在深色窗口上糊成一片，加一条极细描边把卡片边缘勾出来。
            // 有提醒时描边换成提醒色，一眼能看出这次是它自己弹出来的。
            cardShape
                .fill(Color.black)
                .overlay {
                    cardShape.strokeBorder(alert?.color.opacity(0.75) ?? Color.white.opacity(0.10),
                                           lineWidth: alert == nil ? 0.5 : 1)
                }
        }
    }

    private var header: some View {
        HStack(spacing: 6) {
            Circle().fill(alert?.color ?? model.level.color).frame(width: 6, height: 6)
            Text(showSettings ? "设置" : "DeepSeek Harness")
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(.white.opacity(0.85))
            Spacer(minLength: 0)

            HeaderIconButton(systemName: showSettings ? "chevron.left" : "slider.horizontal.3",
                             opacity: showSettings ? 0.95 : 0.65,
                             action: onToggleSettings)

            if !showSettings {
                HeaderIconButton(systemName: "arrow.clockwise",
                                 opacity: model.isRefreshing ? 0.3 : 0.65) {
                    Task { await model.refresh() }
                }
                .disabled(model.isRefreshing)
            }
        }
    }

    private var amount: some View {
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
    }

    private func detail(title: String, value: String) -> some View {
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

    private var footer: some View {
        VStack(alignment: .leading, spacing: 2) {
            if showSettings {
                Text("展开动画与额度提醒，改动即时生效并记住。")
                    .font(.system(size: 9.5))
                    .foregroundStyle(.white.opacity(0.30))
            } else {
                if let alert {
                    HStack(spacing: 5) {
                        Image(systemName: "bell.fill")
                            .font(.system(size: 8))
                            .foregroundStyle(alert.color)
                        Text(alert.title)
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(alert.color)
                    }
                } else if let errorText = model.errorText {
                    Text(errorText)
                        .font(.system(size: 9.5))
                        .foregroundStyle(Color(red: 1.0, green: 0.5, blue: 0.45))
                        .lineLimit(1)
                }

                HStack(spacing: 8) {
                    Text(model.isStale && alert == nil ? "显示的是上次成功获取的数据" : model.updatedText)
                        .font(.system(size: 9.5))
                        .foregroundStyle(.white.opacity(0.32))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    topUpButton
                }
            }
        }
    }

    /// 充值入口：打开平台充值页，沿用浏览器自己的登录态，不带任何授权信息。
    private var topUpButton: some View {
        Button(action: onTopUp) {
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

/// 设置页：展开动画 + 额度提醒
struct SettingsPage: View {
    @ObservedObject var settings: NotchSettings
    let onQuit: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            row("动画时长", NotchSettings.duration(settings.animationDuration))
            SettingSlider(value: $settings.animationDuration, range: NotchSettings.durationRange)

            easingPicker

            row("余额低于", NotchSettings.money(settings.lowBalanceThreshold))
                .padding(.top, 9)
            SettingSlider(value: $settings.lowBalanceThreshold,
                          range: NotchSettings.lowBalanceRange, step: 1)

            row("单次消耗", NotchSettings.money(settings.burnThreshold))
                .padding(.top, 7)
            SettingSlider(value: $settings.burnThreshold,
                          range: NotchSettings.burnRange, step: 0.5)

            row("弹出停留", NotchSettings.seconds(settings.alertDuration))
                .padding(.top, 7)
            SettingSlider(value: $settings.alertDuration,
                          range: NotchSettings.alertDurationRange, step: 1)

            HStack(spacing: 12) {
                Button("恢复默认") { settings.reset() }
                    .buttonStyle(.plain)
                    .font(.system(size: 10))
                    .foregroundStyle(.white.opacity(settings.isDefault ? 0.25 : 0.7))
                    .disabled(settings.isDefault)

                Spacer(minLength: 0)

                // 没有这个按钮，用户只能去活动监视器里杀进程
                Button("退出应用") { onQuit() }
                    .buttonStyle(.plain)
                    .font(.system(size: 10))
                    .foregroundStyle(Color(red: 1.0, green: 0.55, blue: 0.5).opacity(0.85))
            }
            .padding(.top, 7)
        }
    }

    private func row(_ title: String, _ value: String) -> some View {
        HStack {
            Text(title)
                .font(.system(size: 10.5))
                .foregroundStyle(.white.opacity(0.48))
            Spacer(minLength: 0)
            Text(value)
                .font(.system(size: 10.5, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.88))
        }
    }

    /// 自绘分段控件，不用 Picker(.segmented)：
    /// AppKit 支撑的控件在离屏渲染里只能画出占位符，
    /// 而本项目没有屏幕录制权限、只能靠离屏渲染自查，自绘才能验证到真实效果。
    private var easingPicker: some View {
        HStack(spacing: 4) {
            ForEach(NotchSettings.Easing.allCases) { easing in
                let selected = settings.easing == easing
                Button {
                    settings.easing = easing
                } label: {
                    Text(easing.label)
                        .font(.system(size: 9.5, weight: .medium))
                        .foregroundStyle(selected ? Color.black.opacity(0.85) : Color.white.opacity(0.7))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 3.5)
                        .background(
                            RoundedRectangle(cornerRadius: 5, style: .continuous)
                                .fill(selected ? Color.white.opacity(0.88) : Color.white.opacity(0.10))
                        )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.top, 4)
    }
}

/// 自绘滑杆。
///
/// 不用 SwiftUI 的 `Slider`：部署目标降到 macOS 14 之后它退回成 AppKit 的
/// `NSSlider`，而 `ImageRenderer` 画不出 AppKit 控件（渲染出来是一块带禁止符号的
/// 黄条）。本项目没有屏幕录制权限、只能靠离屏渲染自查，自绘才能验证到真实效果——
/// 分段控件当初也是因为同一个原因自绘的。
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

/// 根视图。折叠态什么都不画——刘海保持原样，点击它才展开。
///
/// `isExpanded` 由控制器显式传入，不在这里读 `model.isExpanded`：
/// `@Published` 是在 willSet 阶段发布的，在它的订阅回调里求值会读到旧值，
/// 导致内容永远慢一拍（实测：点开后窗口是空的，再点一次才画出上一状态）。
struct NotchRootView: View {
    @ObservedObject var model: BalanceModel
    @ObservedObject var settings: NotchSettings
    let geometry: NotchGeometry
    let isExpanded: Bool
    let showSettings: Bool
    let alert: BalanceAlert?
    let onToggleSettings: () -> Void
    let onTopUp: () -> Void
    let onQuit: () -> Void

    var body: some View {
        ZStack(alignment: .top) {
            Color.clear
            if isExpanded {
                ExpandedCard(model: model,
                             settings: settings,
                             topInset: geometry.notch.height,
                             showSettings: showSettings,
                             alert: alert,
                             onToggleSettings: onToggleSettings,
                             onTopUp: onTopUp,
                             onQuit: onQuit)
            }
        }
        .ignoresSafeArea()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}
