# dsh-workspace-preset

> 按工作区指定**新会话**打开时使用的 agent preset。
> 未配置的工作区回落到宿主的全局默认，行为与未安装本插件时完全一致。

宿主基线：`@deepseek-ai/dsh-web-app 0.2.0-rc.2`（`@deepseek-ai/cordis 4.0.4`）。

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
装进某个 profile 即可，**不需要重启 DSH 之外的东西**。

### 方式一：从 GitHub 装（推荐）

```powershell
# 在目标 profile 目录里执行
cd "$env:DSH_HOME\profiles\web"

# 1) 把本包加进 profile 依赖
pnpm add github:TanxiaoOrz/dsh-workspace-preset --allow-build=dsh-workspace-preset

# 2) 把包名加进 profile package.json 的 dsh.profile.bundles 数组
#    （手工编辑，或在 dsh web 的「设置 → 插件」里启用）
```

然后把 profile 的 `cordis.patch.yml` 里这条加进去（**也可以不加**，
只靠 bundles 数组即可，因为包自带 `cordis.patch.yml` 作为 bundle 层）：

```yaml
- id: workspace-preset
  name: "./lib/index.js"     # 相对包根，不要写裸包名
```

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

或在同一个 profile 里直接改成绝对路径软链，改完刷新页面即可。

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
│   └── resolve-test.mjs    # 纯逻辑单测（不 import 任何 @deepseek-ai/*）
└── README.md
```

`lib/*.js` 里的 `./resolve.js`、`./target.js` 是**相对导入**，所以
`lib/` 必须作为整体保留，不能只拷 `index.js`。

---

## 自测

```powershell
node scripts/resolve-test.mjs     # 纯逻辑：41 条断言，零依赖
```

只测纯逻辑，不 import 任何 `@deepseek-ai/*` —— 因为那些包只在 profile 的
`node_modules` 里，从工作区直接 import 会 `ERR_MODULE_NOT_FOUND`。

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

一行停用，行为**完全等于**宿主原生（本插件不修改任何宿主状态，
只在 `agent/created` 里"择机切一次"）：

```yaml
- id: workspace-preset
  name: "./lib/index.js"
  disabled: true
```

---

## License

MIT
