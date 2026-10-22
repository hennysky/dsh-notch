import AppKit
import Foundation
import Network
import UserNotifications

// MARK: - 通知协议
//
// 协议与验收标准的唯一真源是 docs/dsh-notifications.md。
//
// 这里刻意不引入第三方 HTTP 框架：桥只服务 127.0.0.1 的 47810 端口、只有
// GET /health 和 POST /notify 两个路由，自己解析请求比拖一整个 Web 框架
// 进来更小、更好审，也不给 DSHNotch 增加外部依赖。

/// 通知类型。`turn-end` = 任务结束，`attention` = 需要用户处理。
enum NotificationKind: String, Sendable {
    case turnEnd = "turn-end"
    case attention
}

/// 插件 POST /notify 的请求体。字段名与文档完全一致。
struct NotificationPayload: Codable, Sendable {
    var kind: String
    var title: String
    var body: String
    var sessionId: String?
    var dedupeKey: String?
}

/// `/health` 里报告的授权状态。取值即 UNUserNotificationCenter 的原始状态名。
enum NotificationAuthorization: String, Sendable {
    case authorized, denied, notDetermined, provisional, ephemeral

    init(_ status: UNAuthorizationStatus) {
        switch status {
        case .authorized: self = .authorized
        case .denied: self = .denied
        case .provisional: self = .provisional
        case .ephemeral: self = .ephemeral
        case .notDetermined: self = .notDetermined
        @unknown default: self = .notDetermined
        }
    }
}

// MARK: - 最小 HTTP 报文

private struct HTTPRequest {
    let method: String
    let path: String
    let body: Data
}

private struct HTTPResponse {
    let status: Int
    let payload: Data

    static func json(_ object: [String: Any], status: Int = 200) -> HTTPResponse {
        // sortedKeys 只是为了日志/自检输出稳定，字段顺序没有语义
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
            ?? Data("{}".utf8)
        return HTTPResponse(status: status, payload: data)
    }

    static func error(_ status: Int, _ message: String) -> HTTPResponse {
        .json(["ok": false, "error": message], status: status)
    }

    private var reason: String {
        switch status {
        case 200: return "OK"
        case 400: return "Bad Request"
        case 404: return "Not Found"
        case 405: return "Method Not Allowed"
        case 408: return "Request Timeout"
        case 204: return "No Content"
        case 413: return "Payload Too Large"
        default: return "Internal Server Error"
        }
    }

    /// 连接用完即关：不属于长连接协议，`Connection: close` 让客户端心里有数。
    func serialized() -> Data {
        var head = "HTTP/1.1 \(status) \(reason)\r\n"
        head += "Content-Type: application/json; charset=utf-8\r\n"
        head += "Content-Length: \(payload.count)\r\n"
        // 浏览器里的 DSH Client UI 插件会直接 POST 到本机桥（绕过 DSH 自己的鉴权网关），
        // 所以桥必须允许跨源；只监听 127.0.0.1，没有暴露到局域网。
        head += "Access-Control-Allow-Origin: *\r\n"
        head += "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        head += "Access-Control-Allow-Headers: content-type\r\n"
        head += "Access-Control-Allow-Private-Network: true\r\n"
        head += "Cache-Control: no-store\r\n"
        head += "Connection: close\r\n\r\n"
        var data = Data(head.utf8)
        data.append(payload)
        return data
    }
}

// MARK: - 单条连接

/// 一条 TCP 连接 = 一个请求。读满一个请求 → 交给主线程处理 → 写回 → 关闭。
///
/// 所有状态都只在 `queue` 上读写（响应回写也先切回 queue），
/// 所以不需要锁；`@unchecked Sendable` 只是告诉编译器这个约定。
private final class HTTPConnectionHandler: @unchecked Sendable {
    typealias ResponseHandler = @Sendable (HTTPResponse) -> Void

    private let connection: NWConnection
    private let queue: DispatchQueue
    private let onRequest: @Sendable (HTTPRequest, @escaping ResponseHandler) -> Void
    private var buffer = Data()
    private var closed = false
    /// 自持有。NWConnection 的回调不会保住解析器对象，`accept` 一返回它就被 ARC
    /// 收走，回调里的 `[weak self]` 全变 nil —— 表现是「curl 收到空响应」。
    /// 由连接关闭/超时时主动释放，所以不会泄漏（最长存活 readTimeout）。
    private var selfRetain: HTTPConnectionHandler?

    init(connection: NWConnection, queue: DispatchQueue,
         onRequest: @escaping @Sendable (HTTPRequest, @escaping ResponseHandler) -> Void) {
        self.connection = connection
        self.queue = queue
        self.onRequest = onRequest
    }

    func start() {
        selfRetain = self
        connection.start(queue: queue)
        receive()

        // 客户端连上却半句话不说时，`receive` 会一直挂着。单靠接收回调里的
        // 截止时间判断不出来，必须真的定时收尾，否则连接会泄漏到进程退出。
        queue.asyncAfter(deadline: .now() + NotificationBridge.readTimeout) { [weak self] in
            self?.finish(.error(408, "读取请求超时"))
        }
    }

    private func receive() {
        // 单独捕获：weak self 的 else 分支里拿不到 self，但连接必须能关掉
        let connection = self.connection
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { connection.cancel(); return }
            guard !self.closed else { return }

            if let data { self.buffer.append(data) }
            if let error {
                dshLog("通知桥：读取请求失败 \(error.localizedDescription)")
                self.close()
                return
            }

            // 头 + 体各自有上限；先卡总量，避免一个不报 Content-Length 的客户端
            // 把内存喂爆（上限之外的头由解析器按 16 KiB 拦）。
            if self.buffer.count > NotificationBridge.maxHeaderBytes + NotificationBridge.maxBodyBytes {
                self.finish(.error(413, "请求超过 64 KiB 上限"))
                return
            }

            switch HTTPConnectionHandler.parse(self.buffer) {
            case .incomplete:
                if isComplete {
                    // 请求没写完对端就关了：给不出有意义的响应，直接断开
                    self.close()
                } else {
                    self.receive()
                }
            case .invalid(let status, let message):
                self.finish(.error(status, message))
            case .request(let request):
                self.onRequest(request) { [weak self] response in
                    self?.queue.async { self?.finish(response) }
                }
            }
        }
    }

    private func finish(_ response: HTTPResponse) {
        guard !closed else { return }
        closed = true
        selfRetain = nil
        let data = response.serialized()
        connection.send(content: data, completion: .contentProcessed { [connection] _ in
            connection.cancel()
        })
    }

    private func close() {
        guard !closed else { return }
        closed = true
        selfRetain = nil
        connection.cancel()
    }

    // MARK: 解析

    private enum ParseResult {
        case incomplete
        case invalid(status: Int, message: String)
        case request(HTTPRequest)
    }

    private static func parse(_ data: Data) -> ParseResult {
        let separator = Data("\r\n\r\n".utf8)
        guard let headerRange = data.range(of: separator) else {
            if data.count > NotificationBridge.maxHeaderBytes {
                return .invalid(status: 400, message: "请求头超过 \(NotificationBridge.maxHeaderBytes) 字节")
            }
            return .incomplete
        }

        let headerData = data.subdata(in: 0..<headerRange.lowerBound)
        guard let headerText = String(data: headerData, encoding: .utf8) else {
            return .invalid(status: 400, message: "请求头不是合法 UTF-8")
        }
        let lines = headerText.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else {
            return .invalid(status: 400, message: "缺少请求行")
        }
        let parts = requestLine.split(separator: " ")
        guard parts.count == 3 else {
            return .invalid(status: 400, message: "请求行格式错误")
        }
        let method = String(parts[0]).uppercased()
        let target = String(parts[1])
        guard parts[2].hasPrefix("HTTP/1.") else {
            return .invalid(status: 400, message: "只支持 HTTP/1.x")
        }
        guard target.hasPrefix("/") else {
            return .invalid(status: 400, message: "请求路径不合法")
        }
        // 去掉查询串：/health?x=1 与 /health 等价
        let path = String(target.split(separator: "?", maxSplits: 1).first ?? "/")

        var headers: [String: String] = [:]
        for line in lines.dropFirst() where !line.isEmpty {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[name] = value
        }

        let bodyStart = headerRange.upperBound
        let transferEncoding = headers["transfer-encoding"]?.lowercased() ?? ""

        // 文档约定按 Content-Length 读；chunked 只是兜底：插件若用 Node 的
        // `http.request` 而不是 `fetch`，字符串 body 默认就是 chunked 编码，
        // 这里不支持的话表现会是「请求一直超时」——比明确报错难查得多。
        if transferEncoding.contains("chunked") {
            switch decodeChunked(data, from: bodyStart) {
            case .incomplete:
                return .incomplete
            case .invalid(let status, let message):
                return .invalid(status: status, message: message)
            case .complete(let body):
                return .request(HTTPRequest(method: method, path: path, body: body))
            }
        }

        let contentLength: Int
        if let raw = headers["content-length"] {
            guard let parsed = Int(raw), parsed >= 0 else {
                return .invalid(status: 400, message: "Content-Length 不合法")
            }
            contentLength = parsed
        } else {
            contentLength = 0
        }
        guard contentLength <= NotificationBridge.maxBodyBytes else {
            return .invalid(status: 413, message: "请求体超过 64 KiB 上限")
        }

        let available = data.count - bodyStart
        guard available >= contentLength else { return .incomplete }
        let body = data.subdata(in: bodyStart..<(bodyStart + contentLength))
        return .request(HTTPRequest(method: method, path: path, body: body))
    }

    private enum ChunkedResult {
        case incomplete
        case invalid(status: Int, message: String)
        case complete(Data)
    }

    /// 只支持「没有 trailer」的 chunked（Node/undici 的默认写法就是如此）。
    private static func decodeChunked(_ data: Data, from offset: Int) -> ChunkedResult {
        var cursor = offset
        var body = Data()

        while true {
            guard let lineEnd = indexOfCRLF(data, from: cursor) else { return .incomplete }
            let line = data.subdata(in: cursor..<lineEnd)
            guard let lineText = String(data: line, encoding: .utf8) else {
                return .invalid(status: 400, message: "chunk 头不是合法文本")
            }
            let sizeText = lineText.split(separator: ";", maxSplits: 1).first.map(String.init) ?? lineText
            guard let size = Int(sizeText.trimmingCharacters(in: .whitespaces), radix: 16), size >= 0 else {
                return .invalid(status: 400, message: "chunk 长度不合法")
            }
            cursor = lineEnd + 2

            if size == 0 {
                // 正常结尾是 "0\r\n\r\n"；带 trailer 的客户端极少见，遇到就等超时
                return data.count >= cursor + 2 ? .complete(body) : .incomplete
            }
            guard body.count + size <= NotificationBridge.maxBodyBytes else {
                return .invalid(status: 413, message: "请求体超过 64 KiB 上限")
            }
            guard data.count >= cursor + size + 2 else { return .incomplete }
            guard data[cursor + size] == 0x0D, data[cursor + size + 1] == 0x0A else {
                return .invalid(status: 400, message: "chunk 数据后缺少 CRLF")
            }
            body.append(data.subdata(in: cursor..<(cursor + size)))
            cursor += size + 2
        }
    }

    private static func indexOfCRLF(_ data: Data, from offset: Int) -> Int? {
        guard offset + 1 < data.count else { return nil }
        var index = offset
        while index + 1 < data.count {
            if data[index] == 0x0D, data[index + 1] == 0x0A { return index }
            index += 1
        }
        return nil
    }
}

// MARK: - 通知中心

/// UNUserNotificationCenter 的 delegate 是 weak，必须由桥强持有。
/// 任务量很小，没必要为它单独开文件。
private final class NotificationCenterDelegate: NSObject, UNUserNotificationCenterDelegate {
    /// 用户点开通知时回调（桥用它清未读红点）。
    var onActivate: (() -> Void)?

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // 即使 DSHNotch 自己在前台也照常弹：通知的价值在于「用户在看别的窗口」，
        // 本应用是 accessory，前台也通常只是卡片展开，不该把它当成阅读通知的时机。
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        // delegate 不保证在主线程回调，而 NSWorkspace/activate 属于 UI 动作
        DispatchQueue.main.async { [weak self] in
            self?.onActivate?()
            Self.activateDeepSeekHarness()
        }
        completionHandler()
    }

    /// 点击通知回到 DSH：优先激活已在运行的实例，没运行就按安装路径打开。
    static func activateDeepSeekHarness() {
        let bundleID = "com.deepseek.dsh"
        let running = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == bundleID }
        if let app = running.first {
            dshLog("通知点击：激活运行中的 DeepSeek Harness（pid \(app.processIdentifier)）")
            app.activate(options: [.activateAllWindows])
            return
        }

        let path = "/Applications/DeepSeek Harness.app"
        let url = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: path) else {
            dshLog("通知点击：没找到 \(path)，也无法按 bundle id 找到运行实例")
            return
        }
        dshLog("通知点击：按路径打开 \(path)")
        NSWorkspace.shared.openApplication(at: url,
                                           configuration: NSWorkspace.OpenConfiguration()) { _, error in
            if let error {
                dshLog("通知点击：打开 DeepSeek Harness 失败 \(error.localizedDescription)")
            }
        }
    }
}

// MARK: - 本地 HTTP 桥

/// DSH 通知的接收端。
///
/// 生命周期由 AppCoordinator 持有；端口被占用等启动失败只记日志，
/// 绝不影响余额轮询——余额是主体功能，通知是增强。
@MainActor
final class NotificationBridge {
    nonisolated static let defaultPort: UInt16 = 47810
    /// 请求体上限（文档写死 64 KiB）
    nonisolated static let maxBodyBytes = 64 * 1024
    /// 请求头上限。正常请求头只有几百字节，16 KiB 是防御值。
    nonisolated static let maxHeaderBytes = 16 * 1024
    /// 读一个请求的总时限
    nonisolated static let readTimeout: TimeInterval = 5
    /// 相同 dedupeKey 的去重窗口
    nonisolated static let dedupeWindow: TimeInterval = 5

    private let settings: NotchSettings
    private let port: UInt16
    /// 应用启动时是否申请通知权限。自检里关掉，避免自动化测试弹出系统授权框。
    private let requestsAuthorization: Bool
    /// 自检注入的授权状态：只影响「要不要投递」，`/health` 仍报告真实状态。
    private let authorizationOverride: (() -> NotificationAuthorization)?
    /// 自检注入的投递实现：真实运行时为 nil，走 UNUserNotificationCenter。
    private let deliveryOverride: ((NotificationPayload) -> Void)?

    private let networkQueue = DispatchQueue(label: "local.dsh.notch.bridge", qos: .userInitiated)
    private let centerDelegate = NotificationCenterDelegate()

    /// 一条通知真正投递出去后回调：主界面据此累加「未读」，让红点不会随横幅一起消失。
    var onDelivered: (() -> Void)?
    /// 用户点开通知后回调：主界面据此清掉未读。
    var onNotificationClicked: (() -> Void)?

    private var listener: NWListener?
    /// 供自检轮询：listener 进入 ready 后为 true
    private(set) var isListening = false
    /// listener 实际绑定的端口（启动失败为 nil；测试模式下的临时端口从这里读）
    private(set) var boundPort: UInt16?

    /// 授权状态缓存。启动时查一次，之后只用于 /health 与投递门禁。
    private var authorization: NotificationAuthorization = .notDetermined
    /// dedupeKey → 最近一次真正投递的时间
    private var lastShown: [String: Date] = [:]

    init(settings: NotchSettings,
         port: UInt16 = NotificationBridge.defaultPort,
         requestsAuthorization: Bool = true,
         authorizationOverride: (() -> NotificationAuthorization)? = nil,
         deliveryOverride: ((NotificationPayload) -> Void)? = nil) {
        self.settings = settings
        self.port = port
        self.requestsAuthorization = requestsAuthorization
        self.authorizationOverride = authorizationOverride
        self.deliveryOverride = deliveryOverride
        centerDelegate.onActivate = { [weak self] in self?.onNotificationClicked?() }
    }

    // MARK: 生命周期

    func start() {
        guard listener == nil else { return }

        if requestsAuthorization {
            prepareNotifications()
        } else {
            refreshAuthorization()
        }

        // 只绑回环地址。局域网里的其它机器不该能往这台机器弹通知。
        //
        // 两个实测踩过的坑（macOS 27 / Network.framework）：
        // 1. `requiredLocalEndpoint` 和 `NWListener(using:on:)` 的 `on:` 同时给会
        //    在 init 抛 EINVAL（22）——端点里已经带了端口，不能再传 on。
        // 2. 端口 0（临时端口）也照样能配 loopback 端点，所以自检兜底端口同样只绑回环。
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        let endpointPort = NWEndpoint.Port(rawValue: port) ?? .any
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: endpointPort)

        let listener: NWListener
        do {
            listener = try NWListener(using: parameters)
        } catch {
            dshLog("⚠️ 通知桥无法创建 listener（端口 \(port)）：\(error.localizedDescription)")
            return
        }
        self.listener = listener

        listener.stateUpdateHandler = { [weak self, weak listener] state in
            switch state {
            case .ready:
                let actual = listener?.port?.rawValue
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.isListening = true
                    self.boundPort = actual
                    dshLog("通知桥已启动：http://127.0.0.1:\(actual ?? self.port)/health")
                }
            case .failed(let error):
                // 端口被占用是预期内的（DSHNotch 可能被开了两份）：只记日志，不阻塞余额
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.isListening = false
                    dshLog("⚠️ 通知桥端口 \(self.port) 启动失败（可能被占用）：\(error.localizedDescription)"
                           + " —— 余额功能不受影响")
                }
                listener?.cancel()
            case .cancelled:
                Task { @MainActor [weak self] in self?.isListening = false }
            default:
                break
            }
        }

        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.start(queue: networkQueue)
    }

    func stop() {
        listener?.stateUpdateHandler = nil
        listener?.newConnectionHandler = nil
        listener?.cancel()
        listener = nil
        isListening = false
        boundPort = nil
        dshLog("通知桥已停止")
    }

    // MARK: 接受连接（在 networkQueue 上调用）

    private nonisolated func accept(_ connection: NWConnection) {
        let handler = HTTPConnectionHandler(connection: connection, queue: networkQueue) { [weak self] request, respond in
            // 解析在后台，业务（设置、通知中心）必须在主线程
            Task { @MainActor [weak self] in
                guard let self else {
                    respond(.error(500, "通知桥已停止"))
                    return
                }
                let response = self.handle(request)
                respond(response)
            }
        }
        handler.start()
    }

    // MARK: 路由（主线程）

    private func handle(_ request: HTTPRequest) -> HTTPResponse {
        // 预检请求：浏览器发 POST + JSON 前会先来一次 OPTIONS。
        if request.method == "OPTIONS" { return .json([:], status: 204) }
        switch request.path {
        case "/probe":
            guard request.method == "POST" else {
                return .error(405, "/probe 只支持 POST")
            }
            return handleProbe(request.body)
        case "/active-session":
            guard request.method == "POST" else {
                return .error(405, "/active-session 只支持 POST")
            }
            return handleActiveSession(request.body)
        case "/health":
            guard request.method == "GET" else {
                return .error(405, "/health 只支持 GET")
            }
            return healthResponse()
        case "/notify":
            guard request.method == "POST" else {
                return .error(405, "/notify 只支持 POST")
            }
            return handleNotify(request.body)
        default:
            return .error(404, "未知路径 \(request.path)")
        }
    }

    private func healthResponse() -> HTTPResponse {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.4"
        return .json([
            "ok": true,
            "app": "DSHNotch",
            "version": version,
            "authorization": authorization.rawValue,
        ])
    }

    /// Client UI 插件的诊断探针：把请求体追加到 ~/.dsh/notch/client-probe.log。
    /// 这是排查「客户端插件到底有没有加载」的最直接证据。
    private func handleProbe(_ data: Data) -> HTTPResponse {
        let directory = Self.notchDirectory()
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("client-probe.log")
        let text = String(data: data.prefix(4096), encoding: .utf8) ?? ""
        let line = "\(Self.isoNow()) \(text)\n"
        if let handle = try? FileHandle(forWritingTo: file) {
            handle.seekToEndOfFile()
            handle.write(Data(line.utf8))
            try? handle.close()
        } else {
            try? Data(line.utf8).write(to: file)
        }
        return .json(["ok": true])
    }

    /// 浏览器插件直连桥上报「当前会话」；宿主插件会轮询这个文件。
    private func handleActiveSession(_ data: Data) -> HTTPResponse {
        struct Payload: Decodable { let sessionId: String }
        guard let payload = try? JSONDecoder().decode(Payload.self, from: data),
              !payload.sessionId.isEmpty else {
            return .error(400, "缺少 sessionId")
        }
        let directory = Self.notchDirectory()
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("active-session.json")
        let object: [String: Any] = [
            "sessionId": payload.sessionId,
            "updatedAt": Int(Date().timeIntervalSince1970 * 1000),
        ]
        guard let encoded = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
            return .error(500, "序列化失败")
        }
        do {
            try encoded.write(to: file, options: .atomic)
            dshLog("桥上报当前会话：\(payload.sessionId)")
            return .json(["ok": true])
        } catch {
            return .error(500, "写入失败：\(error.localizedDescription)")
        }
    }

    private static func notchDirectory() -> URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".dsh/notch")
    }

    private static func isoNow() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }

    private func handleNotify(_ data: Data) -> HTTPResponse {
        let decoded: NotificationPayload
        do {
            decoded = try JSONDecoder().decode(NotificationPayload.self, from: data)
        } catch {
            dshLog("通知请求解析失败：\(error.localizedDescription)")
            return .error(400, "请求体不是合法 JSON，或缺少 kind/title/body")
        }

        guard let kind = NotificationKind(rawValue: decoded.kind) else {
            return .error(400, "kind 必须是 turn-end 或 attention")
        }
        let title = decoded.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = decoded.body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, !body.isEmpty else {
            return .error(400, "title 与 body 不能为空")
        }

        // 超长不拒绝，截断后照发：插件已经截过一道，这里只是兜底；
        // 因为一个标题长了 3 个字符就整条通知不发，用户会以为通知功能坏了。
        let payload = NotificationPayload(
            kind: kind.rawValue,
            title: Self.clamp(title, to: 120),
            body: Self.clamp(body, to: 500),
            sessionId: decoded.sessionId,
            dedupeKey: decoded.dedupeKey
        )

        // 1) 设置过滤
        let enabled = kind == .turnEnd ? settings.notifyTaskDone : settings.notifyAttention
        guard enabled else {
            dshLog("通知被设置过滤：kind=\(kind.rawValue)")
            return .json(["ok": true, "shown": false, "reason": "disabled"])
        }

        // 2) 授权过滤
        let effective = authorizationOverride?() ?? authorization
        guard effective == .authorized || effective == .provisional || effective == .ephemeral else {
            dshLog("通知未投递：授权状态 \(effective.rawValue)")
            let reason = effective == .notDetermined ? "notDetermined" : "denied"
            return .json(["ok": true, "shown": false, "reason": reason])
        }

        // 3) 去重
        if let key = payload.dedupeKey, !key.isEmpty {
            let now = Date()
            lastShown = lastShown.filter { now.timeIntervalSince($0.value) < Self.dedupeWindow }
            if let previous = lastShown[key], now.timeIntervalSince(previous) < Self.dedupeWindow {
                dshLog("通知去重：dedupeKey=\(key)")
                return .json(["ok": true, "shown": false, "reason": "duplicate"])
            }
            lastShown[key] = now
        }

        // 4) 投递
        deliver(payload)
        dshLog("通知已投递 [\(payload.kind)] \(payload.title) — \(payload.body)")
        return .json(["ok": true, "shown": true])
    }

    // MARK: 投递

    private func deliver(_ payload: NotificationPayload) {
        if let deliveryOverride {
            deliveryOverride(payload)
            onDelivered?()
            return
        }
        // 直接跑可执行文件（不在 .app 里）时没有 bundle，UNUserNotificationCenter
        // 会直接抛异常；自检模式不会走到这里，但防御一下，别让桥把主进程带走。
        guard Bundle.main.bundleIdentifier != nil else {
            dshLog("没有 bundle identifier，跳过系统通知投递")
            return
        }

        let content = UNMutableNotificationContent()
        content.title = payload.title
        content.body = payload.body
        content.sound = .default
        if let sessionId = payload.sessionId, !sessionId.isEmpty {
            // 点击通知时保留来源线索（目前只用于日志，将来可做「跳到该会话」）
            content.userInfo["sessionId"] = sessionId
        }
        let request = UNNotificationRequest(identifier: "local.dsh.notch.\(UUID().uuidString)",
                                            content: content,
                                            trigger: nil)
        UNUserNotificationCenter.current().add(request) { [weak self] error in
            if let error {
                dshLog("通知投递失败：\(error.localizedDescription)")
            } else {
                // 真正进了通知中心才算「未读」，投递失败不该点亮红点。
                Task { @MainActor in self?.onDelivered?() }
            }
        }
    }

    // MARK: 授权

    private func prepareNotifications() {
        guard Bundle.main.bundleIdentifier != nil else {
            dshLog("没有 bundle identifier，跳过通知授权请求")
            return
        }
        let center = UNUserNotificationCenter.current()
        center.delegate = centerDelegate
        // 应用启动时只请求一次；授权过之后系统不会再弹框，用户拒绝后也不再骚扰。
        center.requestAuthorization(options: [.alert, .sound]) { [weak self] granted, error in
            if let error {
                dshLog("通知授权请求失败：\(error.localizedDescription)")
            } else {
                dshLog("通知授权结果 granted=\(granted)")
            }
            Task { @MainActor in self?.refreshAuthorization() }
        }
    }

    private func refreshAuthorization() {
        guard Bundle.main.bundleIdentifier != nil else { return }
        UNUserNotificationCenter.current().getNotificationSettings { [weak self] settings in
            let status = NotificationAuthorization(settings.authorizationStatus)
            Task { @MainActor in
                self?.authorization = status
                dshLog("通知授权状态 = \(status.rawValue)")
            }
        }
    }

    // MARK: 小工具

    private static func clamp(_ text: String, to limit: Int) -> String {
        text.count <= limit ? text : String(text.prefix(limit))
    }
}
