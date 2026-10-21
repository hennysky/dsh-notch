using System.Text;

namespace DSHNotch;

/// <summary>
/// Windows toast 的 XML 组装。做成纯函数，方便单测「转义后还能被合法解析」。
///
/// 非打包桌面应用的 toast 必须有 AUMID（见 <see cref="ShortcutCreator"/>）；
/// 点击行为用协议激活 dshnotch://open-dsh，由系统再拉起本进程的 --open-dsh。
/// </summary>
public static class ToastXml
{
    public const string ProtocolLaunch = AppInfo.ProtocolUrl;

    public static string Build(string title, string body)
    {
        var builder = new StringBuilder();
        builder.Append("<toast activationType=\"protocol\" launch=\"");
        builder.Append(Escape(ProtocolLaunch));
        builder.Append("\">");
        builder.Append("<visual><binding template=\"ToastGeneric\">");
        builder.Append("<text>").Append(Escape(title)).Append("</text>");
        builder.Append("<text>").Append(Escape(body)).Append("</text>");
        builder.Append("</binding></visual>");
        builder.Append("<audio src=\"ms-winsoundevent:Notification.Default\" />");
        builder.Append("</toast>");
        return builder.ToString();
    }

    /// <summary>
    /// XML 文本转义 + 去掉 XML 1.0 不允许的控制字符。
    /// 通知正文里可能有用户输入（审批理由、提问题干），必须转义，否则整条 toast 投递失败。
    /// </summary>
    public static string Escape(string text)
    {
        if (string.IsNullOrEmpty(text)) return string.Empty;

        var builder = new StringBuilder(text.Length + 16);
        foreach (var ch in text)
        {
            switch (ch)
            {
                case '&': builder.Append("&amp;"); break;
                case '<': builder.Append("&lt;"); break;
                case '>': builder.Append("&gt;"); break;
                case '"': builder.Append("&quot;"); break;
                case '\'': builder.Append("&apos;"); break;
                default:
                    // XML 1.0 不允许的控制字符（C0 里除 \t \n \r 之外的）直接丢掉；
                    // 允许代理对，emoji 要原样保留。
                    if (ch == '\t' || ch == '\n' || ch == '\r' || (ch >= 0x20 && ch != 0xFFFE && ch != 0xFFFF))
                    {
                        builder.Append(ch);
                    }
                    break;
            }
        }

        return builder.ToString();
    }
}
