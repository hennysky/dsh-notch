/**
 * DSH Client UI 插件：把「当前正在看的会话」上报给 Host 插件。
 *
 * 为什么需要它：Host 进程不知道 Web UI 上正显示哪个会话，只能拿「最近活跃」猜；
 * 切到一个旧会话再点 DSHNotch 就会显示错。这个组件注册在会话作用域的
 * `conversation.composer.dock` 插槽里，props 自带 `sessionId`，变化时上报。
 *
 * 上报走两条路，互为兜底：
 * 1. 同源 `POST /api/notch/active-session`（Host 插件路由；桌面版网关可能要求鉴权）
 * 2. 直连 DSHNotch 本地桥 `POST http://127.0.0.1:47810/active-session`（带 CORS）
 *    桥写 ~/.dsh/notch/active-session.json，Host 插件轮询该文件。
 * 两条路都失败也不影响 UI；同时会把诊断探针写到 ~/.dsh/notch/client-probe.log。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-notch-balance',
  factory(require) {
    const React = require('react')
    const BRIDGE = 'http://127.0.0.1:47810'

    function post(url, body) {
      return window.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      })
    }

    /** 诊断探针：两条通道都发一份，哪条通就知道链路卡在哪。 */
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
      try {
        void post('/api/notch/active-session', { sessionId }).catch(function () {})
      } catch (error) {}
      try {
        void post(BRIDGE + '/active-session', { sessionId }).catch(function () {})
      } catch (error) {}
    }

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
      },
    }
  },
})
