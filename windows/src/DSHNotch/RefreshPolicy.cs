namespace DSHNotch;

/// <summary>
/// 什么时候该真的去打接口。逐行移植 Sources/RefreshPolicy.swift。
///
/// 后台轮询固定 300s；这个下限只约束「点开卡片时补一次」，
/// 否则用户反复点开会打爆接口（开发期间实测触发过 HTTP 429）。
/// </summary>
public static class RefreshPolicy
{
    /// <summary>前台触发的刷新下限（秒）。</summary>
    public const double MinimumIntervalSeconds = 30;

    /// <param name="lastAttemptAt">上一次<strong>发起</strong>查询的时间（成败都算）。</param>
    public static bool ShouldRefresh(DateTime? lastAttemptAt, DateTime now, double minimumIntervalSeconds = MinimumIntervalSeconds)
    {
        if (lastAttemptAt is null) return true;
        return (now - lastAttemptAt.Value).TotalSeconds >= minimumIntervalSeconds;
    }
}
