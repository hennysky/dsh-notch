using System.Drawing;
using System.Windows.Forms;

namespace DSHNotch;

/// <summary>
/// 余额卡片：左键点托盘图标弹出。显示余额 / 赠送余额 / 今日消耗 / 累计消费 / 更新时间，
/// 有当前会话花费快照时再追加「当前会话」区块（标题+模型、tokens、预估金额）。
/// 查询失败时保留旧值并显示红色错误小字（失败绝不合成 0）。
/// </summary>
public sealed class BalanceCardForm : Form
{
    private const int CardWidth = 324;
    private const int BaseHeight = 214;
    private const int ErrorTop = 152;

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
    private bool _applying;

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

        var caption = new Label
        {
            Text = "DSHNotch 余额",
            Location = new Point(14, 8),
            AutoSize = true,
            ForeColor = Color.Gray,
            Font = new Font("Segoe UI", 9f, FontStyle.Bold),
        };

        var refreshButton = new Button
        {
            Text = "刷新",
            Location = new Point(242, 4),
            Size = new Size(70, 24),
            FlatStyle = FlatStyle.Flat,
            ForeColor = Color.Gainsboro,
            BackColor = Color.FromArgb(46, 49, 55),
        };
        refreshButton.FlatAppearance.BorderColor = Color.FromArgb(70, 74, 82);
        refreshButton.Click += (_, _) => RefreshRequested?.Invoke();

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

        Controls.Add(caption);
        Controls.Add(refreshButton);
        Controls.Add(_balanceLabel);
        Controls.Add(_bonusLabel);
        Controls.Add(_todayLabel);
        Controls.Add(_totalLabel);
        Controls.Add(_updatedLabel);
        Controls.Add(_errorLabel);
        Controls.Add(_sessionPanel);
        Controls.Add(_taskDoneCheck);
        Controls.Add(_attentionCheck);

        ApplySettings(settings);
        LayoutCard();

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

    /// <summary>
    /// 从上往下堆叠：更新时间 → 错误小字（可选）→ 当前会话（可选）→ 两个通知开关。
    /// 都不可见时保持原来的紧凑高度，避免卡片无端变高。
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
        ClientSize = new Size(CardWidth, checkTop + 30);
    }

    private void OnNotifySettingChanged(object? sender, EventArgs e)
    {
        if (_applying) return;
        SettingsChanged?.Invoke();
    }
}
