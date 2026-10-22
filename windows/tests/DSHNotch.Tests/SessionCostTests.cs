using DSHNotch;

namespace DSHNotch.Tests;

public sealed class SessionCostTests
{
    private const long UpdatedAt = 1_761_200_000_000;
    private static readonly DateTimeOffset SnapshotTime = DateTimeOffset.FromUnixTimeMilliseconds(UpdatedAt);

    private static DateTimeOffset MinutesAfterSnapshot(int minutes) => SnapshotTime.AddMinutes(minutes);

    private const string UsageJson = """
        "uncachedInputTokens": 1240000,
        "cacheReadTokens": 980000,
        "cacheWriteTokens": 0,
        "outputTokens": 83000,
        "requests": 12
        """;

    private const string CostJson = """
        "cny": 0.42,
        "priced": true,
        "peak": true,
        "estimated": true,
        "note": "按官方公开单价估算，以平台账单为准"
        """;

    private static string SnapshotJson(
        int schema = 1,
        long updatedAt = UpdatedAt,
        string? usageJson = null,
        string? costJson = null,
        string title = "修 Windows 通知",
        string model = "deepseek-flash",
        string models = "\"models\": [\"deepseek-flash\"],")
    {
        var usage = usageJson ?? UsageJson;
        var cost = costJson ?? CostJson;
        return $$"""
            {
              "schema": {{schema}},
              "sessionId": "session-abc",
              "title": "{{title}}",
              "model": "{{model}}",
              {{models}}
              "source": "client",
              "updatedAt": {{updatedAt}},
              "usage": { {{usage}} },
              "cost": { {{cost}} }
            }
            """;
    }

    [Fact]
    public void Parse_NormalSnapshot_ReadsAllFields()
    {
        var snapshot = SessionCost.Parse(SnapshotJson(), MinutesAfterSnapshot(1));

        Assert.NotNull(snapshot);
        Assert.Equal(1, snapshot!.Schema);
        Assert.Equal("session-abc", snapshot.SessionId);
        Assert.Equal("修 Windows 通知", snapshot.Title);
        Assert.Equal("deepseek-flash", snapshot.Model);
        Assert.Equal(new[] { "deepseek-flash" }, snapshot.Models);
        Assert.Equal("client", snapshot.Source);
        Assert.Equal(UpdatedAt, snapshot.UpdatedAt);
        Assert.Equal(1_240_000, snapshot.Usage!.UncachedInputTokens);
        Assert.Equal(980_000, snapshot.Usage.CacheReadTokens);
        Assert.Equal(83_000, snapshot.Usage.OutputTokens);
        Assert.Equal(12, snapshot.Usage.Requests);
        Assert.Equal(0.42m, snapshot.Cost!.Cny);
        Assert.True(snapshot.Cost.Priced);
        Assert.True(snapshot.Cost.Peak);
        Assert.Contains("以平台账单为准", snapshot.Cost.Note);
    }

    [Fact]
    public void Parse_AcceptsDocsExampleWithoutPriced()
    {
        var json = SnapshotJson(costJson: """
            "cny": 0.42,
            "peak": true,
            "estimated": true,
            "note": "按官方公开单价估算，以平台账单为准"
            """);

        var snapshot = SessionCost.Parse(json, MinutesAfterSnapshot(1));

        Assert.NotNull(snapshot);
        Assert.Null(snapshot!.Cost!.Priced);
        Assert.Equal(0.42m, snapshot.Cost.Cny);
    }

    [Fact]
    public void Load_ReturnsNull_WhenFileMissing()
    {
        var path = Path.Combine(Path.GetTempPath(), "dshnotch-session-" + Guid.NewGuid().ToString("N") + ".json");

        Assert.Null(SessionCost.Load(path, MinutesAfterSnapshot(1)));
    }

    [Fact]
    public void Parse_ReturnsNull_ForBrokenJson()
    {
        Assert.Null(SessionCost.Parse("{ this is not json", MinutesAfterSnapshot(1)));
        Assert.Null(SessionCost.Parse(string.Empty, MinutesAfterSnapshot(1)));
    }

    [Fact]
    public void Parse_ReturnsNull_WhenStale()
    {
        // 超过 24 小时：卡片整块隐藏。
        Assert.Null(SessionCost.Parse(SnapshotJson(), MinutesAfterSnapshot(25 * 60)));
    }

    [Fact]
    public void Parse_AcceptsAtExactly24Hours()
    {
        var snapshot = SessionCost.Parse(SnapshotJson(), MinutesAfterSnapshot(24 * 60));

        Assert.NotNull(snapshot);
    }

    [Fact]
    public void Parse_ReturnsNull_ForUnsupportedSchema()
    {
        Assert.Null(SessionCost.Parse(SnapshotJson(schema: 2), MinutesAfterSnapshot(1)));
    }

    [Fact]
    public void Parse_ReturnsNull_WhenUpdatedAtMissing()
    {
        Assert.Null(SessionCost.Parse(SnapshotJson(updatedAt: 0), MinutesAfterSnapshot(1)));
    }

    [Fact]
    public void Parse_ReturnsNull_WhenUsageMissing()
    {
        var json = $$"""
            { "schema": 1, "updatedAt": {{UpdatedAt}}, "usage": null }
            """;

        Assert.Null(SessionCost.Parse(json, MinutesAfterSnapshot(1)));
    }

    [Fact]
    public void Parse_ToleratesMissingUsageFields()
    {
        var snapshot = SessionCost.Parse(SnapshotJson(usageJson: "\"requests\": 3"), MinutesAfterSnapshot(1));

        Assert.NotNull(snapshot);
        Assert.Null(snapshot!.Usage!.UncachedInputTokens);
        Assert.Equal(3, snapshot.Usage.Requests);

        var card = SessionCostCardModel.From(snapshot, MinutesAfterSnapshot(1));
        Assert.Equal("输入 0 · 缓存 0 · 输出 0", card.Tokens);
    }

    [Fact]
    public void Load_ReadsSnapshotFromFile()
    {
        var path = Path.Combine(Path.GetTempPath(), "dshnotch-session-" + Guid.NewGuid().ToString("N") + ".json");
        try
        {
            File.WriteAllText(path, SnapshotJson());

            var snapshot = SessionCost.Load(path, MinutesAfterSnapshot(1));

            Assert.NotNull(snapshot);
            Assert.Equal("session-abc", snapshot!.SessionId);
        }
        finally
        {
            if (File.Exists(path)) File.Delete(path);
        }
    }

    [Fact]
    public void CardModel_Hidden_WhenSnapshotNull()
    {
        var card = SessionCostCardModel.From(null, MinutesAfterSnapshot(1));

        Assert.False(card.IsVisible);
        Assert.Equal(string.Empty, card.TitleWithModel);
        Assert.Equal(string.Empty, card.Tokens);
        Assert.False(card.HasAmount);
    }

    [Fact]
    public void CardModel_Visible_WithDocumentedFields()
    {
        var snapshot = SessionCost.Parse(SnapshotJson(), MinutesAfterSnapshot(1));

        var card = SessionCostCardModel.From(snapshot, MinutesAfterSnapshot(1));

        Assert.True(card.IsVisible);
        Assert.Equal("修 Windows 通知 · deepseek-flash", card.TitleWithModel);
        Assert.Equal("输入 1,240,000 · 缓存 980,000 · 输出 83,000", card.Tokens);
        Assert.Equal("≈¥0.42（预估）", card.Amount);
        Assert.True(card.HasAmount);
    }

    [Fact]
    public void CardModel_UnpricedModel_ShowsTokensButHidesAmount()
    {
        // 未收录模型：插件写 priced=false，token 仍有效，金额不可用。
        var json = SnapshotJson(
            model: "some-unlisted-model",
            costJson: """
                "cny": 0,
                "priced": false,
                "peak": false,
                "estimated": true,
                "note": "未收录模型"
                """);
        var snapshot = SessionCost.Parse(json, MinutesAfterSnapshot(1));

        var card = SessionCostCardModel.From(snapshot, MinutesAfterSnapshot(1));

        Assert.True(card.IsVisible);
        Assert.Contains("some-unlisted-model", card.TitleWithModel);
        Assert.False(card.HasAmount);
        Assert.Equal(string.Empty, card.Amount);
        Assert.Equal("输入 1,240,000 · 缓存 980,000 · 输出 83,000", card.Tokens);
    }

    [Fact]
    public void CardModel_MissingCny_HidesAmount()
    {
        var snapshot = SessionCost.Parse(
            SnapshotJson(costJson: "\"priced\": true, \"estimated\": true"),
            MinutesAfterSnapshot(1));

        var card = SessionCostCardModel.From(snapshot, MinutesAfterSnapshot(1));

        Assert.True(card.IsVisible);
        Assert.False(card.HasAmount);
        Assert.Equal(string.Empty, card.Amount);
    }

    [Fact]
    public void CardModel_Hidden_WhenStale()
    {
        var snapshot = SessionCost.Parse(SnapshotJson(), MinutesAfterSnapshot(1));
        Assert.NotNull(snapshot);

        var card = SessionCostCardModel.From(snapshot, MinutesAfterSnapshot(25 * 60));

        Assert.False(card.IsVisible);
    }

    [Fact]
    public void CardModel_TruncatesLongTitle()
    {
        var longTitle = new string('标', 40);
        var snapshot = SessionCost.Parse(SnapshotJson(title: longTitle), MinutesAfterSnapshot(1));

        var card = SessionCostCardModel.From(snapshot, MinutesAfterSnapshot(1));

        var titlePart = card.TitleWithModel.Split(" · ")[0];
        Assert.Equal(18, titlePart.Length);
        Assert.EndsWith("…", titlePart);
    }

    [Fact]
    public void CardModel_FallsBackForEmptyTitleAndModel()
    {
        var json = SnapshotJson(title: "", model: "", models: "\"models\": [],");
        var snapshot = SessionCost.Parse(json, MinutesAfterSnapshot(1));

        var card = SessionCostCardModel.From(snapshot, MinutesAfterSnapshot(1));

        Assert.Equal("当前会话 · 未知模型", card.TitleWithModel);
    }

    [Fact]
    public void CardModel_UsesFirstKnownModelWhenModelFieldEmpty()
    {
        var json = SnapshotJson(model: "", models: "\"models\": [\"deepseek-v4-pro\", \"deepseek-flash\"],");
        var snapshot = SessionCost.Parse(json, MinutesAfterSnapshot(1));

        var card = SessionCostCardModel.From(snapshot, MinutesAfterSnapshot(1));

        Assert.Contains("deepseek-v4-pro", card.TitleWithModel);
    }

    [Fact]
    public void CardModel_CleansNewlinesInTitle()
    {
        var json = SnapshotJson(title: "第一行\\n第二行");
        var snapshot = SessionCost.Parse(json, MinutesAfterSnapshot(1));

        var card = SessionCostCardModel.From(snapshot, MinutesAfterSnapshot(1));

        // JSON 里的 \n 解析成真实换行，展示时替换成空格
        Assert.StartsWith("第一行 第二行", card.TitleWithModel);
    }

    [Fact]
    public void Format_TokensUsesThousandsSeparator()
    {
        Assert.Equal("1,234,567", SessionCostFormat.FormatTokens(1_234_567));
        Assert.Equal("0", SessionCostFormat.FormatTokens(null));
    }

    [Fact]
    public void Format_AmountUsesTwoDecimals()
    {
        Assert.True(SessionCostFormat.TryAmount(new SessionCostEstimate { Cny = 2.5m, Priced = true }, out var text));
        Assert.Equal("≈¥2.50（预估）", text);
        Assert.Equal("0.42", SessionCostFormat.Cny(0.42m));
        Assert.Equal("0.00", SessionCostFormat.Cny(0m));
    }

    [Fact]
    public void Format_TinyAmountKeepsFourDecimals()
    {
        // 花了 0.004 元不能显示成 ¥0.00
        Assert.Equal("0.0040", SessionCostFormat.Cny(0.004m));
    }

    [Fact]
    public void Format_UnpricedReturnsFalse()
    {
        Assert.False(SessionCostFormat.TryAmount(new SessionCostEstimate { Cny = 0m, Priced = false }, out var text));
        Assert.Equal(string.Empty, text);
        Assert.False(SessionCostFormat.TryAmount(null, out _));
    }

    [Fact]
    public void IsFresh_ChecksSchemaAndAge()
    {
        var snapshot = new SessionCostSnapshot
        {
            Schema = 1,
            UpdatedAt = UpdatedAt,
            Usage = new SessionCostUsage(),
        };

        Assert.True(SessionCost.IsFresh(snapshot, UpdatedAt + 1000));
        Assert.False(SessionCost.IsFresh(snapshot, UpdatedAt + (long)SessionCost.MaxAge.TotalMilliseconds + 1));
        Assert.False(SessionCost.IsFresh(new SessionCostSnapshot { Schema = 2, UpdatedAt = UpdatedAt, Usage = new() }, UpdatedAt));
        Assert.False(SessionCost.IsFresh(new SessionCostSnapshot { Schema = 1, UpdatedAt = 0, Usage = new() }, UpdatedAt));
    }
}
