/**
 * 「当前会话花费」的纯逻辑：价目表、事件折叠、快照 JSON、原子落盘。
 *
 * 为什么金额是估算：DSH 只记录 token，不记录钱；平台接口也只有账户级累计消费。
 * 所以这里按官方公开单价（高峰 / 空闲半价）把每条 assistant/message 的 usage 折算成
 * 人民币，结果供 DSHNotch 显示为「≈¥x.xx（预估）」。真源是平台账单。
 *
 * 与 docs/session-cost.md 的契约保持一致。
 */

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** 北京时间；价目表的时段判断不依赖本机时区。 */
export const TZ = 'Asia/Shanghai'
/** 高峰时段（分钟）：周一至周五 9:00–12:00、14:00–18:00。 */
const PEAK_WINDOWS = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
]

/**
 * 官方公开单价（人民币元 / 百万 tokens，高峰价），2026-10 核对。
 * 空闲时段 = 高峰价 × 0.5；缓存写入并入「缓存未命中」计费（官方不单列）。
 */
export const PEAK_PRICES = Object.freeze({
  'deepseek-flash': { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  'deepseek-v4-pro': { cacheHit: 0.3, cacheMiss: 9, output: 27 },
})

/** 旧模型名/实验名统一按 Flash 计费。 */
export const MODEL_ALIASES = Object.freeze({
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
})

/** 2026 年法定节假日（只影响「节假日不算高峰」；表里没有的年份退化为只看周末）。 */
export const BUILTIN_HOLIDAYS = Object.freeze({
  2026: Object.freeze([
    '2026-01-01', '2026-01-02', '2026-01-03',
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
    '2026-04-04', '2026-04-05', '2026-04-06',
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
    '2026-06-19', '2026-06-20', '2026-06-21',
    '2026-09-25', '2026-09-26', '2026-09-27',
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
  ]),
})

const DEEPSEEK_PROVIDERS = ['deepseek-official', 'deepseek-account']

/** 默认快照位置：DSH home 下，macOS / Windows app 都读同一份。 */
export function defaultSessionCostFile(home = homedir()) {
  return path.join(home, '.dsh', 'notch', 'session-cost.json')
}

/** 北京时间日历字段。 */
export function beijingParts(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(date)
  const get = (type) => parts.find((part) => part.type === type)?.value ?? ''
  const year = Number(get('year'))
  const month = Number(get('month'))
  const day = Number(get('day'))
  const hour = Number(get('hour'))
  const minute = Number(get('minute'))
  return {
    year,
    date: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    weekday: get('weekday'),
    minutes: hour * 60 + minute,
  }
}

/** 高峰：周一至周五、非节假日、落在两个窗口内（左闭右开）。 */
export function isPeak(parts, holidays = {}) {
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false
  const builtin = BUILTIN_HOLIDAYS[String(parts.year)] ?? []
  const extra = holidays[String(parts.year)] ?? []
  if ([...builtin, ...extra].includes(parts.date)) return false
  return PEAK_WINDOWS.some(([start, end]) => parts.minutes >= start && parts.minutes < end)
}

export function normalizeModel(model) {
  if (typeof model !== 'string' || model === '') return ''
  return MODEL_ALIASES[model] ?? model
}

export function isDeepSeekProvider(provider) {
  if (typeof provider !== 'string' || provider === '') return false
  return DEEPSEEK_PROVIDERS.includes(provider) || provider.toLowerCase().startsWith('deepseek')
}

/** 模型对应的高峰单价；未收录返回 undefined（宁可不显示金额，也不报错价）。 */
export function pricesFor(model, pricing = {}) {
  const canonical = normalizeModel(model)
  if (canonical === '') return undefined
  const merged = pricing[canonical] ?? PEAK_PRICES[canonical]
  if (merged === undefined) return undefined
  const cacheHit = Number(merged.cacheHit)
  const cacheMiss = Number(merged.cacheMiss)
  const output = Number(merged.output)
  if (![cacheHit, cacheMiss, output].every((value) => Number.isFinite(value) && value >= 0)) return undefined
  return { model: canonical, cacheHit, cacheMiss, output }
}

/**
 * 单条 usage 的计价。
 *
 * @param usage - `{ inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens }`
 * @param model - 该请求的模型 id
 * @param time - 该请求的时间（毫秒）
 * @param options.pricing - 价目覆盖表
 * @param options.holidays - 额外节假日
 * @returns `{ priced, cny?, peak, breakdown? }`；未收录模型时 priced=false
 */
export function costForUsage(usage, model, time, { pricing = {}, holidays = {} } = {}) {
  const prices = pricesFor(model, pricing)
  if (prices === undefined) return { priced: false, peak: isPeak(beijingParts(new Date(time)), holidays) }
  const peak = isPeak(beijingParts(new Date(time)), holidays)
  const factor = (peak ? 1 : 0.5) / 1e6
  // 缓存写入并入未命中输入（官方口径）
  const missInput = Number(usage?.inputTokens ?? 0) + Number(usage?.cacheWriteTokens ?? 0)
  const hitInput = Number(usage?.cacheReadTokens ?? 0)
  const output = Number(usage?.outputTokens ?? 0)
  const missCost = missInput * prices.cacheMiss * factor
  const hitCost = hitInput * prices.cacheHit * factor
  const outputCost = output * prices.output * factor
  return {
    priced: true,
    peak,
    cny: missCost + hitCost + outputCost,
    breakdown: { missInput, hitInput, output, missCost, hitCost, outputCost },
  }
}

/**
 * 把会话事件折叠成整会话用量与花费。
 *
 * 事件形状：`{ type, time, data }`；只关心
 * - `assistant/message`：`data.usage` + `data.message.source.{provider,model}`
 * - `session/title`：`data.title`
 *
 * @returns `{ title, model, models, usage, cost, requests, unpricedRequests, lastEventAt }`
 */
export function foldSessionEvents(events, { pricing = {}, holidays = {} } = {}) {
  const usage = {
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    requests: 0,
  }
  const models = []
  let title = ''
  let model = ''
  let cost = 0
  let priced = true
  let unpricedRequests = 0
  let lastEventAt = 0

  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object') continue
    const type = event.type
    const data = event.data ?? {}
    const time = Number(event.time)
    if (Number.isFinite(time) && time > lastEventAt) lastEventAt = time

    if (type === 'session/title') {
      if (typeof data.title === 'string' && data.title.trim() !== '') title = data.title.trim()
      continue
    }
    if (type !== 'assistant/message') continue

    const source = data.message?.source
    const provider = source?.provider
    const eventModel = normalizeModel(source?.model)
    if (eventModel !== '') {
      model = eventModel
      if (!models.includes(eventModel)) models.push(eventModel)
    }

    const eventUsage = data.usage
    if (eventUsage === undefined || eventUsage === null) continue
    const uncached = Number(eventUsage.inputTokens ?? 0)
    const cacheRead = Number(eventUsage.cacheReadTokens ?? 0)
    const cacheWrite = Number(eventUsage.cacheWriteTokens ?? 0)
    const output = Number(eventUsage.outputTokens ?? 0)
    if (![uncached, cacheRead, cacheWrite, output].every((value) => Number.isFinite(value) && value >= 0)) continue

    usage.uncachedInputTokens += uncached
    usage.cacheReadTokens += cacheRead
    usage.cacheWriteTokens += cacheWrite
    usage.outputTokens += output
    usage.requests += 1

    if (!isDeepSeekProvider(provider)) {
      priced = false
      unpricedRequests += 1
      continue
    }
    const result = costForUsage(
      { inputTokens: uncached, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, outputTokens: output },
      eventModel,
      Number.isFinite(time) ? time : Date.now(),
      { pricing, holidays },
    )
    if (!result.priced) {
      priced = false
      unpricedRequests += 1
      continue
    }
    cost += result.cny
  }

  return {
    title,
    model,
    models,
    usage,
    cost: { cny: cost, priced },
    unpricedRequests,
    lastEventAt,
  }
}

/**
 * 把「根会话 + 若干子智能体会话」的事件折叠成一个总量。
 *
 * - 标题/主模型取根会话
 * - token 与费用累加所有会话（子智能体的花费也算进这个窗口）
 * - 任一子会话含未收录模型 → priced=false，整块不显示金额
 *
 * @param parts - `[{ events, isRoot? }, ...]`；第一项应为根会话
 */
export function foldSessionParts(parts, options = {}) {
  const list = Array.isArray(parts) ? parts : []
  const folds = list.map((part) => foldSessionEvents(part?.events ?? [], options))
  const root = folds[0]
  const usage = {
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    requests: 0,
  }
  const models = []
  let cost = 0
  let priced = true
  let model = ''
  let lastEventAt = 0
  for (const fold of folds) {
    usage.uncachedInputTokens += fold.usage.uncachedInputTokens
    usage.cacheReadTokens += fold.usage.cacheReadTokens
    usage.cacheWriteTokens += fold.usage.cacheWriteTokens
    usage.outputTokens += fold.usage.outputTokens
    usage.requests += fold.usage.requests
    cost += fold.cost.cny
    if (!fold.cost.priced) priced = false
    for (const item of fold.models) if (!models.includes(item)) models.push(item)
    if (fold.model !== '') model = fold.model
    if (fold.lastEventAt > lastEventAt) lastEventAt = fold.lastEventAt
  }
  return {
    title: root?.title ?? '',
    model: model || root?.model || '',
    models,
    usage,
    cost: { cny: cost, priced: priced && usage.requests > 0 },
    sessions: folds.length,
    subagentSessions: Math.max(0, folds.length - 1),
    lastEventAt,
  }
}

/** 人民币展示：与 macOS/Windows 卡片一致。 */
export function formatCny(value) {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1) return value.toFixed(2)
  if (value >= 0.01) return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  const fixed = value.toFixed(4)
  return fixed === '0.0000' ? '<0.0001' : fixed
}

/**
 * 生成 `~/.dsh/notch/session-cost.json` 的内容。
 *
 * @param params.sessionId - 会话 id
 * @param params.events - 会话事件
 * @param params.source - `client`（UI 上报）或 `recent`（最近活跃兜底）
 * @param params.titleFallback - 没有 session/title 时用（一般是 cwd basename）
 * @param params.now - 生成时间（毫秒）
 */
export function buildSessionCostSnapshot({
  sessionId,
  events,
  extraSessions = [],
  source = 'recent',
  titleFallback = '',
  now = Date.now(),
  pricing = {},
  holidays = {},
}) {
  const parts = [{ events, isRoot: true }].concat(
    (Array.isArray(extraSessions) ? extraSessions : []).map((item) => ({ events: item?.events ?? [], isRoot: false })),
  )
  const folded = foldSessionParts(parts, { pricing, holidays })
  const peakNow = isPeak(beijingParts(new Date(now)), holidays)
  return {
    schema: 1,
    sessionId,
    title: folded.title || titleFallback || '',
    model: folded.model || '',
    models: folded.models,
    source,
    updatedAt: now,
    usage: {
      uncachedInputTokens: folded.usage.uncachedInputTokens,
      cacheReadTokens: folded.usage.cacheReadTokens,
      cacheWriteTokens: folded.usage.cacheWriteTokens,
      outputTokens: folded.usage.outputTokens,
      requests: folded.usage.requests,
      sessions: folded.sessions,
      subagentSessions: folded.subagentSessions,
    },
    cost: {
      cny: Number(folded.cost.cny.toFixed(6)),
      priced: folded.cost.priced && folded.usage.requests > 0,
      peak: peakNow,
      estimated: true,
      note: '按官方公开单价估算，以平台账单为准',
    },
  }
}

/** 原子写：先写临时文件再 rename，避免进程被杀时留下半截 JSON。 */
export async function writeSessionCostSnapshot(filePath, snapshot) {
  const file = filePath || defaultSessionCostFile()
  const directory = path.dirname(file)
  await mkdir(directory, { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
  return file
}
