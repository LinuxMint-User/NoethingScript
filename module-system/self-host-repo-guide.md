# 自托管模块仓库指南 (nsm / nsmp)

> 本文档说明 NoethingScript 模块仓库的**目录结构**、**清单格式**与 **nsm 的仓库地址约定**，并给出建立官方仓库（GitHub 主 + Gitee 镜像）的步骤。面向仓库维护者；模块作者打包请用 `nsmp`（见 [doc.md](../doc.md) "打包工具 (nsmp)"）。
>
> 关联实现：`modules/main/nsm/nsm/nsm.ns`（管理器）、`modules/main/nsmp/nsmp/nsmp.ns`（打包工具）、设计稿 `design.md` §9.1。

---

## 1. 总体模型

模块仓库**不需要任何服务端逻辑**，是纯静态文件托管（任何 HTTP 服务器 / GitHub raw / Gitee raw 均可）。nsm 只依赖两样东西：

1. **清单**（`catalog/` 目录下）：每个来源一个 JSON 文件，列出该来源全部包及其版本/适配/压缩包文件名；
2. **压缩包**（`packages/` 目录下）：`{包}/{manifest}` + 模块目录 的 zip。

nsm 用 `--repo` 指向仓库**基址**，所有文件按相对路径拼接：`{基址}/{相对路径}`。基址可以是 GitHub raw、Gitee raw、任意 HTTP 服务器的静态目录。

---

## 2. 仓库目录结构

```
NSModules/                        ← 仓库根（基址指向此处）
├── catalog/
│   ├── main.manifest.json        ← main 来源清单（必选）
│   └── extra.manifest.json       ← extra 来源清单（可选）
└── packages/
    ├── greet@0.1.0-v2.7.zip
    ├── hello@0.1.0-v2.7.zip
    └── ...
```

- **来源（source）只有三个分类**：`main` / `extra`（远程仓库清单，各一个文件）+ `custom`（本地 `modules/custom/`，nsm 实时扫描，**不需要**在仓库里）；
- `main.manifest.json` 存在则 `nsm -- refresh main` 可用，`extra.manifest.json` 同理；缺了对应文件，该来源的命令报 404；
- 目录名 `catalog` / `packages` 固定，不能改名。

---

## 3. 清单格式 (catalog/{源}.manifest.json)

```json
{
  "packages": [
    {
      "package": "greet",
      "version": "0.1.0",
      "ns": "2.7",
      "zip": "greet@0.1.0-v2.7.zip"
    },
    {
      "package": "hello",
      "version": "0.1.0",
      "ns": "2.7",
      "zip": "hello@0.1.0-v2.7.zip"
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `package` | 是 | 包名，必须与压缩包内 `manifest.package` 一致（nsm 安装时校验） |
| `version` | 是 | 包版本号 `x.y.z`（nsm 用 `cmpVer` 做升级比较；`update` 安全更新 / `upgrade` 跨适配段升级据此判定） |
| `ns` | 是 | **适配段**，如 `"2.7"`——该包要求解释器版本不低于此段（`verMatches`：适配 ≤ 解释器版本才允许安装；不匹配报"适配不匹配"，`--force` 跳过） |
| `zip` | 是 | 压缩包**文件名**（nsm 直接拼 `packages/` + 此值；文件名惯例见 §4，但以清单为准） |

维护约定：

- 同一 `package` 只保留一个条目即可——nsm 认为清单即"当前可用版本"（没有多版本共存机制）；
- 升级包时：更新清单 `version`/`zip` 指向新压缩包；nsm 检测到已装版本 < 清单版本即可 `update`；
- **跨适配段**（如 `ns` 从 `2.7` 升到 `3.0`）：`update` 安全更新会跳过，须用 `upgrade`（含确认，`--force`/`-y` 跳过）；
- 删除包：从清单移除条目即可（nsm 不主动清理，`remove` 由用户本地执行）。

---

## 4. 压缩包命名与内部结构

### 4.1 命名惯例

```
{包名}@{版本}-v{适配}.zip     例: greet@0.1.0-v2.7.zip
```

这是 `nsmp -- pack` 的默认产物命名。**nsm 实际以清单 `zip` 字段为准**，不解析文件名——只要清单写的文件名与实际文件一致，随意命名也能工作（但请遵守惯例，便于人工核对）。

### 4.2 zip 内部结构

```
greet@0.1.0-v2.7.zip
└── greet/                    ← 顶层目录名 = 包名（关键！nsm 定位 {解压目录}/{包名}/manifest）
    ├── manifest              ← 包清单（JSON，无扩展名）
    ├── greet/
    │   └── greet.ns          ← 主模块 {模块}/{模块}.ns
    └── (可选子模块、README 等)
```

安装时 nsm 会校验：

- 解压后 `{解压目录}/{包名}/manifest` **必须存在**，否则报"不是合法模块包"；
- `manifest.package` 必须等于请求的包名（不一致报错）；
- `manifest.source` 必须等于拉取来源（不一致报"来源不匹配"，`--force` 强制）。

### 4.3 包 manifest 字段（`nsmp` 自动生成，手写仍合法）

```json
{
  "package": "greet",
  "version": "0.1.0",
  "ns": "2.7",
  "source": "main",
  "description": "...",
  "modules": ["greet"],
  "command": ["greet"]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `package` | 是 | 包名 = 包目录名 |
| `version` | 是 | 版本号（与清单 `version` 建议一致） |
| `ns` | 是 | 适配段（与清单 `ns` 建议一致） |
| `source` | 是 | `main` / `extra` / `custom`——决定装到 `modules/{来源}/` 下的哪个目录，**必须与所在清单来源一致** |
| `description` | 否 | `search` 展示用 |
| `modules` | 是 | 模块名列表（每个模块 = `{模块}/{模块}.ns`） |
| `command` | 否 | 命令别名列表（如 `nsm`/`nsmp`；装了该包后可直接 `命令 -- ...` 运行，解释器自动注入 fs/http） |

> 注意：包的**依赖**不写进 manifest——nsm 安装后扫描包内 `use` 语句，自动递归安装依赖（同仓库内找）；`use` 声明在模块 `.ns` 源码里。

---

## 5. nsm 需要的地址链接（--repo 约定）

### 5.1 基址必须是什么

`--repo` 传入的是**仓库内容根目录的 HTTP(S) 地址**，nsm 在其后直接拼相对路径：

```
{基址}/catalog/main.manifest.json      ← 清单
{基址}/packages/{清单 zip 字段}         ← 压缩包
```

必须是**能直接 GET 到文件内容的地址**（即 raw 形式），不是网页浏览地址。常见形式：

| 托管 | 基址写法 |
|---|---|
| GitHub | `https://raw.githubusercontent.com/<owner>/<repo>/<branch>`（如 `.../NoethingScript/NSModules/main`） |
| Gitee | `https://gitee.com/<owner>/<repo>/raw/<branch>`（如 `.../NoethingScript/NSModules/raw/main`） |
| 任意 HTTP 服务器 | `http://主机:端口/静态目录`（如本地测试 `http://127.0.0.1:8765`） |

### 5.2 命令用法

```
# 单基址：显式指定，只用它（不回退）
node dist/noethingScript-Interpreter.js nsm -- install hello --repo http://127.0.0.1:8765

# 多镜像：逗号分隔，按序尝试，失败自动回退下一个
node dist/noethingScript-Interpreter.js nsm -- install hello --repo https://raw.githubusercontent.com/NoethingScript/NSModules/main,https://gitee.com/NoethingScript/NSModules/raw/main

# 不带 --repo：使用默认镜像列表（见 §6）
node dist/noethingScript-Interpreter.js nsm -- install hello
```

- **逗号分隔多基址**：拉取失败（连接失败/404/超时）自动试下一个，全部失败才报错；成功后 `[信息] 已刷新/下载 <- 实际URL` 会打印真实来源；
- **单基址**：显式指定即只用它（不自动回退）；
- `--repo` 对 `refresh` / `install` / `update` / `upgrade` / `check-update` / `check-upgrade` / `search` 统一生效（所有远程操作）。

---

## 6. 镜像配置与默认值

### 6.1 镜像加载优先级

```
--repo 命令行 > 配置文件 {MOD}/.nsm-mirrors.json > 内置默认
```

- **配置文件**（持久）：`{模块目录}/.nsm-mirrors.json`（nsm 运行目录下的 `modules/`），格式：
  ```json
  {
    "mirrors": [
      "https://raw.githubusercontent.com/NoethingScript/NSModules/main",
      "https://gitee.com/NoethingScript/NSModules/raw/main"
    ]
  }
  ```
  上限 4 个，顺序即回退顺序。文件缺失/解析失败/数组为空 → 回退内置默认并打提示。**NS 无法写 JSON**（字符串字面量不转义、引号字符无法表达），配置文件由你手动编辑，nsm 只读；
- **命令行 `--repo`**：临时覆盖，优先级最高；逗号分隔多镜像按序回退，单基址只用它；
- **内置默认**（占位）：`https://raw.githubusercontent.com/NoethingScript/NSModules/main` + `https://gitee.com/NoethingScript/NSModules/raw/main`——**`NoethingScript/NSModules` 仓库尚未建立**，当前所有远程命令走 404 预期路径。

### 6.2 查看生效镜像

```bash
node dist/noethingScript-Interpreter.js nsm -- repos
```

打印当前生效的镜像列表（顺序即回退顺序）及来源提示，排查"走了哪个镜像"时用。

---

## 7. 建立官方仓库步骤

1. **建仓库**：GitHub 创建 `NoethingScript/NSModules`（建议 `main` 分支），建好 `catalog/` 与 `packages/` 目录；Gitee 镜像仓库同名，用 Gitee 的"从 GitHub 导入"或手动推送同步；
2. **打包**：把每个包目录用 `nsmp` 打包（自动生成 manifest + 打出 `{包}@{版本}-v{适配}.zip`）：
   ```bash
   node dist/noethingScript-Interpreter.js nsmp -- pack ./greet --out ./packages --desc "..."
   ```
   把 zip 放入 `packages/`，包目录本身的 manifest 不直接进仓库根（zip 内已含）；
3. **自动生成清单**：`nsmp gen-catalog` 扫描 `packages/` 全部 zip，逐个解压读包内 manifest 汇总生成 `catalog/{源}.manifest.json`（按包名排序；`--source` 指定源，默认 `main`；包内 `manifest.source` 与目标源不一致时告警——nsm 安装会校验并拒绝，需先修正）：
   ```bash
   node dist/noethingScript-Interpreter.js nsmp -- gen-catalog ./packages --out ./catalog --source main -y
   # 发布 extra 来源的包时: --source extra
   ```
   无需手写清单；新增/升级包后重跑本命令即更新；
4. **推送**：GitHub 与 Gitee 同步推送；
5. **验证**：见 §8 本地验证 + 真实测试。

> 依赖规则：`main` 来源的包可以依赖 `extra`/`main` 的包，`extra` 同理（nsm 在全部远程清单中找依赖）。依赖包必须也在仓库某来源的清单里。

---

## 8. 本地验证（模拟远程）

不建远程仓库也能完整验证 nsm 远程能力：

```bash
# 1. 搭目录（与真实仓库完全同构）
mkdir -p /tmp/nsrepo/catalog /tmp/nsrepo/packages

# 2. 起静态服务器
python3 -m http.server 8765 --directory /tmp/nsrepo

# 3. 让 nsm 指向它
node dist/noethingScript-Interpreter.js nsm -- refresh main --repo http://127.0.0.1:8765
node dist/noethingScript-Interpreter.js nsm -- install hello --repo http://127.0.0.1:8765

# 4. 模拟镜像回退：坏基址 + 好基址
node dist/noethingScript-Interpreter.js nsm -- refresh main --repo http://127.0.0.1:59999,http://127.0.0.1:8765
```

---

## 9. 常见问题排查

| 现象 | 原因/排查 |
|---|---|
| `[错误] 拉取清单失败 (已尝试全部镜像): catalog/main.manifest.json` | 基址不对（非 raw 根）或文件路径不对。用 `curl {基址}/catalog/main.manifest.json` 直接验证能否 GET |
| `[错误] 下载失败: xxx (全部镜像不可达)` | `packages/` 下没有清单 `zip` 字段指的那个文件 |
| `[错误] 压缩包内无包根 {包}/manifest` | zip 内顶层目录名 ≠ 包名（须为 `{包}/manifest`），用 `unzip -l` 检查 |
| `[错误] 包名不一致` | zip 内 `manifest.package` ≠ 请求的包名 |
| `[错误] 已阻止安装 (来源不匹配)` | zip 内 `manifest.source` ≠ 拉取来源（如清单是 main 但包声明 extra） |
| `[错误] 适配不匹配: xxx 需要 NS 2.7+, 当前解释器 2.7.4` | 清单 `ns` 段高于解释器版本；升级解释器或降适配段 |
| `update` 提示已是最新但清单改了 | 清单缓存 TTL 7 天；`check-update` / `check-upgrade` 默认强制刷新，或 `refresh` 手动刷新 |

---

## 附：与实现的对应关系（供维护者核对）

| 指南描述 | nsm.ns 实现 |
|---|---|
| 基址列表 `MIRROR[]` + 逗号分隔拆分 | `splitMirrors` / `downloadRetry` |
| 相对路径拼接 `{基址}/{rel}` | `mirrorUrl(idx, rel)` |
| 清单读取 | `loadCatalogCache` → `fs.readJsonTable(cache, "packages", ...)`（字段 package/version/ns/zip） |
| zip 定位 `packages/{zip字段}` | `installPkgRemote` 中 `rel = "packages/" + zipName` |
| zip 内部 `{包}/manifest` + 校验 | `installPkgRemote`（存在性/包名/来源/适配检查） |
| 依赖递归 | 安装后 `scanPkgDeps` → 递归安装（上限 10 层防循环） |
| 缓存 TTL 7 天 | `loadCatalog` / `TTL`，超期自动重拉失败回退旧缓存 |
