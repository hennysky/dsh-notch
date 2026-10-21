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

            // --open-dsh 是 toast 点击的协议唤醒路径，要在单实例判断之前处理：
            // 它只负责「把 DSH 叫到前台」，然后立即退出，不参与托盘单实例。
            if (args.Any(arg => string.Equals(arg, "--open-dsh", StringComparison.OrdinalIgnoreCase)))
            {
                var settings = new SettingsStore().Current;
                var launched = DshLocator.ActivateOrLaunch(settings);
                AppLog.Write(launched ? "协议唤醒：已定位并启动 DSH" : "协议唤醒：未找到 DSH");
                return launched ? 0 : 1;
            }

            using var mutex = new Mutex(initiallyOwned: true, @"Local\DSHNotch.SingleInstance", out var createdNew);
            if (!createdNew)
            {
                AppLog.Write("已有实例在运行，退出");
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

            // 首次运行的一次性注册（幂等，失败只记日志）。
            ShortcutCreator.EnsureProcessAumid();
            ShortcutCreator.EnsureShortcut();
            ProtocolRegistration.EnsureRegistered();

            var store = new SettingsStore();
            if (store.Current.LaunchAtLogin) StartupRegistration.SetEnabled(true);

            using var app = new TrayApp(store);
            Application.Run(app);

            AppLog.Write("DSHNotch 已退出");
            return 0;
        }
        catch (Exception ex)
        {
            AppLog.Error("致命错误", ex);
            return 1;
        }
    }
}
