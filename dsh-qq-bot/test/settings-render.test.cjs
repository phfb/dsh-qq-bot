/**
 * 面板渲染冒烟：真的把 client.js 跑起来，喂一份带 schema 的 /state 进去，
 * 数一数它到底渲染出几组、几项字段。
 *
 * 为什么要有这个：上一版 QQ 那半边是手抄字段表，UI 上只有 6 组 24 项，
 * 「每日说说 / 说说互动 / 看门狗」三整组（14 项）根本不存在，而所有单元测试都是绿的
 * ——因为没人真的渲染过它。这里用极简 React 替身把组件跑一遍，少一组就红。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const clientPath = path.join(__dirname, '..', 'lib', 'client.js')

/** 按调用顺序喂 useState 的初始值。 */
function makeFakeReact(queue) {
  let i = 0
  return {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children, _path: props && props.item ? props.item.path : undefined }),
    Fragment: 'Fragment',
    useState: () => {
      const value = i < queue.length ? queue[i] : null
      i += 1
      return [value, () => {}]
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (v) => ({ current: v }),
  }
}

function loadClient(queue) {
  let captured = null
  const win = { __ModuleLoader__: { load: (o) => { captured = o } }, document: undefined }
  const source = fs.readFileSync(clientPath, 'utf8')
  // eslint-disable-next-line no-new-func
  new Function('window', source)(win)
  assert.ok(captured, 'client.js 没有调用 __ModuleLoader__.load')
  const fakeReact = makeFakeReact(queue)
  const mod = captured.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error('client 不该 require 别的模块：' + name)
  })
  const regs = []
  mod.apply({
    effect: () => {},
    slots: {
      inject: (slotName, cb) => cb(),
      register: (spec, component) => {
        regs.push({ spec, component })
        return () => {}
      },
    },
  })
  return { regs, mod, fakeReact }
}

/** 把一个元素树摊平。 */
function flatten(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const n of node) flatten(n, out)
    return out
  }
  out.push(node)
  for (const child of node.children || []) flatten(child, out)
  return out
}

const statePayload = {
  ok: true,
  version: 1,
  dataDir: 'D:/fake',
  configFile: 'D:/fake/config.json',
  config: {
    baseUrl: 'ws://127.0.0.1:3001/',
    accessToken: '',
    allowUsers: ['123456'],
    selfId: '654321',
    enabled: true,
    qzoneDiaryEnabled: false,
    watchdogSeconds: 300,
  },
  schema: { bot: require('../lib/settings-schema.mjs').BOT_GROUPS },
  runtime: { connected: false, linkState: 'idle', memes: 0, sessions: [] },
  logTail: '',
}

test('QQ 面板渲染：11 组、50 个字段，缺的组都回来了', () => {
  const { regs } = loadClient(['bot', statePayload, statePayload.config])
  const main = regs.find((r) => r.spec.name === 'main')
  assert.ok(main, '没有注册主面板')
  // BotSettingsPanel → 里面渲染 QqBotPanel
  const tree = main.component({})
  const nodes = flatten(tree)
  // QqBotPanel 是另一个组件函数，需要真正调用它（替换 React 等价物已经就位）
  const panelNode = nodes.find((n) => n.type && n.type.name === 'QqBotPanel')
  assert.ok(panelNode, '面板里没找到 QqBotPanel')
  const inner = flatten(panelNode.type(panelNode.props))

  const titles = inner
    .map((n) => (n.props && typeof n.props.className === 'string' && n.props.className.includes('qqbot-group-title') ? n.children[0] : null))
    .filter((t) => typeof t === 'string')

  for (const must of ['每日说说（日记）', '说说互动（只在想他/吃醋时）', '她卡住时（看门狗）', '收图（他发来的图片）', '路径']) {
    assert.ok(titles.includes(must), `面板里缺了「${must}」这组（现在只有：${titles.join(' / ')}）`)
  }

  const fieldKeys = inner.map((n) => n._path).filter((p) => typeof p === 'string')
  assert.equal(new Set(fieldKeys).size, 50, `字段数不对：${new Set(fieldKeys).size}`)
  for (const must of ['qzoneDiaryEnabled', 'qzonePollTriggerPercent', 'watchdogSeconds', 'selfId', 'allowUsers']) {
    assert.ok(fieldKeys.includes(must), `面板里缺了字段 ${must}`)
  }
})

test('QQ 面板渲染：三整组缺失问题不会悄悄复发', () => {
  const { regs } = loadClient(['bot', statePayload, statePayload.config])
  const main = regs.find((r) => r.spec.name === 'main')
  const nodes = flatten(main.component({}))
  const panelNode = nodes.find((n) => n.type && n.type.name === 'QqBotPanel')
  const inner = flatten(panelNode.type(panelNode.props))
  const titles = inner
    .map((n) => (n.props && typeof n.props.className === 'string' && n.props.className.includes('qqbot-group-title') ? n.children[0] : null))
    .filter((t) => typeof t === 'string')
  assert.equal(titles.length, 11, `组数不对：${titles.length}（${titles.join(' / ')}）`)
})


/* ── 活人感那一页（2026-10-29）─────────────────────────────────────────────
   老 PowerShell 窗口那份「现在什么情况」里有十行状态 + 四个按钮，
   网页那半边一开始只搬过来六行、一个按钮都没有。
   这里把老窗口那张图上的每一行都钉死 —— 以后谁再改丢一行就红。 */

/** 把一棵元素树里的字都收下来（顺序无关，只查"在不在"）。 */
function textOf(node, out = '') {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') return out + ' ' + String(node)
  if (Array.isArray(node)) {
    for (const n of node) out = textOf(n, out)
    return out
  }
  if (typeof node !== 'object') return out
  return textOf(node.children || [], out)
}

const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString()

const alivePayload = {
  ok: true,
  bot: statePayload.config,
  alive: { enabled: false, dryRun: false, maxPerDay: 40, maxPerHour: 2, muteEnabled: true, lustModeEnabled: true },
  files: { bot: 'D:/fake/config.json', alive: 'D:/fake/alive-config.json' },
  schema: { bot: require('../lib/settings-schema.mjs').BOT_GROUPS, alive: require('../lib/settings-schema.mjs').ALIVE_GROUPS },
  status: {
    ok: true,
    missing: false,
    updatedAt: iso(1),
    blockedAt: iso(1),
    limits: { maxPerDay: 40, maxPerHour: 2 },
    muteEnabled: true,
    control: {
      enabled: true,
      hardOff: false,
      lastWasStop: false,
      muted: true,
      mutedUntil: iso(-50),
      muteReason: 'user-busy',
      dayQuotaSuspendedUntil: '',
      stopToday: false,
    },
    quota: {
      hourCount: 0,
      dayCount: 3,
      hourLeft: 2,
      dayLeft: 37,
      consecutiveIgnored: 2,
      consecutiveReplied: 1,
      lastProactiveAt: iso(180),
    },
    mood: {
      missing: 0.46,
      jealousy: 0.04,
      warmth: 0,
      worry: 0,
      boredom: 0.04,
      lust: 0.8,
      annoyance: 12,
      annoyanceMax: 60,
      annoyanceSilenceAt: 45,
      lustCodeEnabled: true,
      lustSliderEnabled: true,
      lustModeEnabled: true,
      lustOn: true,
    },
    stats: { totalDelivered: 34, totalReplied: 11, abandoned: 10 },
    focus: { lastHumanAt: iso(2), lastQqAt: iso(37), lastTickAt: iso(1) },
    openLoops: [{ what: '去洗澡', kind: 'return', at: iso(-30) }],
    blocked: ['静音中，到 17:04（user-busy）', '冷却中，还要 12 分钟'],
  },
}

/** 把「活人感」那一页渲染出来（AliveForm → AliveStatus 都真的跑一遍）。 */
function renderAlive(payload) {
  const { regs } = loadClient(['alive', 'ready', payload, {}])
  const main = regs.find((r) => r.spec.name === 'main')
  assert.ok(main, '没有注册主面板')
  const nodes = flatten(main.component({}))
  const form = nodes.find((n) => n.type && n.type.name === 'AliveForm')
  assert.ok(form, '面板里没找到 AliveForm')
  const formTree = form.type(form.props)
  const statusNode = flatten(formTree).find((n) => n.type && n.type.name === 'AliveStatus')
  assert.ok(statusNode, '活人感页里没有 AliveStatus')
  return { formTree, statusTree: statusNode.type(statusNode.props) }
}

test('活人感状态：老窗口那十行一行都不能少', () => {
  const { statusTree } = renderAlive(alivePayload)
  const text = textOf(statusTree)
  const musts = [
    '今日额度', '已投 3 条 / 上限 40 条，还剩 37 条',
    '本小时', '0 / 2 条',
    '静音', '静音到', 'user-busy',
    '今天封顶', '否',
    '挂着的念头', '去洗澡',
    '情绪', '想他 46%', '涩涩 80%', '恼火',
    '主情绪', '涩涩 80%',
    '上次主动',
    '你上次说话', 'QQ 里', 'DSH 里',
    '累计', '投出 34 条', '他回了 11 次', '作废 10 条',
    '连续被忽略', '2 次',
    '状态更新于',
  ]
  for (const must of musts) {
    assert.ok(text.includes(must), `状态块里缺了「${must}」`)
  }
})

test('活人感状态：现在为什么不会发，一条条列出来', () => {
  const { statusTree } = renderAlive(alivePayload)
  const text = textOf(statusTree)
  assert.ok(text.includes('现在为什么不会发'), '没有「现在为什么不会发」这一块')
  assert.ok(text.includes('静音中，到 17:04（user-busy）'), '插件给的静音原因没显示')
  assert.ok(text.includes('冷却中，还要 12 分钟'), '插件给的冷却原因没显示')

  const free = JSON.parse(JSON.stringify(alivePayload))
  free.status.blocked = []
  free.status.control.muted = false
  const text2 = textOf(renderAlive(free).statusTree)
  assert.ok(text2.includes('现在能发'), '闸门全过时没提示「现在能发」')
})

test('活人感状态：老窗口那四个按钮都在', () => {
  const { statusTree } = renderAlive(alivePayload)
  const text = textOf(statusTree)
  for (const must of ['刷新', '马上解除静音', '今日额度清零', '打开状态文件']) {
    assert.ok(text.includes(must), `按钮「${must}」没搬过来`)
  }
})

test('活人感页：调参那 10 组也照样渲染', () => {
  const { formTree } = renderAlive(alivePayload)
  const flat = flatten(formTree)
  const fields = flat.filter((n) => n.type && n.type.name === 'SchemaField')
  assert.ok(fields.length >= 48, `字段数不对：${fields.length}`)
  const groupTitles = flat
    .filter((n) => n.props && n.props.key && typeof n.props.key === 'string')
    .map((n) => n.props.key)
  for (const must of ['禁言机制', '情绪速率（多久攒满）', '开关与目标']) {
    assert.ok(groupTitles.includes(must), `缺了「${must}」这组`)
  }
  const text = textOf(formTree)
  for (const must of ['禁言机制', '情绪速率（多久攒满）', '涩涩（对话驱动）', '时段问候（早上 / 中午 / 晚上）']) {
    assert.ok(text.includes(must), `缺了「${must}」这组`)
  }
  assert.ok(text.includes('没有改动'), '缺少「没有改动」那行')
})