using DSHNotch;

namespace DSHNotch.Tests;

public sealed class AlertDetectorTests
{
    private static readonly DateTime Now = new(2026, 10, 22, 12, 0, 0);

    [Fact]
    public void FirstEvaluation_HasNoBurnReference()
    {
        var detector = new AlertDetector();

        var alert = detector.Evaluate(100m, "¥", lowThreshold: 10, burnThreshold: 2, Now);

        Assert.Null(alert);
        Assert.Equal(100m, detector.PreviousAmount);
    }

    [Fact]
    public void LowBalance_TriggersOnce_UntilRearmed()
    {
        var detector = new AlertDetector();

        var first = detector.Evaluate(8m, "¥", lowThreshold: 10, burnThreshold: 2, Now);
        var second = detector.Evaluate(7m, "¥", lowThreshold: 10, burnThreshold: 2, Now);

        Assert.NotNull(first);
        Assert.Equal(BalanceAlert.AlertKind.LowBalance, first!.Kind);
        Assert.Null(second);
        Assert.False(detector.LowBalanceArmed);

        // 回到阈值之上 → 重新武装
        var above = detector.Evaluate(20m, "¥", lowThreshold: 10, burnThreshold: 2, Now);
        Assert.Null(above);
        Assert.True(detector.LowBalanceArmed);

        var again = detector.Evaluate(5m, "¥", lowThreshold: 10, burnThreshold: 2, Now);
        Assert.NotNull(again);
        Assert.Equal(BalanceAlert.AlertKind.LowBalance, again!.Kind);
    }

    [Fact]
    public void LowBalance_EqualToThreshold_DoesNotTrigger()
    {
        var detector = new AlertDetector();

        var alert = detector.Evaluate(10m, "¥", lowThreshold: 10, burnThreshold: 2, Now);

        Assert.Null(alert);
        Assert.True(detector.LowBalanceArmed);
    }

    [Fact]
    public void BigBurn_TriggersWhenDeltaReachesThreshold()
    {
        var detector = new AlertDetector();
        detector.Evaluate(100m, "¥", lowThreshold: 10, burnThreshold: 2, Now);

        var alert = detector.Evaluate(98m, "¥", lowThreshold: 10, burnThreshold: 2, Now);

        Assert.NotNull(alert);
        Assert.Equal(BalanceAlert.AlertKind.BigBurn, alert!.Kind);
        Assert.Equal(2m, alert.ThresholdOrDelta);
    }

    [Fact]
    public void BigBurn_DoesNotTriggerBelowThreshold()
    {
        var detector = new AlertDetector();
        detector.Evaluate(100m, "¥", lowThreshold: 10, burnThreshold: 2, Now);

        var alert = detector.Evaluate(98.5m, "¥", lowThreshold: 10, burnThreshold: 2, Now);

        Assert.Null(alert);
    }

    [Fact]
    public void ZeroThresholds_DisableRules()
    {
        var detector = new AlertDetector();

        var first = detector.Evaluate(0.5m, "¥", lowThreshold: 0, burnThreshold: 0, Now);
        var second = detector.Evaluate(0.1m, "¥", lowThreshold: 0, burnThreshold: 0, Now);

        Assert.Null(first);
        Assert.Null(second);
        Assert.True(detector.LowBalanceArmed);
    }

    [Fact]
    public void BothRulesHit_LowBalanceWins()
    {
        var detector = new AlertDetector();
        detector.Evaluate(12m, "¥", lowThreshold: 10, burnThreshold: 2, Now);

        var alert = detector.Evaluate(7m, "¥", lowThreshold: 10, burnThreshold: 2, Now);

        Assert.NotNull(alert);
        Assert.Equal(BalanceAlert.AlertKind.LowBalance, alert!.Kind);
    }

    [Fact]
    public void Reset_ClearsPreviousAndRearms()
    {
        var detector = new AlertDetector();
        detector.Evaluate(5m, "¥", lowThreshold: 10, burnThreshold: 2, Now);
        detector.Reset();

        var alert = detector.Evaluate(4m, "¥", lowThreshold: 10, burnThreshold: 2, Now);

        Assert.NotNull(alert);
        Assert.Equal(BalanceAlert.AlertKind.LowBalance, alert!.Kind);
    }

    [Fact]
    public void AlertText_IsFormatted()
    {
        var low = new BalanceAlert(BalanceAlert.AlertKind.LowBalance, "¥", 8m, 10m, Now);
        var burn = new BalanceAlert(BalanceAlert.AlertKind.BigBurn, "¥", 90m, 2.5m, Now);

        Assert.Equal("余额已低于 ¥10.00", low.Title);
        Assert.Equal("⚠ ¥8.00", low.CompactText);
        Assert.Equal("当前余额 ¥8.00", low.Body);
        Assert.Equal("本次消耗 ¥2.50", burn.Title);
        Assert.Equal("↓¥2.50", burn.CompactText);
    }
}
