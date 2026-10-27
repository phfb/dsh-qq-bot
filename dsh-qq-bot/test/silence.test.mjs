/**
 * 「零正文」到底是故障还是故意的 —— 判定表的回归测试。
 *
 * 背景：2026-10-27 她在 QQ 里安静了十几分钟，根因是模型把整段回复写进了思考通道、
 * 正文留空。第一版兜底是「这轮零正文就催」，但那样会把「你让她戳你一下，她戳了、没说话」
 * 也当成故障去催 —— 等于嫌她多做了动作。这个文件守的就是这两者分得开。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { judgeTurnSilence, STUCK_REASONING_MIN_CHARS } from '../lib/silence.mjs'

test('说了话就是正常，别的信号一律不用看', () => {
  assert.equal(judgeTurnSilence({ spoke: true, hadToolCall: true, lastReasoningLen: 999 }), 'spoken')
  assert.equal(judgeTurnSilence({ spoke: true }), 'spoken')
})

test('答案写在思考里（真实现场：turn 224 是 308 字思考、正文 0 字）→ 故障', () => {
  assert.equal(judgeTurnSilence({ spoke: false, hadToolCall: true, lastReasoningLen: 308 }), 'stuck')
  assert.equal(judgeTurnSilence({ spoke: false, hadToolCall: false, lastReasoningLen: 300 }), 'stuck')
})

test('什么都没干、一个字没有 → 故障（turn 225 那种）', () => {
  assert.equal(judgeTurnSilence({ spoke: false, hadToolCall: false, lastReasoningLen: 0 }), 'stuck')
  assert.equal(judgeTurnSilence({}), 'stuck')
})

test('动了手、思考里也没东西 → 按故意处理，不催', () => {
  // 戳一戳 / 点赞 / 只发表情包：她做了动作，本来就不打算说话
  assert.equal(judgeTurnSilence({ spoke: false, hadToolCall: true, lastReasoningLen: 0 }), 'quiet')
})

test('思考很短（只够一句语气词）不算「答案写错通道」', () => {
  assert.equal(
    judgeTurnSilence({ spoke: false, hadToolCall: true, lastReasoningLen: STUCK_REASONING_MIN_CHARS - 1 }),
    'quiet',
  )
  assert.equal(
    judgeTurnSilence({ spoke: false, hadToolCall: true, lastReasoningLen: STUCK_REASONING_MIN_CHARS }),
    'stuck',
  )
})
