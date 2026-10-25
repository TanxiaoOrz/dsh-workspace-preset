/**
 * 门禁判定（纯函数）：给定会话头 + 映射 + 工作区，决定"要不要切、切成什么"。
 *
 * ## 为什么门禁要单独成文件、且必须是纯函数
 *
 * 它是整个插件唯一会**改变用户会话状态**的决定点，也是最需要能被单独测试的部分。
 * 把它写成"输入普通值、输出普通值"，就能在没有宿主、没有 profile 的情况下
 * 穷举所有分支（见 `scripts/resolve-test.mjs`）。
 *
 * ## 判定顺序就是优先级
 *
 * G0–G7 的顺序不是随手排的，每一步都挡掉一类误伤：
 *
 * | 门 | 挡掉什么 |
 * |---|---|
 * | G0 | 总开关关掉时，行为必须完全等于宿主原生 |
 * | G1 | 子代理会话与父会话同 cwd，绝不能把它也换了组合 |
 * | G2 | 分叉/种子会话继承父会话语义，改它就是篡改历史 |
 * | G3 | 没有 cwd 就无法判工作区 |
 * | G4 | 不在任何工作区内（例如按 cwd 直接开的会话） |
 * | G5 | 该工作区没配置（或配置为空串） |
 * | G6 | 已经是目标 preset，白切一次要多挂一遍组合 |
 * | G7 | `resume` 且**已开轮**的老会话——"新会话默认"不许污染历史会话 |
 *
 * 注意 G6 与 G7 的先后：先判"是否已经相同"能省掉一次昂贵的空白判定，且语义更清楚
 * ——"它已经是了"比"它是老会话"更根本。
 *
 * @module dsh-workspace-preset/target
 */

import { isBlankBoundary, wantedPreset } from './resolve.js'

/** 跳过原因（写进探针，只在失败/未命中时记录）。 */
export const SKIP = {
  disabled: 'disabled',
  subagent: 'subagent',
  parented: 'parented',
  noCwd: 'no-cwd',
  noWorkspace: 'no-workspace',
  unmapped: 'unmapped',
  already: 'already-target',
  started: 'resume-started',
}

/**
 * 完整门禁：返回"切"还是"不切"，以及不切的原因。
 *
 * @param {object} input
 * @param {boolean} input.enabled - 总开关（G0）。
 * @param {{ cwd?: string, origin?: string, parentSession?: string }} input.header - 会话头（只读这四个字段）。
 * @param {'startup'|'resume'|'clear'|'compact'|string} input.source - `agent/created` 的 source。
 * @param {Record<string, unknown>} input.map - `presetByWorkspace` 映射。
 * @param {string|undefined} input.workspaceId - 由 `resolveByPath(cwd)` 得到的工作区 id。
 * @param {string|undefined} input.currentPreset - 当前已组合的 preset id（`composedPreset`）。
 * @param {{ lastTurn?: unknown, openTurnStartSeq?: unknown }|undefined} input.boundary - `turnBoundary` 投影。
 * @returns {{ action: 'skip', reason: string } | { action: 'switch', workspaceId: string, presetId: string }}
 */
export function evaluateGate(input) {
  const {
    enabled,
    header,
    source,
    map,
    workspaceId,
    currentPreset,
    boundary,
  } = input ?? {}

  // G0 总开关：关掉后行为必须与未安装本插件完全一致。
  if (enabled !== true) return { action: 'skip', reason: SKIP.disabled }

  if (header === null || typeof header !== 'object') {
    return { action: 'skip', reason: SKIP.noCwd }
  }

  // G1 子代理：与父会话同 cwd，但它的组合由父会话派生，不是"新会话"。
  if (header.origin === 'subagent') return { action: 'skip', reason: SKIP.subagent }

  // G2 分叉/种子会话：继承父会话语义，"新会话默认"不该回溯改写它。
  if (header.parentSession !== undefined) return { action: 'skip', reason: SKIP.parented }

  // G3 没有 cwd 就没有工作区身份。
  if (typeof header.cwd !== 'string' || header.cwd === '') {
    return { action: 'skip', reason: SKIP.noCwd }
  }

  // G4 cwd 没对上任何工作区（resolveByPath 返回 undefined 或抛错时都走这里）。
  if (typeof workspaceId !== 'string' || workspaceId === '') {
    return { action: 'skip', reason: SKIP.noWorkspace }
  }

  // G5 该工作区没有映射（含空串）。
  const wanted = wantedPreset(map, workspaceId)
  if (wanted === undefined) return { action: 'skip', reason: SKIP.unmapped }

  // G6 已经是目标了。
  //
  // 用 `composedPreset`（setup 阶段建立的 scope 绑定）而不是
  // `sessionProjections.stateOf(session, 'agentPreset')`：后者是**日志里的已提交值**，
  // 在 `select` 成功前不会变，拿它比较会得出"永远不用切"。
  if (currentPreset === wanted) return { action: 'skip', reason: SKIP.already }

  // G7 老会话不回改。
  //
  // `resume` 有两种来源：用户重开历史会话（绝不能碰）与客户端 `reuseOrCreateBlank`
  // 复用了工作区里的**空白**会话（必须对齐，否则"改了设置却不生效"）。
  // 两者只能靠 turnBoundary 投影区分，且 `select()` 内部用的是同一份投影。
  if (source === 'resume' && !isBlankBoundary(boundary)) {
    return { action: 'skip', reason: SKIP.started }
  }

  return { action: 'switch', workspaceId, presetId: wanted }
}

/**
 * 门禁的瘦封装：只要结论。
 *
 * 参数同 {@link evaluateGate}。
 *
 * @param {Parameters<typeof evaluateGate>[0]} input
 * @returns {null | { workspaceId: string, presetId: string }}
 */
export function pickTarget(input) {
  const decision = evaluateGate(input)
  if (decision.action !== 'switch') return null
  return { workspaceId: decision.workspaceId, presetId: decision.presetId }
}
