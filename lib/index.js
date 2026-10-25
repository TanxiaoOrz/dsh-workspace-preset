/**
 * dsh-workspace-preset 的 **Host 半区**。
 *
 * ## 一句话
 *
 * 挂在 `agent/created` 上：读「会话 cwd → 工作区 → 该工作区的 preset」这条链，
 * 在新会话的**第一个模型步之前**把 preset 切好；任何一步失败就安静地回落到
 * 宿主全局默认（也就是用户没装本插件时的行为）。
 *
 * ## 为什么是 `agent/created`
 *
 * | 候选 | 判定 |
 * |---|---|
 * | `session/created` | 契约是 **emit**（`void` 返回、不 await、只 catch rejection），在里面 `await presets.select()` 拿不到任何顺序保证。而且此刻 `agent/created` 还没派发，生命周期属于"半发布" |
 * | **`agent/created`** | **serial 且被 await**：宿主在监听器全部返回前不会放行该 agent 的输入队列，所以切换**一定**赶在第一个模型步之前；`source` 还能区分创建/恢复 |
 * | `agent/pre-step` | 备选，但每轮都进；`select` 在 `lastTurn > 0` 时本来就锁死，等于白跑 |
 *
 * ## 三条纪律
 *
 * 1. **监听器绝不外抛**。`agent/created` 是 serial 事件，监听器抛错会让**会话创建失败**
 *    并跳过后续监听器（`cordis_inspect_query(host, Event, 'agent/created')` 的契约原文）。
 *    这是本插件唯一"能搞坏别人"的点，所以整条链路包在 try/catch 里。
 * 2. **配置每次现读**，不缓存（volatile 字段变更不重挂 fiber）。
 * 3. **`apply` 不 await** 任何服务，服务用 `ctx.inject` 惰性获取；缺服务时插件只是不生效，
 *    不会让 profile 启动失败。
 *
 * @module dsh-workspace-preset
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeMap, readVolatile } from './resolve.js'
import { evaluateGate } from './target.js'

export const name = 'workspace-preset'

/**
 * 把 `Config` 暴露给 Loader —— 声明它之后 patch 里才能有 `config:` 块，
 * 且设置页能通过 `ctx.configForms` 读写这些字段。
 */
export { Config } from './schema.js'

/**
 * 顶层依赖声明为空：所有服务都走 `ctx.inject` 惰性获取。
 *
 * 硬声明会让"缺 agentPresets / workspaceRegistry"的环境直接停用整个插件，
 * 而我们希望在这种情况下也保持"不生效但不报错"。
 */
export const inject = []

/** 探针与日志用的数据目录名（`$DSH_HOME/workspace-preset`）。 */
const DATA_DIR = 'workspace-preset'

/**
 * 插件入口。
 *
 * @param {any} ctx - 插件根上下文。
 * @param {any} [pluginConfig] - patch 里的 `config` 块；字段是 volatile 引用。
 */
export function apply(ctx, pluginConfig) {
  const warn = makeLogger(ctx, 'warn')

  probe(ctx, 'apply-enter')

  try {
    // 三个服务都要：没有 agentPresets 就没得切；没有 workspaceRegistry 就判不了
    // 工作区；没有 sessionProjections 就判不了空白会话（G7）。
    //
    // 用可选注入的语义：`ctx.inject` 会等服务齐了才回调，服务缺失时回调不执行，
    // 插件保持"装了但不生效"的安静状态。
    ctx.inject(['agentPresets', 'workspaceRegistry', 'sessionProjections'], (child) => {
      try {
        child.on('agent/created', async ({ agent, source }) => {
          try {
            await handleAgentCreated(child, pluginConfig, agent, source, warn)
          } catch (error) {
            // 兜底：`handleAgentCreated` 内部已经全包了，这里是纵深防御。
            warn(`agent/created 处理失败（已降级）：${describeError(error)}`)
            probe(ctx, `created-failed: ${describeError(error)}`)
          }
        })
      } catch (error) {
        warn(`注册 agent/created 失败（本插件不生效）：${describeError(error)}`)
        probe(ctx, `mount-failed: ${describeError(error)}`)
      }
    })
  } catch (error) {
    // 连 inject 都失败：绝不让它冒泡。
    warn(`装载失败（本插件不生效）：${describeError(error)}`)
    probe(ctx, `apply-failed: ${describeError(error)}`)
  }

  probe(ctx, 'apply-done')
}

/**
 * `agent/created` 的实际处理：判定 → 切换。
 *
 * 本函数**不向外抛**任何异常（调用方还有一层兜底）。
 *
 * @param {any} ctx - 注入了三个服务的子上下文。
 * @param {any} pluginConfig - patch config（volatile 引用）。
 * @param {any} agent - `agent/created` 的 agent。
 * @param {string} source - `'startup' | 'resume' | 'clear' | 'compact'`。
 * @param {(message: string) => void} warn
 */
async function handleAgentCreated(ctx, pluginConfig, agent, source, warn) {
  // ── 读配置（每次现读，不缓存）──────────────────────────────────
  const config = readConfig(pluginConfig)

  const header = agent?.session?.header
  if (config.enabled !== true) return
  if (header === undefined || header === null) return

  // 早期跳过，避免为明显无关的会话做任何异步工作（resolveByPath 会碰 fs）。
  if (header.origin === 'subagent') return
  if (header.parentSession !== undefined) return
  if (typeof header.cwd !== 'string' || header.cwd === '') return

  // ── cwd → 工作区 ─────────────────────────────────────────────
  //
  // 不能用 `workspaces.list().find(w => w.sessionIds.includes(sessionId))`：
  // `workspace.attachSession()` 发生在 `ensureSession()` 返回**之后**，
  // 所以 `agent/created` 时刻 `sessionIds` 里还没有本会话。
  // 也不能朴素比较 `w.path === cwd`：`workspace.path` 是 `realpath` 规范化过的，
  // 而 cwd 是会话头里记的原始字符串（软链/大小写/8.3 短名都会让比较失败）。
  // `resolveByPath` 内部做的正是这套规范化，直接复用。
  let workspace
  try {
    workspace = await ctx.workspaceRegistry.resolveByPath(header.cwd)
  } catch {
    // 路径已不存在（工作区目录被删/移动）→ 当作"无映射"。
    probe(ctx, `resolve-path-threw: cwd=${header.cwd}`)
    return
  }

  // ── 判门禁 ───────────────────────────────────────────────────
  let currentPreset
  try {
    currentPreset = ctx.agentPresets.composedPreset(agent.ctx)
  } catch {
    // 读不到当前组合就当作"未知"，让 select 自己判断能否切。
    currentPreset = undefined
  }

  let boundary
  try {
    boundary = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')
  } catch {
    boundary = undefined
  }

  const decision = evaluateGate({
    enabled: config.enabled,
    header,
    source,
    map: config.presetByWorkspace,
    workspaceId: workspace?.id,
    currentPreset,
    boundary,
  })

  if (decision.action !== 'switch') {
    probeOnce(ctx, `skip:${decision.reason}`, `skip ${decision.reason} agent=${agent?.id} source=${source}`)
    return
  }

  // ── 切换 ─────────────────────────────────────────────────────
  try {
    await ctx.agentPresets.select(agent, decision.presetId)
    probe(ctx, `switched: agent=${agent?.id} source=${source} preset=${decision.presetId} workspace=${decision.workspaceId}`)
  } catch (error) {
    // 会走到这里的三种情况（都不会影响会话创建）：
    //   agent-preset/not-found  —— 配置里写了个已删除的 preset
    //   agent-preset/locked     —— 该会话已经有 turn 记录（理论上 G7 已挡）
    //   其它                     —— 组合挂载失败
    // 处理原则一致：记 warn、本轮不切、会话按宿主默认继续创建。
    const code = typeof error?.code === 'string' ? error.code : ''
    const available = Array.isArray(error?.available) ? error.available.join(',') : ''
    warn(
      `未能为会话 ${agent?.id} 切换 preset 到 "${decision.presetId}"`
        + `${code === '' ? '' : `（${code}）`}${available === '' ? '' : `；可用：${available}`}`
        + `；本次沿用宿主默认。`,
    )
    probe(ctx, `select-failed: agent=${agent?.id} code=${code} preset=${decision.presetId} ${describeError(error)}`)
  }
}

/**
 * 从 patch config 里读出规范化后的配置。
 *
 * @param {any} pluginConfig
 * @returns {{ enabled: boolean, presetByWorkspace: Record<string, string> }}
 */
function readConfig(pluginConfig) {
  const rawMap = readVolatile(pluginConfig?.presetByWorkspace, {})
  const enabled = readVolatile(pluginConfig?.enabled, true)
  return {
    enabled: enabled !== false,
    presetByWorkspace: normalizeMap(rawMap),
  }
}

/** 把错误压成一行文本（含 code，便于排查 locked / not-found）。 */
function describeError(error) {
  const code = typeof error?.code === 'string' && error.code !== '' ? `${error.code}: ` : ''
  return `${code}${String(error?.message ?? error)}`
}

/**
 * 造一个永不抛错的命名 logger。
 *
 * 用命名 logger（`ctx.logger('workspace-preset')`）让它与其他插件走同一条
 * exporter 通道；未命名的 `ctx.logger.info()` 在部分级别配置下会被静默过滤，
 * 造成"插件明明在跑却看不到任何输出"。
 *
 * @param {any} ctx
 * @param {'info' | 'warn'} level
 * @returns {(message: string) => void}
 */
function makeLogger(ctx, level) {
  return (message) => {
    try {
      const named = typeof ctx.logger === 'function' ? ctx.logger(name) : ctx.logger
      const fn = named?.[level]
      if (typeof fn === 'function') fn.call(named, message)
    } catch {
      /* 日志失败不影响主流程 */
    }
  }
}

/**
 * 解析探针目录：`$DSH_HOME/workspace-preset`。
 *
 * @param {any} ctx
 * @returns {string}
 */
function resolveDataRoot(ctx) {
  try {
    const fromService = ctx.get?.('dshHome')
    if (typeof fromService === 'string' && fromService.length > 0) {
      return join(fromService, DATA_DIR)
    }
  } catch {
    /* ctx.get 不可用时忽略 */
  }
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.length > 0) return join(env, DATA_DIR)
  return join(process.cwd(), DATA_DIR)
}

/**
 * 追加一行探针。
 *
 * 探针存在的原因：日志可能被 exporter 级别配置过滤掉，导致"插件跑了却看不到输出"，
 * 排查时无法区分「没加载 / 加载了但门禁挡住 / 加载了但抛错」。写文件不受级别影响。
 *
 * **只在失败与关键状态时写**，成功路径不写（否则 probe.log 很快变噪声）。
 *
 * @param {any} ctx
 * @param {string} event
 */
function probe(ctx, event) {
  appendProbe(ctx, event)
}

/**
 * 同一类跳过原因每次进程只记一行。
 *
 * `skip:*` 会随每次新建会话触发（打开工作区、分叉、子代理……），
 * 无条件记录会把日志刷满；但完全不记又看不出"门禁为什么没放行"。
 *
 * @param {any} ctx
 * @param {string} key
 * @param {string} event
 */
const seenSkipReasons = new Set()
function probeOnce(ctx, key, event) {
  if (seenSkipReasons.has(key)) return
  seenSkipReasons.add(key)
  appendProbe(ctx, event)
}

/**
 * @param {any} ctx
 * @param {string} event
 */
function appendProbe(ctx, event) {
  try {
    const root = resolveDataRoot(ctx)
    mkdirSync(root, { recursive: true })
    appendFileSync(
      join(root, 'probe.log'),
      `${new Date().toISOString()}\t${event}\tpid=${process.pid}\n`,
      'utf8',
    )
  } catch {
    /* 探针失败绝不影响插件 */
  }
}
