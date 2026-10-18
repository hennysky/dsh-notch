/**
 * DSH 插件：让刘海余额工具跟着 DeepSeek Harness 一起启动。
 *
 * ── 为什么是「拉起一个原生应用」而不是把界面搬进 DSH ──
 *
 * 刘海覆盖层要求：窗口层级高于菜单栏、无边框、不抢焦点的 panel、
 * 排除出 Exposé 与窗口循环。这些只有原生 NSWindow 能做到；
 * Electron 的 BrowserWindow 拿不到那个层级，也不会被系统当作「刘海上的东西」。
 *
 * 所以这个插件的职责是**生命周期管理**：DSH 启动时确保那个原生应用在跑。
 * 界面仍然由 DSHNotch.app 负责。
 *
 * ── 行为 ──
 *
 * 插件激活（= DSH 启动 / 插件被启用）时：
 *   1. 应用不存在 → 记一条日志，不做任何事（不报错，不刷屏）
 *   2. 已经在运行 → 不重复启动（否则会画出第二个刘海窗口）
 *   3. 否则 → 用 `open -g` 拉起（-g 表示不抢前台）
 *
 * 插件卸载时：只有显式配了 quitOnUnload: true 才收掉应用。
 * 默认 false —— 用户关掉一个插件不该顺手杀掉他正在看的窗口。
 */

import { execFile } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
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

const DEFAULTS = {
  /** 应用位置。可以在 cordis.patch.yml 的 config 里改。 */
  appPath: '/Applications/DSHNotch.app',
  /** 插件卸载时是否同时收掉应用。 */
  quitOnUnload: false,
}

/**
 * 诊断日志。
 *
 * 打包后的 Harness 是 GUI 应用，插件的 console 输出不一定有人看得到，
 * 所以同时写一份到临时目录，便于排查「插件到底有没有跑」。
 * 只记插件自己的行为，不记任何余额或凭据。
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

export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...config }

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
