using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace DSHNotch;

/// <summary>
/// 运行时画托盘图标：蓝底白字，未读时右上角叠一个红点。
/// 不用外部 .ico 资源，打包产物就只有一个 exe。
/// </summary>
public static class TrayIconFactory
{
    public const int Size = 16;

    public static Icon Create(bool unread)
    {
        using var bitmap = new Bitmap(Size, Size, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.Clear(Color.Transparent);

            using var background = new SolidBrush(Color.FromArgb(255, 52, 110, 208));
            graphics.FillEllipse(background, 0, 0, 15, 15);

            using var text = new SolidBrush(Color.White);
            using var font = new Font("Segoe UI", 8f, FontStyle.Bold, GraphicsUnit.Pixel);
            graphics.DrawString("D", font, text, new RectangleF(0, 0, 15, 15), CenteredFormat());

            if (unread)
            {
                using var red = new SolidBrush(Color.FromArgb(255, 226, 48, 48));
                graphics.FillEllipse(red, 8, 0, 8, 8);
                using var outline = new Pen(Color.White, 1f);
                graphics.DrawEllipse(outline, 8, 0, 8, 8);
            }
        }

        var handle = bitmap.GetHicon();
        try
        {
            // Icon.FromHandle 不拥有句柄，所以复制一份由 Icon 自己管理，随后销毁原句柄。
            using var temporary = Icon.FromHandle(handle);
            return (Icon)temporary.Clone();
        }
        finally
        {
            DestroyIcon(handle);
        }
    }

    private static StringFormat CenteredFormat()
    {
        var format = new StringFormat
        {
            Alignment = StringAlignment.Center,
            LineAlignment = StringAlignment.Center,
        };
        return format;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr handle);
}
