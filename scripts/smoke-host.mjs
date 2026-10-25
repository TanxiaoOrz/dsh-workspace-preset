/**
 * Host 半区冒烟测试：真实 import `lib/index.js`，真实解析 `Config`，跑完整
 * `apply()` + `agent/created` 链路。
 *
 * ## 为什么必须用真的 `Config` 解析
 *
 * 第一版这里手造了 `{ get: () => value }` 当 volatile 引用。跑通之后才发现宿主给的
 * 根本不是这个形状 —— 真实引用是 `{ get }`（只有 get，只读、不可 set），
 * 而且它的**语义**才是关键：`readVolatile()` 必须每次现读 `.get()`。
 * 手造假替身能过、真引用过不了，是最典型的"测试自己骗自己"。
 *
 * 所以这里一律走 `plugin.Config(rawPatchConfig)`，也就是宿主 apply() 真正收到的东西。
 *
 * ## 假的是什么
 *
 * 只假 `ctx` 与 agent（宿主运行时对象），不假 Config、不假门禁逻辑：
 *   - `ctx.inject(names, cb)` → 直接回调一个假 child
 *   - `child.agentPresets.select()` → 记录调用
 *   - `child.workspaceRegistry.resolveByPath()` → 用固定表模拟
 *   - `child.sessionProjections.stateOf()` → 返回给定投影
 *
 * ## 依赖
 *
 * `lib/schema.js` 会 `import '@deepseek-ai/schemastery'`。本文件必须在
 * 能解析到它的位置运行（profile 内，或 `test-all.mjs` 搭的临时目录里）。
 *
 * 用法：`node scripts/smoke-host.mjs`（或由 `scripts/test-all.mjs` 拉起）
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// Windows 上 `import('D:\\...')` 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME，
// 必须转成 file:// URL。
const plugin = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

let pass = 0
const fails = []
async function t(name, body) {
  try {
    await body()
    pass += 1
  } catch (e) {
    fails.push(`${name}: ${e?.message ?? e}`)
  }
}
const eq = (a, b, what = '') => {
  const x = JSON.stringify(a)
  const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${what} expected ${y} got ${x}`)
}
const assert = (cond, what = '') => {
  if (!cond) throw new Error(`${what} expected truthy`)
}

// ══════════════════════════════════════════════════════════════
// 1. 模块与 Config 形状
// ══════════════════════════════════════════════════════════════

await t('导出 name', () => eq(plugin.name, 'workspace-preset'))
await t('导出 Config', () => assert(plugin.Config !== undefined, 'Config'))
await t('inject 是空数组（惰性绑定）', () => eq(plugin.inject, []))
await t('apply 是函数', () => eq(typeof plugin.apply, 'function'))

await t('Config 有两个字段', () => {
  eq(Object.keys(plugin.Config.dict ?? {}).sort(), ['enabled', 'presetByWorkspace'])
})
await t('两个字段都 volatile（设置页投影的前提）', () => {
  assert(plugin.Config.dict.enabled.meta.volatile === true, 'enabled')
  assert(plugin.Config.dict.presetByWorkspace.meta.volatile === true, 'map')
})
await t('presetByWorkspace 是 dict<string>', () => {
  eq(plugin.Config.dict.presetByWorkspace.type, 'dict')
  eq(plugin.Config.dict.presetByWorkspace.inner?.type, 'string')
})

await t('真实解析：Config({}) 的字段是只读引用（有 .get，无 .set）', () => {
  const parsed = plugin.Config({})
  for (const key of ['enabled', 'presetByWorkspace']) {
    eq(typeof parsed[key]?.get, 'function', `${key}.get`)
    eq(typeof parsed[key]?.set, 'undefined', `${key}.set 不该存在`)
  }
})
await t('真实解析：默认值 enabled=true、map={}', () => {
  const parsed = plugin.Config({})
  eq(parsed.enabled.get(), true)
  eq(parsed.presetByWorkspace.get(), {})
})
await t('真实解析：给定映射能被 .get() 读回', () => {
  const parsed = plugin.Config({ presetByWorkspace: { 'ws-a': 'creative' } })
  eq(parsed.presetByWorkspace.get(), { 'ws-a': 'creative' })
})

// ══════════════════════════════════════════════════════════════
// 2. 假宿主
// ══════════════════════════════════════════════════════════════

const home = mkdtempSync(join(tmpdir(), 'wsp-smoke-'))
process.env.DSH_HOME = home

const WORKSPACES = { 'ws-code': 'D:\\work\\code', 'ws-doc': 'D:\\work\\doc' }

/**
 * 跑一次完整链路。
 *
 * @param {object} input
 * @param {object} input.rawConfig patch 里的原始 config（会被真实 Config 解析）
 * @param {object} input.agent agent/created 的 agent
 * @param {string} [input.source]
 * @param {object} [input.host] 假的宿主行为
 * @returns {Promise<{selects: string[], warns: string[], listeners: number, injectNames: string[]}>}
 */
async function run({ rawConfig, agent, source = 'startup', host = {} }) {
  const config = plugin.Config(rawConfig) // ← 真实解析，不是手造引用

  const selects = []
  const warns = []
  const injectNames = []
  let listenerCount = 0
  let handler

  const child = {
    on: (event, fn) => {
      if (event === 'agent/created') {
        listenerCount += 1
        handler = fn
      }
    },
    agentPresets: {
      composedPreset: () => host.currentPreset,
      select: async (target, id) => {
        selects.push(id)
        if (host.selectThrows !== undefined) throw host.selectThrows
        return id
      },
    },
    workspaceRegistry: {
      resolveByPath: async (path) => {
        if (host.resolveThrows === true) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        const id = Object.keys(WORKSPACES).find((k) => WORKSPACES[k] === path)
        return id === undefined ? undefined : { id, path }
      },
    },
    sessionProjections: {
      stateOf: () => host.boundary,
    },
  }

  const ctx = {
    logger: () => ({ warn: (m) => warns.push(m), info: () => {} }),
    get: (name) => (name === 'dshHome' ? home : undefined),
    inject: (names, cb) => {
      injectNames.push(...names)
      cb(child)
    },
  }

  plugin.apply(ctx, config)
  if (typeof handler === 'function') await handler({ agent, source })
  return { selects, warns, listeners: listenerCount, injectNames }
}

/**
 * 造一个 agent/created 载荷。
 *
 * ⚠️ 不能用 `cwd: undefined` 表示"没有 cwd" —— 解构默认值会把 `undefined`
 * 替换成默认值，静默变成"有 cwd"。要真的不给 cwd，用 `{ noCwd: true }`。
 */
function makeAgent({ cwd, origin, parentSession, noCwd = false } = {}) {
  const header = { id: 'sess-1' }
  if (!noCwd) header.cwd = cwd ?? 'D:\\work\\code'
  if (origin !== undefined) header.origin = origin
  if (parentSession !== undefined) header.parentSession = parentSession
  return { id: 'sess-1', session: { header }, ctx: {} }
}

const HIT = { presetByWorkspace: { 'ws-code': 'creative' } }
const BLANK = { lastTurn: 0, openTurnStartSeq: null }

// ══════════════════════════════════════════════════════════════
// 3. 接线
// ══════════════════════════════════════════════════════════════

await t('apply 注入三个服务并注册一个 agent/created 监听器', async () => {
  const r = await run({
    rawConfig: HIT,
    agent: makeAgent(),
    host: { currentPreset: 'standard', boundary: BLANK },
  })
  eq(r.injectNames.slice().sort(), ['agentPresets', 'sessionProjections', 'workspaceRegistry'])
  eq(r.listeners, 1)
})

// ══════════════════════════════════════════════════════════════
// 4. 端到端行为（每个 case 对应一道门或一条降级路径）
// ══════════════════════════════════════════════════════════════

await t('配置了的工作区 + startup → 切到映射的 preset', async () => {
  const r = await run({ rawConfig: HIT, agent: makeAgent(), host: { currentPreset: 'standard', boundary: BLANK } })
  eq(r.selects, ['creative'])
})

await t('未配置的工作区 → 不切', async () => {
  const r = await run({
    rawConfig: HIT,
    agent: makeAgent({ cwd: 'D:\\work\\doc' }),
    host: { currentPreset: 'standard', boundary: BLANK },
  })
  eq(r.selects, [])
})

await t('cwd 不在任何工作区 → 不切', async () => {
  const r = await run({
    rawConfig: HIT,
    agent: makeAgent({ cwd: 'D:\\elsewhere' }),
    host: { currentPreset: 'standard', boundary: BLANK },
  })
  eq(r.selects, [])
})

await t('resolveByPath 抛错（工作区目录已不存在）→ 不切且不外抛', async () => {
  const r = await run({
    rawConfig: HIT,
    agent: makeAgent(),
    host: { currentPreset: 'standard', boundary: BLANK, resolveThrows: true },
  })
  eq(r.selects, [])
})

await t('已是目标 preset → 不切', async () => {
  const r = await run({
    rawConfig: HIT,
    agent: makeAgent(),
    host: { currentPreset: 'creative', boundary: BLANK },
  })
  eq(r.selects, [])
})

await t('总开关关闭 → 不切', async () => {
  const r = await run({
    rawConfig: { enabled: false, presetByWorkspace: { 'ws-code': 'creative' } },
    agent: makeAgent(),
    host: { currentPreset: 'standard', boundary: BLANK },
  })
  eq(r.selects, [])
})

await t('子代理（origin=subagent）→ 不切', async () => {
  const r = await run({
    rawConfig: HIT,
    agent: makeAgent({ origin: 'subagent' }),
    host: { currentPreset: 'standard', boundary: BLANK },
  })
  eq(r.selects, [])
})

await t('分叉会话（parentSession）→ 不切', async () => {
  const r = await run({
    rawConfig: HIT,
    agent: makeAgent({ parentSession: 'parent' }),
    host: { currentPreset: 'standard', boundary: BLANK },
  })
  eq(r.selects, [])
})

await t('resume + 老会话（lastTurn>0）→ 不切', async () => {
  const r = await run({
    rawConfig: HIT,
    agent: makeAgent(),
    source: 'resume',
    host: { currentPreset: 'standard', boundary: { lastTurn: 3, openTurnStartSeq: null } },
  })
  eq(r.selects, [])
})

await t('resume + 空白会话（客户端复用）→ 切（R1 对齐）', async () => {
  const r = await run({
    rawConfig: HIT,
    agent: makeAgent(),
    source: 'resume',
    host: { currentPreset: 'standard', boundary: BLANK },
  })
  eq(r.selects, ['creative'])
})

await t('resume + 投影缺失 → 不切（信息不全时不动老会话）', async () => {
  const r = await run({
    rawConfig: HIT,
    agent: makeAgent(),
    source: 'resume',
    host: { currentPreset: 'standard', boundary: undefined },
  })
  eq(r.selects, [])
})

await t('映射值为空串 → 视为未配置，不切', async () => {
  const r = await run({
    rawConfig: { presetByWorkspace: { 'ws-code': '' } },
    agent: makeAgent(),
    host: { currentPreset: 'standard', boundary: BLANK },
  })
  eq(r.selects, [])
})

await t('select 抛 agent-preset/not-found → 不外抛，warn 里带 code 与 available', async () => {
  const error = Object.assign(new Error('Unknown agent preset: gone'), {
    code: 'agent-preset/not-found',
    available: ['standard', 'creative'],
  })
  const r = await run({
    rawConfig: { presetByWorkspace: { 'ws-code': 'gone' } },
    agent: makeAgent(),
    host: { currentPreset: 'standard', boundary: BLANK, selectThrows: error },
  })
  assert(r.warns.length >= 1, 'warn 条数')
  assert(r.warns[0].includes('agent-preset/not-found'), `warn 含 code：${r.warns[0]}`)
  assert(r.warns[0].includes('standard,creative'), `warn 含 available：${r.warns[0]}`)
})

await t('select 抛 agent-preset/locked → 不外抛（会话仍能创建）', async () => {
  const error = Object.assign(new Error('This session has already started'), {
    code: 'agent-preset/locked',
  })
  const r = await run({
    rawConfig: HIT,
    agent: makeAgent(),
    host: { currentPreset: 'standard', boundary: BLANK, selectThrows: error },
  })
  assert(r.warns.length >= 1, 'warn 条数')
  assert(r.warns[0].includes('agent-preset/locked'), `warn 含 code：${r.warns[0]}`)
})

await t('agent 缺 session.header → 不外抛', async () => {
  const r = await run({
    rawConfig: HIT,
    agent: { id: 'sess-1' },
    host: { currentPreset: 'standard', boundary: BLANK },
  })
  eq(r.selects, [])
})

await t('header 无 cwd → 不切', async () => {
  const r = await run({
    rawConfig: HIT,
    agent: makeAgent({ noCwd: true }),
    host: { currentPreset: 'standard', boundary: BLANK },
  })
  eq(r.selects, [])
})

await t('clear / compact 也按 create 语义处理（不看 boundary）', async () => {
  for (const source of ['clear', 'compact']) {
    const r = await run({
      rawConfig: HIT,
      agent: makeAgent(),
      source,
      host: { currentPreset: 'standard', boundary: { lastTurn: 9, openTurnStartSeq: 9 } },
    })
    eq(r.selects, ['creative'], `${source} 应切换`)
  }
})

await t('监听器第二次触发（同一进程另一个会话）仍能工作', async () => {
  const r = await run({
    rawConfig: HIT,
    agent: makeAgent(),
    host: { currentPreset: 'standard', boundary: BLANK },
  })
  eq(r.selects, ['creative'])
})

// ══════════════════════════════════════════════════════════════
// 5. 降级不变成故障：配置里坏了也只 warn
// ══════════════════════════════════════════════════════════════

await t('patch 里 config 为 undefined（没写 config 块）→ 用默认值，不抛错', async () => {
  // 直接调 apply 而不经过 Config 解析，模拟 Loader 没给 config 的情形
  const warns = []
  let registered = 0
  plugin.apply(
    {
      logger: () => ({ warn: (m) => warns.push(m), info: () => {} }),
      get: () => undefined,
      inject: (names, cb) => {
        cb({
          on: () => {
            registered += 1
          },
          agentPresets: { composedPreset: () => 'standard', select: async () => 'x' },
          workspaceRegistry: { resolveByPath: async () => undefined },
          sessionProjections: { stateOf: () => undefined },
        })
      },
    },
    undefined,
  )
  eq(registered, 1, '仍应注册监听器')
  eq(warns, [])
})

// ══════════════════════════════════════════════════════════════
// 6. 探针确实落盘，且成功路径不写噪声
// ══════════════════════════════════════════════════════════════

await t('探针写了 probe.log，含 apply-enter / apply-done / switched', () => {
  const path = join(home, 'workspace-preset', 'probe.log')
  assert(existsSync(path), `${path} 不存在`)
  const text = readFileSync(path, 'utf8')
  assert(text.includes('apply-enter'), '缺 apply-enter')
  assert(text.includes('apply-done'), '缺 apply-done')
  assert(text.includes('switched:'), '缺 switched')
})

await t('跳过原因每类只记一行（不刷日志）', () => {
  const text = readFileSync(join(home, 'workspace-preset', 'probe.log'), 'utf8')
  const unmapped = text.split('\n').filter((l) => l.includes('skip unmapped'))
  assert(unmapped.length <= 1, `unmapped 记了 ${unmapped.length} 行，应 ≤1`)
})

await t('失败路径记进 probe.log', () => {
  const text = readFileSync(join(home, 'workspace-preset', 'probe.log'), 'utf8')
  assert(text.includes('select-failed'), '缺 select-failed')
})

// ══════════════════════════════════════════════════════════════
// 报告
// ══════════════════════════════════════════════════════════════

rmSync(home, { recursive: true, force: true })

const total = pass + fails.length
if (fails.length === 0) {
  console.log(`ok — smoke ${pass}/${total} passed`)
  process.exit(0)
}
console.error(`FAILED — ${fails.length}/${total}`)
for (const f of fails) console.error('  ✗ ' + f)
process.exit(1)
