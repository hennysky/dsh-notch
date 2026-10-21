namespace DSHNotch;

/// <summary>凭据解析失败的分类。分类保留是为了让 UI 能给出「没装 DSH」/「没登录」的引导。</summary>
public enum CredentialErrorKind
{
    FileMissing,
    RecordMissing,
    FieldMissing,
    BadIssuer,
}

public sealed class CredentialException : Exception
{
    public CredentialException(CredentialErrorKind kind, string message) : base(message)
    {
        Kind = kind;
    }

    public CredentialErrorKind Kind { get; }
}

/// <summary>DSH 保存的平台授权（token + issuer）。</summary>
public sealed class DSHCredential
{
    public DSHCredential(string token, Uri issuer)
    {
        Token = token;
        Issuer = issuer;
    }

    public string Token { get; }

    public Uri Issuer { get; }
}

/// <summary>
/// 从 %USERPROFILE%\.dsh\.credentials.yaml 读 DSH 保存的平台授权。
///
/// 只做行级解析，不引入 YAML 依赖：定位 `deepseek-account-platform/default:`
/// 这一段，取其下的 token 与 issuer。逐行对齐 Sources/Balance.swift 的 DSHCredentials。
/// </summary>
public static class DSHCredentials
{
    public const string RecordKey = "deepseek-account-platform/default";

    public static string DefaultPath =>
        System.IO.Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh", ".credentials.yaml");

    public static DSHCredential Load() => Load(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));

    public static DSHCredential Load(string homeDirectory)
    {
        var path = System.IO.Path.Combine(homeDirectory, ".dsh", ".credentials.yaml");
        if (!File.Exists(path))
        {
            throw new CredentialException(CredentialErrorKind.FileMissing, $"未找到 DSH 凭据文件（{path}）");
        }

        try
        {
            return Parse(File.ReadAllText(path));
        }
        catch (CredentialException)
        {
            throw;
        }
        catch (Exception ex)
        {
            throw new CredentialException(CredentialErrorKind.FileMissing, $"读取 DSH 凭据文件失败（{path}）：{ex.Message}");
        }
    }

    public static DSHCredential Parse(string text)
    {
        var lines = text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');

        var start = -1;
        for (var i = 0; i < lines.Length; i++)
        {
            if (lines[i].Trim(' ', '\t').StartsWith(RecordKey + ":", StringComparison.Ordinal))
            {
                start = i;
                break;
            }
        }

        if (start < 0)
        {
            throw new CredentialException(CredentialErrorKind.RecordMissing,
                $"凭据文件中没有 {RecordKey} 记录，请先在 DSH 里登录");
        }

        var headerIndent = IndentWidth(lines[start]);
        string? token = null;
        string? issuer = null;

        for (var i = start + 1; i < lines.Length; i++)
        {
            var line = lines[i];
            var trimmed = line.Trim(' ', '\t');
            if (trimmed.Length == 0 || trimmed.StartsWith("#", StringComparison.Ordinal)) continue;
            // 缩进回到同级或更浅，说明这段记录结束了
            if (IndentWidth(line) <= headerIndent) break;

            token ??= ValueOf("token", trimmed);
            issuer ??= ValueOf("issuer", trimmed);
        }

        if (string.IsNullOrEmpty(token))
        {
            throw new CredentialException(CredentialErrorKind.FieldMissing, "凭据记录缺少 token 字段");
        }

        if (string.IsNullOrEmpty(issuer) || !TryParseIssuer(issuer, out var issuerUri))
        {
            throw new CredentialException(CredentialErrorKind.BadIssuer, $"凭据 issuer 非法：{issuer ?? "<缺失>"}");
        }

        return new DSHCredential(token, issuerUri);
    }

    private static bool TryParseIssuer(string value, out Uri issuer)
    {
        if (Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
            uri.Scheme == Uri.UriSchemeHttps &&
            !string.IsNullOrEmpty(uri.Host))
        {
            issuer = uri;
            return true;
        }

        issuer = null!;
        return false;
    }

    private static int IndentWidth(string line)
    {
        var width = 0;
        foreach (var ch in line)
        {
            if (ch == ' ' || ch == '\t') width++;
            else break;
        }
        return width;
    }

    /// <summary>从 `token: xxx` 这类行里取值；key 必须完全匹配，避免误取 token_estimation 之类。</summary>
    private static string? ValueOf(string key, string trimmedLine)
    {
        var colon = trimmedLine.IndexOf(':');
        if (colon < 0) return null;
        var name = trimmedLine[..colon].Trim(' ', '\t');
        if (!string.Equals(name, key, StringComparison.Ordinal)) return null;
        var raw = trimmedLine[(colon + 1)..].Trim(' ', '\t');
        var unquoted = raw.Trim('"', '\'');
        return unquoted.Length == 0 ? null : unquoted;
    }
}
