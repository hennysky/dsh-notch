# DSHNotch

**在 Mac 上随时看到 DeepSeek Harness 的余额。**

[English](README.en.md) · [下载](https://github.com/hennysky/dsh-notch/releases) · [工程笔记](docs/engineering-notes.md)

点一下刘海（或菜单栏）就能看到余额；余额跌破阈值、或单次消耗过大时，它会主动弹出来提醒你。

| 有刘海的 MacBook | 其它 Mac（Mac mini / iMac / 外接屏） |
|---|---|
| ![刘海形态](preview/balance.png) | ![菜单栏形态](preview/menubar.png) |
| 点刘海展开卡片 | 菜单栏直接显示金额，点开是卡片 |

---

## 这个项目解决什么问题

DSH 的余额只在应用界面里看得到。挂着长任务的时候，你不点开就不知道额度掉了多少，
往往等发现时已经快用完了。

DSHNotch 把余额搬到两个你随时能看到的地方，并在额度异常时主动提醒。

功能刻意做得很窄：**只读余额。不做充值流程、不做历史账单、不碰你的账号。**

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
  https://github.com/hennysky/dsh-notch/releases/download/v1.0.2/DSHNotch-1.0.2.zip \
  && unzip -q -o /tmp/DSHNotch.zip -d /Applications \
  && xattr -dr com.apple.quarantine /Applications/DSHNotch.app \
  && open /Applications/DSHNotch.app
```

```bash
# Gitee
curl -fL -o /tmp/DSHNotch.zip \
  https://gitee.com/hennysky/dsh-notch/releases/download/v1.0.2/DSHNotch-1.0.2.zip \
  && unzip -q -o /tmp/DSHNotch.zip -d /Applications \
  && xattr -dr com.apple.quarantine /Applications/DSHNotch.app \
  && open /Applications/DSHNotch.app
```

### 手动安装

1. 下载 `DSHNotch-1.0.2.zip`
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

### 设置

卡片右上角的滑杆图标进入设置，分三页：

| 页 | 内容 |
|---|---|
| **提醒** | 余额低于、单次消耗、弹出停留时长 |
| **动画** | 展开/收起动画时长与缓动曲线 |
| **通用** | 呈现形态、开机自启 |

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

仓库里的 [`plugin/`](plugin/) 是一个 DSH 插件，装进 profile 后：DSH 启动 → 插件激活 →
确保 `DSHNotch.app` 在跑。

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add /path/to/dsh-notch/plugin
# 重启 DeepSeek Harness 生效
```

验证：

```bash
cat "$(node -e 'process.stdout.write(require("os").tmpdir())')/dsh-notch-plugin.log"
# [..] 已随 DSH 启动：/Applications/DSHNotch.app
```

三种行为：应用没跑就启动；已在运行则不重复启动（避免画出第二个刘海窗口）；
应用不在预期位置则安静跳过。

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

项目带 10 项自检，**全部不依赖肉眼**——开发环境没有屏幕录制权限，
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
