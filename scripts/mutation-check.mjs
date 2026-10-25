/**
 * 变异测试：确认「保存反馈」那几条断言**真的会失败**。
 *
 * 只有证明测试会红，绿才有意义。这里逐个破坏实现，检查对应断言是否变红，
 * 然后恢复文件。
 *
 * 用法：`node scripts/mutation-check.mjs`
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const target = join(root, 'client.js')
const original = readFileSync(target, 'utf8')

/**
 * 跑一次客户端测试，返回 {ok, failed: [断言名]}。
 */
function runClientTest() {
  try {
    const out = execFileSync(process.execPath, [join(here, 'client-structure-test.mjs')], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, failed: [], out: out.trim() }
  } catch (error) {
    const stdout = String(error?.stdout ?? '')
    const failed = [...stdout.matchAll(/✗ (.+?):/g)].map((m) => m[1])
    return { ok: false, failed, out: stdout.trim() }
  }
}

/** 每个变异：一个说明 + 一次替换。替换必须真的命中。 */
const mutations = [
  {
    name: '删掉顶部横幅（第一层反馈）',
    from: "children.push(\n          h(\n            'div',\n            {\n              className: `wsp-toast ${notice.kind === 'ok' ? 'wsp-toast-ok' : 'wsp-toast-error'}`,",
    to: "void 0 && (() => {})(\n          h(\n            'div',\n            {\n              className: `wsp-x`,",
    expect: '顶部横幅',
  },
  {
    name: '删掉行高亮（第二层反馈）',
    from: "const rowClass =\n            'wsp-row' +\n            (flashing\n              ? ` wsp-row-flash ${\n                  notice.kind === 'ok' ? 'wsp-row-flash-ok' : 'wsp-row-flash-error'\n                }`\n              : '')",
    to: "const rowClass = 'wsp-row'",
    expect: '高亮',
  },
  {
    name: '删掉行内胶囊（第三层反馈）',
    from: "                flashing\n                  ? h(\n                      'span',",
    to: "                false\n                  ? h(\n                      'span',",
    expect: '胶囊',
  },
  {
    name: '把失败样式写成成功样式',
    from: "kind: ok ? 'ok' : 'error',",
    to: "kind: 'ok',",
    expect: '失败',
  },
]

const results = []
for (const mutation of mutations) {
  if (!original.includes(mutation.from)) {
    results.push({ ...mutation, applied: false, caught: null })
    continue
  }
  const mutated = original.replace(mutation.from, mutation.to)
  writeFileSync(target, mutated, 'utf8')
  const outcome = runClientTest()
  writeFileSync(target, original, 'utf8')
  results.push({
    ...mutation,
    applied: true,
    caught: !outcome.ok,
    failed: outcome.failed,
  })
}

// 恢复后必须仍然全绿
const final = runClientTest()

let bad = 0
console.log('\n变异测试：验证断言真的会红\n')
for (const r of results) {
  if (!r.applied) {
    bad += 1
    console.log(`  ? ${r.name} —— 替换没能命中源码（测试本身失效）`)
    continue
  }
  if (r.caught) {
    console.log(`  ✓ ${r.name} —— 被逮到（红）`)
    for (const f of r.failed ?? []) console.log(`      ↳ ${f}`)
  } else {
    bad += 1
    console.log(`  ✗ ${r.name} —— 破坏之后测试仍然全绿，说明这条断言是假的`)
  }
}

console.log('')
if (!final.ok) {
  console.log('恢复原文件后测试竟然是红的 —— 文件没还原干净！')
  console.log(final.out)
  process.exit(1)
}
console.log('恢复原文件后重新全绿 ✓')
if (bad === 0) {
  console.log('\n全部变异都被逮到 ✅')
  process.exit(0)
}
console.log(`\n有 ${bad} 个变异没被逮到 ❌`)
process.exit(1)
