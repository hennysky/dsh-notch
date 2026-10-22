# 当前会话花费（session cost）

给 DSHNotch 的卡片/托盘增加一块「当前会话」：显示你正在看的这个 DSH 会话用了多少
token、按官方价目估算花了多少钱。

## 为什么这样做

- **token 精确**：DSH 会话日志里每条 `assistant/message` 都带 `usage`
  （未缓存输入 / 缓存命中 / 缓存写入 / 输出），客户端还能读到 `tokenUsage` 投影。
- **金额只能估算**：DSH 与平台接口都没有「按会话计费」的数据；平台只有账户级
  `total_costs`。所以金额 = token × 官方公开单价，UI 必须标注「预估，以平台账单为准」。
- **当前会话要精确**：仅靠「最近有活动的会话」在切到旧会话时会错；客户端 UI 插件
  （注册在会话作用域插槽）能拿到当前 `sessionId`，用它上报最准。

## 数据链路

```
DSH Web UI（会话页）
  └─ 本插件的 client.js：注册一个不可见组件到 conversation.composer.dock
       │ 拿到 props.sessionId
       │ POST /api/notch/active-session {sessionId}
       ▼
DSH Host 进程（本插件 index.js）
  ├─ 记住 activeSessionId（没有上报时退回「最近活跃会话」）
  ├─ 用 sessionQuery.traceSession(sessionId) 递归找出所有后代会话
  │    （子智能体 / 团队成员；fork/seed 会话跳过，避免继承事件重复计费）
  ├─ 读整棵树的事件：assistant/message.usage + message.source.model + event.time
  ├─ 按每条消息的时间/模型计价（高峰 / 空闲），累加成整棵树的花费
  └─ 原子写 ~/.dsh/notch/session-cost.json
       ▼
DSHNotch.app / DSHNotch.exe
  └─ 打开卡片时读取该 JSON，显示「当前会话」区块
```

文件落在 DSH home 下，两个平台的 app 都读同一份；插件不依赖 webServer 也能工作
（没有路由时只能靠「最近活跃会话」）。

## `~/.dsh/notch/session-cost.json`

```json
{
  "schema": 1,
  "sessionId": "session-…",
  "title": "修 Windows 通知",
  "model": "deepseek-flash",
  "models": ["deepseek-flash"],
  "source": "client",
  "updatedAt": 1761200000000,
  "usage": {
    "uncachedInputTokens": 1240000,
    "cacheReadTokens": 980000,
    "cacheWriteTokens": 0,
    "outputTokens": 83000,
    "requests": 12,
    "sessions": 3,
    "subagentSessions": 2
  },
  "cost": {
    "cny": 0.42,
    "priced": true,
    "peak": true,
    "estimated": true,
    "note": "按官方公开单价估算，以平台账单为准"
  }
}
```

- `source`：`client`（UI 插件上报的当前会话）或 `recent`（最近活跃会话兜底）
- `updatedAt`：毫秒时间戳；app 超过 24h 视为过期不显示
- `usage` 是**整棵会话树**累计：根会话 + 子智能体 / 团队成员的会话
- `usage.sessions`：计入的会话数；`usage.subagentSessions`：其中子会话数
- `cost.cny` 是整棵树预估；`cost.priced`：false 表示出现了未收录模型/非 DeepSeek provider，
  此时 app 只显示 token，不显示金额

## 计价规则（与官方 2026-10 价目一致）

单位：人民币元 / 百万 tokens，以下为**高峰价**：

| 模型 | 缓存命中 | 缓存未命中 | 输出 |
|---|---|---|---|
| `deepseek-flash` | 0.04 | 2 | 8 |
| `deepseek-v4-pro` | 0.30 | 9 | 27 |

- 缓存写入并入「缓存未命中」计费（官方不单列缓存写入费）
- **空闲时段价 = 高峰价 × 0.5**：北京时间周一至周五 9:00–12:00、14:00–18:00 之外，
  以及周末、法定节假日全天
- 每条消息按它自己的 `event.time` 判断高峰/空闲，而不是按当前时间
- **子智能体 / 团队成员的花费也算在当前窗口里**：按 `parentSession` 递归整棵会话树；
  `isSeeded`（fork/seed 会话）整棵跳过，因为它们的日志包含从父会话继承的事件，重复
  计入会让费用翻倍；单次最多统计 50 个后代会话
- 模型别名：`deepseek-v4-flash*` → `deepseek-flash`
- 未收录模型：只显示 token，不显示金额（宁可不显示也不报错价）

## 插件配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `sessionCost` | `true` | 是否记录/写快照 |
| `sessionCostFile` | `~/.dsh/notch/session-cost.json` | 快照路径（一般不用改） |
| `sessionCostPricing` | `{}` | 覆盖价目表，形如 `{"deepseek-flash":{"cacheHit":0.04,"cacheMiss":2,"output":8}}` |
| `sessionCostHolidays` | `[]` | 额外节假日（YYYY-MM-DD），并入内置 2026 表 |

## 客户端上报协议（Host 路由）

`POST /api/notch/active-session`

```json
{ "sessionId": "session-…" }
```

响应 `{ "ok": true }`；sessionId 非法/不存在时 400/404。插件会立即重算并写快照。

## App 展示

- macOS 卡片：在账户余额区下面加一行「当前会话」：会话标题（截断）+ 模型、
  输入/缓存/输出 token、`≈¥0.42（预估）`，打不开/过期时整块隐藏
- Windows 卡片：同样的字段
- 不显示会话内容，只显示 sessionId / 标题 / token / 金额

## 验收

- [ ] 单测：高峰/空闲/节假日判断、缓存写入并入未命中、模型别名、未收录模型、事件 fold、快照 JSON 形状
- [ ] 单测：根 + 子智能体合并、会话计数、seeded/fork 子会话跳过、子会话未收录模型时整体不报价
- [ ] 客户端组件 `client.js` 能通过语法检查；上报只在 sessionId 变化时触发
- [ ] Host 路由：合法 POST 200 并写文件；非法 400；未知 session 404
- [ ] 写文件原子性：临时文件 + rename，不留下半截 JSON
- [ ] macOS `--render` 能渲染带「当前会话」的卡片；`--sessioncostcheck` 解析/格式化通过
- [ ] Windows 单测解析快照 + 卡片字段；CI windows-latest 绿
- [ ] 没有快照文件 / 过期 / 未收录模型时：app 不显示金额，不报错
