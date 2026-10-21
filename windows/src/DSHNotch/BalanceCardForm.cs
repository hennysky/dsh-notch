using System.Drawing;
using System.Windows.Forms;

namespace DSHNotch;

/// <summary>
/// 余额卡片：左键点托盘图标弹出。显示余额 / 赠送余额 / 今日消耗 / 累计消费 / 更新时间，
/// 查询失败时保留旧值并显示红色错误小字（失败绝不合成 0）。
/// </summary>
public sealed class BalanceCardForm : Form
{
    private readonly Label _balanceLabel;
    private readonly Label _bonusLabel;
    private readonly Label _todayLabel;
    private readonly Label _totalLabel;
    private readonly Label _updatedLabel;
    private readonly Label _errorLabel;
    private readonly CheckBox _taskDoneCheck;
    private readonly CheckBox _attentionCheck;
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
        ClientSize = new Size(324, 214);
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
            Location = new Point(14, 152),
            Size = new Size(296, 32),
            ForeColor = Color.FromArgb(255, 120, 120),
            Font = new Font("Segoe UI", 8f),
            AutoEllipsis = true,
            Visible = false,
        };

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
        Controls.Add(_taskDoneCheck);
        Controls.Add(_attentionCheck);

        ApplySettings(settings);

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

    private void OnNotifySettingChanged(object? sender, EventArgs e)
    {
        if (_applying) return;
        SettingsChanged?.Invoke();
    }
}
