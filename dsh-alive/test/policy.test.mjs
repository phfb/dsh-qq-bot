/**
 * dsh-alive 判定核心的单元测试。纯函数，不需要 DSH。
 *
 *   node --test "test/*.test.mjs"     （在 dsh-alive 目录下跑）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  checkGate,
  detectControl,
  extractLoopIntent,
  inQuietHours,
  jitterMs,
  maxAttemptsFor,
  parseTime,
  renderImpulse,
  scoreImpulse,
} from '../lib/policy.mjs'

/* ── 抽取 ── */

test('extractLoopIntent: 外卖', () => {
  const r = extractLoopIntent('我去拿个外卖')
  assert.ok(r, '应该抽到 loop')
  assert.equal(r.kind, 'food')
  assert.ok(r.confidence >= 0.55, `置信度太低：${r.confidence}`)
  assert.ok(r.what.length > 0)
  assert.equal(r.moodHint, 'light')
})

test('extractLoopIntent: 等我一下', () => {
  const r = extractLoopIntent('等我一下，马上回来')
  assert.ok(r)
  assert.equal(r.kind, 'departure')
})

test('extractLoopIntent: 睡了', () => {
  const r = extractLoopIntent('我先睡了，晚安')
  assert.ok(r)
  assert.equal(r.kind, 'sleep')
  assert.ok(r.backInMin >= 300, `睡觉的窗口应该长，实际 ${r.backInMin}`)
})

test('extractLoopIntent: 单纯让我干活不算离开', () => {
  assert.equal(extractLoopIntent('帮我看看这个源码'), null)
})

test('extractLoopIntent: 否定句不建 loop', () => {
  assert.equal(extractLoopIntent('不用等我'), null)
  assert.equal(extractLoopIntent('别催我'), null)
})

test('extractLoopIntent: 技术提问不建 loop', () => {
  assert.equal(extractLoopIntent('这个 PID 参数怎么调？'), null)
})

test('extractLoopIntent: 他在问"吃什么"不是他要走', () => {
  assert.equal(extractLoopIntent('今天中午吃什么'), null)
  assert.equal(extractLoopIntent('晚上吃啥'), null)
})

test('extractLoopIntent: 带明确动作时疑问也不影响', () => {
  const r = extractLoopIntent('等我一下好吗')
  assert.ok(r, '有"等我"就该算离开')
  assert.equal(r.kind, 'departure')
})

test('extractLoopIntent: 空串 / 纯标点', () => {
  assert.equal(extractLoopIntent(''), null)
  assert.equal(extractLoopIntent('？？'), null)
})

test('extractLoopIntent: 派活 + 我回来验收', () => {
  const r = extractLoopIntent('帮我把这个模型导成 step，我回来验收')
  assert.ok(r)
  assert.equal(r.kind, 'task_handoff')
})

/* ── 抖动 ── */

test('jitterMs: 落在 0.55x ~ 2.2x 之间', () => {
  const base = 20 * 60_000
  for (let i = 0; i < 200; i += 1) {
    const ms = jitterMs(20, 'food')
    assert.ok(ms >= base * 0.55 * 0.99, `太小：${ms}`)
    assert.ok(ms <= base * 2.2 * 1.01, `太大：${ms}`)
  }
})

test('jitterMs: 不是每次都一样（有随机性）', () => {
  const seen = new Set()
  for (let i = 0; i < 30; i += 1) seen.add(jitterMs(20, 'departure'))
  assert.ok(seen.size > 10, `抖动太死板，只出现 ${seen.size} 种取值`)
})

/* ── 静音识别 ── */

test('detectControl: 别吵我 → 硬静音 2h', () => {
  const c = detectControl('别吵我')
  assert.ok(c)
  assert.equal(c.action, 'mute')
  assert.equal(c.hard, true)
  assert.equal(c.minutes, 120)
})

test('detectControl: 我在开会 → 软静音 90min', () => {
  const c = detectControl('我在开会，晚点说')
  assert.ok(c)
  assert.equal(c.action, 'mute')
  assert.equal(c.hard, false)
  assert.equal(c.minutes, 90)
})

test('detectControl: 我忙完了 → 解除静音', () => {
  const c = detectControl('我忙完了')
  assert.ok(c)
  assert.equal(c.action, 'unmute')
})

test('detectControl: 普通聊天不误判', () => {
  assert.equal(detectControl('今天中午吃什么'), null)
})

/* ── 时段 ── */

test('inQuietHours: 普通区间', () => {
  const at = (h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime() }
  assert.equal(inQuietHours(at(4), ['03:00-06:00']), true)
  assert.equal(inQuietHours(at(7), ['03:00-06:00']), false)
})

test('inQuietHours: 跨午夜区间', () => {
  const at = (h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.getTime() }
  assert.equal(inQuietHours(at(23), ['23:00-06:00']), true)
  assert.equal(inQuietHours(at(2), ['23:00-06:00']), true)
  assert.equal(inQuietHours(at(12), ['23:00-06:00']), false)
})

test('inQuietHours: 空配置永远 false', () => {
  assert.equal(inQuietHours(Date.now(), []), false)
})

/* ── 闸门 ── */

const CFG = { minSilenceMin: 12, cooldownMin: 45, maxPerHour: 1, maxPerDay: 4, maxAttempts: 2, quietHours: [], deepNightHours: [] }

function baseState(over = {}) {
  return {
    control: { enabled: true, hardOff: false, mutedUntil: null, lastWasStop: false, ...(over.control ?? {}) },
    quota: { hourCount: 0, dayCount: 0, lastProactiveAt: null, consecutiveIgnored: 0, ...(over.quota ?? {}) },
    mood: { annoyanceDebt: 0, ...(over.mood ?? {}) },
    focus: { lastHumanAt: new Date(Date.now() - 60 * 60_000).toISOString(), ...(over.focus ?? {}) },
  }
}
const LOOP = { kind: 'food', what: '去拿外卖', quote: '我去拿个外卖', attempts: 0, confidence: 0.8, expectedBackAt: new Date(Date.now() - 60_000).toISOString(), hardDeadlineAt: new Date(Date.now() + 10 * 60_000).toISOString() }
const ENV = { now: Date.now(), agentExists: true, agentRunning: false }

test('checkGate: 一切正常时放行', () => {
  const r = checkGate(baseState(), CFG, LOOP, ENV)
  assert.equal(r.pass, true, r.failed.join(','))
})

test('checkGate: 关掉就拦', () => {
  const r = checkGate(baseState({ control: { enabled: false } }), CFG, LOOP, ENV)
  assert.equal(r.pass, false)
  assert.ok(r.failed.some((f) => f.startsWith('G1')))
})

test('checkGate: 静音期内拦', () => {
  const until = new Date(Date.now() + 30 * 60_000).toISOString()
  const r = checkGate(baseState({ control: { mutedUntil: until } }), CFG, LOOP, ENV)
  assert.equal(r.pass, false)
  assert.ok(r.failed.some((f) => f.startsWith('G3')))
})

test('checkGate: 他正在跑 turn 就拦', () => {
  const r = checkGate(baseState(), CFG, LOOP, { ...ENV, agentRunning: true })
  assert.equal(r.pass, false)
  assert.ok(r.failed.some((f) => f.startsWith('G4')))
})

test('checkGate: 他刚在 QQ 说完话就拦', () => {
  const r = checkGate(baseState({ focus: { lastQqAt: new Date(Date.now() - 3 * 60_000).toISOString() } }), CFG, LOOP, ENV)
  assert.equal(r.pass, false)
  assert.ok(r.failed.some((f) => f.startsWith('G5')))
})

test('checkGate: 他只在 GUI 里说话不算 —— 静默期不被 GUI 重置', () => {
  // 老 bug：G5 读的是 lastHumanAt（任意渠道），他在 GUI 干活就等于"一直在说话"，她永远不开口
  const r = checkGate(baseState({
    focus: {
      lastHumanAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      lastQqAt: new Date(Date.now() - 180 * 60_000).toISOString(),
    },
  }), CFG, LOOP, ENV)
  assert.equal(r.pass, true)
})

test('checkGate: 冷却期内拦', () => {
  const r = checkGate(baseState({ quota: { lastProactiveAt: new Date(Date.now() - 10 * 60_000).toISOString() } }), CFG, LOOP, ENV)
  assert.equal(r.pass, false)
  assert.ok(r.failed.some((f) => f.startsWith('G6')))
})

test('checkGate: 被忽略过冷却翻倍', () => {
  const recent = new Date(Date.now() - 60 * 60_000).toISOString() // 1 小时前
  const plain = checkGate(baseState({ quota: { lastProactiveAt: recent } }), CFG, LOOP, ENV)
  assert.equal(plain.pass, true, '没被忽略过，45 分钟后应该放行')
  const escalated = checkGate(baseState({ quota: { lastProactiveAt: recent, consecutiveIgnored: 1 } }), CFG, LOOP, ENV)
  assert.equal(escalated.pass, false, '被忽略一次后要等 90 分钟')
})

test('checkGate: 配额满就拦', () => {
  assert.equal(checkGate(baseState({ quota: { dayCount: 4 } }), CFG, LOOP, ENV).pass, false)
  assert.equal(checkGate(baseState({ quota: { hourCount: 1 } }), CFG, LOOP, ENV).pass, false)
})

test('checkGate: 欠账太高就闭嘴', () => {
  assert.equal(checkGate(baseState({ mood: { annoyanceDebt: 60 } }), CFG, LOOP, ENV).pass, false)
})

test('checkGate: 追满了就不再追', () => {
  const loop = { ...LOOP, kind: 'sleep', attempts: 1 } // sleep 只允许 1 次
  assert.equal(checkGate(baseState(), CFG, loop, ENV).pass, false)
})

test('checkGate: 他刚说过"别吵"就拦', () => {
  const r = checkGate(baseState({ control: { lastWasStop: true } }), CFG, LOOP, ENV)
  assert.equal(r.pass, false)
  assert.ok(r.failed.some((f) => f.startsWith('G12')))
})

test('maxAttemptsFor: 各类上限', () => {
  assert.equal(maxAttemptsFor('food'), 1)
  assert.equal(maxAttemptsFor('sleep'), 1)
  assert.equal(maxAttemptsFor('departure'), 2)
  assert.equal(maxAttemptsFor('task_handoff'), 2)
})

/* ── 打分 ── */

test('scoreImpulse: 刚到点分数不高，超期后升高', () => {
  const now = Date.now()
  const justDue = { ...LOOP, expectedBackAt: new Date(now - 1_000).toISOString(), hardDeadlineAt: new Date(now + 20 * 60_000).toISOString() }
  const veryLate = { ...LOOP, expectedBackAt: new Date(now - 15 * 60_000).toISOString(), hardDeadlineAt: new Date(now + 5 * 60_000).toISOString() }
  const a = scoreImpulse(baseState(), justDue, CFG, now).score
  const b = scoreImpulse(baseState(), veryLate, CFG, now).score
  assert.ok(b > a, `超期后应该更高：${a} vs ${b}`)
})

test('scoreImpulse: 欠账会压分', () => {
  const now = Date.now()
  const clean = scoreImpulse(baseState(), LOOP, CFG, now).score
  const dirty = scoreImpulse(baseState({ mood: { annoyanceDebt: 40 } }), LOOP, CFG, now).score
  assert.ok(dirty < clean, `欠账应该压分：${clean} vs ${dirty}`)
})

test('scoreImpulse: 没被忽略过的 handoff 能过阈值', () => {
  const now = Date.now()
  const loop = { ...LOOP, kind: 'task_handoff', expectedBackAt: new Date(now - 20 * 60_000).toISOString(), hardDeadlineAt: new Date(now + 20 * 60_000).toISOString() }
  const s = scoreImpulse(baseState({ mood: { missing: 0.4 } }), loop, CFG, now).score
  assert.ok(s >= 55, `handoff 应该容易过阈值，实际 ${s}`)
})

/* ── 念头文本 ── */

test('renderImpulse: 带原话、带约束', () => {
  const text = renderImpulse(LOOP, { silentMin: 47, moodHint: 'light', timeNote: '' })
  assert.ok(text.includes('我去拿个外卖'), text)
  assert.ok(text.includes('47'), text)
  // 这是给模型看的念头，不是发给他的话 —— 只要结构对就行
  assert.ok(text.includes('要求：'), text)
  assert.ok(text.includes('不要调用任何工具'), text)
  assert.ok(text.includes('一两句话'), text)
  // 不能替模型把话写好：不能出现"外卖比我还重要？"这种具体台词
  assert.ok(!text.includes('外卖比我还重要'), '念头里不该预写台词')
})

test('renderImpulse: 不同 mood 给出不同语气', () => {
  const a = renderImpulse(LOOP, { silentMin: 30, moodHint: 'light' })
  const b = renderImpulse(LOOP, { silentMin: 30, moodHint: 'sulky' })
  assert.notEqual(a, b)
  assert.ok(b.includes('不高兴'), b)
})

/* ── 时间解析 ── */

test('parseTime: ISO / 毫秒 / 垃圾输入', () => {
  assert.equal(parseTime('2026-10-25T10:00:00.000Z'), Date.parse('2026-10-25T10:00:00.000Z'))
  assert.equal(parseTime(1234567890), 1234567890)
  assert.equal(parseTime(null), null)
  assert.equal(parseTime('不是时间'), null)
})

/* ───────────── 情绪驱动的豁免（G1/G2/G7/G8 可绕，其余永远不绕）───────────── */

test('情绪豁免：突破每小时/每天配额（exempt.quota）', () => {
  const st = baseState({
    control: { enabled: true },
    quota: { hourCount: 99, dayCount: 99, lastProactiveAt: null, consecutiveIgnored: 0 },
  });
  const loop = { kind: 'food', attempts: 0 }
  const plain = checkGate(st, CFG, loop, { now: ENV.now, agentRunning: false, agentExists: true })
  assert.equal(plain.pass, false)
  assert.ok(plain.failed.includes('G7:hour-quota'))

  const exempted = checkGate(st, CFG, loop, {
    now: ENV.now, agentRunning: false, agentExists: true,
    exempt: { quota: true },
  })
  assert.equal(exempted.failed.includes('G7:hour-quota'), false)
  assert.equal(exempted.failed.includes('G8:day-quota'), false)
})

test('情绪豁免：连总开关都能绕（exempt.master）', () => {
  const st = baseState({ control: { enabled: false } })
  const loop = { kind: 'food', attempts: 0 }
  const plain = checkGate(st, CFG, loop, { now: ENV.now, agentRunning: false, agentExists: true })
  assert.ok(plain.failed.includes('G1:disabled'))

  const exempted = checkGate(st, CFG, loop, {
    now: ENV.now, agentRunning: false, agentExists: true,
    exempt: { master: true },
  })
  assert.equal(exempted.failed.includes('G1:disabled'), false)
})

test('情绪豁免：深夜 / 他说过「别发了」/ 静音 永远不绕', () => {
  // 深夜（deepNightHours 默认 03:00-06:00）+ 当天封顶 + 静音，三个一起来
  const deepNight = Date.parse('2026-10-26T04:00:00+08:00')
  const st = baseState({
    control: {
      enabled: true,
      mutedUntil: new Date(deepNight + 3600_000).toISOString(),
      dayQuotaSuspendedUntil: new Date(deepNight + 20 * 3600_000).toISOString(),
    },
  })
  const loop = { kind: 'food', attempts: 0 }
  const CFG_NIGHT = { ...CFG, deepNightHours: ['03:00-06:00'] }
  const gate = checkGate(st, CFG_NIGHT, loop, {
    now: deepNight,
    agentRunning: false,
    agentExists: true,
    exempt: { quota: true, master: true },
  })
  assert.equal(gate.pass, false, '两个豁免都开着也不许在深夜/封顶/静音时开口')
  assert.ok(gate.failed.includes('G3:muted'), '静音必须还拦着')
  assert.ok(
    gate.failed.some((f) => f.startsWith('G11')),
    '深夜必须还拦着',
  )
})
