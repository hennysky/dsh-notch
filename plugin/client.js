/**
 * DSH Client UI 插件：账号行余额环 + 输入框下一句预测。
 *
 * 两个功能都只改浏览器呈现，不碰会话数据、不发消息：
 * 1. 余额环：侧栏底部账号行右端注入一个健康环（充值余额 / 参考上限），
 *    余额数据走 DSH 自己的 `remote.account.getBalance`，与设置→账号同源。
 * 2. 输入预测（Codex composer predictions 同款）：一轮回复结束后，空输入框里
 *    出现灰色的「下一句」建议，Tab 填入但不发送；建议由 Host 插件调用模型生成。
 *
 * 为什么账号行用 DOM 注入而不是 slot：侧栏底部是 `sidebar.settings` 单席，
 * 原生账号菜单已经占了它；替换整个菜单会丢掉登录/设置/退出。环只是装饰，
 * 用「找到账号按钮 → 尾部插一个 span」最稳，DS Bot 切走账号菜单时环自然消失。
 *
 * 会话切换上报（原功能）保留在文件末尾。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-notch-balance',
  factory(require) {
    const React = require('react')
    const BRIDGE = 'http://127.0.0.1:47810'

    // ───────────────────────────────────────────────────────────
    // 诊断：只记状态，不记余额数字、不记预测内容
    // ───────────────────────────────────────────────────────────

    function post(url, body) {
      return window.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      })
    }

    function probe(stage, extra) {
      const body = Object.assign({ stage, at: Date.now() }, extra)
      try {
        void post('/probe', body).catch(function () {})
      } catch (error) {}
      try {
        void post(BRIDGE + '/probe', body).catch(function () {})
      } catch (error) {}
    }

    /** 上报当前会话：同源路由 + 本机桥文件双写。 */
    function reportActive(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      // Host 侧据「看过」集合主动生成预测：即使用户在回合结束前切走也不会漏。
      try {
        void post('api/notch/watch', { sessionId }).catch(function () {})
      } catch (error) {}
      try {
        void post('/api/notch/active-session', { sessionId }).catch(function () {})
      } catch (error) {}
      try {
        void post(BRIDGE + '/active-session', { sessionId }).catch(function () {})
      } catch (error) {}
    }

    // ───────────────────────────────────────────────────────────
    // 样式
    // ───────────────────────────────────────────────────────────

    const STYLE_ID = 'dsh-plugin-notch-balance/styles'

    const CSS = `
.dshn-balance{display:inline-flex;flex:none;align-items:center;gap:6px;margin-left:auto;margin-right:2px;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-secondary);outline:none}
.dshn-balance[hidden]{display:none!important}
.dshn-balance:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:2px}
.dshn-amount{display:inline-flex;align-items:baseline;gap:5px;font-size:12px;line-height:16px;white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.dshn-balance[data-tone=danger] .dshn-amount-main{color:var(--dsw-alias-state-error-primary,#ef4444)}
.dshn-amount[hidden]{display:none!important}
.dshn-bonus{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#8a8f98);white-space:nowrap;font-variant-numeric:tabular-nums}
.dshn-bonus[hidden]{display:none!important}
.dshn-ring{display:inline-flex;flex:none;align-items:center;justify-content:center;width:20px;height:20px;color:var(--dsw-alias-label-caption);transition:opacity .15s ease,color .2s ease}
.dshn-ring svg{display:block;transform:rotate(-90deg)}
.dshn-ring-track{fill:none;stroke:currentColor;stroke-opacity:.22;stroke-width:2.2}
.dshn-ring-arc{fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-dasharray:43.98;stroke-dashoffset:43.98;transition:stroke-dashoffset .35s ease,stroke .2s ease}
.dshn-balance[data-tone=ok] .dshn-ring{color:var(--dsw-alias-state-success-primary,#2fb56a)}
.dshn-balance[data-tone=warn] .dshn-ring{color:var(--dsw-alias-state-warn-primary,#f5a524)}
.dshn-balance[data-tone=danger] .dshn-ring{color:var(--dsw-alias-state-error-primary,#ef4444)}
.dshn-balance[data-tone=unknown] .dshn-ring,.dshn-balance[data-tone=loading] .dshn-ring{color:var(--dsw-alias-label-caption,#8a8f98)}
.dshn-balance[data-tone=loading] .dshn-ring-arc{stroke-dashoffset:32.98;animation:dshn-ring-pulse 1.4s ease-in-out infinite}
@keyframes dshn-ring-pulse{0%,100%{opacity:.35}50%{opacity:.9}}
.dshn-pop{position:fixed;z-index:2147483000;min-width:188px;max-width:280px;box-sizing:border-box;padding:10px 12px 9px;border-radius:10px;background:var(--dsw-specific-menu,var(--dsw-alias-button-elevated-fill,#303136));color:var(--dsw-alias-label-primary,#e8e8ea);border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));box-shadow:0 12px 32px rgba(0,0,0,.38);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);font-size:12px;line-height:18px;animation:dshn-pop-in .12s ease-out}
@keyframes dshn-pop-in{from{opacity:0;transform:translateY(3px)}}
.dshn-pop-title{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}
.dshn-pop-amount{margin:1px 0 7px;font-size:21px;line-height:27px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.dshn-pop-row{display:flex;align-items:baseline;justify-content:space-between;gap:18px}
.dshn-pop-row .k{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dshn-pop-row .v{font-variant-numeric:tabular-nums;white-space:nowrap}
.dshn-pop-divider{height:.5px;margin:6px 0;background:var(--dsw-alias-border-l3,rgba(127,127,127,.25))}
.dshn-pop-foot{margin-top:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.dshn-ghost{position:absolute;top:12px;left:14px;right:8px;z-index:4;display:flex;align-items:center;gap:8px;pointer-events:none;user-select:none;color:var(--dsw-alias-label-caption);font-size:inherit;line-height:inherit;white-space:nowrap}
.dshn-ghost-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.9}
.dshn-tab{flex:none;font-size:11px;line-height:16px;padding:0 5px;border-radius:4px;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover);font-family:var(--ds-font-family-code,ui-monospace,monospace)}
.dshn-spinner{flex:none;width:12px;height:12px;border-radius:50%;border:1.5px solid color-mix(in srgb,currentColor 22%,transparent);border-top-color:currentColor;animation:dshn-spin .8s linear infinite}
@keyframes dshn-spin{to{transform:rotate(360deg)}}
.dshn-loading-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:18px;background:linear-gradient(90deg,currentColor 0%,var(--dsw-alias-label-primary,#e8e8ea) 48%,currentColor 96%);background-size:220% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:dshn-shimmer 1.5s linear infinite}
@keyframes dshn-shimmer{from{background-position:120% 0}to{background-position:-120% 0}}
[data-composer-card][data-dsh-prediction] [data-composer-placeholder]{visibility:hidden!important}
@media (prefers-reduced-motion:reduce){.dshn-ring,.dshn-ring-arc,.dshn-pop{transition:none;animation:none!important}.dshn-loading-text{animation:none;background:none;color:var(--dsw-alias-label-caption)}.dshn-spinner{animation-duration:2s}}
`

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // ───────────────────────────────────────────────────────────
    // 通用小工具
    // ───────────────────────────────────────────────────────────

    function currentLocale(ctx) {
      try {
        const snapshot = ctx.get('locale')?.getSnapshot?.()
        return typeof snapshot?.active === 'string' ? snapshot.active : 'zh'
      } catch (error) {
        return 'zh'
      }
    }

    function localeStrings(locale) {
      if (String(locale).toLowerCase().startsWith('en')) {
        return {
          balance: 'Balance',
          balanceTitle: 'Balance',
          bonus: 'Bonus',
          bonusShort: '+',
          updated: 'updated',
          updatedAt: 'Updated',
          total: 'Total',
          popHint: 'DeepSeek account balance',
          unavailable: 'Balance unavailable',
          failed: 'Could not read balance',
          filling: 'AI filling in…',
        }
      }
      return {
        balance: '余额',
        balanceTitle: '余额',
        bonus: '赠送',
        bonusShort: '赠',
        updated: '更新',
        updatedAt: '更新于',
        total: '合计',
        popHint: 'DeepSeek 账号余额',
        unavailable: '余额不可用',
        failed: '余额读取失败',
        filling: 'AI 填充中…',
      }
    }

    /** 客户端版本：从侧栏构建徽标读，读不到再用当前 DSH 构建号。 */
    function clientVersion() {
      try {
        const node = document.querySelector('[class*="_buildVersion"]')
        const text = node !== null && node.textContent !== null ? node.textContent.trim() : ''
        const match = text.match(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)
        if (match !== null) return match[0]
      } catch (error) {}
      return '0.2.1-rc.3'
    }

    function symbolFor(currency) {
      const upper = String(currency ?? '').toUpperCase()
      if (upper === 'CNY') return '¥'
      if (upper === 'USD') return '$'
      return upper === '' ? '' : upper + ' '
    }

    function formatMoney(value) {
      const number = Number(value)
      if (!Number.isFinite(number)) return '—'
      const absolute = Math.abs(number)
      if (absolute > 0 && absolute < 0.01) return '<0.01'
      const [whole, cents] = absolute.toFixed(2).split('.')
      const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      return `${number < 0 ? '-' : ''}${grouped}.${cents}`
    }

    function formatTime(date) {
      try {
        return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      } catch (error) {
        return ''
      }
    }

    function formatTimeSeconds(date) {
      try {
        return date.toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      } catch (error) {
        return ''
      }
    }

    // ───────────────────────────────────────────────────────────
    // 余额环
    // ───────────────────────────────────────────────────────────

    const RING_RADIUS = 7
    const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

    /** 健康环的参考上限 / 黄色 / 红色阈值；金额单位与钱包币种一致。 */
    const RING_CEILING = { CNY: 50, USD: 7 }
    const RING_WARN = { CNY: 20, USD: 3 }
    const RING_LOW = { CNY: 10, USD: 1.5 }

    /** 每个余额元素上的数字滚动动画状态；值更新时从旧值缓动到新值。 */
    const NUMBER_ANIMATIONS = new WeakMap()

    function setTextIfChanged(node, text) {
      if (node.textContent !== text) node.textContent = text
    }

    function cancelNumberAnimation(element, key) {
      const state = NUMBER_ANIMATIONS.get(element)
      const slot = state?.[key]
      if (slot !== undefined && slot.raf !== 0) {
        window.cancelAnimationFrame(slot.raf)
        slot.raf = 0
      }
    }

    /**
     * 数字滚动：从当前显示值缓动到目标值，而不是直接替换文本。
     * 这样余额更新时看到的是一段 600ms 的滚动，而不是数字闪一下。
     */
    function animateNumber(element, key, span, target, format) {
      let state = NUMBER_ANIMATIONS.get(element)
      if (state === undefined) {
        state = {}
        NUMBER_ANIMATIONS.set(element, state)
      }
      let slot = state[key]
      if (slot === undefined) {
        slot = { current: null, target: null, raf: 0, format }
        state[key] = slot
      }
      slot.format = format
      const targetText = format(target)
      // 同一个目标值重复绘制（MutationObserver 每次 DOM 变动都会触发）时不要重启动画。
      if (slot.target === target && (slot.raf !== 0 || span.textContent === targetText)) return
      slot.target = target
      if (slot.raf !== 0) {
        window.cancelAnimationFrame(slot.raf)
        slot.raf = 0
      }
      const from = slot.current === null ? target : slot.current
      const reduceMotion =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
      if (reduceMotion || Math.abs(target - from) < 0.005) {
        slot.current = target
        setTextIfChanged(span, targetText)
        return
      }
      const started = window.performance.now()
      const tick = (now) => {
        if (!element.isConnected) {
          slot.raf = 0
          return
        }
        const progress = Math.min(1, (now - started) / 600)
        const eased = 1 - Math.pow(1 - progress, 3)
        const value = from + (target - from) * eased
        slot.current = value
        setTextIfChanged(span, slot.format(value))
        if (progress < 1) slot.raf = window.requestAnimationFrame(tick)
        else {
          slot.current = target
          slot.raf = 0
          setTextIfChanged(span, targetText)
        }
      }
      slot.raf = window.requestAnimationFrame(tick)
    }

    /** 行尾的「金额 + 环」组合；点击打开余额详情。 */
    function createRingElement() {
      const root = document.createElement('span')
      root.className = 'dshn-balance'
      root.dataset.tone = 'loading'
      root.dataset.state = 'loading'
      root.setAttribute('role', 'button')
      root.setAttribute('tabindex', '0')
      root.setAttribute('aria-haspopup', 'dialog')
      root.setAttribute('aria-expanded', 'false')

      const amount = document.createElement('span')
      amount.className = 'dshn-amount'
      amount.hidden = true

      const amountMain = document.createElement('span')
      amountMain.className = 'dshn-amount-main'

      const bonus = document.createElement('span')
      bonus.className = 'dshn-bonus'
      bonus.hidden = true

      amount.appendChild(amountMain)
      amount.appendChild(bonus)

      const ring = document.createElement('span')
      ring.className = 'dshn-ring'
      ring.setAttribute('aria-hidden', 'true')
      ring.innerHTML =
        '<svg viewBox="0 0 20 20" width="18" height="18" focusable="false" aria-hidden="true">' +
        '<circle class="dshn-ring-track" cx="10" cy="10" r="7"></circle>' +
        '<circle class="dshn-ring-arc" cx="10" cy="10" r="7"></circle>' +
        '</svg>'

      root.appendChild(amount)
      root.appendChild(ring)
      return root
    }

    function paintRing(element, view) {
      const arc = element.querySelector('.dshn-ring-arc')
      if (arc !== null) {
        const dashArray = String(RING_CIRCUMFERENCE)
        const dashOffset = String(RING_CIRCUMFERENCE * (1 - view.fraction))
        if (arc.style.strokeDasharray !== dashArray) arc.style.strokeDasharray = dashArray
        if (arc.style.strokeDashoffset !== dashOffset) arc.style.strokeDashoffset = dashOffset
      }

      const amount = element.querySelector('.dshn-amount')
      const main = element.querySelector('.dshn-amount-main')
      const bonus = element.querySelector('.dshn-bonus')
      const detail = view.detail
      const hidden = view.hidden === true

      if (amount !== null && main !== null && bonus !== null) {
        if (hidden) {
          cancelNumberAnimation(element, 'main')
          cancelNumberAnimation(element, 'bonus')
        } else if (detail !== undefined && detail !== null) {
          animateNumber(element, 'main', main, detail.amount, (value) => `${detail.symbol}${formatMoney(value)}`)
          const prefix = typeof detail.bonusPrefix === 'string' ? detail.bonusPrefix : ''
          animateNumber(element, 'bonus', bonus, detail.bonus, (value) => `${prefix}${detail.symbol}${formatMoney(value)}`)
          if (amount.hidden) amount.hidden = false
          if (bonus.hidden) bonus.hidden = false
        } else {
          cancelNumberAnimation(element, 'main')
          cancelNumberAnimation(element, 'bonus')
          const text = typeof view.amountText === 'string' ? view.amountText : ''
          const bonusText = typeof view.bonusText === 'string' ? view.bonusText : ''
          setTextIfChanged(main, text)
          setTextIfChanged(bonus, bonusText)
          bonus.hidden = bonusText === ''
          amount.hidden = text === ''
        }
      }

      if (element.dataset.tone !== view.tone) element.dataset.tone = view.tone
      if (element.dataset.state !== view.state) element.dataset.state = view.state
      if (element.hidden !== hidden) element.hidden = hidden
      if (typeof view.title === 'string' && view.title !== '') {
        if (element.title !== view.title) element.title = view.title
        if (element.getAttribute('aria-label') !== view.title) element.setAttribute('aria-label', view.title)
      }
    }

    /** 找到侧栏底部的原生账号按钮（avatar + label）；DS Bot 模式下不存在。 */
    function findAccountButton() {
      const buttons = document.querySelectorAll('button[aria-haspopup="menu"]')
      for (const button of buttons) {
        const avatar = button.querySelector('[class*="_avatar"]')
        const label = button.querySelector('[class*="_label"]')
        if (avatar !== null && label !== null) return button
      }
      return null
    }

    /**
     * 余额环控制器：单例，挂在插件生命周期上。
     * @param {object} ctx - client plugin context
     */
    function createBalanceRing(ctx) {
      let element = null
      let timer = null
      let observer = null
      let inFlight = false
      let disposed = false
      let lastView = null
      let scheduled = 0
      let version = null
      let probed = false
      let popover = null

      const strings = () => localeStrings(currentLocale(ctx))

      const viewFor = (payload) => {
        const L = strings()
        const wallets = Array.isArray(payload?.value) ? payload.value : []
        const bonusWallets = Array.isArray(payload?.bonusWallets) ? payload.bonusWallets : []
        const primary =
          wallets.find((wallet) => wallet?.currency === 'CNY') ?? (wallets.length > 0 ? wallets[0] : null)
        if (primary === null || typeof primary !== 'object') {
          return { tone: 'unknown', fraction: 0, state: 'unavailable', title: L.unavailable }
        }
        const currency = String(primary.currency ?? '').toUpperCase()
        const amount = Number(primary.balance)
        if (!Number.isFinite(amount)) {
          return { tone: 'unknown', fraction: 0, state: 'unavailable', title: L.unavailable }
        }
        const ceiling = RING_CEILING[currency] ?? RING_CEILING.CNY
        const warn = RING_WARN[currency] ?? RING_WARN.CNY
        const low = RING_LOW[currency] ?? RING_LOW.CNY
        const fraction = Math.max(0, Math.min(1, amount / ceiling))
        const tone = amount >= warn ? 'ok' : amount >= low ? 'warn' : 'danger'

        const symbol = symbolFor(currency)
        const bonus = bonusWallets
          .filter((wallet) => String(wallet?.currency ?? '').toUpperCase() === currency)
          .reduce((sum, wallet) => sum + (Number(wallet?.balance) || 0), 0)
        const amountText = `${symbol}${formatMoney(amount)}`
        // 赠送金额始终展示（包括 0）：用户明确要求余额与赠送同时可见。
        const bonusText = `${L.bonusShort} ${symbol}${formatMoney(bonus)}`
        const now = new Date()
        const parts = [`${L.balance} ${amountText}`, `${L.bonus} ${symbol}${formatMoney(bonus)}`]
        const time = formatTime(now)
        if (time !== '') parts.push(`${time} ${L.updated}`)
        return {
          tone,
          fraction,
          state: 'ready',
          title: parts.join(' · '),
          amountText,
          bonusText,
          detail: {
            symbol,
            amount,
            bonus,
            bonusPrefix: `${L.bonusShort} `,
            total: amount + bonus,
            updatedAt: now,
          },
        }
      }

      const closePopover = () => {
        if (popover === null) return
        popover.remove()
        popover = null
        if (element !== null) element.setAttribute('aria-expanded', 'false')
        document.removeEventListener('mousedown', onDocumentMouseDown, true)
        document.removeEventListener('keydown', onDocumentKeyDown, true)
        window.removeEventListener('resize', closePopover)
        window.removeEventListener('scroll', closePopover, true)
      }

      const onDocumentMouseDown = (event) => {
        if (popover === null) return
        const target = event.target
        if (target instanceof Node && popover.contains(target)) return
        if (element !== null && target instanceof Node && element.contains(target)) return
        closePopover()
      }

      const onDocumentKeyDown = (event) => {
        if (popover === null || event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        closePopover()
      }

      const popoverRow = (label, value) => {
        const row = document.createElement('div')
        row.className = 'dshn-pop-row'
        const key = document.createElement('span')
        key.className = 'k'
        key.textContent = label
        const val = document.createElement('span')
        val.className = 'v'
        val.textContent = value
        row.appendChild(key)
        row.appendChild(val)
        return row
      }

      const renderPopover = (view) => {
        if (popover === null) return
        const L = strings()
        popover.textContent = ''
        const title = document.createElement('div')
        title.className = 'dshn-pop-title'
        title.textContent = L.balanceTitle
        popover.appendChild(title)

        const detail = view?.detail
        if (detail === undefined || detail === null) {
          const message = document.createElement('div')
          message.className = 'dshn-pop-foot'
          message.textContent = view?.title ?? L.unavailable
          popover.appendChild(message)
          return
        }

        const amount = document.createElement('div')
        amount.className = 'dshn-pop-amount'
        amount.textContent = `${detail.symbol}${formatMoney(detail.amount)}`
        popover.appendChild(amount)

        popover.appendChild(popoverRow(L.bonus, `${detail.symbol}${formatMoney(detail.bonus)}`))
        popover.appendChild(popoverRow(L.total, `${detail.symbol}${formatMoney(detail.total)}`))

        const divider = document.createElement('div')
        divider.className = 'dshn-pop-divider'
        popover.appendChild(divider)

        const updated = formatTimeSeconds(detail.updatedAt)
        if (updated !== '') popover.appendChild(popoverRow(L.updatedAt, updated))

        const foot = document.createElement('div')
        foot.className = 'dshn-pop-foot'
        foot.textContent = view.state === 'ready' ? L.popHint : view.title ?? L.failed
        popover.appendChild(foot)
      }

      const openPopover = () => {
        if (disposed || element === null || lastView === null) return
        closePopover()
        const node = document.createElement('div')
        node.className = 'dshn-pop'
        node.setAttribute('role', 'dialog')
        node.setAttribute('aria-label', strings().balanceTitle)
        node.style.visibility = 'hidden'
        document.body.appendChild(node)
        popover = node
        renderPopover(lastView)

        const anchor = element.getBoundingClientRect()
        const size = node.getBoundingClientRect()
        let top = anchor.top - size.height - 8
        if (top < 8) top = anchor.bottom + 8
        let left = anchor.right - size.width
        const maxLeft = window.innerWidth - size.width - 8
        if (left > maxLeft) left = maxLeft
        if (left < 8) left = 8
        node.style.top = `${Math.round(top)}px`
        node.style.left = `${Math.round(left)}px`
        node.style.visibility = ''
        element.setAttribute('aria-expanded', 'true')

        document.addEventListener('mousedown', onDocumentMouseDown, true)
        document.addEventListener('keydown', onDocumentKeyDown, true)
        window.addEventListener('resize', closePopover)
        window.addEventListener('scroll', closePopover, true)
      }

      const togglePopover = () => {
        if (popover === null) openPopover()
        else closePopover()
      }

      const update = (view) => {
        lastView = view
        if (element === null) return
        paintRing(element, view)
        if (popover !== null) renderPopover(view)
      }

      const findAndMount = () => {
        if (disposed || typeof document === 'undefined') return null
        const button = findAccountButton()
        if (button === null) return null
        if (element === null) {
          element = createRingElement()
          element.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
            togglePopover()
          })
          element.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
              event.preventDefault()
              event.stopPropagation()
              togglePopover()
            } else if (event.key === 'Escape') {
              closePopover()
            }
          })
        }
        if (button.getAttribute('data-collapsed') === 'true' || button.getAttribute('data-signed-out') === 'true') {
          element.hidden = true
          closePopover()
          return button
        }
        if (element.parentElement !== button) button.appendChild(element)
        if (lastView !== null) paintRing(element, lastView)
        element.hidden = false
        return button
      }

      const refresh = async () => {
        if (disposed || inFlight) return
        const account = (() => {
          try {
            return ctx.get('remote.account') ?? ctx.get('remote')?.account
          } catch (error) {
            return null
          }
        })()
        if (account === null || typeof account?.getBalance !== 'function') {
          update({ tone: 'unknown', fraction: 0, state: 'unavailable', title: strings().unavailable })
          return
        }
        inFlight = true
        try {
          if (version === null) version = clientVersion()
          const result = await account.getBalance({
            version,
            locale: currentLocale(ctx),
            timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
          })
          if (disposed) return
          if (result?.ok !== true) {
            update({
              ...(lastView ?? { fraction: 0, tone: 'unknown' }),
              state: 'unavailable',
              title: strings().failed,
            })
            return
          }
          const value = result.value
          if (value === null || value === undefined) {
            // 没有账号凭据：不显示余额（与账号菜单的未登录状态一致）。
            if (element !== null) element.hidden = true
            closePopover()
            return
          }
          if (value.status !== 'ready') {
            update({
              ...(lastView ?? { fraction: 0, tone: 'unknown' }),
              state: 'unavailable',
              title: strings().failed,
            })
            return
          }
          const view = viewFor(value)
          update(view)
          if (!probed && view.state === 'ready') {
            probed = true
            const rect = element === null ? null : element.getBoundingClientRect()
            probe('ring', {
              tone: view.tone,
              state: view.state,
              rect:
                rect === null
                  ? null
                  : {
                      x: Math.round(rect.x),
                      y: Math.round(rect.y),
                      w: Math.round(rect.width),
                      h: Math.round(rect.height),
                    },
            })
          }
          findAndMount()
        } catch (error) {
          if (!disposed) {
            update({
              ...(lastView ?? { fraction: 0, tone: 'unknown' }),
              state: 'unavailable',
              title: strings().failed,
            })
          }
        } finally {
          inFlight = false
        }
      }

      const scheduleMount = () => {
        if (disposed || scheduled !== 0) return
        scheduled = window.requestAnimationFrame(() => {
          scheduled = 0
          findAndMount()
        })
      }

      const start = () => {
        ensureStyle()
        findAndMount()
        void refresh()
        timer = window.setInterval(() => {
          findAndMount()
          void refresh()
        }, 5 * 60 * 1000)
        window.addEventListener('focus', scheduleRefresh)
        document.addEventListener('visibilitychange', onVisibility)
        observer = new MutationObserver(scheduleMount)
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-collapsed', 'data-signed-out'],
        })
      }

      const scheduleRefresh = () => {
        if (disposed) return
        void refresh()
      }

      const onVisibility = () => {
        if (document.visibilityState === 'visible') scheduleRefresh()
      }

      const dispose = () => {
        disposed = true
        closePopover()
        if (timer !== null) window.clearInterval(timer)
        if (scheduled !== 0) window.cancelAnimationFrame(scheduled)
        window.removeEventListener('focus', scheduleRefresh)
        document.removeEventListener('visibilitychange', onVisibility)
        observer?.disconnect()
        if (element !== null && element.parentElement !== null) element.parentElement.removeChild(element)
        element = null
        const style = document.getElementById(STYLE_ID)
        if (style !== null) style.remove()
      }

      return { start, refresh, dispose }
    }

    // ───────────────────────────────────────────────────────────
    // 输入框预测
    // ───────────────────────────────────────────────────────────

    const PREDICTION_ENDPOINT = 'api/notch/predict'
    /** 建议超过这个时间就不再生效，避免切回旧会话时看到上一次的残留。 */
    const PREDICTION_TTL_MS = 300_000

    /**
     * 跨会话的建议仓库：根级 manager 写入，会话组件订阅。
     * 组件可能在回合结束后才挂载（切标签、重渲染），所以触发不能依赖组件挂载时机。
     */
    function createPredictionHub() {
      let manager = null
      const listeners = new Set()
      return {
        attach(next) {
          manager = next
        },
        detach() {
          manager = null
        },
        get(sessionId) {
          if (manager === null) return null
          const entry = manager.get(sessionId)
          if (entry === null) return null
          if (Date.now() - entry.at > PREDICTION_TTL_MS) return null
          return entry
        },
        consume(sessionId) {
          manager?.consume(sessionId)
        },
        pending(sessionId) {
          return manager?.isPending(sessionId) === true
        },
        cancel(sessionId) {
          manager?.cancel(sessionId)
        },
        watch(sessionId) {
          manager?.watch(sessionId)
        },
        ensure(sessionId) {
          manager?.ensure(sessionId)
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        notify() {
          for (const listener of [...listeners]) {
            try {
              listener()
            } catch (error) {}
          }
        },
      }
    }

    /**
     * 根级预测管理器：订阅会话运行状态，只在「主视图会话」的回合结束时请求一次建议。
     * 这样即使 composer 在回合结束后才挂载，也能从仓库里拿到刚生成的建议。
     */
    function createPredictionManager(ctx, hub) {
      const suggestions = new Map()
      const inflight = new Map()
      const pending = new Set()
      const pendingTimers = new Map()
      const runningState = new Map()
      /**
       * 用户看过的会话（composer 挂载过 / 曾是主视图）。
       * 只要看过一次，之后它的回合结束就生成建议；即使当时切去别的对话，切回来 5 分钟内也能看到。
       */
      const watchedEver = new Set()
      let previous = new Map()
      let pruneTimer = null
      let watchTimer = null
      let watchPingTimer = null
      let offList = null
      let lastMainSessionId = null
      let disposed = false

      const mainSessionId = () => {
        try {
          const sessions = ctx.get('sessions')
          const list = sessions?.list?.getSnapshot?.()
          const byId = list?.byId ?? {}
          for (const id of Object.keys(byId)) {
            let retained = byId[id]?.retainedBy?.mainView ?? 0
            if (retained === 0 && typeof sessions?.retainInfo === 'function') {
              try {
                retained = sessions.retainInfo(id)?.getSnapshot?.()?.retainedBy?.mainView ?? 0
              } catch (error) {}
            }
            if (retained > 0) return id
          }
        } catch (error) {}
        return null
      }

      /**
       * 主视图会话：优先读 session list 的 retain 信息，读不到时用 composer 挂载上报的
       * `watch()` 结果兜底——用户正在看的 composer 比 list 快照更可靠。
       */
      const resolveMain = () => {
        const main = mainSessionId()
        if (main !== null) lastMainSessionId = main
        return main ?? lastMainSessionId
      }

      /** 告诉 Host「这个会话用户看过」；Host 据此在 turn/end 时主动生成。 */
      const reportWatch = (sessionId) => {
        try {
          void window
            .fetch('api/notch/watch', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId }),
            })
            .catch(function () {})
        } catch (error) {}
      }

      const watch = (sessionId) => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        lastMainSessionId = sessionId
        watchedEver.add(sessionId)
        reportWatch(sessionId)
      }

      /** 只给用户看过的根会话生成；跳过 subagent / child 会话。 */
      const isRootSession = (sessionId) => {
        try {
          const summary = ctx.get('sessions')?.list?.getSnapshot?.()?.byId?.[sessionId]
          if (summary === undefined || summary === null) return true
          if (summary.origin === 'subagent') return false
          if (summary.parentSessionId !== undefined) return false
        } catch (error) {}
        return true
      }

      const request = async (sessionId, options = {}) => {
        if (disposed || inflight.has(sessionId)) return
        const controller = new AbortController()
        inflight.set(sessionId, controller)
        // 慢一点才显示「AI 填充中」：快速跳过/失败时不要闪一下；静默取缓存不显示。
        if (options.quiet !== true) {
          pendingTimers.set(
            sessionId,
            window.setTimeout(() => {
              pendingTimers.delete(sessionId)
              if (disposed || !inflight.has(sessionId)) return
              pending.add(sessionId)
              hub.notify()
            }, 250),
          )
        }
        try {
          const response = await window.fetch(PREDICTION_ENDPOINT, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              cachedOnly: options.cachedOnly === true,
            }),
            signal: controller.signal,
          })
          if (!response.ok) return
          const payload = await response.json().catch(() => null)
          const text = payload?.ok === true && typeof payload.value?.text === 'string' ? payload.value.text : ''
          // 只接受仍然属于这一次请求的结果；新一轮开始后旧结果直接丢掉。
          if (disposed || text === '' || inflight.get(sessionId) !== controller) return
          suggestions.set(sessionId, { text, at: Date.now() })
          hub.notify()
        } catch (error) {
          // 失败静默：预测只是锦上添花，不打扰对话。
        } finally {
          const timer = pendingTimers.get(sessionId)
          if (timer !== undefined) {
            window.clearTimeout(timer)
            pendingTimers.delete(sessionId)
          }
          inflight.delete(sessionId)
          if (pending.delete(sessionId)) hub.notify()
        }
      }

      /** 切回会话时静默取一次 Host 已经生成好的缓存，不再额外生成。 */
      const ensure = (sessionId) => {
        if (disposed) return
        if (typeof sessionId !== 'string' || sessionId === '') return
        if (suggestions.has(sessionId) || inflight.has(sessionId)) return
        void request(sessionId, { cachedOnly: true, quiet: true })
      }

      /** 当前主视图会话记成「看过」；轮询补记，切走/切回都不丢。 */
      const markWatched = () => {
        const main = resolveMain()
        if (main !== null) watchedEver.add(main)
      }

      const scan = () => {
        if (disposed) return
        let snapshot
        try {
          snapshot = ctx.get('uiSession')?.sessionStatus?.getSnapshot?.()
        } catch (error) {
          return
        }
        if (snapshot === undefined || snapshot === null) return
        const main = resolveMain()
        const next = new Map()
        for (const [id, status] of snapshot) {
          const running = status?.running === true
          next.set(id, running)
          runningState.set(id, running)
          const was = previous.get(id) === true
          if (running) {
            suggestions.delete(id)
            if (id === main) watchedEver.add(id)
            const controller = inflight.get(id)
            if (controller !== undefined) {
              controller.abort()
              inflight.delete(id)
            }
          }
          if (was && !running) {
            const watched = id === main || watchedEver.has(id)
            if (watched && isRootSession(id)) void request(id)
          }
        }
        markWatched()
        previous = next
      }

      const start = () => {
        const status = ctx.get('uiSession')?.sessionStatus
        if (status === undefined || typeof status.subscribe !== 'function') {
          probe('prediction-manager-unavailable', {})
          return () => {}
        }
        const snapshot = status.getSnapshot?.() ?? new Map()
        // 初始化基线：启动时已经空闲的会话不触发预测，避免打开旧会话就烧 token。
        previous = new Map()
        runningState.clear()
        for (const [id, value] of snapshot) {
          const running = value?.running === true
          previous.set(id, running)
          runningState.set(id, running)
        }
        const main = resolveMain()
        if (main !== null) watchedEver.add(main)
        const off = status.subscribe(scan)
        const list = ctx.get('sessions')?.list
        if (list !== undefined && typeof list.subscribe === 'function') {
          offList = list.subscribe(markWatched)
        }
        // 切主视图不一定改 session list；轮询兜底，保证「运行期间看过」能记上。
        watchTimer = window.setInterval(markWatched, 500)
        // 周期把当前主视图会话告诉 Host（覆盖 Host 重启后 watched 丢失的情况）。
        watchPingTimer = window.setInterval(() => {
          const main = resolveMain()
          if (main === null) return
          watchedEver.add(main)
          reportWatch(main)
        }, 10_000)
        pruneTimer = window.setInterval(() => {
          let changed = false
          for (const [id, entry] of suggestions) {
            if (Date.now() - entry.at > PREDICTION_TTL_MS) {
              suggestions.delete(id)
              changed = true
            }
          }
          if (changed) hub.notify()
        }, 30_000)
        return () => {
          disposed = true
          off()
          offList?.()
          offList = null
          if (watchTimer !== null) window.clearInterval(watchTimer)
          if (watchPingTimer !== null) window.clearInterval(watchPingTimer)
          if (pruneTimer !== null) window.clearInterval(pruneTimer)
          for (const timer of pendingTimers.values()) window.clearTimeout(timer)
          pendingTimers.clear()
          for (const controller of inflight.values()) {
            try {
              controller.abort()
            } catch (error) {}
          }
          inflight.clear()
          pending.clear()
          suggestions.clear()
          runningState.clear()
          watchedEver.clear()
        }
      }

      return {
        start,
        watch,
        ensure,
        get(sessionId) {
          return suggestions.get(sessionId) ?? null
        },
        consume(sessionId) {
          suggestions.delete(sessionId)
        },
        isPending(sessionId) {
          return pending.has(sessionId)
        },
        cancel(sessionId) {
          const controller = inflight.get(sessionId)
          if (controller !== undefined) {
            try {
              controller.abort()
            } catch (error) {}
            inflight.delete(sessionId)
          }
          const timer = pendingTimers.get(sessionId)
          if (timer !== undefined) {
            window.clearTimeout(timer)
            pendingTimers.delete(sessionId)
          }
          if (pending.delete(sessionId)) hub.notify()
        },
      }
    }

    /**
     * 一个会话一个实例：订阅根级 manager 的建议，在空输入框里展示。
     * props 里的 useInput / useSessionStatus / inputActions 是会话作用域标准 props。
     */
    function PredictionOverlay(props) {
      const {
        sessionId,
        useInput,
        useSessionStatus,
        inputActions,
        refreshBalance,
        predictionHub,
        predictionStrings,
      } = props

      const input = typeof useInput === 'function' ? useInput((state) => state) : undefined
      const running =
        typeof useSessionStatus === 'function'
          ? useSessionStatus((statuses) => statuses.get(sessionId)?.running === true)
          : true

      const draft = typeof input?.draft === 'string' ? input.draft : ''
      const attachmentCount = Array.isArray(input?.attachmentIds) ? input.attachmentIds.length : 0
      const phase = typeof input?.phase === 'string' ? input.phase : 'plain'

      const [suggestion, setSuggestion] = React.useState(null)
      const [pending, setPending] = React.useState(false)
      const containerRef = React.useRef(null)
      const previousRunning = React.useRef(running)
      const latest = React.useRef({})
      latest.current = { draft }

      // 订阅根级 manager：建议可能在组件挂载前就生成好了（切标签/重渲染）。
      React.useEffect(() => {
        if (predictionHub === undefined || predictionHub === null) return undefined
        // composer 挂载就说明用户正在看这个会话；比 session list 快照更可靠。
        predictionHub.watch(sessionId)
        predictionHub.ensure(sessionId)
        const sync = () => {
          const entry = predictionHub.get(sessionId)
          if (entry !== null && latest.current.draft !== '') {
            predictionHub.consume(sessionId)
            setSuggestion(null)
            setPending(false)
            return
          }
          setSuggestion(entry === null ? null : entry.text)
          setPending(predictionHub.pending(sessionId) === true)
        }
        sync()
        return predictionHub.subscribe(sync)
      }, [predictionHub, sessionId])

      // 正在看这个会话且它在跑：持续把它记成「本轮看过」，切走也能补上。
      React.useEffect(() => {
        if (running) predictionHub?.watch(sessionId)
      }, [running, predictionHub, sessionId])

      const cardOf = () => {
        const node = containerRef.current
        return node === null ? null : node.closest('[data-composer-card]')
      }

      // 回合开始时清掉旧建议和加载态；回合结束时顺手刷新余额（预测本身由根级 manager 负责）。
      React.useEffect(() => {
        const was = previousRunning.current
        previousRunning.current = running
        if (running) {
          setSuggestion(null)
          setPending(false)
          predictionHub?.consume(sessionId)
          predictionHub?.cancel(sessionId)
          return
        }
        if (was && typeof refreshBalance === 'function') refreshBalance()
      }, [running, refreshBalance, predictionHub, sessionId])

      // 用户开始输入 / 加附件：建议和「AI 填充中」立刻消失，并终止在途预测。
      React.useEffect(() => {
        if (draft !== '' || attachmentCount > 0) {
          setSuggestion(null)
          setPending(false)
          predictionHub?.consume(sessionId)
          predictionHub?.cancel(sessionId)
        }
      }, [draft, attachmentCount, predictionHub, sessionId])

      const idleEmpty =
        draft === '' && !running && attachmentCount === 0 && (phase === 'plain' || phase === 'inert')
      const showSuggestion = suggestion !== null && idleEmpty
      const showPending = pending === true && suggestion === null && idleEmpty
      const visible = showSuggestion || showPending


      // 隐藏原生 placeholder，并把灰字对齐到它原本的位置。
      React.useEffect(() => {
        const card = cardOf()
        if (card === null) return undefined
        if (visible) {
          card.setAttribute('data-dsh-prediction', '')
          const ghost = containerRef.current
          const placeholder = card.querySelector('[data-composer-placeholder]')
          if (ghost !== null && placeholder !== null) {
            const cardRect = card.getBoundingClientRect()
            const rect = placeholder.getBoundingClientRect()
            ghost.style.top = `${Math.round(rect.top - cardRect.top)}px`
            ghost.style.left = `${Math.round(rect.left - cardRect.left)}px`
            ghost.style.right = `${Math.round(cardRect.right - rect.right)}px`
          }
        } else {
          card.removeAttribute('data-dsh-prediction')
        }
        return () => {
          card.removeAttribute('data-dsh-prediction')
        }
      }, [visible])

      const accept = React.useCallback(() => {
        if (typeof suggestion !== 'string' || suggestion === '') return false
        if (typeof inputActions?.setDraft !== 'function') return false
        try {
          inputActions.setDraft(suggestion)
        } catch (error) {
          return false
        }
        setSuggestion(null)
        predictionHub?.consume(sessionId)
        window.requestAnimationFrame(() => {
          const card = cardOf()
          const editor = card === null ? null : card.querySelector('[data-composer-input]')
          if (editor !== null && typeof editor.focus === 'function') editor.focus()
        })
        return true
      }, [suggestion, inputActions, predictionHub, sessionId])

      // Tab 填入 / Esc 放弃；只在建议可见且焦点在输入框时接管。
      React.useEffect(() => {
        if (!visible) return undefined
        const card = cardOf()
        if (card === null) return undefined
        const editor = card.querySelector('[data-composer-input]')
        if (editor === null) return undefined

        const onKeyDown = (event) => {
          if (event.defaultPrevented || event.isComposing) return
          if (editor.hasAttribute('data-composer-composing')) return
          // 只在光标真的在编辑器里时接管 Tab；焦点在发送按钮等控件上时不劫持。
          if (document.activeElement !== editor) return
          if (event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
            if (!accept()) return
            event.preventDefault()
            event.stopPropagation()
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            setSuggestion(null)
            setPending(false)
            predictionHub?.consume(sessionId)
            predictionHub?.cancel(sessionId)
          }
        }

        editor.addEventListener('keydown', onKeyDown, true)
        return () => editor.removeEventListener('keydown', onKeyDown, true)
      }, [visible, accept, predictionHub, sessionId])

      if (!visible) return null
      if (showPending) {
        const loadingText =
          typeof predictionStrings === 'function' ? predictionStrings().filling ?? 'AI 填充中…' : 'AI 填充中…'
        return React.createElement(
          'div',
          { ref: containerRef, className: 'dshn-ghost', 'aria-hidden': 'true' },
          React.createElement('span', { className: 'dshn-spinner' }),
          React.createElement('span', { className: 'dshn-loading-text' }, loadingText),
        )
      }
      return React.createElement(
        'div',
        { ref: containerRef, className: 'dshn-ghost', 'aria-hidden': 'true' },
        React.createElement('span', { className: 'dshn-ghost-text' }, suggestion),
        React.createElement('span', { className: 'dshn-tab', 'aria-hidden': 'true' }, 'Tab'),
      )
    }

    // ───────────────────────────────────────────────────────────
    // 原功能：把「当前正在看的会话」上报给 Host / 刘海应用
    // ───────────────────────────────────────────────────────────

    function SessionReporter(props) {
      const sessionId = props.sessionId

      React.useEffect(function () {
        probe('mount', {
          sessionId: typeof sessionId === 'string' ? sessionId : null,
          keys: Object.keys(props || {}).slice(0, 30),
          origin: typeof window.location !== 'undefined' ? window.location.origin : '',
        })
        // 只在挂载时报一次，依赖故意留空
      }, [])

      React.useEffect(
        function () {
          if (typeof sessionId !== 'string' || sessionId === '') return undefined
          probe('session', { sessionId })
          reportActive(sessionId)
          return undefined
        },
        [sessionId],
      )

      return null
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        probe('apply', {})
        ensureStyle()

        const balance = createBalanceRing(ctx)
        try {
          balance.start()
        } catch (error) {
          probe('ring-start-error', { message: String(error?.message ?? error) })
        }
        ctx.effect(() => () => balance.dispose(), 'notch-balance.ring')

        // 根级预测 manager：不依赖 composer 何时挂载，回合结束即可生成。
        const predictionHub = createPredictionHub()
        ctx.inject(['uiSession', 'sessions'], function (scope) {
          const manager = createPredictionManager(scope, predictionHub)
          predictionHub.attach(manager)
          scope.effect(function () {
            return manager.start()
          }, 'notch-balance.prediction-manager')
          scope.effect(
            function () {
              return function () {
                predictionHub.detach()
              }
            },
            'notch-balance.prediction-hub',
          )
        })

        // 会话作用域插槽：进入/切换会话时组件重新挂载，于是每次切换都会上报。
        ctx.slots.inject('conversation.composer.dock', function () {
          return ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'notch-session-reporter',
              order: 999,
            },
            SessionReporter,
          )
        })

        // 输入框灰字建议：会话作用域列表插槽，原生 placeholder 的上层。
        ctx.slots.inject('conversation.input.overlay', function () {
          return ctx.slots.register(
            {
              name: 'conversation.input.overlay',
              id: 'notch-composer-prediction',
              order: 5,
            },
            function PredictionSlot(slotProps) {
              return React.createElement(
                PredictionOverlay,
                Object.assign({}, slotProps, {
                  refreshBalance: balance.refresh,
                  predictionHub,
                  predictionStrings: () => localeStrings(currentLocale(ctx)),
                }),
              )
            },
          )
        })
      },
    }
  },
})
