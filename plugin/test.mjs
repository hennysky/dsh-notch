/**
 * 插件逻辑自检（不依赖 DSH）。
 *
 *   node plugin/test.mjs                              # 全部：通知逻辑 + 进程级三态
 *   NOTCH_SKIP_PROCESS_TESTS=1 node plugin/test.mjs   # 只跑通知逻辑，不碰 DSHNotch.app
 *
 * 覆盖：
 *   A. 通知逻辑（mock HTTP 桥，纯内存，不依赖 DSH、不弹真实通知）
 *      - 文案组装：用时/会话名/根会话判定/turn-end 各 reason/审批/提问
 *      - 发送：POST 载荷、2 秒超时、桥不可达时 osascript 兜底（注入假 execFile）
 *      - 注册：notify:false 时 ctx.on 一次都不调用；卸载时摘干净
 *      - 瀑布流：approval/request、user-questions/request 一定调用 next() 且原样透传
 *   B. 原有的进程级三态（会启动 / 收掉 /Applications/DSHNotch.app）
 *      - pgrep -x 回归护栏
 *      - 未运行 → 启动 / 已在运行 → 不重复启动 / 路径不存在 → 安静跳过
 *
 * 通知测试一律用临时 mock 桥（127.0.0.1:0），不会碰到真实的 47810，
 * 也不会真的执行 osascript（execFile 被注入）。
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DEFAULTS,
  ElectronNotifier,
  NotifyBridge,
  PowerShellToastNotifier,
  UNREAD_BADGE_PNG,
  allowsPayload,
  apply,
  buildApprovalNotification,
  buildPowerShellArgs,
  buildPowerShellToastScript,
  buildQuestionNotification,
  buildToastXml,
  buildTurnEndNotification,
  createNotificationRuntime,
  createWindowsSender,
  encodePowerShellCommand,
  escapeAppleScript,
  escapeXml,
  formatDuration,
  isRootSession,
  resolveSettings,
  sessionName,
} from './index.js'

const APP = '/Applications/DSHNotch.app'
const LOG = path.join(tmpdir(), 'dsh-notch-plugin.log')
const DECOY_PATTERN = 'DSHNotch.app/Contents/MacOS/DSHNotch'
/** 一定不存在的应用路径：让 apply() 跳过 open/pgrep，只测监听逻辑。 */
const NOT_AN_APP = '/Applications/DefinitelyNotHere.app'
const SKIP_PROCESS = process.env.NOTCH_SKIP_PROCESS_TESTS === '1'

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `\n    ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pgrep = (args) => {
  try {
    return execFileSync('/usr/bin/pgrep', args, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}
const lastLog = () => {
  if (!existsSync(LOG)) return ''
  return readFileSync(LOG, 'utf8').trim().split('\n').at(-1) ?? ''
}

/** 轮询到 predicate 返回真值；超时返回最后一次结果。 */
async function waitFor(predicate, timeout = 1500, interval = 10) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const found = predicate()
    if (found) return found
    await sleep(interval)
  }
  return predicate()
}

// ─────────────────────────────────────────────────────────────
// 测试替身
// ─────────────────────────────────────────────────────────────

/** 假 ctx：记录 on/effect 注册，可模拟卸载。 */
function makeCtx() {
  const handlers = new Map()
  const effectCleanups = []
  let onCalls = 0

  const ctx = {
    on(event, listener, options) {
      onCalls++
      const record = { event, listener, options, active: true }
      const bucket = handlers.get(event) ?? []
      bucket.push(record)
      handlers.set(event, bucket)
      return () => {
        if (!record.active) return
        record.active = false
        const current = handlers.get(event) ?? []
        const index = current.indexOf(record)
        if (index >= 0) current.splice(index, 1)
      }
    },
    effect(create) {
      // 真实 cordis 的 effect 会立即执行回调，并在卸载时调用它返回的清理函数。
      effectCleanups.push(create())
      return () => {}
    },
  }

  return {
    ctx,
    onCalls: () => onCalls,
    effectCleanups,
    records: (event) => handlers.get(event) ?? [],
    listener(event) {
      return handlers.get(event)?.find((record) => record.active)?.listener
    },
    activeCount: (event) => (handlers.get(event) ?? []).filter((record) => record.active).length,
    totalActive: () =>
      [...handlers.values()].reduce(
        (sum, bucket) => sum + bucket.filter((record) => record.active).length,
        0,
      ),
    unload() {
      for (const cleanup of effectCleanups) {
        if (typeof cleanup === 'function') cleanup()
      }
    },
  }
}

/** 起一个本地 mock DSHNotch 桥，记录所有请求；端口是动态分配的。 */
async function startMockBridge() {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const record = { method: req.method, url: req.url, headers: req.headers, body }
      try {
        record.json = body === '' ? undefined : JSON.parse(body)
      } catch {
        record.json = undefined
      }
      requests.push(record)

      res.setHeader('content-type', 'application/json')
      if (req.method === 'GET' && req.url === '/health') {
        res.end(JSON.stringify({ ok: true, app: 'DSHNotch', version: '1.4', authorization: 'authorized' }))
        return
      }
      if (req.method === 'POST' && req.url === '/notify') {
        res.end(JSON.stringify({ ok: true, shown: true }))
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ ok: false, error: 'not found' }))
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  return {
    port: server.address().port,
    requests,
    notifyRequests: () => requests.filter((r) => r.url === '/notify' && r.method === 'POST'),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

// ─────────────────────────────────────────────────────────────
// A. 通知逻辑
// ─────────────────────────────────────────────────────────────

console.log('── A. 通知逻辑（mock 桥，不依赖 DSH）──')

// A1. 默认配置与纯函数

check(
  '默认配置 notify=true / bridgePort=47810 / notifyAborted=false',
  DEFAULTS.notify === true && DEFAULTS.bridgePort === 47810 && DEFAULTS.notifyAborted === false,
  JSON.stringify({ ...DEFAULTS }),
)

check('formatDuration：42 秒', formatDuration(42_000) === '42 秒', formatDuration(42_000))
check('formatDuration：2 分 13 秒', formatDuration(133_000) === '2 分 13 秒', formatDuration(133_000))
check('formatDuration：不足 1 秒取整为 0 秒', formatDuration(120) === '0 秒', formatDuration(120))
check('sessionName：取 cwd 的 basename', sessionName({ header: { cwd: '/Users/me/projects/default-workspace' } }) === 'default-workspace')
check('sessionName：取不到时用「会话」', sessionName({ header: {} }) === '会话')
check('isRootSession：根会话', isRootSession({ header: { id: 's1' } }) === true)
check('isRootSession：有 parentSession 的不是根会话', isRootSession({ header: { id: 's2', parentSession: 's1' } }) === false)
check('isRootSession：subagent 不是根会话', isRootSession({ header: { id: 's3', origin: 'subagent' } }) === false)

const completedPayload = buildTurnEndNotification(
  { header: { id: 'session-a', cwd: '/Users/me/projects/default-workspace' } },
  { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } },
  { startedAt: 0, now: 133_000 },
)
check(
  'turn/end completed：标题「任务完成」+ 会话名 + 用时',
  completedPayload?.kind === 'turn-end' &&
    completedPayload.title === '任务完成' &&
    completedPayload.body === 'default-workspace · 用时 2 分 13 秒',
  JSON.stringify(completedPayload),
)
check(
  'turn/end completed：sessionId 与 dedupeKey',
  completedPayload?.sessionId === 'session-a' && completedPayload?.dedupeKey === 'turn-end:session-a:7',
  JSON.stringify(completedPayload),
)

const errorPayload = buildTurnEndNotification(
  { header: { id: 'session-b', cwd: '/tmp/demo' } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: '模型调用超时' } } } },
  { startedAt: 0, now: 12_000 },
)
check(
  'turn/end error：标题「任务失败」+ reason.error.message',
  errorPayload?.title === '任务失败' && errorPayload.body.includes('模型调用超时'),
  JSON.stringify(errorPayload),
)

const reasonCases = [
  ['blocked', '任务被阻塞'],
  ['max-tokens', '任务中断：达到长度上限'],
]
for (const [kind, title] of reasonCases) {
  const payload = buildTurnEndNotification(
    { header: { id: `session-${kind}`, cwd: '/tmp/demo' } },
    { type: 'turn/end', data: { turn: 1, reason: { kind } } },
    { startedAt: 0, now: 1_000 },
  )
  check(`turn/end ${kind}：标题「${title}」`, payload?.title === title, JSON.stringify(payload))
}

const abortedEvent = { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: 'user' } } }
check(
  'turn/end aborted：默认不通知',
  buildTurnEndNotification({ header: { id: 's', cwd: '/tmp/demo' } }, abortedEvent, { startedAt: 0, now: 1_000 }) === null,
)
check(
  'turn/end aborted：notifyAborted=true 时标题「任务已取消」',
  buildTurnEndNotification({ header: { id: 's', cwd: '/tmp/demo' } }, abortedEvent, {
    startedAt: 0,
    now: 1_000,
    notifyAborted: true,
  })?.title === '任务已取消',
)
check(
  'turn/end 未知 reason：不通知',
  buildTurnEndNotification(
    { header: { id: 's', cwd: '/tmp/demo' } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'forked' } } },
    { startedAt: 0, now: 1_000 },
  ) === null,
)

const approvalPayload = buildApprovalNotification({
  toolName: 'Bash',
  displayReason: { en: 'Run a command', zh: '执行命令' },
  agent: { session: { id: 'session-a' } },
})
check(
  'approval：kind=attention、标题「需要你确认」',
  approvalPayload.kind === 'attention' && approvalPayload.title === '需要你确认',
  JSON.stringify(approvalPayload),
)
check('approval：正文 `<toolName> 请求授权` + 截断的 displayReason（优先 zh）',
  approvalPayload.body.startsWith('Bash 请求授权') && approvalPayload.body.includes('执行命令'),
  approvalPayload.body,
)
check('approval：带 sessionId', approvalPayload.sessionId === 'session-a', JSON.stringify(approvalPayload))

const questionPayload = buildQuestionNotification({
  questions: [
    { id: 'q1', question: '你想用哪个方案？', detail: '细节不应进入正文' },
    { id: 'q2', question: '第二个问题' },
  ],
  agent: { session: { id: 'session-a' } },
})
check(
  'question：kind=attention、标题「需要你回答」、正文取第一个问题题干',
  questionPayload.kind === 'attention' &&
    questionPayload.title === '需要你回答' &&
    questionPayload.body === '你想用哪个方案？',
  JSON.stringify(questionPayload),
)
check('question：带 sessionId', questionPayload.sessionId === 'session-a')

check(
  'escapeAppleScript：正确转义反斜杠、引号、换行',
  escapeAppleScript('a"b\\c\nd') === 'a\\"b\\\\c\\nd',
  JSON.stringify(escapeAppleScript('a"b\\c\nd')),
)

// A2. 桥不可达 → osascript 兜底（注入假 execFile，不弹真实通知）

const closedServer = http.createServer(() => {})
await new Promise((resolve) => closedServer.listen(0, '127.0.0.1', resolve))
const closedPort = closedServer.address().port
await new Promise((resolve) => closedServer.close(resolve))

const osascriptCalls = []
const fallbackLogs = []
const fallbackBridge = new NotifyBridge({
  port: closedPort,
  log: (line) => fallbackLogs.push(line),
  execFile: async (...args) => {
    osascriptCalls.push(args)
    return ''
  },
})
const fallbackResult = await fallbackBridge.send({
  kind: 'attention',
  title: '需要"你"确认',
  body: 'Bash 请求授权\n第二行',
})
check('桥不可达：send() 返回 false 且不抛', fallbackResult === false)
check(
  '桥不可达：osascript 兜底恰好一次',
  osascriptCalls.length === 1 &&
    osascriptCalls[0]?.[0] === '/usr/bin/osascript' &&
    osascriptCalls[0]?.[1]?.[0] === '-e',
  JSON.stringify(osascriptCalls),
)
const fallbackScript = osascriptCalls[0]?.[1]?.[1] ?? ''
check(
  '桥不可达：osascript 脚本里的引号已转义、正文已收敛成单行',
  fallbackScript.includes('\\"你\\"') &&
    !fallbackScript.includes('\n') &&
    fallbackScript.includes('Bash 请求授权 第二行'),
  fallbackScript,
)
check('桥不可达：写入了失败日志', fallbackLogs.some((line) => line.includes('退回 osascript')), JSON.stringify(fallbackLogs))

// A3. 完整注册 + mock 桥载荷断言

const bridge = await startMockBridge()
const harness = makeCtx()
apply(harness.ctx, { appPath: NOT_AN_APP, bridgePort: bridge.port, notifyAborted: false }, { platform: 'darwin' })

check(
  'notify:true：注册了 3 个监听',
  harness.onCalls() === 3 &&
    harness.activeCount('session/event') === 1 &&
    harness.activeCount('approval/request') === 1 &&
    harness.activeCount('user-questions/request') === 1,
  `ctx.on 调用 ${harness.onCalls()} 次`,
)
const sessionRecords = harness.records('session/event')
const approvalRecords = harness.records('approval/request')
const questionRecords = harness.records('user-questions/request')
check(
  'session/event 带 { global: true }',
  sessionRecords.length === 1 && sessionRecords[0].options?.global === true,
  JSON.stringify(sessionRecords.map((record) => record.options)),
)
check(
  'approval/request 与 user-questions/request 带 { global: true, prepend: true }',
  approvalRecords[0]?.options?.global === true &&
    approvalRecords[0]?.options?.prepend === true &&
    questionRecords[0]?.options?.global === true &&
    questionRecords[0]?.options?.prepend === true,
  JSON.stringify([approvalRecords[0]?.options, questionRecords[0]?.options]),
)

const healthRequest = await waitFor(() => bridge.requests.find((r) => r.method === 'GET' && r.url === '/health'))
check('启动时探测 GET /health', healthRequest !== undefined, JSON.stringify(bridge.requests))

const rootSession = { header: { id: 'session-test', cwd: '/Users/me/projects/default-workspace' } }
const onSessionEvent = harness.listener('session/event')

onSessionEvent(rootSession, { type: 'turn/start', data: { turn: 1 } })
onSessionEvent(rootSession, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
const completedRequest = await waitFor(() => bridge.notifyRequests().find((r) => r.json?.title === '任务完成'))
check('turn-end 完成 → POST /notify', completedRequest !== undefined)
check(
  'turn-end 完成 → payload {kind,title,body,sessionId,dedupeKey}',
  completedRequest?.json?.kind === 'turn-end' &&
    completedRequest.json.title === '任务完成' &&
    /^default-workspace · 用时 \d+ 秒$/.test(completedRequest.json.body ?? '') &&
    completedRequest.json.sessionId === 'session-test' &&
    completedRequest.json.dedupeKey === 'turn-end:session-test:1',
  JSON.stringify(completedRequest?.json),
)
check(
  'POST /notify 带 application/json',
  (completedRequest?.headers?.['content-type'] ?? '').includes('application/json'),
  JSON.stringify(completedRequest?.headers),
)

onSessionEvent(rootSession, { type: 'turn/start', data: { turn: 2 } })
onSessionEvent(rootSession, {
  type: 'turn/end',
  data: { turn: 2, reason: { kind: 'error', error: { message: '模型调用超时' } } },
})
const errorRequest = await waitFor(() => bridge.notifyRequests().find((r) => r.json?.title === '任务失败'))
check(
  'turn-end 失败 → payload 标题与错误消息',
  errorRequest?.json?.kind === 'turn-end' &&
    (errorRequest?.json?.body ?? '').includes('模型调用超时'),
  JSON.stringify(errorRequest?.json),
)

const notifyCountBeforeChild = bridge.notifyRequests().length
const childSession = { header: { id: 'session-child', parentSession: 'session-test' } }
onSessionEvent(childSession, { type: 'turn/start', data: { turn: 1 } })
onSessionEvent(childSession, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
await sleep(150)
check(
  '子会话 turn/end 不通知',
  bridge.notifyRequests().length === notifyCountBeforeChild,
  `通知数 ${notifyCountBeforeChild} → ${bridge.notifyRequests().length}`,
)

const notifyCountBeforeAbort = bridge.notifyRequests().length
onSessionEvent(rootSession, { type: 'turn/start', data: { turn: 3 } })
onSessionEvent(rootSession, { type: 'turn/end', data: { turn: 3, reason: { kind: 'aborted', reason: 'user' } } })
await sleep(150)
check(
  'notifyAborted=false：aborted 轮次不通知',
  bridge.notifyRequests().length === notifyCountBeforeAbort,
  `通知数 ${notifyCountBeforeAbort} → ${bridge.notifyRequests().length}`,
)

// A4. 审批 / 提问瀑布流：next() 一定被调用且返回值原样透传

let approvalNextCalls = 0
const approvalOutcome = 'allow-once'
const approvalListener = harness.listener('approval/request')
const approvalReturned = approvalListener(
  { toolName: 'Bash', reason: '执行命令需要授权', agent: { session: { id: 'session-test' } } },
  () => {
    approvalNextCalls++
    return Promise.resolve(approvalOutcome)
  },
)
check('approval/request：next() 被调用一次', approvalNextCalls === 1, `调用 ${approvalNextCalls} 次`)
check('approval/request：返回值原样透传', (await approvalReturned) === approvalOutcome, String(await approvalReturned))
const approvalRequest = await waitFor(() => bridge.notifyRequests().find((r) => r.json?.title === '需要你确认'))
check(
  'approval/request → attention 载荷（kind/正文含 toolName）',
  approvalRequest?.json?.kind === 'attention' &&
    (approvalRequest?.json?.body ?? '').startsWith('Bash 请求授权'),
  JSON.stringify(approvalRequest?.json),
)

let questionNextCalls = 0
const questionAnswer = { answers: [{ id: 'q1', answer: ['A'] }] }
const questionListener = harness.listener('user-questions/request')
const questionReturned = questionListener(
  { questions: [{ id: 'q1', question: '选 A 还是 B？' }], agent: { session: { id: 'session-test' } } },
  () => {
    questionNextCalls++
    return Promise.resolve(questionAnswer)
  },
)
check('user-questions/request：next() 被调用一次', questionNextCalls === 1, `调用 ${questionNextCalls} 次`)
check('user-questions/request：返回值原样透传', (await questionReturned) === questionAnswer)
const questionRequest = await waitFor(() =>
  bridge.notifyRequests().find((r) => r.json?.title === '需要你回答'),
)
check(
  'user-questions/request → attention 载荷（kind/第一个问题题干）',
  questionRequest?.json?.kind === 'attention' && questionRequest?.json?.body === '选 A 还是 B？',
  JSON.stringify(questionRequest?.json),
)

// 通知层自己抛异常 / 通知失败，瀑布流都必须照旧
const throwingRuntime = createNotificationRuntime({
  bridge: {
    send() {
      throw new Error('boom')
    },
  },
  log: () => {},
})
let boomNextCalls = 0
const boomReturned = throwingRuntime.onApprovalRequest({ toolName: 'Bash' }, () => {
  boomNextCalls++
  return Promise.resolve('delegated')
})
check(
  '通知组装/发送抛异常也不影响 next()',
  boomNextCalls === 1 && (await boomReturned) === 'delegated',
  `next 调用 ${boomNextCalls} 次`,
)
const waterfallError = new Error('waterfall-failed')
let rejectionPassedThrough = false
try {
  await throwingRuntime.onApprovalRequest({ toolName: 'Bash' }, () => Promise.reject(waterfallError))
} catch (error) {
  rejectionPassedThrough = error === waterfallError
}
check('next() 的 rejection 原样透传', rejectionPassedThrough)

// A5. 卸载摘监听

harness.unload()
check(
  '卸载后 3 个监听全部摘除',
  harness.totalActive() === 0 &&
    harness.activeCount('session/event') === 0 &&
    harness.activeCount('approval/request') === 0 &&
    harness.activeCount('user-questions/request') === 0,
  `剩余 ${harness.totalActive()} 个`,
)
await bridge.close()

// A6. notify:false

const offBridge = await startMockBridge()
const offHarness = makeCtx()
apply(offHarness.ctx, { appPath: NOT_AN_APP, notify: false, bridgePort: offBridge.port }, { platform: 'darwin' })
check('notify:false：ctx.on 一次都没被调用', offHarness.onCalls() === 0, `ctx.on 调用 ${offHarness.onCalls()} 次`)
check('notify:false：不注册任何 effect', offHarness.effectCleanups.length === 0, `effect ${offHarness.effectCleanups.length} 个`)
await sleep(150)
check('notify:false：不探测桥、不发通知', offBridge.requests.length === 0, JSON.stringify(offBridge.requests))
await offBridge.close()

// 非法端口回落到默认值
check(
  'resolveSettings：非法 bridgePort 回落到 47810',
  resolveSettings({ bridgePort: 'not-a-port' }).bridgePort === 47810,
)

// ─────────────────────────────────────────────────────────────
// C. Windows 后端（纯逻辑，不依赖 Windows，可在 CI 的 windows-latest 上跑）
// ─────────────────────────────────────────────────────────────

console.log('\n── C. Windows 通知后端 ──')

// C1. XML 转义 + toast 模板
const escaped = escapeXml(`a&b<c>d"e'f`)
check('escapeXml 转义 & < > " \'', escaped === 'a&amp;b&lt;c&gt;d&quot;e&apos;f', escaped)
const toastXml = buildToastXml({ title: '任务 <完成>', body: 'a & b "c"' })
check('buildToastXml 使用 ToastGeneric 模板', toastXml.includes('template="ToastGeneric"'), toastXml)
check(
  'buildToastXml 对标题/正文做了 XML 转义',
  toastXml.includes('任务 &lt;完成&gt;') && toastXml.includes('a &amp; b &quot;c&quot;'),
  toastXml,
)
check('Windows 红点资源是内嵌 PNG data URL', UNREAD_BADGE_PNG.startsWith('data:image/png;base64,'), UNREAD_BADGE_PNG.slice(0, 32) + '…')

// C2. PowerShell 兜底：脚本 + EncodedCommand
const psScript = buildPowerShellToastScript({ title: '任务完成', body: '用时 2 分 13 秒' })
check(
  'PowerShell 脚本包含 WinRT toast 调用',
  psScript.includes('ToastNotificationManager') && psScript.includes('CreateToastNotifier'),
)
const decodedScript = Buffer.from(encodePowerShellCommand(psScript), 'base64').toString('utf16le')
check('EncodedCommand 是 UTF-16LE base64 且可还原', decodedScript === psScript, `${decodedScript.slice(0, 36)}…`)
const psArgs = buildPowerShellArgs(psScript)
check(
  'PowerShell 参数包含 -NoProfile / -EncodedCommand',
  psArgs.includes('-NoProfile') && psArgs.includes('-EncodedCommand'),
  psArgs.join(' '),
)

// C3. PowerShellToastNotifier
const psCalls = []
const psNotifier = new PowerShellToastNotifier({
  execFile: async (file, args, options) => {
    psCalls.push({ file, args, options })
  },
  log: () => {},
})
const psSent = await psNotifier.send({ kind: 'turn-end', title: '任务完成', body: 'ok' })
check(
  'PowerShellToastNotifier 用 powershell.exe 且 windowsHide',
  psSent === true && psCalls[0]?.file === 'powershell.exe' && psCalls[0]?.options?.windowsHide === true,
  JSON.stringify(psCalls[0]?.options),
)
const psFailNotifier = new PowerShellToastNotifier({
  execFile: async () => {
    throw new Error('boom')
  },
  log: () => {},
})
check('PowerShell toast 失败不抛异常', (await psFailNotifier.send({ title: 'x', body: 'y' })) === false)

// C4. ElectronNotifier（注入假 electron，验证行为而不是 API）
function makeFakeElectron({ supported = true } = {}) {
  const shown = []
  const overlays = []
  const focusCalls = []
  const appHandlers = {}

  const fakeWindow = {
    focused: false,
    overlay: undefined,
    on() {},
    isMinimized: () => false,
    restore: () => {},
    show: () => {},
    focus: () => {
      fakeWindow.focused = true
      focusCalls.push('focus')
    },
    setOverlayIcon(image, description) {
      fakeWindow.overlay = { image, description }
      overlays.push({ image, description })
    },
  }

  class FakeNotification {
    static isSupported() {
      return supported
    }

    constructor(options) {
      this.options = options
      this.handlers = {}
      this.visible = false
      shown.push(this)
    }

    on(event, handler) {
      this.handlers[event] = handler
    }

    show() {
      this.visible = true
    }
  }

  return {
    electron: {
      Notification: FakeNotification,
      nativeImage: { createFromDataURL: (url) => ({ url }) },
      BrowserWindow: {
        getAllWindows: () => [fakeWindow],
        getFocusedWindow: () => (fakeWindow.focused ? fakeWindow : null),
      },
      app: { on: (event, handler) => { appHandlers[event] = handler } },
    },
    shown,
    overlays,
    focusCalls,
    appHandlers,
    fakeWindow,
  }
}

const overlayCleared = (fake) =>
  fake.fakeWindow.overlay?.image === null && (fake.fakeWindow.overlay?.description ?? '') === ''

const fake = makeFakeElectron()
const electronNotifier = new ElectronNotifier({ electron: fake.electron, log: () => {} })
check('ElectronNotifier.health 报告 supported', (await electronNotifier.health()).supported === true)
electronNotifier.bind()
check('ElectronNotifier 绑定已有窗口', electronNotifier.windows.size === 1, `windows=${electronNotifier.windows.size}`)

await electronNotifier.send({ kind: 'turn-end', title: '任务完成', body: 'ok' })
check('Electron 通知被 show()', fake.shown.length === 1 && fake.shown[0].visible === true)
check(
  '未聚焦时任务栏红点 +1',
  electronNotifier.unread === 1 && fake.fakeWindow.overlay?.description === '1 条未读通知',
  JSON.stringify(fake.fakeWindow.overlay?.description),
)
await electronNotifier.send({ kind: 'attention', title: '需要你确认', body: 'bash 请求授权' })
check(
  '第二条 → 未读 2',
  electronNotifier.unread === 2 && fake.fakeWindow.overlay?.description === '2 条未读通知',
  JSON.stringify(fake.fakeWindow.overlay?.description),
)
fake.shown[0]?.handlers?.click?.()
check('点击通知 → 聚焦 DSH 并清未读', fake.focusCalls.length === 1 && electronNotifier.unread === 0 && overlayCleared(fake))

fake.fakeWindow.focused = true
await electronNotifier.send({ kind: 'turn-end', title: '任务完成', body: 'focused' })
check('DSH 已聚焦时不留红点', electronNotifier.unread === 0 && overlayCleared(fake), `unread=${electronNotifier.unread}`)

fake.fakeWindow.focused = false
await electronNotifier.send({ kind: 'attention', title: '需要你回答', body: 'again' })
check('再次未聚焦 → 未读 1', electronNotifier.unread === 1, `unread=${electronNotifier.unread}`)
fake.appHandlers['browser-window-focus']?.()
check('窗口获得焦点 → 未读清零', electronNotifier.unread === 0 && overlayCleared(fake), `unread=${electronNotifier.unread}`)

const unsupported = makeFakeElectron({ supported: false })
const unsupportedNotifier = new ElectronNotifier({ electron: unsupported.electron, log: () => {} })
check('Notification.isSupported()=false 时 health.supported=false', (await unsupportedNotifier.health()).supported === false)

// C5. createWindowsSender：后端选择 + 类型过滤
const electronSender = createWindowsSender({
  settings: resolveSettings({ notifyBackend: 'auto' }, 'win32'),
  log: () => {},
  importModule: async () => fake.electron,
})
check('auto：有 electron 时选 Electron 后端', (await electronSender.health())?.backend === 'electron')

const winSettings = resolveSettings({ notifyBackend: 'auto', notifyTaskDone: false }, 'win32')
const filteredSender = createWindowsSender({
  settings: winSettings,
  log: () => {},
  importModule: async () => {
    throw new Error('no electron in headless dsh')
  },
  execFile: async () => {},
})
check('拿不到 electron → 退回 PowerShell', (await filteredSender.health())?.backend === 'powershell')
check(
  'notifyTaskDone:false 时 Windows 侧过滤 turn-end',
  (await filteredSender.send({ kind: 'turn-end', title: 'x', body: 'y' })) === false,
)
check(
  'notifyAttention 默认开：attention 照发',
  (await filteredSender.send({ kind: 'attention', title: 'x', body: 'y' })) === true,
)
check(
  'allowsPayload 放行未配置的类型',
  allowsPayload(winSettings, { kind: 'attention' }) === true &&
    allowsPayload(winSettings, { kind: 'turn-end' }) === false,
)

// C6. 平台解析与 win32 的 apply 不碰 macOS 应用
check('resolveSettings 记录平台', resolveSettings({}, 'win32').platform === 'win32')
const winCtx = makeCtx()
apply(winCtx.ctx, { notify: false }, { platform: 'win32' })
check('win32 + notify:false 不注册任何监听', winCtx.onCalls() === 0, `ctx.on 调用 ${winCtx.onCalls()} 次`)

// ─────────────────────────────────────────────────────────────
// B. 原有进程级三态（会临时启动 / 收掉 DSHNotch.app）
// ─────────────────────────────────────────────────────────────

if (SKIP_PROCESS) {
  console.log('\n（NOTCH_SKIP_PROCESS_TESTS=1，已跳过会操作 /Applications/DSHNotch.app 的进程级测试）')
} else {
  console.log('\n── B. 进程级三态（会启动 / 收掉 DSHNotch.app）──')

  // ── 1. 进程检测的回归护栏 ──
  // 造一个 argv 里含完整可执行路径、但进程名不是 DSHNotch 的进程：
  // 旧写法 pgrep -f 会把它当成「应用已在运行」，于是根本不启动。

  for (const pid of pgrep(['-x', 'DSHNotch'])) {
    try {
      process.kill(Number(pid), 'SIGTERM')
    } catch {}
  }
  await sleep(1000)
  check('前置：先确保没有 DSHNotch 在跑', pgrep(['-x', 'DSHNotch']).length === 0)

  const decoy = spawn('/usr/bin/env', ['python3', '-c', 'import time; time.sleep(30)', DECOY_PATTERN], {
    detached: true,
    stdio: 'ignore',
  })
  await sleep(800)

  const byCommandLine = pgrep(['-f', DECOY_PATTERN])
  const byName = pgrep(['-x', 'DSHNotch'])

  check(
    'pgrep -f 会被命令行里的路径骗到（所以不能用它）',
    byCommandLine.length > 0,
    `-f 命中 ${byCommandLine.length} 个 pid: ${byCommandLine.join(',')}（诱饵进程名是 python3）`,
  )
  check(
    'pgrep -x 不认诱饵，只认进程名',
    byName.length === 0,
    byName.length ? `误命中: ${byName.join(',')}` : '-x 命中 0（正确）',
  )

  try {
    process.kill(-decoy.pid, 'SIGKILL')
  } catch {}
  await sleep(300)

  // ── 2. apply() 三态 ──
  const ctx = { effect: (fn) => fn() }

  rmSync(LOG, { force: true })
  check('前置：/Applications/DSHNotch.app 存在', existsSync(APP), APP)

  apply(ctx, { appPath: APP, notify: false }, { platform: 'darwin' })
  await sleep(2500)
  check('未运行 → 启动', lastLog().includes('已随 DSH 启动'), lastLog())
  const afterLaunch = pgrep(['-x', 'DSHNotch'])
  check('进程真的起来了', afterLaunch.length === 1, `pid ${afterLaunch.join(',')}`)

  apply(ctx, { appPath: APP, notify: false }, { platform: 'darwin' })
  await sleep(1500)
  check('已在运行 → 不重复启动', lastLog().includes('已在运行'), lastLog())
  check(
    '仍然只有一个实例',
    pgrep(['-x', 'DSHNotch']).length === 1,
    `实例数 ${pgrep(['-x', 'DSHNotch']).length}`,
  )

  apply(ctx, { appPath: '/Applications/DefinitelyNotHere.app', notify: false }, { platform: 'darwin' })
  await sleep(800)
  check('路径不存在 → 安静跳过', lastLog().includes('跳过'), lastLog())
}

console.log('')
console.log(failed === 0 ? '插件逻辑全部通过' : `${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
