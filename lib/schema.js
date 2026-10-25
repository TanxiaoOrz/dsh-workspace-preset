/**
 * 插件的 Config schema —— 它**就是**设置页的数据源。
 *
 * ## 所有字段都必须 `.volatile()`
 *
 * 宿主 `dsh-settings` 的表单投影只收 volatile 字段：
 *
 * - `volatileForm()` 一个 volatile 字段都投影不出来时返回 `undefined`，
 *   `describe()` 随即把整个条目丢弃 —— 设置页根本不会出现；
 * - 写入路径逐字段走 `isVolatilePath()`，非 volatile 直接抛
 *   `Config field "..." is not volatile`。
 *
 * volatile 字段的变更**不重挂插件 fiber**：Loader 把新值提交进运行中的引用并
 * emit `loader/volatile-update`。所以读取必须**每次现读** `readVolatile()`，
 * 绝不能把值缓存到闭包里（见 `lib/resolve.js` 的 `readVolatile`）。
 *
 * ## 为什么 `presetByWorkspace` 是 dict + 在 dict 节点上 volatile
 *
 * `isVolatilePath()` 的实现是「节点自身 volatile → 整棵子树可写」，
 * `volatileForm()` 也是同一个判据（`schema.meta.volatile` 就先 `plainSchema`）。
 * 把 `.volatile()` 打在 dict 节点上，`['presetByWorkspace', wsId]` 这条路径
 * 才既可投影又可写。这一点已用真实 schemastery 实测确认：
 * `z.dict(z.string()).volatile()` 的 `meta.volatile === true` 且 `type === 'dict'`。
 *
 * 退路（万一未来构建改了这条判据）：把整张映射降级成单个 JSON 字符串字段
 * `workspacePresetsJson`，路径只有一段，必然在 volatile 之下。客户端只需自己
 * `JSON.parse` + 合并。设计方案 §4.2 记录了这个退路，**当前未启用**。
 *
 * ## 键为什么是 WorkspaceId 而不是路径
 *
 * 路径进 YAML 要处理 Windows 反斜杠转义，且大小写/软链/8.3 短名会让字符串比较
 * 失败；`resolveByPath()` 已经做完 `realpath` 规范化并直接给出 id，复用它即可。
 * 代价：工作区被删除后 id 变化，那条映射失效 —— 可接受（后果只是回落全局默认）。
 *
 * @module dsh-workspace-preset/schema
 */

import z from '@deepseek-ai/schemastery'

/**
 * 插件配置。
 *
 * 字段顺序即设置页的展示顺序。
 */
export const Config = z.object({
  /** 总开关。关闭后行为**完全等于**未安装本插件。 */
  enabled: z
    .boolean()
    .default(true)
    .description('按工作区指定新会话的 agent preset')
    .volatile(),

  /**
   * 工作区 id → preset id。
   *
   * 空串与「键不存在」都表示跟随全局默认；UI 写「跟随」时用 `unset`，
   * 让键真正消失，而不是留一个空串。
   */
  presetByWorkspace: z
    .dict(z.string())
    .default({})
    .description('每个工作区新建会话使用的 preset；未配置的工作区走全局默认')
    .volatile(),
})
