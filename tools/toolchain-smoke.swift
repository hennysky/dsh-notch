// 工具链冒烟测试：验证 SwiftUI / AppKit / 刘海几何 API 三者都可用。
// 由 verify-toolchain.sh 编译运行；不弹窗、不改系统状态。

import AppKit
import SwiftUI

struct NotchPreview: View {
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(.green).frame(width: 6, height: 6)
            Text("¥0.00").font(.system(size: 13, weight: .semibold, design: .rounded))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Color.black)
        .clipShape(Capsule())
    }
}

let os = ProcessInfo.processInfo.operatingSystemVersion
print("✓ Swift 编译运行正常")
print("  host macOS \(os.majorVersion).\(os.minorVersion).\(os.patchVersion)")
print("  toolchain: \(CommandLine.arguments.first ?? "?")")

_ = NotchPreview()  // 触发 SwiftUI 视图类型检查与代码生成
print("✓ SwiftUI 可用")

var foundNotch = false
for screen in NSScreen.screens {
    guard let left = screen.auxiliaryTopLeftArea,
          let right = screen.auxiliaryTopRightArea else {
        print("  · \(screen.localizedName): 无刘海（辅助区域为 nil）")
        continue
    }
    let width = screen.frame.width - left.width - right.width
    let height = screen.safeAreaInsets.top
    if width > 0 && height > 0 {
        foundNotch = true
        print("✓ 检测到刘海：\(screen.localizedName)")
        print("  屏幕  \(Int(screen.frame.width))x\(Int(screen.frame.height)) pt @ \(screen.backingScaleFactor)x")
        print("  刘海  \(width)x\(height) pt，水平起点 x=\(left.width)")
        print("  窗口  应放置于 y=\(screen.frame.height - height)，宽 \(width)，高 \(height)")
    } else {
        print("  · \(screen.localizedName): 无刘海（\(Int(screen.frame.width))x\(Int(screen.frame.height)) pt）")
    }
}
if !foundNotch {
    print("⚠️  未检测到刘海屏；刘海 UI 需要有 notch 的内置屏才能看到效果")
}
