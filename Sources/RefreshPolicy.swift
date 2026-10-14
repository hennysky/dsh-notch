import Foundation

/// 什么时候该真的去打接口。
///
/// 抽成纯函数是为了能自检：开发期间实测触发过 HTTP 429，
/// 「点开就刷新」必须配一个下限，否则用户反复点开就会打爆接口。
enum RefreshPolicy {
    /// 前台触发的刷新下限。后台轮询是 5 分钟一次，这个只约束「点开时补一次」。
    static let minimumInterval: TimeInterval = 30

    /// 返回 true 表示该刷新。
    /// - Parameter lastAttemptAt: 上一次**发起**查询的时间（成败都算，失败也要计入，
    ///   否则接口挂了的时候用户每点一次就会重试一次）
    static func shouldRefresh(lastAttemptAt: Date?, now: Date,
                              minimumInterval: TimeInterval = RefreshPolicy.minimumInterval) -> Bool {
        guard let last = lastAttemptAt else { return true }
        return now.timeIntervalSince(last) >= minimumInterval
    }
}
