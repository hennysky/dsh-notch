/**
 * 输入框预测（Codex composer predictions 同款）的纯逻辑。
 *
 * 职责边界：
 * - 本文件只做「从会话事件里取最近对话 → 拼预测请求 → 清洗模型输出」；
 * - 不碰网络、不调用模型、不读环境变量，方便 `node --test` 直接测。
 * - 真正的模型调用与 HTTP 路由在 index.js 里。
 *
 * 为什么从会话事件读对话：预测必须基于「用户此刻看到的上下文」，
 * 而客户端可能重连、切换会话，Host 侧会话日志才是唯一真源。
 */

/** 预测请求里保留的最近消息条数上限（用户 + 助手合计，按轮次合并后）。 */
export const MAX_CONTEXT_MESSAGES = 12
/** 单条用户消息截断长度（码点）。 */
export const USER_TEXT_LIMIT = 400
/** 单条助手消息截断长度（码点）。 */
export const ASSISTANT_TEXT_LIMIT = 800
/** 默认输入字节上限；超过时从最早的对话开始丢。 */
export const DEFAULT_MAX_INPUT_BYTES = 12_000
/** 输出长度上限（码点）；超出按省略号结尾。 */
export const OUTPUT_TEXT_LIMIT = 200

/** 预测无法给出时的哨兵；模型被要求原样返回。 */
export const SKIP_MARKER = '[SKIP]'

/**
 * 按码点截断，超出时以省略号结尾。
 * @param {string} value
 * @param {number} limit
 * @returns {string}
 */
export function clipText(value, limit) {
  if (typeof value !== 'string') return ''
  const chars = Array.from(value)
  if (chars.length <= limit) return value
  return chars.slice(0, Math.max(0, limit - 1)).join('') + '…'
}

/** 把任意字段收敛成单行文本。 */
export function singleLine(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * 从消息事件里取文本块。
 * 图片、文件、工具块不进入预测输入。
 * @param {unknown} content
 * @returns {string}
 */
function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * 只保留用户自己打的字：运行时上下文、时间注入、系统提醒不算对话。
 * @param {unknown} source
 * @returns {boolean}
 */
function isHumanUserMessage(source) {
  return source !== null && typeof source === 'object' && source.kind === 'user'
}

/**
 * 把会话事件折叠成预测上下文。
 *
 * 事件形状（当前会话格式）：
 * - `user/message`：`data = { role:'user', content, source:{kind:'user'} }`
 * - `assistant/message`：`data.message = { content, source:{provider,model} }`
 * - `session/title`：`data.title`
 * - 其它事件忽略。
 *
 * @param {Array<unknown>} events - 会话事件（按 seq 递增）。
 * @param {{ maxMessages?: number, userLimit?: number, assistantLimit?: number }} [options]
 * @returns {{
 *   title: string,
 *   turns: Array<{ role: 'user' | 'assistant', text: string }>,
 *   route: { provider: string, model: string } | null,
 *   lastSeq: number,
 *   lastEventAt: number,
 *   enough: boolean,
 * }}
 */
export function extractPredictionContext(events, options = {}) {
  const maxMessages = Number.isInteger(options.maxMessages) ? options.maxMessages : MAX_CONTEXT_MESSAGES
  const userLimit = Number.isInteger(options.userLimit) ? options.userLimit : USER_TEXT_LIMIT
  const assistantLimit = Number.isInteger(options.assistantLimit)
    ? options.assistantLimit
    : ASSISTANT_TEXT_LIMIT

  let title = ''
  let route = null
  let lastSeq = -1
  let lastEventAt = 0
  const turns = []

  const push = (role, rawText, limit) => {
    const text = singleLine(clipText(rawText, limit))
    if (text === '') return
    const last = turns[turns.length - 1]
    // 同一轮里的多个 assistant step 合并成一条，避免上下文被拆碎。
    if (last !== undefined && last.role === role) {
      last.text = singleLine(`${last.text} ${text}`).slice(0, limit)
      return
    }
    turns.push({ role, text })
  }

  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object') continue
    const type = event.type
    const data = event.data ?? {}
    if (typeof event.seq === 'number' && event.seq > lastSeq) lastSeq = event.seq
    if (typeof event.time === 'number' && event.time > lastEventAt) lastEventAt = event.time

    if (type === 'session/title') {
      if (typeof data.title === 'string' && data.title.trim() !== '') title = data.title.trim()
      continue
    }
    if (type === 'user/message') {
      if (!isHumanUserMessage(data.source)) continue
      push('user', textOfContent(data.content), userLimit)
      continue
    }
    if (type === 'assistant/message') {
      const message = data.message
      if (message === null || typeof message !== 'object') continue
      const source = message.source
      if (
        source !== null &&
        typeof source === 'object' &&
        typeof source.provider === 'string' &&
        source.provider !== '' &&
        typeof source.model === 'string' &&
        source.model !== ''
      ) {
        route = { provider: source.provider, model: source.model }
      }
      push('assistant', textOfContent(message.content), assistantLimit)
    }
  }

  const trimmed = turns.slice(Math.max(0, turns.length - maxMessages))
  return {
    title,
    turns: trimmed,
    route,
    lastSeq,
    lastEventAt,
    enough:
      trimmed.some((turn) => turn.role === 'user') && trimmed.some((turn) => turn.role === 'assistant'),
  }
}

/**
 * 拼模型请求。输出 `system` 与 `input` 两段。
 * @param {ReturnType<typeof extractPredictionContext>} context
 * @returns {{ system: string, input: string }}
 */
export function buildPredictionPrompt(context) {
  const title = typeof context?.title === 'string' && context.title !== '' ? context.title : '(untitled)'
  const lines = context?.turns?.map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`) ?? []
  return {
    system: [
      'You predict the next message the user will send in a DeepSeek Harness coding conversation.',
      'Read the recent conversation and write the single most likely next user message.',
      'Rules:',
      '- Reply with the message text only. No quotes, labels, markdown, or explanation.',
      '- Use the same language the user has been writing in.',
      '- Keep it under 80 words and specific to the current work.',
      '- If no useful prediction is possible, reply exactly [SKIP].',
    ].join('\n'),
    input: [
      `Conversation title: ${title}`,
      '',
      'Recent conversation:',
      ...lines,
      '',
      "Predict the user's next message.",
    ].join('\n'),
  }
}

/**
 * 从尾部保留不超过 byteLimit 的输入；先按整轮裁剪，再按字符硬裁。
 * @param {{ system: string, input: string }} prompt
 * @param {number} byteLimit
 * @returns {{ system: string, input: string, dropped: number }}
 */
export function fitPromptToBytes(prompt, byteLimit) {
  const limit = Number.isInteger(byteLimit) && byteLimit > 0 ? byteLimit : DEFAULT_MAX_INPUT_BYTES
  let input = prompt.input
  if (byteLength(input) <= limit) return { ...prompt, dropped: 0 }

  const lines = input.split('\n')
  const header = lines.slice(0, 3) // title 空行 + "Recent conversation:"
  const body = lines.slice(3)
  let dropped = 0
  while (body.length > 1 && byteLength([...header, ...body].join('\n')) > limit) {
    body.shift()
    dropped += 1
  }
  const clipped = [...header, ...body].join('\n')
  return {
    system: prompt.system,
    input: byteLength(clipped) <= limit ? clipped : clipText(clipped, Math.max(1, Math.floor(limit / 2))),
    dropped,
  }
}

/** UTF-8 字节数；非 Node 环境退化到字符数（测试与浏览器都不会走到）。 */
export function byteLength(value) {
  const text = typeof value === 'string' ? value : ''
  if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
    return Buffer.byteLength(text, 'utf8')
  }
  return text.length
}

/**
 * 清洗模型输出：
 * - 去 Markdown 围栏、角色前缀、首尾引号；
 * - 压成单行；
 * - `[SKIP]` / 空串返回 null；
 * - 超长截断。
 * @param {unknown} raw
 * @returns {string | null}
 */
export function cleanPrediction(raw) {
  if (typeof raw !== 'string') return null
  let text = raw.replace(/\r/g, '').trim()
  text = text.replace(/^```[a-zA-Z0-9_-]*\s*/u, '').replace(/\s*```$/u, '').trim()
  text = text.replace(/^(?:User|You|Assistant|用户|我|你)\s*[:：]\s*/iu, '').trim()
  const quotePairs = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
    ['「', '」'],
  ]
  for (const [open, close] of quotePairs) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(open.length, text.length - close.length).trim()
      break
    }
  }
  text = singleLine(text)
  if (text === '' || text === SKIP_MARKER || text === 'SKIP') return null
  return clipText(text, OUTPUT_TEXT_LIMIT)
}

/**
 * 选择预测使用的模型路由：
 * 1. 配置里显式给了 provider + model 时用它；
 * 2. 会话最后一条 assistant 消息来自 deepseek-account 时，固定用 flash（便宜、快）；
 * 3. 其它 provider 沿用会话自己的路由。
 * @param {{ provider: string, model: string } | null} lastRoute
 * @param {{ provider?: string, model?: string }} [options]
 * @returns {{ provider: string, model: string } | null}
 */
export function resolvePredictionRoute(lastRoute, options = {}) {
  const provider = typeof options.provider === 'string' ? options.provider.trim() : ''
  const model = typeof options.model === 'string' ? options.model.trim() : ''
  if (provider !== '' && model !== '') return { provider, model }
  if (lastRoute === null || typeof lastRoute !== 'object') return null
  if (typeof lastRoute.provider !== 'string' || typeof lastRoute.model !== 'string') return null
  if (lastRoute.provider === 'deepseek-account') {
    return { provider: lastRoute.provider, model: 'deepseek-flash' }
  }
  return { provider: lastRoute.provider, model: lastRoute.model }
}
