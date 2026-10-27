/**
 * dsh-model-override 的浏览器侧：左侧栏一个「模型」入口，点开是全局模型选择。
 *
 * 注册两条，缺一条的表现都是「图标点了没反应」：
 *   - `sidebar.panellist` 用自己的 id（复用别人的会把人家格子顶掉）
 *   - `main` 的 key 必须与侧栏 id 一致，侧栏按钮靠这个 key 找面板
 *
 * 数据走 /model-override/state 和 /apply（host 侧 lib/index.js 里注册的）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-override',

  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    /** 侧栏格子的 id，同时是主面板的 key。必须与注册时一致。 */
    const PANEL_ID = 'dsh-model-override'
    /** 接口前缀，与 host 侧的注册路径必须对得上 */
    const API = '/model-override'

    /* ── 颜色：跟随宿主主题，不硬编码深色 ── */
    const C = {
      text: 'inherit',
      dim: 'color-mix(in srgb, currentColor 55%, transparent)',
      border: 'color-mix(in srgb, currentColor 18%, transparent)',
      accent: '#2E5A8A',
    }

    function Icon({ size = 20, active = false }) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          'aria-hidden': true,
          style: { display: 'block', pointerEvents: 'none', opacity: active ? 1 : 0.8 },
        },
        h('circle', {
          cx: 12, cy: 12, r: 8,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
        }),
        h('circle', { cx: 12, cy: 12, r: 3, fill: 'currentColor' }),
        h('path', {
          d: 'M12 2v3M12 19v3M2 12h3M19 12h3',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      )
    }

    const row = { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }
    const labelStyle = { width: 96, flexShrink: 0, color: C.text, fontSize: 13, opacity: 0.75 }
    const selectStyle = {
      flex: 1,
      minWidth: 0,
      padding: '6px 8px',
      borderRadius: 6,
      border: `1px solid ${C.border}`,
      background: 'color-mix(in srgb, currentColor 6%, transparent)',
      color: C.text,
      fontSize: 13,
      outline: 'none',
    }

    function Panel() {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState('')

      const [provider, setProvider] = useState('')
      const [model, setModel] = useState('')
      const [effort, setEffort] = useState('')

      const load = useCallback(async () => {
        try {
          const res = await fetch(`${API}/state`, { headers: { Accept: 'application/json' } })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = await res.json()
          setState(data)
          setError('')
          // 第一次进来用当前全局默认预填
          setProvider((prev) => prev || (data.current?.provider ?? ''))
          setModel((prev) => prev || (data.current?.model ?? ''))
          setEffort((prev) => prev || (data.current?.reasoningEffort ?? ''))
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }, [])

      useEffect(() => {
        void load()
        const timer = setInterval(() => { void load() }, 15000)
        return () => clearInterval(timer)
      }, [load])

      const catalog = state?.catalog ?? []
      const providerEntry = catalog.find((p) => p.id === provider)
      const models = providerEntry?.models ?? []
      const modelEntry = models.find((m) => m.id === model)
      const efforts = modelEntry?.efforts ?? []

      const doApply = async () => {
        if (!provider || !model) return
        setBusy(true)
        setMsg('正在应用…')
        try {
          const res = await fetch(`${API}/apply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              provider,
              model,
              ...(effort === '' ? {} : { reasoningEffort: effort }),
            }),
          })
          const data = await res.json()
          setMsg(
            data.ok
              ? `✅ 生效了\n${(data.details ?? []).join('\n')}`
              : `⚠ 有问题\n${(data.details ?? []).join('\n')}\n${data.note ?? ''}`,
          )
          void load()
        } catch (err) {
          setMsg(`调用失败：${err instanceof Error ? err.message : String(err)}`)
        } finally {
          setBusy(false)
        }
      }

      if (error !== '') {
        return h('div', { style: { padding: 24, fontSize: 13 } },
          h('div', { style: { marginBottom: 8 } }, '读不到插件状态。'),
          h('div', { style: { opacity: 0.65, fontSize: 12 } }, error),
          h('div', { style: { marginTop: 12, opacity: 0.65, fontSize: 12 } },
            '可能插件还没跑起来，或者 DSH 版本不匹配。看 D:\\DSHBot\\data\\model-override.log。'),
        )
      }

      if (state === null) {
        return h('div', { style: { padding: 24, fontSize: 13, opacity: 0.7 } }, '读取中…')
      }

      const cur = state.current ?? {}
      const sessions = state.sessions ?? []

      return h('div', { style: { padding: '20px 24px', fontSize: 13, color: C.text, overflowY: 'auto', height: '100%' } },
        h('h2', { style: { fontSize: 16, margin: '0 0 6px' } }, '全局模型'),
        h('div', { style: { opacity: 0.6, fontSize: 12, marginBottom: 20, lineHeight: 1.6 } },
          '选一次，应用到所有活着的会话（含 QQ bot 建的那一局）。下一轮请求就生效，不用重启。'),

        // 当前状态
        h('div', {
          style: {
            padding: '10px 12px',
            borderRadius: 8,
            border: `1px solid ${C.border}`,
            marginBottom: 20,
            fontSize: 12,
            lineHeight: 1.7,
          },
        },
          h('div', null, `当前全局默认：${cur.provider || '—'} / ${cur.model || '—'}${cur.reasoningEffort ? ` (${cur.reasoningEffort})` : ''}`),
          h('div', { style: { opacity: 0.6 } }, `会话数：${sessions.length}`),
          // 2026-10-27：配置里的 provider 被删掉之后，这里必须**当场喊出来**。
          // 以前没有任何提示，界面上照旧显示 unlimit/xxx，看起来一切正常，
          // 实际每个会话都挂在一条不存在的路由上，还顺带把别的插件炸了。
          Array.isArray(state?.availability) || (state?.availability && typeof state.availability === 'object')
            ? (() => {
                const av = state.availability || {}
                if (av.ok) return null
                const warn = av.provisional
                  ? `⚠ 暂时读不到模型目录（${av.reason || 'llm 还没就绪'}），会自动重试`
                  : `⛔ ${av.reason || '配置的路由已失效'}`
                return h('div', {
                  style: {
                    marginTop: 6,
                    padding: '6px 8px',
                    borderRadius: 6,
                    background: av.provisional ? 'rgba(255,180,0,0.12)' : 'rgba(255,60,60,0.15)',
                    color: av.provisional ? '#e0a020' : '#ff5b5b',
                    fontSize: 11,
                    lineHeight: 1.6,
                  },
                }, warn)
              })()
            : null,
        ),

        // 选择区
        h('div', { style: row },
          h('div', { style: labelStyle }, '服务商'),
          h('select', {
            style: selectStyle,
            value: provider,
            onChange: (e) => { setProvider(e.target.value); setModel(''); setEffort('') },
          },
            h('option', { value: '' }, '— 选一个 —'),
            ...catalog.map((p) => h('option', { key: p.id, value: p.id }, `${p.id}${p.name && p.name !== p.id ? ` — ${p.name}` : ''}`)),
          ),
        ),
        h('div', { style: row },
          h('div', { style: labelStyle }, '模型'),
          h('select', {
            style: selectStyle,
            value: model,
            onChange: (e) => { setModel(e.target.value); setEffort('') },
          },
            h('option', { value: '' }, models.length === 0 ? '— 先选服务商 —' : '— 选一个 —'),
            ...models.map((m) => h('option', { key: m.id, value: m.id }, m.id)),
          ),
        ),
        h('div', { style: row },
          h('div', { style: labelStyle }, '推理等级'),
          h('select', {
            style: selectStyle,
            value: effort,
            onChange: (e) => setEffort(e.target.value),
          },
            h('option', { value: '' }, '（用模型默认）'),
            ...efforts.map((e) => h('option', { key: e, value: e }, String(e))),
          ),
        ),

        h('button', {
          onClick: () => { void doApply() },
          disabled: busy || !provider || !model,
          style: {
            marginTop: 8,
            padding: '8px 18px',
            borderRadius: 6,
            border: 'none',
            background: busy || !provider || !model ? 'color-mix(in srgb, currentColor 15%, transparent)' : C.accent,
            color: busy || !provider || !model ? 'color-mix(in srgb, currentColor 45%, transparent)' : '#fff',
            fontSize: 13,
            cursor: busy || !provider || !model ? 'default' : 'pointer',
          },
        }, busy ? '应用中…' : '应用到全部会话'),

        msg !== '' && h('pre', {
          style: {
            marginTop: 14,
            padding: '10px 12px',
            borderRadius: 8,
            border: `1px solid ${C.border}`,
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            lineHeight: 1.6,
          },
        }, msg),

        // 会话明细
        h('div', { style: { marginTop: 24 } },
          h('div', { style: { fontSize: 12, opacity: 0.6, marginBottom: 8 } }, '各会话实际在用：'),
          sessions.length === 0
            ? h('div', { style: { fontSize: 12, opacity: 0.5 } }, '（当前没有活着的会话）')
            : h('div', { style: { fontSize: 12, lineHeight: 1.8 } },
                ...sessions.map((s) => h('div', {
                  key: s.id,
                  style: { display: 'flex', gap: 10, opacity: s.provider === provider && s.model === model ? 1 : 0.7 },
                },
                  h('span', { style: { fontFamily: 'monospace', opacity: 0.6, width: 130, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, s.id.slice(0, 18)),
                  h('span', null, `${s.provider || '—'} / ${s.model || '—'}`),
                  s.source === 'pending' && h('span', { style: { opacity: 0.45 } }, '·待生效'),
                )),
              ),
        ),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: () => '模型' },
          Icon,
        ),
      )
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel))
    }

    return { name: 'dsh-model-override', inject: ['slots'], apply }
  },
})
