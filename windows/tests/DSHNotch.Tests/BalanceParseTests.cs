using DSHNotch;

namespace DSHNotch.Tests;

public sealed class BalanceParseTests
{
    private static readonly Uri Origin = new("https://platform.deepseek.com");
    private static readonly DateTime FetchedAt = new(2026, 10, 22, 12, 0, 0);

    private const string OkJson = """
        {
          "code": 0,
          "msg": "",
          "data": {
            "biz_code": 0,
            "biz_msg": "",
            "biz_data": {
              "normal_wallets": [
                { "currency": "CNY", "balance": "28.6141700600000000" }
              ],
              "bonus_wallets": [
                { "currency": "CNY", "balance": "0" }
              ],
              "total_costs": [
                { "currency": "CNY", "amount": "12.5" }
              ]
            }
          }
        }
        """;

    [Fact]
    public void Parse_SnapshotFieldsAndFormatting()
    {
        var snapshot = BalanceClient.Parse(OkJson, Origin, FetchedAt);

        Assert.Single(snapshot.Normal);
        Assert.Equal(28.61m, Math.Round(snapshot.Normal[0].Amount, 2));
        Assert.Equal("¥28.61", snapshot.Primary!.Display);
        Assert.Equal("¥0.00", snapshot.Bonus[0].Display);
        Assert.Equal("¥12.50", snapshot.Costs[0].Display);
        Assert.Equal(FetchedAt, snapshot.FetchedAt);
        Assert.Equal(Origin, snapshot.Origin);
    }

    [Fact]
    public void Parse_PrefersNonZeroWalletAsPrimary()
    {
        const string json = """
            {
              "code": 0, "msg": "",
              "data": {
                "biz_code": 0, "biz_msg": "",
                "biz_data": {
                  "normal_wallets": [
                    { "currency": "CNY", "balance": "0" },
                    { "currency": "CNY", "balance": "5.00" }
                  ],
                  "bonus_wallets": [],
                  "total_costs": []
                }
              }
            }
            """;

        var snapshot = BalanceClient.Parse(json, Origin, FetchedAt);

        Assert.Equal("¥5.00", snapshot.Primary!.Display);
    }

    [Fact]
    public void Parse_ThrowsApiError_WhenTopLevelCodeNonZero()
    {
        const string json = """{ "code": 401, "msg": "登录已过期", "data": null }""";

        var error = Assert.Throws<BalanceException>(() => BalanceClient.Parse(json, Origin, FetchedAt));

        Assert.Equal(BalanceErrorKind.Api, error.Kind);
        Assert.Contains("登录已过期", error.Message);
    }

    [Fact]
    public void Parse_ThrowsApiError_WhenBizCodeNonZero()
    {
        const string json = """
            { "code": 0, "msg": "", "data": { "biz_code": 500, "biz_msg": "服务繁忙", "biz_data": null } }
            """;

        var error = Assert.Throws<BalanceException>(() => BalanceClient.Parse(json, Origin, FetchedAt));

        Assert.Equal(BalanceErrorKind.Api, error.Kind);
        Assert.Contains("服务繁忙", error.Message);
    }

    [Fact]
    public void Parse_ThrowsEmptyPayload_WhenNoWallets()
    {
        const string json = """
            {
              "code": 0, "msg": "",
              "data": {
                "biz_code": 0, "biz_msg": "",
                "biz_data": { "normal_wallets": [], "bonus_wallets": [], "total_costs": [] }
              }
            }
            """;

        var error = Assert.Throws<BalanceException>(() => BalanceClient.Parse(json, Origin, FetchedAt));

        Assert.Equal(BalanceErrorKind.EmptyPayload, error.Kind);
    }

    [Fact]
    public void Parse_ThrowsDecode_WhenBodyIsNotJson()
    {
        var error = Assert.Throws<BalanceException>(() => BalanceClient.Parse("<html>bad gateway</html>", Origin, FetchedAt));

        Assert.Equal(BalanceErrorKind.Decode, error.Kind);
    }

    [Fact]
    public void LooseString_AcceptsStringAndNumber()
    {
        var fromString = System.Text.Json.JsonSerializer.Deserialize<LooseString>("\"28.61\"");
        var fromNumber = System.Text.Json.JsonSerializer.Deserialize<LooseString>("28.61");

        Assert.Equal(28.61m, fromString!.Decimal);
        Assert.Equal(28.61m, fromNumber!.Decimal);
    }

    [Fact]
    public void AmountFormat_UsesCurrencySymbol()
    {
        Assert.Equal("¥", AmountFormat.Symbol("CNY"));
        Assert.Equal("$", AmountFormat.Symbol("usd"));
        Assert.Equal("EUR ", AmountFormat.Symbol("EUR"));
        Assert.Equal("28.61", AmountFormat.String(28.6141700600000000m));
        Assert.Equal("2.63", AmountFormat.String(2.625m));
    }
}
