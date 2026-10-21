using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using DSHNotch;

namespace DSHNotch.Tests;

public sealed class BridgeTests
{
    private sealed class FakeNotificationSink : INotificationSink
    {
        public List<(string Title, string Body, string Kind, string? SessionId)> Calls { get; } = new();

        public bool Result { get; set; } = true;

        public bool Show(string title, string body, string kind, string? sessionId)
        {
            Calls.Add((title, body, kind, sessionId));
            return Result;
        }
    }

    private sealed class Harness : IDisposable
    {
        public Harness(Func<string>? authorization = null)
        {
            var router = new NotificationBridgeRouter(() => Settings, Unread, Sink, authorization);
            Server = new BridgeServer(router, port: 0);
            Assert.True(Server.Start(), "桥未能启动");
        }

        public Settings Settings { get; } = new();

        public UnreadStore Unread { get; } = new();

        public FakeNotificationSink Sink { get; } = new();

        public BridgeServer Server { get; }

        public HttpClient Client { get; } = new() { Timeout = TimeSpan.FromSeconds(10) };

        public async Task<(HttpStatusCode Status, JsonElement Json)> SendAsync(
            HttpMethod method, string path, string? json = null)
        {
            using var request = new HttpRequestMessage(method, new Uri($"http://127.0.0.1:{Server.Port}{path}"));
            if (json is not null)
            {
                request.Content = new StringContent(json, Encoding.UTF8, "application/json");
            }

            using var response = await Client.SendAsync(request);
            var text = await response.Content.ReadAsStringAsync();
            using var document = JsonDocument.Parse(text);
            return (response.StatusCode, document.RootElement.Clone());
        }

        public void Dispose()
        {
            Client.Dispose();
            Server.Dispose();
        }
    }

    private static string NotifyJson(
        string kind = "turn-end",
        string title = "任务完成",
        string body = "default-workspace · 用时 42 秒",
        string? dedupeKey = null,
        string? sessionId = "session-1")
    {
        var payload = new Dictionary<string, object?>
        {
            ["kind"] = kind,
            ["title"] = title,
            ["body"] = body,
        };
        if (dedupeKey is not null) payload["dedupeKey"] = dedupeKey;
        if (sessionId is not null) payload["sessionId"] = sessionId;
        return JsonSerializer.Serialize(payload);
    }

    [Fact]
    public async Task Health_ReturnsProtocolFields()
    {
        using var harness = new Harness();

        var (status, json) = await harness.SendAsync(HttpMethod.Get, "/health");

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.True(json.GetProperty("ok").GetBoolean());
        Assert.Equal("DSHNotch", json.GetProperty("app").GetString());
        Assert.False(string.IsNullOrEmpty(json.GetProperty("version").GetString()));
        Assert.Equal("authorized", json.GetProperty("authorization").GetString());
        Assert.Equal(0, json.GetProperty("unread").GetInt32());
    }

    [Fact]
    public async Task Notify_Valid_ShowsAndMarksUnread()
    {
        using var harness = new Harness();

        var (status, json) = await harness.SendAsync(HttpMethod.Post, "/notify", NotifyJson());

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.True(json.GetProperty("shown").GetBoolean());
        Assert.Single(harness.Sink.Calls);
        Assert.Equal("任务完成", harness.Sink.Calls[0].Title);
        Assert.Equal("turn-end", harness.Sink.Calls[0].Kind);
        Assert.Equal(1, harness.Unread.Count);

        var (_, health) = await harness.SendAsync(HttpMethod.Get, "/health");
        Assert.Equal(1, health.GetProperty("unread").GetInt32());
    }

    [Fact]
    public async Task Notify_DisabledBySettings_ReturnsDisabledReason()
    {
        using var harness = new Harness();
        harness.Settings.NotifyTaskDone = false;

        var (status, json) = await harness.SendAsync(HttpMethod.Post, "/notify", NotifyJson());

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.False(json.GetProperty("shown").GetBoolean());
        Assert.Equal("disabled", json.GetProperty("reason").GetString());
        Assert.Empty(harness.Sink.Calls);
        Assert.Equal(0, harness.Unread.Count);
    }

    [Fact]
    public async Task Notify_AttentionDisabled_ReturnsDisabledReason()
    {
        using var harness = new Harness();
        harness.Settings.NotifyAttention = false;

        var (_, json) = await harness.SendAsync(
            HttpMethod.Post, "/notify", NotifyJson(kind: "attention", title: "需要你确认"));

        Assert.False(json.GetProperty("shown").GetBoolean());
        Assert.Equal("disabled", json.GetProperty("reason").GetString());
    }

    [Fact]
    public async Task Notify_DedupesSameKeyWithinWindow()
    {
        using var harness = new Harness();
        var body = NotifyJson(dedupeKey: "turn-end:session-1:7");

        var (_, first) = await harness.SendAsync(HttpMethod.Post, "/notify", body);
        var (_, second) = await harness.SendAsync(HttpMethod.Post, "/notify", body);

        Assert.True(first.GetProperty("shown").GetBoolean());
        Assert.False(second.GetProperty("shown").GetBoolean());
        Assert.Equal("duplicate", second.GetProperty("reason").GetString());
        Assert.Single(harness.Sink.Calls);
        Assert.Equal(1, harness.Unread.Count);
    }

    [Fact]
    public async Task Notify_WithoutDedupeKey_ShowsEveryTime()
    {
        using var harness = new Harness();

        await harness.SendAsync(HttpMethod.Post, "/notify", NotifyJson());
        await harness.SendAsync(HttpMethod.Post, "/notify", NotifyJson());

        Assert.Equal(2, harness.Sink.Calls.Count);
        Assert.Equal(2, harness.Unread.Count);
    }

    [Fact]
    public async Task Notify_InvalidJson_Returns400()
    {
        using var harness = new Harness();

        var (status, json) = await harness.SendAsync(HttpMethod.Post, "/notify", "{ not json");

        Assert.Equal(HttpStatusCode.BadRequest, status);
        Assert.False(json.GetProperty("ok").GetBoolean());
        Assert.Equal(0, harness.Unread.Count);
    }

    [Fact]
    public async Task Notify_UnknownKind_Returns400()
    {
        using var harness = new Harness();

        var (status, json) = await harness.SendAsync(HttpMethod.Post, "/notify", NotifyJson(kind: "bogus"));

        Assert.Equal(HttpStatusCode.BadRequest, status);
        Assert.False(json.GetProperty("ok").GetBoolean());
    }

    [Fact]
    public async Task Notify_EmptyTitle_Returns400()
    {
        using var harness = new Harness();

        var (status, _) = await harness.SendAsync(HttpMethod.Post, "/notify", NotifyJson(title: "   "));

        Assert.Equal(HttpStatusCode.BadRequest, status);
    }

    [Fact]
    public async Task Notify_TruncatesTitleAndBody()
    {
        using var harness = new Harness();
        var title = new string('标', 150);
        var body = new string('文', 600);

        await harness.SendAsync(HttpMethod.Post, "/notify", NotifyJson(title: title, body: body));

        Assert.Single(harness.Sink.Calls);
        Assert.Equal(120, harness.Sink.Calls[0].Title.Length);
        Assert.Equal(500, harness.Sink.Calls[0].Body.Length);
    }

    [Fact]
    public async Task Notify_DeniedAuthorization_ReturnsDeniedReason()
    {
        using var harness = new Harness(authorization: () => "denied");

        var (status, json) = await harness.SendAsync(HttpMethod.Post, "/notify", NotifyJson());

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.False(json.GetProperty("shown").GetBoolean());
        Assert.Equal("denied", json.GetProperty("reason").GetString());
        Assert.Equal(0, harness.Unread.Count);
    }

    [Fact]
    public async Task Notify_DeliveryFailure_ReturnsDeliveryFailed()
    {
        using var harness = new Harness();
        harness.Sink.Result = false;

        var (status, json) = await harness.SendAsync(HttpMethod.Post, "/notify", NotifyJson());

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.False(json.GetProperty("shown").GetBoolean());
        Assert.Equal("delivery-failed", json.GetProperty("reason").GetString());
        Assert.Equal(0, harness.Unread.Count);
    }

    [Fact]
    public async Task UnknownPath_Returns404()
    {
        using var harness = new Harness();

        var (status, json) = await harness.SendAsync(HttpMethod.Get, "/nope");

        Assert.Equal(HttpStatusCode.NotFound, status);
        Assert.False(json.GetProperty("ok").GetBoolean());
    }

    [Fact]
    public async Task WrongMethod_Returns405()
    {
        using var harness = new Harness();

        var (getNotify, _) = await harness.SendAsync(HttpMethod.Get, "/notify");
        var (postHealth, _) = await harness.SendAsync(HttpMethod.Post, "/health", NotifyJson());

        Assert.Equal(HttpStatusCode.MethodNotAllowed, getNotify);
        Assert.Equal(HttpStatusCode.MethodNotAllowed, postHealth);
    }

    [Fact]
    public async Task MalformedRequestLine_Returns400()
    {
        using var harness = new Harness();
        using var tcp = new TcpClient();
        await tcp.ConnectAsync(IPAddress.Loopback, harness.Server.Port);
        using var stream = tcp.GetStream();
        var bytes = Encoding.ASCII.GetBytes("BAD\r\n\r\n");
        await stream.WriteAsync(bytes);
        stream.Flush();

        using var reader = new StreamReader(stream, Encoding.ASCII);
        var statusLine = await reader.ReadLineAsync();

        Assert.Equal("HTTP/1.1 400 Bad Request", statusLine);
    }

    [Fact]
    public void PortInUse_StartFailsWithoutThrowing()
    {
        using var harness = new Harness();
        using var second = new BridgeServer(new NotificationBridgeRouter(
            () => new Settings(), new UnreadStore(), new FakeNotificationSink()), harness.Server.Port);

        var started = second.Start();

        Assert.False(started);
    }

    [Fact]
    public async Task Notify_AllowsAttentionByDefault_AndPassesSessionId()
    {
        using var harness = new Harness();

        await harness.SendAsync(
            HttpMethod.Post, "/notify", NotifyJson(kind: "attention", title: "需要你确认", sessionId: "session-9"));

        var call = Assert.Single(harness.Sink.Calls);
        Assert.Equal("attention", call.Kind);
        Assert.Equal("session-9", call.SessionId);
    }
}
