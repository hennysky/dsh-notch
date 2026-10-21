using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace DSHNotch;

/// <summary>
/// 本地 HTTP 桥（移植 Sources/NotificationBridge.swift 的 TCP 部分）。
///
/// 刻意<b>不用 HttpListener</b>：那需要 URL ACL（管理员权限）才能绑 127.0.0.1:47810，
/// 一个提示余额的托盘应用不该要求提权。这里用 TcpListener + 最小 HTTP/1.1 解析。
///
/// 端口被占用等启动失败只记日志，返回 false，绝不影响余额轮询。
/// </summary>
public sealed class BridgeServer : IDisposable
{
    public const int DefaultPort = AppInfo.BridgePort;

    /// <summary>请求头上限。正常请求头只有几百字节，16 KiB 是防御值。</summary>
    public const int MaxHeaderBytes = 16 * 1024;

    /// <summary>请求体上限（文档写死 64 KiB）。</summary>
    public const int MaxBodyBytes = NotificationBridgeRouter.MaxBodyBytes;

    /// <summary>读一个请求的总时限。</summary>
    public const int ReadTimeoutMilliseconds = 5000;

    private static readonly UTF8Encoding StrictUtf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    private readonly NotificationBridgeRouter _router;
    private readonly int _requestedPort;

    private TcpListener? _listener;
    private Thread? _acceptThread;
    private volatile bool _stopping;
    private int _port;

    public BridgeServer(NotificationBridgeRouter router, int port = DefaultPort)
    {
        _router = router;
        _requestedPort = port;
    }

    /// <summary>实际绑定的端口（请求的是 0 时由系统分配，测试从这里读）。</summary>
    public int Port => _port;

    public bool IsListening => _listener is not null;

    public bool Start()
    {
        if (_listener is not null) return true;

        try
        {
            var listener = new TcpListener(IPAddress.Loopback, _requestedPort);
            // 刻意不设 SO_REUSEADDR：Windows 上它允许两个进程绑同一端口（第二个悄悄抢占），
            // 我们想要的语义是「端口被占 → 记日志、余额照常工作」。
            listener.Start();

            _listener = listener;
            _port = ((IPEndPoint)listener.LocalEndpoint).Port;
            _stopping = false;
            _acceptThread = new Thread(AcceptLoop)
            {
                IsBackground = true,
                Name = "DSHNotch.NotificationBridge",
            };
            _acceptThread.Start();
            AppLog.Write($"通知桥已启动：http://127.0.0.1:{_port}/health");
            return true;
        }
        catch (SocketException ex)
        {
            // 端口被占用是预期内的（DSHNotch 可能被开了两份）：只记日志，不阻塞余额。
            AppLog.Write($"⚠️ 通知桥端口 {_requestedPort} 启动失败（可能被占用）：{ex.Message} —— 余额功能不受影响");
            _listener = null;
            return false;
        }
        catch (Exception ex)
        {
            AppLog.Error("通知桥启动失败", ex);
            _listener = null;
            return false;
        }
    }

    public void Stop()
    {
        if (_listener is null) return;
        _stopping = true;
        try
        {
            _listener.Stop();
        }
        catch (Exception ex)
        {
            AppLog.Error("停止通知桥失败", ex);
        }
        finally
        {
            _listener = null;
            AppLog.Write("通知桥已停止");
        }
    }

    public void Dispose() => Stop();

    private void AcceptLoop()
    {
        while (!_stopping)
        {
            TcpClient client;
            try
            {
                client = _listener!.AcceptTcpClient();
            }
            catch (Exception) when (_stopping)
            {
                return;
            }
            catch (Exception ex)
            {
                // 单次 accept 失败不能让桥线程退出：记日志后继续等下一个连接。
                AppLog.Error("通知桥接受连接失败", ex);
                Thread.Sleep(50);
                continue;
            }

            ThreadPool.QueueUserWorkItem(_ => HandleClient(client));
        }
    }

    private void HandleClient(TcpClient client)
    {
        try
        {
            using (client)
            {
                client.ReceiveTimeout = ReadTimeoutMilliseconds;
                client.SendTimeout = ReadTimeoutMilliseconds;
                using var stream = client.GetStream();

                var read = ReadRequest(stream);
                var response = read.ErrorStatus != 0
                    ? BridgeHttpResponseError(read.ErrorStatus, read.ErrorMessage ?? "请求错误")
                    : _router.Handle(read.Request!);

                WriteResponse(stream, response);
            }
        }
        catch (Exception ex)
        {
            // 单条坏连接不应该把应用带走。
            AppLog.Error("通知桥处理连接失败", ex);
        }
    }

    // MARK: - 请求解析

    private sealed class ReadResult
    {
        public BridgeHttpRequest? Request { get; init; }

        public int ErrorStatus { get; init; }

        public string? ErrorMessage { get; init; }
    }

    private static ReadResult Fail(int status, string message) => new() { ErrorStatus = status, ErrorMessage = message };

    private static ReadResult Ok(string method, string path, byte[] body) =>
        new() { Request = new BridgeHttpRequest { Method = method, Path = path, Body = body } };

    private static ReadResult ReadRequest(NetworkStream stream)
    {
        using var buffer = new MemoryStream();
        var chunk = new byte[8192];
        var headerEnd = -1;

        while (headerEnd < 0)
        {
            if (buffer.Length > MaxHeaderBytes) return Fail(413, $"请求头超过 {MaxHeaderBytes} 字节");

            var read = ReadInto(stream, chunk, buffer);
            if (read < 0) return Fail(408, "读取请求超时");
            if (read == 0) return Fail(400, "请求不完整");

            headerEnd = IndexOfHeaderEnd(buffer.GetBuffer(), (int)buffer.Length);
        }

        var all = buffer.ToArray();
        var headerBytes = new byte[headerEnd];
        Array.Copy(all, headerBytes, headerBytes.Length);

        string headerText;
        try
        {
            headerText = StrictUtf8.GetString(headerBytes);
        }
        catch (Exception)
        {
            return Fail(400, "请求头不是合法 UTF-8");
        }

        var lines = headerText.Split("\r\n", StringSplitOptions.None);
        if (lines.Length == 0 || lines[0].Length == 0) return Fail(400, "缺少请求行");

        var parts = lines[0].Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length != 3) return Fail(400, "请求行格式错误");

        var method = parts[0].ToUpperInvariant();
        var target = parts[1];
        if (!parts[2].StartsWith("HTTP/1.", StringComparison.Ordinal)) return Fail(400, "只支持 HTTP/1.x");
        if (!target.StartsWith("/", StringComparison.Ordinal)) return Fail(400, "请求路径不合法");
        // 去掉查询串：/health?x=1 与 /health 等价
        var path = target.Split('?')[0];

        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 1; i < lines.Length; i++)
        {
            var line = lines[i];
            if (line.Length == 0) continue;
            var colon = line.IndexOf(':');
            if (colon <= 0) continue;
            headers[line[..colon].Trim().ToLowerInvariant()] = line[(colon + 1)..].Trim();
        }

        var bodyStart = headerEnd + 4;
        var bodyBuffer = new MemoryStream();
        bodyBuffer.Write(all, bodyStart, all.Length - bodyStart);

        var chunked = headers.TryGetValue("transfer-encoding", out var transferEncoding) &&
                      transferEncoding.Contains("chunked", StringComparison.OrdinalIgnoreCase);
        if (chunked)
        {
            while (true)
            {
                if (bodyBuffer.Length > MaxBodyBytes) return Fail(413, "请求体超过 64 KiB 上限");
                var bytes = bodyBuffer.ToArray();
                var decoded = DecodeChunked(bytes, 0, bytes.Length);
                if (decoded.Invalid) return Fail(decoded.Status, decoded.Message);
                if (decoded.Complete) return Ok(method, path, decoded.Body!);

                var read = ReadInto(stream, chunk, bodyBuffer);
                if (read < 0) return Fail(408, "读取请求超时");
                if (read == 0) return Fail(400, "请求体不完整");
            }
        }

        var contentLength = 0;
        if (headers.TryGetValue("content-length", out var rawLength))
        {
            if (!int.TryParse(rawLength, NumberStyles.Integer, CultureInfo.InvariantCulture, out contentLength) || contentLength < 0)
            {
                return Fail(400, "Content-Length 不合法");
            }
        }

        if (contentLength > MaxBodyBytes) return Fail(413, "请求体超过 64 KiB 上限");

        while (bodyBuffer.Length < contentLength)
        {
            var read = ReadInto(stream, chunk, bodyBuffer);
            if (read < 0) return Fail(408, "读取请求超时");
            if (read == 0) return Fail(400, "请求体不完整");
        }

        var body = new byte[contentLength];
        Array.Copy(bodyBuffer.GetBuffer(), 0, body, 0, contentLength);
        return Ok(method, path, body);
    }

    /// <summary>读一段并追加到 buffer。返回 -1 表示超时（IOException），0 表示对端关闭。</summary>
    private static int ReadInto(NetworkStream stream, byte[] chunk, MemoryStream buffer)
    {
        try
        {
            var read = stream.Read(chunk, 0, chunk.Length);
            if (read > 0) buffer.Write(chunk, 0, read);
            return read;
        }
        catch (IOException)
        {
            return -1;
        }
        catch (ObjectDisposedException)
        {
            return -1;
        }
    }

    private static int IndexOfHeaderEnd(byte[] data, int length)
    {
        for (var i = 0; i + 3 < length; i++)
        {
            if (data[i] == 13 && data[i + 1] == 10 && data[i + 2] == 13 && data[i + 3] == 10) return i;
        }

        return -1;
    }

    private sealed class ChunkDecodeResult
    {
        public bool Complete { get; init; }

        public bool Invalid { get; init; }

        public int Status { get; init; }

        public string Message { get; init; } = string.Empty;

        public byte[]? Body { get; init; }
    }

    private static ChunkDecodeResult ChunkIncomplete() => new();

    private static ChunkDecodeResult ChunkInvalid(int status, string message) =>
        new() { Invalid = true, Status = status, Message = message };

    private static ChunkDecodeResult ChunkComplete(byte[] body) => new() { Complete = true, Body = body };

    /// <summary>只支持「没有 trailer」的 chunked（Node/undici 的默认写法就是如此）。</summary>
    private static ChunkDecodeResult DecodeChunked(byte[] data, int offset, int end)
    {
        using var body = new MemoryStream();
        var cursor = offset;

        while (true)
        {
            var lineEnd = IndexOfCrlf(data, cursor, end);
            if (lineEnd < 0) return ChunkIncomplete();

            var line = Encoding.ASCII.GetString(data, cursor, lineEnd - cursor);
            var sizeText = line.Split(';')[0].Trim();
            if (!int.TryParse(sizeText, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var size) || size < 0)
            {
                return ChunkInvalid(400, "chunk 长度不合法");
            }

            cursor = lineEnd + 2;

            if (size == 0)
            {
                // 正常结尾是 "0\r\n\r\n"；带 trailer 的客户端极少见，遇到就算不完整等超时。
                return end >= cursor + 2 ? ChunkComplete(body.ToArray()) : ChunkIncomplete();
            }

            if (body.Length + size > MaxBodyBytes) return ChunkInvalid(413, "请求体超过 64 KiB 上限");
            if (end < cursor + size + 2) return ChunkIncomplete();
            if (data[cursor + size] != 0x0D || data[cursor + size + 1] != 0x0A)
            {
                return ChunkInvalid(400, "chunk 数据后缺少 CRLF");
            }

            body.Write(data, cursor, size);
            cursor += size + 2;
        }
    }

    private static int IndexOfCrlf(byte[] data, int offset, int end)
    {
        for (var i = offset; i + 1 < end; i++)
        {
            if (data[i] == 0x0D && data[i + 1] == 0x0A) return i;
        }

        return -1;
    }

    // MARK: - 响应

    private static void WriteResponse(NetworkStream stream, BridgeHttpResponse response)
    {
        var payload = Encoding.UTF8.GetBytes(response.Json);
        var head = "HTTP/1.1 " + response.Status + " " + Reason(response.Status) + "\r\n" +
                   "Content-Type: application/json; charset=utf-8\r\n" +
                   "Content-Length: " + payload.Length + "\r\n" +
                   "Cache-Control: no-store\r\n" +
                   "Connection: close\r\n\r\n";
        var headBytes = Encoding.UTF8.GetBytes(head);
        stream.Write(headBytes, 0, headBytes.Length);
        stream.Write(payload, 0, payload.Length);
        stream.Flush();
    }

    private static BridgeHttpResponse BridgeHttpResponseError(int status, string message)
    {
        var json = "{\"ok\":false,\"error\":" + System.Text.Json.JsonSerializer.Serialize(message) + "}";
        return new BridgeHttpResponse(status, json);
    }

    private static string Reason(int status)
    {
        return status switch
        {
            200 => "OK",
            400 => "Bad Request",
            404 => "Not Found",
            405 => "Method Not Allowed",
            408 => "Request Timeout",
            413 => "Payload Too Large",
            _ => "Internal Server Error",
        };
    }
}
