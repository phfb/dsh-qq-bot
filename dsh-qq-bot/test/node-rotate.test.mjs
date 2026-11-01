// 节点池切换 → 换新对话：判定逻辑的单测
// 跑法：node --test test/node-rotate.test.mjs
import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

import { ROTATE_ACTION, evaluate, parseState, parseSwitchEvent, shortUrl } from '../lib/node-rotate.mjs'

const NOW = 1_800_000_000_000
const A = 'https://a.example/v1'
const B = 'https://b.example/v1'
const MIN = 50_000_000

/** 一份"什么都够"的基准输入，各用例只改自己关心的字段。 */
function baseline(over = {}) {
  return {
    pending: { seq: 1, from: A, to: B, at: '' },
    baselineUrl: A,
    turnNodes: [{ at: NOW - 3000, url: B }, { at: NOW - 2000, url: B }, { at: NOW - 1000, url: B }],
    genTokens: 60_000_000,
    minTokens: MIN,
    streakN: 3,
    windowX: 8,
    windowM: 5,
    cooldownMs: 300_000,
    lastRotateAt: 0,
    now: NOW,
    ...over,
  }
}

describe('parseSwitchEvent', () => {
  test('正常事件', () => {
    assert.deepEqual(parseSwitchEvent({ seq: 3, at: 'x', from: A, to: B }), { seq: 3, at: 'x', from: A, to: B })
  })
  test('缺字段给空串', () => {
    assert.deepEqual(parseSwitchEvent({ seq: 1 }), { seq: 1, at: '', from: '', to: '' })
  })
  test('null / 数组 / 字符串 → null', () => {
    for (const v of [null, undefined, [], '{"seq":1}']) assert.equal(parseSwitchEvent(v), null)
  })
  test('seq 必须是正整数', () => {
    for (const v of [0, -1, 1.5, 'abc', Number.NaN]) assert.equal(parseSwitchEvent({ seq: v }), null)
  })
  test('字符串数字也认', () => {
    assert.equal(parseSwitchEvent({ seq: '7' }).seq, 7)
  })
})

describe('parseState', () => {
  test('没跑过 → 干净初始值', () => {
    assert.deepEqual(parseState(null), {
      lastSeq: 0,
      lastAt: 0,
      baselineUrl: '',
      genTokens: 0,
      turnNodes: [],
      pending: null,
    })
  })

  test('正常读回全字段', () => {
    const st = parseState({
      lastSeq: 5,
      lastAt: NOW,
      baselineUrl: A,
      genTokens: 1234,
      turnNodes: [{ at: NOW, url: B }],
      pending: { seq: 5, from: A, to: B, at: 'x' },
    })
    assert.equal(st.lastSeq, 5)
    assert.equal(st.baselineUrl, A)
    assert.equal(st.genTokens, 1234)
    assert.equal(st.turnNodes.length, 1)
    assert.equal(st.pending.seq, 5)
  })

  test('脏数据不会炸', () => {
    const st = parseState({ lastSeq: -1, lastAt: 'x', genTokens: -5, turnNodes: 'nope', pending: { seq: 0 } })
    assert.equal(st.lastSeq, 0)
    assert.equal(st.lastAt, 0)
    assert.equal(st.genTokens, 0)
    assert.deepEqual(st.turnNodes, [])
    assert.equal(st.pending, null)
  })

  test('turnNodes 里坏条目被丢掉', () => {
    const st = parseState({ turnNodes: [{ at: NOW, url: B }, { at: 'x' }, null, { url: A }] })
    assert.equal(st.turnNodes.length, 1)
  })
})

describe('evaluate — 前置条件', () => {
  test('没有 pending → noop', () => {
    assert.equal(evaluate(baseline({ pending: null })).action, ROTATE_ACTION.NOOP)
  })

  test('用量没到门槛 → below-tokens（默认 50M）', () => {
    const r = evaluate(baseline({ genTokens: 8_000_000 }))
    assert.equal(r.action, ROTATE_ACTION.BELOW_TOKENS)
    assert.match(r.reason, /800 万/)
    assert.match(r.reason, /5000 万/)
  })

  test('门槛设 0 = 不看用量', () => {
    assert.equal(evaluate(baseline({ genTokens: 0, minTokens: 0 })).action, ROTATE_ACTION.ROTATE)
  })

  test('刚够门槛就放行', () => {
    assert.equal(evaluate(baseline({ genTokens: MIN })).action, ROTATE_ACTION.ROTATE)
  })

  test('冷却期内 → cooldown', () => {
    const r = evaluate(baseline({ lastRotateAt: NOW - 60_000, cooldownMs: 300_000 }))
    assert.equal(r.action, ROTATE_ACTION.COOLDOWN)
  })

  test('冷却过了就放行', () => {
    assert.equal(evaluate(baseline({ lastRotateAt: NOW - 301_000, cooldownMs: 300_000 })).action, ROTATE_ACTION.ROTATE)
  })

  test('冷却 0 = 不限', () => {
    assert.equal(evaluate(baseline({ lastRotateAt: NOW - 1, cooldownMs: 0 })).action, ROTATE_ACTION.ROTATE)
  })
})

describe('evaluate — A-B-A 不换', () => {
  test('切回这局开工时的节点 → back-to-baseline', () => {
    const r = evaluate(
      baseline({
        pending: { seq: 2, from: B, to: A, at: '' },
        baselineUrl: A,
        turnNodes: [{ at: 1, url: A }, { at: 2, url: A }, { at: 3, url: A }],
      }),
    )
    assert.equal(r.action, ROTATE_ACTION.BACK_TO_BASELINE)
    assert.match(r.reason, /缓存能接回/)
  })

  test('A→B→A→B：最后一次切到 B，照常判', () => {
    const r = evaluate(
      baseline({
        pending: { seq: 3, from: A, to: B, at: '' },
        baselineUrl: A,
        turnNodes: [{ at: 1, url: A }, { at: 2, url: B }, { at: 3, url: B }],
        streakN: 2,
      }),
    )
    assert.equal(r.action, ROTATE_ACTION.ROTATE)
  })

  test('baseline 还空着时不会误判成"回到原点"', () => {
    const r = evaluate(baseline({ baselineUrl: '', pending: { seq: 1, from: A, to: B, at: '' } }))
    assert.notEqual(r.action, ROTATE_ACTION.BACK_TO_BASELINE)
  })
})

describe('evaluate — 方案 3 的两条判定', () => {
  test('连续 N 轮都在 B → ROTATE（streak）', () => {
    const r = evaluate(
      baseline({
        streakN: 3,
        turnNodes: [{ at: 1, url: A }, { at: 2, url: B }, { at: 3, url: B }, { at: 4, url: B }],
      }),
    )
    assert.equal(r.action, ROTATE_ACTION.ROTATE)
    assert.equal(r.matched, 'streak')
  })

  test('连续不够，但窗口里够 M 轮 → ROTATE（window）', () => {
    const r = evaluate(
      baseline({
        streakN: 3,
        windowX: 8,
        windowM: 5,
        turnNodes: [
          { at: 1, url: B },
          { at: 2, url: A },
          { at: 3, url: B },
          { at: 4, url: A },
          { at: 5, url: B },
          { at: 6, url: A },
          { at: 7, url: B },
          { at: 8, url: B },
        ],
      }),
    )
    assert.equal(r.action, ROTATE_ACTION.ROTATE)
    assert.equal(r.matched, 'window')
    assert.match(r.reason, /8 轮里有 5 轮/)
  })

  test('连续不够、窗口也不够 → NOT_YET', () => {
    const r = evaluate(
      baseline({
        streakN: 3,
        windowX: 8,
        windowM: 5,
        turnNodes: [{ at: 1, url: B }, { at: 2, url: A }, { at: 3, url: A }, { at: 4, url: B }],
      }),
    )
    assert.equal(r.action, ROTATE_ACTION.NOT_YET)
    assert.match(r.reason, /还没攒够/)
  })

  test('窗口里刚好 M 轮也算', () => {
    const r = evaluate(
      baseline({
        streakN: 3,
        windowX: 8,
        windowM: 5,
        turnNodes: [
          { at: 1, url: B },
          { at: 2, url: B },
          { at: 3, url: A },
          { at: 4, url: A },
          { at: 5, url: B },
          { at: 6, url: A },
          { at: 7, url: B },
          { at: 8, url: B },
        ],
      }),
    )
    assert.equal(r.action, ROTATE_ACTION.ROTATE)
    assert.equal(r.matched, 'window')
  })

  test('窗口里 M-1 轮就不换', () => {
    const r = evaluate(
      baseline({
        streakN: 3,
        windowX: 8,
        windowM: 5,
        turnNodes: [
          { at: 1, url: B },
          { at: 2, url: A },
          { at: 3, url: A },
          { at: 4, url: A },
          { at: 5, url: B },
          { at: 6, url: A },
          { at: 7, url: B },
          { at: 8, url: B },
        ],
      }),
    )
    assert.equal(r.action, ROTATE_ACTION.NOT_YET)
  })

  test('一轮记录都没有 → NOT_YET，不抛', () => {
    assert.equal(evaluate(baseline({ turnNodes: [] })).action, ROTATE_ACTION.NOT_YET)
  })
})

describe('evaluate — 真实节奏串联', () => {
  test('切到 B → 第 1、2 轮不换 → 第 3 轮连续够 3 才换', () => {
    const nodes = []
    const step = (url) => {
      nodes.push({ at: NOW, url })
      return evaluate(baseline({ turnNodes: [...nodes] }))
    }
    assert.equal(step(B).action, ROTATE_ACTION.NOT_YET)
    assert.equal(step(B).action, ROTATE_ACTION.NOT_YET)
    assert.equal(step(B).action, ROTATE_ACTION.ROTATE)
  })

  test('长会话 + A→B→A：全程不换（缓存能接回）', () => {
    const nodes = [
      { at: 1, url: A },
      { at: 2, url: B },
      { at: 3, url: B },
      { at: 4, url: A },
      { at: 5, url: A },
      { at: 6, url: A },
    ]
    const r = evaluate(baseline({ pending: { seq: 2, from: B, to: A, at: '' }, turnNodes: nodes }))
    assert.equal(r.action, ROTATE_ACTION.BACK_TO_BASELINE)
  })

  test('短会话（用量没到 50M）即使连续 3 轮在 B 也不换', () => {
    const r = evaluate(
      baseline({
        genTokens: 4_000_000,
        turnNodes: [{ at: 1, url: B }, { at: 2, url: B }, { at: 3, url: B }],
      }),
    )
    assert.equal(r.action, ROTATE_ACTION.BELOW_TOKENS)
  })
})

describe('shortUrl', () => {
  test('只留域名', () => {
    assert.equal(shortUrl('https://tk.enjoygoo.win/v1'), 'tk.enjoygoo.win')
  })
  test('空值有兜底', () => {
    assert.equal(shortUrl(''), '(未定)')
    assert.equal(shortUrl(null), '(未定)')
  })
})
