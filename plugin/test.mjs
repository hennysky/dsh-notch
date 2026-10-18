/**
 * 插件逻辑自检（不依赖 DSH）。
 *
 *   node plugin/test.mjs
 *
 * 覆盖：
 *   1. 进程检测必须用 `pgrep -x`（进程名）而不是 `pgrep -f`（完整命令行）—— 防回归
 *   2. apply() 的三态：未运行则启动 / 已在运行不重复启动 / 路径不存在安静跳过
 *   3. 界面进程被真正拉起，且只有一个实例
 *
 * 会临时启动 /Applications/DSHNotch.app。跑完保留它在运行（本来就是常驻工具）。
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from './index.js'

const APP = '/Applications/DSHNotch.app'
const LOG = path.join(tmpdir(), 'dsh-notch-plugin.log')
const DECOY_PATTERN = 'DSHNotch.app/Contents/MacOS/DSHNotch'

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `\n    ${detail}` : ''}`)
}

const pgrep = (args) => {
  try {
    return execFileSync('/usr/bin/pgrep', args, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const lastLog = () => {
  if (!existsSync(LOG)) return ''
  return readFileSync(LOG, 'utf8').trim().split('\n').at(-1) ?? ''
}

// ── 1. 进程检测的回归护栏 ──
// 造一个 argv 里含完整可执行路径、但进程名不是 DSHNotch 的进程：
// 旧写法 pgrep -f 会把它当成「应用已在运行」，于是根本不启动。

for (const pid of pgrep(['-x', 'DSHNotch'])) {
  try { process.kill(Number(pid), 'SIGTERM') } catch {}
}
await sleep(1000)
check('前置：先确保没有 DSHNotch 在跑', pgrep(['-x', 'DSHNotch']).length === 0)

const decoy = spawn('/usr/bin/env',
  ['python3', '-c', 'import time; time.sleep(30)', DECOY_PATTERN],
  { detached: true, stdio: 'ignore' })
await sleep(800)

const byCommandLine = pgrep(['-f', DECOY_PATTERN])
const byName = pgrep(['-x', 'DSHNotch'])

check('pgrep -f 会被命令行里的路径骗到（所以不能用它）',
  byCommandLine.length > 0,
  `-f 命中 ${byCommandLine.length} 个 pid: ${byCommandLine.join(',')}（诱饵进程名是 python3）`)
check('pgrep -x 不认诱饵，只认进程名',
  byName.length === 0,
  byName.length ? `误命中: ${byName.join(',')}` : '-x 命中 0（正确）')

try { process.kill(-decoy.pid, 'SIGKILL') } catch {}
await sleep(300)

// ── 2. apply() 三态 ──
const ctx = { effect: (fn) => fn() }

rmSync(LOG, { force: true })
check('前置：/Applications/DSHNotch.app 存在', existsSync(APP), APP)

apply(ctx, { appPath: APP })
await sleep(2500)
check('未运行 → 启动', lastLog().includes('已随 DSH 启动'), lastLog())
const afterLaunch = pgrep(['-x', 'DSHNotch'])
check('进程真的起来了', afterLaunch.length === 1, `pid ${afterLaunch.join(',')}`)

apply(ctx, { appPath: APP })
await sleep(1500)
check('已在运行 → 不重复启动', lastLog().includes('已在运行'), lastLog())
check('仍然只有一个实例', pgrep(['-x', 'DSHNotch']).length === 1,
  `实例数 ${pgrep(['-x', 'DSHNotch']).length}`)

apply(ctx, { appPath: '/Applications/DefinitelyNotHere.app' })
await sleep(800)
check('路径不存在 → 安静跳过', lastLog().includes('跳过'), lastLog())

console.log('')
console.log(failed === 0 ? '插件逻辑全部通过' : `${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
