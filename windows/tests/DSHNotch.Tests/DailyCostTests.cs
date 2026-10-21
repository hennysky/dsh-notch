using DSHNotch;

namespace DSHNotch.Tests;

public sealed class DailyCostTests
{
    private static DailyCostState State(string dayKey = "", decimal baseline = 0, decimal lastCost = 0,
        string lastCostDayKey = "", bool certain = false) => new()
    {
        DayKey = dayKey,
        Baseline = baseline,
        LastCost = lastCost,
        LastCostDayKey = lastCostDayKey,
        BaselineCertain = certain,
    };

    [Fact]
    public void FirstRead_UsesCurrentCostAsBaseline_AndIsUncertain()
    {
        var (today, state) = DailyCost.Update(State(), cost: 12.5m, today: "2026-10-22", yesterday: "2026-10-21");

        Assert.Equal(0m, today);
        Assert.Equal("2026-10-22", state.DayKey);
        Assert.Equal(12.5m, state.Baseline);
        Assert.False(state.BaselineCertain);
        Assert.Equal(12.5m, state.LastCost);
        Assert.Equal("2026-10-22", state.LastCostDayKey);
    }

    [Fact]
    public void SameDay_SecondRead_SubtractsBaseline()
    {
        var state = State(dayKey: "2026-10-22", baseline: 10m, lastCost: 10m, lastCostDayKey: "2026-10-22", certain: true);

        var (today, next) = DailyCost.Update(state, cost: 12.5m, today: "2026-10-22", yesterday: "2026-10-21");

        Assert.Equal(2.5m, today);
        Assert.True(next.BaselineCertain);
        Assert.Equal(10m, next.Baseline);
        Assert.Equal(12.5m, next.LastCost);
    }

    [Fact]
    public void SameDay_NoChange_IsZero()
    {
        var state = State(dayKey: "2026-10-22", baseline: 10m, lastCost: 10m, lastCostDayKey: "2026-10-22", certain: true);

        var (today, _) = DailyCost.Update(state, cost: 10m, today: "2026-10-22", yesterday: "2026-10-21");

        Assert.Equal(0m, today);
    }

    [Fact]
    public void CrossDay_UsesYesterdayLastReadAsCertainBaseline()
    {
        var state = State(dayKey: "2026-10-21", baseline: 40m, lastCost: 100m, lastCostDayKey: "2026-10-21", certain: true);

        var (today, next) = DailyCost.Update(state, cost: 105.4m, today: "2026-10-22", yesterday: "2026-10-21");

        Assert.Equal(5.4m, today);
        Assert.Equal(100m, next.Baseline);
        Assert.True(next.BaselineCertain);
    }

    [Fact]
    public void CrossDay_AfterMultiDayGap_IsUncertain()
    {
        var state = State(dayKey: "2026-10-19", baseline: 30m, lastCost: 88m, lastCostDayKey: "2026-10-19", certain: true);

        var (today, next) = DailyCost.Update(state, cost: 120m, today: "2026-10-22", yesterday: "2026-10-21");

        Assert.Equal(0m, today);
        Assert.Equal(120m, next.Baseline);
        Assert.False(next.BaselineCertain);
    }

    [Fact]
    public void CostDecrease_ClampsToZero()
    {
        var state = State(dayKey: "2026-10-22", baseline: 100m, lastCost: 100m, lastCostDayKey: "2026-10-22", certain: true);

        var (today, _) = DailyCost.Update(state, cost: 90m, today: "2026-10-22", yesterday: "2026-10-21");

        Assert.Equal(0m, today);
    }

    [Fact]
    public void Update_DoesNotMutateInputState()
    {
        var state = State(dayKey: "2026-10-21", baseline: 40m, lastCost: 100m, lastCostDayKey: "2026-10-21", certain: true);

        _ = DailyCost.Update(state, cost: 120m, today: "2026-10-22", yesterday: "2026-10-21");

        Assert.Equal("2026-10-21", state.DayKey);
        Assert.Equal(40m, state.Baseline);
        Assert.Equal(100m, state.LastCost);
    }

    [Fact]
    public void Store_RoundTripsState()
    {
        var path = Path.Combine(Path.GetTempPath(), "dshnotch-cost-" + Guid.NewGuid().ToString("N") + ".json");
        try
        {
            var store = new DailyCostStore(path);
            var state = State(dayKey: "2026-10-22", baseline: 10.5m, lastCost: 13.25m, lastCostDayKey: "2026-10-22", certain: true);
            store.Save(state);

            var loaded = new DailyCostStore(path).Load();
            Assert.Equal(state.DayKey, loaded.DayKey);
            Assert.Equal(state.Baseline, loaded.Baseline);
            Assert.Equal(state.LastCost, loaded.LastCost);
            Assert.Equal(state.LastCostDayKey, loaded.LastCostDayKey);
            Assert.True(loaded.BaselineCertain);
        }
        finally
        {
            if (File.Exists(path)) File.Delete(path);
        }
    }

    [Fact]
    public void Store_LoadsDefault_WhenFileCorrupt()
    {
        var path = Path.Combine(Path.GetTempPath(), "dshnotch-cost-" + Guid.NewGuid().ToString("N") + ".json");
        try
        {
            File.WriteAllText(path, "{ not json");
            var loaded = new DailyCostStore(path).Load();
            Assert.Equal(string.Empty, loaded.DayKey);
            Assert.False(loaded.BaselineCertain);
        }
        finally
        {
            if (File.Exists(path)) File.Delete(path);
        }
    }

    [Fact]
    public void DayKey_UsesLocalDate()
    {
        Assert.Equal("2026-01-05", DailyCost.DayKey(new DateTime(2026, 1, 5, 23, 59, 0)));
    }

    [Theory]
    [InlineData(0, false, "统计中")]
    [InlineData(2.63, false, "≥¥2.63")]
    [InlineData(0, true, "¥0.00")]
    [InlineData(2.63, true, "¥2.63")]
    public void Display_ReflectsCertainty(double amount, bool certain, string expected)
    {
        Assert.Equal(expected, DailyCostDisplay.Text((decimal)amount, "¥", certain));
    }
}
