using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace DSHNotch;

/// <summary>
/// 用量日历热力图：自绘 53 列 × 7 行色块（不创建几千个 Label）。
/// 悬停时白框高亮，并通过 <see cref="HoverChanged"/> 让卡片更新固定详情行。
/// </summary>
public sealed class CalendarHeatmapControl : Control
{
    private const float CellSize = 4.4f;
    private const float Gap = 1.0f;
    private const float Pitch = CellSize + Gap;
    private const int MonthLabelHeight = 14;

    private static readonly float GridWidth = ActivityCalendar.Weeks * Pitch - Gap;
    private static readonly float GridHeight = ActivityCalendar.DaysPerWeek * Pitch - Gap;

    private readonly Font _monthFont = new("Segoe UI", 7f);
    private readonly SolidBrush _monthBrush = new(Color.FromArgb(135, 122, 128, 138));
    private readonly Pen _hoverPen = new(Color.FromArgb(230, 255, 255, 255), 1f);
    private readonly SolidBrush _cellBrush = new(Color.Black);

    private ActivityCalendar? _calendar;
    private ActivityMetric _metric = ActivityMetric.Tokens;
    private ActivityCell? _hovered;

    public CalendarHeatmapControl()
    {
        SetStyle(
            ControlStyles.AllPaintingInWmPaint |
            ControlStyles.UserPaint |
            ControlStyles.OptimizedDoubleBuffer |
            ControlStyles.ResizeRedraw,
            true);
        SetStyle(ControlStyles.Selectable, false);
        TabStop = false;
        BackColor = Color.FromArgb(28, 30, 34);
        Cursor = Cursors.Hand;
        Size = new Size((int)Math.Ceiling(GridWidth) + 2, (int)Math.Ceiling(GridHeight) + MonthLabelHeight);
    }

    /// <summary>悬停格变化（null = 移出/空白格）。</summary>
    public event Action<ActivityCell?>? HoverChanged;

    public ActivityCell? Hovered => _hovered;

    public void SetData(ActivityCalendar? calendar, ActivityMetric metric)
    {
        _calendar = calendar;
        _metric = metric;
        _hovered = null;
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var graphics = e.Graphics;
        graphics.Clear(BackColor);
        if (_calendar is null) return;

        var offsetX = (Width - GridWidth) / 2f;
        var maxValue = _calendar.MaxValue(_metric);

        for (var column = 0; column < _calendar.Columns.Count; column++)
        {
            var rows = _calendar.Columns[column];
            for (var row = 0; row < rows.Count; row++)
            {
                var cell = rows[row];
                if (cell is null) continue;

                var level = TokenActivityCalendar.Level(cell.Value(_metric), maxValue);
                _cellBrush.Color = TokenActivityCalendar.CellColor(level, _metric);
                var x = offsetX + column * Pitch;
                var y = row * Pitch;
                graphics.FillRectangle(_cellBrush, x, y, CellSize, CellSize);
            }
        }

        if (_hovered is not null)
        {
            // 找到悬停格的列/行（网格很小，线性查找足够）。
            for (var column = 0; column < _calendar.Columns.Count; column++)
            {
                var rows = _calendar.Columns[column];
                for (var row = 0; row < rows.Count; row++)
                {
                    if (!ReferenceEquals(rows[row], _hovered)) continue;
                    var x = offsetX + column * Pitch;
                    var y = row * Pitch;
                    graphics.DrawRectangle(_hoverPen, x - 0.5f, y - 0.5f, CellSize + 1f, CellSize + 1f);
                    column = _calendar.Columns.Count;
                    break;
                }
            }
        }

        DrawMonthLabels(graphics, offsetX);
    }

    private void DrawMonthLabels(Graphics graphics, float offsetX)
    {
        if (_calendar is null) return;

        var lastRight = float.MinValue;
        foreach (var label in _calendar.MonthLabels)
        {
            var textWidth = graphics.MeasureString(label.Label, _monthFont).Width;
            var x = offsetX + label.Column * Pitch;
            // 最右列的月份标签可能顶出控件：右移会压到上一个标签时就不画，宁可少一个也不重叠。
            if (x + textWidth > Width) x = Width - textWidth;
            if (x < lastRight + 2) continue;

            graphics.DrawString(label.Label, _monthFont, _monthBrush, x, GridHeight + 2f);
            lastRight = x + textWidth;
        }
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        var cell = HitTest(e.Location);
        if (ReferenceEquals(cell, _hovered)) return;

        _hovered = cell;
        Invalidate();
        HoverChanged?.Invoke(cell);
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        if (_hovered is not null)
        {
            _hovered = null;
            Invalidate();
            HoverChanged?.Invoke(null);
        }

        base.OnMouseLeave(e);
    }

    private ActivityCell? HitTest(Point point)
    {
        if (_calendar is null) return null;
        if (point.Y >= GridHeight + MonthLabelHeight) return null;

        var offsetX = (Width - GridWidth) / 2f;
        var column = (int)Math.Floor((point.X - offsetX) / Pitch);
        var row = (int)Math.Floor(point.Y / Pitch);
        if (column < 0 || column >= ActivityCalendar.Weeks || row < 0 || row >= ActivityCalendar.DaysPerWeek) return null;
        if (column >= _calendar.Columns.Count) return null;

        var rows = _calendar.Columns[column];
        if (row >= rows.Count) return null;
        return rows[row];
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _monthFont.Dispose();
            _monthBrush.Dispose();
            _hoverPen.Dispose();
            _cellBrush.Dispose();
        }

        base.Dispose(disposing);
    }
}

/// <summary>自绘胶囊「用量 / 金额」切换。</summary>
public sealed class MetricToggleControl : Control
{
    private readonly Font _font = new("Segoe UI", 9f);
    private readonly SolidBrush _backgroundBrush = new(Color.FromArgb(255, 58, 62, 70));
    private readonly SolidBrush _selectedBrush = new(Color.FromArgb(255, 226, 228, 232));
    private readonly SolidBrush _selectedTextBrush = new(Color.FromArgb(255, 30, 32, 36));
    private readonly SolidBrush _normalTextBrush = new(Color.FromArgb(210, 200, 204, 212));
    private readonly StringFormat _centerFormat = new()
    {
        Alignment = StringAlignment.Center,
        LineAlignment = StringAlignment.Center,
    };

    private ActivityMetric _metric = ActivityMetric.Tokens;

    public MetricToggleControl()
    {
        SetStyle(
            ControlStyles.AllPaintingInWmPaint |
            ControlStyles.UserPaint |
            ControlStyles.OptimizedDoubleBuffer |
            ControlStyles.ResizeRedraw,
            true);
        SetStyle(ControlStyles.Selectable, false);
        TabStop = false;
        BackColor = Color.FromArgb(28, 30, 34);
        Cursor = Cursors.Hand;
        Size = new Size(96, 24);
    }

    public event Action<ActivityMetric>? MetricChanged;

    public ActivityMetric Metric
    {
        get => _metric;
        set
        {
            if (_metric == value) return;
            _metric = value;
            Invalidate();
        }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var graphics = e.Graphics;
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        graphics.Clear(BackColor);

        using (var capsule = RoundedRect(new RectangleF(0, 0, Width - 1, Height - 1), Height / 2f))
        {
            graphics.FillPath(_backgroundBrush, capsule);
        }

        var half = Width / 2f;
        var selected = _metric == ActivityMetric.Tokens
            ? new RectangleF(0, 0, half, Height)
            : new RectangleF(half, 0, half, Height);
        using (var selectedPath = RoundedRect(selected, Height / 2f))
        {
            graphics.FillPath(_selectedBrush, selectedPath);
        }

        var tokensBounds = new RectangleF(0, 0, half, Height);
        var moneyBounds = new RectangleF(half, 0, half, Height);
        graphics.DrawString("用量", _font,
            _metric == ActivityMetric.Tokens ? _selectedTextBrush : _normalTextBrush, tokensBounds, _centerFormat);
        graphics.DrawString("金额", _font,
            _metric == ActivityMetric.Money ? _selectedTextBrush : _normalTextBrush, moneyBounds, _centerFormat);
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        var metric = e.X < Width / 2 ? ActivityMetric.Tokens : ActivityMetric.Money;
        if (metric == _metric) return;

        Metric = metric;
        MetricChanged?.Invoke(metric);
    }

    private static GraphicsPath RoundedRect(RectangleF bounds, float radius)
    {
        var path = new GraphicsPath();
        var diameter = radius * 2;
        path.AddArc(bounds.X, bounds.Y, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Y, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.X, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _font.Dispose();
            _backgroundBrush.Dispose();
            _selectedBrush.Dispose();
            _selectedTextBrush.Dispose();
            _normalTextBrush.Dispose();
            _centerFormat.Dispose();
        }

        base.Dispose(disposing);
    }
}
