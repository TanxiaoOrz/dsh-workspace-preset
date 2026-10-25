# dsh-workspace-preset

> 按工作区指定**新会话**打开时使用的 agent preset。
> 未配置的工作区回落到宿主的全局默认，行为与未安装本插件时完全一致。

宿主基线：`@deepseek-ai/dsh-web-app 0.2.0-rc.2`（`@deepseek-ai/cordis 4.0.4`）。

> **状态**：Host 与 Client 两侧均已实现，程序化测试 93 条全绿（纯逻辑 41 / 客户端结构 31 / Host 端到端冒烟 21）。
> **真机验收尚未进行** —— 真实会话创建、真实 `agentPresets.select`、设置页真实渲染还没在浏览器里跑过。
> 历史设计文档留在 [`docs/`](docs/)，它们记录的是**实现前的取证与方案**，与最终代码有少量偏差（见文末「与设计文档的偏差」）。

---

## 它解决什么

现状：「新会话默认预设」是**全局一个值**（`agentPresetRegistry` 的
`config.default` / `config.selectedDefault`），一份值管所有 profile、所有工作区。
于是写代码的工作区和写文档的工作区只能共用一个默认预设，每次都要手动改。

本插件让**每个工作区各自**指定新会话初始 preset：

```
设置 → 工作区预设
┌───────────────────────────────────────────────┐
│ 当前全局默认：标准                             │
│                                               │
│ D:\Program Code\plugins         [ 跟随全局 ▾ ] │
│ D:\agent\DeepseekHarness        [ 创造    ▾ ] │
└───────────────────────────────────────────────┘
```

- 下拉第一项「跟随全局默认」= 该键**从 patch 里消失**（不是写空串）
- 改动即刻生效，没有"保存"按钮
- 总开关关掉后，行为完全等于未安装

---

## 安装

本插件是一个 DSH **bundle 插件**（`package.json` 里带 `dsh.bundle` 与 `dsh.client`）。

### 方式一：`dsh plugin add`（推荐）

```powershell
dsh plugin --profile web add github:TanxiaoOrz/dsh-workspace-preset
```

**这一条命令就够了**，不用再手工改任何文件：

| 它替你做的事 | 说明 |
|---|---|
| 装依赖 | 转给 pnpm 在 profile 目录里跑 `add` |
| **自动加入 `dsh.profile.bundles`** | 安装成功后 `reconcile()` 发现这个新依赖带 `dsh.bundle`，就把它追加进 bundles 数组 |
| 校验补丁文件 | 对 `dsh.bundle.patch` 声明的每个补丁文件跑一遍 `loadOverlayPatches`，坏补丁当场报错而不是启动时炸 |
| 校验 peer 兼容性 | 不兼容会给出 `dsh plugin allow-version` 的提示，而不是默默装上一个会崩的版本 |

装完**重启 `dsh web`**，打开「设置 → 工作区预设」。

卸载同样是命令，**也会自动把 bundles 里的项删掉**：

```powershell
dsh plugin --profile web remove dsh-workspace-preset
```

> `dsh plugin` 的第一个 `--profile` 是它的必需参数，其余参数**原样转给 pnpm**
> （`add` / `remove` / `why` / `list` …），所以你也可以用它做只读排查：
> `dsh plugin --profile web why dsh-workspace-preset`。

#### 装完怎么确认它真的被装载了

```powershell
dsh --profile web --dump-config | Select-String 'workspace-preset' -Context 2,3
```

应该看到条目被解析成 `file:///…/node_modules/dsh-workspace-preset/lib/index.js`。
**这一步很关键**：如果那里显示的是裸包名或指向 dsh 安装目录，说明 `name` 锚定错了
（见下面那条注意），此时"条目在、`apply()` 不执行"。

再看 Config 有没有被宿主读出来：

```powershell
dsh --profile web --dump-config-schema | Select-String 'workspace-preset' -Context 0,3
```

`"status": "schema"` 表示宿主已成功导入插件并读到 `Config` —— 这是**插件代码真的执行过**
的强证据（`status: "absent"` 则反之）。

> **不需要**手改 `cordis.patch.yml`：包自带 `cordis.patch.yml` 作为 bundle 层，
> 其中的 `name` 写的是 `./lib/index.js`（相对包根）。
> 只有在你要**手动指定映射初始值**时才往 profile 的 patch 里加 `config:` 块。
>
> **为什么 `name` 必须写相对路径**：裸包名会被 cordis loader 按
> `bareModuleBaseUrl`（指向 **dsh 安装目录**的 package.json）解析，
> 结果是"条目看得见、`apply()` 永远不执行"。只有 `./`、`../` 或绝对路径开头的
> `name` 才会被转成指向本包自身的 `file://` URL。

### 方式二：本地开发（改一行看一行）

```powershell
$src = 'D:\Program Code\plugins\WorkspacePreset'
$nm  = "$env:DSH_HOME\profiles\web\node_modules\dsh-workspace-preset"
New-Item -ItemType Directory -Force "$nm\lib" | Out-Null
Copy-Item "$src\lib\*.js" "$nm\lib\" -Force
Copy-Item "$src\client.js","$src\package.json","$src\cordis.patch.yml" $nm -Force

# 哈希比对：装的到底是不是我改的那份（别用肉眼）
(Get-FileHash "$src\lib\index.js" -Algorithm MD5).Hash -eq
  (Get-FileHash "$nm\lib\index.js" -Algorithm MD5).Hash
```

或者更快：直接把 profile 里那份换成指向源码目录的 junction，
改完刷新页面即可（Host 侧改动要重启 `dsh web`）。

### 方式三：离线 / 内网（不经过 GitHub）

`dsh plugin add` 也接受本地路径，所以可以先把仓库拷到本机再装：

```powershell
dsh plugin --profile web add D:\Program Code\plugins\WorkspacePreset
```

代价是它记的是**本地路径**而不是版本，之后 `pnpm install` 依赖那个目录还在。

---

## 用法

装好后打开 **设置 → 工作区预设**：

1. 每行是一个已注册工作区，右侧下拉选 preset
2. 选「跟随全局默认」→ 该键从 `cordis.patch.yml` 中移除
3. 关掉「启用按工作区设置预设」→ 全局恢复单一默认
4. 工作区被删除后，那条映射会显示在「以下映射对应的工作区已不存在」里，
   **只提示不自动清理**（自动清理等于悄悄丢用户配置）

映射落盘位置：`$DSH_HOME/profiles/<profile>/cordis.patch.yml`
里 `- id: workspace-preset` 的 `config.presetByWorkspace`。

---

## 设计要点（为什么这么做）

### 1. 只挂 `agent/created`，不碰 `session/created`

| 候选 | 判定 |
|---|---|
| `session/created` | 契约是 **`emit`**（不 await、只 catch rejection），在里面 `await select()` 拿不到顺序保证；而且此刻 `agent/created` 还没派发，属于"半发布" |
| **`agent/created`** | **serial 且被 await**：宿主在监听器全部返回前不会放行该 agent 的输入队列，所以切换**一定**赶在第一个模型步之前；`source` 还能区分 `startup` 与 `resume` |
| `agent/pre-step` | 每轮都进，`select` 在 `lastTurn > 0` 时本来就锁死，等于白跑 |

### 2. 工作区身份只能按 `cwd` 反查

不能用 `workspace.sessionIds.includes(sessionId)`：`attachSession()` 发生在
`ensureSession()` 返回**之后**，`agent/created` 时刻还读不到当前会话。
也不能朴素比较 `path === cwd`：`workspace.path` 是 `realpath` 规范化过的，
而 cwd 是会话头里的原始字符串（软链 / 大小写 / 8.3 短名都会让比较失败）。
所以复用 `workspaceRegistry.resolveByPath(cwd)`。

### 3. 空白会话复用也一起对齐（R1）

客户端 `reuseOrCreateBlank` 会先复用该工作区已有的**空白**会话，
走的是 `resume` 分支，此时会话日志里记着的 preset 会覆盖一切 —— 这是
"改了设置却看不到效果"的唯一来源。

`resume` 有两种：用户重开老会话（**绝不能碰**）、复用空白会话（**必须对齐**）。
两者只能靠 `turnBoundary` 投影区分，且 `select()` 内部用的就是同一份投影：

```js
blank = boundary.lastTurn === 0 && boundary.openTurnStartSeq === null
```

### 4. 失败一律降级，绝不阻塞会话创建

`agent/created` 是 serial 事件，**监听器抛错会让会话创建失败并跳过后续监听器**。
所以整条链路 try/catch 包死；preset id 不存在（`agent-preset/not-found`）时
只记 warn、本轮不切、会话按宿主默认继续创建。

### 5. 配置每次现读，不缓存

volatile 字段变更**不重挂插件 fiber**：Loader 把新值提交进运行中的引用并
emit `loader/volatile-update`。缓存值 = 改了不生效。

### 6. 键用 `WorkspaceId` 而不是路径

路径进 YAML 要处理 Windows 反斜杠转义，且大小写/软链/8.3 短名会让字符串比较失败；
`resolveByPath` 已经做完规范化并直接给出 id。代价是工作区删除后 id 变化、映射失效
——后果只是回落到全局默认，可接受。

---

## 门禁顺序（顺序即优先级）

| 门 | 条件 | 行为 |
|---|---|---|
| G0 | `enabled !== true` | 跳过（等于未安装） |
| G1 | `header.origin === 'subagent'` | 跳过（子代理不换组合） |
| G2 | `header.parentSession !== undefined` | 跳过（分叉/种子会话继承父语义） |
| G3 | 无 `cwd` | 跳过（判不了工作区） |
| G4 | `resolveByPath` 未命中 | 跳过（不在任何工作区内） |
| G5 | 该工作区无映射 / 映射为空串 | 跳过（跟随全局默认） |
| G6 | 当前 preset 已等于目标 | 跳过（白切一次要多挂一遍组合） |
| G7 | `resume` 且**已开轮** | 跳过（新会话默认不许污染历史会话） |
| — | 其余 | `await agentPresets.select(agent, wanted)` |

---

## 项目结构

```
dsh-workspace-preset/
├── package.json            # dsh.bundle + dsh.client 声明
├── cordis.patch.yml        # bundle 补丁（name 必须相对路径）
├── client.js               # 浏览器半区：设置页（单文件，window.__ModuleLoader__）
├── lib/
│   ├── index.js            # Host 入口：apply + agent/created 接线
│   ├── schema.js           # Config（只依赖 schemastery，全字段 volatile）
│   ├── resolve.js          # 纯函数：映射查询 / 空白判定 / volatile 读取
│   └── target.js           # 门禁判定（纯函数，G0–G7）
├── scripts/
│   ├── resolve-test.mjs           # 纯逻辑单测（41 条，零依赖）
│   ├── client-structure-test.mjs  # 客户端结构（31 条，含迷你 React）
│   ├── smoke-host.mjs             # Host 端到端冒烟（21 条，真 import）
│   └── test-all.mjs               # 一键跑三套
└── docs/                          # 可行性评估 / 设计方案 / 配置页设计 / 实施验收 / 取证索引
```

`lib/*.js` 里的 `./resolve.js`、`./target.js` 是**相对导入**，所以
`lib/` 必须作为整体保留，不能只拷 `index.js`。

---

## 自测

```powershell
node scripts/test-all.mjs        # 三套全跑
node scripts/resolve-test.mjs    # 纯逻辑：41 条断言，零依赖
node scripts/client-structure-test.mjs   # 客户端结构：31 条，含迷你 React 渲染
```

第三套（`scripts/smoke-host.mjs`）会真实 `import lib/index.js`（连同
`lib/schema.js` → `@deepseek-ai/schemastery`），用假 `ctx` 跑完整 `apply` +
`agent/created` 链路。`test-all.mjs` 在找不到 `schemastery` 时会自动搭一个临时目录
（junction 到 profile 里的那份）再跑，所以从工作区也能一键全跑。

**当前状态：93 条断言全部通过。** 但注意：
**这是程序化测试，不是真机验收** —— 真实会话创建、真实 `agentPresets.select`、
设置页真实渲染都还没在浏览器里跑过（见下面的验收清单）。

### 实机验收清单

- [ ] 未配置的工作区 → 新会话用**全局默认** preset
- [ ] 配置了的工作区 → 新会话用配置的 preset（**首轮工具表**就是目标预设的）
- [ ] 同一工作区第二次进入（复用空白会话）→ 仍是目标 preset
- [ ] 打开**已有历史**的会话 → preset **不变**
- [ ] 分叉会话 / 子代理会话 → 不受影响
- [ ] 配置里写不存在的 preset id → 会话仍能创建，仅告警（`$DSH_HOME/workspace-preset/probe.log`）
- [ ] 设置页开着时，消息仍能收发
- [ ] 切下拉 → 刷新页面后值还在；选「跟随全局默认」→ 键从 YAML 里消失
- [ ] 与 `dsh-auto-review-custom` 同时启用：新会话 = auto 权限 + 该工作区的 agent preset

排查顺序：`probe.log` 看 apply 有没有跑 → 看 `skip:<reason>` 是哪道门挡的 →
看 `select-failed` 的 `code`（`locked` / `not-found`）。

---

## 回滚

**首选：一条命令**，会同时清掉依赖和 bundles 项：

```powershell
dsh plugin --profile web remove dsh-workspace-preset
```

**或者只停用、保留安装**（改 profile 的 `cordis.patch.yml`）：

```yaml
- id: workspace-preset
  disabled: true
```

两种方式的行为都**完全等于**宿主原生 —— 本插件不修改任何宿主状态，
只在 `agent/created` 里"择机切一次"，而这一步可被 `enabled: false` 短路。

---

## 与设计文档的偏差

`docs/` 里的四份文档是**实现前**的取证稿。实际落地时发现三处与文档假设不符，
以代码为准：

| 文档假设 | 实际情况 | 影响 |
|---|---|---|
| `配置页实现设计.md` §3.5 用 `ctx.workspaces.list.getSnapshot()` 读工作区列表 | `settings.section` 槽位有官方 `standardProps`，其中就带 `useWorkspaces: SnapshotSelectorHook<WorkspaceSnapshot>`（`cordis_inspect_query(client, Slots, listSubTree, settings.section)` 核实）。用官方 prop 比自己读 service 更稳：不依赖别人插件的生命周期 | 少 30 行代码，且不会在 `dsh-client-ui-workspace` 卸载时把设置页带挂 |
| `实施与验收.md` §0 要 30 分钟探针实验（Q3：resume 时 `select` 会不会 `locked`） | 直接读源码得到确定答案：`select()` 的锁定判据就是 `turnBoundary` 投影（`openTurnStartSeq !== null \|\| lastTurn > 0`），而复用空白会话时 `lastTurn === 0` | 省掉探针；R1 退化为"同一段代码顺带覆盖"，即 D1 选 a |
| 文档只要求纯逻辑单测 | 补了客户端结构测试（含迷你 React，能真正跑到 `useEffect` 之后的渲染状态）和 Host 端到端冒烟（真 `import`、真 `Config` 解析、真 `agent/created`） | 发现并修掉三类真问题（见下） |

**测试逮到的三类真问题**（每一类都靠"真跑"才暴露，只看代码看不出来）：

1. **测试替身过弱**：第一版客户端测试用「什么都不做的 React 替身」，
   `useEffect` 不执行 → preset 花名册永远是空数组 → 下拉只有"跟随全局默认"一项。
   现在的替身会跑 effect、会在 setState 后重渲染，
   「花名册加载后下拉含全部 preset」「broken 项被 disabled」这类断言才真的有效。

2. **手造的 volatile 引用形状是错的**：Host 冒烟第一版手写 `{ get: () => value }`
   当 Config 字段。实测宿主给的引用是**只读 `{ get }`**，语义是"每次现读"。
   手造替身能过、真引用形状不对 —— 这是最典型的"测试自己骗自己"。
   现在一律走 `plugin.Config(rawPatchConfig)`，即宿主 `apply()` 真正收到的东西。

3. **`cwd: undefined` 会触发解构默认值**：`makeAgent({ cwd: undefined })` 里的
   `undefined` 被默认值替换，静默变成"有 cwd"，让「无 cwd → 不切」这条断言**假绿**。
   改用显式 `noCwd` 开关。这类"绿得没道理"的断言比红的更危险。

另外 `dsh plugin add` 这条路径也实测过：装出来的包自测同样 105 条全绿，
`--dump-config` 里条目正确解析成 `file:///…/lib/index.js`，
`--dump-config-schema` 显示 `status: "schema"`（宿主成功导入插件并读到 Config）。
`dsh plugin remove` 会同步清掉 bundles 项。

---

## License

MIT
