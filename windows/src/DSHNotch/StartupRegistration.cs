using Microsoft.Win32;

namespace DSHNotch;

/// <summary>
/// 开机自启：HKCU\Software\Microsoft\Windows\CurrentVersion\Run。
/// 不用计划任务/服务——单用户托盘应用写当前用户 Run 键最轻、也不需要管理员。
/// </summary>
public static class StartupRegistration
{
    public const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    public const string DefaultValueName = AppInfo.AppName;

    public static bool IsEnabled() => !string.IsNullOrEmpty(GetCommand());

    public static string? GetCommand(string valueName = DefaultValueName)
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath);
            return key?.GetValue(valueName) as string;
        }
        catch (Exception ex)
        {
            AppLog.Error("读取开机自启项失败", ex);
            return null;
        }
    }

    /// <summary>可指定 valueName，便于 CI 用临时值测试后清理。</summary>
    public static bool SetEnabled(bool enabled, string? executablePath = null, string valueName = DefaultValueName)
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath, writable: true);
            if (key is null) return false;
            if (enabled)
            {
                var exe = executablePath ?? AppPaths.ExecutablePath;
                key.SetValue(valueName, $"\"{exe}\"");
                AppLog.Write("已启用开机自启（HKCU Run）");
            }
            else
            {
                key.DeleteValue(valueName, throwOnMissingValue: false);
                AppLog.Write("已关闭开机自启");
            }

            return true;
        }
        catch (Exception ex)
        {
            AppLog.Error("写入开机自启项失败", ex);
            return false;
        }
    }
}
