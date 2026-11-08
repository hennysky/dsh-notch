# 插件索引（plugin-index.json）

DSH 0.2.2+ 的「设置 → 插件 → 发现」支持添加**索引源**：粘贴一个索引 JSON 的 URL，
就能在列表里浏览、安装和更新插件。本仓库在根目录提供
[`plugin-index.json`](../plugin-index.json)。

## 用户怎么用

1. DSH → **设置 → 插件 → 发现 → 索引源 → 添加**
2. 粘贴：

   ```
   https://raw.githubusercontent.com/hennysky/dsh-notch/main/plugin-index.json
   ```

   国内可用 Gitee 镜像：

   ```
   https://gitee.com/hennysky/dsh-notch/raw/main/plugin-index.json
   ```

3. 在「发现」中选择 **DSH Notch** → 安装
4. 重启 DSH 生效

索引安装的是**固定 commit** 的 `plugin/` 目录，不依赖 GitHub Release 资产；
发版时更新索引里的版本与 commit 即可。

## 格式

格式 1；字段定义以 DSH 的 `@deepseek-ai/dsh-plugin-market-index` 为准：

```json
{
  "format": 1,
  "title": { "en": "…", "zh": "…" },
  "description": { "en": "…", "zh": "…" },
  "metadata": {},
  "plugins": [
    {
      "name": "dsh-plugin-notch-balance",
      "title": { "en": "DSH Notch", "zh": "DSH Notch 刘海余额" },
      "description": { "en": "…", "zh": "…" },
      "icon": "data:image/svg+xml;base64,…",
      "author": "hennysky",
      "homepage": "https://github.com/hennysky/dsh-notch",
      "repository": {
        "url": "https://github.com/hennysky/dsh-notch",
        "directory": "plugin"
      },
      "metadata": {
        "keywords": ["deepseek-harness", "notch", "balance"]
      },
      "versions": [
        {
          "version": "1.7.1",
          "publishTimestamp": 1794148353,
          "source": {
            "type": "git",
            "url": "https://github.com/hennysky/dsh-notch",
            "commit": "fb922ade92e7f425650f1ac7307aacef407f5ed8",
            "path": "plugin"
          },
          "engines": { "dsh": ">=0.2.1-rc.3" }
        }
      ]
    }
  ]
}
```

约束（DSH 会校验，第一条不满足即失败）：

- `format` 必须是 `1`；
- 插件 `name` 是合法 npm 包名；每个版本 `version` 是精确 SemVer；
- `publishTimestamp` 是 Unix **秒**（整数，0 ≤ ts < 10^11）；
- `source.type` 只能是 `npm` 或 `git`；Git 必须给 40 位小写 commit；
- Git `path` 是相对仓库根目录的目录名，不能含 `.` / `..`；
- `title` / `description` 若用多语言对象，**必须包含 `en`**；
- `icon` 可以是 https URL，也可以是 ≤32 KiB 的 base64 SVG/PNG/JPEG/WebP data URL；
- `versions` 非空，同一插件不能重复版本；DSH 按 SemVer 降序展示。

当前索引内嵌了插件图标（data URL），所以不依赖 raw.githubusercontent 的图标请求。

## 维护者：发布新插件版本

1. 改 `plugin/package.json` 的 `version`，提交并推送；
2. 拿到该提交的完整 SHA：

   ```bash
   git rev-parse HEAD
   ```

3. 在 `plugin-index.json` 的 `versions` 数组**前面**插入新版本：

   ```json
   {
     "version": "1.7.2",
     "publishTimestamp": 1794148353,
     "source": {
       "type": "git",
       "url": "https://github.com/hennysky/dsh-notch",
       "commit": "<完整 40 位 SHA>",
       "path": "plugin"
     },
     "engines": { "dsh": ">=0.2.1-rc.3" }
   }
   ```

4. 本地校验：用 DSH 自带的解析器读一遍（可选，但发版前建议做）：

   ```js
   import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'
   import fs from 'node:fs'
   parseMarketIndex(
     JSON.parse(fs.readFileSync('plugin-index.json', 'utf8')),
     'https://raw.githubusercontent.com/hennysky/dsh-notch/main/plugin-index.json',
   )
   ```

   该包在 DSH 安装目录里（`app.asar` 的 `@deepseek-ai/dsh-plugin-market-index`），
   也可以临时 `npm i @deepseek-ai/dsh-plugin-market-index` 后校验。

5. 推送 `plugin-index.json`。索引 URL 不变，用户刷新「发现」即可看到新版本。

> 索引里保留旧版本便于回退；不需要的版本可以直接删掉。旧 commit 必须仍然可访问，
> 否则该版本安装会失败。
