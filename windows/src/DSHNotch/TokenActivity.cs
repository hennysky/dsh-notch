using System.Drawing;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace DSHNotch;

/// <summary>用量日历的两种口径（移植 Sources/TokenActivity.swift）。</summary>
public enum ActivityMetric
{
    Tokens,
    Money,
}

public static class ActivityMetricExtensions
{
    public static string Label(this ActivityMetric metric) => metric == ActivityMetric.Money ? "金额" : "用量";

    public static string Title(this ActivityMetric metric) => metric == ActivityMetric.Money ? "金额活动" : "Token 活动";
}

/// <summary>`token-activity.json` 里的一天。</summary>
public sealed class ActivityDay
{
    [JsonPropertyName("date")]
    public string? Date { get; set; }

    [JsonPropertyName("tokens")]
    public long? Tokens { get; set; }

    [JsonPropertyName("cost")]
    public decimal? Cost { get; set; }
}

public sealed class TokenActivityRange
{
    [JsonPropertyName("days")]
    public int? Days { get; set; }

    [JsonPropertyName("from")]
    public string? From { get; set; }

    [JsonPropertyName("to")]
    public string? To { get; set; }
}

public sealed class TokenActivityCostInfo
{
    [JsonPropertyName("estimated")]
    public bool? Estimated { get; set; }

    [JsonPropertyName("note")]
    public string? Note { get; set; }
}

/// <summary>
/// DSH 插件写出的每日用量快照（docs/token-activity.md）。
/// 只读本地 JSON、不联网；schema 不符/坏 JSON/没有有效日期时返回 null，日历显示占位。
/// </summary>
public sealed class TokenActivitySnapshot
{
    [JsonPropertyName("schema")]
    public int Schema { get; set; }

    [JsonPropertyName("updatedAt")]
    public long UpdatedAt { get; set; }

    [JsonPropertyName("range")]
    public TokenActivityRange? Range { get; set; }

    [JsonPropertyName("cost")]
    public TokenActivityCostInfo? Cost { get; set; }

    [JsonPropertyName("days")]
    public List<ActivityDay>? Days { get; set; }
}

public static class TokenActivity
{
    public const int SupportedSchema = 1;

    public static string DefaultPath => AppPaths.TokenActivityFile;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        AllowTrailingCommas = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        NumberHandling = JsonNumberHandling.AllowReadingFromString,
    };

    public static TokenActivitySnapshot? Load(string? path = null)
    {
        try
        {
            var file = string.IsNullOrWhiteSpace(path) ? DefaultPath : path;
            if (!File.Exists(file)) return null;
            return Parse(File.ReadAllText(file));
        }
        catch (Exception ex)
        {
            AppLog.Error($"读取用量日历失败（{path ?? DefaultPath}）", ex);
            return null;
        }
    }

    /// <summary>
    /// 解析快照并做最小校验：schema 必须是 1，days 至少有一天合法日期。
    /// 单天字段缺失按 0 处理；非法日期条目跳过（不因一条脏数据丢掉整个日历）。
    /// </summary>
    public static TokenActivitySnapshot? Parse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;

        TokenActivitySnapshot? snapshot;
        try
        {
            snapshot = JsonSerializer.Deserialize<TokenActivitySnapshot>(json, JsonOptions);
        }
        catch (JsonException ex)
        {
            AppLog.Error("解析用量日历失败（JSON 非法）", ex);
            return null;
        }

        if (snapshot is null || snapshot.Schema != SupportedSchema || snapshot.Days is null)
        {
            return null;
        }

        var validDays = new List<ActivityDay>();
        foreach (var day in snapshot.Days)
        {
            if (day is null) continue;
            if (!TryNormalizeDate(day.Date, out var date)) continue;
            validDays.Add(new ActivityDay
            {
                Date = date,
                Tokens = Math.Max(0, day.Tokens ?? 0),
                Cost = Math.Max(0, day.Cost ?? 0),
            });
        }

        if (validDays.Count == 0) return null;

        validDays.Sort(static (left, right) => string.CompareOrdinal(left.Date, right.Date));
        snapshot.Days = validDays;
        return snapshot;
    }

    private static bool TryNormalizeDate(string? value, out string normalized)
    {
        if (DateTime.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed))
        {
            normalized = parsed.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            return true;
        }

        normalized = string.Empty;
        return false;
    }
}

/// <summary>日历网格里的一格（date 为北京时间 yyyy-MM-dd）。</summary>
public sealed class ActivityCell
{
    public ActivityCell(string date, long tokens, decimal cost)
    {
        Date = date;
        Tokens = tokens;
        Cost = cost;
    }

    public string Date { get; }

    public long Tokens { get; }

    public decimal Cost { get; }

    public bool IsEmpty => Tokens == 0 && Cost <= 0;

    public double Value(ActivityMetric metric) => metric == ActivityMetric.Money ? (double)Cost : Tokens;

    public string Text(ActivityMetric metric)
    {
        return metric == ActivityMetric.Money
            ? "≈¥" + SessionCostFormat.Cny(Cost)
            : TokenActivityCalendar.CompactCount(Tokens) + " tokens";
    }
}

/// <summary>月份标签（列索引 + 文案）。</summary>
public sealed class MonthLabel
{
    public MonthLabel(int column, string label)
    {
        Column = column;
        Label = label;
    }

    public int Column { get; }

    public string Label { get; }
}

/// <summary>53 列 × 7 行（周一开头、最后一列包含今天）的日历网格。</summary>
public sealed class ActivityCalendar
{
    public const int Weeks = 53;
    public const int DaysPerWeek = 7;

    public ActivityCalendar(IReadOnlyList<IReadOnlyList<ActivityCell?>> columns, IReadOnlyList<MonthLabel> monthLabels)
    {
        Columns = columns;
        MonthLabels = monthLabels;
    }

    /// <summary>columns[column][row]。</summary>
    public IReadOnlyList<IReadOnlyList<ActivityCell?>> Columns { get; }

    public IReadOnlyList<MonthLabel> MonthLabels { get; }

    public IReadOnlyList<ActivityCell> AllCells
    {
        get
        {
            var cells = new List<ActivityCell>(Weeks * DaysPerWeek);
            foreach (var column in Columns)
            {
                foreach (var cell in column)
                {
                    if (cell is not null) cells.Add(cell);
                }
            }

            return cells;
        }
    }

    public double MaxValue(ActivityMetric metric)
    {
        var max = 0d;
        foreach (var cell in AllCells)
        {
            var value = cell.Value(metric);
            if (value > max) max = value;
        }

        return max;
    }
}

/// <summary>
/// 日历纯逻辑（移植 Sources/TokenActivity.swift 的 TokenActivityCalendar）。
/// 不依赖 UI，单测覆盖网格对齐、今天位置、未来格、档位、格式化、悬停文案。
/// </summary>
public static class TokenActivityCalendar
{
    /// <summary>周一开头、按北京时间切天。</summary>
    public static TimeZoneInfo BeijingTimeZone { get; } = ResolveBeijingTimeZone();

    /// <summary>北京时间的今天（date-only），决定最后一列与未来格子。</summary>
    public static DateTime TodayInBeijing(DateTimeOffset? now = null)
    {
        var instant = now ?? DateTimeOffset.UtcNow;
        return TimeZoneInfo.ConvertTime(instant, BeijingTimeZone).Date;
    }

    /// <summary>由日期数据生成网格；今天在最右列，未来格子为 null。</summary>
    public static ActivityCalendar Build(IEnumerable<ActivityDay>? days, DateTime today)
    {
        var lookup = new Dictionary<string, ActivityDay>(StringComparer.Ordinal);
        if (days is not null)
        {
            foreach (var day in days)
            {
                var key = day?.Date;
                if (key is null) continue;
                lookup.TryAdd(key, day!);
            }
        }

        var todayStart = today.Date;
        var mondayIndex = MondayIndex(todayStart);
        var lastMonday = todayStart.AddDays(-(mondayIndex - 1));
        var firstMonday = lastMonday.AddDays(-(ActivityCalendar.Weeks - 1) * ActivityCalendar.DaysPerWeek);

        var columns = new List<IReadOnlyList<ActivityCell?>>(ActivityCalendar.Weeks);
        var monthLabels = new List<MonthLabel>();
        int? lastMonth = null;

        for (var column = 0; column < ActivityCalendar.Weeks; column++)
        {
            var rowCells = new List<ActivityCell?>(ActivityCalendar.DaysPerWeek);
            for (var row = 0; row < ActivityCalendar.DaysPerWeek; row++)
            {
                var date = firstMonday.AddDays(column * 7 + row);
                if (date > todayStart)
                {
                    rowCells.Add(null);
                    continue;
                }

                var key = date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                lookup.TryGetValue(key, out var day);
                rowCells.Add(new ActivityCell(key, day?.Tokens ?? 0, day?.Cost ?? 0));
            }

            columns.Add(rowCells);

            var wednesday = firstMonday.AddDays(column * 7 + 2);
            if (wednesday <= todayStart)
            {
                var month = wednesday.Month;
                if (month != lastMonth)
                {
                    var label = new MonthLabel(column, month + "月");
                    // 相邻月份标签至少隔 4 列，否则中文「10月」会互相压住；
                    // 靠得太近时换成更近的月份（第一个不完整的月份让位给下个月）。
                    if (monthLabels.Count > 0 && column - monthLabels[^1].Column < 4)
                    {
                        monthLabels[^1] = label;
                    }
                    else
                    {
                        monthLabels.Add(label);
                    }

                    lastMonth = month;
                }
            }
        }

        return new ActivityCalendar(columns, monthLabels);
    }

    /// <summary>Calendar.weekday 转「周一=1 … 周日=7」。</summary>
    public static int MondayIndex(DateTime date)
    {
        return ((int)date.DayOfWeek + 6) % 7 + 1;
    }

    /// <summary>颜色档位：按当天值相对最大值开方分 4 档；0 档表示无数据。</summary>
    public static int Level(double value, double maxValue)
    {
        if (maxValue <= 0 || value <= 0) return 0;
        var scaled = Math.Sqrt(value / maxValue);
        if (scaled < 0.25) return 1;
        if (scaled < 0.5) return 2;
        if (scaled < 0.75) return 3;
        return 4;
    }

    /// <summary>色块颜色：token 用紫色系，金额用绿色系（两种口径一眼能区分）。</summary>
    public static Color CellColor(int level, ActivityMetric metric)
    {
        var palette = metric == ActivityMetric.Money
            ? MoneyPalette
            : TokenPalette;
        var index = Math.Clamp(level, 0, palette.Length - 1);
        return palette[index];
    }

    private static readonly Color[] TokenPalette =
    {
        Color.FromArgb(255, 41, 41, 46),
        Color.FromArgb(255, 61, 41, 107),
        Color.FromArgb(255, 97, 61, 158),
        Color.FromArgb(255, 135, 97, 209),
        Color.FromArgb(255, 176, 140, 247),
    };

    private static readonly Color[] MoneyPalette =
    {
        Color.FromArgb(255, 41, 41, 46),
        Color.FromArgb(255, 26, 64, 46),
        Color.FromArgb(255, 26, 97, 66),
        Color.FromArgb(255, 41, 140, 92),
        Color.FromArgb(255, 74, 191, 125),
    };

    /// <summary>token 数：123 / 12.3k / 1.24M / 13.46B。</summary>
    public static string CompactCount(long value)
    {
        if (value <= 0) return "0";
        if (value >= 1_000_000_000) return (value / 1_000_000_000d).ToString("0.00", CultureInfo.InvariantCulture) + "B";
        if (value >= 1_000_000) return (value / 1_000_000d).ToString("0.00", CultureInfo.InvariantCulture) + "M";
        if (value >= 1_000) return (value / 1_000d).ToString("0.0", CultureInfo.InvariantCulture) + "k";
        return value.ToString(CultureInfo.InvariantCulture);
    }

    /// <summary>日期文案：2026-10-21 → 10月21日。</summary>
    public static string DayLabel(string? date)
    {
        if (DateTime.TryParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed))
        {
            return parsed.Month + "月" + parsed.Day + "日";
        }

        return date ?? string.Empty;
    }

    /// <summary>悬停文案：10月21日 · 1.24M tokens / 10月21日 · ≈¥0.42。</summary>
    public static string HoverText(ActivityCell cell, ActivityMetric metric)
    {
        return DayLabel(cell.Date) + " · " + cell.Text(metric);
    }

    /// <summary>近 12 个月合计文案。</summary>
    public static string TotalText(IEnumerable<ActivityDay> days, ActivityMetric metric)
    {
        long tokens = 0;
        decimal cost = 0;
        foreach (var day in days)
        {
            tokens += Math.Max(0, day.Tokens ?? 0);
            cost += Math.Max(0, day.Cost ?? 0);
        }

        return metric == ActivityMetric.Money
            ? "≈¥" + SessionCostFormat.Cny(cost)
            : CompactCount(tokens) + " tokens";
    }

    private static TimeZoneInfo ResolveBeijingTimeZone()
    {
        foreach (var id in new[] { "China Standard Time", "Asia/Shanghai" })
        {
            try
            {
                return TimeZoneInfo.FindSystemTimeZoneById(id);
            }
            catch (TimeZoneNotFoundException)
            {
            }
            catch (InvalidTimeZoneException)
            {
            }
        }

        return TimeZoneInfo.CreateCustomTimeZone("Beijing", TimeSpan.FromHours(8), "Beijing", "Beijing");
    }
}

/// <summary>
/// 日历页的纯展示模型：是否有数据、合计文案、占位文案。
/// UI 只负责把字段贴到控件上，单测不需要 WinForms。
/// </summary>
public sealed class TokenActivityView
{
    public const string EmptyPlaceholder = "还没有用量数据";
    public const string EmptyHint = "跑一次对话后，插件会按天生成";
    public const string HoverHint = "悬停色块查看每天";

    private TokenActivityView(ActivityCalendar calendar, bool hasData, string totalText)
    {
        Calendar = calendar;
        HasData = hasData;
        TotalText = totalText;
    }

    public ActivityCalendar Calendar { get; }

    public bool HasData { get; }

    /// <summary>「1.24M tokens」或「≈¥12.34」；无数据时为空字符串。</summary>
    public string TotalText { get; }

    public static TokenActivityView Create(TokenActivitySnapshot? snapshot, ActivityMetric metric, DateTime today)
    {
        var days = snapshot?.Days;
        var calendar = TokenActivityCalendar.Build(days, today);
        if (snapshot is null || days is null || days.Count == 0)
        {
            return new TokenActivityView(calendar, hasData: false, totalText: string.Empty);
        }

        return new TokenActivityView(calendar, hasData: true, TokenActivityCalendar.TotalText(days, metric));
    }
}
