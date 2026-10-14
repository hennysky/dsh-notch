# 工程笔记

面向要改这份代码的人。记录架构、设计取舍，以及踩过的坑——**每个坑都是真实发生过的**，
不是预防性提醒。

---

## 架构

```
        AppCoordinator            决定用哪种形态（运行时判定）
              │
        BalanceModel              余额 / 提醒 / 今日消耗 —— 与呈现无关
              │
      ┌───────┴────────┐
 NotchPresenter    MenuBarPresenter
 NSWindow          NSStatusItem + NSPopover
      └───────┬────────┘
        CardRootView             同一张卡片，只有 chrome 不同
```

| 文件 | 职责 |
|---|---|
| `Sources/AppCoordinator.swift` | 形态判定与切换、开机自启 |
| `Sources/PresentationMode.swift` | 形态判定规则（纯函数，可自检） |
| `Sources/BalanceModel.swift` | 状态机：轮询、失败保留旧值、点开刷新 |
| `Sources/RefreshPolicy.swift` | 刷新时机与限流（纯函数） |
| `Sources/BalanceAlert.swift` | 提醒判定（纯函数）+ 提醒模型 |
| `Sources/DailyCost.swift` | 今日消耗推算（纯函数）+ 展示 |
| `Sources/Balance.swift` | 凭据读取、接口调用、数据模型 |
| `Sources/NotchPresenter.swift` | 刘海形态：面板、点击、动画 |
| `Sources/MenuBarPresenter.swift` | 菜单栏形态：状态栏项、popover、标题提醒 |
| `Sources/NotchGeometry.swift` | 刘海几何（只在真有刘海时构造） |
| `Sources/Views.swift` | 卡片视图 + 全部自绘控件 |
| `Sources/Diagnostics.swift` | 日志、离屏渲染、窗口服务器查询 |
| `Sources/main.swift` | 入口 + 8 项自检 |

**分层原则**：`BalanceModel` 及以下完全不碰 AppKit。加新形态时不需要改数据层。

---

## 设计取舍

### 形态判定放在运行时，不放在安装时

显示配置会变：接外屏、合盖（内置屏会从 `NSScreen.screens` 消失）、拔线。
安装时问一次就定死，之后全是错的。而且问用户「你有没有刘海」，Mac mini 用户根本不知道怎么答。

判定依据：`NSScreen.auxiliaryTopLeftArea` 非 nil 且宽度 > 0，`safeAreaInsets.top > 0`。
监听 `didChangeScreenParametersNotification` 随时重判。

### 不用 hover，用点击

做过 hover 版本（先是 `NSTrackingArea`，后改成 80ms 轮询鼠标位置），能用但体验脆：
鼠标扫过刘海就会闪一下、手一抖卡片就没了，而且「算不算移出」很难界定——
卡片底边在 y=764，鼠标从刘海（y=982）往下划过 764 就直接收起，整个过程常常不到一秒。

点击是显式意图，没有歧义，也不需要常驻轮询。

> `NSTrackingArea` 在会动态改变尺寸的窗口上还有个额外问题：追踪区域随窗口重建时
> `mouseExited` 会丢，表现为「移进能弹出、移出收不回」。

### 所有控件自绘

不用 `Slider` / `Toggle` / `Picker(.segmented)`。原因不是审美，是**验证能力**：

本项目没有屏幕录制权限，`screencapture` 不可用，**离屏渲染（`ImageRenderer`）是唯一的
视觉验证手段**。而 `ImageRenderer` 画不出 AppKit 支撑的控件——渲染出来是一块带禁止符号的黄条。

自绘之后，「渲染出来的」和「屏幕上看到的」才是同一回事。

> 这个问题在部署目标降到 macOS 14.0 之后又出现过一次：`Slider` 在那之前用的是
> SwiftUI 原生实现，能渲染；降目标后退回 `NSSlider`，离屏渲染立刻变成黄条。
> 说明这个约束取决于系统的实现选择，不能假定一次就够。

### 点开刷新要限流

用户点开就是想看当下余额，所以点开必须刷新。但无脑刷新会在反复点开时打爆接口——
开发期间实测触发过 HTTP 429。所以配 30 秒下限。

下限按「上一次**发起**查询的时间」算，**成败都计入**：只算成功的话，接口挂掉时用户
每点一次就会重试一次，正好在最不该重试的时候把请求打满。

### 「跌破阈值」只提醒一次

后台每 5 分钟轮询一次。按「处于低位」判定会变成每 5 分钟响一次，那是骚扰。
所以判定的是**跌破这个事件**：充回阈值之上后重新武装。

### 今日消耗本地推算

平台接口的完整字段树（把原始响应摊平后）：

```
code, msg
data.biz_code, data.biz_msg
data.biz_data.bonus_wallets[]  : balance / currency / token_estimation
data.biz_data.normal_wallets[] : balance / currency / token_estimation
data.biz_data.total_costs[]    : amount / currency
```

**没有按天维度**。所以只能记每天起点的累计值作基线，用差值算。

关键是**不知道 ≠ 没消耗**：基线不可信时显示「统计中」或「≥¥x.xx」，绝不显示 ¥0.00。

---

## 踩过的坑

### 1. 窗口被系统下推 33pt

`NSWindow.setFrame` 默认把 frame 约束进屏幕的 `visibleFrame`，而 `visibleFrame`
**不包含菜单栏**（本机 `visibleFrame` 顶边 949，屏幕顶边 982）。窗口被整体下推 33pt：

| | 目标 | 实际 |
|---|---|---|
| 折叠（刘海矩形） | y = 950 | **y = 917** |
| 展开（卡片矩形） | y = 764 | **y = 731** |

刘海在 y 950–982，折叠窗口落在 y 917–949——鼠标根本进不到窗口里。

**修复**：`NotchPanel` 覆写 `constrainFrameRect(_:to:)` 直接返回原始 rect。

**为什么自检没抓到**：当时的自检只比**宽和高**，不比原点。现在比完整 rect（含原点）。

### 2. 窗口层级被 isFloatingPanel 覆盖

```swift
panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)  // 设成 26
...
panel.isFloatingPanel = true   // ← 这一行把 level 强制改回 floating(3)
```

层级 3 低于菜单栏(24)，窗口被整个压在下面。frame、层级、位置全部「正确」，
屏幕上却什么都没有。

**修复**：删掉 `isFloatingPanel`，`level` 放到所有属性设置完之后再赋。

**教训**：**frame 正确 ≠ 显示在屏幕上**。判断窗口是否真的可见必须看
`CGWindowListCopyWindowInfo` 给出的层级与合成顺序。

> 附带发现：`NSStatusItem` **不通过 CGWindowList 暴露**。你菜单栏里其它图标也一样。
> 想确认状态栏项是否挂上，只能在进程内查 `statusItem.button.window`。

### 3. 内容比窗口慢一拍

`@Published` 是在 **willSet 阶段**发布的：订阅回调被调用时属性**还没有真正写入**。

```swift
model.$isExpanded
    .sink { [weak self] expanded in self?.applyExpansion(expanded) }   // 此刻 model.isExpanded 还是旧值
```

而 `NSHostingView` 手工托管的视图树，`@ObservedObject` 的更新传播并不可靠——在回调里
重建视图树时读到的永远是上一个状态。自检抓到的现象：

```
✓ 折叠态不画任何东西        非透明像素 0
✗ 点击后卡片出现且有内容     非透明像素 0        ← 点开是空的
✗ 再次点击后卡片收起         非透明像素 1552     ← 再点一次才画出上一状态
```

**修复**两条一起用：

1. 展开状态**显式传进视图**，不让视图自己去读
2. 内容刷新改到**下一个 runloop 周期**，等属性真正落定后再重建视图树

### 4. 折叠窗口命中测试返回 nil

折叠窗口只有 32pt 高，里面除了一层 `Color.clear` 什么都没有，
`NSHostingView.hitTest` 在这种状态下返回 **nil**。AppKit 的事件投递要先过 hitTest，
返回 nil 就等于点击穿透到下层，到不了 `mouseDown`。

展开态窗口有 256pt、下方有真实内容，hitTest 正常——**所以只在「收起之后再点」时暴露**，
看起来像突然坏了。

**修复**：`ClickHostingView` 覆写 `hitTest`，把刘海带永远判给自己。

**为什么自检没抓到（这个比 bug 本身更值得记）**：当时 `--clicktest` 是**直接调
`host.mouseDown(with:)`** 的，**绕过了命中测试**。测试测的是「点下去之后逻辑对不对」，
而真实点击死在「根本点不下去」这一步。

现在自检里有独立的 `host.hitTest` 断言。真实点击的验证则走合成事件
（`CGEventPost` 到 HID），和人的手点同一条路。

### 5. 部署目标未指定 → 产物要求 macOS 28

不传 `-target` 会继承工具链默认值，`LC_BUILD_VERSION` 被写成 `minos 28.0`，
而 `Info.plist` 里写着 13.0。**这个包发给任何真人都跑不起来**——包括构建它的那台机器
（macOS 27.0）。

**修复**：`toolchain.sh` 固定 `-target arm64-apple-macosx14.0`，`Info.plist` 同步为 14.0。

**教训**：打包前必须核对产物本身（`otool -l | grep minos`），不能只看源文件里的声明。

### 6. Swift 工具链 SDK 与编译器版本戳不一致

本机 Command Line Tools 是 Xcode 16.2，它**内部自相矛盾**：

| 组件 | 版本戳 |
|---|---|
| `CLT/usr/bin/swift-frontend` | `swiftlang-6.0.3.1.10` |
| `SDK/MacOSX15.2.sdk` 的标准库接口 | `swiftlang-6.0.3.1.5` |

系统 `swiftc` 编译任何 Swift 代码都会失败（`unable to load standard library`）。

**绕行**：Homebrew 的 Swift 6.3.3 工具链使用自带 stdlib，不会去读 SDK 里那个版本戳对不上的
标准库，配合系统 SDK 即可正常工作。`toolchain.sh` 封装了它。

**正统修复**：更新 CLT 到与系统匹配的版本，或安装完整 Xcode。

---

## 自检的设计原则

三条，都是被坑出来的：

**1. 结论必须能被命令验证。**
没有屏幕录制权限，就意味着「我看到了」这种结论不可用。每一项都要有对应的检查命令。

**2. 测真实路径，不是你以为的路径。**
「只比宽高不比原点」和「直接调 mouseDown 绕过 hitTest」是同一类错误：
测试覆盖了实现，却没覆盖真实调用链。

**3. 检查产物，不只检查源码。**
`minos 28.0` 那次，源码里写的是 13.0，产物里是 28.0——只有核对二进制才能发现。

---

## 发布流程

```bash
./build.sh          # 构建
./release.sh        # 打包 dist/DSHNotch-x.y.zip
```

打包脚本会打印架构、最低系统版本、体积——**发布前核对这三项**。

GitHub 用 `gh release create`；Gitee 需要在网页上建发行版并上传附件，
或用 API（需要 `projects` 权限的私人令牌）。
