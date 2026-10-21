using System.Diagnostics;
using System.Runtime.InteropServices;

namespace DSHNotch;

/// <summary>
/// 找 DSH 的可执行文件并启动/激活它。
///
/// 顺序：设置里的覆盖路径 → 常见安装路径 → PATH → 运行中的进程。
/// 找不到只记日志，绝不抛异常（--open-dsh 是协议唤醒路径，不能因为一次失败弹窗）。
/// </summary>
public static class DshLocator
{
    public const string ProcessName = "DeepSeek Harness";

    private static readonly string[] CandidateRelativePaths =
    {
        @"Programs\DeepSeek Harness\DeepSeek Harness.exe",
        @"Programs\deepseek-harness\DeepSeek Harness.exe",
        @"DeepSeek Harness\DeepSeek Harness.exe",
        @"DeepSeek Harness\deepseek-harness.exe",
        @"Programs\DeepSeek Harness\deepseek-harness.exe",
    };

    private static readonly string[] ExecutableNames =
    {
        "DeepSeek Harness.exe",
        "deepseek-harness.exe",
    };

    public static string? Find(Settings settings)
    {
        var configured = settings.DshExecutablePath;
        if (!string.IsNullOrWhiteSpace(configured))
        {
            if (File.Exists(configured)) return configured;
            AppLog.Write($"设置里的 DSH 路径不存在：{configured}");
        }

        foreach (var root in InstallRoots())
        {
            foreach (var relative in CandidateRelativePaths)
            {
                var candidate = Path.Combine(root, relative);
                if (File.Exists(candidate))
                {
                    AppLog.Write($"找到 DSH：{candidate}");
                    return candidate;
                }
            }
        }

        var fromPath = FindOnPath();
        if (fromPath is not null) return fromPath;

        foreach (var process in Process.GetProcessesByName(ProcessName))
        {
            try
            {
                var file = process.MainModule?.FileName;
                if (!string.IsNullOrEmpty(file) && File.Exists(file))
                {
                    AppLog.Write($"从运行中的进程找到 DSH：{file}");
                    return file;
                }
            }
            catch (Exception ex)
            {
                // 访问别的进程 MainModule 可能因为权限失败，忽略即可
                AppLog.Error("读取 DSH 进程路径失败", ex);
            }
            finally
            {
                process.Dispose();
            }
        }

        AppLog.Write("没找到 DeepSeek Harness 可执行文件（可在 settings.json 里设置 dshExecutablePath）");
        return null;
    }

    /// <summary>优先激活已运行的窗口；没运行才启动。返回是否成功。</summary>
    public static bool ActivateOrLaunch(Settings settings)
    {
        foreach (var process in Process.GetProcessesByName(ProcessName))
        {
            try
            {
                if (process.MainWindowHandle != IntPtr.Zero)
                {
                    ShowWindowAsync(process.MainWindowHandle, 9 /* SW_RESTORE */);
                    SetForegroundWindow(process.MainWindowHandle);
                    AppLog.Write($"已激活运行中的 DSH（pid {process.Id}）");
                    return true;
                }
            }
            catch (Exception ex)
            {
                AppLog.Error("激活 DSH 窗口失败", ex);
            }
            finally
            {
                process.Dispose();
            }
        }

        var executable = Find(settings);
        if (executable is null) return false;

        try
        {
            Process.Start(new ProcessStartInfo(executable) { UseShellExecute = true });
            AppLog.Write($"已启动 DSH：{executable}");
            return true;
        }
        catch (Exception ex)
        {
            AppLog.Error($"启动 DSH 失败：{executable}", ex);
            return false;
        }
    }

    private static IEnumerable<string> InstallRoots()
    {
        var roots = new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        };

        foreach (var root in roots)
        {
            if (!string.IsNullOrWhiteSpace(root)) yield return root;
        }
    }

    private static string? FindOnPath()
    {
        var path = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (var directory in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            foreach (var name in ExecutableNames)
            {
                try
                {
                    var candidate = Path.Combine(directory.Trim(), name);
                    if (File.Exists(candidate)) return candidate;
                }
                catch
                {
                    // PATH 里可能有非法路径，跳过
                }
            }
        }

        return null;
    }

    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);
}
