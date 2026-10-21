using System.Text.Json;

namespace DSHNotch;

/// <summary>
/// 「今日消耗」的本地推算状态（移植 Sources/DailyCost.swift）。
///
/// 平台只提供累计消费（total_costs），没有按天维度，所以只能自己记基线：
/// 今日消耗 = 当前累计消费 − 当日基线。
/// </summary>
public sealed class DailyCostState
{
    /// <summary>基线所属日期（yyyy-MM-dd）。</summary>
    public string DayKey { get; set; } = string.Empty;

    /// <summary>当天起点时的累计消费。</summary>
    public decimal Baseline { get; set; }

    /// <summary>最近一次读到的累计消费。</summary>
    public decimal LastCost { get; set; }

    /// <summary>最近一次读数所属日期。</summary>
    public string LastCostDayKey { get; set; } = string.Empty;

    /// <summary>
    /// 当日基线是否可信。false 表示当天起点的累计值无从得知（首次运行、或隔了多天才开），
    /// 此时今日消耗只能算「至少这么多」，不能当成精确值展示。
    /// </summary>
    public bool BaselineCertain { get; set; }

    public DailyCostState Clone() => new()
    {
        DayKey = DayKey,
        Baseline = Baseline,
        LastCost = LastCost,
        LastCostDayKey = LastCostDayKey,
        BaselineCertain = BaselineCertain,
    };
}

/// <summary>纯逻辑，逐行移植 Swift，便于单测。</summary>
public static class DailyCost
{
    public static string DayKey(DateTime date) => date.ToString("yyyy-MM-dd");

    /// <summary>
    /// 用一次新读数推算出今日消耗。
    ///
    /// 跨天时基线的取法：
    /// - 上一次读数就在昨天 → 拿它当基线，最接近午夜的真实值
    /// - 上一次读数是更早（应用关了几天）→ 只能用今天第一次读数兜底，会少算一部分
    /// </summary>
    public static (decimal Today, DailyCostState State) Update(
        DailyCostState state, decimal cost, string today, string yesterday)
    {
        var next = state.Clone();

        if (state.DayKey != today)
        {
            next.DayKey = today;
            if (state.LastCostDayKey == yesterday)
            {
                // 昨天有读数，这就是最接近午夜的真实基线
                next.Baseline = state.LastCost;
                next.BaselineCertain = true;
            }
            else
            {
                // 无从得知当天起点，只能用当前读数兜底 —— 会少算，标记为不可信
                next.Baseline = cost;
                next.BaselineCertain = false;
            }
        }

        next.LastCost = cost;
        next.LastCostDayKey = today;

        var spent = cost - next.Baseline;
        return (spent < 0 ? 0 : spent, next);
    }
}

/// <summary>
/// 今日消耗的展示文案。抽成纯函数，守住「不可信时不许显示成 ¥0.00」这条。
/// </summary>
public static class DailyCostDisplay
{
    public static string Text(decimal amount, string symbol, bool certain)
    {
        if (!certain)
        {
            // 不知道 ≠ 没消耗。显示下限或「统计中」，不伪装成精确的 0。
            return amount <= 0 ? "统计中" : "≥" + symbol + AmountFormat.String(amount);
        }
        return symbol + AmountFormat.String(amount);
    }
}

/// <summary>落盘。跨重启保留，否则每次开应用今日消耗都会归零。</summary>
public sealed class DailyCostStore
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
    };

    private readonly string _path;

    public DailyCostStore(string? path = null)
    {
        _path = string.IsNullOrWhiteSpace(path) ? AppPaths.DailyCostFile : path;
    }

    public string Path => _path;

    public DailyCostState Load()
    {
        try
        {
            if (!File.Exists(_path)) return new DailyCostState();
            var text = File.ReadAllText(_path);
            return JsonSerializer.Deserialize<DailyCostState>(text, JsonOptions) ?? new DailyCostState();
        }
        catch (Exception ex)
        {
            AppLog.Error($"读取今日消耗状态失败（{_path}）", ex);
            return new DailyCostState();
        }
    }

    public void Save(DailyCostState state)
    {
        try
        {
            var directory = System.IO.Path.GetDirectoryName(_path);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            File.WriteAllText(_path, JsonSerializer.Serialize(state, JsonOptions));
        }
        catch (Exception ex)
        {
            AppLog.Error($"保存今日消耗状态失败（{_path}）", ex);
        }
    }
}
