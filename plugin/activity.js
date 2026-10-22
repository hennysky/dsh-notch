/**
 * Token 用量日历的宿主侧数据：把会话事件按北京时间归到「天」，算出每天 token 与预估金额。
 *
 * DSH 没有「每日用量」接口，但会话日志里有完整的 assistant/message usage。这里做两件事：
 * 1. 启动时增量回填：扫描 ~/.dsh/sessions 下的会话文件，只重算 mtime 变过的会话；
 *    每个会话按自己的日志重算（替换而不是累加），避免重启后重复计费；
 * 2. 运行时实时累加：监听 session/event，把新消息记到当天。
 *
 * 产出 `~/.dsh/notch/token-activity.json` 给客户端画日历；内部缓存
 * `token-activity-cache.json` 保存每个会话每天的数字，供下次启动增量更新。
 */

import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { beijingParts, costForUsage, isDeepSeekProvider, normalizeModel } from './session-cost.js'

export const ACTIVITY_SCHEMA = 1
/** 53 周，覆盖截图里的「近 12 个月」。 */
export const CALENDAR_DAYS = 371

export function defaultActivityFile(home = homedir()) {
  return path.join(home, '.dsh', 'notch', 'token-activity.json')
}

export function defaultActivityCacheFile(home = homedir()) {
  return path.join(home, '.dsh', 'notch', 'token-activity-cache.json')
}

/** event.time → 北京时间日期（YYYY-MM-DD）。 */
export function dayKeyOf(time) {
  return beijingParts(new Date(Number.isFinite(time) ? time : Date.now())).date
}

/** 今天的北京时间日期。 */
export function todayKey(now = Date.now()) {
  return dayKeyOf(now)
}

function emptyDay() {
  return { tokens: 0, cost: 0 }
}

function addToDay(days, day, tokens, cost) {
  if (!(tokens > 0) && !(cost > 0)) return
  const bucket = days[day] ?? (days[day] = emptyDay())
  bucket.tokens += tokens
  bucket.cost += cost
}

/** usage 的总 token：优先官方 totalTokens，否则四类相加。 */
export function usageTokens(usage) {
  if (usage === null || typeof usage !== 'object') return 0
  const total = Number(usage.totalTokens)
  if (Number.isFinite(total) && total > 0) return total
  const sum =
    Number(usage.inputTokens ?? 0) +
    Number(usage.cacheReadTokens ?? 0) +
    Number(usage.cacheWriteTokens ?? 0) +
    Number(usage.outputTokens ?? 0)
  return Number.isFinite(sum) && sum > 0 ? sum : 0
}

/**
 * 把一条 assistant/message 记进 days（原地修改）。
 *
 * @returns 是否计入
 */
export function recordMessage(days, event, { pricing = {}, holidays = {} } = {}) {
  if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') return false
  const usage = event.data?.usage
  const tokens = usageTokens(usage)
  if (!(tokens > 0)) return false
  const time = Number.isFinite(Number(event.time)) ? Number(event.time) : Date.now()
  const source = event.data?.message?.source
  let cost = 0
  if (isDeepSeekProvider(source?.provider)) {
    const priced = costForUsage(
      {
        inputTokens: Number(usage.inputTokens ?? 0),
        cacheReadTokens: Number(usage.cacheReadTokens ?? 0),
        cacheWriteTokens: Number(usage.cacheWriteTokens ?? 0),
        outputTokens: Number(usage.outputTokens ?? 0),
      },
      normalizeModel(source?.model),
      time,
      { pricing, holidays },
    )
    if (priced.priced) cost = priced.cny
  }
  addToDay(days, dayKeyOf(time), tokens, cost)
  return true
}

/** 折叠一段事件（跳过 inheritedEventCount 个继承事件），返回 { day: {tokens,cost} }。 */
export function foldActivity(events, { inheritedEventCount = 0, pricing = {}, holidays = {} } = {}) {
  const days = {}
  const list = Array.isArray(events) ? events : []
  const start = Math.max(0, Number(inheritedEventCount) || 0)
  for (let index = start; index < list.length; index += 1) {
    recordMessage(days, list[index], { pricing, holidays })
  }
  return days
}

/** 扫描 ~/.dsh/sessions，返回 sessionId → { file, mtime }。 */
export async function scanSessionFiles(home = homedir()) {
  const base = path.join(home, '.dsh', 'sessions')
  const result = new Map()
  let dirs = []
  try {
    dirs = await readdir(base)
  } catch {
    return result
  }
  for (const dir of dirs) {
    const workspace = path.join(base, dir)
    let entries = []
    try {
      entries = await readdir(workspace)
    } catch {
      continue
    }
    for (const sessionId of entries) {
      const file = path.join(workspace, sessionId, 'session.v4.jsonl.zstd')
      try {
        const info = await stat(file)
        if (info.isFile()) result.set(sessionId, { file, mtime: info.mtimeMs })
      } catch {
        // 不是会话目录
      }
    }
  }
  return result
}

/** 从 cache 生成给客户端用的日历数据：最近 CALENDAR_DAYS 天，逐日补零。 */
export function buildActivitySnapshot(cache, now = Date.now(), { pricing = {}, holidays = {} } = {}) {
  const totals = new Map()
  for (const entry of Object.values(cache?.sessions ?? {})) {
    const days = entry?.days
    if (days === null || typeof days !== 'object') continue
    for (const [day, value] of Object.entries(days)) {
      if (!Number.isFinite(Number(value?.tokens)) && !Number.isFinite(Number(value?.cost))) continue
      const bucket = totals.get(day) ?? { tokens: 0, cost: 0 }
      bucket.tokens += Number(value.tokens ?? 0)
      bucket.cost += Number(value.cost ?? 0)
      totals.set(day, bucket)
    }
  }

  const days = []
  const today = new Date(now)
  for (let offset = CALENDAR_DAYS - 1; offset >= 0; offset -= 1) {
    const date = new Date(today.getTime() - offset * 24 * 60 * 60 * 1000)
    const key = beijingParts(date).date
    const value = totals.get(key) ?? { tokens: 0, cost: 0 }
    days.push({
      date: key,
      tokens: Math.max(0, Math.round(value.tokens)),
      cost: Math.max(0, Number(value.cost.toFixed(6))),
    })
  }

  return {
    schema: ACTIVITY_SCHEMA,
    updatedAt: now,
    range: { days: CALENDAR_DAYS, from: days[0]?.date ?? '', to: days[days.length - 1]?.date ?? '' },
    cost: { estimated: true, note: '按官方公开单价估算，以平台账单为准' },
    days,
  }
}

async function writeJsonAtomic(file, value) {
  const directory = path.dirname(file)
  await mkdir(directory, { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

/**
 * 增量回填 + 实时累加 + 落盘。
 *
 * 导出给单测：注入 `readSession` / `scanFiles` / `write`，不依赖真实 DSH。
 */
export class TokenActivityTracker {
  constructor(ctx, settings, {
    now = Date.now,
    log = () => {},
    readSession = null,
    scanFiles = scanSessionFiles,
    save = writeJsonAtomic,
    debounceMs = 3000,
    concurrency = 4,
  } = {}) {
    this.ctx = ctx
    this.settings = settings
    this.now = now
    this.log = log
    this.readSession = readSession
    this.scanFiles = scanFiles
    this.save = save
    this.debounceMs = debounceMs
    this.concurrency = concurrency
    this.cache = { schema: ACTIVITY_SCHEMA, updatedAt: 0, sessions: {} }
    this.timer = null
    this.disposed = false
    this.started = false
    this.backfilling = false
    /** 回填期间到达的实时事件先按会话缓存；回填结束后重读该会话，避免重复/遗漏。 */
    this.pendingLive = {}
  }

  /**
   * 回填结束后处理期间到达的实时事件：
   * - 优先重读会话（文件里通常已经包含这些事件），用「替换式重算」保证不重复；
   * - 重读失败才把缓冲的事件折叠进去（尽力而为）。
   */
  async #replayPendingLive(readOne) {
    const pending = this.pendingLive
    this.pendingLive = {}
    for (const [sessionId, events] of Object.entries(pending)) {
      if (readOne !== null) {
        try {
          const result = await readOne(sessionId)
          const list = Array.isArray(result?.events) ? result.events : []
          const inherited = Number(result?.inheritedEventCount) || 0
          const entry = this.cache.sessions[sessionId] ?? (this.cache.sessions[sessionId] = { mtime: 0, days: {} })
          entry.days = foldActivity(list, {
            inheritedEventCount: inherited,
            pricing: this.pricing,
            holidays: this.holidays,
          })
          continue
        } catch {
          // 重读失败：退回折叠缓冲事件
        }
      }
      const entry = this.cache.sessions[sessionId] ?? (this.cache.sessions[sessionId] = { mtime: 0, days: {} })
      if (entry.days === null || typeof entry.days !== 'object') entry.days = {}
      const folded = foldActivity(events, { pricing: this.pricing, holidays: this.holidays })
      for (const [day, value] of Object.entries(folded)) {
        const bucket = entry.days[day] ?? (entry.days[day] = emptyDay())
        bucket.tokens += value.tokens
        bucket.cost += value.cost
      }
    }
  }

  get pricing() {
    return this.settings.sessionCostPricing ?? {}
  }

  get holidays() {
    return this.settings.sessionCostHolidays ?? {}
  }

  async loadCache() {
    try {
      const raw = await readFile(this.settings.tokenActivityCacheFile, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && parsed.schema === ACTIVITY_SCHEMA) {
        this.cache = {
          schema: ACTIVITY_SCHEMA,
          updatedAt: Number(parsed.updatedAt) || 0,
          sessions: parsed.sessions !== null && typeof parsed.sessions === 'object' ? parsed.sessions : {},
        }
      }
    } catch {
      // 没有缓存或缓存损坏：全量回填
    }
    return this.cache
  }

  #query() {
    return this.ctx.get?.('sessionQuery')
  }

  async #resolveReader() {
    if (typeof this.readSession === 'function') return this.readSession
    const query = this.#query()
    if (query !== undefined && typeof query.readSession === 'function') {
      return (id) => query.readSession(id)
    }
    return null
  }

  async #recomputeSession(sessionId, mtime, readOne) {
    try {
      const result = await readOne(sessionId)
      const events = Array.isArray(result?.events) ? result.events : []
      const inherited = Number(result?.inheritedEventCount) || 0
      const days = foldActivity(events, { inheritedEventCount: inherited, pricing: this.pricing, holidays: this.holidays })
      this.cache.sessions[sessionId] = { mtime: Number(mtime) || 0, days }
      return true
    } catch (error) {
      // 读不出的会话先记 mtime，避免每次启动反复失败；日志留给用户排查
      this.cache.sessions[sessionId] = { mtime: Number(mtime) || 0, days: {} }
      this.log(`用量日历：读取会话 ${sessionId} 失败（${error?.message ?? error}）`)
      return false
    }
  }

  /** 启动回填：只重算新增或 mtime 变化的会话。 */
  async backfill() {
    if (this.started) return
    this.started = true
    this.backfilling = true
    await this.loadCache()
    const readOne = await this.#resolveReader()
    if (readOne === null) {
      this.log('用量日历：没有 sessionQuery.readSession，跳过历史回填')
      this.backfilling = false
      await this.#replayPendingLive(null)
      await this.persist({ immediate: true })
      return
    }
    const files = await this.scanFiles()
    const dirty = []
    for (const [sessionId, entry] of files) {
      const cached = this.cache.sessions[sessionId]
      if (cached === undefined || Number(entry.mtime) > Number(cached.mtime ?? 0)) {
        dirty.push({ sessionId, mtime: entry.mtime })
      }
    }
    this.log(`用量日历：回填 ${dirty.length} 个会话（共 ${files.size} 个）`)
    let index = 0
    const worker = async () => {
      while (index < dirty.length) {
        const current = dirty[index]
        index += 1
        if (this.disposed) return
        await this.#recomputeSession(current.sessionId, current.mtime, readOne)
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(this.concurrency, Math.max(1, dirty.length)) }, worker))
    } finally {
      this.backfilling = false
      await this.#replayPendingLive(readOne)
      this.cache.updatedAt = this.now()
      await this.persist({ immediate: true })
    }
  }

  /** 实时累加：所有会话（含子智能体）的 assistant/message 都算进当天。 */
  noteEvent(session, event) {
    if (this.disposed || event === null || typeof event !== 'object' || event.type !== 'assistant/message') return
    const sessionId = session?.header?.id ?? session?.id
    if (typeof sessionId !== 'string' || sessionId === '') return
    // 回填完成前先按事件缓存，回填结束后靠重读会话统一算，避免与「替换式重算」互相覆盖
    if (this.backfilling) {
      const events = this.pendingLive[sessionId] ?? (this.pendingLive[sessionId] = [])
      events.push(event)
      return
    }
    const delta = {}
    if (!recordMessage(delta, event, { pricing: this.pricing, holidays: this.holidays })) return
    const entry = this.cache.sessions[sessionId] ?? (this.cache.sessions[sessionId] = { mtime: 0, days: {} })
    if (entry.days === null || typeof entry.days !== 'object') entry.days = {}
    for (const [day, value] of Object.entries(delta)) {
      const target = entry.days[day] ?? (entry.days[day] = emptyDay())
      target.tokens += value.tokens
      target.cost += value.cost
    }
    this.schedule()
  }

  schedule(delay = this.debounceMs) {
    if (this.disposed) return
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.persist()
    }, delay)
  }

  /** 写内部缓存 + 客户端快照。 */
  async persist({ immediate = false } = {}) {
    if (this.backfilling) return
    if (this.disposed && !immediate) return
    try {
      // 只保留最近约 400 天，避免缓存无限增长
      const cutoff = new Date(this.now() - 400 * 24 * 60 * 60 * 1000)
      const cutoffKey = beijingParts(cutoff).date
      for (const entry of Object.values(this.cache.sessions)) {
        if (entry?.days === null || typeof entry?.days !== 'object') continue
        for (const day of Object.keys(entry.days)) if (day < cutoffKey) delete entry.days[day]
      }
      this.cache.updatedAt = this.now()
      await this.save(this.settings.tokenActivityCacheFile, this.cache)
      const snapshot = buildActivitySnapshot(this.cache, this.now(), { pricing: this.pricing, holidays: this.holidays })
      await this.save(this.settings.tokenActivityFile, snapshot)
    } catch (error) {
      this.log(`用量日历：写文件失败（${error?.message ?? error}）`)
    }
  }

  dispose() {
    this.disposed = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}
