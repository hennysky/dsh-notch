using System.Globalization;

namespace DSHNotch;

/// <summary>金额展示，逐行对齐 Sources/Balance.swift 的 AmountFormat。</summary>
public static class AmountFormat
{
    public static string Symbol(string currency)
    {
        return currency.ToUpperInvariant() switch
        {
            "CNY" => "¥",
            "USD" => "$",
            _ => currency.ToUpperInvariant() + " ",
        };
    }

    /// <summary>平台的余额是十进制字符串（如 "28.6141700600000000"），展示时保留两位（四舍五入）。</summary>
    public static string String(decimal value)
    {
        var rounded = Math.Round(value, 2, MidpointRounding.AwayFromZero);
        return rounded.ToString("0.00", CultureInfo.InvariantCulture);
    }
}
