using System.Text;

namespace DSHNotch;

/// <summary>
/// 极简日志。任何写日志失败都只能被吞掉：托盘应用不能因为「日志写不进去」而崩。
/// 后台线程上的所有异常都汇到这里（%TEMP%\dsh-notch-windows.log）。
/// </summary>
public static class AppLog
{
    private static readonly object Gate = new();
    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: false);

    public static string LogPath => AppPaths.LogFile;

    public static void Write(string message)
    {
        try
        {
            lock (Gate)
            {
                var directory = Path.GetDirectoryName(LogPath);
                if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
                File.AppendAllText(LogPath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {message}{Environment.NewLine}", Utf8NoBom);
            }
        }
        catch
        {
            // 日志本身就是最后一道防线，绝不能再抛。
        }
    }

    public static void Error(string context, Exception exception)
    {
        Write($"⚠️ {context}：{exception.GetType().Name}: {exception.Message}");
    }
}
