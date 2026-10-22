using System.Drawing;
using System.Windows.Forms;

namespace DSHNotch;

/// <summary>
/// 余额卡片：左键点托盘图标弹出。余额页显示余额 / 赠送余额 / 今日消耗 / 累计消费 /
/// 更新时间，有当前会话花费快照时追加「当前会话」区块；标题栏的「日历」按钮切到
/// Token 用量日历页（自绘 53×7 热力格，支持悬停查看每天）。
/// </summary>
public sealed class BalanceCardForm : Form
{
    private const int CardWidth = 324;
    private const int BaseHeight = 214;
    private const int CalendarHeight = 150;
    private const int ErrorTop = 152;

    // 余额页
    private readonly Panel _balancePanel;
    private readonly Label _balanceLabel;
    private readonly Label _bonusLabel;
    private readonly Label _todayLabel;
    private readonly Label _totalLabel;
    private readonly Label _updatedLabel;
    private readonly Label _errorLabel;
    private readonly CheckBox _taskDoneCheck;
    private readonly CheckBox _attentionCheck;

    private readonly Panel _sessionPanel;
    private readonly Label _sessionHeaderLabel;
    private readonly Label _sessionTitleLabel;
    private readonly Label _sessionTokensLabel;
    private readonly Label _sessionAmountLabel;

    // 顶部公共/切页控件
    private readonly Label _captionLabel;
    private readonly Button _refreshButton;
    private readonly Button _calendarButton;
    private readonly Button _backButton;
    private readonly MetricToggleControl _metricToggle;

    // 日历页
    private readonly CalendarHeatmapControl _heatmap;
    private readonly Label _calendarDetailLabel;
    private readonly Label _calendarTotalLabel;
    private readonly Label _calendarEmptyLabel;
    private readonly Label _calendarEmptyHintLabel;

    private bool _applying;
    private bool _calendarPage;
    private ActivityMetric _metric = ActivityMetric.Tokens;
    private TokenActivitySnapshot? _activity;
    private TokenActivityView? _calendarView;

    public BalanceCardForm(Settings settings)
    {
        Text = AppInfo.AppName;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        ControlBox = false;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        ClientSize = new Size(CardWidth, BaseHeight);
        BackColor = Color.FromArgb(28, 30, 34);
        ForeColor = Color.Gainsboro;
        Font = new Font("Segoe UI", 9f);

        // ---- 顶部：标题 + 刷新 / 日历 / 返回 / 用量-金额切换 ----
        _captionLabel = new Label
        {
            Text = "DSHNotch 余额",
            Location = new Point(14, 8),
            AutoSize = true,
            ForeColor = Color.Gray,
            Font = new Font("Segoe UI", 9f, FontStyle.Bold),
        };

        _refreshButton = CreateFlatButton("刷新", new Point(242, 4), new Size(70, 24));
        _refreshButton.Click += (_, _) => RefreshRequested?.Invoke();

        _calendarButton = CreateFlatButton("日历", new Point(196, 4), new Size(42, 24));
        _calendarButton.Click += (_, _) => ShowCalendarPage();

        _backButton = CreateFlatButton("‹ 返回", new Point(14, 4), new Size(64, 24));
        _backButton.Click += (_, _) => ShowBalancePage();

        _metricToggle = new MetricToggleControl
        {
            Location = new Point(204, 4),
            Size = new Size(96, 24),
            Metric = _metric,
        };
        _metricToggle.MetricChanged += OnMetricChanged;

        // ---- 余额页主体（放在一个 Panel 里，切页时整体隐藏）----
        _balancePanel = new Panel
        {
            Location = new Point(0, 0),
            Size = new Size(CardWidth, BaseHeight),
            BackColor = Color.FromArgb(28, 30, 34),
            Visible = true,
        };

        _balanceLabel = new Label
        {
            Text = "—",
            Location = new Point(12, 28),
            Size = new Size(290, 38),
            Font = new Font("Segoe UI", 20f, FontStyle.Bold),
            ForeColor = Color.White,
            TextAlign = ContentAlignment.MiddleLeft,
        };

        _bonusLabel = CreateLineLabel(new Point(14, 70));
        _todayLabel = CreateLineLabel(new Point(14, 92));
        _totalLabel = CreateLineLabel(new Point(14, 114));

        _updatedLabel = new Label
        {
            Text = "尚未获取",
            Location = new Point(14, 136),
            Size = new Size(296, 16),
            ForeColor = Color.Gray,
            Font = new Font("Segoe UI", 8f),
        };

        _errorLabel = new Label
        {
            Text = string.Empty,
            Location = new Point(14, ErrorTop),
            Size = new Size(296, 32),
            ForeColor = Color.FromArgb(255, 120, 120),
            Font = new Font("Segoe UI", 8f),
            AutoEllipsis = true,
            Visible = false,
        };

        _sessionHeaderLabel = new Label
        {
            Text = "当前会话",
            Location = new Point(0, 0),
            AutoSize = true,
            ForeColor = Color.Gray,
            Font = new Font("Segoe UI", 8f, FontStyle.Bold),
        };
        _sessionTitleLabel = new Label
        {
            Text = string.Empty,
            Location = new Point(0, 15),
            Size = new Size(296, 16),
            ForeColor = Color.Gainsboro,
            Font = new Font("Segoe UI", 9f, FontStyle.Bold),
            AutoEllipsis = true,
        };
        _sessionTokensLabel = new Label
        {
            Text = string.Empty,
            Location = new Point(0, 33),
            Size = new Size(296, 15),
            ForeColor = Color.Gainsboro,
            Font = new Font("Segoe UI", 8f),
            AutoEllipsis = true,
        };
        _sessionAmountLabel = new Label
        {
            Text = string.Empty,
            Location = new Point(0, 49),
            Size = new Size(296, 15),
            ForeColor = Color.FromArgb(120, 200, 150),
            Font = new Font("Segoe UI", 8f),
            AutoEllipsis = true,
        };

        _sessionPanel = new Panel
        {
            Location = new Point(14, ErrorTop),
            Size = new Size(296, 64),
            Visible = false,
            BackColor = Color.FromArgb(28, 30, 34),
        };
        _sessionPanel.Controls.Add(_sessionHeaderLabel);
        _sessionPanel.Controls.Add(_sessionTitleLabel);
        _sessionPanel.Controls.Add(_sessionTokensLabel);
        _sessionPanel.Controls.Add(_sessionAmountLabel);

        _taskDoneCheck = new CheckBox
        {
            Text = "任务完成通知",
            Location = new Point(14, 186),
            AutoSize = true,
            ForeColor = Color.Gainsboro,
            Font = new Font("Segoe UI", 8.5f),
        };
        _attentionCheck = new CheckBox
        {
            Text = "需要处理通知",
            Location = new Point(166, 186),
            AutoSize = true,
            ForeColor = Color.Gainsboro,
            Font = new Font("Segoe UI", 8.5f),
        };
        _taskDoneCheck.CheckedChanged += OnNotifySettingChanged;
        _attentionCheck.CheckedChanged += OnNotifySettingChanged;

        _balancePanel.Controls.Add(_balanceLabel);
        _balancePanel.Controls.Add(_bonusLabel);
        _balancePanel.Controls.Add(_todayLabel);
        _balancePanel.Controls.Add(_totalLabel);
        _balancePanel.Controls.Add(_updatedLabel);
        _balancePanel.Controls.Add(_errorLabel);
        _balancePanel.Controls.Add(_sessionPanel);
        _balancePanel.Controls.Add(_taskDoneCheck);
        _balancePanel.Controls.Add(_attentionCheck);

        // ---- 日历页 ----
        _heatmap = new CalendarHeatmapControl
        {
            Location = new Point(14, 34),
            Size = new Size(296, 54),
            Visible = false,
        };
        _heatmap.HoverChanged += OnCalendarHover;

        _calendarDetailLabel = new Label
        {
            Text = TokenActivityView.HoverHint,
            Location = new Point(14, 92),
            Size = new Size(296, 16),
            ForeColor = Color.FromArgb(135, 140, 148),
            Font = new Font("Segoe UI", 8.5f),
            AutoEllipsis = true,
            Visible = false,
        };

        _calendarTotalLabel = new Label
        {
            Text = string.Empty,
            Location = new Point(14, 112),
            Size = new Size(296, 22),
            ForeColor = Color.FromArgb(232, 232, 236),
            Font = new Font("Segoe UI", 12f, FontStyle.Bold),
            AutoEllipsis = true,
            Visible = false,
        };

        _calendarEmptyLabel = new Label
        {
            Text = TokenActivityView.EmptyPlaceholder,
            Location = new Point(14, 62),
            Size = new Size(296, 20),
            ForeColor = Color.FromArgb(180, 182, 188),
            Font = new Font("Segoe UI", 10f, FontStyle.Bold),
            TextAlign = ContentAlignment.MiddleCenter,
            Visible = false,
        };

        _calendarEmptyHintLabel = new Label
        {
            Text = TokenActivityView.EmptyHint,
            Location = new Point(14, 86),
            Size = new Size(296, 16),
            ForeColor = Color.FromArgb(120, 124, 132),
            Font = new Font("Segoe UI", 8.5f),
            TextAlign = ContentAlignment.MiddleCenter,
            Visible = false,
        };

        Controls.Add(_balancePanel);
        Controls.Add(_captionLabel);
        Controls.Add(_refreshButton);
        Controls.Add(_calendarButton);
        Controls.Add(_backButton);
        Controls.Add(_metricToggle);
        Controls.Add(_heatmap);
        Controls.Add(_calendarDetailLabel);
        Controls.Add(_calendarTotalLabel);
        Controls.Add(_calendarEmptyLabel);
        Controls.Add(_calendarEmptyHintLabel);

        // _balancePanel 是不透明的整页容器，必须放到 z-order 最底层，
        // 否则会盖住标题栏按钮与日历页控件（WinForms 里索引 0 在最前）。
        Controls.SetChildIndex(_balancePanel, Controls.Count - 1);

        ApplySettings(settings);
        ShowBalancePage();

        // 点卡片外面就收起，不占屏幕。
        Deactivate += (_, _) =>
        {
            if (Visible) Hide();
        };
    }

    public event Action? SettingsChanged;

    public event Action? RefreshRequested;

    public bool NotifyTaskDone => _taskDoneCheck.Checked;

    public bool NotifyAttention => _attentionCheck.Checked;

    public bool IsCalendarPage => _calendarPage;

    public void ApplySnapshot(BalanceModel model)
    {
        _balanceLabel.Text = model.AmountText;
        _bonusLabel.Text = "赠送余额  " + model.BonusText;
        _todayLabel.Text = "今日消耗  " + model.TodayCostText;
        _totalLabel.Text = "累计消费  " + model.CostText;
        _updatedLabel.Text = model.UpdatedText + (model.IsRefreshing ? " · 刷新中…" : string.Empty);
        _errorLabel.Text = model.ErrorText ?? string.Empty;
        _errorLabel.Visible = !string.IsNullOrEmpty(model.ErrorText);
        LayoutCard();
    }

    /// <summary>
    /// 应用「当前会话」区块。数据缺失/过期时整块隐藏（<see cref="SessionCostCardModel.Hidden"/>）；
    /// 未收录模型时只隐藏金额行，token 照常显示。布局随可见性伸缩，不溢出卡片。
    /// </summary>
    public void ApplySessionCost(SessionCostCardModel model)
    {
        _sessionPanel.Visible = model.IsVisible;
        if (model.IsVisible)
        {
            _sessionTitleLabel.Text = model.TitleWithModel;
            _sessionTokensLabel.Text = model.Tokens;
            _sessionAmountLabel.Text = model.Amount;
            _sessionAmountLabel.Visible = model.HasAmount;
        }

        LayoutCard();
    }

    /// <summary>
    /// 应用用量日历快照。文件缺失/坏 JSON/schema 不符时传 null：日历页显示占位，
    /// 不会报错；数据有效时按当前「用量/金额」口径重绘热力图。
    /// </summary>
    public void ApplyTokenActivity(TokenActivitySnapshot? activity)
    {
        _activity = activity;
        _calendarView = null;
        UpdateCalendarVisibility();
    }

    public void ApplySettings(Settings settings)
    {
        _applying = true;
        try
        {
            _taskDoneCheck.Checked = settings.NotifyTaskDone;
            _attentionCheck.Checked = settings.NotifyAttention;
        }
        finally
        {
            _applying = false;
        }
    }

    /// <summary>贴屏幕右下角（托盘所在的角落）弹出。</summary>
    public void PositionNearTray()
    {
        var area = Screen.FromPoint(Cursor.Position).WorkingArea;
        var x = Math.Max(area.Left + 8, area.Right - Width - 8);
        var y = Math.Max(area.Top + 8, area.Bottom - Height - 8);
        Location = new Point(x, y);
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // 关窗口 = 收起卡片，不退出应用（退出走托盘菜单）。
        if (e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            return;
        }

        base.OnFormClosing(e);
    }

    // MARK: - 切页

    private void ShowBalancePage()
    {
        _calendarPage = false;
        LayoutTopBar();
        _balancePanel.Visible = true;
        LayoutCard();
        UpdateCalendarVisibility();
        if (Visible) PositionNearTray();
    }

    private void ShowCalendarPage()
    {
        _calendarPage = true;
        LayoutTopBar();
        _balancePanel.Visible = false;
        ClientSize = new Size(CardWidth, CalendarHeight);
        _calendarView = null;
        UpdateCalendarVisibility();
        if (Visible) PositionNearTray();
    }

    private void LayoutTopBar()
    {
        _captionLabel.Text = _calendarPage ? "用量日历" : "DSHNotch 余额";
        _captionLabel.Location = _calendarPage ? new Point(84, 8) : new Point(14, 8);
        _refreshButton.Visible = !_calendarPage;
        _calendarButton.Visible = !_calendarPage;
        _backButton.Visible = _calendarPage;
        _metricToggle.Visible = _calendarPage;
    }

    private void OnMetricChanged(ActivityMetric metric)
    {
        _metric = metric;
        _calendarView = null;
        UpdateCalendarVisibility();
    }

    private void OnCalendarHover(ActivityCell? cell)
    {
        if (!_calendarPage || _calendarView is not { HasData: true }) return;

        if (cell is null)
        {
            _calendarDetailLabel.Text = TokenActivityView.HoverHint;
            _calendarDetailLabel.ForeColor = Color.FromArgb(135, 140, 148);
            return;
        }

        _calendarDetailLabel.Text = TokenActivityCalendar.HoverText(cell, _metric);
        _calendarDetailLabel.ForeColor = Color.FromArgb(232, 232, 236);
    }

    /// <summary>按当前快照/口径重建日历页显示状态（数据为空时显示占位）。</summary>
    private void UpdateCalendarVisibility()
    {
        var view = _calendarView ?? TokenActivityView.Create(
            _activity,
            _metric,
            TokenActivityCalendar.TodayInBeijing());
        _calendarView = view;

        var showCalendarBody = _calendarPage && view.HasData;
        var showPlaceholder = _calendarPage && !view.HasData;

        _heatmap.Visible = showCalendarBody;
        _calendarDetailLabel.Visible = showCalendarBody;
        _calendarTotalLabel.Visible = showCalendarBody;
        _calendarEmptyLabel.Visible = showPlaceholder;
        _calendarEmptyHintLabel.Visible = showPlaceholder;

        if (!showCalendarBody) return;

        _heatmap.SetData(view.Calendar, _metric);
        _calendarTotalLabel.Text = "近 12 个月合计  " + view.TotalText;
        _calendarDetailLabel.Text = TokenActivityView.HoverHint;
        _calendarDetailLabel.ForeColor = Color.FromArgb(135, 140, 148);
    }

    // MARK: - 布局

    private static Label CreateLineLabel(Point location)
    {
        return new Label
        {
            Text = "—",
            Location = location,
            Size = new Size(296, 20),
            ForeColor = Color.Gainsboro,
            Font = new Font("Segoe UI", 9f),
        };
    }

    private static Button CreateFlatButton(string text, Point location, Size size)
    {
        var button = new Button
        {
            Text = text,
            Location = location,
            Size = size,
            FlatStyle = FlatStyle.Flat,
            ForeColor = Color.Gainsboro,
            BackColor = Color.FromArgb(46, 49, 55),
            Font = new Font("Segoe UI", 8.5f),
        };
        button.FlatAppearance.BorderColor = Color.FromArgb(70, 74, 82);
        return button;
    }

    /// <summary>
    /// 余额页从上往下堆叠：更新时间 → 错误小字（可选）→ 当前会话（可选）→ 两个通知开关。
    /// 都不可见时保持原来的紧凑高度。日历页固定高度，不参与这里的伸缩。
    /// </summary>
    private void LayoutCard()
    {
        var y = ErrorTop;
        if (_errorLabel.Visible)
        {
            _errorLabel.Location = new Point(14, y);
            y += _errorLabel.Height + 4;
        }

        if (_sessionPanel.Visible)
        {
            _sessionPanel.Location = new Point(14, y);
            y += _sessionPanel.Height + 6;
        }

        var checkTop = _errorLabel.Visible || _sessionPanel.Visible ? y + 2 : 186;
        _taskDoneCheck.Location = new Point(14, checkTop);
        _attentionCheck.Location = new Point(166, checkTop);

        var height = checkTop + 30;
        _balancePanel.Size = new Size(CardWidth, height);
        if (!_calendarPage) ClientSize = new Size(CardWidth, height);
    }

    private void OnNotifySettingChanged(object? sender, EventArgs e)
    {
        if (_applying) return;
        SettingsChanged?.Invoke();
    }
}
