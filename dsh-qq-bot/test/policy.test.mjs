/**
 * policy.mjs 的单元测试。纯函数，不需要 DSH。
 *
 * 跑法（系统没装 node，用 SnowLuma 自带的）：
 *   node --test dsh-qq-bot\test\policy.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  RateLimiter,
  cleanMarkdown,
  extractText,
  isAllowedUser,
  looksRejected,
  randomIn,
  segmentText,
  splitLongText,
} from '../lib/policy.mjs'

const SEG = { shortMax: 25, longMin: 60 }

/* ── 白名单 ── */

test('isAllowedUser: 命中 / 未命中 / 空表', () => {
  assert.equal(isAllowedUser('123456789', ['123456789']), true)
  assert.equal(isAllowedUser(123456789, ['123456789']), true)
  assert.equal(isAllowedUser('123', ['123456789']), false)
  assert.equal(isAllowedUser('123456789', []), false)
  assert.equal(isAllowedUser('', ['123456789']), false)
})

/* ── 限流 ── */

test('RateLimiter: 额度内放行，超额拒绝，窗口滑走后恢复', () => {
  const rl = new RateLimiter({ windowMs: 1000, max: 3 })
  const t0 = 1_000_000
  assert.equal(rl.take(t0).allowed, true)
  assert.equal(rl.take(t0 + 10).allowed, true)
  assert.equal(rl.take(t0 + 20).allowed, true)
  const denied = rl.take(t0 + 30)
  assert.equal(denied.allowed, false)
  assert.ok(denied.retryAfterMs > 0)
  // 窗口滑过第一条之后又能进
  assert.equal(rl.take(t0 + 1001).allowed, true)
})

test('RateLimiter: refund 能还名额', () => {
  const rl = new RateLimiter({ windowMs: 1000, max: 1 })
  assert.equal(rl.take(0).allowed, true)
  assert.equal(rl.take(1).allowed, false)
  rl.refund()
  assert.equal(rl.take(2).allowed, true)
})

/* ── OneBot 消息解析 ── */

test('extractText: array 格式', () => {
  const msg = [
    { type: 'text', data: { text: '你好' } },
    { type: 'image', data: { file: 'a.jpg' } },
    { type: 'text', data: { text: '看这个' } },
  ]
  assert.equal(extractText(msg), '你好[图片]看这个')
})

test('extractText: 引用和表情', () => {
  const msg = [
    { type: 'reply', data: { id: '1' } },
    { type: 'at', data: { qq: '123456789' } },
    { type: 'text', data: { text: ' 在吗' } },
  ]
  assert.equal(extractText(msg), '[引用]@123456789 在吗')
})

test('extractText: CQ 码字符串', () => {
  assert.equal(
    extractText('[CQ:reply,id=1]hi[CQ:image,file=x.jpg]'),
    'hi[图片]',
  )
})

test('extractText: 空数组 / 非消息', () => {
  assert.equal(extractText([]), '')
  assert.equal(extractText(null), '')
  assert.equal(extractText(undefined), '')
})

test('extractText: 未知段忽略而不是丢 JSON', () => {
  const msg = [{ type: 'weird', data: { foo: 'bar' } }, { type: 'text', data: { text: 'ok' } }]
  assert.equal(extractText(msg), 'ok')
})

/* ── 分段 ── */

test('segmentText: 短句整条', () => {
  assert.deepEqual(segmentText('外卖比我还重要？', SEG), ['外卖比我还重要？'])
})

test('segmentText: 超长整条不拆', () => {
  const long = '这'.repeat(80)
  assert.deepEqual(segmentText(long, SEG), [long])
})

test('segmentText: 中间区间按标点切', () => {
  const text = '今天真的好累啊。你都不会问我一句的吗？我等你很久了诶。'
  const parts = segmentText(text, SEG)
  assert.ok(parts.length >= 2, `期望切成多段，实际 ${JSON.stringify(parts)}`)
  assert.equal(parts.join(''), text, '拼回来必须和原文一致')
  for (const p of parts) assert.ok(p.length > 0)
})

test('segmentText: 碎段并进前一段', () => {
  const text = '我生气了嗯。你倒是说话啊你说句话啊行不行？'
  const parts = segmentText(text, SEG)
  // 「嗯。」这种不该单独成段
  assert.ok(parts.every((p) => [...p].length >= 4 || parts.length === 1), JSON.stringify(parts))
})

test('segmentText: 空串', () => {
  assert.deepEqual(segmentText('   ', SEG), [])
})

/* ── markdown 清洗 ── */

test('cleanMarkdown: 去粗体 / 行内代码 / 标题', () => {
  assert.equal(cleanMarkdown('**在**了 `ok`'), '在了 ok')
  assert.equal(cleanMarkdown('### 标题\n正文'), '标题\n正文')
})

test('cleanMarkdown: 代码围栏保留内容', () => {
  const src = '看这个\n```python\nprint(1)\n```\n就这么简单'
  const out = cleanMarkdown(src)
  assert.ok(out.includes('print(1)'), out)
  assert.ok(!out.includes('```'), out)
})

test('cleanMarkdown: 链接', () => {
  assert.equal(cleanMarkdown('[文档](https://a.com)'), '文档 https://a.com')
})

/* ── 超长切分 ── */

test('splitLongText: 不超限原样返回', () => {
  assert.deepEqual(splitLongText('abc', 10), ['abc'])
})

test('splitLongText: 超限均匀切', () => {
  const parts = splitLongText('a'.repeat(25), 10)
  assert.deepEqual(parts.map((p) => p.length), [10, 10, 5])
})

test('splitLongText: 空串', () => {
  assert.deepEqual(splitLongText('', 10), [])
})

/* ── 杂项 ── */

test('randomIn: 落在区间内', () => {
  for (let i = 0; i < 50; i += 1) {
    const v = randomIn([2, 5])
    assert.ok(v >= 2 && v <= 5, String(v))
  }
})

test('looksRejected: 认得出"别吵"', () => {
  assert.equal(looksRejected('别吵我'), true)
  assert.equal(looksRejected('我在写代码'), false)
})
