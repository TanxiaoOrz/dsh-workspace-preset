/**
 * dsh-workspace-preset 的**浏览器半区**：设置里的「新会话预设」页。
 *
 * ## 数据通道
 *
 * | 数据 | 来源 |
 * |---|---|
 * | 工作区列表 | 槽位标准 prop `useWorkspaces`（`SnapshotSelectorHook<WorkspaceSnapshot>`）。**不要**去读 `ctx.workspaces.list` 或 root hook store —— 后者是 `dsh-client-ui-workspace` 的所有权范围，对方卸载时会连带把我们搞挂 |
 * | preset 花名册 | `ctx.remote.agentPresets.list()`，返回**信封**，必须解包 |
 * | 当前映射 | `ctx.configForms.get(ENTRY_ID)` 的 `getSnapshot().value` |
 * | 写入 | `form.mutate([...])` → profile 的 `cordis.patch.yml` |
 *
 * ## 为什么全是手写控件
 *
 * 这个构建里**没有**自动表单客户端；`dsh-client-ui-primitives` 是静态 bundle 不允许
 * import。所以控件自己画，颜色只用 `--dsw-alias-*` 主题 token（否则暗色主题下会瞎）。
 *
 * ## 两条硬约束
 *
 * 1. `apply` 必须**同步**：不许 `await`。挂在客户端启动序列里的异步等待会导致
 *    "新会话能开、消息发不出"。
 * 2. 传给组件的函数必须在 `apply` 里**建一次**。`inject: () => ({...})` 每次渲染都会
 *    重新求值；里面现写的箭头函数每次都是新引用，一旦进 `useEffect` 依赖数组就是
 *    「渲染 → 依赖变 → 重订阅 → 再渲染」的无限循环。
 */

window.__ModuleLoader__.load({
  id: 'dsh-workspace-preset',

  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 宿主 Loader 条目 id —— 必须与 cordis.patch.yml 里的 id 一致，不是包名。 */
    const ENTRY_ID = 'workspace-preset'
    /** locale 命名空间。 */
    const LOCALE_NS = 'settings.workspacePreset'
    /** Config 里存映射的字段名（与 lib/schema.js 一致）。 */
    const MAP_FIELD = 'presetByWorkspace'

    // ── 词条 ──────────────────────────────────────────────────────────

    const en = {
      title: 'New-session preset by workspace',
      intro:
        'Choose the agent preset a new session starts with in each workspace. Workspaces left on “Follow global default” use the global default.',
      notReady: 'This configuration is not available in this deployment.',
      readOnly: 'This deployment serves the configuration read-only.',
      enable: 'Enable per-workspace presets',
      enableHint: 'When off, every new session uses the global default, exactly as before.',
      globalDefaultIs: 'Current global default',
      noWorkspace: 'No workspace yet. Add one from the sidebar first.',
      follows: 'global',
      custom: 'custom',
      followGlobal: 'Follow global default',
      broken: '(unavailable)',
      globalTag: '· global',
      stalePrefix: 'Mappings for workspaces that no longer exist',
      staleHint: 'they are ignored',
      saved: 'Saved.',
      saveFailed: 'The Host refused the write; the previous value is still in effect.',
      presetsError: 'Could not read the preset list. Change the selection once it loads.',
      loading: 'Loading…',
    }

    const zh = {
      title: '新会话预设（按工作区）',
      intro:
        '为每个工作区指定新会话打开时使用的预设。保持「跟随全局默认」的工作区走全局设置。',
      notReady: '当前部署未提供这份配置。',
      readOnly: '当前部署的配置是只读的。',
      enable: '启用按工作区设置预设',
      enableHint: '关闭后，所有新会话都走全局默认，行为与未安装本插件时完全一致。',
      globalDefaultIs: '当前全局默认',
      noWorkspace: '还没有工作区。先在侧边栏添加一个。',
      follows: '跟随',
      custom: '已自定义',
      followGlobal: '跟随全局默认',
      broken: '（不可用）',
      globalTag: '· 全局',
      stalePrefix: '以下映射对应的工作区已不存在',
      staleHint: '会被忽略',
      saved: '已保存。',
      saveFailed: '宿主拒绝了这次写入，原值仍然生效。',
      presetsError: '预设列表读取失败。列表加载好后才能改这一行。',
      loading: '加载中…',
    }

    // ── 样式（只用主题 token，绝不写死颜色）──────────────────────────────

    const css = `
      .wsp-page { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 24px; }
      .wsp-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .wsp-hint { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
      .wsp-block { display: flex; flex-direction: column; gap: 8px;
                   padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l1);
                   border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
      .wsp-row { display: grid; grid-template-columns: 1fr 220px; gap: 12px;
                 align-items: center; padding: 8px 0;
                 border-top: 1px solid var(--dsw-alias-border-l1); }
      .wsp-row:first-of-type { border-top: none; }
      .wsp-meta { min-width: 0; }
      .wsp-name { font-size: 13px; color: var(--dsw-alias-label-primary);
                  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wsp-path { font-size: 11px; color: var(--dsw-alias-label-secondary);
                  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wsp-select { width: 100%; padding: 6px 8px; font-size: 13px; border-radius: 8px;
                    color: var(--dsw-alias-label-primary);
                    background: var(--dsw-alias-bg-layer-2);
                    border: 1px solid var(--dsw-alias-border-l2); }
      .wsp-select:disabled { opacity: .55; cursor: not-allowed; }
      .wsp-badge { display: inline-block; margin-left: 6px; padding: 1px 6px;
                   font-size: 11px; border-radius: 6px;
                   color: var(--dsw-alias-label-secondary);
                   border: 1px solid var(--dsw-alias-border-l1); }
      .wsp-badge-custom { color: var(--dsw-alias-brand-primary);
                          border-color: var(--dsw-alias-brand-primary); }
      .wsp-check { accent-color: var(--dsw-alias-brand-primary); }
      .wsp-notice { font-size: 12px; color: var(--dsw-alias-state-success-primary); }
      .wsp-error  { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
      .wsp-warn   { font-size: 12px; color: var(--dsw-alias-state-warn-primary); }
    `

    // ── 工具函数 ──────────────────────────────────────────────────────

    /**
     * 解 Remote 调用的信封 `{ok,value} | {ok,error}`。
     *
     * 不解包的话永远读到 `undefined`（信封本身就是个对象，容易误判成"有数据"）。
     *
     * @param {unknown} envelope
     * @returns {any|null} 成功时的 value，失败/异常形状时 null
     */
    function unwrap(envelope) {
      if (envelope === null || typeof envelope !== 'object') return null
      if (typeof (/** @type {any} */ (envelope).ok) !== 'boolean') return envelope
      return /** @type {any} */ (envelope).ok === true ? /** @type {any} */ (envelope).value : null
    }

    /**
     * 从 form snapshot 里安全读出映射表。
     *
     * 空串与非字符串一律剔除 —— 与 `lib/resolve.js` 的 `normalizeMap` 同口径，
     * 保证"页面认为没配置"与"Host 认为没配置"永远一致。
     *
     * @param {any} snapshot
     * @returns {Record<string, string>}
     */
    function readMap(snapshot) {
      const raw = snapshot?.value?.[MAP_FIELD]
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
      /** @type {Record<string, string>} */
      const out = {}
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'string' && value !== '') out[key] = value
      }
      return out
    }

    /**
     * preset id → 展示名。找不到就回 id，**绝不返回空白**。
     *
     * @param {Array<{id: string, name?: string}>} rows
     * @param {string} id
     * @returns {string}
     */
    function presetName(rows, id) {
      const row = rows.find((item) => item.id === id)
      return typeof row?.name === 'string' && row.name !== '' ? row.name : id
    }

    // ── 注册 ──────────────────────────────────────────────────────────

    /** 同步！不许出现 `await`。 */
    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-workspace-preset'
        tag.textContent = css
        document.head.appendChild(tag)
        return () => tag.remove()
      }, 'workspace-preset styles')

      ctx.effect(() => ctx.locale.register(LOCALE_NS, { en, zh }), 'workspace-preset locale')

      const form = ctx.configForms.get(ENTRY_ID)

      // ⚠️ 下面这些函数**必须在 apply 里建一次**，不能写进 `inject: () => ({...})`。
      // `inject()` 每次渲染都重新求值 → 现写的箭头函数每次都是新引用 → 一旦进
      // useEffect 依赖数组就是无限重订阅。
      const readPresets = () => ctx.remote.agentPresets.list()
      const setWorkspacePreset = (wsId, presetId) =>
        presetId === ''
          ? form.mutate([{ op: 'unset', path: [MAP_FIELD, wsId] }])
          : form.mutate([{ op: 'set', path: [MAP_FIELD, wsId], value: presetId }])
      const setEnabled = (value) => form.set('enabled', value)

      ctx.effect(
        () =>
          ctx.configForms.whileServed([ENTRY_ID], () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: ENTRY_ID,
                  order: 125, // 紧挨 Auto Review 的 120
                  label: () => '工作区预设',
                  locale: LOCALE_NS,
                  inject: () => ({
                    hooks: { form },
                    setEnabled,
                    setWorkspacePreset,
                    readPresets,
                  }),
                },
                Section,
              ),
            ),
          ),
        'workspace-preset settings page',
      )
    }

    // ── 页面组件 ──────────────────────────────────────────────────────

    /**
     * @param {any} props - `useForm` / `useWorkspaces` 是槽位标准 prop；
     *   其余来自上面 `inject`。
     */
    function Section({ useForm, useWorkspaces, setEnabled, setWorkspacePreset, readPresets, t }) {
      const snapshot = useForm((value) => value)
      const formReady = snapshot?.status === 'ready'
      const writable = formReady && snapshot?.writable === true
      const enabled = snapshot?.value?.enabled !== false
      const map = readMap(snapshot)

      // 工作区列表：槽位标准 prop，自带订阅与快照语义，不用自己管退订。
      const workspaceSnapshot = useWorkspaces((state) => state)
      const items = Array.isArray(workspaceSnapshot?.items) ? workspaceSnapshot.items : []
      const workspaces = items.map((item) => ({
        workspaceId: String(item.workspaceId),
        path: typeof item.path === 'string' ? item.path : '',
        title: typeof item.title === 'string' ? item.title : '',
      }))

      // preset 花名册
      const [presets, setPresets] = React.useState({ status: 'loading', rows: [] })
      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const roster = unwrap(await readPresets())
            if (!alive) return
            if (roster === null || !Array.isArray(roster.presets)) {
              setPresets({ status: 'error', rows: [] })
              return
            }
            setPresets({ status: 'ready', rows: roster.presets })
          } catch {
            if (alive) setPresets({ status: 'error', rows: [] })
          }
        })()
        return () => {
          alive = false
        }
      }, [readPresets])

      // 提示条：3.5 秒自动消失，用 seq 保证连续操作重新计时
      const [notice, setNotice] = React.useState(null)
      const seqRef = React.useRef(0)
      const noticeSeq = notice?.seq
      React.useEffect(() => {
        if (noticeSeq === undefined) return undefined
        const timer = setTimeout(() => setNotice(null), 3500)
        return () => clearTimeout(timer)
      }, [noticeSeq])

      const [busy, setBusy] = React.useState({})

      const choose = async (workspaceId, presetId) => {
        if (!writable || busy[workspaceId] === true) return
        setBusy((prev) => ({ ...prev, [workspaceId]: true }))
        try {
          const ok = await setWorkspacePreset(workspaceId, presetId)
          seqRef.current += 1
          setNotice(
            ok
              ? { kind: 'ok', seq: seqRef.current, text: t('saved') }
              : { kind: 'error', seq: seqRef.current, text: t('saveFailed') },
          )
        } catch (error) {
          seqRef.current += 1
          setNotice({
            kind: 'error',
            seq: seqRef.current,
            text: String(error?.message ?? error),
          })
        } finally {
          setBusy((prev) => {
            const next = { ...prev }
            delete next[workspaceId]
            return next
          })
        }
      }

      // 配置里有、但工作区列表里没有的 id（工作区被删了）
      const known = new Set(workspaces.map((item) => item.workspaceId))
      const stale = Object.keys(map).filter((id) => !known.has(id))

      const globalDefault = presets.rows.find((row) => row.isDefault === true)?.id ?? ''

      const children = []

      children.push(h('div', { className: 'wsp-title', key: 'title' }, t('title')))
      children.push(h('div', { className: 'wsp-hint', key: 'intro' }, t('intro')))

      if (!formReady) {
        children.push(h('div', { className: 'wsp-hint', key: 'not-ready' }, t('notReady')))
      } else if (!writable) {
        children.push(h('div', { className: 'wsp-hint', key: 'read-only' }, t('readOnly')))
      }

      // ── 总开关 ──────────────────────────────────────────────────
      children.push(
        h(
          'div',
          { className: 'wsp-block', key: 'enable' },
          h(
            'label',
            { className: 'wsp-row', style: { gridTemplateColumns: '1fr auto' } },
            h(
              'div',
              { className: 'wsp-meta' },
              h('div', { className: 'wsp-name' }, t('enable')),
              h('div', { className: 'wsp-path' }, t('enableHint')),
            ),
            h('input', {
              type: 'checkbox',
              className: 'wsp-check',
              checked: enabled,
              disabled: !writable,
              onChange: (event) => {
                setEnabled(event.target.checked)
              },
            }),
          ),
        ),
      )

      // ── 映射表 ──────────────────────────────────────────────────
      const rows = []

      rows.push(
        h(
          'div',
          { className: 'wsp-path', key: 'global-default' },
          `${t('globalDefaultIs')}：${
            globalDefault === '' ? '—' : presetName(presets.rows, globalDefault)
          }`,
        ),
      )

      if (presets.status === 'error') {
        rows.push(h('div', { className: 'wsp-error', key: 'presets-error' }, t('presetsError')))
      }

      if (workspaces.length === 0) {
        rows.push(h('div', { className: 'wsp-hint', key: 'no-workspace' }, t('noWorkspace')))
      } else {
        for (const ws of workspaces) {
          const picked = map[ws.workspaceId] ?? ''
          const badge =
            picked === ''
              ? h('span', { className: 'wsp-badge' }, t('follows'))
              : h('span', { className: 'wsp-badge wsp-badge-custom' }, t('custom'))

          const options = [
            h('option', { value: '', key: '__follow' }, t('followGlobal')),
          ]
          for (const row of presets.rows) {
            const broken = typeof row.broken === 'string'
            options.push(
              h(
                'option',
                { key: row.id, value: row.id, disabled: broken },
                (row.name ?? row.id) +
                  (broken ? ' ' + t('broken') : '') +
                  (row.id === globalDefault ? ' ' + t('globalTag') : ''),
              ),
            )
          }

          rows.push(
            h(
              'div',
              { className: 'wsp-row', key: ws.workspaceId },
              h(
                'div',
                { className: 'wsp-meta' },
                h(
                  'div',
                  { className: 'wsp-name', title: ws.path },
                  ws.title === '' ? ws.path : ws.title,
                  badge,
                ),
                h('div', { className: 'wsp-path', title: ws.path }, ws.path),
              ),
              h(
                'select',
                {
                  className: 'wsp-select',
                  value: picked,
                  disabled:
                    !writable || busy[ws.workspaceId] === true || presets.status !== 'ready',
                  onChange: (event) => {
                    choose(ws.workspaceId, event.target.value)
                  },
                },
                ...options,
              ),
            ),
          )
        }
      }

      // 失效映射：只提示，不自动清理（自动清理等于悄悄丢用户配置）
      if (stale.length > 0) {
        rows.push(
          h(
            'div',
            { className: 'wsp-warn', key: 'stale' },
            `${t('stalePrefix')}：${stale.join('、')} — ${t('staleHint')}`,
          ),
        )
      }

      children.push(h('div', { className: 'wsp-block', key: 'map' }, ...rows))

      // ── 提示 ────────────────────────────────────────────────────
      if (notice !== null && notice !== undefined) {
        children.push(
          h(
            'div',
            { className: notice.kind === 'ok' ? 'wsp-notice' : 'wsp-error', key: 'notice' },
            notice.text,
          ),
        )
      }

      return h('div', { className: 'wsp-page' }, ...children)
    }

    return {
      inject: ['slots', 'locale', 'configForms', 'remote', 'remote.agentPresets'],
      apply,
    }
  },
})
