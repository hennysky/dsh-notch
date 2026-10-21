using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;

namespace DSHNotch;

/// <summary>
/// Windows toast 投递。非打包桌面应用走 WinRT + AUMID；任何失败都降级为
/// NotifyIcon.ShowBalloonTip（由托盘应用注入），绝不把异常抛给桥或 UI 线程。
/// </summary>
public sealed class ToastNotifier : INotificationSink
{
    private readonly Func<string, string, bool>? _balloonFallback;

    public ToastNotifier(Func<string, string, bool>? balloonFallback = null)
    {
        _balloonFallback = balloonFallback;
    }

    /// <summary>最近一次投递是否降级到了气泡（只用于日志/诊断）。</summary>
    public bool LastDeliveryUsedFallback { get; private set; }

    public bool Show(string title, string body, string kind, string? sessionId)
    {
        LastDeliveryUsedFallback = false;
        try
        {
            var xml = new XmlDocument();
            xml.LoadXml(ToastXml.Build(title, body));
            var toast = new ToastNotification(xml);
            ToastNotificationManager.CreateToastNotifier(AppInfo.Aumid).Show(toast);
            return true;
        }
        catch (Exception ex)
        {
            // AUMID 快捷方式缺失、通知被禁用、WinRT 不可用（例如精简版系统）都会走到这里。
            AppLog.Error("toast 投递失败，降级为托盘气泡", ex);
            LastDeliveryUsedFallback = true;
            try
            {
                return _balloonFallback?.Invoke(title, body) ?? false;
            }
            catch (Exception fallbackError)
            {
                AppLog.Error("托盘气泡也失败了", fallbackError);
                return false;
            }
        }
    }
}
