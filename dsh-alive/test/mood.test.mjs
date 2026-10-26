import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_MOOD,
  DEFAULT_FILL_HOURS,
  LUST_SLIDER_ENABLED,
  digest,
  dominant,
  evolve,
  fillTimeHours,
  labelOf,
  moodHintOf,
  normalizeMood,
  normalizeRates,
  onHeCameBack,
  onIgnored,
  onRejected,
  onReplied,
  onSweetTalk,
  onTeased,
  percentOf,
  snapshot,
} from '../lib/mood.mjs'

function fresh(extra) {
  return normalizeMood({ ...DEFAULT_MOOD, ...(extra ?? {}) })
}

test('首次运行：七个情绪一律从 0 开始，不继承任何东西', () => {
  // 插件第一次跑时 emptyState() 用的就是 DEFAULT_MOOD 这一套数
  for (const [k, v] of Object.entries(DEFAULT_MOOD)) {
    if (typeof v === 'number') assert.equal(v, 0, `{k} 初始值该是 0`)
  }
  assert.equal(DEFAULT_MOOD.lust, 0)
  assert.equal(DEFAULT_MOOD.lustPhase, 'grow')
  // 空对象喂进去也不该长出任何数值
  const m = normalizeMood({})
  for (const k of ['missing', 'jealousy', 'warmth', 'worry', 'boredom', 'lust']) {
    assert.equal(m[k], 0, `{k} 该补成 0`)
  }
  assert.equal(m.annoyanceDebt, 0)
})
test('normalizeMood: 老状态文件只有三个字段也能补全', () => {
  const m = normalizeMood({ missing: 0.5, jealousy: 0.2, annoyanceDebt: 10 })
  assert.equal(m.warmth, 0)
  assert.equal(m.worry, 0)
  assert.equal(m.boredom, 0)
  assert.equal(m.lastWarmthAt, null)
})

test('normalizeMood: 越界的值会被夹回来', () => {
  const m = normalizeMood({ missing: 9, warmth: -3, annoyanceDebt: 999 })
  assert.equal(m.missing, 1)
  assert.equal(m.warmth, 0)
  assert.equal(m.annoyanceDebt, 60)
})

test('evolve: 深夜想念涨得更快', () => {
  const day = evolve(fresh(), 1, { hourOfDay: 14, hoursSinceQq: 5 })
  const night = evolve(fresh(), 1, { hourOfDay: 1, hoursSinceQq: 5 })
  assert.ok(night.missing > day.missing, '深夜应该涨得更多')
  assert.ok(day.missing > 0)
})

test('evolve: 一次最多补 6 小时', () => {
  const m = evolve(fresh(), 100, { hourOfDay: 14, hoursSinceQq: 5 })
  assert.ok(m.missing <= 1)
})

test('evolve: 暖意会自己退下去', () => {
  const m = evolve(fresh({ warmth: 1 }), 2, { hourOfDay: 14, hoursSinceQq: 0 })
  assert.ok(m.warmth < 1)
  assert.ok(m.warmth >= 0)
})

test('evolve: 凌晨他还没消息，担心会涨', () => {
  const m = evolve(fresh(), 1, { hourOfDay: 2, hoursSinceQq: 5 })
  assert.ok(m.worry > 0)
})

test('evolve: 他一直在 QQ 里，吃醋不涨', () => {
  const m = evolve(fresh(), 2, { hourOfDay: 14, hoursSinceQq: 0.1 })
  assert.equal(m.jealousy, 0)
})

test('onHeCameBack: 想念、吃醋、闲、担心一起往下掉', () => {
  const m = onHeCameBack(fresh({ missing: 1, jealousy: 1, boredom: 1, worry: 1, annoyanceDebt: 40 }))
  assert.ok(m.missing < 1)
  assert.ok(m.jealousy < 1)
  assert.equal(m.boredom, 0.8)
  assert.equal(m.worry, 0.8)
  assert.equal(m.annoyanceDebt, 20)
})

test('onSweetTalk: 暖意上脸，火气消一点', () => {
  const m = onSweetTalk(fresh({ annoyanceDebt: 20 }), Date.parse('2026-10-25T14:00:00Z'))
  assert.equal(m.warmth, 0.3)
  assert.equal(m.annoyanceDebt, 12)
  assert.equal(m.lastWarmthAt, '2026-10-25T14:00:00.000Z')
})

test('onRejected: 欠账 +30、暖意清零', () => {
  const m = onRejected(fresh({ warmth: 0.8 }), Date.parse('2026-10-25T14:00:00Z'))
  assert.equal(m.annoyanceDebt, 30)
  assert.equal(m.warmth, 0)
  assert.equal(m.lastRejectedAt, '2026-10-25T14:00:00.000Z')
})

test('onRejected: 欠账封顶 60', () => {
  const m = onRejected(fresh({ annoyanceDebt: 50 }))
  assert.equal(m.annoyanceDebt, 60)
})

test('onIgnored / onReplied: 忽略攒火，回复回血', () => {
  const ignored = onIgnored(fresh())
  assert.equal(ignored.annoyanceDebt, 12)
  const replied = onReplied(fresh({ missing: 0.5 }))
  assert.equal(replied.warmth, 0.15)
  assert.ok(replied.missing < 0.5)
})

test('dominant: 什么都低的时候是 calm', () => {
  assert.equal(dominant(fresh()).key, 'calm')
})

test('dominant: 欠账高过一切都是恼火', () => {
  const d = dominant(fresh({ missing: 0.3, annoyanceDebt: 50 }))
  assert.equal(d.key, 'annoyance')
})

test('dominant: 想念占上风就是想他', () => {
  const d = dominant(fresh({ missing: 0.9, jealousy: 0.2 }))
  assert.equal(d.key, 'missing')
})

test('moodHintOf: 每种主情绪对应一种语气', () => {
  assert.equal(moodHintOf(fresh()), 'flat')
  assert.equal(moodHintOf(fresh({ warmth: 0.9 })), 'warm')
  assert.equal(moodHintOf(fresh({ missing: 0.9 })), 'clingy')
  assert.equal(moodHintOf(fresh({ jealousy: 0.9 })), 'pouty')
  assert.equal(moodHintOf(fresh({ worry: 0.9 })), 'worried')
  assert.equal(moodHintOf(fresh({ boredom: 0.9 })), 'light')
  assert.equal(moodHintOf(fresh({ annoyanceDebt: 50 })), 'sulky')
})

test('labelOf / digest: 面板能直接显示（百分比）', () => {
  assert.equal(labelOf('calm'), '平静')
  assert.equal(labelOf('annoyance'), '有点恼')
  assert.equal(labelOf('missing'), '想他')
  assert.equal(labelOf('lust'), '涩涩')
  const text = digest(fresh({ missing: 0.72 }))
  assert.ok(text.includes('想他 72%'))
  assert.ok(text.includes('涩涩 0%'))
  assert.ok(text.includes('恼火 0%'))
  assert.ok(text.includes('0/60'))
})

/* ─────────────── 2026-10-26：涩涩 + 速率倍率 ─────────────── */

test('normalizeMood: 老状态文件没有 lust 也能补上一个 0', () => {
  const m = normalizeMood({ missing: 0.2 })
  assert.equal(m.lust, 0)
})

test('percentOf: 0..1 变成整数百分比', () => {
  assert.equal(percentOf(0), 0)
  assert.equal(percentOf(0.724), 72)
  assert.equal(percentOf(1), 100)
  assert.equal(percentOf(3), 100)
})

test('默认 1.0x = 6 小时满值（想他，白天）', () => {
  const m = evolve(fresh(), 6, { hourOfDay: 14, hoursSinceQq: 5 })
  assert.ok(m.missing > 0.99, `6 小时应该基本攒满，实际 ${m.missing}`)
})

test('倍率直接乘在速度上：10x → 0.6 小时满值', () => {
  const m = evolve(fresh(), 0.6, { hourOfDay: 14, hoursSinceQq: 5, rates: { missing: 10 } })
  assert.ok(m.missing > 0.95, `10x 下 0.6 小时应该基本满，实际 ${m.missing}`)
})

test('倍率 0.1x → 60 小时满值（一次演化封顶 6 小时，所以 6 小时只到 10%）', () => {
  const m = evolve(fresh(), 6, { hourOfDay: 14, hoursSinceQq: 5, rates: { missing: 0.1 } })
  assert.ok(m.missing > 0.08 && m.missing < 0.12, `0.1x 下 6 小时约 10%，实际 ${m.missing}`)
})

test('fillTimeHours: 满值时间 = 基准 ÷ 倍率', () => {
  assert.equal(fillTimeHours('missing', { rates: { missing: 1 }, fillHours: 6 }), 6)
  assert.equal(fillTimeHours('missing', { rates: { missing: 2 }, fillHours: 6 }), 3)
  assert.equal(fillTimeHours('missing', { rates: { missing: 10 }, fillHours: 6 }), 0.6)
  assert.equal(fillTimeHours('warmthGain'), null)
  assert.equal(fillTimeHours('missing', { fillHours: 12 }), DEFAULT_FILL_HOURS * 2)
})

test('涩涩倍率：代码层允许就按填的值走（能不能调看面板那颗正式开关）', () => {
  const rates = normalizeRates({ lust: 10 })
  assert.equal(rates.lust, LUST_SLIDER_ENABLED ? 10 : 1)
})

/* ─────────────── 涩涩：对话驱动 + 两层开关（2026-10-26 重做） ───────────────
   模型：挑逗 → 顶上去 → 事后回落到余温下限 → 再随「想他」自己爬、自涨封顶 → 只能靠对话再顶
   两层开关：代码里的 LUST_ENABLED 决定面板露不露，面板上的 lustModeEnabled 才真启用。
   下面用 codeEnabled 这个单测旁路模拟"代码开关已经拧开"。 */

const LUST_ON = Object.freeze({ enabled: true, codeEnabled: true })

test('涩涩默认两层都不亮：放 6 小时也一点不涨', () => {
  const m = evolve(fresh(), 6, { hourOfDay: 14, hoursSinceQq: 5 })
  assert.equal(m.lust, 0)
})

test('涩涩：他挑逗一次，按「单次涨幅」顶上去', () => {
  const m = onTeased(fresh({ lust: 0.1 }), Date.parse('2026-10-26T14:00:00Z'), { lust: LUST_ON })
  assert.equal(Math.round(m.lust * 100), 35)
  assert.equal(m.lastTeasedAt, '2026-10-26T14:00:00.000Z')
})

test('涩涩：挑逗到顶也是 100%，不会溢出', () => {
  const m = onTeased(fresh({ lust: 0.95 }), 0, { lust: LUST_ON })
  assert.equal(m.lust, 1)
})

test('涩涩：没启用的时候挑逗也不动（省得关着还偷偷改数）', () => {
  // 显式写 codeEnabled: false —— 不能靠「LUST_ENABLED 缺省」这种全局状态，
  // 运行版把代码开关打开时（LUST_ENABLED = true）这条就会假失败。
  const m = onTeased(fresh({ lust: 0.3 }), 0, { lust: { enabled: true, codeEnabled: false } })
  assert.equal(m.lust, 0.3)
})

test('涩涩：事后 4 小时正好落回 20% 余温下限', () => {
  const teased = onTeased(fresh({ lust: 0.75 }), 0, { lust: LUST_ON })
  assert.equal(teased.lust, 1) // 0.75 + 25% 顶满
  assert.equal(teased.lustPhase, 'decay')
  const m = evolve(teased, 4, { hourOfDay: 14, hoursSinceQq: 5, lust: LUST_ON })
  assert.ok(Math.abs(m.lust - 0.2) < 0.01, `该落到 20%，实际 ${m.lust}`)
  assert.equal(m.lustPhase, 'grow') // 落到底就翻回自涨
})

test('涩涩：自涨封顶 70%，封顶之后不会再往上飘', () => {
  let m = fresh({ lust: 0.2 })
  for (let i = 0; i < 40; i += 1) m = evolve(m, 6, { hourOfDay: 14, hoursSinceQq: 5, lust: LUST_ON })
  assert.ok(Math.abs(m.lust - 0.7) < 1e-9, `该停在 70%，实际 ${m.lust}`)
})

test('涩涩：余温下限、自涨封顶、回落耗时都能改', () => {
  const custom = { ...LUST_ON, floorPercent: 40, selfCapPercent: 50, decayHours: 2 }
  const teased = onTeased(fresh({ lust: 0.75 }), 0, { lust: custom })
  const m = evolve(teased, 2, { hourOfDay: 14, hoursSinceQq: 5, lust: custom })
  assert.ok(Math.abs(m.lust - 0.4) < 0.01, `该落到 40%，实际 ${m.lust}`)
})

test('涩涩：想他越重，自己爬得越快', () => {
  const slow = evolve(fresh({ lust: 0.2 }), 2, { hourOfDay: 14, hoursSinceQq: 5, lust: LUST_ON })
  const fast = evolve(fresh({ lust: 0.2, missing: 1 }), 2, { hourOfDay: 14, hoursSinceQq: 5, lust: LUST_ON })
  assert.ok(fast.lust > slow.lust)
})

test('涩涩没启用就不参与主情绪，启用才参与', () => {
  const m = fresh({ lust: 0.9, missing: 0.2 })
  assert.notEqual(dominant(m, {}).key, 'lust')
  assert.equal(dominant(m, { lust: LUST_ON }).key, 'lust')
})

test('snapshot: 涩涩那行带锁 / 未启用标记，五个参数原样给面板', () => {
  const snap = snapshot(fresh({ lust: 0.3 }), { fillHours: 6 })
  const row = snap.rows.find((r) => r.key === 'lust')
  assert.equal(row.locked, true, '没启用 → 滑条锁着')
  assert.equal(row.disabled, true)
  assert.equal(snap.lustEnabled, false)
  assert.equal(snap.lust.floorPercent, 20)
  assert.equal(snap.lust.selfCapPercent, 70)
  assert.equal(snap.lust.decayHours, 4)
  assert.equal(snap.lust.teaseStepPercent, 25)

  const on = snapshot(fresh({ lust: 0.3 }), { fillHours: 6, lust: LUST_ON })
  assert.equal(on.lustEnabled, true)
  assert.equal(on.rows.find((r) => r.key === 'lust').disabled, false)
  assert.equal(on.rows.find((r) => r.key === 'lust').locked, false, '启用了 → 滑条可拖')
})

test('snapshot: 每行都有百分比、倍率和满值时间，涩涩带锁', () => {
  const snap = snapshot(fresh({ missing: 0.5, lust: 0.3 }), { fillHours: 6 })
  assert.equal(snap.rows.length, 7)
  const row = snap.rows.find((r) => r.key === 'missing')
  assert.equal(row.percent, 50)
  assert.equal(row.rate, 1)
  assert.equal(row.fillHours, 6)
  const lust = snap.rows.find((r) => r.key === 'lust')
  assert.equal(lust.locked, true, '没启用 → 滑条锁着')
  assert.equal(lust.percent, 30)
})
