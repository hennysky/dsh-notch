using System.Diagnostics;
using System.Drawing;
using System.Text;
using System.Windows.Forms;

namespace DSHNotch;

/// <summary>
/// 托盘主体：NotifyIcon + 右键菜单 + 余额轮询 + 本地通知桥 + 未读红点。
///
/// 线程模型：UI 操作全部经 <see cref="_dispatcher"/> 回到 UI 线程；
/// 桥在后台线程收请求，HTTP 处理完成后只通过 Post 触碰 UI。
/// </summary>
public sealed class TrayApp : ApplicationContext
{
    private readonly Control _dispatcher = new();
    private readonly SettingsStore _settings;
    private readonly UnreadStore _unread = new();
    private readonly BalanceModel _model;
    private readonly BalanceCardForm _card;
    private readonly NotifyIcon _tray;
    private readonly ToastNotifier _notifier;
    private readonly NotificationBridgeRouter _router;
    private readonly BridgeServer _bridge;
    private readonly System.Threading.Timer _pollTimer;
    private readonly ToolStripMenuItem _startupItem;
    private readonly Icon _normalIcon;
    private readonly Icon _unreadIcon;
    private bool _disposed;

    public TrayApp(SettingsStore settings)
    {
        // 先建好 dispatcher 句柄，后台线程（桥/定时器）之后才能 BeginInvoke 到 UI 线程。
        _ = _dispatcher.Handle;

        _settings = settings;
        _normalIcon = TrayIconFactory.Create(unread: false);
        _unreadIcon = TrayIconFactory.Create(unread: true);

        _card = new BalanceCardForm(settings.Current);
        _card.SettingsChanged += OnCardSettingsChanged;
        _card.RefreshRequested += () => BeginRefresh(force: true);

        var menu = new ContextMenuStrip();
        var showItem = new ToolStripMenuItem("显示余额卡片");
        showItem.Click += (_, _) => ShowCard();
        var refreshItem = new ToolStripMenuItem("立即刷新");
        refreshItem.Click += (_, _) => BeginRefresh(force: true);
        _startupItem = new ToolStripMenuItem("开机自启")
        {
            Checked = StartupRegistration.IsEnabled(),
        };
        _startupItem.Click += (_, _) => ToggleStartup();
        var openDshItem = new ToolStripMenuItem("打开 DeepSeek Harness");
        openDshItem.Click += (_, _) => DshLocator.ActivateOrLaunch(_settings.Current);
        var openSettingsItem = new ToolStripMenuItem("打开设置文件");
        openSettingsItem.Click += (_, _) => OpenSettingsFile();
        var openLogItem = new ToolStripMenuItem("打开日志");
        openLogItem.Click += (_, _) => OpenPath(AppLog.LogPath);
        var exitItem = new ToolStripMenuItem("退出");
        exitItem.Click += (_, _) => ExitApp();

        menu.Items.Add(showItem);
        menu.Items.Add(refreshItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(_startupItem);
        menu.Items.Add(openDshItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(openSettingsItem);
        menu.Items.Add(openLogItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(exitItem);

        _tray = new NotifyIcon
        {
            Icon = _normalIcon,
            Text = AppInfo.AppName,
            Visible = true,
            ContextMenuStrip = menu,
        };
        _tray.MouseClick += OnTrayMouseClick;

        _notifier = new ToastNotifier(ShowBalloon);
        _router = new NotificationBridgeRouter(() => _settings.Current, _unread, _notifier);
        _router.NotificationShown += () => Post(RefreshPresentation);
        _bridge = new BridgeServer(_router, AppInfo.BridgePort);
        _bridge.Start();

        _model = new BalanceModel(() => _settings.Current);
        _model.Changed += () => Post(RefreshPresentation);
        _model.AlertRaised += alert => Post(() => ShowAlert(alert));

        RefreshPresentation();

        _pollTimer = new System.Threading.Timer(
            _ => Post(() => { _ = _model.RefreshAsync(); }),
            state: null,
            dueTime: TimeSpan.FromSeconds(1),
            period: TimeSpan.FromSeconds(BalanceModel.RefreshIntervalSeconds));

        AppLog.Write(_bridge.IsListening
            ? $"托盘已启动（桥端口 {_bridge.Port}）"
            : "托盘已启动（通知桥未启动，余额功能不受影响）");

        // 首次启动给一个气泡提示：本应用没有主窗口，图标又可能收在「^」里，
        // 不给提示的话「双击没反应」是用户最自然的判断。
        if (!_settings.Current.TrayIntroShown)
        {
            try
            {
                _tray.ShowBalloonTip(
                    6000,
                    AppInfo.AppName,
                    "已在系统托盘运行：左键看余额，右键更多（图标可能收在「^」里）",
                    ToolTipIcon.Info);
                var next = _settings.Current.Clone();
                next.TrayIntroShown = true;
                _settings.Save(next);
                AppLog.Write("已显示首次启动提示");
            }
            catch (Exception ex)
            {
                AppLog.Error("首次启动提示失败（不影响运行）", ex);
            }
        }
    }

    private void OnTrayMouseClick(object? sender, MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Left) ShowCard();
    }

    private void ShowCard()
    {
        try
        {
            // 打开卡片 = 已读（与 macOS 行为一致）。
            _unread.Clear();
            RefreshPresentation();
            _card.ApplySnapshot(_model);
            _card.ApplySettings(_settings.Current);
            _card.PositionNearTray();
            _card.Show();
            _card.BringToFront();
            _card.Activate();
            BeginRefresh(force: false);
        }
        catch (Exception ex)
        {
            AppLog.Error("显示余额卡片失败", ex);
        }
    }

    private void BeginRefresh(bool force)
    {
        try
        {
            if (force) AppLog.Write("手动刷新余额");
            else if (!_model.RefreshIfStale()) return;
            _ = _model.RefreshAsync();
        }
        catch (Exception ex)
        {
            AppLog.Error("触发刷新失败", ex);
        }
    }

    private void RefreshPresentation()
    {
        try
        {
            var text = new StringBuilder();
            text.Append(AppInfo.AppName).Append(" · 余额 ").Append(_model.AmountText);
            if (_unread.HasUnread) text.Append(" · ").Append(_unread.Count).Append(" 条未读通知");
            _tray.Text = Truncate(text.ToString(), 63);
            _tray.Icon = _unread.HasUnread ? _unreadIcon : _normalIcon;
            _card.ApplySnapshot(_model);
        }
        catch (Exception ex)
        {
            AppLog.Error("更新托盘展示失败", ex);
        }
    }

    private bool ShowBalloon(string title, string body)
    {
        try
        {
            // toast 失败时的降级路径：Post 到 UI 线程弹气泡，绝不阻塞桥线程。
            Post(() => ShowBalloonOnUi(title, body));
            return true;
        }
        catch (Exception ex)
        {
            AppLog.Error("调度托盘气泡失败", ex);
            return false;
        }
    }

    private void ShowBalloonOnUi(string title, string body)
    {
        try
        {
            _tray.BalloonTipTitle = Truncate(title, 63);
            _tray.BalloonTipText = Truncate(body, 255);
            _tray.ShowBalloonTip(5000);
        }
        catch (Exception ex)
        {
            AppLog.Error("显示托盘气泡失败", ex);
        }
    }

    private void ShowAlert(BalanceAlert alert)
    {
        try
        {
            AppLog.Write($"额度提醒：{alert.Title}");
            _notifier.Show(alert.Title, alert.Body, "alert", sessionId: null);
        }
        catch (Exception ex)
        {
            AppLog.Error("显示额度提醒失败", ex);
        }
    }

    private void OnCardSettingsChanged()
    {
        try
        {
            var current = _settings.Current.Clone();
            current.NotifyTaskDone = _card.NotifyTaskDone;
            current.NotifyAttention = _card.NotifyAttention;
            _settings.Save(current);
            RefreshPresentation();
        }
        catch (Exception ex)
        {
            AppLog.Error("保存通知开关失败", ex);
        }
    }

    private void ToggleStartup()
    {
        try
        {
            var enabled = !_startupItem.Checked;
            if (!StartupRegistration.SetEnabled(enabled))
            {
                ShowBalloon("开机自启设置失败", "无法写入 HKCU Run 注册表项");
                return;
            }

            _startupItem.Checked = enabled;
            var current = _settings.Current.Clone();
            current.LaunchAtLogin = enabled;
            _settings.Save(current);
        }
        catch (Exception ex)
        {
            AppLog.Error("切换开机自启失败", ex);
        }
    }

    private void OpenSettingsFile()
    {
        try
        {
            if (!File.Exists(_settings.Path)) _settings.Save(_settings.Current);
            OpenPath(_settings.Path);
        }
        catch (Exception ex)
        {
            AppLog.Error("打开设置文件失败", ex);
        }
    }

    private static void OpenPath(string path)
    {
        try
        {
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            AppLog.Error($"打开 {path} 失败", ex);
        }
    }

    private void ExitApp()
    {
        AppLog.Write("用户退出 DSHNotch");
        try
        {
            _tray.Visible = false;
        }
        catch (Exception ex)
        {
            AppLog.Error("隐藏托盘图标失败", ex);
        }

        ExitThread();
    }

    private void Post(Action action)
    {
        try
        {
            if (_disposed) return;
            _dispatcher.BeginInvoke(action);
        }
        catch (Exception ex)
        {
            AppLog.Error("UI 调度失败", ex);
        }
    }

    private static string Truncate(string text, int limit)
    {
        if (string.IsNullOrEmpty(text) || text.Length <= limit || limit <= 0) return text;
        return text[..(limit - 1)] + "…";
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !_disposed)
        {
            _disposed = true;
            TryDispose(() => _pollTimer?.Dispose());
            TryDispose(() => _bridge?.Dispose());
            TryDispose(() => _tray.Dispose());
            TryDispose(() => _card.Dispose());
            TryDispose(() => _normalIcon.Dispose());
            TryDispose(() => _unreadIcon.Dispose());
            TryDispose(() => _dispatcher.Dispose());
        }

        base.Dispose(disposing);
    }

    private static void TryDispose(Action action)
    {
        try
        {
            action();
        }
        catch (Exception ex)
        {
            AppLog.Error("释放资源失败", ex);
        }
    }
}
