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

test('换局阈值可以调到 35（本机现在就是 35，别让它回到 60）', () => {
  // 代码默认仍是 80（老值，给别人装的时候别一上来就换局），
  // 但这台机器的 config.json 已经改成 35 —— 上下文到 35 万 token 就开始换新局。
  assert.equal(DEFAULTS.contextLimitPercent, 80)
  assert.equal(parseConfig({ contextLimitPercent: 35 }).config.contextLimitPercent, 35)
})
