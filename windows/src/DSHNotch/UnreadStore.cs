namespace DSHNotch;

/// <summary>
/// 未读系统通知计数（移植 Sources/UnreadStore.swift）。
///
/// 横幅只停留几秒，人不在屏幕前就错过了；所以计数挂在「不会自己消失」的托盘图标红点上，
/// 只有用户主动打开卡片（或点开通知）才清零。计数只存在内存里，重启归零。
///
/// 桥的连接线程和 UI 线程都会读写，所以用 Interlocked。
/// </summary>
public sealed class UnreadStore
{
    private int _count;

    public int Count => Volatile.Read(ref _count);

    public bool HasUnread => Count > 0;

    /// <summary>收到一条真正投递出去的通知。</summary>
    public void MarkUnread()
    {
        var next = Interlocked.Increment(ref _count);
        AppLog.Write($"未读通知 +1 → {next}");
    }

    /// <summary>用户打开卡片 / 点开通知：视为已读。</summary>
    public void Clear()
    {
        var previous = Interlocked.Exchange(ref _count, 0);
        if (previous != 0) AppLog.Write("未读通知已清零");
    }
}
