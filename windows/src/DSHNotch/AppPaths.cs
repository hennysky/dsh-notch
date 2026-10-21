using System.Diagnostics;

namespace DSHNotch;

/// <summary>落盘位置。集中在一处，测试可以自己传路径，不必依赖这些默认值。</summary>
public static class AppPaths
{
    /// <summary>当前进程的可执行文件（单文件发布时是 exe 本身，不是解包目录）。</summary>
    public static string ExecutablePath =>
        Environment.ProcessPath
        ?? Process.GetCurrentProcess().MainModule?.FileName
        ?? string.Empty;

    /// <summary>%APPDATA%\DSHNotch</summary>
    public static string DataDirectory =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "DSHNotch");

    public static string SettingsFile => Path.Combine(DataDirectory, "settings.json");

    public static string DailyCostFile => Path.Combine(DataDirectory, "daily-cost.json");

    /// <summary>后台线程异常与运行日志：%TEMP%\dsh-notch-windows.log（任务要求写死在这里）。</summary>
    public static string LogFile => Path.Combine(Path.GetTempPath(), "dsh-notch-windows.log");

    /// <summary>开始菜单里的快捷方式：非打包应用要靠它拿 AUMID，toast 才能显示。</summary>
    public static string StartMenuShortcut =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "DSHNotch.lnk");
}
