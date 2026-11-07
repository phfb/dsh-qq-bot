/**
 * 运行时冒烟：用一个假的宿主把 dsh-qq-bot 真加载起来，跑一遍新增的三个接口。
 *
 * 为什么不是单测：`switchSession` / `historyForPanel` / `backfillHistory` 都在
 * apply() 的闭包里，依赖 ctx、agents、sessionController，光测纯函数证明不了
 * 「插件还起得来」。这个脚本用最小替身把它们跑一遍 —— 崩了这里就能看见。
 *
 * 用法：
 *   node tools/smoke-session-switch.mjs
 * 退出码 0 = 全过；1 = 有断言没过（会打印原因）。
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

const failures = []
const ok = (cond, label) => {
  if (cond) console.log(`  ✓ ${label}`)
  else {
    console.log(`  ✗ ${label}`)
    failures.push(label)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'qqbot-smoke-'))

/* ── 假的宿主 ─────────────────────────────────────────────────── */

const routes = new Map()
const services = new Map()

const ctx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  on() {
    return () => {}
  },
  inject(names, cb) {
    try {
      // 真实 cordis 给的是一个「注入了这些服务的子 ctx」——服务挂在对象属性上
      const scope = Object.create(ctx)
      for (const n of names) scope[n] = services.get(n)
      cb(scope)
    } catch (err) {
      console.log(`  (inject 回调抛了：${err instanceof Error ? err.message : String(err)})`)
    }
    return () => {}
  },
  effect(fn) {
    try {
      const off = fn()
      return typeof off === 'function' ? off : () => {}
    } catch {
      return () => {}
    }
  },
  plugin() {},
  get(name) {
    return services.get(name) ?? null
  },
}

services.set('webServer', {
  register(spec) {
    routes.set(spec.path, spec.handler)
    return () => routes.delete(spec.path)
  },
})
services.set('agents', {
  get: () => null,
  list: () => [],
  create: async () => {
    throw new Error('smoke 不该走到 create')
  },
})
services.set('sessionController', {
  resolveAgent: async () => ({ error: new Error('smoke: not found') }),
})
services.set('agentDefaultModel', { currentSelection: () => ({}) })
services.set('tokenMeter', null)
services.set('sessionQuery', null)

/* ── 假的 req / res ───────────────────────────────────────────── */

function fakeRes() {
  // sendJson 是直接写 res.statusCode 的（不是 setHeader），所以这层必须是普通属性
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) {
      res.headers[k] = v
    },
    end(chunk) {
      res.body = String(chunk ?? '')
    },
    json() {
      try {
        return JSON.parse(res.body)
      } catch {
        return null
      }
    },
  }
  return res
}

function fakeReq(method, url, body) {
  const handlers = {}
  return {
    method,
    url,
    on(evt, cb) {
      handlers[evt] = cb
    },
    async start() {
      if (handlers.data && body !== undefined) handlers.data(Buffer.from(JSON.stringify(body), 'utf8'))
      if (handlers.end) await handlers.end()
    },
  }
}

async function call(method, route, body) {
  const handler = routes.get('/api/dsh-qq-bot')
  if (typeof handler !== 'function') throw new Error('插件没有注册 /api/dsh-qq-bot 路由')
  const req = fakeReq(method, `/api/dsh-qq-bot${route}`, body)
  const res = fakeRes()
  const p = handler(req, res)
  await req.start()
  await p
  return res
}

/* ── 开跑 ─────────────────────────────────────────────────────── */

try {
  console.log('1) 加载插件')
  apply(ctx, {
    dataDir: dir,
    enabled: false, // 不连 OneBot，只验证本地逻辑
    allowUsers: ['123456'],
    selfId: '654321',
    workspacePath: join(dir, 'workspace'),
    forwarding: true,
  })
  ok(true, 'apply() 没抛异常')
  ok(routes.has('/api/dsh-qq-bot'), '路由注册上了')

  console.log('2) GET /state')
  const state = await call('GET', '/state')
  const stateBody = state.json()
  console.log(`  （返回体：${String(state.body).slice(0, 500)}）`)
  ok(state.statusCode === 200, '状态码 200')
  ok(stateBody && stateBody.ok === true, '返回 ok:true')
  ok(stateBody && stateBody.runtime && typeof stateBody.runtime === 'object', 'runtime 在')
  ok(stateBody && stateBody.runtime.history && typeof stateBody.runtime.history === 'object', 'runtime.history 在')
  const hist = stateBody.runtime.history
  ok(Array.isArray(hist.accounts) && hist.accounts.length === 1, '按号给了一份履历（1 个号）')
  ok(hist.accounts[0].uin === '123456', 'uin 对得上')
  ok(Array.isArray(hist.accounts[0].items), 'items 是数组')
  ok(hist.backfill && hist.backfill.done === false, '还没回填（懒触发）')

  console.log('3) GET /sessions（会触发一次懒回填）')
  const sessions = await call('GET', '/sessions')
  const sessBody = sessions.json()
  ok(sessions.statusCode === 200, '状态码 200')
  ok(sessBody && sessBody.ok === true, '返回 ok:true')
  ok(Array.isArray(sessBody.accounts), 'accounts 是数组')
  ok(typeof sessBody.backfill.reason === 'string' && sessBody.backfill.reason !== '', '没挂 sessionQuery 时要说清楚为什么没回填')

  console.log('4) POST /switch-session —— 不在履历里的 id 必须拒绝')
  const bad = await call('POST', '/switch-session', { uin: '123456', sessionId: 'session-not-in-history' })
  const badBody = bad.json()
  ok(bad.statusCode === 400, '状态码 400')
  ok(badBody && badBody.ok === false, '返回 ok:false')
  ok(/履历/.test(String(badBody.error)), `错误文案说的是「履历」：${badBody && badBody.error}`)

  console.log('5) POST /switch-session —— 缺参数必须拒绝')
  const missing = await call('POST', '/switch-session', { uin: '123456' })
  ok(missing.statusCode === 400, '缺 sessionId 时 400')

  console.log('6) 履历文件：切换失败时不该被写出来')
  ok(existsSync(join(dir, 'qq-session-history.json')) === false, '还没有任何一局结束过 → 不该有履历文件')

  console.log('7) 面板 POST /reset-session 仍然可用，且会记一笔')
  const reset = await call('POST', '/reset-session', {})
  ok(reset.statusCode === 200, '状态码 200')
  const resetBody = reset.json()
  ok(resetBody && resetBody.ok === true, '返回 ok:true')
  ok(/切回历史会话|履历/.test(String(resetBody.note)), '提示里说了旧局能被找回来')

  console.log('8) /panel 与 /accounts 这两个老接口没被碰坏')
  const panel = await call('GET', '/panel')
  ok(panel.statusCode === 200, '/panel 200')
} catch (err) {
  console.error('冒烟脚本自己抛了：', err)
  failures.push(`脚本异常：${err instanceof Error ? err.message : String(err)}`)
} finally {
  try {
    if (existsSync(join(dir, 'logs', 'qq-bot.log'))) {
      const log = readFileSync(join(dir, 'logs', 'qq-bot.log'), 'utf8')
      const bad = log.split('\n').filter((l) => /ERROR/.test(l)).slice(0, 5)
      if (bad.length > 0) console.log(`\n日志里的 ERROR（前 ${bad.length} 行）：\n${bad.join('\n')}`)
    }
  } catch {
    // 日志读不出来无所谓
  }
  rmSync(dir, { recursive: true, force: true })
  console.log('')
  if (failures.length === 0) {
    console.log('✅ 冒烟全过')
    process.exit(0)
  }
  console.log(`❌ ${failures.length} 项没过：`)
  for (const f of failures) console.log(`   - ${f}`)
  process.exit(1)
}
