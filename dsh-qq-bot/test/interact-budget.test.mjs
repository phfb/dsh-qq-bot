/**
 * 小动作额度的单元测试。纯函数，不需要连接。
 *
 *   node --test "test/*.test.mjs"     （在 dsh-qq-bot 目录下跑）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  INTERACT_DEFAULTS,
  checkBudget,
  emptyBudget,
  rollDay,
  takeBudget,
} from '../lib/interact-budget.mjs'

const T0 = Date.parse('2026-10-26T20:00:00+08:00')

test('emptyBudget: 三项都是 0', () => {
  const b = emptyBudget(T0)
  assert.equal(b.poke, 0)
  assert.equal(b.qzone, 0)
  assert.equal(b.link, 0)
  assert.equal(b.dayStart, T0)
})

test('rollDay: 同一天不动', () => {
  const b = { dayStart: T0, poke: 2, qzone: 1, link: 0 }
  const r = rollDay(b, T0 + 3 * 3600_000)
  assert.equal(r.poke, 2)
  assert.equal(r.dayStart, T0)
})

test('rollDay: 过 24 小时归零', () => {
  const b = { dayStart: T0, poke: 5, qzone: 1, link: 1 }
  const r = rollDay(b, T0 + 24 * 3600_000)
  assert.equal(r.poke, 0)
  assert.equal(r.qzone, 0)
  assert.equal(r.dayStart, T0 + 24 * 3600_000)
})

test('rollDay: 没有 dayStart 就重新开一天', () => {
  const r = rollDay({ poke: 3 }, T0)
  assert.equal(r.poke, 0)
  assert.equal(r.dayStart, T0)
})

test('checkBudget: 没用完就放行', () => {
  const v = checkBudget(emptyBudget(T0), 'poke', 5)
  assert.equal(v.ok, true)
  assert.equal(v.used, 0)
})

test('checkBudget: 到顶就拦，并说清第几次', () => {
  const v = checkBudget({ dayStart: T0, poke: 5, qzone: 0, link: 0 }, 'poke', 5)
  assert.equal(v.ok, false)
  assert.match(v.reason, /5\/5/)
  assert.match(v.reason, /戳一戳/)
})

test('checkBudget: 上限设成 0 等于关掉这项', () => {
  const v = checkBudget(emptyBudget(T0), 'qzone', 0)
  assert.equal(v.ok, false)
  assert.match(v.reason, /没开/)
})

test('checkBudget: 三项互不干扰', () => {
  const b = { dayStart: T0, poke: 5, qzone: 0, link: 0 }
  assert.equal(checkBudget(b, 'qzone', 1).ok, true, '戳满了不该影响发说说')
  assert.equal(checkBudget(b, 'link', 1).ok, true, '戳满了不该影响分享')
})

test('takeBudget: 记一笔，不改原对象', () => {
  const b = emptyBudget(T0)
  const n = takeBudget(b, 'poke')
  assert.equal(n.poke, 1)
  assert.equal(b.poke, 0, '不能改原对象')
})

test('takeBudget: 连记 5 次之后就该被拦', () => {
  let b = emptyBudget(T0)
  for (let i = 0; i < 5; i += 1) b = takeBudget(b, 'poke')
  assert.equal(checkBudget(b, 'poke', 5).ok, false)
})

test('默认额度：说说一天只给一条', () => {
  assert.equal(INTERACT_DEFAULTS.qzoneMaxPerDay, 1)
  assert.equal(INTERACT_DEFAULTS.linkMaxPerDay, 1)
  assert.ok(INTERACT_DEFAULTS.pokeMaxPerDay <= 10)
})
