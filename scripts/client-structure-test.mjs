/**
 * 客户端半区结构测试（零依赖，在 node 里跑）。
 *
 * 验证：
 *   1. `client.js` 能被 `window.__ModuleLoader__.load({id, factory})` 装载
 *   2. `factory(require)` 返回 `{ inject, apply }`，`inject` 覆盖要用的通道
 *   3. `apply(ctx)` 是**同步**的、注册进 `settings.section`、inject 面引用稳定
 *   4. `Section` 渲染不抛错，各状态（未配置/已配置/broken/只读/未就绪/空列表/失效映射）正确
 *   5. 三条写入路径的形状：`set` / `unset` / `setEnabled`
 *
 * ## 为什么要写一个迷你 React
 *
 * workspace 里没有 react，而 `client.js` 里 `require('react')`。这几条断言真正要测的是
 * **异步 effect 跑完之后**的状态（preset 花名册是 `useEffect` 里拉的），
 * 所以替身必须真的会：跑 effect、setState 后重渲染。
 * 用一个「渲染直到没有 effect 再触发状态」的极小运行时即可。
 *
 * 用法：`node scripts/client-structure-test.mjs`
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client.js')

// ══════════════════════════════════════════════════════════════
// 迷你 React（只覆盖本插件用到的 API）
// ══════════════════════════════════════════════════════════════

/** 当前正在渲染的组件实例。 */
let currentInstance = null

function createElement(type, props, ...children) {
  const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
  return { $$el: true, type, props: props ?? {}, children: flat }
}

function useState(init) {
  const inst = currentInstance
  const index = inst.cursor
  inst.cursor += 1
  if (!(index in inst.state)) {
    inst.state[index] = typeof init === 'function' ? init() : init
  }
  const setter = (next) => {
    const value = typeof next === 'function' ? next(inst.state[index]) : next
    if (JSON.stringify(value) === JSON.stringify(inst.state[index])) return
    inst.state[index] = value
    inst.dirty = true
  }
  return [inst.state[index], setter]
}

function useRef(init) {
  const inst = currentInstance
  const index = inst.cursor
  inst.cursor += 1
  if (!(index in inst.refs)) inst.refs[index] = { current: init }
  return inst.refs[index]
}

/** effect 依赖比较：浅比，`undefined` 依赖数组 = 每次都跑。 */
function sameDeps(a, b) {
  if (a === undefined || b === undefined) return false
  if (a.length !== b.length) return false
  return a.every((v, i) => Object.is(v, b[i]))
}

function useEffect(callback, deps) {
  const inst = currentInstance
  const index = inst.cursor
  inst.cursor += 1
  const previous = inst.effects[index]
  if (previous !== undefined && sameDeps(previous.deps, deps)) return
  inst.pendingEffects.push({ index, callback, deps })
}

const React = {
  createElement,
  useState,
  useEffect,
  useRef,
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}

/**
 * 挂载并渲染，跑完所有 effect（含 effect 里 setState 引起的重渲染），
 * 直到状态稳定。返回最后一次渲染的元素树。
 *
 * @param {(props: any) => any} Component
 * @param {object} props
 * @param {number} [maxRounds]
 * @returns {Promise<any>}
 */
async function renderStable(Component, props, maxRounds = 30) {
  const inst = {
    state: {},
    refs: {},
    effects: {},
    pendingEffects: [],
    cursor: 0,
    dirty: true,
  }
  let tree
  for (let round = 0; round < maxRounds; round += 1) {
    currentInstance = inst
    inst.cursor = 0
    inst.pendingEffects = []
    inst.dirty = false
    tree = Component(props)

    // 跑本次渲染登记的 effect
    const effects = inst.pendingEffects
    for (const { index, callback, deps } of effects) {
      const cleanup = callback()
      inst.effects[index] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
    }

    // effect 里 setState 了 → 再渲染一轮；否则还要给微任务（异步 effect）一次机会
    if (inst.dirty) continue
    if (round === 0 && effects.length > 0) {
      // 异步 effect（拉 preset 花名册）在微任务后才 setState
      await Promise.resolve()
      await Promise.resolve()
      if (inst.dirty) continue
    }
    break
  }
  currentInstance = null
  return tree
}

/** 深度遍历元素树，收集某类元素。 */
function collect(tree, predicate, out = []) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return out
  if (tree.$$el === true) {
    if (predicate(tree)) out.push(tree)
    for (const child of tree.children) collect(child, predicate, out)
  }
  return out
}

/** 元素树 → 可搜索的 JSON 文本（断言提示文案用）。 */
function flattenText(tree) {
  if (tree === null || tree === undefined) return ''
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(flattenText).join(' ')
  if (tree.$$el === true) return tree.children.map(flattenText).join(' ')
  return ''
}

// ══════════════════════════════════════════════════════════════
// 断言器
// ══════════════════════════════════════════════════════════════

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
const eq = (actual, expected, what = '') => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${what} expected ${e} got ${a}`)
}
const assert = (cond, what = '') => {
  if (!cond) throw new Error(`${what} expected truthy`)
}

// ══════════════════════════════════════════════════════════════
// 装载 client.js
// ══════════════════════════════════════════════════════════════

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => {
      captured = definition
    },
  },
}

const source = readFileSync(clientPath, 'utf8')
await import(
  `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`
)

const mod = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})

// ══════════════════════════════════════════════════════════════
// 假客户端 ctx
// ══════════════════════════════════════════════════════════════

const PRESETS = {
  ok: true,
  value: {
    presets: [
      { id: 'standard', name: 'Standard', isDefault: true },
      { id: 'creative', name: 'Creative', isDefault: false },
      { id: 'broken-one', name: 'Broken', broken: 'load failed', isDefault: false },
    ],
  },
}

function makeClientCtx(options = {}) {
  const recorded = {
    styleTags: [],
    locales: [],
    slotRegistrations: [],
    mutations: [],
    formSet: [],
    formId: undefined,
    servedNamespaces: undefined,
    injectedSlot: undefined,
  }

  const form = {
    getSnapshot: () => options.snapshot,
    mutate: async (ops) => {
      recorded.mutations.push(ops)
      return true
    },
    set: async (field, value) => {
      recorded.formSet.push([field, value])
      return true
    },
  }

  const ctx = {
    effect: (fn) => {
      const cleanup = fn()
      return typeof cleanup === 'function' ? cleanup : () => {}
    },
    locale: {
      register: (ns, dicts) => {
        recorded.locales.push({ ns, dicts })
        return () => {}
      },
    },
    configForms: {
      get: (id) => {
        recorded.formId = id
        return form
      },
      whileServed: (namespaces, register) => {
        recorded.servedNamespaces = namespaces
        const off = register()
        return typeof off === 'function' ? off : () => {}
      },
    },
    slots: {
      inject: (name, cb) => {
        recorded.injectedSlot = name
        const off = cb()
        return typeof off === 'function' ? off : () => {}
      },
      register: (opts, component) => {
        recorded.slotRegistrations.push({ options: opts, component })
        return () => {}
      },
    },
    remote: {
      agentPresets: {
        list: async () => {
          if (options.presetsError === true) return { ok: false, error: { message: 'boom' } }
          return PRESETS
        },
      },
    },
  }

  globalThis.document = {
    head: { appendChild: (tag) => recorded.styleTags.push(tag) },
    createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
  }

  return { ctx, recorded }
}

const SNAPSHOT_EMPTY = { status: 'ready', writable: true, value: { enabled: true, presetByWorkspace: {} } }
const SNAPSHOT_MAPPED = {
  status: 'ready',
  writable: true,
  value: { enabled: true, presetByWorkspace: { 'ws-1': 'creative' } },
}

const WS = [
  { workspaceId: 'ws-1', path: 'D:\\work\\one', title: 'One' },
  { workspaceId: 'ws-2', path: 'D:\\work\\two', title: '' },
]

const tFn = (key) => `[${key}]`

/** 渲染一次并返回最后的树。 */
async function renderWith(snapshot, workspaces, presetsError = false) {
  const { ctx, recorded } = makeClientCtx({ snapshot, presetsError })
  mod.apply(ctx)
  const registration = recorded.slotRegistrations[0]
  const face = registration.options.inject()
  const tree = await renderStable(registration.component, {
    ...face,
    useForm: (selector) => selector(snapshot),
    useWorkspaces: (selector) => selector({ items: workspaces }),
    t: tFn,
  })
  return { tree, recorded, registration, face }
}

// ══════════════════════════════════════════════════════════════
// 1. 模块与注册形状
// ══════════════════════════════════════════════════════════════

await t('__ModuleLoader__.load 被调用', () => assert(captured !== null, 'captured'))
await t('loader id 是 dsh-workspace-preset', () => eq(captured.id, 'dsh-workspace-preset'))
await t('factory 返回 { inject, apply }', () => {
  eq(typeof mod.apply, 'function')
  assert(Array.isArray(mod.inject), 'inject 数组')
})
await t('inject 覆盖 slots/locale/configForms/remote.agentPresets', () => {
  for (const need of ['slots', 'locale', 'configForms', 'remote', 'remote.agentPresets']) {
    assert(mod.inject.includes(need), `inject 缺 ${need}`)
  }
})

{
  const { ctx, recorded } = makeClientCtx({ snapshot: SNAPSHOT_EMPTY })
  const returned = mod.apply(ctx)

  await t('apply 同步（不返回 Promise）', () => {
    assert(!(returned instanceof Promise), 'apply 返回了 Promise')
  })
  await t('apply 注入一个 <style>', () => eq(recorded.styleTags.length, 1))
  await t('apply 注册 locale 字典（en + zh）', () => {
    eq(recorded.locales.length, 1)
    eq(recorded.locales[0].ns, 'settings.workspacePreset')
    assert(recorded.locales[0].dicts.en !== undefined, 'en')
    assert(recorded.locales[0].dicts.zh !== undefined, 'zh')
  })
  await t('form 的 ENTRY_ID 是 loader 条目 id', () => eq(recorded.formId, 'workspace-preset'))
  await t('whileServed 盯本条目', () => eq(recorded.servedNamespaces, ['workspace-preset']))
  await t('注册进 settings.section', () => eq(recorded.injectedSlot, 'settings.section'))

  const registration = recorded.slotRegistrations[0]
  await t('槽位注册项字段正确', () => {
    eq(registration.options.name, 'settings.section')
    eq(registration.options.id, 'workspace-preset')
    eq(registration.options.order, 125)
    assert(typeof registration.options.label === 'function', 'label 是 thunk')
    eq(registration.options.locale, 'settings.workspacePreset')
  })
  await t('inject() 产出稳定引用（防无限重订阅）', () => {
    const a = registration.options.inject()
    const b = registration.options.inject()
    assert(a.setEnabled === b.setEnabled, 'setEnabled 不稳定')
    assert(a.setWorkspacePreset === b.setWorkspacePreset, 'setWorkspacePreset 不稳定')
    assert(a.readPresets === b.readPresets, 'readPresets 不稳定')
    assert(a.hooks.form === b.hooks.form, 'form 不稳定')
  })
}

// ══════════════════════════════════════════════════════════════
// 2. 渲染各状态
// ══════════════════════════════════════════════════════════════

const isSelect = (el) => el.type === 'select'

await t('渲染不抛错', async () => {
  await renderWith(SNAPSHOT_EMPTY, WS)
})

await t('两个工作区 → 两个 select', async () => {
  const { tree } = await renderWith(SNAPSHOT_EMPTY, WS)
  eq(collect(tree, isSelect).length, 2)
})

await t('未配置：select value 为 ""（跟随全局默认）', async () => {
  const { tree } = await renderWith(SNAPSHOT_EMPTY, WS)
  const selects = collect(tree, isSelect)
  eq(selects[0].props.value, '')
  eq(selects[1].props.value, '')
})

await t('已配置：select value 是映射里的 preset id', async () => {
  const { tree } = await renderWith(SNAPSHOT_MAPPED, WS)
  const selects = collect(tree, isSelect)
  eq(selects[0].props.value, 'creative')
  eq(selects[1].props.value, '')
})

await t('「跟随全局默认」是下拉第一项且 value 为 ""', async () => {
  const { tree } = await renderWith(SNAPSHOT_EMPTY, WS)
  eq(collect(tree, isSelect)[0].children[0].props.value, '')
})

await t('preset 花名册加载后：下拉含全部 preset', async () => {
  const { tree } = await renderWith(SNAPSHOT_EMPTY, WS)
  const options = collect(tree, isSelect)[0].children
  const values = options.map((o) => o.props.value)
  eq(values, ['', 'standard', 'creative', 'broken-one'])
})

await t('broken 的 preset 在下拉里被 disabled', async () => {
  const { tree } = await renderWith(SNAPSHOT_EMPTY, WS)
  const options = collect(tree, isSelect)[0].children
  const broken = options.find((o) => o.props.value === 'broken-one')
  assert(broken !== undefined, '没找到 broken 选项')
  eq(broken.props.disabled, true)
})

await t('花名册就绪后 select 可编辑', async () => {
  const { tree } = await renderWith(SNAPSHOT_EMPTY, WS)
  eq(collect(tree, isSelect)[0].props.disabled, false)
})

await t('只读部署：select 全部 disabled', async () => {
  const { tree } = await renderWith(
    { status: 'ready', writable: false, value: { enabled: true, presetByWorkspace: {} } },
    WS,
  )
  eq(collect(tree, isSelect)[0].props.disabled, true)
})

await t('表单未就绪：select 全部 disabled', async () => {
  const { tree } = await renderWith({ status: 'loading', writable: false, value: {} }, WS)
  eq(collect(tree, isSelect)[0].props.disabled, true)
})

await t('没有工作区：渲染空态而不抛错', async () => {
  const { tree } = await renderWith(SNAPSHOT_EMPTY, [])
  eq(collect(tree, isSelect).length, 0)
  assert(flattenText(tree).includes('[noWorkspace]'), '缺空态文案')
})

await t('花名册读取失败：下拉被 disabled（不知道有哪些 preset）', async () => {
  const { tree } = await renderWith(SNAPSHOT_EMPTY, WS, true)
  eq(collect(tree, isSelect)[0].props.disabled, true)
  assert(flattenText(tree).includes('[presetsError]'), '缺错误文案')
})

await t('失效映射只提示、不自动清理', async () => {
  const { tree, recorded } = await renderWith(
    {
      status: 'ready',
      writable: true,
      value: { enabled: true, presetByWorkspace: { 'ws-gone': 'standard' } },
    },
    WS,
  )
  assert(flattenText(tree).includes('ws-gone'), '没提示失效的 ws-gone')
  eq(recorded.mutations.length, 0, '不该有任何写入')
  // 失效键不影响现存工作区的下拉
  eq(collect(tree, isSelect)[0].props.value, '')
})

await t('已配置但 preset 不在花名册里：保留原值（不显示空白）', async () => {
  const { tree } = await renderWith(
    {
      status: 'ready',
      writable: true,
      value: { enabled: true, presetByWorkspace: { 'ws-1': 'deleted-preset' } },
    },
    WS,
  )
  eq(collect(tree, isSelect)[0].props.value, 'deleted-preset')
})

await t('enabled=false 时复选框未勾选', async () => {
  const { tree } = await renderWith(
    { status: 'ready', writable: true, value: { enabled: false, presetByWorkspace: {} } },
    WS,
  )
  const boxes = collect(tree, (el) => el.type === 'input')
  eq(boxes[0].props.checked, false)
})

// ══════════════════════════════════════════════════════════════
// 3. 写入路径
// ══════════════════════════════════════════════════════════════

{
  const { ctx, recorded } = makeClientCtx({ snapshot: SNAPSHOT_EMPTY })
  mod.apply(ctx)
  const face = recorded.slotRegistrations[0].options.inject()

  await face.setWorkspacePreset('ws-1', 'creative')
  await face.setWorkspacePreset('ws-2', '')
  await face.setEnabled(false)

  await t('选 preset → set path [presetByWorkspace, wsId]', () => {
    eq(recorded.mutations[0], [
      { op: 'set', path: ['presetByWorkspace', 'ws-1'], value: 'creative' },
    ])
  })
  await t('选「跟随全局默认」→ unset 该键（不是写空串）', () => {
    eq(recorded.mutations[1], [{ op: 'unset', path: ['presetByWorkspace', 'ws-2'] }])
  })
  await t('总开关走 form.set("enabled", …)', () => {
    eq(recorded.formSet[0], ['enabled', false])
  })
  await t('映射写入是局部 set，不整块覆盖', () => {
    const op = recorded.mutations[0][0]
    eq(op.path.length, 2, '路径段数（整块覆盖会是 1 段）')
  })
}

// ══════════════════════════════════════════════════════════════
// 报告
// ══════════════════════════════════════════════════════════════

const total = pass + fails.length
if (fails.length === 0) {
  console.log(`ok — client ${pass}/${total} passed`)
  process.exit(0)
}
console.error(`FAILED — ${fails.length}/${total}`)
for (const f of fails) console.error('  ✗ ' + f)
process.exit(1)
