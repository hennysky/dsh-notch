using DSHNotch;

namespace DSHNotch.Tests;

public sealed class UnreadStoreTests
{
    [Fact]
    public void StartsAtZero()
    {
        var store = new UnreadStore();

        Assert.Equal(0, store.Count);
        Assert.False(store.HasUnread);
    }

    [Fact]
    public void MarkUnread_Increments()
    {
        var store = new UnreadStore();

        store.MarkUnread();
        store.MarkUnread();

        Assert.Equal(2, store.Count);
        Assert.True(store.HasUnread);
    }

    [Fact]
    public void Clear_ResetsToZero()
    {
        var store = new UnreadStore();
        store.MarkUnread();
        store.MarkUnread();

        store.Clear();

        Assert.Equal(0, store.Count);
        Assert.False(store.HasUnread);
    }

    [Fact]
    public void Clear_OnZero_IsNoOp()
    {
        var store = new UnreadStore();

        store.Clear();

        Assert.Equal(0, store.Count);
    }

    [Fact]
    public void MarkUnread_IsThreadSafe()
    {
        var store = new UnreadStore();

        Parallel.For(0, 500, _ => store.MarkUnread());

        Assert.Equal(500, store.Count);
    }
}

public sealed class RefreshPolicyTests
{
    private static readonly DateTime Now = new(2026, 10, 22, 12, 0, 0);

    [Fact]
    public void FirstAttempt_Refreshes()
    {
        Assert.True(RefreshPolicy.ShouldRefresh(null, Now));
    }

    [Fact]
    public void RecentAttempt_IsSkipped()
    {
        Assert.False(RefreshPolicy.ShouldRefresh(Now.AddSeconds(-5), Now));
        Assert.False(RefreshPolicy.ShouldRefresh(Now.AddSeconds(-29), Now));
    }

    [Fact]
    public void OldEnoughAttempt_Refreshes()
    {
        Assert.True(RefreshPolicy.ShouldRefresh(Now.AddSeconds(-30), Now));
        Assert.True(RefreshPolicy.ShouldRefresh(Now.AddSeconds(-300), Now));
    }

    [Fact]
    public void CustomInterval_IsHonored()
    {
        Assert.False(RefreshPolicy.ShouldRefresh(Now.AddSeconds(-5), Now, minimumIntervalSeconds: 10));
        Assert.True(RefreshPolicy.ShouldRefresh(Now.AddSeconds(-11), Now, minimumIntervalSeconds: 10));
    }
}
