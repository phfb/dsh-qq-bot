/**
 * dsh-alive 判定核心的单元测试。纯函数，不需要 DSH。
 *
 *   D:\Astrbot\Snowluma\node.exe --test "D:\DSHBot\plugin\dsh-alive\test\policy.test.mjs"
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildFreeLoop,
  buildGreetingLoop,
  checkGate,
  dayKey,
  detectControl,
  extractLoopIntent,
  greetingLabelOf,
  greetingSlotOf,
  inQuietHours,
  isFarewell,
  jitterMs,
  maxAttemptsFor,
  parseClockWindow,
  parseTime,
  pickGreetingMinute,
  renderImpulse,
  saidGoodbyeLast,
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

/* ── 自发念头：没有 open loop 也能开口（2026-10-26 补的缺口） ── */

const FREE_NOW = Date.parse('2026-10-26T23:00:00+08:00')

/** 一个"他 30 分钟没在 QQ 说话、想他满格"的现场。 */
function freeState(over = {}) {
  return {
    focus: { lastQqAt: new Date(FREE_NOW - 30 * 60_000).toISOString() },
    mood: { missing: 1, jealousy: 0, warmth: 0, worry: 0, boredom: 0.3, lust: 0.7, annoyanceDebt: 0 },
    loops: [],
    stats: {},
    rhythm: { samples: 0, hourly: [] },
    quota: {},
    control: { enabled: true },
    ...over,
  }
}

const FREE_CFG = {
  freeTalkEnabled: true,
  freeTalkSilenceMin: 15,
  freeTalkGapMin: 45,
  freeTalkMoodPercent: 45,
  staleMin: 30,
  targetSession: 'auto',
  lustModeEnabled: true,
}

test('buildFreeLoop: 安静够久 + 情绪够 → 造一条 kind=free', () => {
  const loop = buildFreeLoop(freeState(), FREE_CFG, FREE_NOW)
  assert.ok(loop, '应该造出一条')
  assert.equal(loop.kind, 'free')
  assert.equal(loop.source, 'free')
  assert.equal(loop.status, 'open')
  assert.equal(loop.quote, '', '自发念头没有"他说的原话"')
  assert.ok(loop.freePercent >= 45)
  assert.equal(loop.attempts, 0)
  assert.ok(parseTime(loop.expectedBackAt) <= FREE_NOW, '到点即到期：现在就该能投')
  assert.ok(parseTime(loop.hardDeadlineAt) > FREE_NOW, '得留投递窗口，不能立刻自我作废')
})

test('buildFreeLoop: 总开关关着就不造', () => {
  assert.equal(buildFreeLoop(freeState(), { ...FREE_CFG, freeTalkEnabled: false }, FREE_NOW), null)
})

test('buildFreeLoop: 他刚说完话不插嘴', () => {
  const st = freeState({ focus: { lastQqAt: new Date(FREE_NOW - 5 * 60_000).toISOString() } })
  assert.equal(buildFreeLoop(st, FREE_CFG, FREE_NOW), null)
})

test('buildFreeLoop: 情绪没到线不造', () => {
  const st = freeState({
    mood: { missing: 0.2, jealousy: 0, warmth: 0, worry: 0, boredom: 0.3, lust: 0.1, annoyanceDebt: 0 },
  })
  assert.equal(buildFreeLoop(st, FREE_CFG, FREE_NOW), null)
})

test('buildFreeLoop: 两次自发要隔开', () => {
  const st = freeState({
    loops: [{ source: 'free', status: 'answered', createdAt: new Date(FREE_NOW - 10 * 60_000).toISOString() }],
  })
  assert.equal(buildFreeLoop(st, FREE_CFG, FREE_NOW), null)

  const old = freeState({
    loops: [{ source: 'free', status: 'answered', createdAt: new Date(FREE_NOW - 90 * 60_000).toISOString() }],
  })
  assert.ok(buildFreeLoop(old, FREE_CFG, FREE_NOW), '隔够久就该再开口')
})

test('buildFreeLoop: 从没在 QQ 说过话就不乱开口', () => {
  assert.equal(buildFreeLoop(freeState({ focus: {} }), FREE_CFG, FREE_NOW), null)
})

test('buildFreeLoop: 涩涩没启用时不吃涩涩那一维', () => {
  const st = freeState({
    mood: { missing: 0.1, jealousy: 0, warmth: 0, worry: 0, boredom: 0.1, lust: 0.95, annoyanceDebt: 0 },
  })
  assert.equal(buildFreeLoop(st, { ...FREE_CFG, lustModeEnabled: false }, FREE_NOW), null)
  const on = buildFreeLoop(st, FREE_CFG, FREE_NOW)
  assert.ok(on)
  assert.equal(on.freeMood, 'lust')
})

test('scoreImpulse: 自发念头在情绪满的时候过得了默认阈值', () => {
  const st = freeState()
  const loop = buildFreeLoop(st, FREE_CFG, FREE_NOW)
  const { score } = scoreImpulse(st, loop, { threshold: 30, lustModeEnabled: true }, FREE_NOW)
  assert.ok(score >= 30, `分数太低会永远发不出去：${score}`)
})

test('maxAttemptsFor: 自发念头只追一次', () => {
  assert.equal(maxAttemptsFor('free'), 1)
})

test('renderImpulse: 自发念头说的是"他没说话"，不是引用一句空话', () => {
  const loop = { kind: 'free', what: '想他了，没理由也想说一句', freePercent: 100, moodHint: 'clingy' }
  const text = renderImpulse(loop, { silentMin: 42 })
  assert.ok(text.includes('42 分钟'), '应该说清安静了多久')
  assert.ok(!text.includes('「」'), '不该出现空引号（他根本没说过话）')
  assert.ok(text.includes('想他了'), '要把驱动它的那股情绪带上')
})

/* ── 主动不只是开口：互动菜单（2026-10-26 晚上加的） ── */

const MENU_LOOP = { kind: 'free', what: '想他了，没理由也想说一句', freePercent: 100, moodHint: 'clingy' }

test('renderImpulse: 没给菜单时还是老行为 —— 只说话', () => {
  const text = renderImpulse(MENU_LOOP, { silentMin: 30 })
  assert.match(text, /这一轮只说话/)
  assert.ok(!text.includes('qq_poke'), '没给菜单就不该提工具')
})

test('renderImpulse: 菜单里有戳一戳，就告诉她可以不用说话', () => {
  const text = renderImpulse(MENU_LOOP, { silentMin: 30, menu: ['speak', 'poke'] })
  assert.match(text, /qq_poke/)
  assert.match(text, /不用说任何话/)
  assert.ok(!text.includes('这一轮只说话'), '有动作可选时不该再说“只说话”')
})

test('renderImpulse: 菜单里没有的动作一个字都不提', () => {
  const text = renderImpulse(MENU_LOOP, { silentMin: 30, menu: ['speak', 'poke'] })
  assert.ok(!text.includes('qq_qzone'), '没给 qzone 就不该提')
  assert.ok(!text.includes('qq_share'), '没给 link 就不该提')
})

test('renderImpulse: 发说说时把“所有人可见”的闸门带上', () => {
  const text = renderImpulse(MENU_LOOP, { silentMin: 30, menu: ['speak', 'qzone'] })
  assert.match(text, /所有人可见/)
  assert.match(text, /不许出现「他」/)
  assert.match(text, /学校、课程、住址/)
})

/* ── 2026-10-28：想他的时候可以真的去翻他的说说（只读） ── */

test('renderImpulse: 菜单里有「翻他的说说」，说清那是他的空间、别顺手点赞', () => {
  const text = renderImpulse(MENU_LOOP, { silentMin: 30, menu: ['speak', 'qzoneRead'] })
  assert.match(text, /qq_qzone/)
  assert.match(text, /不给就是他的空间/)
  assert.match(text, /不要顺手 like \/ comment/)
  assert.match(text, /uin="me"/, '得说清哪个号才是她自己')
  assert.ok(!text.includes('所有人可见'), '翻说说不是发说说，不该带发布的闸门')
})

test('renderImpulse: 不给 qzone 就不啰嗦那条闸门', () => {
  const text = renderImpulse(MENU_LOOP, { silentMin: 30, menu: ['speak', 'poke', 'meme'] })
  assert.ok(!text.includes('所有人可见'), '没发说说就不该提可见范围')
})

test('renderImpulse: 工具被拒时让她改说话，别卡死', () => {
  const text = renderImpulse(MENU_LOOP, { silentMin: 30, menu: ['speak', 'poke'] })
  assert.match(text, /ok:false/)
})
/* ── 道别闭环：说完晚安就别再找了（2026-10-27 加的） ── */

const NOW = Date.parse('2026-10-27T00:30:00+08:00')

test('saidGoodbyeLast: 她最后一句是晚安 → 闭嘴', () => {
  const term = [
    { role: 'user', text: '我睡了', at: new Date(NOW - 5 * 60_000).toISOString() },
    { role: 'assistant', text: '晚安，早点睡', at: new Date(NOW - 4 * 60_000).toISOString() },
  ]
  assert.equal(saidGoodbyeLast(term, { now: NOW }), true)
})

test('saidGoodbyeLast: 最后一句是他说的 → 没闭环', () => {
  const term = [
    { role: 'assistant', text: '晚安', at: new Date(NOW - 5 * 60_000).toISOString() },
    { role: 'user', text: '晚安', at: new Date(NOW - 2 * 60_000).toISOString() },
  ]
  assert.equal(saidGoodbyeLast(term, { now: NOW }), false)
})

test('saidGoodbyeLast: 她最后说的是别的事 → 照常', () => {
  const term = [
    { role: 'assistant', text: '那你记得吃饭', at: new Date(NOW - 3 * 60_000).toISOString() },
  ]
  assert.equal(saidGoodbyeLast(term, { now: NOW }), false)
})

test('saidGoodbyeLast: 隔太久就不算了（新的一轮）', () => {
  const term = [
    { role: 'assistant', text: '晚安', at: new Date(NOW - 11 * 3600_000).toISOString() },
  ]
  assert.equal(saidGoodbyeLast(term, { now: NOW }), false)
})

test('saidGoodbyeLast: 短间隔配置生效', () => {
  const term = [
    { role: 'assistant', text: '晚安', at: new Date(NOW - 30 * 60_000).toISOString() },
  ]
  assert.equal(saidGoodbyeLast(term, { now: NOW, gapMin: 60 }), true)
  assert.equal(saidGoodbyeLast(term, { now: NOW, gapMin: 10 }), false)
})

test('saidGoodbyeLast: 空历史不炸', () => {
  assert.equal(saidGoodbyeLast([], { now: NOW }), false)
  assert.equal(saidGoodbyeLast(null, { now: NOW }), false)
  assert.equal(saidGoodbyeLast(undefined, { now: NOW }), false)
})

test('isFarewell: 两边口径一致（alive 侧）', () => {
  assert.equal(isFarewell('晚安'), true)
  assert.equal(isFarewell('那个参数改好了'), false)
  assert.equal(isFarewell(''), false)
})
/* ── 时段问候：早上 / 中午 / 晚上（2026-10-27 加的） ── */

test('parseClockWindow: 正常区间', () => {
  assert.deepEqual(parseClockWindow('07:00-09:00'), { start: 420, end: 540 })
  assert.deepEqual(parseClockWindow('11:30-13:00'), { start: 690, end: 780 })
})

test('parseClockWindow: 垃圾输入返回 null', () => {
  assert.equal(parseClockWindow(''), null)
  assert.equal(parseClockWindow('7点-9点'), null)
  assert.equal(parseClockWindow('09:00-07:00'), null, '跨午夜不算问候窗口')
})

test('greetingSlotOf: 落在窗口里', () => {
  const seven30 = new Date(2026, 9, 27, 7, 30, 0).getTime()
  assert.equal(greetingSlotOf(seven30, undefined), 0)
  const noon = new Date(2026, 9, 27, 12, 0, 0).getTime()
  assert.equal(greetingSlotOf(noon, undefined), 1)
  const eight = new Date(2026, 9, 27, 19, 0, 0).getTime()
  assert.equal(greetingSlotOf(eight, undefined), 2)
})

test('greetingSlotOf: 窗口外返回 -1', () => {
  const three = new Date(2026, 9, 27, 3, 0, 0).getTime()
  assert.equal(greetingSlotOf(three, undefined), -1)
  const six = new Date(2026, 9, 27, 6, 59, 0).getTime()
  assert.equal(greetingSlotOf(six, undefined), -1)
})

test('pickGreetingMinute: 落在窗口内，而且不是开头', () => {
  for (let i = 0; i < 40; i += 1) {
    const m = pickGreetingMinute('07:00-09:00')
    assert.ok(m >= 420 && m < 540, `超出窗口：${m}`)
  }
  // 固定随机数时能精确断言
  assert.equal(pickGreetingMinute('07:00-09:00', () => 0), 420)
  assert.equal(pickGreetingMinute('07:00-09:00', () => 0.999), 539)
})

test('dayKey: 同一天同一个键', () => {
  const a = dayKey(new Date(2026, 9, 27, 1, 0, 0).getTime())
  const b = dayKey(new Date(2026, 9, 27, 23, 59, 0).getTime())
  assert.equal(a, b)
  assert.equal(a, '2026-10-27')
})

test('greetingLabelOf: 三个窗口各自的问法', () => {
  assert.equal(greetingLabelOf(0), '早上好')
  assert.equal(greetingLabelOf(1), '中午好')
  assert.equal(greetingLabelOf(2), '晚上好')
  assert.equal(greetingLabelOf(9), '打个招呼')
})

test('buildGreetingLoop: 结构对，且不带"他说了什么"', () => {
  const loop = buildGreetingLoop(NOW, 0, { targetSession: 'auto', staleMin: 30 })
  assert.equal(loop.kind, 'greeting')
  assert.equal(loop.source, 'greeting')
  assert.equal(loop.status, 'open')
  assert.equal(loop.quote, '')
  assert.equal(loop.what, '早上好')
  assert.ok(parseTime(loop.expectedBackAt) <= NOW, '到点即可投')
  assert.ok(parseTime(loop.hardDeadlineAt) > NOW)
})

test('renderImpulse: 问候走自己的话术，不引用他的话', () => {
  const loop = buildGreetingLoop(NOW, 0, { targetSlon: '', staleMin: 30 })
  const text = renderImpulse(loop, {})
  assert.match(text, /现在是早上/)
  assert.match(text, /一句问候就够/)
  assert.ok(!text.includes('「」'), '不该出现空引号')
})