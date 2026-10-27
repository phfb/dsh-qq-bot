/**
 * 日志轮转的配置回归测试。
 *
 * 轮转逻辑本身写在 index.js 里（writeLog 内联，热路径，没抽成模块）——
 * 这里守的是配置项：默认 10MB、可以关、坏值不炸。
 * 行为验证靠现场跑：把上限调到 1KB 灌日志，确认只留一份 qq-bot.log.1。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS, parseConfig } from '../lib/config.js'

test('日志轮转默认 10MB', () => {
  assert.equal(DEFAULTS.logRotateMB, 10)
  assert.equal(parseConfig({}).config.logRotateMB, 10)
})

test('可以关掉（0 = 不轮转），也可以调大', () => {
  assert.equal(parseConfig({ logRotateMB: 0 }).config.logRotateMB, 0)
  assert.equal(parseConfig({ logRotateMB: 50 }).config.logRotateMB, 50)
})

test('坏值退回默认，超大值压到上限', () => {
  assert.equal(parseConfig({ logRotateMB: 9e9 }).config.logRotateMB, 512)
  assert.equal(parseConfig({ logRotateMB: 'abc' }).config.logRotateMB, 10)
})
