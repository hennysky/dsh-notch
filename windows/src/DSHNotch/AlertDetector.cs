namespace DSHNotch;

/// <summary>一次额度提醒（移植 Sources/BalanceAlert.swift）。</summary>
public sealed class BalanceAlert
{
    public enum AlertKind
    {
        /// <summary>余额跌破设定值。</summary>
        LowBalance,
        /// <summary>两次查询之间消耗超过设定值。</summary>
        BigBurn,
    }

    public BalanceAlert(AlertKind kind, string symbol, decimal current, decimal thresholdOrDelta, DateTime at)
    {
        Kind = kind;
        Symbol = symbol;
        Current = current;
        ThresholdOrDelta = thresholdOrDelta;
        At = at;
    }

    public AlertKind Kind { get; }

    public string Symbol { get; }

    public decimal Current { get; }

    /// <summary>LowBalance 时是阈值；BigBurn 时是差额。</summary>
    public decimal ThresholdOrDelta { get; }

    public DateTime At { get; }

    public string Title => Kind == AlertKind.LowBalance
        ? $"余额已低于 {Symbol}{AmountFormat.String(ThresholdOrDelta)}"
        : $"本次消耗 {Symbol}{AmountFormat.String(ThresholdOrDelta)}";

    /// <summary>紧凑文案（托盘很窄，用符号代替文字）。</summary>
    public string CompactText => Kind == AlertKind.LowBalance
        ? "⚠ " + Symbol + AmountFormat.String(Current)
        : "↓" + Symbol + AmountFormat.String(ThresholdOrDelta);

    /// <summary>通知正文。</summary>
    public string Body => Kind == AlertKind.LowBalance
        ? $"当前余额 {Symbol}{AmountFormat.String(Current)}"
        : $"相邻两次查询间消耗了 {Symbol}{AmountFormat.String(ThresholdOrDelta)}";
}

/// <summary>
/// 提醒判定。纯逻辑，不碰网络与 UI，便于单测。
///
/// 两条规则：
/// 1. <b>余额跌破阈值</b>：只在「跌破」那一刻提醒一次；余额回到阈值之上后重新武装，
///    下次再跌破才会再提醒。否则每轮询一次就响一次，会变成骚扰。
/// 2. <b>单次消耗超阈值</b>：比较相邻两次查询的余额差值。首次查询没有参照，不判定。
///
/// 阈值设为 0 表示关闭该条规则。
/// </summary>
public sealed class AlertDetector
{
    /// <summary>上一次成功查询的余额。</summary>
    public decimal? PreviousAmount { get; private set; }

    /// <summary>余额是否还处于「已跌破」状态。true 表示可以再次触发。</summary>
    public bool LowBalanceArmed { get; private set; } = true;

    public void Reset()
    {
        PreviousAmount = null;
        LowBalanceArmed = true;
    }

    public BalanceAlert? Evaluate(decimal current, string symbol, double lowThreshold, double burnThreshold, DateTime at)
    {
        try
        {
            // 规则 1：单次消耗
            BalanceAlert? burnAlert = null;
            if (burnThreshold > 0 && PreviousAmount is { } previous)
            {
                var delta = previous - current;
                if (delta >= (decimal)burnThreshold)
                {
                    burnAlert = new BalanceAlert(BalanceAlert.AlertKind.BigBurn, symbol, current, delta, at);
                }
            }

            // 规则 2：跌破阈值（回落即重新武装）
            BalanceAlert? lowAlert = null;
            if (lowThreshold > 0)
            {
                var threshold = (decimal)lowThreshold;
                if (current < threshold)
                {
                    if (LowBalanceArmed)
                    {
                        LowBalanceArmed = false;
                        lowAlert = new BalanceAlert(BalanceAlert.AlertKind.LowBalance, symbol, current, threshold, at);
                    }
                }
                else
                {
                    LowBalanceArmed = true;
                }
            }

            // 两条同时命中时，余额告急更需要动作
            return lowAlert ?? burnAlert;
        }
        finally
        {
            PreviousAmount = current;
        }
    }
}
