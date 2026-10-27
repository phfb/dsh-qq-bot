/**
 * 看门狗阈值和判定表的回归测试。
 *
 * 看门狗管的是「零正文判定抓不到的那一半」：请求发出去了、一直不回包 ——
 * 那一轮压根还没结束，只能靠时间发现。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS, parseConfig, WATCHDOG_MIN_SECONDS, WATCHDOG_MAX_SECONDS } from '../lib/config.js'
import { judgeWatchdog } from '../lib/watchdog.mjs'

test('默认 300 秒，落在设置页给的范围里', () => {
  assert.equal(DEFAULTS.watchdogSeconds, 300)
  assert.ok(DEFAULTS.watchdogSeconds >= WATCHDOG_MIN_SECONDS)
  assert.ok(DEFAULTS.watchdogSeconds <= WATCHDOG_MAX_SECONDS)
  assert.equal(parseConfig({}).config.watchdogSeconds, 300)
})

test('设置页范围 180~900：超出会被压回去并记一条 problem', () => {
  const low = parseConfig({ watchdogSeconds: 60 })
  assert.equal(low.config.watchdogSeconds, WATCHDOG_MIN_SECONDS)
  assert.ok(low.problems.some((p) => p.includes('watchdogSeconds')))

  const high = parseConfig({ watchdogSeconds: 5000 })
  assert.equal(high.config.watchdogSeconds, WATCHDOG_MAX_SECONDS)
  assert.ok(high.problems.some((p) => p.includes('watchdogSeconds')))

  assert.equal(parseConfig({ watchdogSeconds: 600 }).config.watchdogSeconds, 600)
})

test('配置里显式写 0 可以关掉看门狗（设置页不给这个选项，但文件能写）', () => {
  assert.equal(parseConfig({ watchdogSeconds: 0 }).config.watchdogSeconds, 0)
})

test('坏值退回默认', () => {
  assert.equal(parseConfig({ watchdogSeconds: 'abc' }).config.watchdogSeconds, 300)
})

test('判定：没在跑、没到点、关掉，都不动手', () => {
  assert.equal(judgeWatchdog({ inTurn: false, idleMs: 999999, thresholdMs: 300000, strikes: 0, maxStrikes: 2 }), 'idle')
  assert.equal(judgeWatchdog({ inTurn: true, idleMs: 1000, thresholdMs: 300000, strikes: 0, maxStrikes: 2 }), 'wait')
  assert.equal(judgeWatchdog({ inTurn: true, idleMs: 999999, thresholdMs: 0, strikes: 0, maxStrikes: 2 }), 'off')
})

test('判定：到点了就救，救满上限才换局', () => {
  const base = { inTurn: true, idleMs: 300000, thresholdMs: 300000 }
  assert.equal(judgeWatchdog({ ...base, strikes: 0, maxStrikes: 2 }), 'rescue')
  assert.equal(judgeWatchdog({ ...base, strikes: 1, maxStrikes: 2 }), 'rescue')
  assert.equal(judgeWatchdog({ ...base, strikes: 2, maxStrikes: 2 }), 'rollover')
  // maxStrikes = 0 表示不换局，一直救
  assert.equal(judgeWatchdog({ ...base, strikes: 9, maxStrikes: 0 }), 'rescue')
})

test('时间戳异常（负数/NaN）宁可不动手', () => {
  assert.equal(judgeWatchdog({ inTurn: true, idleMs: -5, thresholdMs: 300000, strikes: 0, maxStrikes: 2 }), 'wait')
  assert.equal(judgeWatchdog({ inTurn: true, idleMs: NaN, thresholdMs: 300000, strikes: 0, maxStrikes: 2 }), 'wait')
})
