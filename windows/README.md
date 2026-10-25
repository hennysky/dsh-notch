# DSHNotch for Windows

DSH 的 Windows 托盘伴侣应用（C# / .NET 8 WinForms）。与 macOS 的 `DSHNotch.app`
功能对等：托盘余额、今日消耗、余额提醒、本地通知桥、未读红点。

> **状态**：功能已实现，CI（`windows-latest`）负责编译、单测与发布产物。
> 开发机是 macOS、没有 Windows 实机，所以「真实 Windows 上的观感/点击行为」见文末
> [已知未验证项](#已知未验证项)。请把这一节当作验收边界，不要当成已验证。

---

## 安装（推荐：安装包）

下载 **[DSHNotch-Setup-1.2.3.exe](https://github.com/hennysky/dsh-notch/releases/download/v1.7.8/DSHNotch-Setup-1.2.3.exe)**，双击 → 下一步 → 安装。不需要解压、不需要命令行、不需要管理员：

- 装到 `%LOCALAPPDATA%\Programs\DSHNotch`（插件默认就在这个位置找 `DSHNotch.exe`）
- 可选：桌面快捷方式、开机自启
- 装完自动启动；首次启动会在开始菜单写入带 AUMID 的快捷方式（Windows toast 的前提），
  并注册 `dshnotch://open-dsh` 协议，然后显示托盘图标、每 300 秒查询一次余额

> **未签名 exe 的提示**：如果出现「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」。
> 这是没有代码签名证书导致的（不是病毒）；安装包与便携版都是同一次 CI 构建的产物。

### 便携版（不想安装）

[DSHNotch-1.2.3-portable.exe](https://github.com/hennysky/dsh-notch/releases/download/v1.7.8/DSHNotch-1.2.3-portable.exe) 是单个自包含 exe，双击即用，不需要解压/安装；
代价是不会自动创建开始菜单/桌面快捷方式（其余功能相同）。

### 双击没反应怎么办

程序是 WinExe（没有控制台窗口），托盘图标可能收在任务栏「^」里：

1. 先看任务栏右下角「^」——首次启动会弹一次气泡提示；
2. 仍没有：用 `DSHNotch.exe --diagnose` 启动（会弹窗显示版本、系统、路径与日志位置）；
3. 日志在 `%TEMP%\dsh-notch-windows.log`，发出来即可定位；
4. 启动失败会弹错误框，不会静默退出。

从源码构建/测试（需要 .NET 8 SDK，在 Windows 上）：

```powershell
dotnet build windows/DSHNotch.Windows.sln -c Release
dotnet test  windows/tests/DSHNotch.Tests/DSHNotch.Tests.csproj -c Release
dotnet publish windows/src/DSHNotch/DSHNotch.csproj -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o publish
```

CI：`.github/workflows/windows-app.yml`，push/PR 到 `windows-app`、`main` 或手动触发。

---

## 使用

| 操作 | 行为 |
|---|---|
| 左键点托盘图标 | 弹出余额卡片（打开卡片即清未读红点） |
| 右键点托盘图标 | 菜单：显示余额卡片 / 立即刷新 / 开机自启 / 打开 DeepSeek Harness / 打开设置文件 / 打开日志 / 退出 |
| 托盘 tooltip | `DSHNotch · 余额 ¥X · N 条未读通知`（无未读时省略后半段） |
| 托盘图标红点 | 收到一条真正投递出去的通知后变红点；打开卡片清零 |
| 点 toast 通知 | 通过 `dshnotch://open-dsh` 拉起本进程 `--open-dsh`，定位并激活/启动 DSH |
| 卡片标题栏「日历」 | 切换到 Token 用量日历页；日历页左上「‹ 返回」回余额页 |
| 卡片里的两个开关 | 「任务完成通知」「需要处理通知」，改动立即写入 `settings.json` |

余额卡片显示：主钱包余额、赠送余额、今日消耗（本地推算）、累计消费、更新时间；
有当前会话快照时再显示一块「当前会话」（标题+模型、输入/缓存/输出 token、`≈¥0.42（预估）`）。
查询失败时**保留旧值**，只额外显示一行红色错误小字——绝不把失败合成 `¥0.00`。

### 余额来源

读取 `%USERPROFILE%\.dsh\.credentials.yaml` 中
`deepseek-account-platform/default` 记录的 `token` 与 `issuer`（行级解析，不引 YAML 依赖），
然后请求：

```
GET {issuer}/api/v0/users/get_user_summary
x-dsh-auth-token: <token>
```

解析 `normal_wallets` / `bonus_wallets` / `total_costs`。失败不伪造数据：
HTTP 401 提示重新登录，429 提示稍后重试，其余错误原样展示。

- 后台轮询：300 秒。
- 点开卡片时补一次刷新，但 30 秒内不重复打接口（防 429）。
- 今日消耗 = 当前累计消费 − 当日基线，状态存在
  `%APPDATA%\DSHNotch\daily-cost.json`；跨天且昨天有读数时基线可信，
  否则只显示 `≥¥X` 或「统计中」。

---

## 当前会话花费（v1.1.0+，当前 1.2.3）

卡片下方的「当前会话」区块显示你正在看的这个 DSH 会话用了多少 token、按官方价目
**估算**花了多少钱。数据由 DSH 插件写入本地文件，本应用**只读、不发网络请求**：

```
%USERPROFILE%\.dsh\notch\session-cost.json
```

数据契约（schema 1、计价规则、插件侧怎么写）见仓库 `docs/session-cost.md`。

显示内容：

- 会话标题（过长截断）+ 模型；
- `输入 1,240,000 · 缓存 980,000 · 输出 83,000`（千分位）；
- `≈¥0.42（预估）`。

读取与刷新：

- 打开卡片时读一次；卡片显示期间每 30 秒重读一次（只读文件，无网络）；
- 文件不存在、JSON 损坏、schema 不认识、`updatedAt` 缺失或超过 **24 小时**未更新：
  整个区块隐藏，不报错；
- 未收录模型（插件的 `cost.priced = false`，或 JSON 里没有 `cost.cny`）：
  仍显示 token，只是不显示金额——宁可不显示，也不报错价；
- 金额是**预估**：token 来自会话日志，单价是官方公开价目（高峰/空闲不同），
  最终以平台账单为准。

想验证本机文件长什么样：

```powershell
Get-Content "$env:USERPROFILE\.dsh\notch\session-cost.json"
```

---

## Token 用量日历（v1.2.3+）

卡片标题栏的「日历」按钮切到用量日历页：53 列 × 7 行热力格（周一开头），
按天展示近 3 个月用了多少 token 或预估金额。数据同样由 DSH 插件写到本地，
本应用**只读、不发网络请求**：

```
%USERPROFILE%\.dsh\notch\token-activity.json
```

数据契约（schema 1、371 天逐日补零、计价口径、插件侧回填）见仓库 `docs/token-activity.md`。

页面内容：

- 顶部「用量 / 金额」胶囊切换：**用量是紫色系、金额是绿色系**，一眼区分口径；
- 自绘 53×7 热力格（不是几千个 Label）：颜色档位按「当天值 / 最大值」开方分 4 档，
  0 表示当天没有数据；
- 悬停色块：白框高亮，并在格下方显示「10月21日 · 124万 tokens」或「10月21日 · ≈¥0.42」；
- 下方月份标签（相邻太近时用更近的月份替换，避免重叠）；
- 底部「近 3 个月合计」（token 用 124万 / 134.6亿 这类中文单位，金额 `≈¥12.34`）。

读取与降级：

- 打开卡片时读一次；卡片显示期间每 30 秒重读本地 JSON（无网络）；
- 文件不存在、JSON 损坏、schema 不认识：显示「还没有用量数据」占位，
  并提示「跑一次对话后，插件会按天生成」；
- 插件首次启动会增量回填会话日志，可能跑几十秒——数据文件出现前显示占位即可；
- 日期按**北京时间**切天；未来格子留空；
- 金额是**预估**（与当前会话花费同一套官方价目），以平台账单为准。

想验证本机文件长什么样：

```powershell
Get-Content "$env:USERPROFILE\.dsh\notch\token-activity.json"
```

---

## 设置

`%APPDATA%\DSHNotch\settings.json`（首次保存时自动创建）：

```json
{
  "notifyTaskDone": true,
  "notifyAttention": true,
  "launchAtLogin": false,
  "lowBalanceThreshold": 10,
  "burnThreshold": 2,
  "dshExecutablePath": null
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `notifyTaskDone` | `true` | `kind=turn-end` 的通知是否投递 |
| `notifyAttention` | `true` | `kind=attention` 的通知是否投递 |
| `launchAtLogin` | `false` | 与 `HKCU\...\CurrentVersion\Run` 同步；菜单里勾选即写入 |
| `lowBalanceThreshold` | `10` | 余额低于该值提醒一次；`0` 关闭。范围 0–50 |
| `burnThreshold` | `2` | 相邻两次查询消耗超过该值提醒；`0` 关闭。范围 0–20 |
| `dshExecutablePath` | `null` | 手动指定 DSH 可执行文件；为空时自动找 |

提醒规则（与 macOS 一致）：

- 余额跌破阈值只提醒一次，回到阈值之上后重新武装，下次再跌破才提醒；
- 单次消耗超过阈值时提醒；两条同时命中时余额告急优先。

### 开机自启

写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 的 `DSHNotch` 值，
命令为 `"<exe 路径>"`，不需要管理员权限。卸载前记得在菜单里取消勾选。

### DSH 可执行文件定位

1. `settings.json` 的 `dshExecutablePath`（存在才用）；
2. 常见安装路径（`%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe`、
   `%ProgramFiles%\DeepSeek Harness\...` 等）；
3. `PATH` 里的 `DeepSeek Harness.exe`；
4. 正在运行的 `DeepSeek Harness` 进程路径。

都找不到只写日志、不弹窗；点通知不会因此崩溃。

---

## 本地通知桥（与插件配合）

监听 `127.0.0.1:47810`（TCP 回环，**不用 HttpListener**，避免 URL ACL/管理员权限）。
协议与 macOS 版完全一致，真源见仓库 `docs/dsh-notifications.md` 第 1 节。

```bash
curl -s 127.0.0.1:47810/health
# {"ok":true,"app":"DSHNotch","version":"1.2.3","authorization":"authorized","unread":0}

curl -s -X POST 127.0.0.1:47810/notify \
  -H 'content-type: application/json' \
  -d '{"kind":"attention","title":"测试","body":"这是一条测试通知"}'
# {"ok":true,"shown":true}
```

| 请求 | 响应 |
|---|---|
| `GET /health` | `{ok, app:"DSHNotch", version, authorization:"authorized", unread:N}` |
| `POST /notify` 合法 | `{ok:true,shown:true}`，未读 +1 |
| 被设置过滤 | `{ok:true,shown:false,reason:"disabled"}` |
| dedupeKey 5 秒内重复 | `{ok:true,shown:false,reason:"duplicate"}` |
| 参数不合法 | `400 {ok:false,error}` |
| 未知路径 / 方法不对 | `404` / `405` |
| 端口被占用 | 只写日志，余额功能照常 |

- `title` 超 120 字符、`body` 超 500 字符会截断后照发（不因超长丢通知）。
- 相同 `dedupeKey` 5 秒内只弹一次。
- 投递顺序：设置开关 → 授权状态 → 去重 → toast；toast 失败降级为托盘气泡。
- 端口占用/桥启动失败只影响通知，不影响余额。

**插件 1.3.0+ 在 Windows 上的后端优先级是「托盘应用 → Electron → PowerShell」**：
插件启动时会探测本桥（`/health` 返回 `app="DSHNotch"`），可达就把通知 POST 过来；
应用没在运行时会按 `windowsAppPath`（默认 `%LOCALAPPDATA%\Programs\DSHNotch\DSHNotch.exe`）
尝试拉起并轮询 1.6 秒；仍不可达才退回 DSH 宿主自己的 Electron 通知。
所以托盘应用与插件同时安装时**不会重复通知**——插件选中托盘后端后就不再走 Electron。

### 通知实现细节

- 非打包桌面应用用 WinRT `Windows.UI.Notifications` 发 toast，必须带 AUMID：
  首次运行创建开始菜单快捷方式 `DSHNotch.lnk` 并写入 `System.AppUserModel.ID = DSHNotch.Desktop`，
  同时设置进程 AUMID。
- toast 用协议激活：`activationType="protocol"`、`launch="dshnotch://open-dsh"`，
  点击后由系统拉起 `DSHNotch.exe --open-dsh`；该参数在单实例判断之前处理，只负责
  定位并激活/启动 DSH，然后退出。
- toast 投递任何异常都降级为 `NotifyIcon.ShowBalloonTip`，绝不把异常抛给桥线程或 UI 线程。
- 托盘图标与红点用 `System.Drawing` 在运行时绘制（16×16，未读时右上角红点）。

---

## 日志与排查

日志：`%TEMP%\dsh-notch-windows.log`（菜单里有「打开日志」）。

- 后台线程（桥连接、轮询、toast）的异常全部捕获并写日志，不崩托盘进程；
- UI 线程未处理异常同样只记录，应用继续运行；
- 记录内容只含状态与标题，不写凭据/token。

| 现象 | 排查 |
|---|---|
| 托盘图标不出现 | 看日志是否有致命错误；确认只有一个实例在跑（单实例 Mutex） |
| 通知不弹 | `curl /health` 看 `authorization`；看日志是否有「toast 投递失败，降级为托盘气泡」 |
| 余额显示 — | 确认 DSH 已登录（凭据文件存在）；日志里有具体错误 |
| 点击通知没反应 | 确认 `HKCU\Software\Classes\dshnotch\shell\open\command` 指向当前 exe；日志有「协议唤醒」记录 |
| 端口 47810 被占用 | 日志「通知桥端口 47810 启动失败」；关掉重复实例即可，余额不受影响 |

---

## 已知未验证项

开发机是 macOS，**没有 Windows 实机**。以下行为只有代码路径 + CI 的编译/单测/集成测试
覆盖，没有在真实 Windows 桌面上肉眼确认：

- [ ] 真实 toast 的外观、署名（应显示 DSHNotch）、点击后是否真的拉起 DSH；
- [ ] AUMID + 开始菜单快捷方式在真实用户会话里能否让 toast 稳定显示
      （CI 只验证了 `.lnk` 能创建、AUMID 属性可回读）；
- [ ] 托盘图标在真实任务栏/通知区域（含高 DPI、多显示器）的观感与红点可见性；
- [ ] 余额卡片在 100%/150%/200% 缩放下的排版；
- [ ] 开机自启在真实重启/重新登录后是否真的拉起（CI 只验证 HKCU Run 读写）；
- [ ] 真实 DSH 安装路径定位（CI 机器没有 DSH），以及点击通知后 DSH 窗口是否被激活到前台；
- [ ] 单实例 Mutex 在快速双击/开机启动竞争下的行为；
- [ ] 与 Microsoft Defender/企业策略、专注助手（Focus Assist）的交互；
- [ ] 真实平台接口的余额响应（需要用户本机登录凭据；CI 不访问外网接口）；
- [ ] 「当前会话」块在真实 DSH 会话语料上的显示效果与卡片高度（CI 只覆盖
      session-cost.json 的解析/校验/格式化与纯逻辑可见性，没有真实插件文件）；
- [ ] 插件写入过程中读文件（原子 rename 的瞬间）是否会出现一次「区块闪烁/暂时隐藏」；
- [ ] 极小金额（< ¥0.01）与超长会话标题在真实卡片里的观感；
- [ ] 用量日历页在真实 Windows 桌面上的观感：53×7 热力格、月份标签、悬停高亮/
      详情行、高 DPI 下是否清晰（CI 只覆盖网格/档位/格式化/悬停文案的纯逻辑）；
- [ ] 日历页与余额页切换时的窗口尺寸/位置跳动（代码会在切页时重新贴右下角，
      但没有实机确认多显示器/任务栏位置不同的情况）；
- [ ] 真实插件首次回填几十秒期间、以及原子 rename 瞬间读文件的占位/刷新表现。

CI 实际验证的是：两个工程在 `windows-latest` 上编译通过；xUnit 全部通过
（凭据解析、今日消耗、提醒规则、桥协议随机端口、toast XML 转义、设置读写、未读计数、
托盘图标红色像素、session-cost 解析/过期/缺字段/未收录模型/格式化/卡片可见性、
token-activity 解析/371 天补零/53×7 网格对齐/今天位置/未来格/档位/格式化/悬停文案/空数据）；
AUMID 快捷方式与 HKCU 协议/自启注册表读写；Release 单文件
self-contained 发布并打包成 artifact。

---

## 目录

```
windows/
  DSHNotch.Windows.sln
  src/DSHNotch/
    Program.cs                 入口、单实例、--open-dsh、异常兜底
    TrayApp.cs                 NotifyIcon/菜单/轮询/桥/未读红点
    BalanceCardForm.cs         余额卡片 + 用量日历页（标题栏切换）
    BalanceModel.cs            余额状态机（失败保留旧快照）
    SessionCost.cs             当前会话花费快照读取/校验/格式化（只读本地 JSON）
    TokenActivity.cs           用量日历：快照解析 + 53×7 网格/档位/格式化（纯逻辑）
    CalendarHeatmapControl.cs  自绘热力格 + 月份标签、用量/金额胶囊切换
    BalanceClient.cs           凭据 + HTTP + 响应解析
    Credentials.cs             .credentials.yaml 行级解析
    DailyCost.cs               今日消耗推算与落盘
    AlertDetector.cs           余额/消耗提醒
    RefreshPolicy.cs           30 秒刷新下限
    NotificationBridgeRouter.cs 桥协议业务逻辑（纯逻辑，可单测）
    BridgeServer.cs            TcpListener + 最小 HTTP/1.1 解析
    ToastNotifier.cs           WinRT toast + 气泡降级
    ToastXml.cs                toast XML 组装/转义
    ShortcutCreator.cs         IShellLinkW/IPropertyStore/IPersistFile + AUMID
    ProtocolRegistration.cs    dshnotch:// 协议
    StartupRegistration.cs     HKCU Run
    DshLocator.cs              DSH 定位/激活
    TrayIconFactory.cs         System.Drawing 画图标与红点
    Settings.cs                settings.json
    AppInfo.cs / AppPaths.cs / AppLog.cs / AmountFormat.cs / UnreadStore.cs
  tests/DSHNotch.Tests/        xUnit（CI 在 windows-latest 跑）
```

## 卸载

1. 托盘菜单取消「开机自启」；
2. 退出托盘应用；
3. 删除 exe 所在目录、`%APPDATA%\DSHNotch\`、`%TEMP%\dsh-notch-windows.log`；
4. 删除开始菜单快捷方式 `DSHNotch.lnk`；
5. 删除注册表项 `HKCU\Software\Classes\dshnotch`。
