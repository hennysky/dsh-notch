import Foundation
import SwiftUI

/// 用量日历的两种口径。
enum ActivityMetric: String, Equatable, CaseIterable {
    case tokens
    case money

    var label: String {
        switch self {
        case .tokens: return "用量"
        case .money: return "金额"
        }
    }

    var title: String {
        switch self {
        case .tokens: return "Token 活动"
        case .money: return "金额活动"
        }
    }
}

/// `~/.dsh/notch/token-activity.json` 里的一天。
struct ActivityDay: Codable, Equatable {
    let date: String
    let tokens: Int
    let cost: Double
}

/// DSH 插件写出的每日用量快照（docs/token-activity.md）。
struct TokenActivity: Codable, Equatable {
    let schema: Int
    let updatedAt: Double
    let days: [ActivityDay]

    var updatedDate: Date { Date(timeIntervalSince1970: updatedAt / 1000) }

    static func load(home: URL = SessionCostSnapshot.defaultHome()) -> TokenActivity? {
        let url = home.appendingPathComponent(".dsh/notch/token-activity.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return parse(data)
    }

    static func parse(_ data: Data) -> TokenActivity? {
        guard let activity = try? JSONDecoder().decode(TokenActivity.self, from: data) else { return nil }
        guard activity.schema == 1, !activity.days.isEmpty else { return nil }
        return activity
    }
}

/// 日历网格里的一格。
struct ActivityCell: Equatable {
    /// yyyy-MM-dd（北京时间）
    let date: String
    let tokens: Int
    let cost: Double

    var isEmpty: Bool { tokens == 0 && cost <= 0 }

    func value(for metric: ActivityMetric) -> Double {
        switch metric {
        case .tokens: return Double(tokens)
        case .money: return cost
        }
    }

    func text(for metric: ActivityMetric) -> String {
        switch metric {
        case .tokens:
            return "\(TokenActivityCalendar.compactCount(tokens)) tokens"
        case .money:
            return "≈¥\(SessionCostSnapshot.formatCny(cost))"
        }
    }
}

/// 月份标签（放在对应列下方）。
struct MonthLabel: Equatable, Identifiable {
    let column: Int
    let label: String
    var id: Int { column }
}

/// 日历网格（53 列 × 7 行，周一开头，最后一列包含今天）。
struct ActivityCalendar: Equatable {
    static let weeks = 53
    static let daysPerWeek = 7

    /// columns[col][row]
    let columns: [[ActivityCell?]]
    /// 每个月的标签（列索引 + 文案）
    let monthLabels: [MonthLabel]

    var allCells: [ActivityCell] { columns.flatMap { $0.compactMap { $0 } } }

    func maxValue(for metric: ActivityMetric) -> Double {
        allCells.map { $0.value(for: metric) }.max() ?? 0
    }
}

enum TokenActivityCalendar {
    static let timeZone = TimeZone(identifier: "Asia/Shanghai")!
    static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        calendar.firstWeekday = 2
        return calendar
    }()
    static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
    static let monthFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = timeZone
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "M月"
        return formatter
    }()
    static let dayLabelFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = timeZone
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "M月d日"
        return formatter
    }()

    /// 由日期字符串生成网格；`today` 决定最后一列、未来格子置空。
    static func build(days: [ActivityDay], today: Date = Date()) -> ActivityCalendar {
        let lookup = Dictionary(days.map { ($0.date, $0) }, uniquingKeysWith: { first, _ in first })
        let todayStart = calendar.startOfDay(for: today)
        let weekday = calendar.component(.weekday, from: todayStart)
        // Calendar.weekday: 1=周日 … 7=周六；转成周一=1 … 周日=7
        let mondayIndex = (weekday + 5) % 7 + 1
        let lastMonday = calendar.date(byAdding: .day, value: -(mondayIndex - 1), to: todayStart)!
        let firstMonday = calendar.date(byAdding: .day, value: -(ActivityCalendar.weeks - 1) * 7, to: lastMonday)!

        var columns: [[ActivityCell?]] = []
        var monthLabels: [MonthLabel] = []
        var lastMonth: Int?
        for column in 0..<ActivityCalendar.weeks {
            var rowCells: [ActivityCell?] = []
            for row in 0..<ActivityCalendar.daysPerWeek {
                let date = calendar.date(byAdding: .day, value: column * 7 + row, to: firstMonday)!
                if date > todayStart {
                    rowCells.append(nil)
                    continue
                }
                let key = dayFormatter.string(from: date)
                let day = lookup[key]
                rowCells.append(ActivityCell(date: key, tokens: day?.tokens ?? 0, cost: day?.cost ?? 0))
            }
            columns.append(rowCells)

            if let wednesday = calendar.date(byAdding: .day, value: column * 7 + 2, to: firstMonday),
               wednesday <= todayStart {
                let month = calendar.component(.month, from: wednesday)
                if month != lastMonth {
                    let label = MonthLabel(column: column, label: monthFormatter.string(from: wednesday))
                    // 相邻月份标签至少隔 4 列（约 20pt），否则中文「10月」会互相压住；
                    // 靠得太近时换成更近的月份（第一个不完整的月份让位给下个月）。
                    if let last = monthLabels.last, column - last.column < 4 {
                        monthLabels[monthLabels.count - 1] = label
                    } else {
                        monthLabels.append(label)
                    }
                    lastMonth = month
                }
            }
        }

        return ActivityCalendar(columns: columns, monthLabels: monthLabels)
    }

    /// 颜色档位：按当天值相对最大值开方分 4 档；0 档表示无数据。
    /// token 与金额各自用自己的最大值算档位。
    static func level(for value: Double, maxValue: Double) -> Int {
        guard maxValue > 0, value > 0 else { return 0 }
        let scaled = sqrt(value / maxValue)
        if scaled < 0.25 { return 1 }
        if scaled < 0.5 { return 2 }
        if scaled < 0.75 { return 3 }
        return 4
    }

    /// 色块颜色：token 用紫色系，金额用绿色系（两种口径一眼能区分）。
    static func color(level: Int, metric: ActivityMetric) -> Color {
        let palette: [(Double, Double, Double)]
        switch metric {
        case .tokens:
            palette = [
                (0.16, 0.16, 0.18),   // 0 无数据
                (0.24, 0.16, 0.42),
                (0.38, 0.24, 0.62),
                (0.53, 0.38, 0.82),
                (0.69, 0.55, 0.97),
            ]
        case .money:
            palette = [
                (0.16, 0.16, 0.18),
                (0.10, 0.25, 0.18),
                (0.10, 0.38, 0.26),
                (0.16, 0.55, 0.36),
                (0.29, 0.75, 0.49),
            ]
        }
        let value = palette[min(max(level, 0), palette.count - 1)]
        return Color(red: value.0, green: value.1, blue: value.2)
    }

    /// token 数：123 / 12.3k / 1.24M
    static func compactCount(_ value: Int) -> String {
        guard value > 0 else { return "0" }
        if value >= 1_000_000_000 { return String(format: "%.2fB", Double(value) / 1_000_000_000) }
        if value >= 1_000_000 { return String(format: "%.2fM", Double(value) / 1_000_000) }
        if value >= 1_000 { return String(format: "%.1fk", Double(value) / 1_000) }
        return String(value)
    }

    /// 悬停文案：10月22日 · 1.24M tokens / ≈¥0.42
    static func hoverText(for cell: ActivityCell, metric: ActivityMetric) -> String {
        let date = dayFormatter.date(from: cell.date).map { dayLabelFormatter.string(from: $0) } ?? cell.date
        return "\(date) · \(cell.text(for: metric))"
    }
}
