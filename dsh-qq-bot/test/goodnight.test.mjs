/**
 * 道别闭环的单元测试。纯函数。
 *
 *   node --test "test/*.test.mjs"     （在 dsh-qq-bot 目录下跑）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_GAP_MIN, isFarewell, shouldStopHere } from '../lib/goodnight.mjs'

const NOW = Date.parse('2026-10-27T00:30:00+08:00')

test('isFarewell: 常见的道别都认得', () => {
  for (const t of ['晚安', '晚安，早点睡', '我睡了', '睡了睡了', '先睡啦', '拜拜', '明天见',
    '困了，眯一会', '我下线了', '安啦']) {
    assert.equal(isFarewell(t), true, `「${t}」应该算道别`)
  }
})

test('isFarewell: 普通说话不算', () => {
  for (const t of ['在吗', '那个参数改好了', '今天吃什么', '', '嗯']) {
    assert.equal(isFarewell(t), false, `「${t}」不该算道别`)
  }
})

test('isFarewell: 太长的多半在说事，不算道别', () => {
  const long = '我睡觉前记得把那个参数改一下顺便看看日志里有没有报错再说一句要不要重跑一遍'
  assert.ok([...long].length > 30, `测试用的句子得超过 30 字，实际 ${[...long].length}`)
  assert.equal(isFarewell(long), false)
})

/* ── 闭环判定 ── */

const SAID_NIGHT = { text: '晚安，早点睡', at: NOW - 60_000 }

test('shouldStopHere: 她说过晚安 + 他也说晚安 → 吞掉', () => {
  const r = shouldStopHere({ text: '晚安', lastAssistant: SAID_NIGHT, now: NOW })
  assert.equal(r.stop, true)
  assert.match(r.reason, /已经说过/)
})

test('shouldStopHere: 他说「睡了」也算', () => {
  const r = shouldStopHere({ text: '睡了', lastAssistant: SAID_NIGHT, now: NOW })
  assert.equal(r.stop, true)
})

test('shouldStopHere: 她最后说的不是道别 → 照常回', () => {
  const last = { text: '那你早点休息哦', at: NOW - 60_000 }
  const r = shouldStopHere({ text: '晚安', lastAssistant: last, now: NOW })
  assert.equal(r.stop, false)
})

test('shouldStopHere: 他还在说事 → 照常回', () => {
  const r = shouldStopHere({ text: '对了明天那个东西记得带', lastAssistant: SAID_NIGHT, now: NOW })
  assert.equal(r.stop, false)
})

test('shouldStopHere: 隔太久了算新的一轮', () => {
  const old = { text: '晚安', at: NOW - (DEFAULT_GAP_MIN + 5) * 60_000 }
  const r = shouldStopHere({ text: '晚安', lastAssistant: old, now: NOW })
  assert.equal(r.stop, false)
})

test('shouldStopHere: 没有她上一句 → 不拦', () => {
  assert.equal(shouldStopHere({ text: '晚安', lastAssistant: null, now: NOW }).stop, false)
  assert.equal(shouldStopHere({ text: '晚安', now: NOW }).stop, false)
})

test('shouldStopHere: 自定义间隔生效', () => {
  const last = { text: '晚安', at: NOW - 30 * 60_000 }
  assert.equal(shouldStopHere({ text: '晚安', lastAssistant: last, now: NOW, gapMin: 60 }).stop, true)
  assert.equal(shouldStopHere({ text: '晚安', lastAssistant: last, now: NOW, gapMin: 10 }).stop, false)
})

test('shouldStopHere: 时间倒流（改系统时间）不拦', () => {
  const future = { text: '晚安', at: NOW + 10 * 60_000 }
  assert.equal(shouldStopHere({ text: '晚安', lastAssistant: future, now: NOW }).stop, false)
})
