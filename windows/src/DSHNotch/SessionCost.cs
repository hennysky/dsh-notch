using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace DSHNotch;

/// <summary>
/// 当前会话花费快照（schema 1），由 DSH 插件写到
/// <c>%USERPROFILE%\.dsh\notch\session-cost.json</c>。
/// 数据契约见仓库 docs/session-cost.md。
///
/// 这里只读本地 JSON、不发网络请求；字段缺失/文件损坏/过期（>24h）一律返回 null，
/// UI 整块隐藏——宁可什么都不显示，也不能显示错的金额。
/// </summary>
public sealed class SessionCostSnapshot
{
    [JsonPropertyName("schema")]
    public int Schema { get; set; }

    [JsonPropertyName("sessionId")]
    public string? SessionId { get; set; }

    [JsonPropertyName("title")]
    public string? Title { get; set; }

    [JsonPropertyName("model")]
    public string? Model { get; set; }

    [JsonPropertyName("models")]
    public List<string>? Models { get; set; }

    [JsonPropertyName("source")]
    public string? Source { get; set; }

    /// <summary>毫秒时间戳。</summary>
    [JsonPropertyName("updatedAt")]
    public long UpdatedAt { get; set; }

    [JsonPropertyName("usage")]
    public SessionCostUsage? Usage { get; set; }

    [JsonPropertyName("cost")]
    public SessionCostEstimate? Cost { get; set; }
}

public sealed class SessionCostUsage
{
    [JsonPropertyName("uncachedInputTokens")]
    public long? UncachedInputTokens { get; set; }

    [JsonPropertyName("cacheReadTokens")]
    public long? CacheReadTokens { get; set; }

    [JsonPropertyName("cacheWriteTokens")]
    public long? CacheWriteTokens { get; set; }

    [JsonPropertyName("outputTokens")]
    public long? OutputTokens { get; set; }

    [JsonPropertyName("requests")]
    public long? Requests { get; set; }
}

public sealed class SessionCostEstimate
{
    /// <summary>整会话预估金额（人民币）。未收录模型时插件仍可能写 0，同时把 priced 置 false。</summary>
    [JsonPropertyName("cny")]
    public decimal? Cny { get; set; }

    /// <summary>是否算出了金额（未收录模型为 false）。旧版/文档示例可能没有这个字段。</summary>
    [JsonPropertyName("priced")]
    public bool? Priced { get; set; }

    /// <summary>快照生成时是否处于高峰时段（仅信息展示用）。</summary>
    [JsonPropertyName("peak")]
    public bool? Peak { get; set; }

    [JsonPropertyName("estimated")]
    public bool? Estimated { get; set; }

    [JsonPropertyName("note")]
    public string? Note { get; set; }
}

public static class SessionCost
{
    public const int SupportedSchema = 1;

    /// <summary>超过 24 小时视为过期（docs/session-cost.md）。</summary>
    public static readonly TimeSpan MaxAge = TimeSpan.FromHours(24);

    public static string DefaultPath => AppPaths.SessionCostFile;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        AllowTrailingCommas = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        NumberHandling = JsonNumberHandling.AllowReadingFromString,
    };

    /// <summary>
    /// 读取并校验快照。文件不存在、JSON 坏、schema 不认识、usage 缺失、超过 24h
    /// 都返回 null（调用方整块隐藏，不报错也不写脏数据）。
    /// </summary>
    public static SessionCostSnapshot? Load(string? path = null, DateTimeOffset? now = null)
    {
        try
        {
            var file = string.IsNullOrWhiteSpace(path) ? DefaultPath : path;
            if (!File.Exists(file)) return null;
            return Parse(File.ReadAllText(file), now);
        }
        catch (Exception ex)
        {
            AppLog.Error($"读取当前会话花费失败（{path ?? DefaultPath}）", ex);
            return null;
        }
    }

    /// <summary>解析快照文本并校验 schema / 时效。抽成纯函数便于单测。</summary>
    public static SessionCostSnapshot? Parse(string? json, DateTimeOffset? now = null)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;

        SessionCostSnapshot? snapshot;
        try
        {
            snapshot = JsonSerializer.Deserialize<SessionCostSnapshot>(json, JsonOptions);
        }
        catch (JsonException ex)
        {
            AppLog.Error("解析当前会话花费失败（JSON 非法）", ex);
            return null;
        }

        if (snapshot is null) return null;
        if (snapshot.Usage is null) return null;

        var nowMilliseconds = (now ?? DateTimeOffset.Now).ToUnixTimeMilliseconds();
        return IsFresh(snapshot, nowMilliseconds) ? snapshot : null;
    }

    /// <summary>
    /// schema 兼容且没超过 24h。updatedAt 缺失（0）也算不可用——没有时间戳就无法判断新旧。
    /// </summary>
    public static bool IsFresh(SessionCostSnapshot snapshot, long nowUnixMilliseconds)
    {
        if (snapshot.Schema != SupportedSchema) return false;
        if (snapshot.UpdatedAt <= 0) return false;
        return nowUnixMilliseconds - snapshot.UpdatedAt <= MaxAge.TotalMilliseconds;
    }
}

/// <summary>
/// 卡片「当前会话」区块的展示模型。把可见性与文案全部抽成纯逻辑，
/// UI 只负责把字段贴到 Label 上，单测不需要创建 WinForms 窗口。
/// </summary>
public sealed class SessionCostCardModel
{
    public static readonly SessionCostCardModel Hidden =
        new(false, string.Empty, string.Empty, string.Empty, string.Empty, false);

    private SessionCostCardModel(
        bool isVisible,
        string titleWithModel,
        string tokens,
        string amount,
        string note,
        bool hasAmount)
    {
        IsVisible = isVisible;
        TitleWithModel = titleWithModel;
        Tokens = tokens;
        Amount = amount;
        Note = note;
        HasAmount = hasAmount;
    }

    public bool IsVisible { get; }

    /// <summary>「会话标题 · 模型」，标题过长会截断。</summary>
    public string TitleWithModel { get; }

    /// <summary>「输入 1,240,000 · 缓存 980,000 · 输出 83,000」。</summary>
    public string Tokens { get; }

    /// <summary>「≈¥0.42（预估）」；金额不可用时为空字符串。</summary>
    public string Amount { get; }

    /// <summary>插件给的说明文字，UI 目前不展示，保留给调试/未来使用。</summary>
    public string Note { get; }

    public bool HasAmount { get; }

    /// <summary>
    /// 从快照构造展示模型。快照为 null、过期、schema 不认识时返回 <see cref="Hidden"/>；
    /// 未收录模型（priced=false 或缺 cny）时仍显示 token，只是不显示金额。
    /// </summary>
    public static SessionCostCardModel From(SessionCostSnapshot? snapshot, DateTimeOffset? now = null)
    {
        if (snapshot is null || snapshot.Usage is null) return Hidden;

        var nowMilliseconds = (now ?? DateTimeOffset.Now).ToUnixTimeMilliseconds();
        if (!SessionCost.IsFresh(snapshot, nowMilliseconds)) return Hidden;

        var title = CleanTitle(snapshot.Title);
        var model = ResolveModel(snapshot);
        var titleWithModel =
            (title.Length == 0 ? "当前会话" : Truncate(title, 18)) +
            " · " +
            (model.Length == 0 ? "未知模型" : model);

        var tokens = SessionCostFormat.Tokens(snapshot.Usage);
        var hasAmount = SessionCostFormat.TryAmount(snapshot.Cost, out var amount);

        return new SessionCostCardModel(
            isVisible: true,
            titleWithModel,
            tokens,
            amount,
            snapshot.Cost?.Note ?? string.Empty,
            hasAmount);
    }

    private static string ResolveModel(SessionCostSnapshot snapshot)
    {
        if (!string.IsNullOrWhiteSpace(snapshot.Model)) return snapshot.Model.Trim();
        if (snapshot.Models is { Count: > 0 })
        {
            var first = snapshot.Models.FirstOrDefault(item => !string.IsNullOrWhiteSpace(item));
            if (first is not null) return first.Trim();
        }

        return string.Empty;
    }

    private static string CleanTitle(string? title)
    {
        if (string.IsNullOrWhiteSpace(title)) return string.Empty;
        return title.Replace("\r", " ").Replace("\n", " ").Trim();
    }

    private static string Truncate(string text, int limit)
    {
        if (text.Length <= limit) return text;
        return text[..(limit - 1)] + "…";
    }
}

/// <summary>token / 金额的展示格式化（纯函数）。</summary>
public static class SessionCostFormat
{
    public static string Tokens(SessionCostUsage usage)
    {
        return "输入 " + FormatTokens(usage.UncachedInputTokens) +
               " · 缓存 " + FormatTokens(usage.CacheReadTokens) +
               " · 输出 " + FormatTokens(usage.OutputTokens);
    }

    /// <summary>千分位；缺失按 0 处理。</summary>
    public static string FormatTokens(long? value)
    {
        return (value ?? 0).ToString("N0", CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// 金额可用时返回 true 并给出「≈¥0.42（预估）」。
    /// 未收录模型（priced=false）或缺 cny 时返回 false，调用方隐藏金额行。
    /// </summary>
    public static bool TryAmount(SessionCostEstimate? cost, out string text)
    {
        text = string.Empty;
        if (cost?.Cny is null) return false;
        if (cost.Priced == false) return false;

        text = "≈¥" + Cny(cost.Cny.Value) + "（预估）";
        return true;
    }

    /// <summary>
    /// 正常金额保留两位；很小的金额（&lt; 0.01 元）保留四位，
    /// 避免「花了 0.004 元」被显示成 ¥0.00。
    /// </summary>
    public static string Cny(decimal value)
    {
        if (value <= 0) return "0.00";
        return value >= 0.01m
            ? value.ToString("0.00", CultureInfo.InvariantCulture)
            : value.ToString("0.0000", CultureInfo.InvariantCulture);
    }
}
