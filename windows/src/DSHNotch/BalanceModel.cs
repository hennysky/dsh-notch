namespace DSHNotch;

/// <summary>
/// 余额状态机（移植 Sources/BalanceModel.swift）。
///
/// 关键约定：<b>查询失败绝不合成 0</b>。失败时保留上一次成功快照，只把 ErrorText 标出来，
/// UI 显示旧值并标注「已过期」。
/// </summary>
public sealed class BalanceModel
{
    /// <summary>轮询间隔：5 分钟。DSH 自身超时 30s，不需要更频繁地打接口。</summary>
    public const double RefreshIntervalSeconds = 300;

    private readonly Func<Settings> _settings;
    private readonly BalanceClient _client;
    private readonly DailyCostStore _costStore;
    private readonly AlertDetector _detector = new();

    public BalanceModel(
        Func<Settings>? settingsProvider = null,
        BalanceClient? client = null,
        DailyCostStore? costStore = null)
    {
        _settings = settingsProvider ?? Settings.CreateDefault;
        _client = client ?? new BalanceClient();
        _costStore = costStore ?? new DailyCostStore();
        CostState = _costStore.Load();
    }

    public BalanceSnapshot? Snapshot { get; private set; }

    public string? ErrorText { get; private set; }

    public bool IsRefreshing { get; private set; }

    /// <summary>今日消耗（本地用累计消费的差值推算）。</summary>
    public decimal? TodayCost { get; private set; }

    public DailyCostState CostState { get; private set; }

    /// <summary>上一次<strong>发起</strong>查询的时间（成败都记），用于「点开时补一次」的限流。</summary>
    public DateTime? LastAttemptAt { get; private set; }

    public event Action? Changed;

    /// <summary>触发额度提醒时的回调。控制器负责弹通知并更新托盘。</summary>
    public event Action<BalanceAlert>? AlertRaised;

    /// <summary>
    /// 点开卡片时调用：只在数据够旧时才真的打接口。
    /// 返回 true 表示调用方应接着执行 <see cref="RefreshAsync"/>。
    /// </summary>
    public bool RefreshIfStale(DateTime? now = null)
    {
        var current = now ?? DateTime.Now;
        if (!RefreshPolicy.ShouldRefresh(LastAttemptAt, current))
        {
            var age = LastAttemptAt is null ? -1 : (int)(current - LastAttemptAt.Value).TotalSeconds;
            AppLog.Write($"余额 {age}s 前刚查过，跳过刷新");
            return false;
        }

        AppLog.Write("点开触发刷新");
        return true;
    }

    public async Task RefreshAsync(CancellationToken cancellationToken = default)
    {
        if (IsRefreshing) return;
        IsRefreshing = true;
        LastAttemptAt = DateTime.Now;
        Changed?.Invoke();

        try
        {
            var fresh = await _client.FetchAsync(cancellationToken).ConfigureAwait(true);
            Snapshot = fresh;
            ErrorText = null;
            UpdateDailyCost(fresh);
            EvaluateAlert(fresh);
        }
        catch (Exception ex)
        {
            // 失败不合成 0：保留旧快照，只显示错误小字。
            ErrorText = ex.Message;
            AppLog.Error("余额查询失败", ex);
        }
        finally
        {
            IsRefreshing = false;
            Changed?.Invoke();
        }
    }

    private void UpdateDailyCost(BalanceSnapshot fresh)
    {
        if (fresh.Costs.Count == 0) return;
        var cost = fresh.Costs[0].CostValue;
        var today = DailyCost.DayKey(fresh.FetchedAt);
        var yesterday = DailyCost.DayKey(fresh.FetchedAt.AddDays(-1));
        var result = DailyCost.Update(CostState, cost, today, yesterday);
        CostState = result.State;
        _costStore.Save(result.State);
        TodayCost = result.Today;
    }

    private void EvaluateAlert(BalanceSnapshot fresh)
    {
        var wallet = fresh.Primary;
        if (wallet is null) return;
        var settings = _settings();
        var alert = _detector.Evaluate(
            wallet.Amount,
            wallet.Symbol,
            settings.LowBalanceThreshold,
            settings.BurnThreshold,
            fresh.FetchedAt);
        if (alert is not null) AlertRaised?.Invoke(alert);
    }

    // MARK: - 展示

    /// <summary>折叠胶囊与卡片主数字。</summary>
    public string AmountText => Snapshot?.Primary?.Display ?? "—";

    public string BonusText
    {
        get
        {
            var wallet = Snapshot?.Bonus.FirstOrDefault(w => w.Amount > 0) ?? Snapshot?.Bonus.FirstOrDefault();
            return wallet?.Display ?? "—";
        }
    }

    public string CostText => Snapshot is { Costs.Count: > 0 } ? Snapshot.Costs[0].Display : "—";

    public string UpdatedText => Snapshot is null ? "尚未获取" : "更新于 " + Snapshot.FetchedAt.ToString("HH:mm:ss");

    public bool IsStale => Snapshot is not null && ErrorText is not null;

    /// <summary>
    /// 今日消耗文案。基线不可信时（首次运行、或隔了多天才开应用）只显示「≥ 值」或「统计中」，
    /// 不能显示成 ¥0.00 —— 那是把「不知道」伪装成「没消耗」。
    /// </summary>
    public string TodayCostText
    {
        get
        {
            if (TodayCost is null) return "—";
            var symbol = Snapshot is { Costs.Count: > 0 } ? Snapshot.Costs[0].Symbol : "¥";
            return DailyCostDisplay.Text(TodayCost.Value, symbol, CostState.BaselineCertain);
        }
    }

    /// <summary>今日消耗是否为精确值（供界面加脚注）。</summary>
    public bool TodayCostIsExact => CostState.BaselineCertain;

    /// <summary>充值入口：链接由凭据里的平台来源派生，不带任何授权信息。</summary>
    public Uri TopUpUrl
    {
        get
        {
            var origin = Snapshot?.Origin ?? new Uri("https://platform.deepseek.com");
            return new Uri(origin.ToString().TrimEnd('/') + "/top_up");
        }
    }
}
