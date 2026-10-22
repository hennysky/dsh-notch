/**
 * DSH 插件：刘海余额工具的生命周期管理 + DSH 系统通知。
 *
 * ── 为什么是「拉起一个原生应用」而不是把界面搬进 DSH ──
 *
 * 刘海覆盖层要求：窗口层级高于菜单栏、无边框、不抢焦点的 panel、
 * 排除出 Exposé 与窗口循环。这些只有原生 NSWindow 能做到；
 * Electron 的 BrowserWindow 拿不到那个层级，也不会被系统当作「刘海上的东西」。
 *
 * 所以这个插件的职责之一是**生命周期管理**：DSH 启动时确保那个原生应用在跑。
 * 界面仍然由 DSHNotch.app 负责。
 *
 * ── 通知为什么也交给 DSHNotch ──
 *
 * 直接 `osascript display notification` 的通知会署名「脚本编辑器」，点击没有行为，
 * 也不跟随应用设置。所以正常路径是：插件把会话事件 POST 给 DSHNotch 的本地 HTTP 桥
 * （127.0.0.1:<bridgePort>），由它用 UNUserNotificationCenter 发通知、处理点击回跳。
 * osascript 只在桥不可达时兜底一次，保证用户至少还能收到。
 *
 * 协议与验收标准的唯一真源：docs/dsh-notifications.md。
 *
 * ── 行为 ──
 *
 * 插件激活（= DSH 启动 / 插件被启用）时：
 *   1. 应用不存在 → 记一条日志，不做任何事（不报错，不刷屏）
 *   2. 已经在运行 → 不重复启动（否则会画出第二个刘海窗口）
 *   3. 否则 → 用 `open -g` 拉起（-g 表示不抢前台）
 *
 * notify: true（默认）时再注册三个监听：
 *   - session/event：turn/start 记开始时间，turn/end 只通知根会话；
 *   - approval/request：需要用户确认时发 attention（必须原样 `return next()`）；
 *   - user-questions/request：需要用户回答时发 attention（同样 `return next()`）。
 * notify: false 时一个监听器都不注册，行为与旧版完全一致。
 *
 * 插件卸载时：摘掉全部监听；只有显式配了 quitOnUnload: true 才收掉应用。
 * 默认 false —— 用户关掉一个插件不该顺手杀掉他正在看的窗口。
 */

import { execFile, spawn } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  buildSessionCostSnapshot,
  defaultSessionCostFile,
  writeSessionCostSnapshot,
} from './session-cost.js'
import {
  TokenActivityTracker,
  defaultActivityCacheFile,
  defaultActivityFile,
  scanSessionFiles,
} from './activity.js'

const execFileAsync = promisify(execFile)

/**
 * 进程名（可执行文件名）。用 `pgrep -x` 按**进程名精确匹配**，不要用 `-f`。
 *
 * 踩过的坑：`pgrep -f 'DSHNotch.app/Contents/MacOS/DSHNotch'` 匹配的是完整命令行，
 * 于是任何命令行里含有这个路径的进程都会被当成「应用已在运行」——包括
 * 正在 grep 它、正在编辑它的 shell。实测就因为这个误判导致插件以为应用在跑，
 * 结果根本没启动。
 */
const PROCESS_NAME = 'DSHNotch'

/** 通知协议上限（docs/dsh-notifications.md §1）。 */
const TITLE_LIMIT = 120
const BODY_LIMIT = 500

/** 与 DSHNotch 本地桥约定的默认端口。 */
export const DEFAULT_BRIDGE_PORT = 47810

/** POST /notify 的超时；桥是本机回环，2 秒足够，且不能拖住 DSH。 */
const BRIDGE_TIMEOUT_MS = 2000

export const DEFAULTS = {
  /** macOS 伴侣应用位置。可以在 cordis.patch.yml 的 config 里改。 */
  appPath: '/Applications/DSHNotch.app',
  /** 插件卸载时是否同时收掉 macOS 伴侣应用。 */
  quitOnUnload: false,
  /** 通知总开关；false 时一个监听器都不注册。 */
  notify: true,
  /** 与 DSHNotch 的本地桥端口（macOS）。 */
  bridgePort: DEFAULT_BRIDGE_PORT,
  /** 用户自己中断的轮次默认不通知（他本来就知道）。 */
  notifyAborted: false,
  /** 轮次结束通知。Windows 侧由插件过滤；macOS 由 DSHNotch 设置页控制。 */
  notifyTaskDone: true,
  /** 审批 / 提问通知。Windows 侧由插件过滤；macOS 由 DSHNotch 设置页控制。 */
  notifyAttention: true,
  /**
   * Windows 通知后端：
   * - `auto`（默认）：托盘应用（本地桥）→ Electron 原生通知 → PowerShell toast
   * - `app`：只走托盘应用（DSHNotch.exe）的本地桥
   * - `electron`：只走 Electron 原生通知
   * - `powershell`：只走 PowerShell toast（无 Electron / 无托盘应用的场景）
   */
  notifyBackend: 'auto',
  /** PowerShell 可执行文件（Windows 兜底通知用）。 */
  powershellPath: 'powershell.exe',
  /** 是否记录「当前会话花费」并写快照（docs/session-cost.md）。 */
  sessionCost: true,
  /** 快照路径；留空 = ~/.dsh/notch/session-cost.json。 */
  sessionCostFile: '',
  /** 覆盖价目表，形如 { 'deepseek-flash': { cacheHit: 0.04, cacheMiss: 2, output: 8 } }。 */
  sessionCostPricing: {},
  /** 额外节假日（YYYY-MM-DD 数组），并入内置 2026 表。 */
  sessionCostHolidays: [],
  /** 是否记录 Token 用量日历（按天聚合 token / 预估金额）。 */
  tokenActivity: true,
  /** 日历快照路径；留空 = ~/.dsh/notch/token-activity.json。 */
  tokenActivityFile: '',
  /** 日历内部缓存路径；留空 = ~/.dsh/notch/token-activity-cache.json。 */
  tokenActivityCacheFile: '',
  /**
   * Windows 托盘应用路径（DSHNotch.exe）。留空则自动探测
   * `%LOCALAPPDATA%\Programs\DSHNotch\DSHNotch.exe`。
   */
  windowsAppPath: '',
}

/** 根会话的标题/正文模板。未列出的 reason.kind 一律不通知。 */
const TURN_END_TITLES = Object.freeze({
  completed: '任务完成',
  error: '任务失败',
  blocked: '任务被阻塞',
  'max-tokens': '任务中断：达到长度上限',
  aborted: '任务已取消',
})

/**
 * 诊断日志。
 *
 * 打包后的 Harness 是 GUI 应用，插件的 console 输出不一定有人看得到，
 * 所以同时写一份到临时目录，便于排查「插件到底有没有跑」。
 * 只记插件自己的行为，不记余额、凭据或通知正文（审批/提问正文可能有敏感信息）。
 */
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`
  console.log(`[notch-balance] ${message}`)
  try {
    appendFileSync(path.join(tmpdir(), 'dsh-notch-plugin.log'), line + '\n')
  } catch {
    // 写不了日志不影响主流程
  }
}

async function isRunning() {
  try {
    await execFileAsync('/usr/bin/pgrep', ['-x', PROCESS_NAME])
    return true
  } catch {
    // pgrep 找不到时退出码非 0，这是正常情况
    return false
  }
}

async function launch(appPath) {
  // -g：不要抢到前台。工具本身是 accessory，但这样更稳。
  // -a：按应用包路径启动，交给 LaunchServices 走正常启动流程。
  await execFileAsync('/usr/bin/open', ['-g', '-a', appPath])
}

// ─────────────────────────────────────────────────────────────
// 可测试的纯函数：文案组装
// ─────────────────────────────────────────────────────────────

/** 把任意字段收敛成单行文本；非字符串返回空串。 */
function singleLine(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim()
}

/** 按字符（码点）截断，超出时以省略号结尾，保证长度 ≤ limit。 */
function truncateText(value, limit) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const characters = Array.from(text)
  if (characters.length <= limit) return text
  if (limit <= 0) return ''
  return characters.slice(0, limit - 1).join('') + '…'
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = singleLine(value)
    if (text !== '') return text
  }
  return undefined
}

function describeError(error) {
  if (error === undefined || error === null) return '未知错误'
  const code = typeof error.code === 'string' ? `${error.code}: ` : ''
  const message = typeof error.message === 'string' ? error.message : String(error)
  return `${code}${message}`
}

/** 会话名取 `session.header.cwd` 的 basename；拿不到就用「会话」。 */
export function sessionName(session) {
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && cwd !== '') {
    const base = path.basename(cwd)
    if (base !== '' && base !== '.' && base !== path.sep) return base
  }
  return '会话'
}

/** 根会话判定：没有父会话、也不是 subagent 派生的会话。 */
export function isRootSession(session) {
  const header = session?.header
  return header?.parentSession == null && header?.origin !== 'subagent'
}

function sessionIdOfSession(session) {
  const id = session?.header?.id ?? session?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

function sessionIdOfRequest(request) {
  const id = request?.agent?.session?.header?.id ?? request?.agent?.session?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** 用时文案：`42 秒` / `2 分 13 秒`。 */
export function formatDuration(milliseconds) {
  // 向下取整：还没到 60 秒就不显示「60 秒」，也避免把 42.9 秒说成 43 秒。
  const seconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes} 分 ${rest} 秒`
}

/** 从 `reason.error`（LlmFailure | string）里取一句人类可读的消息。 */
function errorMessageOf(reason) {
  const error = reason?.error
  if (typeof error === 'string') return singleLine(error)
  if (error !== null && typeof error === 'object') {
    return firstNonEmptyString(error.message, error.reason, error.code) ?? ''
  }
  return ''
}

/**
 * 组装 turn/end 的通知载荷。
 *
 * @param session - DSH Session（读取 `.header`）。
 * @param event - `{ type: 'turn/end', data: { turn, reason } }`。
 * @param options.startedAt - turn/start 记下的 `Date.now()`；缺省则正文不带用时。
 * @param options.now - 当前时间（测试可注入）。
 * @param options.notifyAborted - aborted 轮次是否通知，默认 false。
 * @returns 通知载荷；不需要通知时返回 `null`。
 */
export function buildTurnEndNotification(session, event, options = {}) {
  const { startedAt, now = Date.now(), notifyAborted = false } = options
  const reason = event?.data?.reason
  const kind = typeof reason?.kind === 'string' ? reason.kind : undefined
  const title = kind === undefined ? undefined : TURN_END_TITLES[kind]
  if (title === undefined) return null
  // 用户自己按了停止，他本来就知道，默认不打扰。
  if (kind === 'aborted' && notifyAborted !== true) return null

  const parts = [sessionName(session)]
  if (Number.isFinite(startedAt)) {
    parts.push(`用时 ${formatDuration(Math.max(0, now - startedAt))}`)
  }
  if (kind === 'error') {
    const message = errorMessageOf(reason)
    if (message !== '') parts.push(truncateText(message, 300))
  }

  const sessionId = sessionIdOfSession(session)
  const turn = event?.data?.turn
  const payload = { kind: 'turn-end', title, body: parts.join(' · ') }
  if (sessionId !== undefined) {
    payload.sessionId = sessionId
    payload.dedupeKey = `turn-end:${sessionId}:${turn ?? ''}`
  }
  return payload
}

/** 审批提示的补充理由：优先 displayReason（对象，按 zh → en 取），其次 reason。 */
function approvalReasonText(request) {
  const display = request?.displayReason
  if (typeof display === 'string') return singleLine(display)
  if (display !== null && typeof display === 'object') {
    const localized =
      firstNonEmptyString(display.zh, display['zh-CN'], display['zh-Hans'], display.en) ??
      Object.values(display).find((value) => typeof value === 'string' && value.trim() !== '')
    if (typeof localized === 'string') return singleLine(localized)
  }
  return firstNonEmptyString(request?.reason) ?? ''
}

/**
 * 组装 approval/request 的通知载荷：kind=attention，标题「需要你确认」。
 * 正文是 `<toolName> 请求授权`，有 reason/displayReason 时截断附上。
 */
export function buildApprovalNotification(request) {
  const toolName = firstNonEmptyString(request?.toolName) ?? '工具'
  const reason = approvalReasonText(request)
  let body = `${toolName} 请求授权`
  if (reason !== '') body += `：${truncateText(reason, 240)}`

  const sessionId = sessionIdOfRequest(request)
  const callId = typeof request?.callId === 'string' ? request.callId : undefined
  const payload = { kind: 'attention', title: '需要你确认', body }
  if (sessionId !== undefined) payload.sessionId = sessionId
  payload.dedupeKey = `attention:approval:${sessionId ?? 'unknown'}:${callId ?? toolName}`
  return payload
}

/**
 * 组装 user-questions/request 的通知载荷：标题「需要你回答」，
 * 正文取第一个问题的题干（没有题干时退回 header）。
 */
export function buildQuestionNotification(request) {
  const questions = Array.isArray(request?.questions) ? request.questions : []
  const first = questions[0]
  const question =
    firstNonEmptyString(first?.question, first?.header) ?? '（问题内容为空）'

  const sessionId = sessionIdOfRequest(request)
  const questionId = first?.id === undefined ? '' : String(first.id)
  const payload = { kind: 'attention', title: '需要你回答', body: question }
  if (sessionId !== undefined) payload.sessionId = sessionId
  payload.dedupeKey = `attention:question:${sessionId ?? 'unknown'}:${questionId}`
  return payload
}

/** 把通知载荷收成协议允许的线上格式；不合法时返回 null。 */
export function toWirePayload(notification) {
  if (notification === null || typeof notification !== 'object') return null
  const kind = notification.kind
  if (kind !== 'turn-end' && kind !== 'attention') return null
  const title = truncateText(singleLine(notification.title), TITLE_LIMIT)
  const body = truncateText(singleLine(notification.body), BODY_LIMIT)
  if (title === '' || body === '') return null

  const payload = { kind, title, body }
  const sessionId = singleLine(notification.sessionId)
  if (sessionId !== '') payload.sessionId = sessionId
  const dedupeKey = singleLine(notification.dedupeKey)
  if (dedupeKey !== '') payload.dedupeKey = dedupeKey
  return payload
}

// ─────────────────────────────────────────────────────────────
// 可测试的发送层：HTTP 桥 + osascript 兜底
// ─────────────────────────────────────────────────────────────

/** AppleScript 字符串字面量转义（反斜杠先转，避免二次转义）。 */
export function escapeAppleScript(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/\t/g, '\\t')
}

/** 兜底用的 AppleScript 命令（由 execFile 直接执行，不经 shell）。 */
export function buildAppleScriptNotification(notification) {
  const title = escapeAppleScript(notification?.title ?? '')
  const body = escapeAppleScript(notification?.body ?? '')
  return `display notification "${body}" with title "${title}"`
}

/**
 * 通知发送器：先走 DSHNotch 的本地 HTTP 桥；桥不可达时退回一次 osascript。
 *
 * 永远不向调用方抛异常——通知失败绝不能影响 DSH 的会话或审批流程。
 */
export class NotifyBridge {
  /**
   * @param options.port - 桥端口。
   * @param options.timeoutMs - 单次 HTTP 超时（默认 2 秒）。
   * @param options.log - 日志函数（默认丢弃；测试可注入）。
   * @param options.execFile - 执行 osascript 的函数（默认 promisify(execFile)；测试可注入）。
   */
  constructor({ port = DEFAULT_BRIDGE_PORT, timeoutMs = BRIDGE_TIMEOUT_MS, log: logger = () => {}, execFile: run = execFileAsync } = {}) {
    this.port = port
    this.timeoutMs = timeoutMs
    this.log = logger
    this.execFile = run
  }

  /** `http://127.0.0.1:<port>/notify`，排查时直接复制去 curl。 */
  get endpoint() {
    return `http://127.0.0.1:${this.port}/notify`
  }

  /**
   * 发送一条通知。
   *
   * @returns `true` 表示桥接受了请求（`shown:false` 也算接受，只是被设置过滤）；
   *          `false` 表示桥拒绝或不可达（不可达时已尝试 osascript 兜底）。
   */
  async send(notification) {
    const payload = toWirePayload(notification)
    if (payload === null) {
      this.log('通知：载荷不合法，已丢弃')
      return false
    }

    try {
      const response = await this.#request('POST', '/notify', payload)
      if (response.statusCode >= 200 && response.statusCode < 300) {
        // shown=false 是正常的「被设置过滤 / 没授权」，不是错误，别再弹 osascript。
        const shown = response.json?.shown
        const reason = response.json?.reason
        const suffix = shown === false ? `（未显示：${reason ?? 'unknown'}）` : ''
        this.log(`通知已发送：${payload.kind}「${payload.title}」${suffix}`)
        return true
      }
      this.log(`通知：DSHNotch 拒绝了请求（HTTP ${response.statusCode}），不兜底`)
      return false
    } catch (error) {
      this.log(`通知：HTTP 桥不可用（${describeError(error)}），退回 osascript`)
      await this.#osascript(payload)
      return false
    }
  }

  /**
   * 探测桥与通知权限，只写日志（docs §1：插件用它判断「桥在、但没授权」）。
   * 永不影响主流程。
   */
  async health() {
    try {
      const response = await this.#request('GET', '/health')
      const json = response.json
      const authorization = json?.authorization
      this.log(
        `通知桥：HTTP ${response.statusCode} version=${json?.version ?? '?'} authorization=${authorization ?? '?'}`,
      )
      if (authorization === 'denied') {
        this.log('通知桥：用户未授权通知（到「系统设置 → 通知 → DSH Notch」打开）')
      } else if (authorization === 'notDetermined') {
        this.log('通知桥：通知权限尚未申请，DSHNotch 首次发通知时会弹系统授权框')
      }
      return json ?? null
    } catch (error) {
      this.log(`通知桥：暂不可达（${describeError(error)}），发送时会退回 osascript`)
      return null
    }
  }

  /** 发一个请求（POST /notify 或 GET /health），解析 JSON 响应。 */
  #request(method, requestPath, body) {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (fn, value) => {
        if (settled) return
        settled = true
        fn(value)
      }
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: this.port,
          path: requestPath,
          method,
          // 不复用 socket：通知是低频事件，避免在 DSH 主进程里留一个 keep-alive 池。
          agent: false,
          headers: {
            accept: 'application/json',
            ...(encoded === undefined
              ? {}
              : {
                  'content-type': 'application/json; charset=utf-8',
                  'content-length': String(encoded.length),
                }),
          },
        },
        (res) => {
          let text = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => {
            text += chunk
            // 响应体只可能是几十字节；异常大的响应直接断开，别把主进程内存吃掉。
            if (text.length > 64 * 1024) req.destroy(new Error('响应体过大'))
          })
          res.on('error', (error) => settle(reject, error))
          res.on('end', () => {
            let json
            try {
              json = text === '' ? undefined : JSON.parse(text)
            } catch {
              json = undefined
            }
            settle(resolve, { statusCode: res.statusCode ?? 0, json, text })
          })
        },
      )
      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new Error(`超时（${this.timeoutMs} ms）`))
      })
      req.on('error', (error) => settle(reject, error))
      if (encoded !== undefined) req.write(encoded)
      req.end()
    })
  }

  /** 桥不可达时的唯一一次兜底。 */
  async #osascript(payload) {
    const script = buildAppleScriptNotification(payload)
    try {
      await this.execFile('/usr/bin/osascript', ['-e', script], { timeout: 5000 })
      this.log('通知：osascript 兜底已执行')
    } catch (error) {
      this.log(`通知：osascript 兜底也失败（${describeError(error)}）`)
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Windows：Electron 原生通知 + PowerShell toast 兜底
// ─────────────────────────────────────────────────────────────
//
// Windows 上 DSH 同样是 Electron 主进程跑 Host，插件和宿主在同一个进程里。
// 所以**不需要再写一个原生伴侣应用**：直接 import('electron') 用它的
// Notification API，通知就署名 DeepSeek Harness、点击能聚焦窗口；
// 「未读不会消失」用任务栏图标上的 overlay badge（红点）实现。
//
// 唯一的不确定点是 DSH 的插件加载器允不允许 import('electron')。
// 因此 auto 模式先试 Electron，失败再退回 PowerShell 5.1 的 WinRT toast
// （Win10/11 自带，零依赖；署名是 Windows PowerShell，点击无行为）。

/** 16×16 红点（任务栏 overlay badge）。红色 #E53E3E，带抗锯齿边缘。 */
export const UNREAD_BADGE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAS0lEQVR42mNgGLTgqZ2dDxBXQrEPqRpvAvF/NHyToEFQzf8JYB98BtwkwoCblNiO2xXQwCLWgEqaGECZFygORKpEI8UJiSpJme4AANT++XHHVJEfAAAAAElFTkSuQmCC'

/** XML 文本转义（toast 模板会原样解析这些字符）。 */
export function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      case "'": return '&apos;'
      default: return character
    }
  })
}

/** 生成 ToastGeneric 的 toast XML。 */
export function buildToastXml({ title, body }) {
  return (
    '<toast activationType="foreground" scenario="default">'
    + '<visual><binding template="ToastGeneric">'
    + `<text>${escapeXml(title)}</text>`
    + `<text>${escapeXml(body)}</text>`
    + '</binding></visual><audio silent="false"/></toast>'
  )
}

/**
 * 生成 PowerShell toast 脚本。
 *
 * XML 以 base64 内嵌，避免标题/正文里的引号、`'@` 之类破坏 here-string；
 * 主题内容不进命令行，也不担心控制台编码。
 */
export function buildPowerShellToastScript(payload) {
  const encoded = Buffer.from(buildToastXml(payload), 'utf8').toString('base64')
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    `$xmlText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$doc.LoadXml($xmlText)',
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier().Show($toast)',
  ].join('\n')
}

/** PowerShell `-EncodedCommand`：UTF-16LE + base64，绕过所有引号问题。 */
export function encodePowerShellCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64')
}

/** `powershell.exe` 的参数（不含可执行文件本身）。 */
export function buildPowerShellArgs(script) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encodePowerShellCommand(script)]
}

/**
 * 纯 PowerShell toast 发送器（Electron 不可用时）。
 *
 * 永远不抛：通知失败不能影响 DSH 的会话或审批流程。
 */
export class PowerShellToastNotifier {
  constructor({ execFile: run = execFileAsync, log: logger = () => {}, powershellPath = DEFAULTS.powershellPath } = {}) {
    this.execFile = run
    this.log = logger
    this.powershellPath = powershellPath
  }

  async send(payload) {
    try {
      await this.execFile(this.powershellPath, buildPowerShellArgs(buildPowerShellToastScript(payload)), {
        windowsHide: true,
        timeout: 5000,
      })
      this.log(`通知：PowerShell toast 已发送「${payload.title}」`)
      return true
    } catch (error) {
      this.log(`通知：PowerShell toast 失败（${describeError(error)}）`)
      return false
    }
  }

  async health() {
    return { backend: 'powershell', supported: true }
  }
}

/**
 * Electron 原生通知发送器。
 *
 * - 通知署名 DeepSeek Harness（宿主自己的 app identity）
 * - 点击通知 → 恢复/聚焦 DSH 窗口
 * - 有未读时在任务栏图标上叠加红点；窗口获得焦点（或点通知）时清除
 *
 * `electron` 由调用方注入，测试可以用假对象直接验证行为。
 */
export class ElectronNotifier {
  constructor({ electron, log: logger = () => {}, badgeDataUrl = UNREAD_BADGE_PNG } = {}) {
    this.electron = electron ?? {}
    this.log = logger
    this.badgeDataUrl = badgeDataUrl
    this.unread = 0
    this.windows = new Set()
    this.bound = false
  }

  async health() {
    let supported = false
    try {
      const notification = this.electron.Notification
      supported = typeof notification?.isSupported === 'function'
        ? notification.isSupported() === true
        : typeof notification === 'function'
    } catch {
      supported = false
    }
    if (!supported) this.log('通知：Electron Notification 不可用')
    return { backend: 'electron', supported }
  }

  /** 订阅窗口事件：新窗口也要能叠 badge，窗口聚焦时清未读。 */
  bind() {
    if (this.bound) return
    this.bound = true
    const { app, BrowserWindow } = this.electron
    app?.on?.('browser-window-created', (_event, window) => this.watch(window))
    app?.on?.('browser-window-focus', () => this.clearUnread())
    for (const window of BrowserWindow?.getAllWindows?.() ?? []) this.watch(window)
  }

  watch(window) {
    if (window === null || window === undefined || this.windows.has(window)) return
    this.windows.add(window)
    window.on?.('closed', () => {
      this.windows.delete(window)
      this.applyOverlay()
    })
  }

  #badgeImage() {
    try {
      return this.electron.nativeImage?.createFromDataURL?.(this.badgeDataUrl) ?? null
    } catch {
      return null
    }
  }

  applyOverlay() {
    const image = this.unread > 0 ? this.#badgeImage() : null
    const description = this.unread > 0 ? `${this.unread} 条未读通知` : ''
    for (const window of this.windows) {
      try {
        window.setOverlayIcon?.(image, description)
      } catch (error) {
        this.log(`通知：设置任务栏徽标失败（${describeError(error)}）`)
      }
    }
  }

  markUnread() {
    this.unread += 1
    this.applyOverlay()
    this.log(`通知：未读 +1 → ${this.unread}（任务栏红点）`)
  }

  clearUnread() {
    if (this.unread === 0) return
    this.unread = 0
    this.applyOverlay()
    this.log('通知：未读已清零（任务栏红点移除）')
  }

  /** 从通知或托盘回到 DSH：恢复最小化、显示并聚焦主窗口。 */
  focusDsh() {
    const { BrowserWindow } = this.electron
    let window = null
    try {
      window = BrowserWindow?.getFocusedWindow?.() ?? BrowserWindow?.getAllWindows?.()[0] ?? null
    } catch {
      window = null
    }
    if (window !== null) {
      try {
        if (typeof window.isMinimized === 'function' && window.isMinimized()) window.restore?.()
        window.show?.()
        window.focus?.()
      } catch (error) {
        this.log(`通知：聚焦 DSH 窗口失败（${describeError(error)}）`)
      }
    }
    this.clearUnread()
  }

  async send(payload) {
    try {
      const { Notification, BrowserWindow } = this.electron
      if (typeof Notification !== 'function') throw new Error('Electron Notification 不可用')
      if (typeof Notification.isSupported === 'function' && !Notification.isSupported()) {
        throw new Error('系统不支持 Electron 通知')
      }
      const notification = new Notification({
        title: payload.title,
        body: payload.body,
        silent: false,
      })
      notification.on?.('click', () => this.focusDsh())
      notification.show()
      let focused = null
      try {
        focused = BrowserWindow?.getFocusedWindow?.() ?? null
      } catch {
        focused = null
      }
      // 用户正看着 DSH：弹通知但不留红点，免得打扰
      if (focused === null) this.markUnread()
      this.log(`通知：Windows 原生通知已发送「${payload.title}」`)
      return true
    } catch (error) {
      this.log(`通知：Windows 原生通知发送失败（${describeError(error)}）`)
      return false
    }
  }
}

/** 按设置过滤通知类型（Windows 侧；macOS 由 DSHNotch 设置页过滤）。 */
export function allowsPayload(settings, payload) {
  if (payload?.kind === 'turn-end' && settings.notifyTaskDone === false) return false
  if (payload?.kind === 'attention' && settings.notifyAttention === false) return false
  return true
}

/** Windows 托盘应用的默认安装位置（DSHNotch.exe）。没有 LOCALAPPDATA 时返回空串。 */
export function defaultWindowsAppPath(env = process.env, pathModule = path) {
  const local = env.LOCALAPPDATA
  if (typeof local !== 'string' || local === '') return ''
  return pathModule.join(local, 'Programs', 'DSHNotch', 'DSHNotch.exe')
}

/** 启动托盘应用：detached，不占住 DSH 的进程。 */
function defaultSpawn(command, args, options) {
  const child = spawn(command, args, options)
  child?.unref?.()
  return child
}

const waitMilliseconds = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 探测/拉起 Windows 托盘应用。
 *
 * 优先复用已在运行的托盘应用（本地桥 `/health` 返回 app=DSHNotch）；
 * 不在运行时尝试拉起 `windowsAppPath`，并在 1.6 秒内轮询桥。
 * 任何失败都只返回 null，让调用方继续降级。
 */
async function connectTrayApp({
  settings,
  logger,
  spawn: spawnApp,
  wait,
  bridgeFactory,
}) {
  const bridge = bridgeFactory(settings.bridgePort, logger)
  let health = await bridge.health()
  if (health?.app === 'DSHNotch') {
    logger('通知：Windows 后端 = DSHNotch 托盘应用（本地桥）')
    return { bridge }
  }

  const appPath = settings.windowsAppPath
  if (appPath === '') return null
  if (!existsSync(appPath)) {
    logger(`通知：Windows 托盘应用不存在（${appPath}），跳过托盘后端`)
    return null
  }

  try {
    spawnApp(appPath, [], { detached: true, stdio: 'ignore' })
    logger(`通知：已拉起 Windows 托盘应用：${appPath}`)
  } catch (error) {
    logger(`通知：启动 Windows 托盘应用失败（${describeError(error)}）`)
    return null
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await wait(400)
    health = await bridge.health()
    if (health?.app === 'DSHNotch') {
      logger('通知：Windows 后端 = DSHNotch 托盘应用（启动后可达）')
      return { bridge }
    }
  }
  logger('通知：Windows 托盘应用已启动，但本地桥仍不可达')
  return null
}

/**
 * 创建 Windows 通知发送器。
 *
 * 后端优先级（`auto`）：托盘应用（本地桥，和 macOS 同一协议）→ Electron 原生通知 →
 * PowerShell toast。异步选择后端，但对外只暴露 `send` / `health`：
 * 选择完成前的通知会排队等它，不会丢。
 */
export function createWindowsSender({
  settings,
  log: logger = log,
  importModule = (specifier) => import(specifier),
  execFile: run = execFileAsync,
  spawn: spawnApp = defaultSpawn,
  wait = waitMilliseconds,
  bridgeFactory = (port, logFn) => new NotifyBridge({ port, log: logFn }),
} = {}) {
  const ready = (async () => {
    const backend = settings.notifyBackend

    if (backend === 'auto' || backend === 'app') {
      const tray = await connectTrayApp({ settings, logger, spawn: spawnApp, wait, bridgeFactory })
      if (tray !== null) {
        return {
          backend: 'app',
          async send(payload) {
            return tray.bridge.send(payload)
          },
          async health() {
            const health = await tray.bridge.health()
            return { backend: 'app', supported: health?.app === 'DSHNotch', app: health }
          },
        }
      }
      if (backend === 'app') {
        logger('通知：托盘后端不可用，退回 PowerShell toast')
      }
    }

    if (backend === 'auto' || backend === 'electron') {
      try {
        const imported = await importModule('electron')
        // Electron 以 CommonJS 内置模块暴露；不同 Electron/Node 版本下
        // 动态 import 的命名导出形态可能不同，合并成普通对象最稳。
        const electron =
          imported?.default !== undefined ? { ...imported.default, ...imported } : imported
        const notifier = new ElectronNotifier({ electron, log: logger })
        const health = await notifier.health()
        if (health.supported) {
          notifier.bind()
          logger('通知：Windows 后端 = Electron 原生通知（署名 DeepSeek Harness）')
          return notifier
        }
        logger('通知：Electron Notification 不可用，退回 PowerShell toast')
      } catch (error) {
        logger(`通知：在宿主里拿不到 electron（${describeError(error)}），退回 PowerShell toast`)
      }
    }

    logger('通知：Windows 后端 = PowerShell toast（署名 Windows PowerShell）')
    return new PowerShellToastNotifier({ execFile: run, log: logger, powershellPath: settings.powershellPath })
  })()

  return {
    backend: 'windows',
    async send(payload) {
      if (!allowsPayload(settings, payload)) {
        logger(`通知：按设置跳过 ${payload?.kind ?? '未知类型'}（Windows 侧过滤）`)
        return false
      }
      const notifier = await ready.catch(() => null)
      if (notifier === null) return false
      return notifier.send(payload)
    },
    async health() {
      const notifier = await ready.catch(() => null)
      return notifier === null ? null : notifier.health()
    },
  }
}

// ─────────────────────────────────────────────────────────────
// 事件 → 通知：纯监听器工厂（便于测试，不直接依赖 ctx）
// ─────────────────────────────────────────────────────────────

/**
 * 创建三个监听器。`apply()` 只负责把它们注册到 `ctx`；这里不碰 ctx，
 * 所以测试可以直接调用，不需要假 DSH。
 *
 * @param options.bridge - `{ send(payload) }`，通常是 NotifyBridge。
 * @param options.notifyAborted - aborted 轮次是否通知。
 * @param options.now - 时钟（测试可注入）。
 * @param options.log - 日志函数。
 */
export function createNotificationRuntime({
  bridge,
  notifyAborted = false,
  now = Date.now,
  log: logger = () => {},
} = {}) {
  if (bridge === undefined || typeof bridge.send !== 'function') {
    throw new TypeError('createNotificationRuntime 需要 bridge.send(payload)')
  }

  /** sessionId → turn/start 的时间戳。 */
  const turnStartedAt = new Map()

  const dispatch = (payload) => {
    if (payload === null || payload === undefined) return
    try {
      const pending = bridge.send(payload)
      // send() 自身保证不抛；这里再兜一层，防止替换实现时留下未处理 rejection。
      if (pending !== null && typeof pending?.catch === 'function') {
        pending.catch((error) => logger(`通知：发送异常（${describeError(error)}）`))
      }
    } catch (error) {
      logger(`通知：发送异常（${describeError(error)}）`)
    }
  }

  /** `ctx.on('session/event', …)` 的监听器。 */
  const onSessionEvent = (session, event) => {
    try {
      const type = event?.type
      const sessionId = sessionIdOfSession(session)

      if (type === 'turn/start') {
        if (sessionId !== undefined) turnStartedAt.set(sessionId, now())
        return
      }
      if (type !== 'turn/end') return

      let startedAt
      if (sessionId !== undefined) {
        startedAt = turnStartedAt.get(sessionId)
        turnStartedAt.delete(sessionId)
      }

      // 子 agent 的轮次不通知；只处理根会话。
      if (!isRootSession(session)) return

      dispatch(
        buildTurnEndNotification(session, event, {
          startedAt,
          now: now(),
          notifyAborted,
        }),
      )
    } catch (error) {
      logger(`通知：处理 session/event 失败（${describeError(error)}）`)
    }
  }

  /**
   * `ctx.on('approval/request', …)` 的监听器。
   *
   * 只观察、绝不认领：原样 `return next()`。通知（含组装/发送）的任何异常
   * 都被吞掉，瀑布流的返回值、错误与时机都不因本插件而改变。
   */
  const onApprovalRequest = (request, next) => {
    try {
      dispatch(buildApprovalNotification(request))
    } catch (error) {
      logger(`通知：处理 approval/request 失败（${describeError(error)}）`)
    }
    return next()
  }

  /** `ctx.on('user-questions/request', …)` 的监听器，规则同审批。 */
  const onUserQuestionsRequest = (request, next) => {
    try {
      dispatch(buildQuestionNotification(request))
    } catch (error) {
      logger(`通知：处理 user-questions/request 失败（${describeError(error)}）`)
    }
    return next()
  }

  return { onSessionEvent, onApprovalRequest, onUserQuestionsRequest }
}

// ─────────────────────────────────────────────────────────────
// 当前会话花费（docs/session-cost.md）
// ─────────────────────────────────────────────────────────────

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 把 ['2026-01-01', ...] 或 { '2026': [...] } 收敛成 { 年: [日期] }。 */
function normalizeHolidays(value) {
  const result = {}
  const add = (date) => {
    if (typeof date !== 'string') return
    const trimmed = date.trim()
    const match = /^(\d{4})-\d{2}-\d{2}$/.exec(trimmed)
    if (match === null) return
    const year = match[1]
    if (result[year] === undefined) result[year] = []
    if (!result[year].includes(trimmed)) result[year].push(trimmed)
  }
  if (Array.isArray(value)) {
    value.forEach(add)
  } else if (isPlainObject(value)) {
    for (const dates of Object.values(value)) {
      if (Array.isArray(dates)) dates.forEach(add)
      else add(dates)
    }
  }
  return result
}

/** 读请求体（64 KiB 上限；超限直接断开）。 */
function readRequestBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 从宿主服务里取会话事件；兼容内存会话 / sessionQuery / sessionPersistence。 */
async function readSessionEvents(ctx, sessionId) {
  const sessions = ctx.get?.('sessions')
  const session = sessions?.get?.(sessionId)
  let events = null
  if (session) {
    try {
      if (typeof session.ownEvents === 'function') events = session.ownEvents()
      else if (Array.isArray(session.events)) events = session.events
    } catch {
      events = null
    }
  }
  if (events === null) {
    const query = ctx.get?.('sessionQuery')
    if (query !== undefined && typeof query.readSession === 'function') {
      try {
        const snapshot = await query.readSession(sessionId)
        if (Array.isArray(snapshot?.events)) events = snapshot.events
      } catch {
        // 交给下一个来源
      }
    }
  }
  if (events === null) {
    const persistence = ctx.get?.('sessionPersistence')
    if (persistence !== undefined && typeof persistence.readFrom === 'function') {
      try {
        const read = await persistence.readFrom(sessionId, 0)
        if (Array.isArray(read?.events)) events = read.events
      } catch {
        // 读不到就当作没有
      }
    }
  }
  return { session, events }
}

/**
 * 收集根会话的所有后代会话（子智能体 / 团队成员的会话）。
 *
 * 为什么用 `sessionQuery.traceSession`：会话头里有 `parentSession`，查询服务能递归
 * 给出后代树，既包含活跃会话也包含已持久化的历史会话；只看 `ctx.sessions` 会漏掉
 * 已经结束/被回收的子智能体。
 *
 * 只统计**自己的事件**：fork/seed 会话会继承父会话历史，重复计入会让费用翻倍，
 * 所以 `isSeeded` 的会话整棵跳过。
 */
async function collectDescendantSessions(ctx, rootSessionId, { limit = 50 } = {}) {
  const query = ctx.get?.('sessionQuery')
  if (query === undefined || typeof query.traceSession !== 'function') return []
  let trace
  try {
    trace = await query.traceSession(rootSessionId)
  } catch (error) {
    log(`会话花费：traceSession 失败（${describeError(error)}），只统计根会话`)
    return []
  }

  const pending = Array.isArray(trace?.descendants) ? [...trace.descendants] : []
  const candidates = []
  while (pending.length > 0 && candidates.length < limit) {
    const node = pending.shift()
    const header = node?.session?.header
    const id = header?.id
    if (typeof id === 'string' && id !== '') {
      candidates.push({ id, seeded: header?.isSeeded === true })
    }
    if (Array.isArray(node?.descendants)) pending.push(...node.descendants)
  }

  const extra = []
  for (const candidate of candidates) {
    if (candidate.seeded) continue
    const { session, events } = await readSessionEvents(ctx, candidate.id)
    if (events === null) continue
    if (session?.header?.isSeeded === true) continue
    extra.push({ sessionId: candidate.id, events })
  }
  if (extra.length > 0) log(`会话花费：根 ${rootSessionId} 子会话 ${extra.length} 个已计入`)
  return extra
}

/** 会话标题兜底：工作目录 basename。 */
function sessionTitleFallback(session) {
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && cwd !== '') {
    const base = path.basename(cwd)
    if (base !== '' && base !== '.' && base !== path.sep) return base
  }
  return ''
}

/**
 * 跟踪「当前会话」并落盘快照。
 *
 * 会话来源有两层：
 * - `client`：Web UI 组件上报的 sessionId（精确，用户正在看的那个）
 * - `recent`：没有上报时，用最近有事件活动的根会话兜底
 *
 * 导出给单测：测试用假 ctx / 假 now / 假写盘，不依赖 DSH。
 */
export function createSessionCostTracker(
  ctx,
  settings,
  {
    log: logger = log,
    now = Date.now,
    debounceMs = 1200,
    write = writeSessionCostSnapshot,
  } = {},
) {
  let activeSessionId = null
  let activeSource = 'recent'
  let timer = null
  let flushing = false
  let disposed = false
  let lastLoggedSessionId = null
  let lastLoggedAt = 0

  const schedule = (delay = debounceMs) => {
    if (disposed) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, delay)
  }

  const flush = async () => {
    if (disposed || flushing) return
    const sessionId = activeSessionId
    if (typeof sessionId !== 'string' || sessionId === '') return
    flushing = true
    try {
      const { session, events } = await readSessionEvents(ctx, sessionId)
      if (events === null) {
        logger(`会话花费：读取不到会话 ${sessionId} 的事件，保留上一次快照`)
        return
      }
      const extraSessions = await collectDescendantSessions(ctx, sessionId)
      const snapshot = buildSessionCostSnapshot({
        sessionId,
        events,
        extraSessions,
        source: activeSource,
        titleFallback: sessionTitleFallback(session),
        now: now(),
        pricing: settings.sessionCostPricing,
        holidays: settings.sessionCostHolidays,
      })
      await write(settings.sessionCostFile, snapshot)
      const current = now()
      if (sessionId !== lastLoggedSessionId || current - lastLoggedAt > 60_000) {
        lastLoggedSessionId = sessionId
        lastLoggedAt = current
        const money = snapshot.cost.priced
          ? `≈¥${snapshot.cost.cny.toFixed(3)}`
          : '金额不可用（未收录模型）'
        const tokens =
          snapshot.usage.uncachedInputTokens + snapshot.usage.cacheReadTokens + snapshot.usage.outputTokens
        logger(`会话花费：${snapshot.title || sessionId} ${tokens} tokens ${money}（${activeSource}）`)
      }
    } catch (error) {
      logger(`会话花费：写快照失败（${describeError(error)}）`)
    } finally {
      flushing = false
    }
  }

  return {
    /** UI 上报：用户切到某个会话。 */
    setActive(sessionId, source = 'client') {
      if (typeof sessionId !== 'string' || sessionId === '') return
      activeSessionId = sessionId
      activeSource = source
      schedule(0)
    },
    /** 会话活动：没有 UI 上报时用它推断「最近活跃会话」。 */
    noteActivity(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (activeSource === 'client') {
        // UI 已经明确上报了当前会话：同会话的活动只刷新数据，不能把来源降级成
        // 「最近活跃」；其他会话的活动更不能把当前窗口抢走。
        if (activeSessionId === sessionId) schedule()
        return
      }
      activeSessionId = sessionId
      activeSource = 'recent'
      schedule()
    },
    dispose() {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
    flush,
    get active() {
      return { sessionId: activeSessionId, source: activeSource }
    },
  }
}

/** client 上报路由的 handler。 */
export async function handleActiveSession(ctx, tracker, req, res) {
  const send = (status, body) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }
  if (req.method !== 'POST') return send(405, { ok: false, error: 'method not allowed' })
  let payload
  try {
    payload = JSON.parse(await readRequestBody(req))
  } catch {
    return send(400, { ok: false, error: 'invalid json' })
  }
  const sessionId = payload?.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') {
    return send(400, { ok: false, error: 'missing sessionId' })
  }
  const { events } = await readSessionEvents(ctx, sessionId)
  if (events === null) return send(404, { ok: false, error: 'session not found' })
  tracker.setActive(sessionId, 'client')
  return send(200, { ok: true })
}

/** 注册 client 上报路由 + 根会话活动监听。 */
function registerSessionCost(ctx, settings) {
  const tracker = createSessionCostTracker(ctx, settings)
  const webServer = ctx.get?.('webServer')

  ctx.effect(() => {
    let detachEvent = null
    let detachRoute = null
    // Client UI 插件直连本机桥写 active-session.json；这里轮询文件兜底，
    // 不依赖 DSH Web 网关对 /api 路由的鉴权。
    const activeFile = path.join(path.dirname(settings.sessionCostFile), 'active-session.json')
    let lastActiveStamp = 0
    let readingActive = false
    const pollTimer = setInterval(() => {
      void (async () => {
        if (readingActive) return
        readingActive = true
        try {
          const raw = await readFile(activeFile, 'utf8')
          const data = JSON.parse(raw)
          const stamp = Number(data?.updatedAt) || 0
          if (stamp > lastActiveStamp && typeof data?.sessionId === 'string' && data.sessionId !== '') {
            lastActiveStamp = stamp
            tracker.setActive(data.sessionId, 'client')
            log(`会话花费：桥上报当前会话 ${data.sessionId}`)
          }
        } catch {
          // 文件还没出现或正在写：下一轮再试
        } finally {
          readingActive = false
        }
      })()
    }, 2000)
    pollTimer.unref?.()

    // 客户端插件加载诊断：clientModules 服务里有没有我们的客户端 bundle。
    const debugTimer = setTimeout(() => {
      void (async () => {
        try {
          const clientModules = ctx.get?.('clientModules')
          const info = {
            at: new Date().toISOString(),
            hasClientModules: clientModules !== undefined,
            clientPath: null,
            graphKeys: null,
            rows: null,
            error: null,
          }
          try {
            info.clientPath = clientModules?.clientPath?.('dsh-plugin-notch-balance') ?? null
          } catch (error) {
            info.error = `clientPath: ${String(error?.message ?? error)}`
          }
          try {
            const graph = clientModules?.graph?.()
            if (graph !== null && typeof graph === 'object') {
              info.graphKeys = Object.keys(graph).slice(0, 20)
              const rows = graph.rows ?? graph.entries ?? graph.plugins
              if (Array.isArray(rows)) {
                info.rows = rows
                  .slice(0, 300)
                  .map((row) => (typeof row === 'string' ? row : (row?.id ?? row?.name ?? null)))
              }
            }
          } catch (error) {
            info.error = `${info.error ?? ''} graph: ${String(error?.message ?? error)}`
          }
          const directory = path.dirname(settings.sessionCostFile)
          await mkdir(directory, { recursive: true })
          await writeFile(path.join(directory, 'client-debug.json'), `${JSON.stringify(info, null, 2)}\n`, 'utf8')
        } catch {
          // 诊断失败不影响主功能
        }
      })()
    }, 1500)
    debugTimer.unref?.()

    try {
      detachEvent = ctx.on(
        'session/event',
        (session) => {
          try {
            if (!isRootSession(session)) return
            const sessionId = session?.header?.id ?? session?.id
            if (typeof sessionId === 'string' && sessionId !== '') tracker.noteActivity(sessionId)
          } catch (error) {
            log(`会话花费：处理 session/event 失败（${describeError(error)}）`)
          }
        },
        { global: true },
      )
      if (webServer !== undefined && typeof webServer.register === 'function') {
        detachRoute = webServer.register(
          {
            kind: 'exact',
            path: '/api/notch/active-session',
            handler: (req, res) => handleActiveSession(ctx, tracker, req, res),
          },
          'notch-balance.sessionCost',
        )
      } else {
        log('会话花费：当前组合没有 webServer，无法接收 UI 上报，按最近活跃会话推断')
      }
    } catch (error) {
      log(`会话花费：注册失败（${describeError(error)}），已跳过界面定位`)
    }
    return () => {
      clearInterval(pollTimer)
      clearTimeout(debugTimer)
      if (typeof detachEvent === 'function') detachEvent()
      if (typeof detachRoute === 'function') detachRoute()
      tracker.dispose()
    }
  }, 'notch-balance.sessionCost')

  log(`会话花费：已启用（快照 ${settings.sessionCostFile}）`)
}

/** 注册用量日历：实时累加 + 启动回填。 */
function registerTokenActivity(ctx, settings) {
  const tracker = new TokenActivityTracker(ctx, settings, { log })

  ctx.effect(() => {
    const detach = ctx.on(
      'session/event',
      (session, event) => {
        try {
          tracker.noteEvent(session, event)
        } catch (error) {
          log(`用量日历：处理 session/event 失败（${describeError(error)}）`)
        }
      },
      { global: true },
    )
    return () => {
      if (typeof detach === 'function') detach()
      clearTimeout(backfillTimer)
      tracker.dispose()
      void tracker.persist({ immediate: true })
    }
  }, 'notch-balance.tokenActivity')

  // 回填在后台跑，不阻塞 DSH 启动；先让启动路径跑完再扫历史，失败只记日志。
  const backfillTimer = setTimeout(() => {
    void tracker.backfill().catch((error) => {
      log(`用量日历：回填失败（${describeError(error)}）`)
    })
  }, 3000)

  // 诊断端点：排查「插件是否拿到 sessionQuery / 扫到多少会话 / 回填了多少」。
  // 只读本地状态，不返回会话内容。
  const webServer = ctx.get?.('webServer')
  if (webServer !== undefined && typeof webServer.register === 'function') {
    ctx.effect(
      () =>
        webServer.register(
          {
            kind: 'exact',
            path: '/api/notch/activity-status',
            handler: async (req, res) => {
              const send = (body) => {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
                res.end(JSON.stringify(body))
              }
              try {
                const query = ctx.get?.('sessionQuery')
                const files = await scanSessionFiles()
                send({
                  ok: true,
                  hasSessionQuery: query !== undefined && typeof query.readSession === 'function',
                  hasSessions: ctx.get?.('sessions') !== undefined,
                  sessionFiles: files.size,
                  cachedSessions: Object.keys(tracker.cache.sessions).length,
                  backfilling: tracker.backfilling,
                  cacheFile: settings.tokenActivityCacheFile,
                  snapshotFile: settings.tokenActivityFile,
                })
              } catch (error) {
                send({ ok: false, error: describeError(error) })
              }
            },
          },
          'notch-balance.activityStatus',
        ),
      'notch-balance.activityStatus',
    )
  }

  log(`用量日历：已启用（快照 ${settings.tokenActivityFile}）`)
}

// ─────────────────────────────────────────────────────────────
// 插件入口
// ─────────────────────────────────────────────────────────────

/** 合并 config 并做边界收敛；不合法的端口回落到默认值。 */
export function resolveSettings(config, platform = process.platform) {
  const overrides = config !== null && typeof config === 'object' ? config : {}
  const settings = { ...DEFAULTS, ...overrides }

  let bridgePort = Number(settings.bridgePort)
  if (!Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65535) {
    log(`通知：bridgePort=${String(settings.bridgePort)} 不合法，改用 ${DEFAULT_BRIDGE_PORT}`)
    bridgePort = DEFAULT_BRIDGE_PORT
  }

  const notifyBackend = ['auto', 'app', 'electron', 'powershell'].includes(settings.notifyBackend)
    ? settings.notifyBackend
    : 'auto'

  const windowsAppPath =
    typeof settings.windowsAppPath === 'string' && settings.windowsAppPath !== ''
      ? settings.windowsAppPath
      : defaultWindowsAppPath()

  return {
    platform,
    appPath:
      typeof settings.appPath === 'string' && settings.appPath !== ''
        ? settings.appPath
        : DEFAULTS.appPath,
    quitOnUnload: settings.quitOnUnload === true,
    notify: settings.notify !== false,
    bridgePort,
    notifyAborted: settings.notifyAborted === true,
    notifyTaskDone: settings.notifyTaskDone !== false,
    notifyAttention: settings.notifyAttention !== false,
    notifyBackend,
    powershellPath:
      typeof settings.powershellPath === 'string' && settings.powershellPath !== ''
        ? settings.powershellPath
        : DEFAULTS.powershellPath,
    windowsAppPath,
    sessionCost: settings.sessionCost !== false,
    sessionCostFile:
      typeof settings.sessionCostFile === 'string' && settings.sessionCostFile !== ''
        ? settings.sessionCostFile
        : defaultSessionCostFile(),
    sessionCostPricing: isPlainObject(settings.sessionCostPricing) ? settings.sessionCostPricing : {},
    sessionCostHolidays: normalizeHolidays(settings.sessionCostHolidays),
    tokenActivity: settings.tokenActivity !== false,
    tokenActivityFile:
      typeof settings.tokenActivityFile === 'string' && settings.tokenActivityFile !== ''
        ? settings.tokenActivityFile
        : defaultActivityFile(),
    tokenActivityCacheFile:
      typeof settings.tokenActivityCacheFile === 'string' && settings.tokenActivityCacheFile !== ''
        ? settings.tokenActivityCacheFile
        : defaultActivityCacheFile(),
  }
}

/** 用 `ctx.effect` 注册三个通知监听；卸载时由 effect 的清理函数全部摘除。 */
function registerNotificationListeners(ctx, settings, sender) {
  const runtime = createNotificationRuntime({
    bridge: sender,
    notifyAborted: settings.notifyAborted,
    log,
  })

  ctx.effect(() => {
    const disposers = []
    const detach = (dispose) => {
      if (typeof dispose === 'function') disposers.push(dispose)
    }

    try {
      // `global: true` 是必需的，不是偏好：事件按 agent 作用域分发，本插件位于
      // host 作用域、不拥有任何 agent，没有这个标志会在运行前就被过滤掉。
      //
      // `prepend: true` 只影响 waterfall 的观察顺序：我们的监听器只 `return next()`，
      // 不认领请求，跑在前面只是为了尽早把「需要你确认」推出去，桌面板照旧应答。
      detach(ctx.on('session/event', runtime.onSessionEvent, { global: true }))
      detach(
        ctx.on('approval/request', runtime.onApprovalRequest, {
          global: true,
          prepend: true,
        }),
      )
      detach(
        ctx.on('user-questions/request', runtime.onUserQuestionsRequest, {
          global: true,
          prepend: true,
        }),
      )
    } catch (error) {
      // 注册失败也不要连累插件其余功能；把已注册的摘干净。
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 摘除失败同样只能忽略
        }
      }
      log(`通知：注册监听失败（${describeError(error)}），本插件其余功能不受影响`)
      return () => {}
    }

    log(`通知：已注册 3 个监听（${settings.platform}）`)

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch (error) {
          log(`通知：摘除监听失败（${describeError(error)}）`)
        }
      }
      log('通知：已摘除监听')
    }
  }, 'notch-balance.notify')

  // 启动时顺便看一眼后端状态；失败只写日志，不影响任何流程。
  void sender.health?.()
}

/**
 * @param ctx - 宿主上下文。
 * @param config - `cordis.patch.yml` 里的 config。
 * @param runtime - 测试注入点：`{ platform }` 可覆盖 `process.platform`，
 *   让同一套测试在 Linux/Windows CI 上也能走 darwin / win32 分支。
 */
export function apply(ctx, config = {}, runtime = {}) {
  const settings = resolveSettings(config, runtime.platform ?? process.platform)

  // 当前会话花费与通知彼此独立：即使关掉通知，也继续记录花费快照。
  if (settings.sessionCost) {
    try {
      registerSessionCost(ctx, settings)
    } catch (error) {
      log(`会话花费：初始化失败（${describeError(error)}），已跳过`)
    }
  }

  // 用量日历：独立于通知/当前会话，按天聚合所有会话的 token 与预估金额。
  if (settings.tokenActivity) {
    try {
      registerTokenActivity(ctx, settings)
    } catch (error) {
      log(`用量日历：初始化失败（${describeError(error)}），已跳过`)
    }
  }

  // macOS：确保 DSHNotch.app 在跑（Windows 不需要伴侣应用，通知直接由宿主进程发）
  if (settings.platform === 'darwin') {
    // 激活即执行，不阻塞 DSH 启动
    void (async () => {
      if (!existsSync(settings.appPath)) {
        log(`跳过：未找到 ${settings.appPath}`)
        return
      }
      if (await isRunning()) {
        log('已在运行，不重复启动')
        return
      }
      try {
        await launch(settings.appPath)
        log(`已随 DSH 启动：${settings.appPath}`)
      } catch (error) {
        log(`启动失败：${error?.message ?? error}`)
      }
    })()

    if (settings.quitOnUnload) {
      ctx.effect(
        () => () => {
          void execFileAsync('/usr/bin/pkill', ['-x', PROCESS_NAME]).catch(() => {})
          log('插件卸载，已收掉刘海工具')
        },
        'notch-balance.quitOnUnload',
      )
    }
  }

  if (!settings.notify) return

  try {
    if (settings.platform === 'darwin') {
      registerNotificationListeners(
        ctx,
        settings,
        new NotifyBridge({ port: settings.bridgePort, log }),
      )
    } else if (settings.platform === 'win32') {
      registerNotificationListeners(ctx, settings, createWindowsSender({ settings }))
    } else {
      log(`通知：当前平台 ${settings.platform} 没有通知后端，已跳过`)
    }
  } catch (error) {
    // 通知是增值功能：注册失败也绝不能拖垮插件或 DSH 启动。
    log(`通知：初始化失败（${describeError(error)}），已跳过系统通知`)
  }
}
