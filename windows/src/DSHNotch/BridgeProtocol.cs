namespace DSHNotch;

/// <summary>通知投递抽象。桥只需要知道「投递成功与否」，测试可注入假实现。</summary>
public interface INotificationSink
{
    bool Show(string title, string body, string kind, string? sessionId);
}

/// <summary>插件 POST /notify 的请求体。字段名与 docs/dsh-notifications.md 完全一致。</summary>
public sealed class NotificationPayload
{
    public string Kind { get; set; } = string.Empty;

    public string Title { get; set; } = string.Empty;

    public string Body { get; set; } = string.Empty;

    public string? SessionId { get; set; }

    public string? DedupeKey { get; set; }
}

/// <summary>一条解析出来的 HTTP 请求。桥只服务两个路由，不需要通用 Web 框架。</summary>
public sealed class BridgeHttpRequest
{
    public string Method { get; init; } = "GET";

    public string Path { get; init; } = "/";

    public byte[] Body { get; init; } = Array.Empty<byte>();
}

/// <summary>桥的响应：状态码 + JSON 文本。连接用完即关，不是长连接协议。</summary>
public sealed class BridgeHttpResponse
{
    public BridgeHttpResponse(int status, string json)
    {
        Status = status;
        Json = json;
    }

    public int Status { get; }

    public string Json { get; }
}
