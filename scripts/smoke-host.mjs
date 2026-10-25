/**
 * Host 半区冒烟测试（临时探针，跑在 profile 目录里以便解析 @deepseek-ai/*）。
 *
 * 目标：不装插件、不改 profile 配置的前提下，验证
 *   1. lib/index.js 能被真实 import（含 schema.js -> @deepseek-ai/schemastery）
 *   2. apply() 会注册 agent/created 监听器
 *   3. 门禁 + select 的端到端行为符合预期
 *   4. 监听器绝不向外抛错
 */

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PLUGIN = 'file:///D:/Program Code/plugins/WorkspacePreset/lib/index.js'

const plugin = await import(PLUGIN)

let pass = 0
const fails = []
const t = (name, body) => {
  try {
    body()
    pass += 1
  } catch (e) {
    fails.push(`${name}: ${e?.message ?? e}`)
  }
}
const eq = (a, b, w = '') => {
  const x = JSON.stringify(a)
  const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${w} expected ${y} got ${x}`)
}
const assert = (c, w = '') => {
  if (!c) throw new Error(`${w} expected truthy`)
}

// ── 1. 模块形状 ────────────────────────────────────────────────
t('导出 name', () => eq(plugin.name, 'workspace-preset'))
t('导出 Config', () => assert(plugin.Config !== undefined, 'Config'))
t('inject 是空数组（惰性绑定）', () => eq(plugin.inject, []))
t('apply 是函数', () => eq(typeof plugin.apply, 'function'))

// Config 形状与 volatile 标记
t('Config 有 enabled 与 presetByWorkspace', () => {
  const keys = Object.keys(plugin.Config.dict ?? {})
  assert(keys.includes('enabled'), 'enabled')
  assert(keys.includes('presetByWorkspace'), 'presetByWorkspace')
})
t('两个字段都是 volatile', () => {
  assert(plugin.Config.dict.enabled.meta.volatile === true, 'enabled volatile')
  assert(plugin.Config.dict.presetByWorkspace.meta.volatile === true, 'map volatile')
})
t('presetByWorkspace 是 dict 且 inner 是 string', () => {
  eq(plugin.Config.dict.presetByWorkspace.type, 'dict')
  eq(plugin.Config.dict.presetByWorkspace.inner?.type, 'string')
})

// ── 2. 假宿主 ─────────────────────────────────────────────────
const home = mkdtempSync(join(tmpdir(), 'wsp-smoke-'))
process.env.DSH_HOME = home

/** @type {Array<{event: string, handler: Function}>} */
let listeners = []
let injectNames = null

const WORKSPACES = new Map([
  ['ws-code', 'D:\\work\\code'],
  ['ws-doc', 'D:\\work\\doc'],
])

function makeCtx(overrides = {}) {
  listeners = []
  const ctx = {
    logger: () => ({ warn: (m) => { ctx.__warns.push(m) }, info: () => {} }),
    __warns: [],
    get: (n) => (n === 'dshHome' ? home : undefined),
    inject: (names, cb) => {
      injectNames = names
      const child = {
        on: (event, handler) => { listeners.push({ event, handler }) },
        agentPresets: {
          composedPreset: () => overrides.currentPreset,
          select: async (agent, id) => {
            ctx.__selects.push({ agentId: agent.id, preset: id })
            if (overrides.selectThrows !== undefined) throw overrides.selectThrows
            return id
          },
        },
        workspaceRegistry: {
          resolveByPath: async (p) => {
            if (overrides.resolveThrows === true) throw new Error('ENOENT')
            for (const [id, path] of WORKSPACES) if (path === p) return { id, path }
            return undefined
          },
        },
        sessionProjections: {
          stateOf: () => overrides.boundary,
        },
      }
      cb(child)
    },
    __selects: [],
  }
  return ctx
}

/** 造一个 agent/created 载荷。 */
function makeAgent({ cwd = 'D:\\work\\code', origin, parentSession } = {}) {
  const header = { id: 'sess-1' }
  if (cwd !== undefined) header.cwd = cwd
  if (origin !== undefined) header.origin = origin
  if (parentSession !== undefined) header.parentSession = parentSession
  return { id: 'sess-1', session: { header }, ctx: {} }
}

/** 跑一次完整链路，返回 {selects, warns}。 */
async function run({ config, agent, source = 'startup', overrides = {} }) {
  const ctx = makeCtx(overrides)
  const patchConfig = {
    enabled: { get: () => config.enabled },
    presetByWorkspace: { get: () => config.presetByWorkspace },
  }
  plugin.apply(ctx, patchConfig)
  eq(injectNames?.slice().sort(), ['agentPresets', 'sessionProjections', 'workspaceRegistry'], 'inject 服务集')
  const created = listeners.filter((l) => l.event === 'agent/created')
  eq(created.length, 1, 'agent/created 监听器数量')
  await created[0].handler({ agent, source })
  return { selects: ctx.__selects, warns: ctx.__warns }
}

const CONFIG_HIT = { enabled: true, presetByWorkspace: { 'ws-code': 'creative' } }

// ── 3. 端到端行为 ─────────────────────────────────────────────

// 需要在 async 上下文里跑，所以先收集 promise
const cases = []
const acase = (name, fn) => cases.push({ name, fn })

acase('配置了的工作区 + startup -> 切到映射的 preset', async () => {
  const r = await run({
    config: CONFIG_HIT,
    agent: makeAgent(),
    overrides: { currentPreset: 'standard', boundary: { lastTurn: 0, openTurnStartSeq: null } },
  })
  eq(r.selects, [{ agentId: 'sess-1', preset: 'creative' }])
})

acase('未配置的工作区 -> 不切', async () => {
  const r = await run({
    config: CONFIG_HIT,
    agent: makeAgent({ cwd: 'D:\\work\\doc' }),
    overrides: { currentPreset: 'standard' },
  })
  eq(r.selects, [])
})

acase('cwd 不在任何工作区 -> 不切', async () => {
  const r = await run({
    config: CONFIG_HIT,
    agent: makeAgent({ cwd: 'D:\\elsewhere' }),
    overrides: { currentPreset: 'standard' },
  })
  eq(r.selects, [])
})

acase('resolveByPath 抛错 -> 不切且不外抛', async () => {
  const r = await run({
    config: CONFIG_HIT,
    agent: makeAgent(),
    overrides: { currentPreset: 'standard', resolveThrows: true },
  })
  eq(r.selects, [])
})

acase('已是目标 preset -> 不切', async () => {
  const r = await run({
    config: CONFIG_HIT,
    agent: makeAgent(),
    overrides: { currentPreset: 'creative' },
  })
  eq(r.selects, [])
})

acase('总开关关闭 -> 不切', async () => {
  const r = await run({
    config: { enabled: false, presetByWorkspace: { 'ws-code': 'creative' } },
    agent: makeAgent(),
    overrides: { currentPreset: 'standard' },
  })
  eq(r.selects, [])
})

acase('子代理 -> 不切', async () => {
  const r = await run({
    config: CONFIG_HIT,
    agent: makeAgent({ origin: 'subagent' }),
    overrides: { currentPreset: 'standard' },
  })
  eq(r.selects, [])
})

acase('分叉会话（parentSession）-> 不切', async () => {
  const r = await run({
    config: CONFIG_HIT,
    agent: makeAgent({ parentSession: 'parent' }),
    overrides: { currentPreset: 'standard' },
  })
  eq(r.selects, [])
})

acase('resume + 老会话（lastTurn>0）-> 不切', async () => {
  const r = await run({
    config: CONFIG_HIT,
    agent: makeAgent(),
    source: 'resume',
    overrides: { currentPreset: 'standard', boundary: { lastTurn: 3, openTurnStartSeq: null } },
  })
  eq(r.selects, [])
})

acase('resume + 空白会话（复用）-> 切（R1）', async () => {
  const r = await run({
    config: CONFIG_HIT,
    agent: makeAgent(),
    source: 'resume',
    overrides: { currentPreset: 'standard', boundary: { lastTurn: 0, openTurnStartSeq: null } },
  })
  eq(r.selects, [{ agentId: 'sess-1', preset: 'creative' }])
})

acase('select 抛 not-found -> 不外抛，记 warn', async () => {
  const err = Object.assign(new Error('Unknown agent preset: gone'), {
    code: 'agent-preset/not-found',
    available: ['standard', 'creative'],
  })
  const r = await run({
    config: { enabled: true, presetByWorkspace: { 'ws-code': 'gone' } },
    agent: makeAgent(),
    overrides: { currentPreset: 'standard', selectThrows: err },
  })
  assert(r.warns.length >= 1, 'warn 条数')
  assert(r.warns[0].includes('agent-preset/not-found'), `warn 含 code: ${r.warns[0]}`)
  assert(r.warns[0].includes('standard,creative'), `warn 含 available: ${r.warns[0]}`)
})

acase('agent 缺少 session.header -> 不外抛', async () => {
  const r = await run({
    config: CONFIG_HIT,
    agent: { id: 'sess-1' },
    overrides: { currentPreset: 'standard' },
  })
  eq(r.selects, [])
})

acase('映射值为空串 -> 视为未配置，不切', async () => {
  const r = await run({
    config: { enabled: true, presetByWorkspace: { 'ws-code': '' } },
    agent: makeAgent(),
    overrides: { currentPreset: 'standard' },
  })
  eq(r.selects, [])
})

for (const c of cases) {
  try {
    await c.fn()
    pass += 1
  } catch (e) {
    fails.push(`${c.name}: ${e?.message ?? e}`)
  }
}

// ── 4. 探针确实写了文件 ────────────────────────────────────────
t('探针写了 probe.log', () => {
  const p = join(home, 'workspace-preset', 'probe.log')
  assert(existsSync(p), `${p} 不存在`)
  const text = readFileSync(p, 'utf8')
  assert(text.includes('apply-enter'), 'probe 含 apply-enter')
  assert(text.includes('apply-done'), 'probe 含 apply-done')
})

rmSync(home, { recursive: true, force: true })

const total = pass + fails.length
if (fails.length === 0) {
  console.log(`ok — smoke ${pass}/${total} passed`)
  process.exit(0)
}
console.error(`FAILED — ${fails.length}/${total}`)
for (const f of fails) console.error('  ✗ ' + f)
process.exit(1)
