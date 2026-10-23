# dsh-plugin-notch-balance

DSH 插件：**启动 DeepSeek Harness 时自动拉起 DSHNotch 刘海余额工具，并把
「任务完成 / 需要你确认 / 需要你回答」推送成系统通知。**

- **macOS**：由 `DSHNotch.app` 发通知（本地 HTTP 桥，署名 DSH Notch）
- **Windows**：不需要额外应用——直接由 DeepSeek Harness 自己发（Electron 原生通知 +
  任务栏未读红点）；拿不到 Electron 时退回 PowerShell toast

## 为什么是「拉起一个应用」而不是「把界面搬进 DSH」

刘海覆盖层要求：窗口层级高于菜单栏、无边框、不抢焦点的 panel、排除出 Exposé 与窗口循环。
这些只有原生 `NSWindow` 能做到；Electron 的 `BrowserWindow` 拿不到那个层级。

所以 macOS 上这个插件的职责是**生命周期管理 + 事件桥接**，界面和通知都由 `DSHNotch.app`
负责。两者是配套关系，不是替代关系。Windows 没有刘海应用，通知由宿主进程直接发（见下面的
「Windows」一节）。

## 装什么

| 东西 | 作用 |
|---|---|
| `DSHNotch.app` | 真正的刘海余额界面 + 发 macOS 通知的本地 HTTP 桥 |
| 本插件 | 随 DSH 启动确保应用在跑；监听会话事件，把通知 POST 给应用 |

## 安装

### 1. 先装应用

`DSHNotch.app` 放到 `/Applications/DSHNotch.app`（插件默认从这里启动）。
装在别处的话，改插件 `config.appPath`。

### 2. 再装插件

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add /path/to/this/directory
```

`dsh plugin` 会做两件事：把包装进 profile，并把 bundle 加进 `dsh.profile.bundles`。

### 3. 重启 DSH

插件在 profile 装载时激活，**需要重启 DeepSeek Harness 生效**。

## 验证它真的工作了

插件把行为写进一份诊断日志（不记任何余额、凭据或通知正文）：

```bash
cat "$(node -e 'process.stdout.write(require("os").tmpdir())')/dsh-notch-plugin.log"
```

三种启动结果：

| 日志 | 含义 |
|---|---|
| `已随 DSH 启动：/Applications/DSHNotch.app` | 正常 |
| `已在运行，不重复启动` | 应用本来就在跑（不会画出第二个刘海窗口） |
| `跳过：未找到 <路径>` | 应用不在那个位置，装好或改 `appPath` |

也可以直接看进程：

```bash
pgrep -x DSHNotch
```

## Windows：三种后端，自动降级

Windows 上 DSH 同样是 Electron 主进程跑 Host，插件和宿主在同一个进程里。所以通知
不需要像 macOS 那样必须有一个伴侣应用，优先级是：

```
1. DSHNotch 托盘应用（推荐）
      本地桥 127.0.0.1:47810 —— 和 macOS 完全同一套 /health、/notify 协议
      托盘显示余额、任务栏未读红点、toast 署名 DSHNotch
2. Electron 原生通知（没装托盘应用时）
      import('electron') → new Notification(...)  ← 署名 DeepSeek Harness
      点击 → BrowserWindow 恢复/聚焦；未读 → win.setOverlayIcon(任务栏红点)
3. PowerShell toast（拿不到 Electron 时，例如 dsh web 在 Node 里跑）
      WinRT toast，署名 Windows PowerShell，点击无行为
```

Windows 配置（`cordis.patch.yml` 的 `config`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `notifyTaskDone` | `true` | Windows 侧是否通知「任务完成 / 失败 / 阻塞 / 中断」 |
| `notifyAttention` | `true` | Windows 侧是否通知审批与提问 |
| `notifyBackend` | `auto` | `auto`（托盘 → Electron → PowerShell）/ `app` / `electron` / `powershell` |
| `windowsAppPath` | 空 | 托盘应用路径；留空自动探测 `%LOCALAPPDATA%\Programs\DSHNotch\DSHNotch.exe` |
| `powershellPath` | `powershell.exe` | 兜底通知使用的 PowerShell |

托盘应用从仓库的 [`windows/`](../windows/) 构建（GitHub Actions 的 windows-latest
产出 `DSHNotch-Windows-*.zip`），解压后放到
`%LOCALAPPDATA%\Programs\DSHNotch\DSHNotch.exe` 即可；插件在 `auto` 模式下会自动探测并拉起它。

验证（不需要 Windows 机器也能跑大部分）：

```bash
NOTCH_SKIP_PROCESS_TESTS=1 node plugin/test.mjs
```

测试里注入了假的 `electron` 和假的本地桥，所以三种后端的**选择顺序**与
`send` / 未读 / 点击行为都能在 macOS 上验证；真实 toast 与托盘外观只能在 Windows 上肉眼确认。

## Token 用量日历

卡片里还有一个「用量日历」：近 12 个月的每日 token 用量或预估金额，53 周 × 7 天的
色块，鼠标悬停查看具体数值；顶部可在「用量 / 金额」之间切换（token 紫色、金额绿色）。

- 数据由插件回填 + 实时累加：启动时扫描 `~/.dsh/sessions`（只重算 mtime 变过的会话），
  运行时监听 `session/event`；按北京时间切天
- 首次回填可能跑几十秒（历史会话多时），缓存后重启很快
- 产出 `~/.dsh/notch/token-activity.json`，内部缓存 `token-activity-cache.json`
- 配置：`tokenActivity` / `tokenActivityFile` / `tokenActivityCacheFile`
- 详细契约见 [docs/token-activity.md](../docs/token-activity.md)

## 当前会话花费（哪个窗口花了多少钱）

除了通知，插件还会记录**你正在看的那个 DSH 会话**用了多少 token、按官方价目估算花了多少钱。
数据写到 `~/.dsh/notch/session-cost.json`，macOS / Windows 两个客户端都读同一份。

```
DSH Web UI（会话页）
  └─ client.js：注册一个不可见组件到 conversation.input.right
       │ 拿到当前 sessionId → POST /api/notch/active-session
       ▼
Host 插件：读会话事件（assistant/message.usage + 模型 + 时间）
  ├─ 按每条消息的时间/模型计价（高峰 / 空闲半价）
  └─ 原子写 ~/.dsh/notch/session-cost.json
       ▼
DSHNotch.app / DSHNotch.exe 卡片里的「当前会话」区块
```

- **token 精确**：来自 DSH 会话日志的 `usage`
- **子智能体 / 团队成员的会话也计入**：按 `parentSession` 递归整棵会话树；
  fork/seed 会话跳过（继承事件会重复计费）
- **金额是预估**：DSH/平台都没有按会话计费的数据；按官方公开单价折算，UI 标注「以平台账单为准」
- 计价规则：`deepseek-flash` 缓存命中 0.04 / 未命中 2 / 输出 8（元/百万 tokens，高峰价）；
  空闲时段（工作日 9-12、14-18 之外，以及周末/节假日）半价；缓存写入并入未命中
- 没有 UI 上报时退回「最近活跃会话」；未收录模型只显示 token，不显示金额
- 只记录 sessionId / 标题 / token / 金额，不记录任何对话内容

配置（`cordis.patch.yml` 的 `config`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `sessionCost` | `true` | 是否记录并写快照 |
| `sessionCostFile` | `~/.dsh/notch/session-cost.json` | 快照路径 |
| `sessionCostPricing` | `{}` | 覆盖价目表（模型 → cacheHit/cacheMiss/output） |
| `sessionCostHolidays` | `[]` | 额外法定节假日（YYYY-MM-DD） |

协议与实现细节见 [docs/session-cost.md](../docs/session-cost.md)。

## DSH 通知（任务完成 / 需要你处理）

DSH 桌面端本身不发通知。插件监听会话事件，通过 `DSHNotch.app` 的本地 HTTP 桥
（`http://127.0.0.1:47810`）让它发系统通知——通知署名 **DSH Notch**，点击能切回
DeepSeek Harness，权限也只申请一次。

链路：

```
DSH Host 进程
  └─ dsh-plugin-notch-balance（本插件）
        │  POST http://127.0.0.1:47810/notify
        ▼
DSHNotch.app → macOS 通知中心
```

### 什么时候会通知

| 触发 | 通知标题 | 正文 |
|---|---|---|
| 一轮任务正常结束 | 任务完成 | `<会话名> · 用时 2 分 13 秒` |
| 一轮任务失败 | 任务失败 | 会话名、用时、错误消息 |
| 任务被阻塞 | 任务被阻塞 | 会话名、用时 |
| 达到长度上限 | 任务中断：达到长度上限 | 会话名、用时 |
| 用户中断（可选，见 `notifyAborted`） | 任务已取消 | 会话名、用时 |
| agent 请求权限 | 需要你确认 | `<toolName> 请求授权`（附理由） |
| agent 提问 | 需要你回答 | 第一个问题的题干 |

只有**根会话**的轮次会通知；子 agent / 委派产生的轮次不打扰你。
会话名取会话工作目录的 basename（例如 `default-workspace`），取不到就显示「会话」。

审批与提问的监听器只观察、始终 `return next()`，**不认领、不改变瀑布流**：
驳回、允许、委托都和没装插件时完全一样；通知失败也绝不影响审批。

### 两个开关

| 配置 | 默认 | 说明 |
|---|---|---|
| `notify` | `true` | 总开关。`false` 时**一个监听器都不注册**，行为与旧版完全一致 |
| `notifyAborted` | `false` | 是否通知「用户自己中断」的轮次。默认关：他本来就知道 |

另外还有两处独立开关，按需使用：

- macOS **系统设置 → 通知 → DSH Notch**：关闭后系统不显示，插件日志会记
  `authorization=denied`。
- DSHNotch 自己的设置里可以分别关掉「任务完成通知」和「需要处理通知」，
  关掉后桥返回 `shown:false, reason:"disabled"`。

### 端口

默认 `47810`，只绑 `127.0.0.1`。如果被占用，改 `config.bridgePort`（两边要一致，
DSHNotch 侧也有对应设置/参数）。手工验证：

```bash
# 桥是否健康、通知权限状态（authorized / denied / notDetermined ...）
curl -s 127.0.0.1:47810/health

# 直接发一条测试通知
curl -s -X POST 127.0.0.1:47810/notify \
  -H 'content-type: application/json' \
  -d '{"kind":"attention","title":"测试","body":"这是一条测试通知"}'
```

正常返回 `{"ok":true,"shown":true}`。完整协议见仓库 `docs/dsh-notifications.md`。

### 通知权限

第一次由 DSHNotch 发通知时，macOS 会弹一次「是否允许 DSH Notch 发送通知」。
如果当时点了拒绝，通知不会显示——到 **系统设置 → 通知 → DSH Notch** 打开即可，
插件日志会记录 `authorization=denied`。专注模式也会让通知静默，别误判成插件坏了。

### DSHNotch 没起来会怎样

通知仍会送达，但走的是兜底路径：插件执行一次
`osascript -e 'display notification …'`，署名变成「脚本编辑器」，点击也没有回跳行为。
日志里会看到 `HTTP 桥不可用（ECONNREFUSED: …），退回 osascript`。
想让通知好用，保证 `pgrep -x DSHNotch` 有输出、端口对得上。

### 排查清单

| 日志 / 现象 | 含义与处理 |
|---|---|
| `通知：已注册 3 个监听（桥端口 47810）` | 插件侧正常 |
| `通知桥：HTTP 200 version=1.4 authorization=authorized` | 桥和权限都正常 |
| `通知桥：暂不可达（ECONNREFUSED: …）` | DSHNotch 没起来或端口不一致；`pgrep -x DSHNotch`、核对 `bridgePort` |
| `通知已发送：… （未显示：disabled）` | DSHNotch 设置里关掉了对应的通知开关 |
| `通知已发送：… （未显示：denied）` | macOS 通知权限被拒，去系统设置打开 |
| `HTTP 桥不可用（…），退回 osascript` | 走了兜底通知（署名「脚本编辑器」、点击无行为） |
| 完全没有任何通知 | 先看日志；再查专注模式、通知中心、DSHNotch 权限 |

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: notch-balance
  name: dsh-plugin-notch-balance
  config:
    appPath: /Applications/DSHNotch.app
    quitOnUnload: false
    notify: true
    bridgePort: 47810
    notifyAborted: false
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `appPath` | `/Applications/DSHNotch.app` | 应用位置 |
| `quitOnUnload` | `false` | 插件卸载时是否同时关掉应用 |
| `notify` | `true` | 通知总开关；`false` 时不注册任何监听器 |
| `bridgePort` | `47810` | 与 DSHNotch 的本地 HTTP 桥端口 |
| `notifyAborted` | `false` | 是否通知用户自己中断的轮次 |

`quitOnUnload` 默认关掉是刻意的：**用户禁用/卸载一个插件，不该顺手杀掉他正在看的窗口。**

## 设计细节

- 用 `pgrep -x DSHNotch` 按**进程名精确匹配**，不用 `pgrep -f`
  - 踩过的坑：`-f` 匹配完整命令行，任何命令行里含有该路径的进程都会被当成
    「应用已在运行」——包括正在 grep 它、正在编辑它的 shell。实测因此误判过一次。
- 用 `open -g -a` 启动：`-g` 不抢前台，`-a` 交给 LaunchServices 走正常启动流程
- 应用不在时**安静跳过**，不报错、不刷屏
- 所有失败都被捕获，插件的任何问题都不会影响 DSH 启动、会话或审批
- 监听器一律带 `{ global: true }`：插件在 host 作用域、不拥有 agent，漏掉这个标志
  会在运行前就被过滤掉（表现是「日志正常、通知全无」）
- 审批/提问监听器只观察：`return next()` 原样透传返回值与 rejection，不认领请求
- 通知发送 2 秒超时；只有桥**不可达**才兜底 osascript，桥明确返回错误不兜底
  （避免把「设置里关掉了」误判成「桥坏了」而多弹一条）
- 日志只记 kind/标题/状态，不记通知正文——审批理由和问题里可能有敏感信息

## 卸载

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop remove dsh-plugin-notch-balance
```

然后在 profile 的 `cordis.patch.yml` 里删掉对应的 `- id: notch-balance` 覆盖项（如果加过）。

## 版本

本插件与 DSHNotch 一起发布，版本号独立。当前 `1.6.1`，配套 DSHNotch 1.6+（通知桥 / 会话花费 / 用量日历）。
`1.0.x` 只负责拉起应用，没有通知功能。
