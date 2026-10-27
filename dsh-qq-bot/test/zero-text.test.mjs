/**
 * 零正文兜底的配置回归测试。
 *
 * 2026-10-27 事故：上下文压到 58 万 token 时 flash 模型开始只 thinking 不给正文，
 * 她在 QQ 里安静了十几分钟，日志里只有几行「本段 0 字」。
 * 这里守的是那个兜底开关的取值 —— 关掉它就等于把「静默故障」放回去。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS, parseConfig } from '../lib/config.js'

test('零正文换局默认开着，且是 2 轮', () => {
  assert.equal(DEFAULTS.zeroTextRolloverTurns, 2)
  assert.equal(parseConfig({}).config.zeroTextRolloverTurns, 2)
})

test('zeroTextRolloverTurns: 0 表示只报警不换局（允许，但要显式写）', () => {
  assert.equal(parseConfig({ zeroTextRolloverTurns: 0 }).config.zeroTextRolloverTurns, 0)
})

test('zeroTextRolloverTurns: 坏值被夹回合法区间', () => {
  // num() 的语义：低于下限 / NaN → 用默认值；高于上限 → 压到上限
  assert.equal(parseConfig({ zeroTextRolloverTurns: -3 }).config.zeroTextRolloverTurns, 2)
  assert.equal(parseConfig({ zeroTextRolloverTurns: 999 }).config.zeroTextRolloverTurns, 10)
  assert.equal(parseConfig({ zeroTextRolloverTurns: 'abc' }).config.zeroTextRolloverTurns, 2)
})

test('零正文先「推一句」，默认开，文案可换', () => {
  // 真相：模型把整段回复写进了思考通道，正文留空。先催一句比直接换局便宜得多。
  assert.equal(DEFAULTS.zeroTextNudge, true)
  assert.equal(parseConfig({}).config.zeroTextNudge, true)
  assert.equal(parseConfig({ zeroTextNudge: false }).config.zeroTextNudge, false)
  assert.ok(parseConfig({}).config.zeroTextNudgeText.includes('思考'))
  assert.equal(parseConfig({ zeroTextNudgeText: '  快说句话  ' }).config.zeroTextNudgeText, '快说句话')
  assert.equal(parseConfig({ zeroTextNudgeText: '   ' }).config.zeroTextNudgeText, DEFAULTS.zeroTextNudgeText)
})

test('换局阈值可配（代码默认 80，本机 config.json 现在是 60）', () => {
  // 2026-10-27 中途试过 35，用户看过实际占用后改回 60 —— 别再拿错误的估算去改它。
  assert.equal(DEFAULTS.contextLimitPercent, 80)
  assert.equal(parseConfig({ contextLimitPercent: 35 }).config.contextLimitPercent, 35)
  assert.equal(parseConfig({ contextLimitPercent: 60 }).config.contextLimitPercent, 60)
})
