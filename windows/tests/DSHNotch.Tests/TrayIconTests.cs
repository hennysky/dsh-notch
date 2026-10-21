using System.Drawing;
using DSHNotch;

namespace DSHNotch.Tests;

/// <summary>
/// 运行时画的托盘图标：unread 时确实有红色像素，正常时没有。
/// 只在 Windows 上跑（System.Drawing.Common 在其它平台不可用）。
/// </summary>
public sealed class TrayIconTests
{
    [Fact]
    public void UnreadIcon_ContainsRedDot()
    {
        if (!OperatingSystem.IsWindows()) return;

        using var icon = TrayIconFactory.Create(unread: true);
        using var bitmap = icon.ToBitmap();

        Assert.True(HasStrongRedPixel(bitmap), "未读图标里没有找到红色像素");
    }

    [Fact]
    public void NormalIcon_HasNoRedDot()
    {
        if (!OperatingSystem.IsWindows()) return;

        using var icon = TrayIconFactory.Create(unread: false);
        using var bitmap = icon.ToBitmap();

        Assert.False(HasStrongRedPixel(bitmap), "正常图标里不应该有红色像素");
    }

    private static bool HasStrongRedPixel(Bitmap bitmap)
    {
        for (var y = 0; y < bitmap.Height; y++)
        {
            for (var x = 0; x < bitmap.Width; x++)
            {
                var color = bitmap.GetPixel(x, y);
                if (color.A > 180 && color.R > 180 && color.G < 100 && color.B < 100) return true;
            }
        }

        return false;
    }
}
