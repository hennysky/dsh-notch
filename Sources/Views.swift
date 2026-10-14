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

/// 卡片外形：顶部与屏幕边缘齐平（与刘海连成一体），底部圆角。
private var cardShape: UnevenRoundedRectangle {
    UnevenRoundedRectangle(topLeadingRadius: 0,
                           bottomLeadingRadius: 18,
                           bottomTrailingRadius: 18,
                           topTrailingRadius: 0,
                           style: .continuous)
}

/// 展开态：点击刘海后向下展开的卡片。两页内容：余额 / 动画设置。
struct ExpandedCard: View {
    @ObservedObject var model: BalanceModel
    @ObservedObject var settings: NotchSettings
    let topInset: CGFloat
    let showSettings: Bool
    let onToggleSettings: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if showSettings {
                SettingsPage(settings: settings)
                    .padding(.top, 12)
            } else {
                amount
                Divider().overlay(Color.white.opacity(0.10)).padding(.vertical, 9)
                detail(title: "赠送钱包", value: model.bonusText)
                detail(title: "累计消费", value: model.costText)
            }
            Spacer(minLength: 6)
            footer
        }
        .padding(.horizontal, 16)
        .padding(.top, topInset + 10)
        .padding(.bottom, 13)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background {
            // 纯黑会在深色窗口上糊成一片，加一条极细描边把卡片边缘勾出来
            cardShape
                .fill(Color.black)
                .overlay {
                    cardShape.strokeBorder(Color.white.opacity(0.10), lineWidth: 0.5)
                }
        }
    }

    private var header: some View {
        HStack(spacing: 6) {
            Circle().fill(model.level.color).frame(width: 6, height: 6)
            Text(showSettings ? "动画设置" : "DeepSeek Harness")
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(.white.opacity(0.85))
            Spacer(minLength: 0)

            Button(action: onToggleSettings) {
                Image(systemName: showSettings ? "chevron.left" : "slider.horizontal.3")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(.white.opacity(showSettings ? 0.95 : 0.65))
            }
            .buttonStyle(.plain)

            if !showSettings {
                Button {
                    Task { await model.refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(.white.opacity(model.isRefreshing ? 0.3 : 0.65))
                }
                .buttonStyle(.plain)
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
        VStack(alignment: .leading, spacing: 1) {
            if showSettings {
                Text("展开/收起刘海卡片时的动画，改动即时生效并记住。")
                    .font(.system(size: 9.5))
                    .foregroundStyle(.white.opacity(0.32))
            } else {
                if let errorText = model.errorText {
                    Text(errorText)
                        .font(.system(size: 9.5))
                        .foregroundStyle(Color(red: 1.0, green: 0.5, blue: 0.45))
                        .lineLimit(1)
                }
                Text(model.isStale ? "显示的是上次成功获取的数据" : model.updatedText)
                    .font(.system(size: 9.5))
                    .foregroundStyle(.white.opacity(0.32))
            }
        }
    }
}

/// 动画参数设置页
struct SettingsPage: View {
    @ObservedObject var settings: NotchSettings

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("动画时长")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.white.opacity(0.48))
                Spacer(minLength: 0)
                Text(String(format: "%.2f 秒", settings.animationDuration))
                    .font(.system(size: 10.5, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.88))
            }
            Slider(value: $settings.animationDuration, in: NotchSettings.durationRange)
                .controlSize(.mini)
                .tint(.white.opacity(0.75))
                .padding(.top, 2)

            Text("缓动曲线")
                .font(.system(size: 10.5))
                .foregroundStyle(.white.opacity(0.48))
                .padding(.top, 10)

            // 自绘分段控件，不用 Picker(.segmented)：
            // AppKit 支撑的控件在离屏渲染里只能画出占位符，
            // 而本项目没有屏幕录制权限、只能靠离屏渲染自查，自绘才能验证到真实效果。
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
                            .padding(.vertical, 4)
                            .background(
                                RoundedRectangle(cornerRadius: 5, style: .continuous)
                                    .fill(selected ? Color.white.opacity(0.88) : Color.white.opacity(0.10))
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 3)

            HStack {
                Spacer(minLength: 0)
                Button("恢复默认") { settings.reset() }
                    .buttonStyle(.plain)
                    .font(.system(size: 10))
                    .foregroundStyle(.white.opacity(settings.isDefault ? 0.25 : 0.7))
                    .disabled(settings.isDefault)
            }
            .padding(.top, 9)
        }
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
    let onToggleSettings: () -> Void

    var body: some View {
        ZStack(alignment: .top) {
            Color.clear
            if isExpanded {
                ExpandedCard(model: model,
                             settings: settings,
                             topInset: geometry.notch.height,
                             showSettings: showSettings,
                             onToggleSettings: onToggleSettings)
            }
        }
        .ignoresSafeArea()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}
