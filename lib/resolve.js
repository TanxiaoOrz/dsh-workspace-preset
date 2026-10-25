/**
 * 纯函数层：映射表查询 + 空白会话判定。
 *
 * ## 为什么单独一个文件
 *
 * `lib/index.js` 会 `import '@deepseek-ai/schemastery'`，从工作区直接跑测试会
 * `ERR_MODULE_NOT_FOUND`（那个包只在 profile 的 node_modules 里）。把判定逻辑抽到这里，
 * `scripts/resolve-test.mjs` 就能零依赖全量单测。
 *
 * 本文件**不 import 任何 `@deepseek-ai/*`**，也不碰任何宿主对象：
 * 输入是普通 JS 值（字符串 / 对象 / 数字），输出是普通 JS 值。
 *
 * @module dsh-workspace-preset/resolve
 */

/**
 * 读该工作区配置的 preset id。
 *
 * 空串与 `undefined` 都表示"未配置"，一律回落到宿主全局默认。
 * 这是「跟随全局默认」在落盘后的两种可能形态（键被 unset → undefined；
 * 手改成空串 → ''），两者行为必须一致。
 *
 * @param {Record<string, unknown>} map - `presetByWorkspace` 映射。
 * @param {string} workspaceId - 工作区 id。
 * @returns {string|undefined} 要切到的 preset id，未配置时为 undefined。
 */
export function wantedPreset(map, workspaceId) {
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return undefined
  if (typeof workspaceId !== 'string' || workspaceId === '') return undefined
  const value = map[workspaceId]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * `turnBoundary` 投影 → 该会话是否"还没开始第一轮"。
 *
 * 判空白的唯一可靠依据是投影，不要去数事件条数：`select()` 内部用的就是同一份投影，
 * 两边口径必须一致，否则会出现"我们以为能切、`select` 却抛 locked"。
 *
 * 投影不存在（`undefined`）时**不算空白**——宁可放过，不要在信息不全时动别人的会话。
 *
 * @param {{ lastTurn?: unknown, openTurnStartSeq?: unknown }|undefined} boundary
 * @returns {boolean}
 */
export function isBlankBoundary(boundary) {
  if (boundary === null || typeof boundary !== 'object') return false
  return boundary.lastTurn === 0 && boundary.openTurnStartSeq === null
}

/**
 * 把任意来源的映射值规整成 `Record<string, string>`。
 *
 * 来源可能是 patch 里的 YAML 对象、volatile 引用的当前值、或 `JSON.parse` 的结果；
 * 统一在这里清掉空串与非字符串，下游只处理"干净的映射"。
 *
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
export function normalizeMap(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  /** @type {Record<string, string>} */
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || key === '') continue
    if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out
}

/**
 * 读一个 volatile 配置引用（或普通值）。
 *
 * volatile 字段的变更**不重挂插件 fiber**：Loader 把新值提交进运行中的引用并 emit
 * `loader/volatile-update`。所以每次使用都必须现读 `.get()`，绝不能缓存。
 *
 * @param {unknown} ref - volatile 引用或普通值。
 * @param {unknown} fallback - 缺失/读取失败时的回落值。
 * @returns {unknown}
 */
export function readVolatile(ref, fallback) {
  try {
    if (ref === undefined || ref === null) return fallback
    if (typeof ref.get === 'function') {
      const value = ref.get()
      return value === undefined ? fallback : value
    }
    return ref
  } catch {
    return fallback
  }
}
