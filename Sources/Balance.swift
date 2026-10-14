import Foundation

// MARK: - 数据模型

/// 平台字段类型不统一：金额是十进制字符串（"28.6141700600000000"），
/// 而 code / biz_code 是 JSON 数字（0）。统一按「字符串或数字」解码，
/// 避免一处类型差异就让整次解析失败。
struct LooseString: Decodable {
    let value: String

    init(_ value: String) { self.value = value }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let text = try? container.decode(String.self) {
            value = text
        } else if let number = try? container.decode(Decimal.self) {
            value = NSDecimalNumber(decimal: number).stringValue
        } else {
            throw DecodingError.dataCorruptedError(in: container,
                                                   debugDescription: "既不是字符串也不是数字")
        }
    }

    var decimal: Decimal { Decimal(string: value) ?? 0 }
}

/// 钱包（充值钱包 normal_wallets / 赠送钱包 bonus_wallets 共用）
struct Wallet: Decodable {
    let currency: String
    let balance: LooseString

    var amount: Decimal { balance.decimal }
    var symbol: String { AmountFormat.symbol(for: currency) }
    var display: String { symbol + AmountFormat.string(amount) }
}

/// 累计消费
struct Cost: Decodable {
    let currency: String
    let amount: LooseString

    var display: String { AmountFormat.symbol(for: currency) + AmountFormat.string(amount.decimal) }
}

/// 一次成功查询的结果
struct BalanceSnapshot {
    let normal: [Wallet]
    let bonus: [Wallet]
    let costs: [Cost]
    let fetchedAt: Date
    /// 凭据里的平台来源。充值链接由它派生，与接口调用同一来源，且不携带任何 token。
    let origin: URL

    /// 展示用的主钱包：优先取有余额的充值钱包。
    /// 注意：查询失败时不会走到这里——失败绝不合成 0，而是保留上一次的快照。
    var primary: Wallet? { normal.first { $0.amount > 0 } ?? normal.first }
}

enum AmountFormat {
    static func symbol(for currency: String) -> String {
        switch currency.uppercased() {
        case "CNY": return "¥"
        case "USD": return "$"
        default: return currency.uppercased() + " "
        }
    }

    /// 平台的余额是十进制字符串（如 "28.6141700600000000"），展示时保留两位。
    static func string(_ value: Decimal) -> String {
        let formatter = NumberFormatter()
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = 2
        formatter.roundingMode = .halfUp
        return formatter.string(from: value as NSDecimalNumber) ?? "—"
    }
}

// MARK: - 凭据读取

struct DSHCredential {
    let token: String
    let issuer: URL
}

enum CredentialError: LocalizedError {
    case fileMissing(URL)
    case recordMissing(String)
    case fieldMissing(String)
    case badIssuer(String)

    var errorDescription: String? {
        switch self {
        case .fileMissing(let url):
            return "未找到 DSH 凭据文件（\(url.path)）"
        case .recordMissing(let key):
            return "凭据文件中没有 \(key) 记录，请先在 DSH 里登录"
        case .fieldMissing(let field):
            return "凭据记录缺少 \(field) 字段"
        case .badIssuer(let value):
            return "凭据 issuer 非法：\(value)"
        }
    }
}

/// 从 ~/.dsh/.credentials.yaml 读取 DSH 保存的平台授权。
///
/// 只做行级解析，不引入 YAML 依赖：定位 `deepseek-account-platform/default:`
/// 这一段，取其下的 token 与 issuer。凭证文件是 DSH 内部格式，若将来结构变化，
/// 这里会以明确的错误提示失败，而不是静默返回错误数据。
enum DSHCredentials {
    static let recordKey = "deepseek-account-platform/default"

    static func load(home: URL = FileManager.default.homeDirectoryForCurrentUser) throws -> DSHCredential {
        let url = home.appendingPathComponent(".dsh/.credentials.yaml")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else {
            throw CredentialError.fileMissing(url)
        }
        return try parse(text)
    }

    static func parse(_ text: String) throws -> DSHCredential {
        let lines = text.components(separatedBy: .newlines)

        guard let start = lines.firstIndex(where: {
            $0.trimmingCharacters(in: .whitespaces).hasPrefix(recordKey + ":")
        }) else {
            throw CredentialError.recordMissing(recordKey)
        }

        let headerIndent = indentWidth(of: lines[start])
        var token: String?
        var issuer: String?

        for line in lines[(start + 1)...] {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty || trimmed.hasPrefix("#") { continue }
            // 缩进回到同级或更浅，说明这段记录结束了
            if indentWidth(of: line) <= headerIndent { break }

            if token == nil, let value = value(of: "token", in: trimmed) { token = value }
            if issuer == nil, let value = value(of: "issuer", in: trimmed) { issuer = value }
        }

        guard let tokenValue = token, !tokenValue.isEmpty else {
            throw CredentialError.fieldMissing("token")
        }
        guard let issuerValue = issuer, let issuerURL = URL(string: issuerValue),
              issuerURL.scheme == "https", issuerURL.host != nil else {
            throw CredentialError.badIssuer(issuer ?? "<缺失>")
        }
        return DSHCredential(token: tokenValue, issuer: issuerURL)
    }

    private static func indentWidth(of line: String) -> Int {
        line.prefix { $0 == " " || $0 == "\t" }.count
    }

    /// 从 `token: xxx` 这类行里取值；key 必须完全匹配，避免误取 token_estimation 之类。
    private static func value(of key: String, in trimmedLine: String) -> String? {
        guard let colon = trimmedLine.firstIndex(of: ":") else { return nil }
        let name = trimmedLine[trimmedLine.startIndex..<colon].trimmingCharacters(in: .whitespaces)
        guard name == key else { return nil }
        let raw = trimmedLine[trimmedLine.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        let unquoted = raw.trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
        return unquoted.isEmpty ? nil : unquoted
    }
}

/// 把 JSON 响应的字段路径摊平，用于确认平台到底提供了哪些字段。
/// DSH_NOTCH_DEBUG=1 时打进日志——排查「平台有没有按天维度」只能靠它。
func jsonFieldPaths(_ value: Any, path: String = "") -> [String] {
    if let dict = value as? [String: Any] {
        return dict.flatMap { key, nested in
            jsonFieldPaths(nested, path: path.isEmpty ? key : "\(path).\(key)")
        }.sorted()
    }
    if let array = value as? [Any], let first = array.first {
        return jsonFieldPaths(first, path: path + "[]")
    }
    return [path]
}

// MARK: - 接口调用

enum BalanceError: LocalizedError {
    case credential(Error)
    case http(Int)
    case api(code: String, message: String)
    case emptyPayload
    case transport(String)
    case decode(snippet: String, underlying: String)

    var errorDescription: String? {
        switch self {
        case .credential(let error):
            return (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        case .http(let code):
            switch code {
            case 401: return "授权已失效，请在 DSH 里重新登录"
            case 429: return "请求过于频繁（HTTP 429），稍后自动重试"
            default: return "服务返回 HTTP \(code)"
            }
        case .api(let code, let message):
            return message.isEmpty ? "平台返回错误码 \(code)" : "\(message)（\(code)）"
        case .emptyPayload:
            return "响应里没有余额数据"
        case .transport(let message):
            return message
        case .decode(let snippet, let underlying):
            return "响应解析失败：\(underlying)；响应片段：\(snippet)"
        }
    }
}

/// 调用 DSH 平台接口取余额。
///
/// 与 DSH 自身行为保持一致：
/// - 携 x-dsh-auth-token 头请求 GET {issuer}/api/v0/users/get_user_summary
/// - 超时 30s（DSH 的 balanceTimeoutMs 默认值）
/// - code / biz_code 非 "0" 视为失败，不提供金额
struct BalanceClient {
    private static let timeout: TimeInterval = 30

    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = BalanceClient.timeout
        config.timeoutIntervalForResource = BalanceClient.timeout
        config.httpAdditionalHeaders = ["Accept": "application/json"]
        return URLSession(configuration: config)
    }()

    func fetch() async throws -> BalanceSnapshot {
        let credential: DSHCredential
        do {
            credential = try DSHCredentials.load()
        } catch {
            throw BalanceError.credential(error)
        }

        let url = credential.issuer.appendingPathComponent("api/v0/users/get_user_summary")
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = Self.timeout
        request.setValue(credential.token, forHTTPHeaderField: "x-dsh-auth-token")
        request.setValue("DSHNotch/0.1", forHTTPHeaderField: "user-agent")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw BalanceError.transport((error as NSError).localizedDescription)
        }

        if let http = response as? HTTPURLResponse, http.statusCode != 200 {
            throw BalanceError.http(http.statusCode)
        }

        if let raw = try? JSONSerialization.jsonObject(with: data) {
            dshLog("响应字段: " + jsonFieldPaths(raw).joined(separator: ", "))
        }

        let envelope: Envelope
        do {
            envelope = try JSONDecoder().decode(Envelope.self, from: data)
        } catch {
            let snippet = String(data: data.prefix(240), encoding: .utf8) ?? "<非文本响应>"
            throw BalanceError.decode(snippet: snippet,
                                     underlying: String(describing: error))
        }

        guard envelope.code.value == "0" else {
            throw BalanceError.api(code: envelope.code.value, message: envelope.msg)
        }
        guard let payload = envelope.data, payload.bizCode.value == "0", let biz = payload.bizData else {
            throw BalanceError.api(code: envelope.data?.bizCode.value ?? "?",
                                   message: envelope.data?.bizMsg ?? envelope.msg)
        }
        guard !biz.normalWallets.isEmpty || !biz.bonusWallets.isEmpty else {
            throw BalanceError.emptyPayload
        }

        return BalanceSnapshot(normal: biz.normalWallets,
                               bonus: biz.bonusWallets,
                               costs: biz.totalCosts,
                               fetchedAt: Date(),
                               origin: credential.issuer)
    }

    private struct Envelope: Decodable {
        let code: LooseString
        let msg: String
        let data: Payload?

        struct Payload: Decodable {
            let bizCode: LooseString
            let bizMsg: String
            let bizData: Biz?

            enum CodingKeys: String, CodingKey {
                case bizCode = "biz_code"
                case bizMsg = "biz_msg"
                case bizData = "biz_data"
            }

            struct Biz: Decodable {
                let normalWallets: [Wallet]
                let bonusWallets: [Wallet]
                let totalCosts: [Cost]

                enum CodingKeys: String, CodingKey {
                    case normalWallets = "normal_wallets"
                    case bonusWallets = "bonus_wallets"
                    case totalCosts = "total_costs"
                }
            }
        }
    }
}
