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
    const ReactDOM = require('react-dom')
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
.dshn-pop-footrow{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:6px}
.dshn-pop-topup{display:inline-flex;align-items:center;gap:3px;padding:2px 9px;border-radius:999px;border:0;background:var(--dsw-alias-button-elevated-fill,#3d3e44);color:var(--dsw-alias-label-primary,#e8e8ea);font:inherit;font-size:11px;line-height:16px;cursor:pointer}
.dshn-pop-topup:hover{background:var(--dsw-alias-button-elevated-fill-hover,#4a4b52)}
.dshn-ghost{position:absolute;top:12px;left:14px;right:8px;z-index:4;display:flex;align-items:center;gap:8px;pointer-events:none;user-select:none;color:var(--dsw-alias-label-caption);font-size:inherit;line-height:inherit;white-space:nowrap}
.dshn-ghost-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.9}
.dshn-tab{flex:none;font-size:11px;line-height:16px;padding:0 5px;border-radius:4px;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover);font-family:var(--ds-font-family-code,ui-monospace,monospace)}
.dshn-spinner{flex:none;width:12px;height:12px;border-radius:50%;border:1.5px solid color-mix(in srgb,currentColor 22%,transparent);border-top-color:currentColor;animation:dshn-spin .8s linear infinite}
@keyframes dshn-spin{to{transform:rotate(360deg)}}
.dshn-loading-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:18px;background:linear-gradient(90deg,currentColor 0%,var(--dsw-alias-label-primary,#e8e8ea) 48%,currentColor 96%);background-size:220% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:dshn-shimmer 1.5s linear infinite}
@keyframes dshn-shimmer{from{background-position:120% 0}to{background-position:-120% 0}}
[data-composer-card][data-dsh-prediction] [data-composer-placeholder]{visibility:hidden!important}
@media (prefers-reduced-motion:reduce){.dshn-ring,.dshn-ring-arc,.dshn-pop{transition:none;animation:none!important}.dshn-loading-text{animation:none;background:none;color:var(--dsw-alias-label-caption)}.dshn-spinner{animation-duration:2s}}
/* 设置页：合盖不休眠。沿用 DSH 自己的 design token，深浅色主题都跟着走。 */
.dshn-lid{display:flex;flex-direction:column;width:100%;padding-top:18px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.dshn-lid-head{display:flex;align-items:center;gap:8px;min-width:0}
.dshn-lid-title{margin:0;font-size:16px;line-height:24px;font-weight:500}
.dshn-lid-badge{display:inline-flex;flex:none;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap}
.dshn-lid-badge[data-tone=on]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2fb56a) 14%,transparent);color:var(--dsw-alias-state-success-primary,#2fb56a)}
.dshn-lid-dot{flex:none;width:6px;height:6px;border-radius:50%;background:currentColor}
.dshn-lid-desc{margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dshn-lid-status{margin-top:14px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25))}
.dshn-lid-row{display:flex;align-items:baseline;justify-content:space-between;gap:20px;padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25))}
.dshn-lid-row:last-child{border-bottom:none}
.dshn-lid-row .k{flex:none;color:var(--dsw-alias-label-secondary)}
.dshn-lid-row .v{min-width:0;text-align:right;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.dshn-lid-row .v[data-tone=on]{color:var(--dsw-alias-state-success-primary,#2fb56a)}
.dshn-lid-row .v[data-tone=warn]{color:var(--dsw-alias-state-warn-primary,#f5a524)}
.dshn-lid-row .v[data-tone=error]{color:var(--dsw-alias-state-error-primary,#ef4444)}
.dshn-lid-form{display:flex;flex-direction:column;gap:10px;margin-top:18px;padding-top:14px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25))}
.dshn-lid-form-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshn-lid-choice{display:flex;align-items:flex-start;gap:8px;min-width:0;cursor:pointer}
.dshn-lid-choice input{flex:none;margin:3px 0 0;accent-color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.dshn-lid-choice-body{display:flex;flex-direction:column;min-width:0}
.dshn-lid-choice-title{font-size:13px;line-height:20px}
.dshn-lid-choice-hint{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.dshn-lid-warn{margin-top:2px;padding:8px 10px;border-radius:var(--dsw-radius-md,8px);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f5a524) 10%,transparent);color:var(--dsw-alias-state-warn-primary,#f5a524);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dshn-lid-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:18px}
.dshn-lid-spacer{flex:1 1 0;min-width:0}
.dshn-lid-btn{display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer}
.dshn-lid-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshn-lid-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:2px}
.dshn-lid-btn:disabled{opacity:.5;cursor:default}
.dshn-lid-btn[data-variant=primary]{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-state-business-primary,#4d6bfe));color:var(--dsw-alias-label-primary-foreground,#fff)}
.dshn-lid-btn[data-variant=primary]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill,#4d6bfe))}
.dshn-lid-btn[data-variant=ghost]{border-color:transparent;color:var(--dsw-alias-label-secondary)}
.dshn-lid-btn[data-variant=ghost]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshn-lid-messages{display:flex;flex-direction:column;gap:6px;margin-top:14px}
.dshn-lid-msg{padding:9px 11px;border-radius:var(--dsw-radius-md,8px);border:.5px solid transparent;font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dshn-lid-msg[data-tone=ok]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2fb56a) 10%,transparent);color:var(--dsw-alias-state-success-primary,#2fb56a)}
.dshn-lid-msg[data-tone=error]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 28%,transparent);color:var(--dsw-alias-state-error-primary,#ef4444)}
.dshn-lid-empty{display:flex;flex-direction:column;gap:10px;margin-top:16px}
.dshn-lid-loading{display:flex;align-items:center;gap:8px;padding:12px 0;color:var(--dsw-alias-label-secondary)}
.dshn-lid-callout{padding:12px 14px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dshn-lid-callout[data-tone=warn]{color:var(--dsw-alias-state-warn-primary,#f5a524)}
.dshn-lid-callout[data-tone=error]{color:var(--dsw-alias-state-error-primary,#ef4444)}
.dshn-lid-callout-title{margin-bottom:4px;font-size:13px;line-height:20px;font-weight:500}
.dshn-lid-callout-body{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dshn-lid-hint{margin:10px 0 0;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px;line-height:18px}
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
          topUp: 'Top up',
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
        topUp: '充值',
        failed: '余额读取失败',
        filling: 'AI 填充中…',
      }
    }

    /**
     * 设置页「合盖不休眠」的文案。
     *
     * 默认中文（这个功能只在 macOS 上有意义）；英文只保证 label/title 等界面不出现
     * 未翻译的空洞。文案集中在这里，和余额环的 localeStrings 保持同一种写法。
     */
    function lidSleepStrings(locale) {
      if (String(locale).toLowerCase().startsWith('en')) {
        return {
          label: 'Lid Sleep',
          title: 'Lid Sleep',
          desc: 'Keep the system awake while the lid is closed. The built-in display still turns off when closed; this keeps the system awake and external displays on.',
          refresh: 'Refresh',
          retry: 'Retry',
          on: 'Turn on',
          off: 'Turn off',
          busy: 'Working…',
          loading: 'Reading status…',
          unavailableTitle: 'Host side is not enabled (restart DSH to activate)',
          unavailableHint: 'The settings page is loaded, but the Host has not registered the api/notch/lid-sleep route yet. Restart DSH and open this page again.',
          loadFailed: 'Could not read status',
          loadFailedHttp: (status) => `Could not read status (HTTP ${status})`,
          actionFailedHttp: (status) => `Request failed (HTTP ${status})`,
          requestFailed: 'Could not reach the Host',
          reasonLabel: 'Reason',
          resultFallback: 'The Host returned no detail.',
          rowState: 'Lid behavior',
          rowDesired: 'Configured',
          rowPower: 'Power',
          rowStrategy: 'Strategy',
          rowDisplays: 'External displays',
          rowKeepAwake: 'Keep display awake',
          rowHelper: 'Helper',
          rowTimers: 'Sleep timers',
          stateOn: 'Lid stays awake',
          stateOff: 'Normal sleep',
          stateUnknown: 'Unknown',
          stateOnRaw: (raw) => `Lid stays awake (SleepDisabled=${raw})`,
          stateOffRaw: (raw) => `Normal sleep (SleepDisabled=${raw})`,
          desiredOn: 'Turned on',
          desiredOff: 'Turned off',
          desiredUnknown: 'Not set',
          powerAc: 'Plugged in',
          powerBattery: 'On battery',
          powerUnknown: 'Unknown',
          strategyAcOnly: 'When plugged in (ac-only)',
          strategyAlways: 'Always (always)',
          strategyUnknown: 'Unknown',
          displaysNone: 'None',
          displaysCount: (count) => `${count}`,
          helperReady: 'Installed and running',
          helperStopped: 'Installed, not running',
          helperMissing: 'Not installed',
          keepAwakeOn: 'Enabled',
          keepAwakeOff: 'Disabled',
          timersText: (sleep, displaysleep) => `sleep ${sleep} min · display ${displaysleep} min`,
          strategyLabel: 'Power strategy',
          acOnlyOption: 'When plugged in',
          acOnlyHint: 'On battery the lid closes into normal sleep. This is a plugin strategy, not a native macOS setting.',
          alwaysOption: 'Always',
          alwaysHint: 'Keeps the lid closed awake on battery too, which drains it faster.',
          keepAwakeOption: 'Keep the display awake too',
          keepAwakeHint: 'Changes the AC sleep / displaysleep timers; turning off or unchecking restores the backup.',
          batteryWarning: 'On battery power: staying awake with the lid closed keeps draining. Turn it off before carrying the machine.',
          unsupported: 'This machine is not macOS, so the feature is unavailable.',
          helperMissingHint: 'The background helper is not installed yet: ask the agent to install it in chat, or run install.sh manually as described in docs/lid-sleep.md.',
        }
      }
      return {
        label: '合盖不休眠',
        title: '合盖不休眠',
        desc: '合盖时让系统保持唤醒。合盖时内置屏仍会熄灭；本功能保住的是「系统不睡 + 外接屏常亮」。',
        refresh: '刷新',
        retry: '重试',
        on: '开启',
        off: '关闭',
        busy: '处理中…',
        loading: '正在读取状态…',
        unavailableTitle: 'Host 侧未启用（需重启 DSH 后生效）',
        unavailableHint: '设置页已经加载，但 Host 还没注册 api/notch/lid-sleep 路由。重启 DSH 后再打开本页即可。',
        loadFailed: '状态读取失败',
        loadFailedHttp: (status) => `状态读取失败（HTTP ${status}）`,
        actionFailedHttp: (status) => `操作失败（HTTP ${status}）`,
        requestFailed: '请求 Host 失败',
        reasonLabel: '原因',
        resultFallback: 'Host 没有返回 detail。',
        rowState: '合盖行为',
        rowDesired: '用户设置',
        rowPower: '电源',
        rowStrategy: '策略',
        rowDisplays: '外接屏',
        rowKeepAwake: '同时不熄屏',
        rowHelper: 'Helper',
        rowTimers: '休眠计时器',
        stateOn: '合盖不休眠',
        stateOff: '正常休眠',
        stateUnknown: '未知',
        stateOnRaw: (raw) => `合盖不休眠（SleepDisabled=${raw}）`,
        stateOffRaw: (raw) => `正常休眠（SleepDisabled=${raw}）`,
        desiredOn: '已设为开启',
        desiredOff: '已设为关闭',
        desiredUnknown: '未设置',
        powerAc: '已插电',
        powerBattery: '电池供电',
        powerUnknown: '未知',
        strategyAcOnly: '插电生效（ac-only）',
        strategyAlways: '始终生效（always）',
        strategyUnknown: '未知',
        displaysNone: '无',
        displaysCount: (count) => `${count} 台`,
        helperReady: '已安装并运行',
        helperStopped: '已安装，未运行',
        helperMissing: '未安装',
        keepAwakeOn: '已启用',
        keepAwakeOff: '未启用',
        timersText: (sleep, displaysleep) => `休眠 ${sleep} 分钟 · 熄屏 ${displaysleep} 分钟`,
        strategyLabel: '电源策略',
        acOnlyOption: '插电生效',
        acOnlyHint: '拔电后合盖仍会正常休眠。这是插件策略，不是系统原生能力。',
        alwaysOption: '始终生效',
        alwaysHint: '电池供电时也会保持唤醒，耗电更快。',
        keepAwakeOption: '同时不熄屏',
        keepAwakeHint: '会修改 AC 的 sleep / displaysleep；关闭或取消勾选时按备份恢复。',
        batteryWarning: '当前是电池供电：合盖保持唤醒会持续耗电，带走前建议先关闭。',
        unsupported: '本机不是 macOS，无法使用该功能。',
        helperMissingHint: '后台 helper 还没安装：可以在对话里让 agent 安装，或参考 docs/lid-sleep.md 手工运行 install.sh。',
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

        const footRow = document.createElement('div')
        footRow.className = 'dshn-pop-footrow'
        const foot = document.createElement('div')
        foot.className = 'dshn-pop-foot'
        foot.style.marginTop = '0'
        foot.textContent = view.state === 'ready' ? L.popHint : view.title ?? L.failed
        footRow.appendChild(foot)

        // 充值入口：系统浏览器打开，沿用那边的登录态；链接不带任何 token。
        const topUp = document.createElement('button')
        topUp.type = 'button'
        topUp.className = 'dshn-pop-topup'
        topUp.textContent = L.topUp
        topUp.addEventListener('click', () => {
          window.open('https://platform.deepseek.com/top_up', '_blank', 'noopener,noreferrer')
        })
        footRow.appendChild(topUp)
        popover.appendChild(footRow)
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
     * 跳过原因 → 重试间隔（毫秒）。与 prediction.js 的 PREDICTION_RETRY_PLAN 保持一致。
     *
     * 只重试「过一会儿可能就好了」的原因：回合事件还没写完、Host 主动生成还没落地、
     * 并发打满、网络抖一下。`model-skipped` 是模型自己的判断、`no-cache` 是旧会话没建议，
     * 重试都不会变好，不重试。
     */
    const PREDICTION_RETRY_PLAN = {
      'not-enough-context': [600, 1600],
      busy: [700, 1800],
      failed: [1200],
    }

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
      /** sessionId → 下一次重试的定时器；用户输入/新一轮开始时必须清掉。 */
      const retryTimers = new Map()
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

      /** 清掉某个会话挂着的重试定时器。 */
      const clearRetry = (sessionId) => {
        const timer = retryTimers.get(sessionId)
        if (timer === undefined) return
        window.clearTimeout(timer)
        retryTimers.delete(sessionId)
      }

      /**
       * 按 Host 给的跳过原因排一次重试。
       *
       * 回合刚结束时是预测最不稳定的时刻：会话事件可能还没写完（Host 报
       * `not-enough-context`）。过几百毫秒再问一次通常就有了；`model-skipped`
       * 是模型自己的判断、`no-cache` 是旧会话没有建议，重试都不会变好。
       */
      const retryLater = (sessionId, reason, attempt) => {
        if (disposed || suggestions.has(sessionId)) return
        const delays = PREDICTION_RETRY_PLAN[reason]
        if (!Array.isArray(delays)) return
        const delay = delays[attempt]
        if (delay === undefined) return
        clearRetry(sessionId)
        retryTimers.set(
          sessionId,
          window.setTimeout(() => {
            retryTimers.delete(sessionId)
            if (disposed || inflight.has(sessionId) || suggestions.has(sessionId)) return
            // 重试只取 Host 已有的结果；顺带把窗口内漏生成的回合补上，所以带 cachedOnly。
            void request(sessionId, { cachedOnly: true, quiet: true, attempt: attempt + 1 })
          }, delay),
        )
      }

      const request = async (sessionId, options = {}) => {
        if (disposed || inflight.has(sessionId)) return
        const attempt = Number.isInteger(options.attempt) ? options.attempt : 0
        // 新请求接手：把这一会话挂着的重试清掉，避免同一回合问两次。
        clearRetry(sessionId)
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
          if (disposed || inflight.get(sessionId) !== controller) return
          if (!response.ok) {
            probe('prediction-http-error', { sessionId, status: response.status, attempt })
            retryLater(sessionId, 'failed', attempt)
            return
          }
          const payload = await response.json().catch(() => null)
          if (disposed || inflight.get(sessionId) !== controller) return
          const text = payload?.ok === true && typeof payload.value?.text === 'string' ? payload.value.text : ''
          if (text === '') {
            // Host 明确说明了为什么没建议：能等好的就排一次重试，等不好的就安静收工。
            const reason = typeof payload?.value?.reason === 'string' ? payload.value.reason : 'unknown'
            probe('prediction-skip', {
              sessionId,
              reason,
              cachedOnly: options.cachedOnly === true,
              attempt,
            })
            retryLater(sessionId, reason, attempt)
            return
          }
          clearRetry(sessionId)
          suggestions.set(sessionId, { text, at: Date.now() })
          hub.notify()
        } catch (error) {
          // 我们自己取消的（新一轮开始 / 用户开始输入）不算失败；其它情况再试一次。
          if (controller.signal.aborted !== true) retryLater(sessionId, 'failed', attempt)
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
            clearRetry(id)
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
        // 有的实现会在回合结束时把会话直接从 status map 里摘掉（而不是置 running:false）；
        // 这也算「这一轮结束了」，否则快回合会整个漏掉。
        for (const [id, was] of previous) {
          if (was !== true || next.has(id)) continue
          const watched = id === main || watchedEver.has(id)
          if (watched && isRootSession(id)) void request(id)
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
          for (const timer of retryTimers.values()) window.clearTimeout(timer)
          retryTimers.clear()
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
          clearRetry(sessionId)
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
    // 设置页：合盖不休眠（macOS pmset disablesleep）
    //
    // 页面只在被真正打开时请求 Host：挂载 GET 一次状态，开关走 POST，操作完再 GET
    // 同步。Host 侧路由由 plugin/lid-sleep.js 注册；Host 没重启 / 没注册时这里会
    // 404，显示「Host 侧未启用」而不是报错。成败只看 Host 返回的 ok/reason/detail，
    // 客户端不因为 HTTP 200 或按钮点过就自己判成功。
    // ───────────────────────────────────────────────────────────

    /** Host 路由：同源相对路径（浏览器 bundle，没有 Node API；和余额环/预测同写法）。 */
    const LID_SLEEP_ENDPOINT = 'api/notch/lid-sleep'
    /** POST 在 Host 侧最多等 helper 回执 6s 再 pmset 读回，留足余量再判超时。 */
    const LID_SLEEP_ACTION_TIMEOUT_MS = 20_000
    const LID_SLEEP_STATUS_TIMEOUT_MS = 12_000

    /** 带超时的同源 JSON 请求；返回 HTTP 状态与解析后的 body，网络错误往上抛。 */
    async function requestLidSleep(url, init, timeoutMs) {
      const controller = new AbortController()
      const timer = window.setTimeout(function () {
        try {
          controller.abort()
        } catch (error) {}
      }, timeoutMs)
      try {
        const response = await window.fetch(
          url,
          Object.assign({ credentials: 'same-origin', cache: 'no-store' }, init, {
            signal: controller.signal,
          }),
        )
        let payload = null
        try {
          payload = await response.json()
        } catch (error) {
          payload = null
        }
        return { httpStatus: response.status, httpOk: response.ok, payload }
      } finally {
        window.clearTimeout(timer)
      }
    }

    /** 非 2xx 时优先显示 Host 返回的 detail/error 原文（路由失败会给 error 字段）。 */
    function hostErrorText(response, fallback) {
      const payload = response?.payload
      if (payload !== null && typeof payload === 'object') {
        if (typeof payload.detail === 'string' && payload.detail !== '') return payload.detail
        if (typeof payload.error === 'string' && payload.error !== '') return payload.error
      }
      return fallback
    }

    /**
     * Status 字段 → 设置页展示值。
     *
     * 严格按 §4 的 Status 契约取值：缺字段 / null 一律显示「未知」，绝不按默认值猜。
     * tone 只影响颜色：on=绿、warn=琥珀、error=红。
     */
    function lidSleepViews(L, status) {
      const value = status !== null && typeof status === 'object' ? status : {}
      const sleepDisabled = value.sleepDisabled
      const desired = typeof value.desired === 'string' ? value.desired : 'unknown'
      const power = typeof value.powerSource === 'string' ? value.powerSource : 'unknown'
      const strategy = typeof value.strategy === 'string' ? value.strategy : 'unknown'
      const externalDisplays = value.externalDisplays
      const helperInstalled = value.helperInstalled === true
      const helperRunning = value.helperRunning === true
      const sleep = value.sleep
      const displaysleep = value.displaysleep

      return {
        state:
          sleepDisabled === 1
            ? { text: L.stateOnRaw(1), short: L.stateOn, tone: 'on' }
            : sleepDisabled === 0
              ? { text: L.stateOffRaw(0), short: L.stateOff, tone: 'off' }
              : { text: L.stateUnknown, short: L.stateUnknown, tone: 'unknown' },
        desired:
          desired === 'on'
            ? { text: L.desiredOn, tone: 'on' }
            : desired === 'off'
              ? { text: L.desiredOff, tone: 'off' }
              : { text: L.desiredUnknown, tone: 'unknown' },
        power:
          power === 'ac'
            ? { text: L.powerAc, tone: 'on' }
            : power === 'battery'
              ? { text: L.powerBattery, tone: 'warn' }
              : { text: L.powerUnknown, tone: 'unknown' },
        strategy:
          strategy === 'ac-only'
            ? { text: L.strategyAcOnly, tone: 'off' }
            : strategy === 'always'
              ? { text: L.strategyAlways, tone: 'off' }
              : { text: L.strategyUnknown, tone: 'unknown' },
        displays:
          typeof externalDisplays === 'number' && Number.isFinite(externalDisplays)
            ? externalDisplays > 0
              ? { text: L.displaysCount(externalDisplays), tone: 'off' }
              : { text: L.displaysNone, tone: 'off' }
            : { text: L.stateUnknown, tone: 'unknown' },
        keepAwake:
          value.keepDisplayAwake === true
            ? { text: L.keepAwakeOn, tone: 'on' }
            : { text: L.keepAwakeOff, tone: 'off' },
        helper:
          helperInstalled && helperRunning
            ? { text: L.helperReady, tone: 'on' }
            : helperInstalled
              ? { text: L.helperStopped, tone: 'warn' }
              : { text: L.helperMissing, tone: 'warn' },
        timers:
          typeof sleep === 'number' && Number.isFinite(sleep) && typeof displaysleep === 'number' && Number.isFinite(displaysleep)
            ? { text: L.timersText(sleep, displaysleep), tone: 'off' }
            : null,
      }
    }

    /**
     * 设置页里的「合盖不休眠」。
     *
     * props.strings 返回当前 locale 的文案（由 apply 里的注册闭包提供）：
     * 组件本身不依赖任何 slot prop，设置页外壳传不传 close 都能渲染。
     */
    function LidSleepSettings(props) {
      const L = typeof props?.strings === 'function' ? props.strings() : lidSleepStrings('zh')
      const el = React.createElement

      const [phase, setPhase] = React.useState('loading') // loading | ready | unavailable | failed
      const [status, setStatus] = React.useState(null)
      const [loadError, setLoadError] = React.useState('')
      const [result, setResult] = React.useState(null)
      const [busy, setBusy] = React.useState('') // '' | 'on' | 'off' | 'refresh'
      const [draft, setDraft] = React.useState({ strategy: 'ac-only', keepDisplayAwake: false })

      const alive = React.useRef(true)
      const dirty = React.useRef(false)
      /** 同步的在途标记：按钮 disabled 要等下一次 render，连续点击时用 ref 挡住第二次 POST。 */
      const inFlightRef = React.useRef('')
      const loadingRef = React.useRef(false)
      const statusRef = React.useRef(null)

      const applyStatus = (next) => {
        statusRef.current = next
        setStatus(next)
        // 用户正在改选项时不要被后台刷新覆盖；刷新成功后（dirty 清掉）再对齐服务端状态。
        if (next !== null && dirty.current !== true) {
          setDraft({
            strategy: next.strategy === 'always' ? 'always' : 'ac-only',
            keepDisplayAwake: next.keepDisplayAwake === true,
          })
        }
      }

      /** 读一次状态。404 / 网络错误 = Host 侧没启用（友好提示）；其它 HTTP 错误 = 红字。 */
      const load = async () => {
        if (loadingRef.current) return
        loadingRef.current = true
        try {
          const response = await requestLidSleep(LID_SLEEP_ENDPOINT, { method: 'GET' }, LID_SLEEP_STATUS_TIMEOUT_MS)
          if (!alive.current) return
          if (response.httpStatus === 404) {
            applyStatus(null)
            setPhase('unavailable')
            setLoadError('')
            return
          }
          if (!response.httpOk) {
            // Host 的 500/400 会带 error 文本；优先显示原文，再退回 HTTP 状态。
            setLoadError(hostErrorText(response, L.loadFailedHttp(response.httpStatus)))
            if (statusRef.current === null) setPhase('failed')
            return
          }
          const payload = response.payload
          if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
            setLoadError(typeof payload?.error === 'string' && payload.error !== '' ? payload.error : L.loadFailed)
            if (statusRef.current === null) setPhase('failed')
            return
          }
          applyStatus(payload)
          setPhase('ready')
          setLoadError('')
        } catch (error) {
          if (!alive.current) return
          // fetch 抛错通常就是 Host 不可达（没重启 / 端口变了），按「未启用」处理，不崩。
          applyStatus(null)
          setPhase('unavailable')
          setLoadError('')
        } finally {
          loadingRef.current = false
        }
      }

      /** 刷新按钮：只读，不写请求文件。 */
      const refresh = () => {
        if (inFlightRef.current !== '' || loadingRef.current) return
        inFlightRef.current = 'refresh'
        setBusy('refresh')
        setLoadError('')
        void load().finally(function () {
          inFlightRef.current = ''
          if (alive.current) setBusy('')
        })
      }

      /** 开启/关闭：POST 后无论成败都重新 GET，界面只信 Host 的 ok/reason/detail。 */
      const run = async (action) => {
        if (inFlightRef.current !== '' || loadingRef.current) return
        inFlightRef.current = action
        setBusy(action)
        setResult(null)
        setLoadError('')
        try {
          const response = await requestLidSleep(
            LID_SLEEP_ENDPOINT,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                action,
                strategy: draft.strategy === 'always' ? 'always' : 'ac-only',
                keepDisplayAwake: draft.keepDisplayAwake === true,
              }),
            },
            LID_SLEEP_ACTION_TIMEOUT_MS,
          )
          if (!alive.current) return
          if (response.httpStatus === 404) {
            setLoadError(L.unavailableTitle)
            if (statusRef.current === null) setPhase('unavailable')
            return
          }
          if (!response.httpOk) {
            const detail = hostErrorText(response, L.actionFailedHttp(response.httpStatus))
            setResult({ ok: false, detail, reason: '', warnings: [] })
            return
          }
          const payload = response.payload
          if (payload === null || typeof payload !== 'object') {
            setResult({ ok: false, detail: L.loadFailed, reason: '', warnings: [] })
            return
          }
          setResult({
            ok: payload.ok === true,
            detail: typeof payload.detail === 'string' ? payload.detail : '',
            reason: typeof payload.reason === 'string' ? payload.reason : '',
            warnings: Array.isArray(payload.warnings)
              ? payload.warnings.filter(function (line) {
                  return typeof line === 'string' && line !== ''
                })
              : [],
          })
          // 结果以 Host 为准；这次 GET 只用来同步界面显示的系统状态。
          dirty.current = false
          await load()
        } catch (error) {
          if (!alive.current) return
          setResult({
            ok: false,
            detail: `${L.requestFailed}：${String(error?.message ?? error)}`,
            reason: '',
            warnings: [],
          })
        } finally {
          inFlightRef.current = ''
          if (alive.current) setBusy('')
        }
      }

      // 设置页真正打开（组件挂载）时才请求；卸载后不再 setState。
      React.useEffect(function () {
        alive.current = true
        // 诊断：设置页每打开一次记一行，方便确认「打开设置才请求」这条约定真的生效。
        probe('lid-sleep-settings-mount', {})
        void load()
        return function () {
          alive.current = false
        }
      }, [])

      const views = lidSleepViews(L, status)
      const unsupported = status !== null && typeof status.platform === 'string' && status.platform !== 'darwin'
      const actionDisabled = busy !== '' || unsupported === true

      const head = el(
        'div',
        { className: 'dshn-lid-head' },
        el('h3', { className: 'dshn-lid-title' }, L.title),
        status === null
          ? null
          : el(
              'span',
              { className: 'dshn-lid-badge', 'data-tone': views.state.tone },
              el('span', { className: 'dshn-lid-dot', 'aria-hidden': 'true' }),
              views.state.short ?? views.state.text,
            ),
      )

      const statusRow = (key, label, view) =>
        el(
          'div',
          { className: 'dshn-lid-row', key },
          el('span', { className: 'k' }, label),
          el('span', { className: 'v', 'data-tone': view.tone }, view.text),
        )

      const renderStatus = () => {
        const rows = [
          statusRow('state', L.rowState, views.state),
          statusRow('desired', L.rowDesired, views.desired),
          statusRow('power', L.rowPower, views.power),
          statusRow('strategy', L.rowStrategy, views.strategy),
          statusRow('displays', L.rowDisplays, views.displays),
          statusRow('keep', L.rowKeepAwake, views.keepAwake),
          statusRow('helper', L.rowHelper, views.helper),
        ]
        if (views.timers !== null) rows.push(statusRow('timers', L.rowTimers, views.timers))
        return el('div', { className: 'dshn-lid-status' }, rows)
      }

      const strategyChoice = (value, title, hint) =>
        el(
          'label',
          { className: 'dshn-lid-choice', key: value },
          el('input', {
            type: 'radio',
            name: 'dshn-lid-strategy',
            value,
            checked: draft.strategy === value,
            disabled: actionDisabled,
            onChange: () => {
              dirty.current = true
              setDraft((previous) => Object.assign({}, previous, { strategy: value }))
            },
          }),
          el(
            'span',
            { className: 'dshn-lid-choice-body' },
            el('span', { className: 'dshn-lid-choice-title' }, title),
            el('span', { className: 'dshn-lid-choice-hint' }, hint),
          ),
        )

      const form = el(
        'div',
        { className: 'dshn-lid-form' },
        el('div', { className: 'dshn-lid-form-label' }, L.strategyLabel),
        strategyChoice('ac-only', L.acOnlyOption, L.acOnlyHint),
        strategyChoice('always', L.alwaysOption, L.alwaysHint),
        el(
          'label',
          { className: 'dshn-lid-choice' },
          el('input', {
            type: 'checkbox',
            checked: draft.keepDisplayAwake === true,
            disabled: actionDisabled,
            onChange: (event) => {
              dirty.current = true
              const checked = event?.target?.checked === true
              setDraft((previous) => Object.assign({}, previous, { keepDisplayAwake: checked }))
            },
          }),
          el(
            'span',
            { className: 'dshn-lid-choice-body' },
            el('span', { className: 'dshn-lid-choice-title' }, L.keepAwakeOption),
            el('span', { className: 'dshn-lid-choice-hint' }, L.keepAwakeHint),
          ),
        ),
        // 电池供电时保持唤醒是持续耗电的：状态行给琥珀色之外，再单独提醒一句。
        views.power.tone === 'warn'
          ? el('div', { className: 'dshn-lid-warn', role: 'note' }, `⚠ ${L.batteryWarning}`)
          : null,
      )

      const actions = el(
        'div',
        { className: 'dshn-lid-actions' },
        el(
          'button',
          {
            type: 'button',
            className: 'dshn-lid-btn',
            'data-variant': 'primary',
            disabled: actionDisabled,
            onClick: () => {
              void run('on')
            },
          },
          busy === 'on' ? L.busy : L.on,
        ),
        el(
          'button',
          {
            type: 'button',
            className: 'dshn-lid-btn',
            disabled: actionDisabled,
            onClick: () => {
              void run('off')
            },
          },
          busy === 'off' ? L.busy : L.off,
        ),
        el('span', { className: 'dshn-lid-spacer' }),
        el(
          'button',
          {
            type: 'button',
            className: 'dshn-lid-btn',
            'data-variant': 'ghost',
            disabled: busy !== '' || unsupported === true,
            onClick: refresh,
          },
          busy === 'refresh' ? L.busy : L.refresh,
        ),
      )

      const messageNodes = []
      if (result !== null) {
        const tone = result.ok === true ? 'ok' : 'error'
        const detail =
          result.detail !== ''
            ? result.detail
            : result.reason !== ''
              ? `${L.reasonLabel}：${result.reason}`
              : L.resultFallback
        messageNodes.push(
          el(
            'div',
            { className: 'dshn-lid-msg', 'data-tone': tone, role: tone === 'error' ? 'alert' : 'status', key: 'result' },
            detail,
          ),
        )
        result.warnings.forEach((line, index) => {
          messageNodes.push(el('div', { className: 'dshn-lid-warn', role: 'note', key: `warning-${index}` }, `⚠ ${line}`))
        })
      }
      if (loadError !== '') {
        messageNodes.push(
          el('div', { className: 'dshn-lid-msg', 'data-tone': 'error', role: 'alert', key: 'load-error' }, loadError),
        )
      }
      if (status !== null && typeof status.error === 'string' && status.error !== '') {
        messageNodes.push(
          el('div', { className: 'dshn-lid-msg', 'data-tone': 'error', role: 'alert', key: 'status-error' }, status.error),
        )
      }
      if (unsupported) {
        messageNodes.push(
          el('div', { className: 'dshn-lid-msg', 'data-tone': 'error', role: 'alert', key: 'unsupported' }, L.unsupported),
        )
      }
      const messages = messageNodes.length === 0 ? null : el('div', { className: 'dshn-lid-messages' }, messageNodes)

      let body
      if (status === null) {
        // 还没拿到状态：加载中 / Host 未启用 / 读取失败，三种都只渲染提示，不渲染开关。
        const empty =
          phase === 'loading'
            ? el('div', { className: 'dshn-lid-loading' }, el('span', { className: 'dshn-spinner' }), el('span', null, L.loading))
            : el(
                'div',
                { className: 'dshn-lid-callout', 'data-tone': phase === 'unavailable' ? 'warn' : 'error' },
                el(
                  'div',
                  { className: 'dshn-lid-callout-title' },
                  phase === 'unavailable' ? L.unavailableTitle : loadError !== '' ? loadError : L.loadFailed,
                ),
                phase === 'unavailable' ? el('div', { className: 'dshn-lid-callout-body' }, L.unavailableHint) : null,
              )
        body = el(
          'div',
          { className: 'dshn-lid-empty' },
          empty,
          el(
            'div',
            { className: 'dshn-lid-actions' },
            el(
              'button',
              {
                type: 'button',
                className: 'dshn-lid-btn',
                disabled: busy !== '' || phase === 'loading',
                onClick: refresh,
              },
              busy === 'refresh' ? L.busy : L.retry,
            ),
          ),
          messages,
        )
      } else {
        body = el(
          'div',
          null,
          renderStatus(),
          form,
          actions,
          messages,
          status.helperInstalled !== true ? el('p', { className: 'dshn-lid-hint' }, L.helperMissingHint) : null,
        )
      }

      return el('div', { className: 'dshn-lid' }, head, el('p', { className: 'dshn-lid-desc' }, L.desc), body)
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

    // ───────────────────────────────────────────────────────────
    // 执行过程跟踪：底部状态条 + 步骤时间线
    // ───────────────────────────────────────────────────────────

    const RT_CSS = [
      '.dshn-rt{display:inline-flex;flex-wrap:nowrap;align-items:center;gap:2px 7px;min-width:0;max-width:min(52ch,54vw);white-space:nowrap;padding:2px 5px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;line-height:1.5;cursor:pointer;text-align:left;white-space:normal}',
      '.dshn-rt:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',
      '.dshn-rt-dot{width:6px;height:6px;flex:0 0 auto;border-radius:50%;background:var(--dsw-alias-brand-primary);animation:dshn-rt-pulse 1.4s ease-in-out infinite}',
      '.dshn-rt-dot-idle{animation:none;background:var(--dsw-alias-state-success-primary)}',
      '.dshn-rt-label{min-width:0;flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}',
      '.dshn-rt-meta{flex:0 0 auto;margin-left:auto;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;white-space:nowrap;font-size:11px}',
      '.dshn-rt-panel{position:fixed;z-index:2147483000;width:min(440px,92vw);max-height:52vh;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 12px 32px rgba(0,0,0,.3);overflow:hidden}',
      '.dshn-rt-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dshn-rt-title{font-size:13px;font-weight:600}',
      '.dshn-rt-headmeta{font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dshn-rt-body{overflow:auto;padding:6px 0}',
      '.dshn-rt-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 12px;font-size:12.5px}',
      '.dshn-rt-row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dshn-rt-rowlabel{display:inline-flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshn-rt-step{flex:0 0 auto;min-width:16px;height:16px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:16px;text-align:center;font-variant-numeric:tabular-nums}',
      '.dshn-rt-time{flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dshn-rt-live .dshn-rt-rowlabel{color:var(--dsw-alias-brand-primary)}',
      '.dshn-rt-empty{padding:14px 12px;font-size:12.5px;color:var(--dsw-alias-label-secondary)}',
      '.dshn-rt-hint{padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '@keyframes dshn-rt-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
      '@media (prefers-reduced-motion: reduce){.dshn-rt-dot{animation:none}}',
    ].join('\n')

    function rtElapsed(ms) {
      if (!(ms > 0)) return null
      const total = Math.floor(ms / 1000)
      const s = total % 60
      const m = Math.floor(total / 60) % 60
      const h = Math.floor(total / 3600)
      const pad = (n) => (n < 10 ? '0' + n : String(n))
      if (h > 0) return h + ':' + pad(m) + ':' + pad(s)
      if (m > 0) return m + ':' + pad(s)
      return s + 's'
    }

    function rtTextOf(blocks) {
      if (!Array.isArray(blocks)) return ''
      let out = ''
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue
        const kind = block.kind || block.type
        if (kind !== 'text' || typeof block.text !== 'string') continue
        out += block.text + '\n'
      }
      return out
    }

    function rtJudgmentOf(blocks) {
      const text = rtTextOf(blocks)
      if (text === '') return null
      const lines = text.split('\n')
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const match = /^[▸►▶>]\s*(.+)$/.exec(lines[i].trim())
        if (match && match[1].trim() !== '') return match[1].trim()
      }
      return null
    }

    function rtName(call) {
      if (!call || typeof call !== 'object') return null
      const value = call.name || call.toolName || call.wireName
      return typeof value === 'string' && value !== '' ? value : null
    }

    function rtRow(entry) {
      if (!entry || typeof entry !== 'object') return null
      if (entry.running) {
        const name = rtName(entry.running)
        return {
          key: 'run-' + (entry.running.callId || entry.anchorSeq),
          label: name ? '正在执行 · ' + name : '运行中',
          at: null,
          live: true,
        }
      }
      const node = entry.node
      if (!node || typeof node !== 'object') return null
      const key = 'n-' + (node.key || node.seq || entry.anchorSeq)
      const at = typeof node.time === 'number' ? node.time : null
      switch (node.kind) {
        case 'assistant': {
          const judgment = rtJudgmentOf(node.blocks)
          return {
            key,
            label: judgment || (typeof node.step === 'number' ? '模型第 ' + node.step + ' 步' : '模型输出'),
            at,
            live: false,
            step: typeof node.step === 'number' ? node.step : null,
          }
        }
        case 'tool-result': {
          const name = rtName(node.data && node.data.call) || rtName(node)
          return { key, label: name ? '工具完成 · ' + name : '工具完成', at, live: false }
        }
        case 'model-retry':
          return { key, label: '重试模型请求', at, live: false }
        case 'turn-error':
          return { key, label: '出错', at, live: false }
        case 'turn-max-tokens':
          return { key, label: '达到输出上限', at, live: false }
        default:
          return null
      }
    }

    function useRunTrace(useChat) {
      const nodes = useChat((state) => (state && state.legacy ? state.legacy.nodes : undefined))
      const running = useChat((state) => (state && state.legacy ? state.legacy.runningCalls : undefined))
      const partial = useChat((state) => (state && state.legacy ? state.legacy.partial : undefined))
      const timings = useChat((state) => (state && state.legacy ? state.legacy.turnTimings : undefined))

      const calls = Array.isArray(running) ? running : []
      const isRunning = calls.length > 0 || Boolean(partial)
      const turn =
        partial && typeof partial.turn === 'number'
          ? partial.turn
          : calls.length > 0 && typeof calls[0].turn === 'number'
            ? calls[0].turn
            : null

      let steps = 0
      if (Array.isArray(nodes)) {
        for (const node of nodes) {
          if (node && node.kind === 'assistant' && (turn === null || node.turn === turn)) steps += 1
        }
      }

      const started =
        turn !== null && timings && typeof timings.get === 'function'
          ? (timings.get(turn) || {}).startTime
          : undefined

      const [now, setNow] = React.useState(() => Date.now())
      React.useEffect(() => {
        if (!isRunning) return undefined
        const id = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(id)
      }, [isRunning])

      const spend = typeof started === 'number' && isRunning ? rtElapsed(now - started) : null

      const rows = []
      if (Array.isArray(nodes)) {
        for (const node of nodes.slice(-40)) {
          const row = rtRow({ node: node, anchorSeq: node && node.seq })
          if (row) rows.push(row)
        }
      }
      for (let i = calls.length - 1; i >= 0; i -= 1) {
        const row = rtRow({ running: calls[i], anchorSeq: 'live' + i })
        if (row) rows.push(row)
      }

      const live = partial ? rtJudgmentOf(partial.blocks) : null
      let last = null
      if (Array.isArray(nodes)) {
        for (let i = nodes.length - 1; i >= 0; i -= 1) {
          const node = nodes[i]
          if (!node || node.kind !== 'assistant') continue
          last = rtJudgmentOf(node.blocks)
          if (last) break
        }
      }

      return {
        isRunning,
        spend,
        step: steps + 1,
        judgment: live || last,
        tool: rtName(calls[0]),
        rows: rows.slice(-24),
      }
    }

    function RunTracePill(props) {
      const useChat = props.useChat
      const run = useRunTrace(typeof useChat === 'function' ? useChat : () => undefined)
      const [open, setOpen] = React.useState(false)
      const [anchor, setAnchor] = React.useState(null)
      const rootRef = React.useRef(null)

      if (!run.isRunning) return null

      const head = run.judgment || run.tool || '运行中'
      const meta = [run.spend, '第 ' + run.step + ' 步'].filter(Boolean).join(' · ')

      const toggle = () => {
        if (open) {
          setOpen(false)
          return
        }
        const node = rootRef.current
        if (node && node.getBoundingClientRect) {
          const box = node.getBoundingClientRect()
          setAnchor({
            left: Math.max(12, Math.round(box.left)),
            bottom: Math.round(window.innerHeight - box.top + 10),
          })
        }
        setOpen(true)
      }

      const children = [
        React.createElement('span', { key: 'dot', className: 'dshn-rt-dot', 'aria-hidden': 'true' }),
        React.createElement('span', { key: 'label', className: 'dshn-rt-label' }, head),
        meta ? React.createElement('span', { key: 'meta', className: 'dshn-rt-meta' }, meta) : null,
      ]

      const element = React.createElement(
        'span',
        { ref: rootRef, className: 'dshn-rt-anchor' },
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dshn-rt',
            onClick: toggle,
            'aria-expanded': open ? 'true' : 'false',
            title: '运行中 · ' + head + ' · ' + meta,
          },
          children,
        ),
        open
          ? ReactDOM.createPortal(
              React.createElement(
                'div',
                {
                  className: 'dshn-rt-panel',
                  role: 'dialog',
                  style: anchor
                    ? { left: anchor.left + 'px', bottom: anchor.bottom + 'px' }
                    : { left: '50%', bottom: '160px', transform: 'translateX(-50%)' },
                },
                React.createElement(
                  'div',
                  { className: 'dshn-rt-head' },
                  React.createElement('span', { className: 'dshn-rt-title' }, '执行过程'),
                  React.createElement('span', { className: 'dshn-rt-headmeta' }, meta),
                ),
                React.createElement(
                  'div',
                  { className: 'dshn-rt-body' },
                  run.rows.length === 0
                    ? React.createElement('div', { className: 'dshn-rt-empty' }, '还没有可显示的执行记录。')
                    : run.rows.map((row) =>
                        React.createElement(
                          'div',
                          { key: row.key, className: 'dshn-rt-row' + (row.live ? ' dshn-rt-live' : '') },
                          React.createElement(
                            'span',
                            { className: 'dshn-rt-rowlabel' },
                            row.live
                              ? React.createElement('span', { className: 'dshn-rt-dot', 'aria-hidden': 'true' })
                              : null,
                            row.step !== null && row.step !== undefined
                              ? React.createElement('span', { className: 'dshn-rt-step' }, row.step)
                              : null,
                            row.label,
                          ),
                          row.at
                            ? React.createElement(
                                'span',
                                { className: 'dshn-rt-time' },
                                new Date(row.at).toLocaleTimeString(),
                              )
                            : null,
                        ),
                      ),
                ),
                React.createElement(
                  'div',
                  { className: 'dshn-rt-hint' },
                  '连按两次 Esc 停止本轮 · 直接在输入框打字可以插话纠错',
                ),
              ),
              document.body,
            )
          : null,
      )
      return element
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        probe('apply', {})
        ensureStyle()

        // 执行过程跟踪：底部状态条 + 步骤时间线（会话作用域，随会话挂载卸载）
        ctx.effect(() => {
          if (document.querySelector('style[data-dshn-run-trace]') !== null) return () => {}
          const style = document.createElement('style')
          style.setAttribute('data-dshn-run-trace', '1')
          style.textContent = RT_CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'notch.run-trace.style')
        ctx.slots.inject('conversation.composer.dock', function () {
          return ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'notch-run-trace',
              order: 2,
            },
            RunTracePill,
          )
        })

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

        // 设置页：合盖不休眠。settings.section 是 root scope 的列表 slot，
        // 由设置外壳声明并渲染；没有这个 slot 的组合里 inject 不会执行，天然降级。
        // label 用函数而不是固定字符串：外壳切语言时重新求值，和 DSH 自带设置页一致。
        ctx.slots.inject('settings.section', function () {
          try {
            const dispose = ctx.slots.register(
              {
                name: 'settings.section',
                id: 'notch-lid-sleep',
                order: 60,
                label: () => lidSleepStrings(currentLocale(ctx)).label,
              },
              function LidSleepSettingsSlot(slotProps) {
                return React.createElement(
                  LidSleepSettings,
                  Object.assign({}, slotProps, {
                    strings: () => lidSleepStrings(currentLocale(ctx)),
                  }),
                )
              },
            )
            // 诊断：只记「设置页 slot 注册成功」这一个事实，便于确认 HMR 后新代码真的加载了。
            probe('lid-sleep-settings-registered', {})
            return dispose
          } catch (error) {
            // 注册失败只记诊断，不能让设置页把整个 client 插件拖垮（余额环还在跑）。
            probe('lid-sleep-settings-slot-error', { message: String(error?.message ?? error) })
            return () => {}
          }
        })
      },
    }
  },
})
