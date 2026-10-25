/**
 * 一键跑全部测试。
 *
 * 三套：
 *   1. resolve-test.mjs          —— 纯逻辑（映射查询 / 空白判定 / G0–G7 门禁）
 *   2. client-structure-test.mjs —— 客户端半区结构（含迷你 React 渲染）
 *   3. smoke-host.mjs            —— Host 半区真实 import + apply + agent/created 端到端
 *
 * 前两套**零依赖**，从工作区直接跑。
 * 第三套要 import `lib/schema.js`，而它 `import '@deepseek-ai/schemastery'` ——
 * 那个包只在 profile 的 node_modules 里。所以本脚本会：
 *   - 若当前目录能解析到 schemastery，直接跑；
 *   - 否则自动搭一个临时目录（junction 到 profile 的 schemastery）再跑。
 *
 * 用法：`node scripts/test-all.mjs`
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/**
 * @param {string} label
 * @param {string} script 绝对路径
 * @param {string} [cwd]
 */
function runSuite(label, script, cwd = root) {
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
    process.stdout.write(`   ✗ ${label} 失败（exit ${error?.status ?? '?'}）\n`)
    return false
  }
}

/** 找出 profile 里 schemastery 的位置。 */
function findSchemastery() {
  const require = createRequire(join(root, 'package.json'))
  try {
    return dirname(require.resolve('@deepseek-ai/schemastery/package.json'))
  } catch {
    /* 继续找 profile */
  }
  const home = process.env.DSH_HOME
  if (typeof home !== 'string' || home === '') return undefined
  const candidate = join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'schemastery')
  return existsSync(candidate) ? candidate : undefined
}

let ok = true
ok = runSuite('纯逻辑（lib/resolve.js + lib/target.js）', join(here, 'resolve-test.mjs')) && ok
ok = runSuite('客户端结构（client.js）', join(here, 'client-structure-test.mjs')) && ok

// Host 冒烟：需要 schemastery
const schemaDir = findSchemastery()
if (schemaDir === undefined) {
  process.stdout.write('\n── Host 冒烟 ──\n')
  process.stdout.write('   ⚠ 跳过：找不到 @deepseek-ai/schemastery。')
  process.stdout.write('设好 DSH_HOME 或在本 profile 里跑即可执行。\n')
} else {
  const stage = mkdtempSync(join(tmpdir(), 'wsp-hosttest-'))
  try {
    const scopeDir = join(stage, 'node_modules', '@deepseek-ai')
    mkdirSync(scopeDir, { recursive: true })
    symlinkSync(schemaDir, join(scopeDir, 'schemastery'), 'junction')
    cpSync(join(root, 'lib'), join(stage, 'plugin', 'lib'), { recursive: true })
    cpSync(join(root, 'package.json'), join(stage, 'plugin', 'package.json'))

    // smoke-host.mjs 里写的是绝对 file:// URL，临时目录里要换成相对路径。
    const smoke = execFileSync(process.execPath, ['-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8"))', join(here, 'smoke-host.mjs')], { encoding: 'utf8' })
    writeFileSync(
      join(stage, 'smoke.mjs'),
      smoke.replace(
        'file:///D:/Program Code/plugins/WorkspacePreset/lib/index.js',
        './plugin/lib/index.js',
      ),
      'utf8',
    )
    ok = runSuite('Host 冒烟（lib/index.js 真实 import + 门禁）', join(stage, 'smoke.mjs'), stage) && ok
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
