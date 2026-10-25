/**
 * 离线冒烟：不装宿主，直接模拟 __ModuleLoader__ 把 client.js 跑一遍。
 * 验三件事：
 *   1. bundle 结构对（load 的 id / factory）
 *   2. factory 能返回 { name, inject, apply }
 *   3. apply 会往 plugins.row.config 这个 slot 里注册
 */
const fs = require('node:fs')
const path = require('node:path')

const clientPath = process.argv[2]
if (!clientPath) {
  console.error('用法: node smoke-client.cjs <client.js>')
  process.exit(2)
}

let captured = null
global.window = {
  __ModuleLoader__: {
    load(opts) {
      captured = opts
    },
  },
  document: undefined,
}

// 极简 React 替身：只提供 client.js 用到的那几个
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'Fragment',
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
}

const source = fs.readFileSync(clientPath, 'utf8')
// 在受控作用域里执行 bundle（它自己会调 window.__ModuleLoader__.load）
new Function('window', source)(global.window)

if (captured === null) {
  console.error('FAIL: client.js 没有调用 __ModuleLoader__.load')
  process.exit(1)
}
console.log('load.id =', captured.id)
if (captured.id !== 'dsh-qq-bot') {
  console.error('FAIL: load.id 不是 dsh-qq-bot')
  process.exit(1)
}

const mod = captured.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error('client 不该 require 别的模块：' + name)
})

console.log('exports.name =', mod.name)
console.log('exports.inject =', JSON.stringify(mod.inject))
if (typeof mod.apply !== 'function') {
  console.error('FAIL: 没有 apply')
  process.exit(1)
}

// 假 ctx：只记录 slots.inject / slots.register 被调了什么
const calls = []
const fakeCtx = {
  effect: () => {},
  slots: {
    inject(slotName, cb) {
      calls.push({ kind: 'inject', slotName })
      cb()
    },
    register(spec, component) {
      calls.push({ kind: 'register', spec: spec, componentType: typeof component })
      return () => {}
    },
  },
}

mod.apply(fakeCtx)

console.log('slots 调用：')
for (const c of calls) {
  console.log('  ', JSON.stringify(c.kind === 'register' ? { kind: c.kind, spec: c.spec, componentType: c.componentType } : c))
}

const injectCall = calls.find((c) => c.kind === 'inject')
const registerCall = calls.find((c) => c.kind === 'register')

let failed = false
// 配置面板挂在**包详情页**（plugins.item），不是组件行详情页（plugins.row.config）——
// 用户点插件列表里那一行进去看到的就是包页。
if (!injectCall || injectCall.slotName !== 'plugins.item') {
  console.error('FAIL: 没有 inject 到 plugins.item')
  failed = true
}
if (!registerCall || registerCall.spec.name !== 'plugins.item' || registerCall.spec.id !== 'dsh-qq-bot') {
  console.error('FAIL: register 的 spec 不对')
  failed = true
}
if (registerCall && registerCall.componentType !== 'function') {
  console.error('FAIL: 没有给出渲染组件')
  failed = true
}

if (failed) process.exit(1)
console.log('OK: client bundle 结构、apply、slot 注册都正常')
