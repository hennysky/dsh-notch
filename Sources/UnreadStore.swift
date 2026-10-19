import Combine

/// 未读系统通知计数。
///
/// 为什么需要它：macOS 的横幅只停留几秒。人不在屏幕前、或者正在专心看别的窗口，
/// 那条「任务完成 / 需要你确认」就永远错过了——通知中心里翻历史不是正常人的用法。
///
/// 所以这个计数挂在两个**不会自己消失**的地方：
/// - 刘海形态：菜单栏图标的红点
/// - 菜单栏形态：金额后面的红点（`●`）
///
/// 只有用户主动打开卡片（或点开通知）才清零。于是「有没有新东西要我处理」
/// 这件事终于有一个持久的答案。
@MainActor
final class UnreadStore: ObservableObject {
    @Published private(set) var count = 0

    var hasUnread: Bool { count > 0 }

    /// 收到一条真正投递出去的通知。
    func markUnread() {
        count += 1
        dshLog("未读通知 +1 → \(count)")
    }

    /// 用户打开卡片 / 点开通知：视为已读。
    func clear() {
        guard count != 0 else { return }
        count = 0
        dshLog("未读通知已清零")
    }
}
