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

import { execFile } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

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
  /** 应用位置。可以在 cordis.patch.yml 的 config 里改。 */
  appPath: '/Applications/DSHNotch.app',
  /** 插件卸载时是否同时收掉应用。 */
  quitOnUnload: false,
  /** 通知总开关；false 时一个监听器都不注册。 */
  notify: true,
  /** 与 DSHNotch 的本地桥端口。 */
  bridgePort: DEFAULT_BRIDGE_PORT,
  /** 用户自己中断的轮次默认不通知（他本来就知道）。 */
  notifyAborted: false,
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
// 插件入口
// ─────────────────────────────────────────────────────────────

/** 合并 config 并做边界收敛；不合法的端口回落到默认值。 */
export function resolveSettings(config) {
  const overrides = config !== null && typeof config === 'object' ? config : {}
  const settings = { ...DEFAULTS, ...overrides }

  let bridgePort = Number(settings.bridgePort)
  if (!Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65535) {
    log(`通知：bridgePort=${String(settings.bridgePort)} 不合法，改用 ${DEFAULT_BRIDGE_PORT}`)
    bridgePort = DEFAULT_BRIDGE_PORT
  }

  return {
    appPath:
      typeof settings.appPath === 'string' && settings.appPath !== ''
        ? settings.appPath
        : DEFAULTS.appPath,
    quitOnUnload: settings.quitOnUnload === true,
    notify: settings.notify !== false,
    bridgePort,
    notifyAborted: settings.notifyAborted === true,
  }
}

/** 用 `ctx.effect` 注册三个通知监听；卸载时由 effect 的清理函数全部摘除。 */
function registerNotificationListeners(ctx, settings) {
  const bridge = new NotifyBridge({ port: settings.bridgePort, log })
  const runtime = createNotificationRuntime({
    bridge,
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

    log(`通知：已注册 3 个监听（桥端口 ${settings.bridgePort}）`)

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

  // 启动时顺便看一眼桥和通知权限；失败只写日志，不影响任何流程。
  void bridge.health()
}

export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)

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

  if (!settings.notify) return

  try {
    registerNotificationListeners(ctx, settings)
  } catch (error) {
    // 通知是增值功能：注册失败也绝不能拖垮插件或 DSH 启动。
    log(`通知：初始化失败（${describeError(error)}），已跳过系统通知`)
  }
}
