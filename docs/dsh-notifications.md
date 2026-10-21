# DSH 通知（v1.4）

**问题**：DSH 桌面端没有任何系统通知。任务跑完、或 agent 停下来等你审批／回答时，
用户在看别的窗口就完全不知道，只能反复切回来看。

**方案**：DSH 通知由 DSHNotch 统一发。

```
DSH Host 进程（Electron 主进程）
  └─ dsh-plugin-notch-balance（本仓库 plugin/）
        │  监听会话事件
        │  POST http://127.0.0.1:47810/notify
        ▼
DSHNotch.app（本仓库 Sources/）
  ├─ 本地 HTTP 桥（Network.framework，只绑 127.0.0.1）
  ├─ UNUserNotificationCenter → macOS 通知中心
  └─ 点击通知 → 激活 DeepSeek Harness
```

为什么不直接用 `osascript display notification`：那样通知会署名为「脚本编辑器」，
点击也没有行为，且无法跟随应用设置。由 DSHNotch 发的通知署名 DSH Notch，
点击能回到 DSH，权限也只申请一次。

---

## 1. 本地 HTTP 协议

服务端：`DSHNotch.app`，绑定 `127.0.0.1:47810`（TCP，仅回环）。
请求体上限 64 KiB，读超时 5 秒。响应一律 `Content-Type: application/json`。

### `GET /health`

```json
{ "ok": true, "app": "DSHNotch", "version": "1.4",
  "authorization": "authorized" }
```

`authorization` ∈ `authorized | denied | notDetermined | provisional | ephemeral`，
取自 `UNUserNotificationCenter.getNotificationSettings`。插件用它判断
「桥在、但用户没授权通知」这类问题，并写进日志。

### `POST /notify`

请求：

```json
{
  "kind": "turn-end",
  "title": "任务完成",
  "body": "default-workspace · 用时 2 分 13 秒",
  "sessionId": "session-f4c16fe5-...",
  "dedupeKey": "turn-end:session-f4c16fe5-...:7"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `kind` | 是 | `turn-end`（任务结束）或 `attention`（需要你处理） |
| `title` | 是 | 通知标题，≤ 120 字符 |
| `body` | 是 | 通知正文，≤ 500 字符 |
| `sessionId` | 否 | 来源会话，只用于去重与日志 |
| `dedupeKey` | 否 | 相同 key 在 5 秒内只弹一次 |

响应：

- 已显示：`200 {"ok":true,"shown":true}`
- 被设置过滤：`200 {"ok":true,"shown":false,"reason":"disabled"}`
- 用户关闭了通知权限：`200 {"ok":true,"shown":false,"reason":"denied"}`
- 参数不合法：`400 {"ok":false,"error":"..."}`；未知路径 `404`；方法不对 `405`。

### 行为

- `kind: "turn-end"` 受设置 **任务完成通知** 控制；`kind: "attention"` 受
  **需要处理通知** 控制。两项默认都开。
- 通知用 `UNMutableNotificationContent`：标题、正文、默认提示音。
- 展示时（`willPresent`）用 `[.banner, .list, .sound]`，即使 DSHNotch 自己在前台也显示。
- 点击通知（或 `didReceive`）→ 激活 DeepSeek Harness：
  先按 bundle id `com.deepseek.dsh` 找运行中的实例 `activate()`；
  没在运行就 `NSWorkspace.openApplication` 打开 `/Applications/DeepSeek Harness.app`。
- 应用启动时调用一次 `requestAuthorization([.alert, .sound])`；拒绝后不再反复弹系统框。
- 桥启动失败（端口被占）只记日志，不阻塞余额功能。

### 未读红点（v1.4 build 3）

横幅只停留几秒，人不在屏幕前就会错过——这是实际使用中暴露的问题（系统日志证明
通知按 banner 正常展示过，只是没被看到）。因此 DSHNotch 额外维护一个**不会自己消失**
的未读计数：

- 投递成功（`UNUserNotificationCenter.add` 无错误）→ `UnreadStore.markUnread()`；
- 刘海形态：菜单栏图标右上角画红点（`PresenceItem.iconImage(unread:)`，template 必须关掉）；
- 菜单栏形态：金额后追加红色 `●`（`MenuBarPresenter.updateTitle`）；
- 点开卡片、点开菜单栏图标、或点开系统通知 → `UnreadStore.clear()`；
- 计数只存在内存里：应用重启后归零（通知已经弹过，系统通知中心里还有历史）。

### Windows（插件 1.2.0+）

Windows 上不需要 DSHNotch：DSH 同样是 Electron 主进程跑 Host，插件与宿主同进程，
因此通知直接从宿主发出：

| 能力 | Windows 实现 |
|---|---|
| 通知 | `import('electron')` → `new Notification({title, body})`；署名 DeepSeek Harness |
| 点击 | `notification.on('click')` → 恢复最小化 / 显示 / 聚焦 `BrowserWindow` |
| 未读 | `win.setOverlayIcon(红点)` 叠在任务栏图标上；窗口获得焦点或点通知时清除 |
| 无 Electron 时 | PowerShell 5.1 + WinRT toast（`-EncodedCommand` 传 base64 脚本，零依赖） |
| 后端选择 | `notifyBackend: auto / electron / powershell`；`auto` 先试 Electron |
| 平台过滤 | `notifyTaskDone` / `notifyAttention`（macOS 由 DSHNotch 设置页过滤） |

Windows 分支的逻辑用注入的假 `electron` 覆盖，可以在 macOS / Linux 上跑单测；
真实系统通知仍需 Windows 机器肉眼确认（CI 在 `windows-latest` 上跑同一套单测）。

> 路线图：下一步是独立的 Windows 托盘伴侣（C# WinForms，托盘显示余额 + 未读 + 右键菜单），
> 通过同一个 `127.0.0.1:47810` 协议与插件通信；届时插件优先走托盘应用，其次才是 Electron。

---

## 2. 插件侧（dsh-plugin-notch-balance）

新增配置（`cordis.patch.yml` 可覆盖）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `notify` | `true` | 总开关；false 时一个监听器都不注册 |
| `bridgePort` | `47810` | 与 DSHNotch 的本地桥端口 |
| `notifyAborted` | `false` | 用户自己中断的轮次默认不通知（他本来就知道） |

监听（全部 `global: true`，插件在 host 作用域，不拥有 agent）：

- `ctx.on('session/event', (session, event) => …)`：
  - `turn/start`：记 `sessionId → Date.now()`，用于算用时。
  - `turn/end`：**只处理根会话**（`session.header.parentSession == null`
    且 `session.header.origin !== 'subagent'`），子 agent 的轮次不通知。
    - `reason.kind === 'completed'` → `kind: "turn-end"`，标题「任务完成」，
      正文 `<会话名> · 用时 …`。
    - `reason.kind === 'error'` → 标题「任务失败」，正文带 `reason.error.message`。
    - `reason.kind === 'blocked'` → 标题「任务被阻塞」。
    - `reason.kind === 'max-tokens'` → 标题「任务中断：达到长度上限」。
    - `reason.kind === 'aborted'` → 仅当 `notifyAborted` 才通知，标题「任务已取消」。
  - 会话名取 `session.header.cwd` 的 basename；拿不到就用「会话」。
- `ctx.on('approval/request', (request, next) => …, { global: true, prepend: true })`
  → `kind: "attention"`，标题「需要你确认」，正文 `<toolName> 请求授权`
  （有 `reason`/`displayReason` 时截断附上）。**必须原样 `return next()`**，
  不认领请求；通知失败也绝不影响审批。
- `ctx.on('user-questions/request', (request, next) => …, { global: true, prepend: true })`
  → `kind: "attention"`，标题「需要你回答」，正文取第一个问题的题干（截断）。
  **必须 `return next()`**。

发送失败（DSHNotch 没起来 / 端口不通）：退回一次
`osascript -e 'display notification … with title …'`，让用户至少还能收到；
两种情况都写 `$TMPDIR/dsh-notch-plugin.log`。

去重：同 `dedupeKey` 由 DSHNotch 侧兜底（5 秒），插件侧不重复抑制。

---

## 3. 验收标准

- [x] `./build.sh` 通过；`--selftest`、`--alertcheck`、`--panelcheck`、`--clicktest`、
      `--modecheck`、`--costcheck`、`--settingscheck`、`--refreshcheck` 全绿（无回归）。
- [x] 新增 `--notifycheck`：起桥 → 自测 `GET /health`、`POST /notify`（合法/非法/
      方法错误）→ 断言状态码与 `shown`，退出码 0/1；不依赖 GUI 点击。
- [x] `curl -s 127.0.0.1:47810/health` 返回 200 且 `authorization` 字段存在。
- [x] `curl -s -X POST 127.0.0.1:47810/notify -d '{"kind":"attention","title":"测试","body":"这是一条测试通知"}'`
      返回 `shown:true`，macOS 通知中心能看到「DSH Notch」的通知。
- [x] 设置里能单独关掉「任务完成通知」「需要处理通知」；关掉后 `/notify` 返回
      `shown:false, reason:"disabled"`。
- [~] 点击通知能切回 DeepSeek Harness：代码路径已实现（activate `com.deepseek.dsh`，
      未运行则打开安装路径），点击动作需要人工确认。
- [x] `node plugin/test.mjs` 全绿（原有三态测试不能退化）。
- [x] 插件在 `notify:false` 时不注册任何监听器。
- [x] 审批/问答瀑布流不因本插件改变行为：驳回、允许、委托都照旧（集成验证里
      `next()` 的返回值原样透传）。
- [x] 未读红点：新增 `--unreadcheck`，断言计数 / 清零 / 图标里真的画出了红色像素；
      真实投递后日志出现「未读通知 +1」「未读红点 显示（N 条）」。

### 验证记录（2026-10-19）

| 项 | 证据 |
|---|---|
| 构建 | `./build.sh` exit 0，产物 `DSHNotch 1.4 (build 3)` |
| App 自检 | 12 项全部 exit 0；`--notifycheck` 15/15 ✓，`--unreadcheck` 6/6 ✓（红点红色像素 77） |
| 插件测试 | `node plugin/test.mjs` 全绿（含进程级三态：启动 / 不重复启动 / 路径不存在） |
| 桥 | `GET /health` → `{"app":"DSHNotch","authorization":"authorized","ok":true,"version":"1.4"}` |
| 真实投递 | `POST /notify` → `{"ok":true,"shown":true}`；系统日志 `Presenting ... as banner`，通知中心出现「DSH Notch」通知；dedupe、截断、413、405/404 均实测 |
| 全链路 | 用假 ctx 跑真实 `plugin/index.js`：注册 3 个监听 → 触发 turn-end / approval / question → 3 条真实 macOS 通知；`next()` 返回值 `delegated-to-desktop` 原样透传 |
| 未读红点 | 真实投递两条 → 日志「未读通知 +1 → 1 / +1 → 2」「未读红点 显示（1 条 / 2 条）」 |
| 安装 | 新构建已替换 `/Applications/DSHNotch.app` 并 ad-hoc 签名通过 |

**备注**：DSH 侧的插件已在 2026-10-19 12:14 重启后加载（日志「通知：已注册 3 个监听（桥端口 47810）」），
之后 5 次真实任务完成 / 提问通知均由系统按 banner 正常展示。本次红点改动只涉及 DSHNotch，
**不需要再重启 DSH**，重启 DSHNotch 即可。

## 4. 文件归属（并行开发时不要越界）

| 范围 | 负责人 |
|---|---|
| `Sources/*.swift`、`Resources/Info.plist` | swift-notify |
| `plugin/**` | plugin-notify |
| `docs/**`、`README*.md`、集成与安装验证 | lead |
