# 插件打包（dsh-plugin-packer）

把一个插件连同它的 **node 依赖闭包**，以及可选的**运行时环境**，打成一个可离线导入的 `.dsh-plugin.zip`；导入时铺回 `node_modules` 并按需重建环境。

普通插件只带代码就够，但**真正重量在运行时环境里**的插件不够：

> 有的插件本体只有几百 KB，却依赖机器上另外一份工具环境、模型文件或数据目录（动辄上百 MB）。只打代码的包换台机器打开后，依赖面板只会说「未安装」，点安装又要联网。

所以这个打包器多一层：**运行时资产（runtime asset）**。插件可以声明「我还需要这份环境」，导出时它跟着 zip 走，导入时**无网**重建并激活。

## 打包格式

| 场景 | 导出格式 | 能否导入 |
| --- | --- | --- |
| 普通插件（无资产声明） | **format 1** | ✅ |
| 带运行时资产的插件 | format 2 | ✅ |

- 没有资产声明的包**始终写成 format 1**，旧工具也读得懂，体积也更小。
- 导入**同时接受 format 1 和 format 2**：历史包照常能装。
- 只有声明过资产的插件才会变成 format 2；读不了 format 2 的工具会明确报错，不会静默装半截。

## 安装

从 npm 安装（发布在 `registry.npmjs.org`）：

```bash
npm i dsh-plugin-packer
```

装完把 `dsh-plugin-packer` 加进 profile 的 `package.json`：

```json
{
  "dependencies": { "dsh-plugin-packer": "^2.1.0" },
  "dsh": { "profile": { "bundles": ["...", "dsh-plugin-packer"] } }
}
```

然后**完全退出 DSH 再重开**——host 路由与设置页标签都在启动时挂载。装好后：设置 → 插件 → **插件打包**，接口挂在 `/plugin-packer/api`。

不想走 npm 也可以：`node tools/pack-self.mjs` 打出一个 zip，在设置页「导入 zip」装进去。

## 使用

- **设置 → 插件 → 插件打包**：一键列出 profile 里的全部包，每行带版本、体积、**安装日期**与**更新时间**（相对时间 + 日期），可按更新时间 / 安装日期 / 名称 / 体积 / 状态 / 版本排序，也可按「全部 / 可导出 / 已启用 / 未启用 / 应用内置」筛选。
- **多选批量打包**：每行一个勾选框，支持「全选当前视图」，选好后点「打包选中（N）」，逐个打包并逐个下载（文件名带版本与日期，如 `dsh-foo-2.1.0-20261122.dsh-plugin.zip`）。浏览器第一次可能询问「是否允许多个文件下载」，选允许即可。
- **检查最新版本**：主动向 npm registry 查一次已安装包的 `latest`，每行显示「已是最新 / 最新 vX.Y.Z / 未发布到 npm / 最新版本未知」。开发中用 `link:` 挂进来的插件显示「未发布到 npm」是正常的。
- `GET /plugin-packer/api/list?sort=<name|installed|updated|size|status|version>&order=<asc|desc>` —— 插件清单（每行带 `assets` 数量、`installedAt`、`updatedAt`、`bytes`、`files`，响应带 `totals` 汇总）
- `GET /plugin-packer/api/latest?names=<包名,包名>` —— 查 npm 上的最新版本（逐个上报失败原因，离线时返回 `offline`）
- `GET /plugin-packer/api/export?name=<包名>` —— 导出 zip（含声明的资产）
- `POST /plugin-packer/api/import` —— 导入 zip（请求体就是 zip），响应多了 `backupsPruned`
- `GET /plugin-packer/api/assets` —— 本机资产状态（装没装、期望路径在不在）
- `GET /plugin-packer/api/health` —— 版本与格式 / 是否支持资产

## 资产声明（可选，通用机制）

打包器本身不认识任何具体插件。如果某个插件的重量在 `node_modules` 之外——工具环境、模型文件、数据目录——就在 profile 里给它写一份声明，导出时一起带走、导入时无网重建：

`<profile>/.plugin-packer/assets/<插件名>.json`

```json
{
  "version": 1,
  "plugin": "my-plugin",
  "assets": [
    {
      "id": "my-plugin-env",
      "kind": "offline-env",
      "label": "my-plugin 的离线运行时",
      "bundleDir": "/path/to/built/runtime",
      "installDir": "<DSH_HOME>/plugin-packer/assets/my-plugin-env",
      "install": {
        "executable": "installer/run.exe",
        "args": ["--offline", "--prefix", "<ASSET>"],
        "env": { "OFFLINE": "1" },
        "cwd": "<ASSET>",
        "expect": ["<DSH_HOME>/my-plugin/runtime/bin"]
      },
      "postInstall": { "script": "activate.mjs" }
    }
  ]
}
```

字段语义：

| 字段 | 说明 |
| --- | --- |
| `bundleDir` | 打包机上的**源目录**，整个目录进 zip 的 `assets/<id>/`。只写在这里，不会进清单（清单里不出现任何机器路径）。 |
| `installDir` | 导入机上的**落点**，必须绝对路径（占位符展开后）。**会长期保留**：运行时环境里的自引用路径指回这里，删了环境就废。 |
| `install.executable` | 资产**内部**的可执行文件（相对 `installDir`），禁止指向资产外。 |
| `install.args` | 参数数组，不经 shell。`--index-url` / `--upgrade` 这类联网开关会被拒绝——离线包不许偷偷下载。 |
| `install.env` | 子进程环境，支持占位符。打包器另会注入 `DSH_HOME` / `DSH_PROFILE_DIR` / `DSH_PLUGIN_DIR` / `DSH_ASSET_DIR`。 |
| `install.expect` | 装完必须存在的路径；缺一个就判定失败（不靠退出码猜）。 |
| `postInstall` | 装完跑一个**资产内**的 Node 脚本，用来激活：写状态、指向配置。 |
| `keep` | 标记该资产目录必须保留（默认 true 语义，删了要报错）。 |

占位符：`<DSH_HOME>`、`<PROFILE>`、`<ASSET>`、`<PLUGIN_DIR>`。

没有声明文件的插件就是普通包：只打 `package.json#files` 与依赖闭包，导出为 format 1。
## 安全边界

- 服务只监听回环：非 `127.0.0.1`/`::1` 一律 403；拒绝 `sec-fetch-site: cross-site`。
- 导入请求体上限 512 MiB（`maxImportBytes` 可配）。
- 资产里的命令只允许**资产内部**的可执行文件；路径逃逸（`..`）直接拒绝；不许进 `node_modules`。
- 不经过 shell：`spawn(exe, args)`，参数是数组。
- 联网开关（`--index-url` 等）在声明阶段就被拒。
- 天然信任边界：导入一个包 = 把它的代码放进 profile，资产与插件同权。只导入你信任的包。

## 磁盘占用（2.1.0 起收口）

这个仓库曾经吃到 2.5 GB，原因不在运行时，而在**测试残留**：测试脚本把「一次性的
DSH home」建在仓库里的 `build/tmp/`，导入又会重建整套运行时环境，跑几轮就攒出
多份副本；`build/dist/` 里还躺着几份大 zip。

2.1.0 的修正：

- 测试脚本改用 `os.tmpdir()` 下的 `mkdtemp`，并在结束时删掉整棵临时 home；
- 新增 `npm run clean`（删 `build/tmp`、`build/dist`）与 `npm run clean:all`
  （再加 `build/pipenv`、`build/stage`），并附 `.gitignore`；
- 导入时只保留最近 **5 批**备份（`<profile>/.plugin-packer/backups`），更旧的自动清理，
  避免每次换版本都留一整套旧环境。

当前仓库约 250 KB：纯代码、测试与文档，不再携带任何具体插件的运行时资产源。

### 别把「源码目录体积」当成插件体积

- **发布/安装体积**：npm 包约 38 KB，解压 124 KB（只有 `lib/`、`README`、`LICENSE`、`cordis.patch.yml`）。
- **导出的插件包**：按 `package.json#files` 白名单打包，普通插件几十 KB 级；只有声明了运行时资产的包才会大，大小取决于那份资产。

用 `link:` 挂进 profile 的插件，设置页那一行显示的是**源码目录**的总占用；行内会标注
「（源码目录）」「链接目录」，鼠标悬停有说明。真实安装进 `node_modules` 的插件显示的是安装体积本身。

## 已知限制

- **format 2 不能被只认 format 1 的旧工具导入**；跨格式只能向上兼容。
- 运行时资产会长期占位：体积取决于资产本身；删掉 `<DSH_HOME>/plugin-packer/assets/<id>` 会破坏已经建好的环境。
- 导入是覆盖式：旧的同一资产目录会被移到 `<profile>/.plugin-packer/backups/assets-<时间戳>/`。
- 资产装好了但激活钩子写不进配置时（比如 profile 归属有歧义），钩子**不失败**，退出码 0 并输出说明；按该插件自己的设置页重新指向即可。
- 浏览器半的改动：重启 DSH 才会挂上路由与标签页。

## 目录

- `lib/packer.js` —— 闭包/清单/导入核心：依赖闭包、format 1/2、资产块、安装/更新时间与排序、备份保留策略。
- `lib/assets.js` —— 资产声明校验、打包暂存、导入安装、命令执行、状态查询。
- `lib/index.js` —— 回环 HTTP 路由（list / latest / export / import / assets / health）。
- `lib/client.js` —— 设置页标签页（时间列、排序筛选、多选批量打包、检查最新版本）。
- `lib/zip.js` —— STORE/DEFLATE 的流式 zip 读写（无外部依赖）。
- `tools/pack-self.mjs` —— 用本包的库把源码目录打成 format 1 包（无需外部依赖）。
- `tools/clean.mjs` —— 清理测试/构建残留，`npm run clean`。
- `test/catalogue.mjs` / `test/export.mjs` / `test/import.mjs` / `test/plain-plugin.mjs` —— 目录接口、导出、冷导入、普通插件兼容性自检。

## 测试

```bash
node test/catalogue.mjs      # 快：清单字段、排序、/api/list 与 /api/latest（秒级）
node test/plain-plugin.mjs   # 普通插件仍是 format 1，且能导入
node test/export.mjs         # 导出结构：包文件 / 清单 / 无机器路径
node test/import.mjs <zip>   # 空 DSH_HOME 冷导入：铺包 + 依赖写入 + 资产（若有）
```

`test/import.mjs` 会自己造一个临时 `DSH_HOME` 与 profile（在系统临时目录），不动你正在跑的 profile，跑完不留垃圾。
