using System.Text.Json;

namespace DSHNotch;

/// <summary>
/// 桥的路由与业务逻辑（纯逻辑，不依赖 TcpListener，单测可直接调 Handle）。
///
/// 协议真源：docs/dsh-notifications.md 第 1 节。
/// - GET /health  → {ok, app, version, authorization, unread}
/// - POST /notify → kind/title/body/sessionId?/dedupeKey?
///   - 设置过滤 → {ok:true, shown:false, reason:"disabled"}
///   - 授权过滤 → {... reason:"denied"|"notDetermined"}
///   - dedupeKey 5 秒内重复 → {... reason:"duplicate"}
///   - 投递成功 → {ok:true, shown:true}，未读 +1
/// - 参数不合法 400；未知路径 404；方法不对 405
/// </summary>
public sealed class NotificationBridgeRouter
{
    /// <summary>请求体上限（文档写死 64 KiB）。</summary>
    public const int MaxBodyBytes = 64 * 1024;

    /// <summary>相同 dedupeKey 的去重窗口（秒）。</summary>
    public const double DedupeWindowSeconds = 5;

    private static readonly JsonSerializerOptions RequestJsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly Func<Settings> _settings;
    private readonly UnreadStore _unread;
    private readonly INotificationSink _sink;
    private readonly Func<string> _authorization;
    private readonly Func<DateTime> _clock;

    private readonly object _gate = new();
    private readonly Dictionary<string, DateTime> _lastShown = new(StringComparer.Ordinal);

    public NotificationBridgeRouter(
        Func<Settings> settings,
        UnreadStore unread,
        INotificationSink sink,
        Func<string>? authorization = null,
        Func<DateTime>? clock = null)
    {
        _settings = settings;
        _unread = unread;
        _sink = sink;
        _authorization = authorization ?? (() => "authorized");
        _clock = clock ?? (() => DateTime.Now);
    }

    /// <summary>一条通知真正投递出去后触发：托盘应用据此更新 tooltip 与红点。</summary>
    public event Action? NotificationShown;

    public BridgeHttpResponse Handle(BridgeHttpRequest request)
    {
        try
        {
            switch (request.Path)
            {
                case "/health":
                    if (request.Method != "GET") return Error(405, "/health 只支持 GET");
                    return Health();
                case "/notify":
                    if (request.Method != "POST") return Error(405, "/notify 只支持 POST");
                    return Notify(request.Body);
                default:
                    return Error(404, $"未知路径 {request.Path}");
            }
        }
        catch (Exception ex)
        {
            AppLog.Error("桥请求处理失败", ex);
            return Error(500, "内部错误");
        }
    }

    private BridgeHttpResponse Health()
    {
        return Json(200, new
        {
            ok = true,
            app = AppInfo.AppName,
            version = AppInfo.Version,
            authorization = _authorization(),
            unread = _unread.Count,
        });
    }

    private BridgeHttpResponse Notify(byte[] body)
    {
        if (body.Length > MaxBodyBytes) return Error(413, "请求体超过 64 KiB 上限");

        NotificationPayload? decoded;
        try
        {
            decoded = JsonSerializer.Deserialize<NotificationPayload>(body, RequestJsonOptions);
        }
        catch (JsonException ex)
        {
            AppLog.Error("通知请求解析失败", ex);
            return Error(400, "请求体不是合法 JSON，或缺少 kind/title/body");
        }

        if (decoded is null) return Error(400, "请求体不是合法 JSON，或缺少 kind/title/body");

        var kind = decoded.Kind ?? string.Empty;
        if (kind != "turn-end" && kind != "attention")
        {
            return Error(400, "kind 必须是 turn-end 或 attention");
        }

        var title = (decoded.Title ?? string.Empty).Trim();
        var bodyText = (decoded.Body ?? string.Empty).Trim();
        if (title.Length == 0 || bodyText.Length == 0)
        {
            return Error(400, "title 与 body 不能为空");
        }

        // 超长不拒绝，截断后照发：插件已经截过一道，这里只是兜底。
        var payload = new NotificationPayload
        {
            Kind = kind,
            Title = Clamp(title, 120),
            Body = Clamp(bodyText, 500),
            SessionId = decoded.SessionId,
            DedupeKey = decoded.DedupeKey,
        };

        // 1) 设置过滤
        var settings = _settings();
        var enabled = kind == "turn-end" ? settings.NotifyTaskDone : settings.NotifyAttention;
        if (!enabled)
        {
            AppLog.Write($"通知被设置过滤：kind={kind}");
            return Shown(false, "disabled");
        }

        // 2) 授权过滤（Windows 上 toast 没有可查询的用户授权状态；注入一个 provider 便于测试）
        var authorization = _authorization();
        if (authorization != "authorized" && authorization != "provisional" && authorization != "ephemeral")
        {
            AppLog.Write($"通知未投递：授权状态 {authorization}");
            return Shown(false, authorization == "notDetermined" ? "notDetermined" : "denied");
        }

        // 3) 去重
        if (!string.IsNullOrEmpty(payload.DedupeKey) && !TryAcceptDedupeKey(payload.DedupeKey))
        {
            AppLog.Write($"通知去重：dedupeKey={payload.DedupeKey}");
            return Shown(false, "duplicate");
        }

        // 4) 投递
        bool delivered;
        try
        {
            delivered = _sink.Show(payload.Title, payload.Body, payload.Kind, payload.SessionId);
        }
        catch (Exception ex)
        {
            AppLog.Error("通知投递失败", ex);
            delivered = false;
        }

        if (!delivered)
        {
            AppLog.Write("通知投递失败（toast 与托盘气泡均不可用）");
            return Shown(false, "delivery-failed");
        }

        _unread.MarkUnread();
        AppLog.Write($"通知已投递 [{payload.Kind}] {payload.Title} — {payload.Body}");
        NotificationShown?.Invoke();
        return Shown(true, null);
    }

    private bool TryAcceptDedupeKey(string key)
    {
        var now = _clock();
        lock (_gate)
        {
            var cutoff = now.AddSeconds(-DedupeWindowSeconds);
            var stale = _lastShown.Where(pair => pair.Value < cutoff).Select(pair => pair.Key).ToList();
            foreach (var staleKey in stale) _lastShown.Remove(staleKey);

            if (_lastShown.TryGetValue(key, out var previous) &&
                (now - previous) < TimeSpan.FromSeconds(DedupeWindowSeconds))
            {
                return false;
            }

            _lastShown[key] = now;
            return true;
        }
    }

    private static string Clamp(string text, int limit) => text.Length <= limit ? text : text[..limit];

    private static BridgeHttpResponse Shown(bool shown, string? reason)
    {
        if (shown) return Json(200, new { ok = true, shown = true });
        return Json(200, new { ok = true, shown = false, reason });
    }

    private static BridgeHttpResponse Error(int status, string message)
        => Json(status, new { ok = false, error = message });

    private static BridgeHttpResponse Json(int status, object value)
        => new(status, JsonSerializer.Serialize(value));
}
