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
  expandQuote,
  extractQuoteId,
  extractText,
  formatQuote,
  hasImageSegments,
  isAllowedUser,
  limitImageSegments,
  looksRejected,
  randomIn,
  segmentText,
  splitLongText,
  stripTrailingPeriod,
  takeMergeMarker,
  looksLikeWork,
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

/* ── 引用段的 message_id（expandQuote 靠它去 get_msg 取原文）── */

test('extractQuoteId: array 格式取 reply 段的 id', () => {
  assert.equal(
    extractQuoteId([
      { type: 'reply', data: { id: '7485621634122345678' } },
      { type: 'text', data: { text: ' 这句是啥意思' } },
    ]),
    '7485621634122345678',
  )
})

test('extractQuoteId: 没有 reply 段返回 null', () => {
  assert.equal(extractQuoteId([{ type: 'text', data: { text: '在吗' } }]), null)
  assert.equal(extractQuoteId('在吗'), null)
  assert.equal(extractQuoteId(null), null)
})

test('extractQuoteId: reply 段缺 id / 空 id 都算没有', () => {
  assert.equal(extractQuoteId([{ type: 'reply', data: {} }]), null)
  assert.equal(extractQuoteId([{ type: 'reply', data: { id: '  ' } }]), null)
})

test('extractQuoteId: CQ 码字符串里取 id（id 不在最后一个参数也要取到）', () => {
  assert.equal(extractQuoteId('[CQ:reply,id=123,text=abc]你好'), '123')
  assert.equal(extractQuoteId('[CQ:face,id=1]你好'), null)
})

test('extractQuoteId: 数字 id 也认', () => {
  assert.equal(extractQuoteId([{ type: 'reply', data: { id: 456 } }]), '456')
})

/* ── 引用里的图：张数封顶 ── */

test('limitImageSegments: 只留前 N 张图，文字段全留', () => {
  const msg = [
    { type: 'text', data: { text: 'a' } },
    { type: 'image', data: { file: '1.jpg' } },
    { type: 'image', data: { file: '2.jpg' } },
    { type: 'mface', data: { url: 'x' } },
    { type: 'text', data: { text: 'b' } },
  ]
  const out = limitImageSegments(msg, 2)
  assert.equal(out.length, 4)
  assert.equal(out.filter((s) => s.type === 'image').length, 2)
  assert.deepEqual(out.filter((s) => s.type === 'text').map((s) => s.data.text), ['a', 'b'])
})

test('limitImageSegments: 上限定 0 就一张都不留；不是 array 原样返回', () => {
  const msg = [{ type: 'image', data: { file: '1.jpg' } }, { type: 'text', data: { text: 'x' } }]
  assert.deepEqual(limitImageSegments(msg, 0), [{ type: 'text', data: { text: 'x' } }])
  assert.equal(limitImageSegments('[CQ:image,file=1.jpg]x', 4), '[CQ:image,file=1.jpg]x')
})

test('hasImageSegments: 认得出图 / 表情 / 纯文字', () => {
  assert.equal(hasImageSegments([{ type: 'image', data: {} }]), true)
  assert.equal(hasImageSegments([{ type: 'mface', data: {} }]), true)
  assert.equal(hasImageSegments([{ type: 'text', data: { text: 'x' } }]), false)
  assert.equal(hasImageSegments(null), false)
})

/* ── 引用展开（expandQuote / formatQuote）──
   她以前只看得见「[引用]」三个字，看不见引的是哪句。这几个用例盯的就是那三个字
   到底有没有被填成原话，以及取不到时有没有乖乖退回占位。 */

const quoteMsg = (id, text = '') => [
  { type: 'reply', data: { id } },
  ...(text === '' ? [] : [{ type: 'text', data: { text } }]),
]

test('formatQuote: 带昵称和正文', () => {
  const data = { message: [{ type: 'text', data: { text: '那不是复制文件，那是搬家' } }], sender: { nickname: 'Never' } }
  assert.equal(formatQuote(data), '[引用 Never]: 那不是复制文件，那是搬家')
})

test('formatQuote: 没有昵称就只留「[引用]」', () => {
  const data = { message: [{ type: 'text', data: { text: '在吗' } }] }
  assert.equal(formatQuote(data), '[引用]: 在吗')
})

test('formatQuote: 空正文 / 只有表情的引用返回 null', () => {
  assert.equal(formatQuote({ message: [{ type: 'text', data: { text: '   ' } }] }), null)
  assert.equal(formatQuote({ message: [] }), null)
  assert.equal(formatQuote(null), null)
})

test('formatQuote: 太长截断（不把一整段聊天记录塞进正文）', () => {
  const data = { message: [{ type: 'text', data: { text: '啊'.repeat(50) } }], sender: { nickname: 'Never' } }
  const out = formatQuote(data, { maxChars: 10 })
  assert.equal(out, `[引用 Never]: ${'啊'.repeat(10)}…`)
})

test('expandQuote: 把引用原话取回来', async () => {
  const fake = {
    1001: { message: [{ type: 'text', data: { text: '外卖比我还重要？' } }], sender: { nickname: 'Never' } },
  }
  const out = await expandQuote(quoteMsg('1001', ' 你这话什么意思'), {
    fetchMsg: async (id) => fake[id] ?? null,
  })
  assert.equal(out, '[引用 Never]: 外卖比我还重要？')
})

test('expandQuote: 没有引用段就不取（也不该白打一次 get_msg）', async () => {
  let called = 0
  const out = await expandQuote([{ type: 'text', data: { text: '在吗' } }], {
    fetchMsg: async () => { called++; return null },
  })
  assert.equal(out, null)
  assert.equal(called, 0)
})

test('expandQuote: 引用里的引用一并展开', async () => {
  const fake = {
    A: { message: [{ type: 'reply', data: { id: 'B' } }, { type: 'text', data: { text: ' 这句' } }], sender: { nickname: 'Never' } },
    B: { message: [{ type: 'text', data: { text: '更早那句' } }], sender: { nickname: 'Never' } },
  }
  const out = await expandQuote(quoteMsg('A'), { fetchMsg: async (id) => fake[id] ?? null })
  assert.equal(out, '[引用 Never]: [引用 Never]: 更早那句 这句')
})

test('expandQuote: 环形引用不会转圈（maxDepth 兜住）', async () => {
  const fake = {
    A: { message: [{ type: 'reply', data: { id: 'B' } }, { type: 'text', data: { text: 'A' } }], sender: { nickname: 'X' } },
    B: { message: [{ type: 'reply', data: { id: 'A' } }, { type: 'text', data: { text: 'B' } }], sender: { nickname: 'X' } },
  }
  let calls = 0
  const out = await expandQuote(quoteMsg('A'), {
    fetchMsg: async (id) => { calls++; return fake[id] ?? null },
    maxDepth: 2,
  })
  assert.equal(calls, 2, '最多只展两层')
  assert.ok(out !== null)
})

test('expandQuote: 取不到就返回 null（调用方退回「[引用]」，不能整条消息丢掉）', async () => {
  const errors = []
  const out = await expandQuote(quoteMsg('404', ' 你引的是啥'), {
    fetchMsg: async () => { throw new Error('消息不存在') },
    onError: (id, err) => errors.push([id, err.message]),
  })
  assert.equal(out, null)
  assert.deepEqual(errors, [['404', '消息不存在']])
})

test('extractText + expandQuote: 拼出来的正文是「你后面那句话 + 引用的原话」', async () => {
  const msg = quoteMsg('1001', ' 你这话什么意思')
  assert.equal(extractText(msg), '[引用] 你这话什么意思')
  const out = await expandQuote(msg, {
    fetchMsg: async () => ({ message: [{ type: 'text', data: { text: '外卖比我还重要？' } }], sender: { nickname: 'Never' } }),
  })
  const filled = extractText(msg).replace('[引用]', out)
  assert.equal(filled, '[引用 Never]: 外卖比我还重要？ 你这话什么意思')
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

test('segmentText: 没有任何标点的长句不硬切（一句完整的话不该被腰斩）', () => {
  const long = '这'.repeat(80)
  const parts = segmentText(long, SEG)
  // 2026-10-27 统一规则后：切分只认语意，不认字数。
  // 长度硬上限交给 splitLongText(maxCharsPerMessage)。
  assert.deepEqual(parts, [long])
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

/* ── 只有一道边界：25 字（60 字合并那条 2026-10-25 取消）── */

test('segmentText: 只看语意，不看总字数（25 字也一样按停顿切）', () => {
  const text = '啊'.repeat(25)
  const parts = segmentText(text, SEG)
  // 全是语气词「啊」→ 每一处都是停顿点，切成多条是符合新规则的。
  // 旧规则里「<=25 字整条发」那道闸门 2026-10-27 已经拆掉了。
  assert.ok(parts.length >= 2, JSON.stringify(parts))
  assert.equal(parts.join(''), text)
})

test('segmentText: 同样只看停顿，不看是不是 26 字', () => {
  const text = '啊'.repeat(26)
  const parts = segmentText(text, SEG)
  assert.ok(parts.length >= 2, JSON.stringify(parts))
  assert.equal(parts.join(''), text)
})

test('segmentText: 60 字不再合并成一条', () => {
  const text = '啊'.repeat(60)
  const parts = segmentText(text, SEG)
  assert.ok(parts.length >= 2, JSON.stringify(parts))
  assert.equal(parts.join(''), text)
})

test('segmentText: 只有逗号也能分条（不用句号同样切得开）', () => {
  const text = '我先去洗个澡，回来再跟你说这个事，你先别急着跑去睡觉啊'
  const parts = segmentText(text, SEG)
  assert.ok(parts.length >= 2, JSON.stringify(parts))
  assert.equal(parts.join(''), text)
})

test('segmentText: 一个标点都没有时按语气词/连词切', () => {
  const text = '我今天真的特别想你可是一直都没有等到你发来的任何一条消息'
  const parts = segmentText(text, SEG)
  assert.ok(parts.length >= 2, JSON.stringify(parts))
  assert.equal(parts.join(''), text)
})

/* ── 结尾不留句号 ── */

test('stripTrailingPeriod: 抹句号，放过问号 / 叹号 / 省略号', () => {
  assert.equal(stripTrailingPeriod('你真行。'), '你真行')
  assert.equal(stripTrailingPeriod('你真行。。'), '你真行')
  assert.equal(stripTrailingPeriod('你真行？'), '你真行？')
  assert.equal(stripTrailingPeriod('你真行！'), '你真行！')
  assert.equal(stripTrailingPeriod('我等你很久了……'), '我等你很久了……')
  assert.equal(stripTrailingPeriod('我等你很久了~'), '我等你很久了~')
  assert.equal(stripTrailingPeriod('ok.'), 'ok')
  assert.equal(stripTrailingPeriod('wait...'), 'wait...')
  assert.equal(stripTrailingPeriod(''), '')
})

test('segmentText + stripTrailingPeriod: 拼回后每条都不带句号', () => {
  const text = '今天真的好累啊。你都不会问我一句的吗？我等你很久了诶。'
  const parts = segmentText(text, SEG)
  const sent = parts.map((p) => stripTrailingPeriod(p))
  assert.ok(sent.length >= 2, JSON.stringify(sent))
  for (const s of sent) assert.ok(!s.endsWith('。'), JSON.stringify(sent))
})

/* ── 正事整条发（2026-10-25 晚上加的通道）── */

test('takeMergeMarker: 认标记并剥掉', () => {
  assert.deepEqual(takeMergeMarker('[[整条]]看这个参数'), { merge: true, text: '看这个参数' })
  assert.deepEqual(takeMergeMarker('  [[merge]] 改好了'), { merge: true, text: '改好了' })
  assert.deepEqual(takeMergeMarker('[[整条]]'), { merge: true, text: '' })
})

test('takeMergeMarker: 没有标记原样返回', () => {
  assert.deepEqual(takeMergeMarker('外卖比我还重要？'), { merge: false, text: '外卖比我还重要？' })
  assert.deepEqual(takeMergeMarker(''), { merge: false, text: '' })
})

test('looksLikeWork: 代码块 / 列表 / 表格 / 命令行都算正事', () => {
  assert.equal(looksLikeWork('改这里\n```js\nconst a = 1\n```'), true)
  assert.equal(looksLikeWork('- 第一项\n- 第二项\n- 第三项'), true)
  assert.equal(looksLikeWork('| 参数 | 值 |\n|---|---|\n| a | 1 |'), true)
  assert.equal(looksLikeWork('$ npm install\n$ npm run build'), true)
})

test('looksLikeWork: 闲聊不算正事', () => {
  assert.equal(looksLikeWork('外卖比我还重要？'), false)
  assert.equal(looksLikeWork('今天真的好累啊\n你都不会问我一句的吗'), false)
  assert.equal(looksLikeWork('嗯'), false)
  assert.equal(looksLikeWork(''), false)
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
