using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace DSHNotch;

/// <summary>
/// 平台字段类型不统一：金额是十进制字符串（"28.6141700600000000"），
/// 而 code / biz_code 是 JSON 数字（0）。统一按「字符串或数字」解码，
/// 避免一处类型差异就让整次解析失败。
/// </summary>
[JsonConverter(typeof(LooseStringConverter))]
public sealed class LooseString
{
    public LooseString(string value)
    {
        Value = value;
    }

    public string Value { get; }

    public decimal Decimal =>
        decimal.TryParse(Value, NumberStyles.Float | NumberStyles.AllowThousands, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : 0m;
}

public sealed class LooseStringConverter : JsonConverter<LooseString>
{
    public override LooseString Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        switch (reader.TokenType)
        {
            case JsonTokenType.String:
                return new LooseString(reader.GetString() ?? string.Empty);
            case JsonTokenType.Number:
                return new LooseString(reader.GetDecimal().ToString(CultureInfo.InvariantCulture));
            case JsonTokenType.Null:
                return new LooseString(string.Empty);
            default:
                throw new JsonException($"既不是字符串也不是数字（{reader.TokenType}）");
        }
    }

    public override void Write(Utf8JsonWriter writer, LooseString value, JsonSerializerOptions options)
    {
        writer.WriteStringValue(value.Value);
    }
}

/// <summary>钱包（充值钱包 normal_wallets / 赠送钱包 bonus_wallets 共用）。</summary>
public sealed class Wallet
{
    [JsonPropertyName("currency")]
    public string Currency { get; set; } = string.Empty;

    [JsonPropertyName("balance")]
    public LooseString Balance { get; set; } = new(string.Empty);

    [JsonIgnore]
    public decimal Amount => Balance.Decimal;

    [JsonIgnore]
    public string Symbol => AmountFormat.Symbol(Currency);

    [JsonIgnore]
    public string Display => Symbol + AmountFormat.String(Amount);
}

/// <summary>累计消费。</summary>
public sealed class Cost
{
    [JsonPropertyName("currency")]
    public string Currency { get; set; } = string.Empty;

    [JsonPropertyName("amount")]
    public LooseString Amount { get; set; } = new(string.Empty);

    [JsonIgnore]
    public decimal CostValue => Amount.Decimal;

    [JsonIgnore]
    public string Symbol => AmountFormat.Symbol(Currency);

    [JsonIgnore]
    public string Display => Symbol + AmountFormat.String(CostValue);
}

/// <summary>一次成功查询的结果。</summary>
public sealed class BalanceSnapshot
{
    public BalanceSnapshot(
        IReadOnlyList<Wallet> normal,
        IReadOnlyList<Wallet> bonus,
        IReadOnlyList<Cost> costs,
        DateTime fetchedAt,
        Uri origin)
    {
        Normal = normal;
        Bonus = bonus;
        Costs = costs;
        FetchedAt = fetchedAt;
        Origin = origin;
    }

    public IReadOnlyList<Wallet> Normal { get; }

    public IReadOnlyList<Wallet> Bonus { get; }

    public IReadOnlyList<Cost> Costs { get; }

    public DateTime FetchedAt { get; }

    /// <summary>凭据里的平台来源。充值链接由它派生，与接口调用同一来源，且不携带任何 token。</summary>
    public Uri Origin { get; }

    /// <summary>
    /// 展示用的主钱包：优先取有余额的充值钱包。
    /// 注意：查询失败时不会走到这里——失败绝不合成 0，而是保留上一次的快照。
    /// </summary>
    public Wallet? Primary => Normal.FirstOrDefault(wallet => wallet.Amount > 0) ?? Normal.FirstOrDefault();
}

public enum BalanceErrorKind
{
    Credential,
    Http,
    Api,
    EmptyPayload,
    Transport,
    Decode,
}

public sealed class BalanceException : Exception
{
    public BalanceException(BalanceErrorKind kind, string message, Exception? inner = null, int? statusCode = null)
        : base(message, inner)
    {
        Kind = kind;
        StatusCode = statusCode;
    }

    public BalanceErrorKind Kind { get; }

    public int? StatusCode { get; }
}

/// <summary>
/// 调用 DSH 平台接口取余额。逐行对齐 Sources/Balance.swift 的 BalanceClient：
/// - 携 x-dsh-auth-token 头请求 GET {issuer}/api/v0/users/get_user_summary
/// - 超时 30s（DSH 的 balanceTimeoutMs 默认值）
/// - code / biz_code 非 "0" 视为失败，不提供金额
/// </summary>
public sealed class BalanceClient
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(30);

    private static readonly HttpClient Http = CreateHttpClient();

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = false,
    };

    public static HttpClient CreateHttpClient()
    {
        var client = new HttpClient { Timeout = Timeout };
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        return client;
    }

    public async Task<BalanceSnapshot> FetchAsync(CancellationToken cancellationToken = default)
    {
        DSHCredential credential;
        try
        {
            credential = DSHCredentials.Load();
        }
        catch (Exception ex)
        {
            throw new BalanceException(BalanceErrorKind.Credential, ex.Message, ex);
        }

        var url = credential.Issuer.ToString().TrimEnd('/') + "/api/v0/users/get_user_summary";
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.TryAddWithoutValidation("x-dsh-auth-token", credential.Token);
        request.Headers.TryAddWithoutValidation("user-agent", "DSHNotch/0.1");

        HttpResponseMessage response;
        try
        {
            response = await Http.SendAsync(request, HttpCompletionOption.ResponseContentRead, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new BalanceException(BalanceErrorKind.Transport, "请求超时（30 秒）");
        }
        catch (HttpRequestException ex)
        {
            throw new BalanceException(BalanceErrorKind.Transport, ex.Message, ex);
        }

        using (response)
        {
            var status = (int)response.StatusCode;
            if (status != 200)
            {
                throw new BalanceException(BalanceErrorKind.Http, HttpMessage(status), statusCode: status);
            }

            var text = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            return Parse(text, credential.Issuer, DateTime.Now);
        }
    }

    /// <summary>解析平台响应。抽成静态方法便于用固定 JSON 单测。</summary>
    public static BalanceSnapshot Parse(string json, Uri origin, DateTime fetchedAt)
    {
        BalanceEnvelope? envelope;
        try
        {
            envelope = JsonSerializer.Deserialize<BalanceEnvelope>(json, JsonOptions);
        }
        catch (JsonException ex)
        {
            var snippet = json.Length > 240 ? json[..240] : json;
            throw new BalanceException(BalanceErrorKind.Decode,
                $"响应解析失败：{ex.Message}；响应片段：{snippet}", ex);
        }

        if (envelope is null)
        {
            throw new BalanceException(BalanceErrorKind.Decode, "响应解析失败：空响应");
        }

        if (envelope.Code.Value != "0")
        {
            throw new BalanceException(BalanceErrorKind.Api, ApiMessage(envelope.Code.Value, envelope.Msg));
        }

        var payload = envelope.Data;
        if (payload is null || payload.BizCode.Value != "0" || payload.BizData is null)
        {
            throw new BalanceException(BalanceErrorKind.Api, ApiMessage(payload?.BizCode.Value ?? "?", payload?.BizMsg ?? envelope.Msg));
        }

        var biz = payload.BizData;
        if (biz.NormalWallets.Count == 0 && biz.BonusWallets.Count == 0)
        {
            throw new BalanceException(BalanceErrorKind.EmptyPayload, "响应里没有余额数据");
        }

        return new BalanceSnapshot(biz.NormalWallets, biz.BonusWallets, biz.TotalCosts, fetchedAt, origin);
    }

    private static string HttpMessage(int status)
    {
        return status switch
        {
            401 => "授权已失效，请在 DSH 里重新登录",
            429 => "请求过于频繁（HTTP 429），稍后自动重试",
            _ => $"服务返回 HTTP {status}",
        };
    }

    private static string ApiMessage(string code, string message)
    {
        return string.IsNullOrEmpty(message) ? $"平台返回错误码 {code}" : $"{message}（{code}）";
    }

    private sealed class BalanceEnvelope
    {
        [JsonPropertyName("code")]
        public LooseString Code { get; set; } = new("0");

        [JsonPropertyName("msg")]
        public string Msg { get; set; } = string.Empty;

        [JsonPropertyName("data")]
        public BalancePayload? Data { get; set; }
    }

    private sealed class BalancePayload
    {
        [JsonPropertyName("biz_code")]
        public LooseString BizCode { get; set; } = new("0");

        [JsonPropertyName("biz_msg")]
        public string BizMsg { get; set; } = string.Empty;

        [JsonPropertyName("biz_data")]
        public BalanceBizData? BizData { get; set; }
    }

    private sealed class BalanceBizData
    {
        [JsonPropertyName("normal_wallets")]
        public List<Wallet> NormalWallets { get; set; } = new();

        [JsonPropertyName("bonus_wallets")]
        public List<Wallet> BonusWallets { get; set; } = new();

        [JsonPropertyName("total_costs")]
        public List<Cost> TotalCosts { get; set; } = new();
    }
}
