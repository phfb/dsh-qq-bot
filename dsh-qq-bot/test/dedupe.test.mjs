/**
 * 重复消息合并的判定表。
 *
 * 2026-10-27 现场：同一条话连发两次，每一份都触发一轮，她把同一段回答了两遍，
 * 第二遍还带点不耐烦（「听到了，第三遍了 / 你不用一遍一遍再讲」）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS, parseConfig } from '../lib/config.js'
import { isDuplicateMessage } from '../lib/dedupe.mjs'

test('默认 8 秒窗口，可以关掉', () => {
  assert.equal(DEFAULTS.dedupeSeconds, 8)
  assert.equal(parseConfig({}).config.dedupeSeconds, 8)
  assert.equal(parseConfig({ dedupeSeconds: 0 }).config.dedupeSeconds, 0)
  assert.equal(parseConfig({ dedupeSeconds: 999 }).config.dedupeSeconds, 120)
})

test('窗口内重复 → 丢', () => {
  assert.equal(
    isDuplicateMessage({ lastText: '在吗', lastAt: 1000, now: 3000, windowMs: 8000, lastInFlight: false }),
    true,
  )
})

test('超出窗口 → 放过（隔了几分钟他自己再讲一遍，那是故意的）', () => {
  assert.equal(
    isDuplicateMessage({ lastText: '在吗', lastAt: 1000, now: 60000, windowMs: 8000, lastInFlight: false }),
    false,
  )
})

test('上一条还在处理中 → 无论隔多久都算重复（他等急了又发一遍）', () => {
  assert.equal(
    isDuplicateMessage({ lastText: '在吗', lastAt: 1000, now: 99999, windowMs: 8000, lastInFlight: true }),
    true,
  )
})

test('没有上一条 / 窗口关了 / 时间戳异常 → 一律放过', () => {
  const base = { lastAt: 1000, now: 2000, windowMs: 8000, lastInFlight: false }
  assert.equal(isDuplicateMessage({ ...base, lastText: null }), false)
  assert.equal(isDuplicateMessage({ ...base, lastText: '' }), false)
  assert.equal(isDuplicateMessage({ ...base, lastText: '在吗', windowMs: 0 }), false)
  assert.equal(isDuplicateMessage({ ...base, lastText: '在吗', lastAt: NaN }), false)
  // 时间戳反了（时钟跳变）不能乱合并
  assert.equal(isDuplicateMessage({ ...base, lastText: '在吗', lastAt: 5000, now: 1000 }), false)
})
