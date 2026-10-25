# Token 用量日历（token activity）

DSHNotch 卡片里的「用量日历」：按天展示近 3 个月消耗的 token 或预估金额（快照仍保留 371 天，客户端展示最近 13 周；
日历页会把同一张卡片放大到 380×390，余额页仍是 300×224），
支持鼠标悬停查看每天的具体数值。

## 数据从哪来

DSH 没有「每日用量」接口，但每个会话日志里都有 `assistant/message.usage`。
插件做两件事：

1. **增量回填**：启动时扫描 `~/.dsh/sessions`，只重算 mtime 变过的会话
   （`sessionQuery.readSession`）；每个会话按自己的日志重算（替换而不是累加），
   避免重启后重复计费。第一次安装/重启后可能跑几十秒，之后走缓存很快。
2. **实时累加**：监听 `session/event`，把新的 `assistant/message` 记到当天，
   所有会话（根会话、子智能体、团队成员）都算。

- 一天按**北京时间**切分；`tokens = usage.totalTokens`（没有则四类相加）
- 金额沿用会话花费的口径：每条消息按自己的时间/模型计价（高峰/空闲），
  未收录模型只累计 token、不加金额
- `isSeeded`（fork/seed）会话的自有事件才计入，继承的父会话事件不重复算
- 只记录日期 / token / 金额，不记录任何对话内容

## 落盘

- 客户端快照：`~/.dsh/notch/token-activity.json`
- 内部缓存：`~/.dsh/notch/token-activity-cache.json`（按会话保存每天的聚合，供增量回填）

```json
{
  "schema": 1,
  "updatedAt": 1792663219934,
  "range": { "days": 371, "from": "2025-10-17", "to": "2026-10-22" },
  "cost": { "estimated": true, "note": "按官方公开单价估算，以平台账单为准" },
  "days": [
    { "date": "2026-10-21", "tokens": 1240000, "cost": 0.42 }
  ]
}
```

- 固定 371 天（53 周），逐日补零；`days` 按日期升序
- app 只读本地 JSON，不联网

## 插件配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `tokenActivity` | `true` | 是否记录并写日历快照 |
| `tokenActivityFile` | `~/.dsh/notch/token-activity.json` | 快照路径 |
| `tokenActivityCacheFile` | `~/.dsh/notch/token-activity-cache.json` | 内部缓存路径 |

计价相关复用 `sessionCostPricing` / `sessionCostHolidays`。

## 客户端 UI

- 卡片标题栏新增日历按钮，点击切换到日历页；再点左上角返回
- 日历页顶部「用量 / 金额」切换：token 用紫色系，金额用绿色系
- 13 列 × 7 行热力格（周一开头，约 3 个月），月份标签在下方
- 鼠标悬停色块：白框高亮 + 色块下方固定一行显示「10月21日 · 124万 tokens / ≈¥0.42」
- 底部显示近 3 个月合计；没有数据时显示占位提示

## 验收

- [ ] 单测：按北京时间归日、token/金额累加、inherited 事件跳过、快照 371 天补零、跨会话合并
- [ ] tracker 单测：回填两个会话、按会话缓存、实时消息累加
- [ ] macOS `--calendarcheck`：13×7 网格、今天位置、未来格子为空、档位/颜色/文案
- [ ] macOS `--render-calendar` / `--render-calendar-money` 离屏渲染两种口径
- [ ] Windows 单测解析快照 + 日历网格（见 Windows README）
