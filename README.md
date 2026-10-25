# DSHNotch

**DeepSeek Harness 的 macOS 原生伴侣：刘海看余额，任务完成 / 等你处理时发系统通知。**

[English](README.en.md) · [下载](https://github.com/hennysky/dsh-notch/releases) · [工程笔记](docs/engineering-notes.md)
· [DSH 通知协议](docs/dsh-notifications.md)

![release](https://img.shields.io/github/v/release/hennysky/dsh-notch)
![license](https://img.shields.io/github/license/hennysky/dsh-notch)
![platform](https://img.shields.io/badge/macOS-14%2B%20%C2%B7%20arm64-blue)
![plugin tests](https://github.com/hennysky/dsh-notch/actions/workflows/plugin-tests.yml/badge.svg)

| 余额就在刘海里 | 没有刘海的 Mac 也能用 | 通知可以分别关 |
|---|---|---|
| ![刘海形态](preview/balance.png) | ![菜单栏形态](preview/menubar.png) | ![通知设置](preview/settings-notifications.png) |
| 点刘海展开卡片 | 自动用菜单栏形态 | 任务完成 / 需要处理，两个开关 |

三件事：

- **余额**：点刘海（或菜单栏）就能看到 DeepSeek Harness 余额；跌破阈值、单次消耗过大时主动提醒。
- **DSH 通知**：任务完成、失败、或 agent 停下来等你审批／回答时发 macOS 系统通知。点通知切回 DSH；
  横幅会消失，但菜单栏图标上的**红点不会**——直到你点开卡片。
- **跟着 DSH 启动**：装一个配套插件，DSH 启动时自动拉起，并负责把会话事件转成通知。

> 状态：v1.6.7（Windows 1.2.3 / 插件 1.6.1）· MIT · macOS 14+ · Apple Silicon ｜ 12 项零人工自检、插件测试与真实通知投递均已实测

---

## 这个项目解决什么问题

DSH 的余额只在应用界面里看得到。挂着长任务的时候，你不点开就不知道额度掉了多少，
往往等发现时已经快用完了。长任务还有另一个问题：任务跑完了、或 agent 停下来等你审批，
人不在窗口前就完全不知道——DSH 桌面端没有任何系统通知。

DSHNotch 解决这两件事：把余额搬到刘海／菜单栏，并在额度异常、任务完成、需要你处理时
主动提醒。

功能边界刻意守住：**只读余额、只转发 DSH 的事件。不代发消息、不碰你的账号、不做充值流程。**

---

## 安装

### 要求

| | |
|---|---|
| 机型 | Apple Silicon 的 Mac（带刘海的 MacBook 全部是 Apple Silicon） |
| 系统 | macOS 14.0 或更高 |
| 前置 | **已安装并登录 DeepSeek Harness**——余额数据来自它的登录凭据 |

> **没有装 DSH 的话这个工具对你没用**，它会显示下面这个引导页而不是余额。
> 应用读的是**你自己机器上**的凭据，不会看到别人的数据。

![未连接账号时的引导](preview/setup-guide.png)

### 下载

[GitHub Releases](https://github.com/hennysky/dsh-notch/releases) ·
[Gitee 发行版](https://gitee.com/hennysky/dsh-notch/releases)（国内更快）

两个平台的安装包逐字节相同，任选。

### 安装（一条命令）

```bash
# GitHub
curl -fL -o /tmp/DSHNotch.zip \
  https://github.com/hennysky/dsh-notch/releases/download/v1.7.6/DSHNotch-1.6.7.zip \
  && unzip -q -o /tmp/DSHNotch.zip -d /Applications \
  && xattr -dr com.apple.quarantine /Applications/DSHNotch.app \
  && open /Applications/DSHNotch.app
```

```bash
# Gitee
curl -fL -o /tmp/DSHNotch.zip \
  https://gitee.com/hennysky/dsh-notch/releases/download/v1.7.6/DSHNotch-1.6.7.zip \
  && unzip -q -o /tmp/DSHNotch.zip -d /Applications \
  && xattr -dr com.apple.quarantine /Applications/DSHNotch.app \
  && open /Applications/DSHNotch.app
```

### 手动安装

1. 下载 `DSHNotch-1.6.7.zip`
2. 解压，把 `DSHNotch.app` 拖进「应用程序」
3. **首次打开必须右键 → 打开**（原因见下）

### 为什么首次要「右键 → 打开」

应用没有 Apple 开发者签名与公证（需要 99 美元/年）。macOS 的 Gatekeeper 会拦下未签名的应用，
双击只会看到「无法打开」。「右键 → 打开」是一次性的放行，之后不再提示。

不想用右键，也可以去掉隔离标记：

```bash
xattr -dr com.apple.quarantine /Applications/DSHNotch.app
```

这行命令做的事情就是删掉「这个文件来自网络」的标记。应用本身不联网下载任何东西，
只读取本机 DSH 的凭据、请求 DeepSeek 平台的余额接口。

---

## 使用

### 启动

把 `DSHNotch.app` 拖进「应用程序」，双击即可（首次需要右键 → 打开）。

**或者让它跟着 DSH 一起启动** —— 装一个配套的 DSH 插件即可，见下面的「作为 DSH 插件使用」。

启动之后**菜单栏会出现一个卡片图标**——应用不占 Dock，刘海形态下屏幕上也不显示东西，
这个图标是用来确认「它在运行」的：

| 操作 | 效果 |
|---|---|
| **左键** | 展开余额卡片 |
| **右键** | 菜单：显示卡片 / 立即刷新 / 打开充值页 / 设置 / 开机自启 / **退出** |

不想看到它？设置 → 通用 → 菜单栏图标，可以关掉。
（菜单栏形态下不需要它，那个图标本身就是入口。）

**不想每次手动启动**：设置 → 通用 → 打开「开机自启」。已实测可用。

### 第一次打开：需要先连上 DSH

余额来自 DSH 保存的登录凭据。如果这台机器上还没有（没装 DSH、或装了没登录），
卡片会直接告诉你该做什么：

| 情况 | 卡片显示 |
|---|---|
| 找不到凭据文件 | 「还没有找到 DSH 的登录凭据」+ 引导去安装并登录 |
| 有凭据但没登录记录 | 「DSH 还没有登录」+ 引导去登录 |
| 其它错误（网络、限流） | 正常的错误行——**不会**被误判成引导态 |

登录完点「重新检查」即可，不用重启应用。

### 两种形态，自动选

**不需要在安装时选择，也不需要你知道自己有没有刘海。** 应用会在运行时判断，
并在显示器变化时自动重判：

| 场景 | 形态 |
|---|---|
| MacBook 有刘海 | **刘海形态**：点刘海展开卡片 |
| Mac mini / iMac / 纯外接屏 | **菜单栏形态**：菜单栏显示金额，点开是卡片 |
| MacBook 合盖接外屏 | 自动切到菜单栏形态，**功能不丢** |

想固定用某一种，可以在设置里指定：自动 / 仅刘海 / 仅菜单栏。

### 卡片里有什么

```
● DeepSeek Harness                    ⚙  ↻
¥20.75
充值钱包余额
────────────────────────────────
赠送钱包                        ¥0.00
累计消费                      ¥555.11
今日消耗                        ¥2.63
────────────────────────────────
更新于 15:23:57              [ 充值 ↗ ]
```

- **充值 ↗** 用系统浏览器打开平台充值页，沿用那边的登录态，不带任何 token
- **↻** 手动刷新，立即生效
- **⚙** 进入设置

### 什么时候刷新

| 触发 | 说明 |
|---|---|
| **点开卡片 / 菜单栏** | **立刻刷新，你看到的就是当下余额** |
| 后台轮询 | 每 5 分钟一次 |
| 手动点 ↻ | 立即刷新，不受限制 |

点开时的刷新有 30 秒下限（刚查过就不重复查）——否则反复点开会触发平台的频率限制。

### 额度提醒

余额藏在刘海后面，不点开就不知道掉了多少，所以有两条主动提醒规则：

| 规则 | 默认 | 行为 |
|---|---|---|
| **余额低于** | ¥10 | 跌破那一刻提醒一次 |
| **单次消耗超过** | ¥2 | 相邻两次查询之间掉得太多就提醒 |

- 阈值**设为 0 即关闭**该规则
- 两条同时命中时，余额告急优先
- **刘海形态**：卡片自动弹出来，停留几秒后自己收回
- **菜单栏形态**：菜单栏标题临时变色（`¥5.74 → ⚠ ¥5.74`），不打断你正在做的事
- 你一旦自己点击，提醒立刻交还给你

> 为什么「跌破」只提醒一次？因为后台每 5 分钟查一次，按「处于低位」判定会变成每 5 分钟响一次。
> 充回阈值之上后会重新武装，下次再跌破才会再提醒。

### DSH 通知（v1.4）

DSH 桌面端本身没有任何系统通知：任务跑完了、或 agent 停下来等你审批，人不在窗口前就
完全不知道。装上配套插件（[`plugin/`](plugin/)，v1.6.1+）后，这些事件由 DSHNotch 变成
macOS 通知：

| 什么时候 | 通知 |
|---|---|
| DSH 跑完一轮 | 「任务完成」，正文是会话名 + 用时 |
| 任务失败 / 被阻塞 / 达到长度上限 | 对应的标题，失败时附错误信息 |
| agent 等你审批 | 「需要你确认」+ 工具名与原因 |
| agent 提问 | 「需要你回答」+ 问题题干 |

- **点通知直接切回 DeepSeek Harness**（应用没在跑就先打开它）
- **横幅会消失，红点不会**：有新通知时菜单栏图标右上角出现红点（菜单栏形态是金额后面的
  `●`），直到你点开卡片（或点开那条通知）才清除——不在屏幕前也不会永久错过
- 第一次会问一次系统授权，之后可在「系统设置 → 通知 → DSH Notch」里关掉；
  也可以在卡片设置 → **通知**页单独关掉「任务完成通知」/「需要处理通知」
- 用户自己按停止的轮次默认不通知（你本来就知道）；子 agent 的轮次不单独通知
- 通知由 DSHNotch 用自己的身份发出，不经过「脚本编辑器」这类替身

链路：插件在 DSH 侧监听会话事件 → `POST 127.0.0.1:47810/notify` → DSHNotch 用
`UNUserNotificationCenter` 投递。端口只绑回环；没装插件、或插件没加载时，DSHNotch 的
其余功能完全不受影响。协议与设计见 [docs/dsh-notifications.md](docs/dsh-notifications.md)。

通知没出来时按顺序排查：

```bash
curl -s http://127.0.0.1:47810/health
# {"app":"DSHNotch","authorization":"authorized","ok":true,"version":"1.4"}

grep 通知 "$(node -e 'process.stdout.write(require("os").tmpdir())')/dsh-notch-plugin.log"
```

| 现象 | 原因 |
|---|---|
| curl 连不上 | DSHNotch 没在跑（或端口被另一个实例占用） |
| `authorization` 不是 `authorized` | 系统通知权限没开 |
| 日志里没有「已注册 3 个监听」 | 插件还是旧版：重启一次 DSH 加载新代码 |
| 日志里 `HTTP 200 … shown:false` | 卡片设置里对应的开关被关了 |

### Token 用量日历

卡片标题栏的日历按钮可以切到「用量日历」：日历页会把同一张卡片放大到 380×390，
展示近 3 个月的每日 token 用量或金额（token 紫色、金额绿色），鼠标悬停色块查看当天具体数值。

![Token 用量日历](preview/calendar-tokens.png)

- 数据由插件按天聚合会话日志，首次回填需要几十秒，之后增量更新
- 只读本地 `~/.dsh/notch/token-activity.json`；口径见 [docs/token-activity.md](docs/token-activity.md)

### 当前会话花费

装插件（1.6.1+）后，卡片会多一块「当前会话」：你正在看的那个 DSH 会话用了多少 token、
按官方价目估算花了多少钱（如 `≈¥0.42`，标注预估、以平台账单为准）。

- token 来自 DSH 会话日志，是精确值；金额是按官方高峰/空闲单价折算的估算
- 只读本地 `~/.dsh/notch/session-cost.json`，不联网、不记录对话内容
- 数据来源与计价规则见 [docs/session-cost.md](docs/session-cost.md)

### 设置

卡片右上角的滑杆图标进入设置，分四页：

| 页 | 内容 |
|---|---|
| **提醒** | 余额低于、单次消耗、弹出停留时长 |
| **动画** | 展开/收起动画时长与缓动曲线 |
| **通用** | 呈现形态、开机自启 |
| **通知** | 任务完成通知、需要处理通知（DSH 插件发来的系统通知） |

改动即时生效并记住。

### 退出 / 卸载

| | |
|---|---|
| **退出** | 菜单栏图标右键 → 退出（或 点刘海 → 右上角滑杆图标 → 「退出应用」） |
| **开机自启** | 设置页 → 通用 → 开机自启 |
| **卸载** | 把 `DSHNotch.app` 删掉。配置存在 UserDefaults 域 `local.dsh.notch`，想彻底清干净就一并删除 |

---

## 作为 DSH 插件使用（可选）

如果你每天都开着 DeepSeek Harness，可以让刘海工具**跟着 DSH 一起启动**，不用单独双击。

仓库里的 [`plugin/`](plugin/) 是一个 DSH 插件，装进 profile 后它做两件事：

1. **生命周期**：DSH 启动 → 插件激活 → 确保 `DSHNotch.app` 在跑；
2. **通知桥**（v1.1.0+）：把 DSH 的任务结束 / 审批 / 提问事件 POST 给 DSHNotch，
   变成 macOS 系统通知（见上面「DSH 通知」）。

> **Windows 有独立的托盘伴侣**：下载 [DSHNotch-Setup-1.2.2.exe](https://github.com/hennysky/dsh-notch/releases/download/v1.7.6/DSHNotch-Setup-1.2.3.exe) 双击安装即可（装到
> `%LOCALAPPDATA%\Programs\DSHNotch`，不需要解压或命令行）；插件（v1.3.0+）会自动探测并拉起它。
> Gitee 发行版同样提供 Windows 安装包：https://gitee.com/hennysky/dsh-notch/releases/tag/v1.7.5
> 没装托盘应用时退到 DeepSeek Harness 自己的 Electron 通知，再退到 PowerShell toast。
> 源码在 [`windows/`](windows/)，见 [plugin/README.md](plugin/README.md)。

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add /path/to/dsh-notch/plugin
# 重启 DeepSeek Harness 生效
```

验证：

```bash
cat "$(node -e 'process.stdout.write(require("os").tmpdir())')/dsh-notch-plugin.log"
# [..] 已随 DSH 启动：/Applications/DSHNotch.app
# [..] 通知：已注册 3 个监听（桥端口 47810）
```

启动行为：应用没跑就启动；已在运行则不重复启动（避免画出第二个刘海窗口）；
应用不在预期位置则安静跳过。**改了插件代码必须重启 DSH**（Host 插件不像 Web UI 那样热更新）。

### 为什么插件不把界面直接搬进 DSH

刘海覆盖层要求窗口层级高于菜单栏、无边框、不抢焦点的 panel、排除出 Exposé 与窗口循环。
这些只有原生 `NSWindow` 能做到，Electron 的 `BrowserWindow` 拿不到那个层级。
所以插件负责**生命周期**，界面仍然由 `DSHNotch.app` 负责。

详见 [plugin/README.md](plugin/README.md)。

## 数据从哪来

```
~/.dsh/.credentials.yaml          ← 本机 DSH 保存的平台授权
        ↓
GET {platform}/api/v0/users/get_user_summary
Header: x-dsh-auth-token: <token>
        ↓
normal_wallets / bonus_wallets / total_costs
```

- **不改动、不上传你的凭据**。token 只在请求余额接口时作为请求头发给 DeepSeek 平台本身
- 充值链接的域名取自同一份凭据，**链接里不携带任何 token**
- 查询失败时**保留上一次成功的数据**并标注，绝不显示成 ¥0.00
- 金额字段同时兼容平台的两种下发形态（十进制字符串和 JSON 数字）

### 今日消耗是怎么算的

平台接口**没有按天维度**，只提供累计消费（`total_costs`，全时段）。
所以今日消耗是本地推算的：记录每天起点的累计值作为基线，用差值算。

当天起点无从得知时（首次运行、或隔了多天才开应用），**不会显示成 ¥0.00** ——
那是把「不知道」伪装成「没消耗」：

| 基线 | 显示 | 含义 |
|---|---|---|
| 可信 | `¥2.63` | 精确值 |
| 不可信，尚无增量 | `统计中` | 等第一次增量 |
| 不可信，已有增量 | `≥¥2.63` | 至少这么多 |

从第二天起会自动变精确。

---

## 常见问题

**点了刘海没反应？**
确认刘海那一块区域（屏幕最上沿、中间约 193pt）真的被点到了。如果长期无响应，
用下面的自检跑一遍，并把 `/tmp/dsh-notch.log` 附在 issue 里（需要先用
`DSH_NOTCH_DEBUG=1` 启动）。

**为什么余额显示「统计中」？**
见上面「今日消耗是怎么算的」。这是本地推算在当天还没有可信基线时的诚实显示。

**会不会把我的 token 传到别的地方？**
不会。只有两个网络请求：查余额（发给 DeepSeek 平台）、打开充值页（交给系统浏览器，
链接里不含 token）。没有别的上报。

**我把这个发给朋友，他能用吗？**
可以，前提是**他也用 DSH 并登录过**——应用读的是他自己机器上的
`~/.dsh/.credentials.yaml`，看不到你的数据。整份代码里只硬编码了一个域名
（`platform.deepseek.com`），不会把数据发到别处。

需要提醒的是：通过微信 / AirDrop / 浏览器下载的包会带上「来自网络」标记，
**双击必然被 Gatekeeper 拦下**，要走「右键 → 打开」。把 README 里那条 `curl`
命令发给他更省事——`curl` 下载不带这个标记。

**Intel Mac 能用吗？**
不能。只构建了 arm64：所有带刘海的 MacBook 都是 Apple Silicon。

**菜单栏里没有图标？**
设置 → 通用 → 呈现形态，确认不是停在「仅刘海」。如果选了「仅刘海」但那块屏没有刘海，
应用会退回菜单栏形态并在日志里记一条。

---

## 自检

项目带 12 项自检，**全部不依赖肉眼**——开发环境没有屏幕录制权限，
所以每个结论都要能被命令验证：

```bash
BIN=/Applications/DSHNotch.app/Contents/MacOS/DSHNotch

$BIN --selftest        # 凭据读取 + 接口调用 + 解析
$BIN --modecheck       # 形态判定：刘海 / 菜单栏 / 合盖 / 强制指定
$BIN --refreshcheck    # 刷新时机：30 秒限流边界
$BIN --alertcheck      # 额度提醒判定：8 种阈值情形
$BIN --costcheck       # 今日消耗推算：跨天 / 隔天 / 异常值
$BIN --settingscheck   # 设置项读写与持久化
$BIN --logincheck      # 开机自启：能否注册登录项（试完自动撤销）
$BIN --setupcheck      # 首次使用引导：凭据缺失/未登录的分类，以及不误判
$BIN --panelcheck      # 窗口落点 + 层级高于菜单栏
$BIN --clicktest       # 点击链路 + 命中测试 + 内容像素 + 收起动画中途采样
$BIN --notifycheck     # 通知桥协议：/health、/notify、去重、截断、错误码
$BIN --unreadcheck     # 未读红点：计数 / 清零 / 图标里真的画出了红色像素
```

排查显示问题时还有几个开关：

```bash
DSH_NOTCH_DEBUG=1 $BIN      # 把状态切换、窗口实际 frame、窗口服务器层级打进 stderr
DSH_NOTCH_TEST_ALERT=3 $BIN # 启动 3 秒后模拟一次额度提醒
```

---

## 已知限制

1. **没有 Apple 签名与公证**。首次打开需要「右键 → 打开」。
2. **接口有频率限制**。开发期间实测触发过 HTTP 429；这也是点开刷新要设 30 秒下限的原因。
3. **开机自启不支持沙箱或未签名的分发形态有额外限制**。本项目实测 adhoc 签名可正常注册
   （`--logincheck`），但**应用需要在「应用程序」目录下**才有意义。若被系统拒绝，
   设置项会退回实际状态，可在「系统设置 → 通用 → 登录项」手动添加。
4. **全屏 / 多显示器下的窗口层级未做视觉验证**。需要在全屏应用、多显示器场景下肉眼确认。
5. **今日消耗是本地推算的**，平台没有按天维度。
6. **只构建 arm64**。
7. **凭据来源是 DSH 的内部文件**，其格式随 DSH 版本可能变化。解析失败会明确报错，
   不会静默显示错误金额。
8. **通知依赖 DSH 插件 v1.1.0+**。插件代码在 DSH 启动时加载，升级插件后要重启一次 DSH；
   DSHNotch 自身升级不需要重启 DSH。
9. **通知只覆盖根会话**：子 agent 的轮次不单独通知；用户自己按停止的轮次默认不通知。
10. **免打扰 / 专注模式会压掉横幅**（通知仍进通知中心，视系统设置而定），这是 macOS 行为。
11. **点击通知只切回 DSH 应用，不跳具体会话**：DSH 的本地端口每次启动都会变，暂不做深链。

---

## 开发

```bash
git clone https://github.com/hennysky/dsh-notch.git
cd dsh-notch
./build.sh      # → build/DSHNotch.app
./release.sh    # → dist/DSHNotch-x.y.zip
```

需要 Swift 工具链。构建产物**必须显式指定部署目标**——不指定会继承工具链默认值，
把 `LC_BUILD_VERSION` 写成当前系统版本，那样发出去的包谁都跑不起来
（`toolchain.sh` 里已固定）。详见[工程笔记](docs/engineering-notes.md)。

代码结构与实现取舍同样在[工程笔记](docs/engineering-notes.md)里。

---

## 协议

[MIT](LICENSE)
