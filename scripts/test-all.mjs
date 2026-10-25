/**
 * 一键跑全部测试。
 *
 * 三套：
 *   1. `resolve-test.mjs`          —— 纯逻辑（映射查询 / 空白判定 / G0–G7 门禁）
 *   2. `client-structure-test.mjs` —— 客户端半区结构（含迷你 React 渲染）
 *   3. `smoke-host.mjs`            —— Host 半区真实 import + 真实 Config 解析 + 端到端
 *
 * 前两套**零依赖**，从工作区直接跑。
 * 第三套要 `import lib/schema.js`，而它 `import '@deepseek-ai/schemastery'` ——
 * 那个包只在 profile 的 node_modules 里。本脚本的做法：
 *
 *   - 当前目录能解析到 schemastery → 就地跑（profile 里 / 已装依赖时）
 *   - 否则搭一个临时目录，**复刻 profile 的目录布局**：
 *
 *       <stage>/node_modules/@deepseek-ai/schemastery  ← junction 到 profile 那份
 *       <stage>/lib/**                                 ← 拷本仓库的 lib
 *       <stage>/package.json
 *       <stage>/scripts/smoke-host.mjs                 ← 拷本仓库的测试
 *
 *     这样 `lib/schema.js` 向上找 node_modules 就能命中，且 `scripts/../lib`
 *     也自然成立 —— 不需要在测试文件里写死绝对路径。
 *
 * 用法：`node scripts/test-all.mjs`
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/**
 * 跑一套测试，把输出转出来。
 *
 * @param {string} label
 * @param {string} script 绝对路径
 * @param {string} cwd
 * @returns {boolean} 是否通过
 */
function runSuite(label, script, cwd) {
  process.stdout.write(`\n── ${label} ──\n`)
  try {
    const out = execFileSync(process.execPath, [script], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    process.stdout.write(out.trimEnd() + '\n')
    return true
  } catch (error) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout.trimEnd() : ''
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trimEnd() : ''
    if (stdout !== '') process.stdout.write(stdout + '\n')
    if (stderr !== '') process.stderr.write(stderr + '\n')
    process.stdout.write(`   ✗ 失败（exit ${error?.status ?? '?'}）\n`)
    return false
  }
}

/** 找出 `@deepseek-ai/schemastery` 的包目录。 */
function findSchemastery() {
  try {
    const require = createRequire(join(root, 'package.json'))
    return dirname(require.resolve('@deepseek-ai/schemastery/package.json'))
  } catch {
    /* 继续找 profile */
  }
  const home = process.env.DSH_HOME
  if (typeof home !== 'string' || home === '') return undefined
  for (const profile of ['web', 'desktop']) {
    const candidate = join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', 'schemastery')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

let ok = true
ok = runSuite('纯逻辑（lib/resolve.js + lib/target.js）', join(here, 'resolve-test.mjs'), root) && ok
ok = runSuite('客户端结构（client.js）', join(here, 'client-structure-test.mjs'), root) && ok

const schemaDir = findSchemastery()
if (schemaDir === undefined) {
  process.stdout.write('\n── Host 冒烟（lib/index.js） ──\n')
  process.stdout.write('   ⚠ 跳过：找不到 @deepseek-ai/schemastery。\n')
  process.stdout.write('   设好 DSH_HOME，或在 profile 目录里跑，即可执行这套。\n')
} else {
  const stage = mkdtempSync(join(tmpdir(), 'wsp-hosttest-'))
  try {
    // node_modules/@deepseek-ai/schemastery（junction，避免真拷一份）
    const scopeDir = join(stage, 'node_modules', '@deepseek-ai')
    mkdirSync(scopeDir, { recursive: true })
    symlinkSync(schemaDir, join(scopeDir, 'schemastery'), 'junction')

    // 本仓库的 lib + package.json，放到 stage 根
    cpSync(join(root, 'lib'), join(stage, 'lib'), { recursive: true })
    cpSync(join(root, 'package.json'), join(stage, 'package.json'))

    // 测试放到 stage/scripts，让 `scripts/../lib` 自然成立
    mkdirSync(join(stage, 'scripts'), { recursive: true })
    cpSync(join(here, 'smoke-host.mjs'), join(stage, 'scripts', 'smoke-host.mjs'))

    ok = runSuite('Host 冒烟（lib/index.js 真实 import + 真实 Config 解析）', join(stage, 'scripts', 'smoke-host.mjs'), stage) && ok
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

process.stdout.write('\n')
if (ok) {
  process.stdout.write('全部通过 ✅\n')
  process.exit(0)
}
process.stdout.write('有失败 ❌\n')
process.exit(1)
