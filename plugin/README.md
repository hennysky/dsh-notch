# dsh-plugin-notch-balance

DSH 插件：**启动 DeepSeek Harness 时自动拉起 DSHNotch 刘海余额工具。**

## 为什么是「拉起一个应用」而不是「把界面搬进 DSH」

刘海覆盖层要求：窗口层级高于菜单栏、无边框、不抢焦点的 panel、排除出 Exposé 与窗口循环。
这些只有原生 `NSWindow` 能做到；Electron 的 `BrowserWindow` 拿不到那个层级。

所以这个插件的职责是**生命周期管理**，界面仍然由 `DSHNotch.app` 负责。
两者是配套关系，不是替代关系。

## 装什么

| 东西 | 作用 |
|---|---|
| `DSHNotch.app` | 真正的刘海余额界面 |
| 本插件 | 随 DSH 启动，确保上面那个应用在跑 |

## 安装

### 1. 先装应用

`DSHNotch.app` 放到 `/Applications/DSHNotch.app`（插件默认从这里启动）。
装在别处的话，改插件 `config.appPath`。

### 2. 再装插件

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add /path/to/this/directory
```

`dsh plugin` 会做两件事：把包装进 profile，并把 bundle 加进 `dsh.profile.bundles`。

### 3. 重启 DSH

插件在 profile 装载时激活，**需要重启 DeepSeek Harness 生效**。

## 验证它真的工作了

插件把行为写进一份诊断日志（不记任何余额或凭据）：

```bash
cat "$(node -e 'process.stdout.write(require("os").tmpdir())')/dsh-notch-plugin.log"
```

三种可能：

| 日志 | 含义 |
|---|---|
| `已随 DSH 启动：/Applications/DSHNotch.app` | 正常 |
| `已在运行，不重复启动` | 应用本来就在跑（不会画出第二个刘海窗口） |
| `跳过：未找到 <路径>` | 应用不在那个位置，装好或改 `appPath` |

也可以直接看进程：

```bash
pgrep -x DSHNotch
```

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: notch-balance
  name: dsh-plugin-notch-balance
  config:
    appPath: /Applications/DSHNotch.app
    quitOnUnload: false
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `appPath` | `/Applications/DSHNotch.app` | 应用位置 |
| `quitOnUnload` | `false` | 插件卸载时是否同时关掉应用 |

`quitOnUnload` 默认关掉是刻意的：**用户禁用/卸载一个插件，不该顺手杀掉他正在看的窗口。**

## 设计细节

- 用 `pgrep -x DSHNotch` 按**进程名精确匹配**，不用 `pgrep -f`
  - 踩过的坑：`-f` 匹配完整命令行，任何命令行里含有该路径的进程都会被当成
    「应用已在运行」——包括正在 grep 它、正在编辑它的 shell。实测因此误判过一次。
- 用 `open -g -a` 启动：`-g` 不抢前台，`-a` 交给 LaunchServices 走正常启动流程
- 应用不在时**安静跳过**，不报错、不刷屏
- 所有失败都被捕获，插件的任何问题都不会影响 DSH 启动

## 卸载

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop remove dsh-plugin-notch-balance
```

然后在 profile 的 `cordis.patch.yml` 里删掉对应的 `- id: notch-balance` 覆盖项（如果加过）。

## 版本

本插件与 DSHNotch 一起发布，版本号独立。当前 `1.0.0`，配套 DSHNotch 1.3+。
