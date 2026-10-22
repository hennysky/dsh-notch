using System.Windows.Forms;

namespace DSHNotch;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            AppLog.Write($"启动 {AppInfo.AppName} {AppInfo.Version}，参数：[{string.Join(" ", args)}]");

            // --diagnose：双击没反应时的第一站。不依赖托盘/通知是否成功，
            // 把环境、路径、日志位置写进日志并弹窗，同时打开日志所在目录。
            if (HasArgument(args, "--diagnose"))
            {
                ShowDiagnostics();
                return 0;
            }
            if (HasArgument(args, "--version"))
            {
                ShowInfo($"DSHNotch {AppInfo.Version}");
                return 0;
            }

            // --open-dsh 是 toast 点击的协议唤醒路径，要在单实例判断之前处理：
            // 它只负责「把 DSH 叫到前台」，然后立即退出，不参与托盘单实例。
            if (HasArgument(args, "--open-dsh"))
            {
                var settings = new SettingsStore().Current;
                var launched = DshLocator.ActivateOrLaunch(settings);
                AppLog.Write(launched ? "协议唤醒：已定位并启动 DSH" : "协议唤醒：未找到 DSH");
                return launched ? 0 : 1;
            }

            using var mutex = new Mutex(initiallyOwned: true, @"Local\DSHNotch.SingleInstance", out var createdNew);
            if (!createdNew)
            {
                AppLog.Write("已有实例在运行，退出（再次双击不会出现第二个托盘图标）");
                // 让用户至少知道：不是没启动，而是已经在跑。
                ShowInfo("DSHNotch 已经在运行。\n\n请查看任务栏右下角的托盘图标（可能收在「^」里）：\n左键看余额，右键更多。");
                return 0;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
            }
            catch (Exception ex)
            {
                AppLog.Error("设置高 DPI 模式失败", ex);
            }

            // UI 线程异常只记日志、不退出：托盘应用要能继续跑。
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += (_, e) => AppLog.Error("UI 线程未处理异常", e.Exception);
            AppDomain.CurrentDomain.UnhandledException += (_, e) =>
                AppLog.Error("进程未处理异常", e.ExceptionObject as Exception ?? new Exception(e.ExceptionObject?.ToString() ?? "unknown"));
            TaskScheduler.UnobservedTaskException += (_, e) =>
            {
                AppLog.Error("未观察的任务异常", e.Exception);
                e.SetObserved();
            };

            // 首次运行的一次性注册。**每一项都单独兜底**：
            // 快捷方式/协议注册失败（精简系统、组策略、杀软拦截）不能阻止托盘出现。
            SafeRun("设置进程 AUMID", ShortcutCreator.EnsureProcessAumid);
            SafeRun("创建开始菜单快捷方式", () => ShortcutCreator.EnsureShortcut());
            SafeRun("注册 dshnotch:// 协议", () => ProtocolRegistration.EnsureRegistered());

            var store = new SettingsStore();
            if (store.Current.LaunchAtLogin) SafeRun("同步开机自启", () => StartupRegistration.SetEnabled(true));

            AppLog.Write("创建托盘…");
            using var app = new TrayApp(store);
            AppLog.Write("托盘已创建，进入消息循环");
            Application.Run(app);

            AppLog.Write("DSHNotch 已退出");
            return 0;
        }
        catch (Exception ex)
        {
            AppLog.Error("致命错误", ex);
            ShowFatal(ex);
            return 1;
        }
    }

    private static bool HasArgument(string[] args, string name) =>
        args.Any(arg => string.Equals(arg, name, StringComparison.OrdinalIgnoreCase));

    /// <summary>首次运行注册失败只记日志：托盘必须能起来。</summary>
    private static void SafeRun(string what, Action action)
    {
        try
        {
            action();
        }
        catch (Exception ex)
        {
            AppLog.Error($"{what}失败（已忽略，托盘照常启动）", ex);
        }
    }

    private static void ShowFatal(Exception ex)
    {
        try
        {
            MessageBox.Show(
                $"DSHNotch 启动失败\n\n{ex.GetType().Name}: {ex.Message}\n\n日志：{AppLog.LogPath}\n\n"
                + "把日志文件发给开发者可以定位问题。",
                "DSHNotch 启动失败",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
        catch
        {
            // 连弹窗都失败时，日志已经写了
        }
    }

    private static void ShowInfo(string text)
    {
        try
        {
            MessageBox.Show(text, "DSHNotch", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch
        {
            // 无 GUI 会话时忽略
        }
    }

    private static void ShowDiagnostics()
    {
        string dsh;
        try
        {
            dsh = DshLocator.Find(new SettingsStore().Current) ?? "（未找到）";
        }
        catch (Exception ex)
        {
            dsh = $"（检测失败：{ex.Message}）";
        }

        var lines = new[]
        {
            $"DSHNotch {AppInfo.Version}",
            $"系统：{Environment.OSVersion}",
            $"exe：{AppPaths.ExecutablePath}",
            $"设置：{AppPaths.SettingsFile}",
            $"日志：{AppLog.LogPath}",
            $"DSH：{dsh}",
            "",
            "托盘图标可能在任务栏右下角的「^」里：左键看余额，右键更多。",
        };
        var text = string.Join(Environment.NewLine, lines);
        AppLog.Write("诊断：" + string.Join(" | ", lines));
        ShowInfo(text);

        // 顺手打开日志所在目录，方便用户直接发日志
        try
        {
            var folder = System.IO.Path.GetDirectoryName(AppLog.LogPath);
            if (!string.IsNullOrEmpty(folder))
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(folder) { UseShellExecute = true });
        }
        catch
        {
            // 打不开资源管理器也不影响诊断信息
        }
    }
}
