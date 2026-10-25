/**
 * 纯逻辑单测：`lib/resolve.js` + `lib/target.js`。
 *
 * ## 为什么不用测试框架
 *
 * 这两个模块**不 import 任何 `@deepseek-ai/*`**，就是为了能 `node scripts/resolve-test.mjs`
 * 直接从工作区跑通（profile 里的包在工作区 node_modules 里不存在）。
 * 引入 vitest/node:test 反而会要求在工作区装依赖，破坏这个约束。
 *
 * 所以这里是一个 40 行的自足断言器：无依赖、退出码可信、失败时打印差异。
 *
 * 用法：`node scripts/resolve-test.mjs`
 * 退出码：0 = 全绿，1 = 有失败。
 */

import { normalizeMap, isBlankBoundary, readVolatile, wantedPreset } from '../lib/resolve.js'
import { evaluateGate, pickTarget, SKIP } from '../lib/target.js'

let passed = 0
const failures = []

/**
 * @param {string} name
 * @param {() => void} body
 */
function test(name, body) {
  try {
    body()
    passed += 1
  } catch (error) {
    failures.push({ name, error })
  }
}

/**
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string} [what]
 */
function eq(actual, expected, what = 'value') {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`)
}

function ok(value, what = 'value') {
  if (!value) throw new Error(`${what}: expected truthy, got ${JSON.stringify(value)}`)
}

// ─────────────────────────────────────────────────────────────
// wantedPreset
// ─────────────────────────────────────────────────────────────

test('wantedPreset: 有映射', () => {
  eq(wantedPreset({ 'ws-1': 'creative' }, 'ws-1'), 'creative')
})

test('wantedPreset: 无该工作区的键 → undefined', () => {
  eq(wantedPreset({ 'ws-1': 'creative' }, 'ws-2'), undefined)
})

test('wantedPreset: 空串视为未配置', () => {
  eq(wantedPreset({ 'ws-1': '' }, 'ws-1'), undefined)
})

test('wantedPreset: 非字符串值被忽略（YAML 里误写成数字/布尔）', () => {
  eq(wantedPreset({ 'ws-1': 42 }, 'ws-1'), undefined)
  eq(wantedPreset({ 'ws-1': true }, 'ws-1'), undefined)
  eq(wantedPreset({ 'ws-1': null }, 'ws-1'), undefined)
  eq(wantedPreset({ 'ws-1': { nested: 'x' } }, 'ws-1'), undefined)
})

test('wantedPreset: 空映射 / 非对象 / 数组 / null 一律 undefined', () => {
  eq(wantedPreset({}, 'ws-1'), undefined)
  eq(wantedPreset(null, 'ws-1'), undefined)
  eq(wantedPreset(undefined, 'ws-1'), undefined)
  eq(wantedPreset([], 'ws-1'), undefined)
  eq(wantedPreset('nope', 'ws-1'), undefined)
})

test('wantedPreset: workspaceId 非字符串或空串 → undefined', () => {
  eq(wantedPreset({ 'ws-1': 'x' }, ''), undefined)
  eq(wantedPreset({ 'ws-1': 'x' }, undefined), undefined)
  eq(wantedPreset({ 'ws-1': 'x' }, 1), undefined)
})

test('wantedPreset: 原型链上的键不应被当成映射值（防 prototype 污染误命中）', () => {
  // 直接读 `map['toString']` 会拿到函数——必须被 typeof 检查挡掉。
  eq(wantedPreset({}, 'toString'), undefined)
})

// ─────────────────────────────────────────────────────────────
// isBlankBoundary
// ─────────────────────────────────────────────────────────────

test('isBlankBoundary: 未开始 → true', () => {
  eq(isBlankBoundary({ lastTurn: 0, openTurnStartSeq: null }), true)
})

test('isBlankBoundary: 已开轮 → false', () => {
  eq(isBlankBoundary({ lastTurn: 1, openTurnStartSeq: null }), false)
})

test('isBlankBoundary: 有个未结束的轮 → false', () => {
  eq(isBlankBoundary({ lastTurn: 0, openTurnStartSeq: 12 }), false)
})

test('isBlankBoundary: 投影缺失/异常 → false（信息不全时不动别人的会话）', () => {
  eq(isBlankBoundary(undefined), false)
  eq(isBlankBoundary(null), false)
  eq(isBlankBoundary({}), false)
  eq(isBlankBoundary([]), false)
  // lastTurn 缺省时不能靠 falsy 蒙对
  eq(isBlankBoundary({ openTurnStartSeq: null }), false)
})

// ─────────────────────────────────────────────────────────────
// normalizeMap / readVolatile
// ─────────────────────────────────────────────────────────────

test('normalizeMap: 剔空串、剔非字符串、保留其余', () => {
  eq(normalizeMap({ a: 'x', b: '', c: 1, d: null }), { a: 'x' })
})

test('normalizeMap: 非对象入参 → {}', () => {
  eq(normalizeMap(null), {})
  eq(normalizeMap(undefined), {})
  eq(normalizeMap([]), {})
  eq(normalizeMap('a'), {})
})

test('readVolatile: 引用取 .get()', () => {
  eq(readVolatile({ get: () => 'v' }, 'fallback'), 'v')
})

test('readVolatile: 普通值直接返回', () => {
  eq(readVolatile('v', 'fallback'), 'v')
})

test('readVolatile: undefined → fallback', () => {
  eq(readVolatile(undefined, 'fallback'), 'fallback')
})

test('readVolatile: .get() 返回 undefined → fallback', () => {
  eq(readVolatile({ get: () => undefined }, 'fallback'), 'fallback')
})

test('readVolatile: .get() 抛错 → fallback（不把插件带崩）', () => {
  eq(readVolatile({ get: () => { throw new Error('boom') } }, 'fallback'), 'fallback')
})

// ─────────────────────────────────────────────────────────────
// evaluateGate —— 逐门
// ─────────────────────────────────────────────────────────────

/** 一个"全部条件都满足、应当切换"的基线输入。 */
function baseline(overrides = {}) {
  return {
    enabled: true,
    header: { cwd: 'D:\\work\\a' },
    source: 'startup',
    map: { 'ws-a': 'creative' },
    workspaceId: 'ws-a',
    currentPreset: 'standard',
    boundary: { lastTurn: 0, openTurnStartSeq: null },
    ...overrides,
  }
}

test('G0: enabled=false → 跳过（行为等于宿主原生）', () => {
  const d = evaluateGate(baseline({ enabled: false }))
  eq(d, { action: 'skip', reason: SKIP.disabled })
})

test('G0: enabled 缺失（undefined）也视为关闭', () => {
  eq(evaluateGate(baseline({ enabled: undefined })).action, 'skip')
})

test('基线：全部满足 → 切到映射的 preset', () => {
  eq(evaluateGate(baseline()), {
    action: 'switch',
    workspaceId: 'ws-a',
    presetId: 'creative',
  })
})

test('G1: origin=subagent → 跳过', () => {
  const d = evaluateGate(baseline({ header: { cwd: 'D:\\work\\a', origin: 'subagent' } }))
  eq(d, { action: 'skip', reason: SKIP.subagent })
})

test('G2: parentSession 存在（分叉会话）→ 跳过', () => {
  const d = evaluateGate(
    baseline({ header: { cwd: 'D:\\work\\a', parentSession: 'parent-1' } }),
  )
  eq(d, { action: 'skip', reason: SKIP.parented })
})

test('G2: parentSession 为 undefined 的显式键仍算没有父（不误伤）', () => {
  const d = evaluateGate(
    baseline({ header: { cwd: 'D:\\work\\a', parentSession: undefined } }),
  )
  eq(d.action, 'switch')
})

test('G3: 无 cwd → 跳过', () => {
  eq(evaluateGate(baseline({ header: {} })), { action: 'skip', reason: SKIP.noCwd })
  eq(evaluateGate(baseline({ header: { cwd: '' } })), { action: 'skip', reason: SKIP.noCwd })
  eq(evaluateGate(baseline({ header: null })), { action: 'skip', reason: SKIP.noCwd })
})

test('G4: cwd 没命中任何工作区 → 跳过', () => {
  eq(evaluateGate(baseline({ workspaceId: undefined })), {
    action: 'skip',
    reason: SKIP.noWorkspace,
  })
  eq(evaluateGate(baseline({ workspaceId: '' })), {
    action: 'skip',
    reason: SKIP.noWorkspace,
  })
})

test('G5: 该工作区无映射 → 跳过', () => {
  eq(evaluateGate(baseline({ map: {} })), { action: 'skip', reason: SKIP.unmapped })
  eq(evaluateGate(baseline({ map: { 'ws-a': '' } })), {
    action: 'skip',
    reason: SKIP.unmapped,
  })
})

test('G5: 映射里有别的键、但没有本工作区 → 跳过', () => {
  eq(evaluateGate(baseline({ map: { 'ws-b': 'creative' } })), {
    action: 'skip',
    reason: SKIP.unmapped,
  })
})

test('G6: 当前 preset 已等于目标 → 跳过', () => {
  eq(evaluateGate(baseline({ currentPreset: 'creative' })), {
    action: 'skip',
    reason: SKIP.already,
  })
})

test('G6: currentPreset 未知（undefined）时不算"已经相同"，交给 select 判断', () => {
  eq(evaluateGate(baseline({ currentPreset: undefined })).action, 'switch')
})

test('G7: resume + 非空白 → 跳过（老会话不回改）', () => {
  const d = evaluateGate(
    baseline({ source: 'resume', boundary: { lastTurn: 3, openTurnStartSeq: null } }),
  )
  eq(d, { action: 'skip', reason: SKIP.started })
})

test('G7: resume + 空中有未结束轮 → 跳过', () => {
  const d = evaluateGate(
    baseline({ source: 'resume', boundary: { lastTurn: 0, openTurnStartSeq: 7 } }),
  )
  eq(d, { action: 'skip', reason: SKIP.started })
})

test('G7: resume + 空白（复用空白会话）→ 切换（R1 对齐）', () => {
  const d = evaluateGate(
    baseline({ source: 'resume', boundary: { lastTurn: 0, openTurnStartSeq: null } }),
  )
  eq(d, { action: 'switch', workspaceId: 'ws-a', presetId: 'creative' })
})

test('G7: resume + 投影缺失 → 跳过（不肯在信息不全时动老会话）', () => {
  eq(evaluateGate(baseline({ source: 'resume', boundary: undefined })).action, 'skip')
})

test('G7: startup 不看 boundary（新建会话必然是空白）', () => {
  const d = evaluateGate(
    baseline({ source: 'startup', boundary: { lastTurn: 5, openTurnStartSeq: 9 } }),
  )
  eq(d.action, 'switch')
})

test('clear / compact 走 create 分支语义：非 resume 即不看 boundary', () => {
  eq(evaluateGate(baseline({ source: 'clear' })).action, 'switch')
  eq(evaluateGate(baseline({ source: 'compact' })).action, 'switch')
})

test('门禁顺序：G1 优先于 G5（子代理即使同工作区有映射也不碰）', () => {
  const d = evaluateGate(
    baseline({ header: { cwd: 'D:\\work\\a', origin: 'subagent' }, map: {} }),
  )
  eq(d.reason, SKIP.subagent)
})

test('门禁顺序：G5 优先于 G6（没映射时不下"已相同"的结论）', () => {
  const d = evaluateGate(baseline({ map: {}, currentPreset: 'creative' }))
  eq(d.reason, SKIP.unmapped)
})

test('evaluateGate: 入参为 null/undefined 不抛错', () => {
  eq(evaluateGate(null).action, 'skip')
  eq(evaluateGate(undefined).action, 'skip')
})

// ─────────────────────────────────────────────────────────────
// pickTarget
// ─────────────────────────────────────────────────────────────

test('pickTarget: 命中返回 { workspaceId, presetId }', () => {
  eq(pickTarget(baseline()), { workspaceId: 'ws-a', presetId: 'creative' })
})

test('pickTarget: 任一跳过条件 → null', () => {
  eq(pickTarget(baseline({ enabled: false })), null)
  eq(pickTarget(baseline({ header: { cwd: 'D:\\work\\a', origin: 'subagent' } })), null)
  eq(pickTarget(baseline({ source: 'resume', boundary: { lastTurn: 2, openTurnStartSeq: null } })), null)
})

// ─────────────────────────────────────────────────────────────
// 报告
// ─────────────────────────────────────────────────────────────

const total = passed + failures.length
if (failures.length === 0) {
  console.log(`ok — ${passed}/${total} assertions passed`)
  process.exit(0)
}

console.error(`FAILED — ${failures.length}/${total} failed\n`)
for (const { name, error } of failures) {
  console.error(`  ✗ ${name}`)
  console.error(`    ${error?.message ?? error}`)
}
process.exit(1)
