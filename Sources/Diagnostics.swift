import AppKit
import Foundation

/// 诊断日志。设置环境变量 DSH_NOTCH_DEBUG=1 后输出到 stderr。
private let dshLogFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "HH:mm:ss.SSS"
    return f
}()

func dshLog(_ message: String) {
    guard ProcessInfo.processInfo.environment["DSH_NOTCH_DEBUG"] == "1" else { return }
    let line = "[dsh-notch \(dshLogFormatter.string(from: Date()))] " + message + "\n"
    FileHandle.standardError.write(Data(line.utf8))
}

/// 让应用把自己视图层级画进位图并统计非透明像素（不需要屏幕录制权限）。
///
/// 这是本项目唯一能自动化验证「屏幕上到底画出了什么」的手段：
/// 没有屏幕录制权限，`screencapture` 不可用。返回 -1 表示无法渲染。
func opaquePixelCount(_ view: NSView, sampleStride: Int = 4) -> Int {
    guard view.bounds.width > 1, view.bounds.height > 1,
          let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return -1 }
    view.cacheDisplay(in: view.bounds, to: rep)
    var count = 0
    for y in stride(from: 0, to: rep.pixelsHigh, by: sampleStride) {
        for x in stride(from: 0, to: rep.pixelsWide, by: sampleStride) {
            if let color = rep.colorAt(x: x, y: y), color.alphaComponent > 0.05 { count += 1 }
        }
    }
    return count
}

func dumpViewContent(_ view: NSView, to path: String) {
    guard view.bounds.width > 1, view.bounds.height > 1,
          let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
    view.cacheDisplay(in: view.bounds, to: rep)
    guard let png = rep.representation(using: .png, properties: [:]) else { return }
    try? png.write(to: URL(fileURLWithPath: path))
}

/// 窗口服务器眼里的真实情况。
///
/// `frame` 正确**不代表**显示在屏幕上——层级低于菜单栏时窗口会被整个压住。
/// 判断窗口是否真的可见必须看这里的层级与合成顺序。
func windowServerReport(pid: pid_t) -> String {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                                kCGNullWindowID) as? [[String: Any]] else {
        return "读不到窗口列表"
    }
    let mine = list.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid }
    guard !mine.isEmpty else { return "❌ 窗口服务器里没有本进程的窗口" }
    return mine.map { dict in
        let bounds = dict[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
        let layer = dict[kCGWindowLayer as String] as? Int ?? -999
        let owner = dict[kCGWindowOwnerName as String] as? String ?? "?"
        return "\(owner) layer=\(layer) bounds=[x:\(bounds["X"] ?? 0) y:\(bounds["Y"] ?? 0) w:\(bounds["Width"] ?? 0) h:\(bounds["Height"] ?? 0)]"
    }.joined(separator: " || ")
}

/// 把 JSON 响应的字段路径摊平，用于确认平台到底提供了哪些字段。
func jsonFieldPaths(_ value: Any, path: String = "") -> [String] {
    if let dict = value as? [String: Any] {
        return dict.flatMap { key, nested in
            jsonFieldPaths(nested, path: path.isEmpty ? key : "\(path).\(key)")
        }.sorted()
    }
    if let array = value as? [Any], let first = array.first {
        return jsonFieldPaths(first, path: path + "[]")
    }
    return [path]
}
