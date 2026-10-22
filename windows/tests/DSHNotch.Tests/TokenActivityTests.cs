using System.Globalization;
using DSHNotch;

namespace DSHNotch.Tests;

public sealed class TokenActivityTests
{
    // 2026-10-22 是周四，方便断言「今天在最后一列第 4 行」。
    private static readonly DateTime Today = new(2026, 10, 22);

    private static string DayKey(DateTime date) => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    private static List<ActivityDay> BuildDays(
        DateTime today,
        int count = 371,
        Func<DateTime, (long Tokens, decimal Cost)>? valueFactory = null)
    {
        var days = new List<ActivityDay>();
        for (var offset = count - 1; offset >= 0; offset--)
        {
            var date = today.AddDays(-offset);
            var (tokens, cost) = valueFactory?.Invoke(date) ?? (0L, 0m);
            days.Add(new ActivityDay { Date = DayKey(date), Tokens = tokens, Cost = cost });
        }

        return days;
    }

    private const string NormalJson = """
        {
          "schema": 1,
          "updatedAt": 1792663219934,
          "range": { "days": 371, "from": "2025-10-17", "to": "2026-10-22" },
          "cost": { "estimated": true, "note": "按官方公开单价估算，以平台账单为准" },
          "days": [
            { "date": "2026-10-21", "tokens": 1240000, "cost": 0.42 },
            { "date": "2026-10-22", "tokens": 83000, "cost": 0.01 }
          ]
        }
        """;

    [Fact]
    public void Parse_NormalSnapshot_ReadsAllFields()
    {
        var snapshot = TokenActivity.Parse(NormalJson);

        Assert.NotNull(snapshot);
        Assert.Equal(1, snapshot!.Schema);
        Assert.Equal(1792663219934, snapshot.UpdatedAt);
        Assert.Equal(371, snapshot.Range!.Days.GetValueOrDefault());
        Assert.Equal("2025-10-17", snapshot.Range.From);
        Assert.True(snapshot.Cost!.Estimated);
        Assert.Contains("以平台账单为准", snapshot.Cost.Note);
        Assert.Equal(2, snapshot.Days!.Count);
        Assert.Equal("2026-10-21", snapshot.Days[0].Date);
        Assert.Equal(1_240_000L, snapshot.Days[0].Tokens.GetValueOrDefault());
        Assert.Equal(0.42m, snapshot.Days[0].Cost.GetValueOrDefault());
    }

    [Fact]
    public void Parse_SortsDaysAscending()
    {
        var json = """
            {
              "schema": 1,
              "days": [
                { "date": "2026-10-22", "tokens": 2, "cost": 0.02 },
                { "date": "2026-10-20", "tokens": 1, "cost": 0.01 }
              ]
            }
            """;

        var snapshot = TokenActivity.Parse(json);

        Assert.NotNull(snapshot);
        Assert.Equal("2026-10-20", snapshot!.Days![0].Date);
        Assert.Equal("2026-10-22", snapshot.Days[1].Date);
    }

    [Fact]
    public void Parse_ReturnsNull_ForBrokenJson()
    {
        Assert.Null(TokenActivity.Parse("{ not json"));
        Assert.Null(TokenActivity.Parse(string.Empty));
        Assert.Null(TokenActivity.Parse("null"));
    }

    [Fact]
    public void Parse_ReturnsNull_ForUnsupportedSchema()
    {
        var json = """{ "schema": 2, "days": [ { "date": "2026-10-21", "tokens": 1 } ] }""";

        Assert.Null(TokenActivity.Parse(json));
    }

    [Fact]
    public void Parse_ReturnsNull_WhenDaysMissingOrEmpty()
    {
        Assert.Null(TokenActivity.Parse("""{ "schema": 1 }"""));
        Assert.Null(TokenActivity.Parse("""{ "schema": 1, "days": [] }"""));
        Assert.Null(TokenActivity.Parse("""{ "schema": 1, "days": null }"""));
    }

    [Fact]
    public void Parse_SkipsInvalidDateEntries()
    {
        var json = """
            {
              "schema": 1,
              "days": [
                { "date": "2026-13-40", "tokens": 9, "cost": 9 },
                { "date": "not-a-date", "tokens": 9, "cost": 9 },
                { "date": "2026-10-21", "tokens": 1240000, "cost": 0.42 }
              ]
            }
            """;

        var snapshot = TokenActivity.Parse(json);

        Assert.NotNull(snapshot);
        Assert.Single(snapshot!.Days!);
        Assert.Equal("2026-10-21", snapshot.Days![0].Date);
    }

    [Fact]
    public void Parse_ToleratesMissingAndNegativeFields()
    {
        var json = """
            {
              "schema": 1,
              "days": [
                { "date": "2026-10-21" },
                { "date": "2026-10-22", "tokens": -5, "cost": -1.5 }
              ]
            }
            """;

        var snapshot = TokenActivity.Parse(json);

        Assert.NotNull(snapshot);
        Assert.Equal(0L, snapshot!.Days![0].Tokens.GetValueOrDefault());
        Assert.Equal(0m, snapshot.Days[0].Cost.GetValueOrDefault());
        Assert.Equal(0L, snapshot.Days[1].Tokens.GetValueOrDefault());
        Assert.Equal(0m, snapshot.Days[1].Cost.GetValueOrDefault());
    }

    [Fact]
    public void Load_ReturnsNull_WhenFileMissing()
    {
        var path = Path.Combine(Path.GetTempPath(), "dshnotch-activity-" + Guid.NewGuid().ToString("N") + ".json");

        Assert.Null(TokenActivity.Load(path));
    }

    [Fact]
    public void Load_ReadsSnapshotFromFile()
    {
        var path = Path.Combine(Path.GetTempPath(), "dshnotch-activity-" + Guid.NewGuid().ToString("N") + ".json");
        try
        {
            File.WriteAllText(path, NormalJson);

            var snapshot = TokenActivity.Load(path);

            Assert.NotNull(snapshot);
            Assert.Equal(2, snapshot!.Days!.Count);
        }
        finally
        {
            if (File.Exists(path)) File.Delete(path);
        }
    }

    [Fact]
    public void Build_Has13ColumnsAnd7Rows()
    {
        var calendar = TokenActivityCalendar.Build(BuildDays(Today), Today);

        Assert.Equal(ActivityCalendar.Weeks, calendar.Columns.Count);
        Assert.All(calendar.Columns, column => Assert.Equal(ActivityCalendar.DaysPerWeek, column.Count));
    }

    [Fact]
    public void Build_RowsStartOnMonday()
    {
        var calendar = TokenActivityCalendar.Build(BuildDays(Today), Today);

        foreach (var column in calendar.Columns)
        {
            var monday = column[0];
            Assert.NotNull(monday);
            var date = DateTime.ParseExact(monday!.Date, "yyyy-MM-dd", CultureInfo.InvariantCulture);
            Assert.Equal(DayOfWeek.Monday, date.DayOfWeek);
        }
    }

    [Fact]
    public void Build_TodayIsInLastColumnAtItsWeekdayRow()
    {
        var calendar = TokenActivityCalendar.Build(BuildDays(Today), Today);

        var lastColumn = calendar.Columns[^1];
        var expectedRow = TokenActivityCalendar.MondayIndex(Today) - 1;

        Assert.Equal(DayKey(Today), lastColumn[expectedRow]!.Date);
        Assert.All(Enumerable.Range(0, expectedRow), row => Assert.NotNull(lastColumn[row]));
        Assert.All(Enumerable.Range(expectedRow + 1, 7 - expectedRow - 1), row => Assert.Null(lastColumn[row]));
    }

    [Fact]
    public void Build_FutureCellsAreNull()
    {
        var calendar = TokenActivityCalendar.Build(BuildDays(Today), Today);

        var futureCount = calendar.Columns
            .SelectMany(column => column)
            .Count(cell => cell is null);

        Assert.Equal(7 - TokenActivityCalendar.MondayIndex(Today), futureCount);
    }

    [Fact]
    public void Build_GridStartAndCellCountMatch13Weeks()
    {
        var calendar = TokenActivityCalendar.Build(BuildDays(Today), Today);

        var mondayIndex = TokenActivityCalendar.MondayIndex(Today);
        var firstMonday = Today.AddDays(-(mondayIndex - 1) - (ActivityCalendar.Weeks - 1) * 7);
        Assert.Equal(DayKey(firstMonday), calendar.Columns[0][0]!.Date);

        var expectedCells = (ActivityCalendar.Weeks - 1) * 7 + mondayIndex;
        Assert.Equal(expectedCells, calendar.AllCells.Count);
    }

    [Fact]
    public void Build_MapsDayValuesIntoGrid()
    {
        var days = BuildDays(Today, valueFactory: date =>
            date == Today.AddDays(-1) ? (1_240_000L, 0.42m) : (0L, 0m));

        var calendar = TokenActivityCalendar.Build(days, Today);
        var cell = calendar.AllCells.Single(item => item.Date == DayKey(Today.AddDays(-1)));

        Assert.Equal(1_240_000, cell.Tokens);
        Assert.Equal(0.42m, cell.Cost);
        Assert.False(cell.IsEmpty);
    }

    [Fact]
    public void Build_MissingDaysAreZero()
    {
        // 只给今天一天的数据，其它格子应由「逐日补零」变成 0。
        var days = new List<ActivityDay>
        {
            new() { Date = DayKey(Today), Tokens = 10, Cost = 0.01m },
        };

        var calendar = TokenActivityCalendar.Build(days, Today);
        var yesterday = calendar.AllCells.Single(item => item.Date == DayKey(Today.AddDays(-1)));

        Assert.True(yesterday.IsEmpty);
        Assert.Equal(0L, yesterday.Tokens);
        Assert.Equal(0m, yesterday.Cost);
    }

    [Fact]
    public void Build_DataNotEndingToday_LeavesTodayEmpty()
    {
        var days = BuildDays(Today.AddDays(-3));

        var calendar = TokenActivityCalendar.Build(days, Today);

        var todayCell = calendar.AllCells.Single(item => item.Date == DayKey(Today));
        Assert.True(todayCell.IsEmpty);
    }

    [Fact]
    public void MonthLabels_AreAscendingAndSpaced()
    {
        var calendar = TokenActivityCalendar.Build(BuildDays(Today), Today);

        Assert.NotEmpty(calendar.MonthLabels);
        for (var i = 1; i < calendar.MonthLabels.Count; i++)
        {
            var previous = calendar.MonthLabels[i - 1];
            var current = calendar.MonthLabels[i];
            Assert.True(current.Column > previous.Column);
            Assert.True(current.Column - previous.Column >= 4, $"月份标签太近：{previous.Column} → {current.Column}");
        }
    }

    [Fact]
    public void MonthLabels_MatchColumnMonth()
    {
        var days = BuildDays(Today);
        var calendar = TokenActivityCalendar.Build(days, Today);
        var mondayIndex = TokenActivityCalendar.MondayIndex(Today);
        var firstMonday = Today.AddDays(-(mondayIndex - 1) - (ActivityCalendar.Weeks - 1) * 7);

        foreach (var label in calendar.MonthLabels)
        {
            var wednesday = firstMonday.AddDays(label.Column * 7 + 2);
            Assert.Equal(wednesday.Month + "月", label.Label);
        }
    }

    [Theory]
    [InlineData(0, 100, 0)]
    [InlineData(-1, 100, 0)]
    [InlineData(1, 100, 1)]
    [InlineData(6, 100, 1)]
    [InlineData(7, 100, 2)]
    [InlineData(25, 100, 3)]
    [InlineData(57, 100, 4)]
    [InlineData(100, 100, 4)]
    [InlineData(50, 0, 0)]
    public void Level_UsesSquareRootThresholds(double value, double maxValue, int expected)
    {
        Assert.Equal(expected, TokenActivityCalendar.Level(value, maxValue));
    }

    [Fact]
    public void Level_MatchesDocsExamples()
    {
        Assert.Equal(1, TokenActivityCalendar.Level(6, 100));
        Assert.Equal(2, TokenActivityCalendar.Level(7, 100));
        Assert.Equal(3, TokenActivityCalendar.Level(25, 100));
        Assert.Equal(3, TokenActivityCalendar.Level(56, 100));
        Assert.Equal(4, TokenActivityCalendar.Level(57, 100));
    }

    [Fact]
    public void CellColor_TokensArePurple_MoneyIsGreen()
    {
        var tokenLevel4 = TokenActivityCalendar.CellColor(4, ActivityMetric.Tokens);
        var moneyLevel4 = TokenActivityCalendar.CellColor(4, ActivityMetric.Money);

        Assert.True(tokenLevel4.B > tokenLevel4.R && tokenLevel4.R > tokenLevel4.G, $"{tokenLevel4}");
        Assert.True(moneyLevel4.G > moneyLevel4.R && moneyLevel4.G > moneyLevel4.B, $"{moneyLevel4}");
        Assert.NotEqual(tokenLevel4, moneyLevel4);
    }

    [Fact]
    public void CellColor_LevelZeroIsDarkForBothMetrics()
    {
        var tokens = TokenActivityCalendar.CellColor(0, ActivityMetric.Tokens);
        var money = TokenActivityCalendar.CellColor(0, ActivityMetric.Money);

        Assert.Equal(tokens, money);
        Assert.True(tokens.R < 60 && tokens.G < 60 && tokens.B < 60);
    }

    [Fact]
    public void CompactCount_MatchesMacAndDocs()
    {
        Assert.Equal("0", TokenActivityCalendar.CompactCount(0));
        Assert.Equal("123", TokenActivityCalendar.CompactCount(123));
        Assert.Equal("999", TokenActivityCalendar.CompactCount(999));
        Assert.Equal("1000", TokenActivityCalendar.CompactCount(1000));
        Assert.Equal("1.23万", TokenActivityCalendar.CompactCount(12_345));
        Assert.Equal("8.3万", TokenActivityCalendar.CompactCount(83_000));
        Assert.Equal("124万", TokenActivityCalendar.CompactCount(1_240_000));
        Assert.Equal("134.6亿", TokenActivityCalendar.CompactCount(13_460_000_000));
    }

    [Fact]
    public void HoverText_TokensAndMoney()
    {
        var cell = new ActivityCell("2026-10-21", 1_240_000, 0.42m);

        Assert.Equal("10月21日 · 124万 tokens", TokenActivityCalendar.HoverText(cell, ActivityMetric.Tokens));
        Assert.Equal("10月21日 · ≈¥0.42", TokenActivityCalendar.HoverText(cell, ActivityMetric.Money));
    }

    [Fact]
    public void HoverText_ZeroDay()
    {
        var cell = new ActivityCell("2026-10-21", 0, 0m);

        Assert.Equal("10月21日 · 0 tokens", TokenActivityCalendar.HoverText(cell, ActivityMetric.Tokens));
        Assert.Equal("10月21日 · ≈¥0.00", TokenActivityCalendar.HoverText(cell, ActivityMetric.Money));
    }

    [Fact]
    public void TotalText_SumsDays()
    {
        var days = new List<ActivityDay>
        {
            new() { Date = "2026-10-21", Tokens = 1_240_000, Cost = 0.42m },
            new() { Date = "2026-10-22", Tokens = 83_000, Cost = 0.01m },
        };

        Assert.Equal("132万 tokens", TokenActivityCalendar.TotalText(days, ActivityMetric.Tokens));
        Assert.Equal("≈¥0.43", TokenActivityCalendar.TotalText(days, ActivityMetric.Money));
    }

    [Fact]
    public void View_EmptySnapshot_ShowsPlaceholderState()
    {
        var view = TokenActivityView.Create(null, ActivityMetric.Tokens, Today);

        Assert.False(view.HasData);
        Assert.Equal(string.Empty, view.TotalText);
        Assert.Equal(ActivityCalendar.Weeks, view.Calendar.Columns.Count);
        Assert.Equal("还没有用量数据", TokenActivityView.EmptyPlaceholder);
        Assert.Equal("悬停色块查看每天", TokenActivityView.HoverHint);
    }

    [Fact]
    public void View_WithData_ReportsTotalPerMetric()
    {
        var snapshot = TokenActivity.Parse(NormalJson);

        var tokens = TokenActivityView.Create(snapshot, ActivityMetric.Tokens, Today);
        var money = TokenActivityView.Create(snapshot, ActivityMetric.Money, Today);

        Assert.True(tokens.HasData);
        Assert.True(money.HasData);
        Assert.Equal("132万 tokens", tokens.TotalText);
        Assert.Equal("≈¥0.43", money.TotalText);
    }

    [Fact]
    public void View_EmptyDays_IsEmpty()
    {
        var snapshot = new TokenActivitySnapshot
        {
            Schema = 1,
            Days = new List<ActivityDay>(),
        };

        var view = TokenActivityView.Create(snapshot, ActivityMetric.Tokens, Today);

        Assert.False(view.HasData);
    }

    [Fact]
    public void TodayInBeijing_UsesChinaTimeZone()
    {
        // UTC 16:30 = 北京时间次日 00:30
        var late = DateTimeOffset.Parse("2026-10-21T16:30:00Z", CultureInfo.InvariantCulture);
        // UTC 15:59 = 北京时间当天 23:59
        var early = DateTimeOffset.Parse("2026-10-21T15:59:00Z", CultureInfo.InvariantCulture);

        Assert.Equal(new DateTime(2026, 10, 22), TokenActivityCalendar.TodayInBeijing(late));
        Assert.Equal(new DateTime(2026, 10, 21), TokenActivityCalendar.TodayInBeijing(early));
    }

    [Fact]
    public void MondayIndex_MapsWeekdays()
    {
        Assert.Equal(1, TokenActivityCalendar.MondayIndex(new DateTime(2026, 10, 19))); // 周一
        Assert.Equal(4, TokenActivityCalendar.MondayIndex(new DateTime(2026, 10, 22))); // 周四
        Assert.Equal(7, TokenActivityCalendar.MondayIndex(new DateTime(2026, 10, 25))); // 周日
    }
}
