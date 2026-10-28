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

test('QQ 面板渲染：11 组、48 个字段，缺的组都回来了', () => {
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
  assert.equal(new Set(fieldKeys).size, 48, `字段数不对：${new Set(fieldKeys).size}`)
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
