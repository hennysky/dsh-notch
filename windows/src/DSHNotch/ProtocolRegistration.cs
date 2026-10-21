using Microsoft.Win32;

namespace DSHNotch;

/// <summary>
/// 注册 dshnotch:// 协议（HKCU\Software\Classes），点击 toast 时由系统拉起
/// `DSHNotch.exe --open-dsh`。写 HKCU 不需要管理员权限。
/// </summary>
public static class ProtocolRegistration
{
    public const string Scheme = AppInfo.ProtocolScheme;

    public static bool EnsureRegistered(string? executablePath = null)
    {
        var exe = executablePath ?? AppPaths.ExecutablePath;
        if (string.IsNullOrEmpty(exe))
        {
            AppLog.Write("注册协议跳过：拿不到当前可执行文件路径");
            return false;
        }

        return Register(Scheme, exe);
    }

    /// <summary>可指定 scheme，便于 CI 用临时 scheme 测试后清理。</summary>
    public static bool Register(string scheme, string executablePath, string arguments = "--open-dsh")
    {
        try
        {
            using var root = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{scheme}", writable: true);
            if (root is null) return false;
            root.SetValue(string.Empty, "URL:DSHNotch Protocol");
            root.SetValue("URL Protocol", string.Empty);
            using var command = root.CreateSubKey(@"shell\open\command", writable: true);
            command?.SetValue(string.Empty, $"\"{executablePath}\" {arguments}".TrimEnd());
            AppLog.Write($"已注册协议 {scheme}:// → \"{executablePath}\" {arguments}");
            return true;
        }
        catch (Exception ex)
        {
            AppLog.Error($"注册协议 {scheme} 失败", ex);
            return false;
        }
    }

    public static string? ReadCommand(string scheme = Scheme)
    {
        try
        {
            using var command = Registry.CurrentUser.OpenSubKey($@"Software\Classes\{scheme}\shell\open\command");
            return command?.GetValue(string.Empty) as string;
        }
        catch (Exception ex)
        {
            AppLog.Error($"读取协议 {scheme} 失败", ex);
            return null;
        }
    }

    public static void Unregister(string scheme)
    {
        try
        {
            Registry.CurrentUser.DeleteSubKeyTree($@"Software\Classes\{scheme}", throwOnMissingSubKey: false);
        }
        catch (Exception ex)
        {
            AppLog.Error($"清除协议 {scheme} 失败", ex);
        }
    }
}
