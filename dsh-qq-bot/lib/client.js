/**
 * dsh-qq-bot —— 浏览器半侧（手写 __ModuleLoader__ bundle，不需要构建工具）
 *
 * 往「设置 → 插件 → dsh-qq-bot」这一行的配置区里画一个表单：
 *   - 连 OneBot 的四项（地址 / token / 白名单 / BOT 号）
 *   - 行为开关、分段规则、上下文换局阈值
 *   - 表情包频率闸门（这就是用户最常调的那三个数）
 *   - 数据目录、表情包目录
 * 下面还显示运行状态（连上没、当前会话、图库几张）和日志尾巴。
 *
 * 与宿主端只走同源 HTTP（/api/dsh-qq-bot/*），不碰 RPC —— 失败模式最少。
 * 语法检查：node --check lib/client.js
 */

window.__ModuleLoader__.load({
  id: 'dsh-qq-bot',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useEffect = React.useEffect
    var useState = React.useState
    var useCallback = React.useCallback

    var API = '/api/dsh-qq-bot'
    var PKG = 'dsh-qq-bot'

    /* ── 同源请求 ─────────────────────────────────────────────────────── */

    function request(method, path, body) {
      var init = { cache: 'no-store', headers: {} }
      if (method === 'POST') {
        init.method = 'POST'
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body || {})
      }
      return fetch(API + path, init).then(function (res) {
        return res.text().then(function (text) {
          var data = null
          try {
            data = text === '' ? null : JSON.parse(text)
          } catch (e) {
            data = null
          }
          if (!res.ok) {
            var msg = data && data.error ? data.error : 'HTTP ' + res.status
            throw new Error(msg)
          }
          return data
        })
      })
    }

    /* ── 路径读写：'segment.shortMax' → obj.segment.shortMax ──────────── */

    function getPath(obj, path) {
      var parts = path.split('.')
      var cur = obj
      for (var i = 0; i < parts.length; i += 1) {
        if (cur === null || cur === undefined) return undefined
        cur = cur[parts[i]]
      }
      return cur
    }

    function setPath(obj, path, value) {
      var parts = path.split('.')
      var next = Object.assign({}, obj)
      var cur = next
      for (var i = 0; i < parts.length - 1; i += 1) {
        var key = parts[i]
        cur[key] = Object.assign({}, cur[key] || {})
        cur = cur[key]
      }
      cur[parts[parts.length - 1]] = value
      return next
    }

    /* ── 字段表 ─────────────────────────────────────────────────────────
       2026-10-28：这一块原来是手抄的硬编码数组（只抄了 6 组 24 项，
       每日说说 / 说说互动 / 看门狗 整三组都漏了）。现在**不再抄**：
       字段全部来自宿主随 /state 一起发下来的调参表（lib/settings-schema.mjs），
       加字段只改那一处，面板自动长出来。
       面板必须自洽的两条：schema 里的 path 就是 json 键；界面按 type 选控件。 */

    /* ── 样式 ─────────────────────────────────────────────────────────── */

    var CSS = [
      '.qqbot-wrap{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.qqbot-banner{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;line-height:1.6;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-l1,rgba(127,127,127,.06))}',
      '.qqbot-banner b{color:var(--dsw-alias-label-primary)}',
      '.qqbot-group{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}',
      '.qqbot-group-title{font-weight:600;font-size:14px}',
      '.qqbot-group-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}',
      '.qqbot-row{display:grid;grid-template-columns:200px 1fr;gap:10px;align-items:center}',
      '.qqbot-label{color:var(--dsw-alias-label-secondary)}',
      '.qqbot-hint{grid-column:2;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;margin-top:-4px}',
      '.qqbot-input{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-input,transparent);color:inherit;font:inherit}',
      '.qqbot-check{width:16px;height:16px}',
      '.qqbot-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.qqbot-btn{padding:6px 14px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;font:inherit;cursor:pointer}',
      '.qqbot-btn:hover{border-color:var(--dsw-alias-label-tertiary)}',
      '.qqbot-btn[data-primary="1"]{background:var(--dsw-alias-state-business-primary,#3b82f6);border-color:transparent;color:#fff}',
      '.qqbot-btn:disabled{opacity:.5;cursor:default}',
      '.qqbot-msg{font-size:12px;line-height:1.6}',
      '.qqbot-msg[data-kind="ok"]{color:#3fb950}',
      '.qqbot-msg[data-kind="err"]{color:#f85149}',
      '.qqbot-msg[data-kind="warn"]{color:#d29922}',
      '.qqbot-log{margin:0;max-height:220px;overflow:auto;background:rgba(0,0,0,.28);border-radius:6px;padding:10px;font-family:Consolas,Menlo,monospace;font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-all}',
      '.qqbot-kv{display:grid;grid-template-columns:110px 1fr;gap:4px 10px;font-size:12px}',
      '.qqbot-kv span:nth-child(odd){color:var(--dsw-alias-label-tertiary)}',
    ].join('\n')

    function useStyles() {
      useEffect(function () {
        var id = 'dsh-qq-bot-styles'
        if (document.getElementById(id) === null) {
          var style = document.createElement('style')
          style.id = id
          style.textContent = CSS
          document.head.appendChild(style)
        }
      }, [])
    }

    /* ── 单个字段 ─────────────────────────────────────────────────────── */

    function Field(props) {
      var item = props.item
      var form = props.form
      var onChange = props.onChange
      // 调参表里叫 path（就是 json 键），老的硬编码表叫 key —— 两个都认
      var fieldKey = item.path && item.path !== '' ? item.path : String(item['key'] || '')
      var raw = getPath(form, fieldKey)

      var common = {
        className: 'qqbot-input',
        onChange: function (event) {
          var value = event.target.value
          if (item.type === 'number') {
            var n = Number(value)
            onChange(fieldKey, value === '' ? '' : Number.isFinite(n) ? n : raw)
          } else if (item.type === 'list') {
            onChange(fieldKey, value.split(/[,，\s]+/).filter(function (s) { return s !== '' }))
          } else {
            onChange(fieldKey, value)
          }
        },
      }

      var control
      if (item.type === 'bool') {
        control = h('input', {
          type: 'checkbox',
          className: 'qqbot-check',
          checked: raw === true,
          onChange: function (event) { onChange(fieldKey, event.target.checked) },
        })
      } else if (item.type === 'account') {
        // 读出来选，不要让人手打：候选来自 OneBot 的 get_login_info
        var accounts = Array.isArray(props.accounts) ? props.accounts : []
        var options = [h('option', { key: '__none', value: '' }, accounts.length === 0 ? '（点右边「读取」拿号）' : '（未选择）')]
        for (var i = 0; i < accounts.length; i += 1) {
          var acc = accounts[i]
          options.push(h('option', { key: acc.uin, value: acc.uin },
            acc.uin + (acc.nickname ? '　' + acc.nickname : '') + (acc.offline ? '　(当前离线)' : '　(当前登录)')))
        }
        control = h('div', { style: { display: 'flex', gap: '6px' } },
          h('select', {
            className: 'qqbot-input',
            value: raw === undefined || raw === null ? '' : String(raw),
            onChange: function (event) { onChange(fieldKey, event.target.value) },
          }, options),
          h('button', {
            className: 'qqbot-btn',
            type: 'button',
            disabled: props.reading === true,
            onClick: function () { if (props.onReadAccounts) props.onReadAccounts() },
          }, props.reading === true ? '读取中…' : '读取'))
      } else if (item.type === 'list') {
        control = h('input', Object.assign({}, common, {
          type: 'text',
          value: Array.isArray(raw) ? raw.join(', ') : '',
          placeholder: item.placeholder || '填你自己的 QQ 号',
        }))
      } else {
        control = h('input', Object.assign({}, common, {
          type: item.type === 'password' ? 'password' : item.type === 'number' ? 'number' : 'text',
          value: raw === undefined || raw === null ? '' : String(raw),
          placeholder: item.placeholder || '',
          min: item.min,
          max: item.max,
          step: item.step,
          autoComplete: 'off',
        }))
      }

      return h(React.Fragment, null,
        h('div', { className: 'qqbot-row' },
          h('div', { className: 'qqbot-label' }, item.label),
          control),
        item.hint !== undefined ? h('div', { className: 'qqbot-hint' }, item.hint) : null)
    }

    /* ── 主面板 ───────────────────────────────────────────────────────── */

    function QqBotPanel() {
      useStyles()
      var stateRes = useState(null)
      var formRes = useState(null)
      var msgRes = useState(null)
      var busyRes = useState(false)
      var accountsRes = useState([])
      var readingRes = useState(false)
      var state = stateRes[0]
      var setState = stateRes[1]
      var form = formRes[0]
      var setForm = formRes[1]
      var msg = msgRes[0]
      var setMsg = msgRes[1]
      var busy = busyRes[0]
      var setBusy = busyRes[1]
      var accounts = accountsRes[0]
      var setAccounts = accountsRes[1]
      var reading = readingRes[0]
      var setReading = readingRes[1]

      var readAccounts = useCallback(function () {
        setReading(true)
        request('GET', '/accounts').then(function (data) {
          var list = Array.isArray(data.candidates) ? data.candidates : []
          setAccounts(list)
          if (data.hint) {
            setMsg({ kind: 'warn', text: data.hint })
          } else if (list.length === 0) {
            setMsg({ kind: 'warn', text: '没读到号：先让小号在 QQ 里登录，再在 SnowLuma 里挂载该号，然后回来点「读取」' })
          } else {
            setMsg({ kind: 'ok', text: '读到 ' + list.length + ' 个号，选一个就是 BOT 号' })
          }
        }).catch(function (err) {
          setMsg({ kind: 'err', text: '读取账号失败：' + err.message })
        }).then(function () {
          setReading(false)
        })
      }, [])

      var reload = useCallback(function () {
        return request('GET', '/state').then(function (data) {
          setState(data)
          setForm(data.config || {})
          return data
        }).catch(function (err) {
          setMsg({ kind: 'err', text: '读不到插件状态：' + err.message })
        })
      }, [])

      useEffect(function () {
        reload().then(function () { readAccounts() })
      }, [reload, readAccounts])

      var onChange = useCallback(function (key, value) {
        setForm(function (prev) { return setPath(prev || {}, key, value) })
        setMsg(null)
      }, [])

      var onSave = useCallback(function () {
        setBusy(true)
        request('POST', '/save', form).then(function (data) {
          setState(function (prev) {
            if (prev === null) return prev
            var next = Object.assign({}, prev)
            next.config = data.config
            return next
          })
          setForm(data.config || {})
          var extra = data.problems && data.problems.length > 0 ? '（注意：' + data.problems.join('；') + '）' : ''
          setMsg({ kind: 'ok', text: (data.note || '已保存') + extra })
        }).catch(function (err) {
          setMsg({ kind: 'err', text: '保存失败：' + err.message })
        }).then(function () {
          setBusy(false)
        })
      }, [form])

      var onReconnect = useCallback(function () {
        setBusy(true)
        request('POST', '/reconnect', {}).then(function (data) {
          setMsg({ kind: 'ok', text: data.note || '已重新连接' })
          return reload()
        }).catch(function (err) {
          setMsg({ kind: 'err', text: '重连失败：' + err.message })
        }).then(function () { setBusy(false) })
      }, [reload])

      var onResetSession = useCallback(function () {
        setBusy(true)
        request('POST', '/reset-session', {}).then(function (data) {
          setMsg({ kind: 'warn', text: data.note || '已清空会话映射' })
          return reload()
        }).catch(function (err) {
          setMsg({ kind: 'err', text: '清空失败：' + err.message })
        }).then(function () { setBusy(false) })
      }, [reload])

      if (form === null) {
        return h('div', { className: 'qqbot-wrap' },
          h('div', { className: 'qqbot-banner' },
            msg !== null ? msg.text : '正在读取 dsh-qq-bot 的配置…'))
      }

      var runtime = state && state.runtime ? state.runtime : {}
      var sessions = Array.isArray(runtime.sessions) ? runtime.sessions : []
      // 字段表来自宿主（lib/settings-schema.mjs），这里不再手抄一份
      var schemaGroups = state && state.schema && Array.isArray(state.schema.bot) ? state.schema.bot : []

      return h('div', { className: 'qqbot-wrap' },
        h('div', { className: 'qqbot-banner' },
          h('div', null, h('b', null, 'QQ 私聊接入'),
            ' —— 让 DSH 住进你的手机 QQ。私聊陪伴用，不是群管机器人。'),
          h('div', null, '链路：手机 QQ → QQ 客户端 → SnowLuma(OneBot v11) → 本插件 → DSH agent'),
          h('div', null, 'SnowLuma 走的是 QQ 客户端 hook，', h('b', null, '不需要也不会保存 QQ 密码'),
            '；那个小号要你自己在 QQ 里登录，再去 SnowLuma 里挂载。')),

        h('div', { className: 'qqbot-kv' },
          h('span', null, '连接状态'),
          h('span', null, runtime.connected === true ? '已连上 OneBot' : '未连接（' + (runtime.linkState || '空闲') + '）'),
          h('span', null, '转发'),
          h('span', null, runtime.forwarding === true ? '开着' : '已关（QQ 里发 ' + (form.commandPrefix || '/qq') + ' on 打开）'),
          h('span', null, '当前会话'),
          h('span', null, sessions.length === 0 ? '(还没建，收到第一条消息才建)'
            : sessions.map(function (s) { return s.uin + ' → ' + s.sessionId + '（第 ' + s.generation + ' 局）' }).join('；')),
          h('span', null, '表情图库'),
          h('span', null, String(runtime.memes || 0) + ' 张（' + (form.memesDir || state.dataDir + '/memes') + '）'),
          h('span', null, '配置文件'),
          h('span', null, state.configFile)),

        // 2026-10-28：按钮挪到字段上面 —— 跟「活人感」那页一致，33 个字段不用滚到底才能保存
        h('div', { className: 'qqbot-actions' },
          h('button', { className: 'qqbot-btn', 'data-primary': '1', disabled: busy, onClick: onSave }, busy ? '处理中…' : '保存'),
          h('button', { className: 'qqbot-btn', disabled: busy, onClick: onReconnect }, '重新连接'),
          h('button', { className: 'qqbot-btn', disabled: busy, onClick: onResetSession }, '清空会话（换新一局）'),
          h('button', { className: 'qqbot-btn', disabled: busy, onClick: reload }, '刷新状态')),

        msg !== null ? h('div', { className: 'qqbot-msg', 'data-kind': msg.kind }, msg.text) : null,

        schemaGroups.map(function (group) {
          return h('div', { className: 'qqbot-group', key: group.title },
            h('div', { className: 'qqbot-group-title' }, group.title),
            group.hint !== undefined && group.hint !== '' ? h('div', { className: 'qqbot-group-hint' }, group.hint) : null,
            (Array.isArray(group.fields) ? group.fields : []).map(function (item) {
              return h(Field, {
                key: item.path || item.key,
                item: item,
                form: form,
                onChange: onChange,
                accounts: accounts,
                reading: reading,
                onReadAccounts: readAccounts,
              })
            }))
        }),


        state && state.logTail ? h('details', null,
          h('summary', { style: { cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)' } }, '最近日志'),
          h('pre', { className: 'qqbot-log' }, state.logTail)) : null)
    }

    /** 错误边界：面板崩了要看得见原因，而不是白屏。 */
    function Boundary(props) {
      var res = useState(null)
      var err = res[0]
      var setErr = res[1]
      if (err !== null) {
        return h('div', { className: 'qqbot-banner' }, '配置面板出错了：' + (err.message || String(err)))
      }
      return h(ErrCatcher, { onError: setErr }, props.children)
    }

    function ErrCatcher(props) {
      var res = useState(null)
      if (res[0] !== null) throw res[0]
      return props.children
    }

    /* ── 注册到插件页 ─────────────────────────────────────────────────── */

    function apply(ctx) {
      // 注册在**包详情页**（插件列表里点这一行进去就是它）。
      // 之前注册的是 plugins.row.config（组件行详情），用户第一眼看的是包页，所以找不到。
      // 侧栏入口 + 主面板（2026-10-28）：跟「插件 / 自动化任务 / 记忆 / 模型」同一列，只占一格。
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 44,
          label: function () { return 'DSH-BOT' },
        }, PanelIcon)
      })
      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: PANEL_ID }, BotSettingsPanel)
      })

      ctx.slots.inject('plugins.item', function () {
        return ctx.slots.register({
          name: 'plugins.item',
          id: PKG,
          order: 60,
        }, function (props) {
          var p = props !== null && props !== undefined ? props : {}
          if (p.view === 'summary') {
            return h('span', null, 'QQ 私聊接入 · 点进来调连接参数和表情频率')
          }
          return h(Boundary, null, h(QqBotPanel))
        })
      })
    }

    /* ── 调参面板：侧栏一个入口，两个标签（QQ 机器人 / 活人感） ──────────
       原来这两个插件只能靠 DSH 外面的两个 PowerShell 窗口调参；这里把两份 json
       接到 DSH 里来。**两半边都按宿主发下来的调参表（schema）现场生成**：
       bot 48 项 / 11 组、alive 48 项 / 10 组，字段全在 lib/settings-schema.mjs，
       以后加字段只改那一处（2026-10-28 修：QQ 那半边原来是手抄的硬编码表，
       只抄了 24 项，每日说说 / 说说互动 / 看门狗 整三组都漏了）。 */

    var PANEL_ID = 'dsh-bot-settings'

    var fieldInputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 9px',
      borderRadius: 7,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: 13,
    }

    function PanelIcon(props) {
      var size = props && typeof props.size === 'number' ? props.size : 20
      var active = Boolean(props && props.active)
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-label': 'DSH-BOT',
        role: 'img',
        style: { display: 'block', opacity: active ? 1 : 0.72 },
      },
        h('path', { d: 'M4 7h9M18 7h2M4 12h4M13 12h7M4 17h11M20 17h0', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('circle', { cx: 15, cy: 7, r: 2, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('circle', { cx: 10, cy: 12, r: 2, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('circle', { cx: 18, cy: 17, r: 2, stroke: 'currentColor', strokeWidth: 1.6 }))
    }

    /** 取点号路径的值（调参表里有 `moodRates.missing` 这种两层的）。 */
    function pickByPath(obj, dotted) {
      var cur = obj
      var parts = String(dotted).split('.')
      for (var i = 0; i < parts.length; i += 1) {
        if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
        cur = cur[parts[i]]
      }
      return cur
    }

    /** 一个字段：bool 是勾选框，其余是输入框（数字走 number，范围由 schema 夹）。 */
    function SchemaField(props) {
      var field = props.field
      var value = props.value
      var onChange = props.onChange
      var text = Array.isArray(value) ? value.join(', ') : value === undefined || value === null ? '' : String(value)

      if (field.type === 'bool') {
        return h('label', {
          style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 13, color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' },
        },
          h('input', {
            type: 'checkbox',
            checked: value === true,
            onChange: function (e) { onChange(e.target.checked) },
          }),
          h('span', null, field.label))
      }

      if (field.type === 'range') {
        var num = Number(text)
        var shown = Number.isFinite(num) ? num : Number(field.min) || 0
        var t = props.extraText || ''
        return h('label', { style: { display: 'block', padding: '6px 0' } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 2 } },
            h('span', null, field.label),
            h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, shown.toFixed(1) + 'x' + (t ? ' · ' + t : ''))),
          h('input', {
            type: 'range',
            min: field.min,
            max: field.max,
            step: field.step,
            value: shown,
            onChange: function (e) { onChange(e.target.value) },
            style: { width: '100%', accentColor: 'var(--dsw-alias-brand-primary)' },
          }))
      }

      return h('label', { style: { display: 'block', padding: '6px 0' } },
        h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 } }, field.label),
        h('input', {
          type: field.type === 'number' ? 'number' : 'text',
          value: text,
          min: field.min,
          max: field.max,
          step: field.step,
          placeholder: field.placeholder || '',
          onChange: function (e) { onChange(e.target.value) },
          style: fieldInputStyle,
        }))
    }

    /** 只读状态条：情绪七维 + 额度 + 静音。数据来自宿主读 alive-state.json。 */
    function AliveStatus(props) {
      var status = props.status
      if (!status) return null
      var pct = function (v) { return Math.round((Number(v) || 0) * 100) + '%' }
      var shortTime = function (iso) {
        if (!iso) return '—'
        var d = new Date(iso)
        if (isNaN(d.getTime())) return '—'
        var two = function (n) { return String(n).padStart(2, '0') }
        return two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes())
      }
      var muted = status.control.mutedUntil && new Date(status.control.mutedUntil).getTime() > Date.now()
      var chips = [
        ['想他', status.mood.missing],
        ['吃醋', status.mood.jealousy],
        ['暖意', status.mood.warmth],
        ['担心', status.mood.worry],
        ['闲得慌', status.mood.boredom],
        ['涩涩', status.mood.lust],
        ['恼火', status.mood.annoyance],
      ]
      return h('section', {
        style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: '10px 14px', marginBottom: 12 },
      },
        h('div', { style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: 6 } }, '当前状态'),
        h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.9 } },
          h('span', null, muted ? ('静音中' + (status.control.muteReason ? '（' + status.control.muteReason + '）' : '')) : '没静音'),
          h('span', null, '今天已开口 ' + status.quota.dayCount + ' 次 / 这一小时 ' + status.quota.hourCount + ' 次'),
          h('span', null, '上次主动 ' + shortTime(status.quota.lastProactiveAt)),
          h('span', null, '连续被忽略 ' + status.quota.consecutiveIgnored + ' 次'),
          h('span', null, '累计投递 ' + status.stats.totalDelivered + ' · 他回 ' + status.stats.totalReplied),
          h('span', null, '状态更新于 ' + shortTime(status.updatedAt))),
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 } },
          chips.map(function (pair) {
            return h('span', {
              key: pair[0],
              style: {
                fontSize: 12,
                padding: '2px 8px',
                borderRadius: 999,
                border: '1px solid var(--dsw-alias-border-l1)',
                color: 'var(--dsw-alias-label-secondary)',
              },
            }, pair[0] + ' ' + pct(pair[1]))
          })))
    }

    /** 活人感（dsh-alive）那一页：表驱动，别在这里写死字段。 */
    function AliveForm() {
      var phaseRes = useState('loading')
      var dataRes = useState(null)
      var draftRes = useState({})
      var msgRes = useState(null)
      var busyRes = useState(false)
      var phase = phaseRes[0]
      var setPhase = phaseRes[1]
      var data = dataRes[0]
      var setData = dataRes[1]
      var draft = draftRes[0]
      var setDraft = draftRes[1]
      var msg = msgRes[0]
      var setMsg = msgRes[1]
      var busy = busyRes[0]
      var setBusy = busyRes[1]

      var reload = useCallback(function () {
        return request('GET', '/panel').then(function (res) {
          if (!res || res.ok !== true) throw new Error((res && res.error) || '读不到配置')
          setData(res)
          setDraft({})
          setPhase(res.alive === null ? 'missing' : 'ready')
          if (res.alive === null && res.note) setMsg({ kind: 'warn', text: res.note })
        }).catch(function (err) {
          setPhase('error')
          setMsg({ kind: 'err', text: '读配置失败：' + err.message })
        })
      }, [])

      useEffect(function () { reload() }, [reload])

      var save = function () {
        var payload = {}
        Object.keys(draft).forEach(function (k) { payload[k] = draft[k] })
        if (Object.keys(payload).length === 0) {
          setMsg({ kind: 'warn', text: '还没改任何一项' })
          return
        }
        setBusy(true)
        request('POST', '/panel', { alive: payload }).then(function (res) {
          if (res && res.ok) {
            setMsg({ kind: 'ok', text: '已保存 ' + (res.saved || []).length + ' 项。' + (res.note || '') })
            reload()
          } else {
            setMsg({ kind: 'err', text: (res && res.note) || '保存失败' })
          }
        }).catch(function (err) {
          setMsg({ kind: 'err', text: '保存失败：' + err.message })
        }).then(function () { setBusy(false) })
      }

      if (phase === 'loading') return h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, '读取中…')
      if (phase === 'error') return h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-state-error-primary)' } }, (msg && msg.text) || '读取失败')
      if (phase === 'missing') {
        return h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.8 } },
          (msg && msg.text) || '读不到 alive-config.json',
          h('div', null, '路径：' + (data && data.files ? data.files.alive : '')))
      }

      var groups = data && data.schema && Array.isArray(data.schema.alive) ? data.schema.alive : []
      var current = data.alive || {}
      var dirty = Object.keys(draft).length

      return h('div', null,
        h(AliveStatus, { status: data.status }),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 } },
          h('button', {
            type: 'button',
            disabled: busy,
            onClick: save,
            style: { padding: '6px 14px', borderRadius: 7, border: '1px solid var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', fontWeight: 600, cursor: busy ? 'default' : 'pointer', fontSize: 13 },
          }, busy ? '保存中…' : '保存'),
          h('button', {
            type: 'button',
            disabled: busy || dirty === 0,
            onClick: function () { setDraft({}); setMsg(null) },
            style: { padding: '6px 14px', borderRadius: 7, border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: 13 },
          }, '撤销改动'),
          h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, dirty > 0 ? '改了 ' + dirty + ' 项' : '没有改动'),
          h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, data.files ? data.files.alive : '')),
        msg ? h('div', {
          style: {
            marginBottom: 10, fontSize: 12, lineHeight: 1.7,
            color: msg.kind === 'err' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
          },
        }, msg.text) : null,
        groups.map(function (group) {
          return h('section', {
            key: group.title,
            style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: '10px 14px', marginBottom: 10 },
          },
            h('div', { style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: 2 } }, group.title),
            group.hint ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.7, marginBottom: 6 } }, group.hint) : null,
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '2px 14px' } },
              group.fields.map(function (field) {
                var shown = Object.prototype.hasOwnProperty.call(draft, field.path) ? draft[field.path] : pickByPath(current, field.path)
                // 速率滑条右边那列：满值要多久（跟 PowerShell 版一样实时算）
                var fillRaw = Object.prototype.hasOwnProperty.call(draft, 'moodFillHours')
                  ? draft.moodFillHours
                  : pickByPath(current, 'moodFillHours')
                var fill = Number(fillRaw) > 0 ? Number(fillRaw) : 6
                var extra = ''
                if (String(field.path).indexOf('moodRates.') === 0) {
                  var mul = Number(shown)
                  if (Number.isFinite(mul) && mul > 0) {
                    if (field.path === 'moodRates.warmthGain') {
                      extra = '每次哄 +' + Math.round(30 * mul) + '%'
                    } else {
                      var hours = fill / mul
                      extra = hours >= 1 ? '满值约 ' + hours.toFixed(1) + ' 小时' : '满值约 ' + Math.round(hours * 60) + ' 分钟'
                    }
                  }
                }
                return h(SchemaField, {
                  key: field.path,
                  field: field,
                  value: shown,
                  extraText: extra,
                  onChange: function (v) {
                    setDraft(function (prev) {
                      var next = Object.assign({}, prev)
                      next[field.path] = v
                      return next
                    })
                  },
                })
              })))
        }))
    }

    function BotSettingsPanel() {
      var tabRes = useState('bot')
      var tab = tabRes[0]
      var setTab = tabRes[1]
      var tabBtn = function (id, text) {
        var on = tab === id
        return h('button', {
          key: id,
          type: 'button',
          onClick: function () { setTab(id) },
          style: {
            padding: '6px 14px',
            borderRadius: 999,
            fontSize: 13,
            cursor: 'pointer',
            border: '1px solid ' + (on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'),
            background: on ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            color: on ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
          },
        }, text)
      }
      return h('div', {
        style: {
          // 2026-10-28：面板跟着主区域铺满高度并自己滚动。
          // 不写 overflowY 的话这一页 33 个字段会被直接切掉（他的原话："你这没加滚动啊？？"）。
          height: '100%',
          overflowY: 'auto',
          boxSizing: 'border-box',
          padding: '18px 22px 40px',
          color: 'var(--dsw-alias-label-primary)',
        },
      },
      h('div', { style: { maxWidth: 900, margin: '0 auto' } },
        h('h2', { style: { fontSize: 17, fontWeight: 600, margin: '0 0 6px' } }, 'DSH-BOT'),
        h('div', { style: { display: 'flex', gap: 8, marginBottom: 14 } },
          tabBtn('bot', 'QQ 机器人（dsh-qq-bot）'),
          tabBtn('alive', '活人感（dsh-alive）')),
        tab === 'bot' ? h(Boundary, null, h(QqBotPanel)) : h(Boundary, null, h(AliveForm))))
    }

    module.exports = {
      name: 'dsh-qq-bot',
      inject: ['slots'],
      apply: apply,
    }
    return module.exports
  },
})
