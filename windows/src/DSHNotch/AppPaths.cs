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

    /// <summary>
    /// 当前会话花费快照（schema 见 docs/session-cost.md）。由 DSH 插件原子写入，
    /// 本应用只读；路径固定在 DSH home 下，两个平台读同一份。
    /// </summary>
    public static string SessionCostFile =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh", "notch", "session-cost.json");

    /// <summary>
    /// 每日用量快照（schema 见 docs/token-activity.md）。由 DSH 插件按天聚合后原子写入，
    /// 本应用只读；文件出现前日历页显示占位。
    /// </summary>
    public static string TokenActivityFile =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh", "notch", "token-activity.json");

    /// <summary>后台线程异常与运行日志：%TEMP%\dsh-notch-windows.log（任务要求写死在这里）。</summary>
    public static string LogFile => Path.Combine(Path.GetTempPath(), "dsh-notch-windows.log");

    /// <summary>开始菜单里的快捷方式：非打包应用要靠它拿 AUMID，toast 才能显示。</summary>
    public static string StartMenuShortcut =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "DSHNotch.lnk");
}
