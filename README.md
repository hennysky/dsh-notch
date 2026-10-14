# dsh-notch

**v1.0** — 在 Mac 上随时看到 DeepSeek Harness 余额，额度异常时主动提醒。

**所有 Mac 都能用**，自动选形态：

| 有刘海的 MacBook | 其它 Mac（Mac mini / iMac / 外接屏） |
|---|---|
| ![刘海形态](preview/balance.png) | ![菜单栏形态](preview/menubar.png) |
| 点刘海展开卡片 | 菜单栏直接显示金额，点开是卡片 |

- 平台：macOS 14+，Apple Silicon
- 协议：MIT，见 [LICENSE](LICENSE)
- 自检：7 项，全部不依赖肉眼，见下文

## 两种形态，运行时自动选

**不在安装时问用户，也不需要问。** 显示配置随时会变，安装时写死一次之后全是错的：

| 场景 | 形态 |
|---|---|
| MacBook 有刘海 | 刘海形态，放在那块屏上 |
| Mac mini / iMac / 纯外接屏 | 菜单栏形态 |
| MacBook 合盖接外屏（内置屏从 `NSScreen.screens` 消失） | **自动切到菜单栏形态，功能不丢** |
| 用户手动指定 | 以手动为准（自动 / 仅刘海 / 仅菜单栏） |

判定依据是 `NSScreen.auxiliaryTopLeftArea` 是否为 nil、`safeAreaInsets.top` 是否 > 0，
并监听 `didChangeScreenParametersNotification` 随时重判。

> **v0.5 及更早的版本有个设计错误**：在没有刘海的屏上会模拟一块假刘海，
> 于是 Mac mini 用户屏幕顶上凭空多出一条黑条。1.0 把这条 fallback 删了——
> 没有刘海就不该有「刘海形态」这个东西。

### 菜单栏形态的提醒方式不同

刘海形态靠「卡片自己弹出来」；菜单栏形态没有可弹的地方（popover 会抢焦点，
正在打字的人会被打断）。所以改成**菜单栏标题临时变成提醒内容**：

```
¥5.74   →   ⚠ ¥5.74     （余额告急，橙色）
¥5.74   →   ↓¥2.50      （单次大额消耗，蓝色）
```

停留设定时长后自动恢复。用户一旦点击菜单栏项，提醒立刻交还给他。

## 安装

### 下载预编译包（推荐）

1. 下载 `DSHNotch-1.0.zip`：
   [GitHub Releases](https://github.com/hennysky/dsh-notch/releases) ·
   [Gitee 发行版](https://gitee.com/hennysky/dsh-notch/releases)
2. 解压，把 `DSHNotch.app` 拖进「应用程序」
3. **首次打开必须右键 → 打开**。应用没有 Apple 开发者签名与公证，双击会被 Gatekeeper 拦下

   或者用一条命令去掉隔离标记：

   ```bash
   xattr -dr com.apple.quarantine /Applications/DSHNotch.app
   ```

下载 + 安装 + 去隔离 + 启动，一条龙（两个平台的包逐字节相同，任选）：

```bash
# GitHub
curl -fL -o /tmp/DSHNotch.zip \
  https://github.com/hennysky/dsh-notch/releases/download/v1.0/DSHNotch-1.0.zip \
  && unzip -q -o /tmp/DSHNotch.zip -d /Applications \
  && xattr -dr com.apple.quarantine /Applications/DSHNotch.app \
  && open /Applications/DSHNotch.app

# Gitee（国内更快）
curl -fL -o /tmp/DSHNotch.zip \
  https://gitee.com/hennysky/dsh-notch/releases/download/v1.0/DSHNotch-1.0.zip \
  && unzip -q -o /tmp/DSHNotch.zip -d /Applications \
  && xattr -dr com.apple.quarantine /Applications/DSHNotch.app \
  && open /Applications/DSHNotch.app
```

包信息：**arm64 / macOS 14.0+**


**环境要求：Apple Silicon + macOS 14.0+**

- 带刘海的 MacBook **全部是 Apple Silicon**（刘海从 2021 款 M1 Pro 起），Intel 机型没有刘海，
  所以只构建 arm64，没有做通用二进制。
- macOS 14 是 `UnevenRoundedRectangle` 等 API 的下限。

> 为什么没有签名：Apple Developer ID 需要 99 美元/年。不签名的代价就是首次打开要走
> 「右键 → 打开」这一步，之后就不再有提示。

### 从源码构建

```bash
git clone https://github.com/hennysky/dsh-notch.git
cd dsh-notch
./build.sh      # → build/DSHNotch.app
./release.sh    # → dist/DSHNotch-x.y.zip
```

需要 Swift 工具链（Xcode 或 Command Line Tools）。本机 CLT 的 SDK 与编译器版本戳
不一致会导致系统 `swiftc` 失效，`toolchain.sh` 里记录了根因与绕行方式。

### 退出 / 自启 / 卸载

| | |
|---|---|
| **退出** | 点刘海 → 右上角滑杆图标 → 「退出应用」 |
| **开机自启** | 系统设置 → 通用 → 登录项 → 添加 DSHNotch |
| **卸载** | 把 `DSHNotch.app` 删掉。配置存在 `local.dsh.notch` 这个 UserDefaults 域里，想彻底清干净就一并删除 |

## 它解决什么问题

DSH 的余额只在应用界面里看得到。这个工具把余额搬到刘海——不占桌面空间，
点一下就能看到，尤其适合挂着长任务时瞄一眼余额。

功能刻意做得很窄：**只读余额，不做充值、不做历史、不碰账号**。

## 卡片内容

```
● DeepSeek Harness                    ⚙  ↻
¥11.02
充值钱包余额
────────────────────────────────
赠送钱包                        ¥0.00
累计消费                      ¥555.11
今日消耗                        ¥2.63
────────────────────────────────
更新于 15:23:57              [ 充值 ↗ ]
```

### 充值入口

右下角的「充值 ↗」用系统浏览器打开 `{平台来源}/top_up`（本机是
`https://platform.deepseek.com/top_up`）。

链接的域名来自凭据里的 `issuer`——**和取余额用的是同一个来源，且不携带任何 token**，
打开的是浏览器自己的登录态。这与 DSH 自身的做法一致：账号链接从平台来源派生，
DSH token 永远不进 URL。

### 今日消耗是怎么算的

**平台接口没有按天维度。** 这不是猜测——把 `get_user_summary` 的原始响应字段树
摊平之后，总共就这些：

```
code, msg
data.biz_code, data.biz_msg
data.biz_data.bonus_wallets[]  : balance / currency / token_estimation
data.biz_data.normal_wallets[] : balance / currency / token_estimation
data.biz_data.total_costs[]    : amount / currency
```

没有 `daily` / `today` / 按日数组。DSH 自己解析的 schema 也只有钱包两项。

所以今日消耗是本地推算的：记录每天起点的累计消费作为基线，用差值算。

| 情况 | 基线取法 |
|---|---|
| 同一天内 | 沿用当天已有的基线 |
| 跨天，且上次读数就在昨天 | 拿昨天最后一次读数（最接近午夜的真实值） |
| 跨天，但上次读数是好几天前 | 只能用当天第一次读数兜底，**会少算** |

### 不知道 ≠ 没消耗

最后一种情况是已知代价：当天起点无从得知。**这时候绝不能显示 ¥0.00**——
那是把「不知道」伪装成「没消耗」，比不显示更糟。

| 基线 | 显示 | 含义 |
|---|---|---|
| 可信 | `¥2.63` | 精确值 |
| 不可信，且尚无增量 | `统计中` | 还等着第一次增量 |
| 不可信，已有增量 | `≥¥2.63` | 至少这么多（从开始观察算起） |

从第二天起会自动变精确：只要应用跨过午夜（或次日重启），昨天的最后一次读数
就是最接近午夜的真实基线，`baselineCertain` 转为 true。

![今日消耗不可信时的显示](preview/today-unknown.png)

`--costcheck` 把这些分支都固化了：

```
✓ 当天首次读数 → 今日消耗 0        ✓ 隔了几天没开 → 当天首读兜底（不误报）
✓ 同一天再读 → 差值 ¥2.50          ✓ 差值异常为负 → 钳到 0
✓ 跨天（昨天有读数）→ 用昨天末值    ✓ 连续两天各自独立统计
✓ 跨天且昨天有读数 → 基线可信        ✓ 基线不可信且为 0 → 显示「统计中」
✓ 隔了几天没开 → 基线不可信          ✓ 基线不可信但有增量 → 显示「≥¥2.50」
✓ 基线可信 → 显示精确值
```

基线落在 UserDefaults，跨重启保留——否则每次重开今日消耗都会归零。

## 额度提醒

余额藏在刘海后面，不点开就不知道掉了多少。所以加了两条主动提醒规则：

| 规则 | 默认 | 说明 |
|---|---|---|
| **余额低于 X** | ¥10 | 跌破那一刻提醒一次；充回阈值之上后重新武装，下次再跌破才会再响 |
| **单次消耗超过 X** | ¥2 | 比较相邻两次查询的余额差；首次查询没有参照，不判定 |

- 任一阈值设为 **0 即关闭**该规则
- 两条同时命中时，**余额告急优先**（更需要动作）
- 触发时**卡片自动弹出**，停留设定时长（默认 6 秒）后自动收起
- 提醒期间卡片描边、状态点、文案都换成提醒色，一眼能看出是它自己弹的
- **用户手动点击优先**：弹出期间你一旦点了，自动收起立刻取消，不跟你抢

### 为什么"跌破只响一次"

每 5 分钟轮询一次，如果只要"低于阈值"就响，会变成每 5 分钟响一次。
所以判定用的是**跌破这个事件**，不是"处于该状态"——充回阈值以上后重新武装。

`--alertcheck` 覆盖了 8 种情况来守这套行为：

```
✓ 首次查询不触发消耗提醒        ✓ 仍低于阈值 → 不重复提醒
✓ 消耗 ¥2.50 ≥ 阈值 ¥2 → 提醒   ✓ 充值后再次跌破 → 重新提醒
✓ 消耗 ¥1.00 < 阈值 ¥2 → 不提醒  ✓ 阈值设为 0 → 该规则关闭
✓ 余额 ¥9 跌破 ¥10 → 提醒        ✓ 同时命中 → 优先余额告急
```

### 想立刻看效果

不用等余额真的跌破：

```bash
DSH_NOTCH_TEST_ALERT=3 ./build/DSHNotch.app/Contents/MacOS/DSHNotch
```

启动 3 秒后模拟一次提醒，完整走一遍「弹出 → 停留 → 自动收起」。

## 验证记录

`--selftest` 实测输出（真实账号）：

```
✓ 凭据读取成功（~/.dsh/.credentials.yaml）
✓ 接口调用成功
  充值钱包  ¥25.98
  赠送钱包  ¥0.00
  累计消费  ¥540.15
```

自洽性检查：同一次会话开始时读到的是「余额 ¥28.61 / 累计消费 ¥537.52」，
之后是「¥25.98 / ¥540.15」——余额减少 2.63，消费增加 2.63，**两者完全相等**，
说明字段映射正确（`normal_wallets` 确为充值钱包、`total_costs` 确为累计消费）。

开发期间踩到的两个真实坑，均已修正并写进代码注释：

1. **`code` / `biz_code` 是 JSON 数字 `0`，不是字符串 `"0"`** —— 最初按 String 解码导致整次解析失败。
   现在用 `LooseString` 统一兼容字符串与数字两种形态。
2. **接口有频率限制** —— 连续请求会返回 HTTP 429，已单独处理并给出友好提示。


## 快速开始

```bash
./build.sh                       # 构建 build/DSHNotch.app
./build/DSHNotch.app/Contents/MacOS/DSHNotch --selftest   # 只验证取数，不弹窗
open build/DSHNotch.app          # 启动（常驻，无 Dock 图标）
```

退出：`pkill -f DSHNotch`

## 交互设计

点击触发，不用 hover。

- **折叠态（默认）**：**什么都不画**。刘海保持原样，窗口 = 刘海矩形左右各外扩 4pt
  （本机 193×32pt），不占用菜单栏以外的任何区域。外扩是为了覆盖窗口对齐 2x 像素网格的
  取整误差，也让 185×32pt 的窄目标更容易点中。
- **点击刘海带** → 卡片从屏幕顶端向下展开成 300×256pt 的黑色卡片，顶部与刘海连成一体、
  底部圆角。显示充值钱包余额、赠送钱包、累计消费、今日消耗、更新时间，右下角是充值入口。
- **再点一次刘海带 / 点卡片外面** → 收起。收起后窗口缩回刘海那 193×32pt，不再画任何东西。
- 状态色：≥¥10 绿 / ≥¥1 橙 / <¥1 红 / 查询失败灰。

### 为什么不用 hover

先做过 hover 版本（`NSTrackingArea`，后又改成 80ms 轮询鼠标位置），能用但体验脆：
鼠标扫过刘海就会闪一下、手一抖卡片就没了，而且"到底算不算移出"很难界定——
卡片底边在 y=764，鼠标从刘海（y=982）往下划过 764 就直接收起，整个过程常常不到一秒。

点击是显式意图，没有歧义，也不需要常驻轮询。触发点就在刘海那一条上，开和关是同一个手势。

窗口行为：层级 `NSWindow.Level.statusBar + 1`（高于菜单栏）、`.nonactivatingPanel`
（点击不会抢走当前应用的焦点）、`canJoinAllSpaces` + `fullScreenAuxiliary`（切换
桌面、全屏应用时依然可见）。

## 第三个坑（最贵的一个）：内容比窗口慢一拍

### 症状

窗口 frame、层级、位置**全部正确**，自绘位图却是 **0 个非透明像素**——
窗口在那儿，里面是空的，所以屏幕上什么也看不到。

### 根因

`@Published` 是在 **willSet 阶段**发布的：订阅回调被调用时，属性**还没有真正写入**。

```swift
model.$isExpanded
    .sink { [weak self] expanded in self?.applyExpansion(expanded) }   // 此刻 model.isExpanded 还是旧值
```

而 `NSHostingView` 手工托管的视图树，`@ObservedObject` 的更新传播并不可靠——
在回调里重建视图树时读 `model.isExpanded`，拿到的是**上一个状态**，于是内容永远慢一拍。
`--clicktest` 把这个现象抓得很清楚：

```
✓ 折叠态不画任何东西        非透明像素 0
✗ 点击后卡片出现且有内容     非透明像素 0        ← 点开是空的
✗ 再次点击后卡片收起         非透明像素 1552     ← 再点一次才画出上一状态
```

### 修复

两条一起用：

1. **展开状态显式传进视图**，不让视图自己去读：

```swift
struct NotchRootView: View {
    let isExpanded: Bool        // 由控制器传入，不读 model.isExpanded
    ...
}
```

2. **内容刷新改到下一个 runloop 周期**，等属性真正落定后再重建视图树：

```swift
model.objectWillChange
    .sink { [weak self] in DispatchQueue.main.async { self?.refreshContent() } }
```

### 教训

**窗口正确 ≠ 内容正确。** 这次三层 bug 叠在一起：层级对了、位置对了、状态机也对了，
但窗口里是空的。判断"到底显示了什么"必须看**内容本身**——
`opaquePixelCount()` 数窗口的非透明像素，是唯一能自动化验证这件事的办法。

## 设置

卡片右上角的滑杆图标进入设置页，分三页：

| 页 | 内容 |
|---|---|
| **提醒** | 余额低于、单次消耗、弹出停留 |
| **动画** | 动画时长、缓动曲线 |
| **通用** | 呈现形态、开机自启 |

改动即时生效，写入 `UserDefaults`（域 `local.dsh.notch`），重启后保留。

### 动画参数

- **动画时长** 0.1 – 1.5 秒（默认 0.45，原先用系统默认约 0.2 秒，偏快）
- **缓动曲线** 平滑 / 缓出 / 缓入 / 线性
- **恢复默认**

改动即时生效，写入 `UserDefaults`（key: `dshNotch.animationDuration` / `dshNotch.easing`），重启后保留。

### 展开与收起必须分别处理内容时机

内容状态（`contentExpanded`）要**故意滞后于**窗口状态：

- **展开**：内容立刻置为展开，由窗口动画把它「拉」出来
- **收起**：内容留到**动画结束后**才撤。否则 `objectWillChange` 的回调会在动画一开始
  就把卡片撤掉，只剩一个空窗口在缩小——表现就是「消失没有动画」

`--clicktest` 会在动画走到一半时采样内容像素来守这条：

```
✓ 收起动画进行中内容仍在      0.28s 时非透明像素 7626（展开态 16323 的一半）
✓ 动画结束后内容才撤掉        非透明像素 0
```

### 动画时长怎么控制

`setFrame(_:display:animate:)` 的时长是系统固定的、改不了，所以动画改用 `NSAnimationContext`：

```swift
NSAnimationContext.runAnimationGroup { context in
    context.duration = settings.animationDuration
    context.timingFunction = settings.easing.timingFunction
    panel.animator().setFrame(target, display: true)
}
```

分段控件是自绘的（HStack + Button），没用 `Picker(.segmented)`：
AppKit 支撑的控件在离屏渲染里只能画出占位符（一块带禁止符号的黄条），
而本项目只能靠离屏渲染自查，自绘才能验证到真实效果。

## 自检（无需肉眼）

当前 Agent 环境没有屏幕录制权限，`screencapture` 不可用。三个自检模式覆盖了
「看不到屏幕」时最容易出错的地方：

```bash
BIN=./build/DSHNotch.app/Contents/MacOS/DSHNotch

$BIN --panelcheck   # 窗口落点 + 层级：是否真的落在刘海/卡片矩形上、是否高于菜单栏
$BIN --clicktest    # 点击链路：折叠空白 → 点击出卡片 → 再点收起（含内容像素校验）
$BIN --settingscheck # 设置项读写与持久化
$BIN --modecheck     # 形态判定：刘海/菜单栏/合盖/强制指定
$BIN --alertcheck    # 额度提醒判定：8 种阈值情形
$BIN --costcheck     # 今日消耗推算：跨天/隔天/异常值
$BIN --render       # 离屏渲染余额页 → /tmp/dsh-notch-expanded.png
$BIN --render --render-settings   # 离屏渲染设置页 → /tmp/dsh-notch-settings.png
$BIN --render --render-alert      # 离屏渲染提醒态 → /tmp/dsh-notch-alert.png
$BIN --selftest     # 数据链路：凭据读取 + 接口调用 + 解析
```

排查显示问题时还有两个环境变量：

```bash
# 常驻展开，不做 hover 轮询。
# 用来把「窗口能不能显示出来」和「hover 时机对不对」这两件事分开验证——
# 分不清是"没展开"还是"展开了但看不见"时，这是最有效的隔离手段。
DSH_NOTCH_FORCE_EXPAND=1 $BIN

# 把状态切换、窗口实际 frame、窗口服务器的层级/合成顺序打进日志
DSH_NOTCH_DEBUG=1 $BIN

# 启动 N 秒后模拟一次额度提醒，用于即时验证弹出/自动收起
DSH_NOTCH_TEST_ALERT=3 $BIN
```

`--panelcheck` 与 `--clicktest` 是这次踩坑后加的回归护栏，见下面三节。

## 最大的那个坑：窗口被系统下推 33pt

### 症状

- 鼠标移进刘海**唤不出卡片**
- 卡片展开后**不贴屏幕顶端**，上方露出一条菜单栏
- 移出卡片**收不回去**

### 根因

`NSWindow.setFrame` 默认会把 frame 约束进屏幕的 `visibleFrame`，而
`visibleFrame` **不包含菜单栏**（本机 `visibleFrame = (0, 0, 1466, 949)`，
顶边是 949，而屏幕顶边是 982）。窗口于是被整体下推 33pt（菜单栏 32pt + 1pt 间隙）：

| | 目标 | 实际 |
|---|---|---|
| 折叠（刘海矩形） | y = 950 | **y = 917** |
| 展开（卡片矩形） | y = 764 | **y = 731** |

刘海在 y 950–982，而折叠窗口落在 y 917–949——**鼠标移进刘海时根本不在窗口内**，
所以永远唤不出卡片。

### 修复

`NotchPanel` 覆写 `constrainFrameRect(_:to:)` 直接返回原始 rect。

### 为什么一开始没发现

第一版的自检只比较了**宽和高**，没比原点，所以窗口被整体下推依然报 `✓ 符合`。
现在比较完整 rect（含原点），容差 1pt（窗口 frame 会对齐到 2x 像素网格）。

## 第二个坑：窗口层级被 isFloatingPanel 覆盖，压在菜单栏下面

### 症状

状态机、窗口 frame 全部正确（日志逐条 `✓ 与目标一致`），**但屏幕上什么也看不见**。

### 根因

```swift
panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)  // 设成 26
...
panel.isFloatingPanel = true   // ← 这一行把 level 强制改回 floating(3)
```

`NSPanel.isFloatingPanel = true` 会把窗口层级设为 `floating(3)`，**覆盖**之前设的 level。

用 `CGWindowListCopyWindowInfo` 看到的真实合成顺序：

```
layer=3     DSH Notch        bounds=(659, 0, 193, 32)     ← 我们的窗口，在最底下
layer=20    程序坞            bounds=(0, 0, 1512, 982)     ← 菜单栏容器
layer=24    Window Server    bounds=(0, 0, 1512, 33)      ← 菜单栏
layer=0     DeepSeek Harness bounds=(0, 33, 1466, 949)
```

层级 3 低于菜单栏(24)，窗口被整个压在下面。

### 修复

面板配置抽成 `NotchPanel.configured(contentRect:)`，控制器与 `--panelcheck` 共用同一份；
删掉 `isFloatingPanel`，`level` 放到所有属性设置完之后再赋（26 = `.mainMenu + 2`）。

`--panelcheck` 现在会断言层级：

```
✓ 窗口层级 26 > 菜单栏层级 24
```

### 教训

**frame 正确 ≠ 显示在屏幕上。** 当时的自检（判定逻辑 / `--panelcheck` 的落点部分）
全部通过，窗口依然不可见。判断一个窗口是否真的在屏幕上，要看
`CGWindowListCopyWindowInfo` 给出的**层级和合成顺序**，而不只是 `NSWindow.frame`。
`DSH_NOTCH_DEBUG=1` 启动时会把这条信息打进日志。

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
| `Sources/BalanceModel.swift` | 状态机：轮询、失败保留旧值 |
| `Sources/BalanceAlert.swift` | 提醒判定（纯函数）+ 提醒模型 |
| `Sources/DailyCost.swift` | 今日消耗推算（纯函数）+ 展示 |
| `Sources/Balance.swift` | 凭据读取、接口调用、数据模型 |
| `Sources/NotchPresenter.swift` | 刘海形态：面板、点击、动画 |
| `Sources/MenuBarPresenter.swift` | 菜单栏形态：状态栏项、popover、标题提醒 |
| `Sources/NotchGeometry.swift` | 刘海几何（只在真有刘海时构造） |
| `Sources/Views.swift` | 卡片视图 + 全部自绘控件 |
| `Sources/Diagnostics.swift` | 日志、离屏渲染、窗口服务器查询 |
| `Sources/main.swift` | 入口 + 7 项自检 |

### 取数链路

```
~/.dsh/.credentials.yaml  →  deepseek-account-platform/default  →  token + issuer
        ↓
GET {issuer}/api/v0/users/get_user_summary
Header: x-dsh-auth-token: <token>
        ↓
data.biz_data.normal_wallets / bonus_wallets / total_costs
```

- 超时 30s（对齐 DSH 自身的 `balanceTimeoutMs`）
- 轮询间隔 5 分钟
- **查询失败绝不合成 0**：保留上一次成功快照，界面标注「显示的是上次成功获取的数据」
- 金额字段同时兼容十进制字符串和 JSON 数字两种形态

## 已知限制

1. **接口有频率限制**。开发期间实测触发过 HTTP 429；5 分钟轮询是安全的，不要调低。
2. **凭据来源是 DSH 内部文件**。`~/.dsh/.credentials.yaml` 的格式随 DSH 版本可能变化；
   解析失败会给出明确报错，不会静默显示错误金额。
3. **没有 Apple 签名与公证**。首次打开需要「右键 → 打开」，需要 $99/年才能免掉这一步。
4. **开机自启未验证**（`SMAppService`）。未签名应用注册登录项可能被系统拒绝；
   失败时设置项会退回系统实际状态，不会撒谎。以 README 里的手动方式为准。
5. **全屏 / 多显示器下的窗口层级未做视觉验证**：`.statusBar + 1`、`canJoinAllSpaces`、
   `fullScreenAuxiliary` 的效果需要在全屏应用、多显示器场景下肉眼确认。
6. **今日消耗是本地推算的**，平台没有按天维度；基线不可信时显示「统计中」或「≥¥x.xx」。
7. **只构建 arm64**。带刘海的 MacBook 全是 Apple Silicon，工具链的运行库也只有 arm64 切片。

## 后续可做

- 全屏 / 多显示器场景下的层级验证
- 更新检查
- 消耗趋势折线（采样序列已经在攒了）
- Apple Developer ID 签名与公证（$99/年）

---

# 附：Swift 工具链问题（已解决）

## 症状

系统 `/usr/bin/swiftc` 编译**任何** Swift 代码都会失败：

```
error: unable to load standard library for target 'arm64-apple-macosx18.0'
error: could not build Objective-C module 'SwiftShims'
error: redefinition of module 'SwiftBridging'
```

## 根因

本机 Command Line Tools 是 **Xcode 16.2**（`CLTools_Executables 16.2.0.0.1`），它内部自相矛盾：

| 组件 | 版本戳 |
|---|---|
| `CLT/usr/bin/swift-frontend` | `swiftlang-6.0.3.1.10` |
| `SDK/MacOSX15.2.sdk` 的 `Swift.swiftmodule/*.swiftinterface` | `swiftlang-6.0.3.1.5` |

编译器与它自带 SDK 的标准库接口版本戳不一致，因此无法加载标准库。
机器上也没有完整 Xcode。背景是本机运行 macOS 27.0，而 CLT 仍是 Xcode 16.2 时代的产物。

## 解决方式

本机 Homebrew 装有**自洽的 Swift 6.3.3 工具链**。它使用工具链自带的 stdlib
（`runtimeResourcePath` 指向工具链而非 SDK），因此不会去读 SDK 里那个版本戳对不上的标准库。

`toolchain.sh` 把它和系统 SDK、可写模块缓存一起封装好：

```bash
source toolchain.sh
dsh_swiftc -O main.swift -o app
./verify-toolchain.sh     # 一键验证
```

## 正统修复路径（可选）

1. **更新 Command Line Tools** 到与 macOS 27 匹配的版本。
2. **安装完整 Xcode**（推荐用于正式开发，自带 SwiftPM、调试器、Instruments）。

## 未验证项

- **SwiftPM（`swift build`）未能在 Agent 环境验证**：SwiftPM 需要嵌套 `sandbox-exec`，
  被 Agent 沙箱拒绝（`sandbox-exec: sandbox_apply: Operation not permitted`）。
  这是 Agent 环境的限制，不是工具链问题，请在普通终端自行确认。
