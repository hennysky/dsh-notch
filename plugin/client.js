/**
 * DSH Client UI 插件：把「当前正在看的会话」上报给 Host 插件。
 *
 * 为什么需要它：Host 进程不知道 Web UI 上正显示哪个会话，只能拿「最近活跃」猜；
 * 切到一个旧会话再点 DSHNotch 就会显示错。这个组件注册在会话作用域的
 * `conversation.input.right` 插槽里，props 自带 `sessionId`，变化时 POST 给宿主。
 *
 * 组件不可见（返回 null），不改变任何 UI。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-notch-balance',
  factory(require) {
    const React = require('react')

    function SessionReporter(props) {
      const sessionId = props.sessionId

      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined
        const controller = new AbortController()
        window
          .fetch('/api/notch/active-session', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
            cache: 'no-store',
            signal: controller.signal,
          })
          .catch(() => {
            // DSH 还没装载 Host 插件、或页面正在卸载：静默失败，下一次切换会再报。
          })
        return () => controller.abort()
      }, [sessionId])

      return null
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 会话作用域插槽：进入/切换会话时组件重新挂载，于是每次切换都会上报。
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.right',
              id: 'notch-session-reporter',
              order: 100,
            },
            SessionReporter,
          ),
        )
      },
    }
  },
})
