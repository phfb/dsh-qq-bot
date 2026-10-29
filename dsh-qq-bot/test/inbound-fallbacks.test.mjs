/**
 * 「取不到东西」这几条路的单测（2026-10-30）。
 *
 * 起因是他反馈的三件事：引用看不到内容、发图片看不到图片、转发消息看不到内容。
 * 查下来接口全是通的（日志里 get_msg / get_forward_msg 都成功过），坏的是
 * **取不到之后没人说一句**：
 *   · 图下载失败 → 正文只剩裸的 `[图片]`，她只能回「图没传过来」
 *   · 引用里那张图没取到 → 引文有、图没有，她以为引用里只有字
 *   · 合并转发 → 正文只有一个 id，没人叫她展开，她就当没看见
 *
 * 这个文件就是把这三种「沉默」钉住的：以后谁把它们改回沉默，这里会红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildInboundText } from '../lib/index.js'
import {
  QUOTE_MISSING,
  countForwardSegments,
  countImageSegments,
  normalizeForwardId,
} from '../lib/policy.mjs'
import {
  FORWARD_NODE_MAX_CHARS,
  formatForwardNodes,
  forwardNodeBody,
  forwardNodes,
  forwardSegText,
  renderForward,
} from '../lib/forward.mjs'

/* ── 段计数 ─────────────────────────────────────────────────────────── */

test('countImageSegments: 数图/大表情，不数文字和小黄脸', () => {
  const msg = [
    { type: 'text', data: { text: '看图' } },
    { type: 'image', data: { file: 'a.jpg' } },
    { type: 'mface', data: { url: 'http://x/1.gif' } },
    { type: 'face', data: { id: '14' } },
  ]
  assert.equal(countImageSegments(msg), 2)
  assert.equal(countImageSegments([]), 0)
  assert.equal(countImageSegments('不是数组'), 0)
})

test('countForwardSegments: array 和 CQ 码两种形态都数得出来', () => {
  assert.equal(countForwardSegments([{ type: 'forward', data: { id: 'x' } }]), 1)
  assert.equal(
    countForwardSegments([
      { type: 'forward', data: { id: 'a' } },
      { type: 'text', data: { text: '再看这个' } },
      { type: 'forward', data: { id: 'b' } },
    ]),
    2,
  )
  assert.equal(countForwardSegments('前面 [CQ:forward,id=abc] 后面'), 1)
  assert.equal(countForwardSegments([{ type: 'text', data: { text: '没有' } }]), 0)
  assert.equal(countForwardSegments(null), 0)
})

/* ── 转发 id 剥壳 ───────────────────────────────────────────────────── */

test('normalizeForwardId: 整段占位抄过来也认', () => {
  const raw = 'hyT44utKW+JtYXu3ISmMHCNdjTtuabmGytTCf/cs7uLhIxr2Tv4o/SddYPnFVcfs'
  assert.equal(normalizeForwardId(`[合并转发:${raw}]`), raw)
  assert.equal(normalizeForwardId(`  [合并转发：${raw}]  `), raw)
  assert.equal(normalizeForwardId(raw), raw)
  assert.equal(normalizeForwardId(`"${raw}"`).startsWith('hyT44'), true)
})

test('normalizeForwardId: base64 里的 + / = 一个都不能动', () => {
  const raw = 'abc+def/ghi=='
  assert.equal(normalizeForwardId(`[合并转发:${raw}]`), raw)
})

test('normalizeForwardId: 空的还是空', () => {
  assert.equal(normalizeForwardId(''), '')
  assert.equal(normalizeForwardId('   '), '')
  assert.equal(normalizeForwardId(null), '')
  assert.equal(normalizeForwardId(undefined), '')
})

/* ── 引用：取不到原文要留痕 ──────────────────────────────────────────── */

test('QUOTE_MISSING 必须和原来的「[引用]」长得不一样', () => {
  assert.notEqual(QUOTE_MISSING, '[引用]')
  assert.ok(QUOTE_MISSING.includes('没取到'))
})

/* ── 转发格式化 ─────────────────────────────────────────────────────── */

test('forwardSegText: 图/表情/语音/文件/嵌套转发都留占位，不清零', () => {
  assert.equal(forwardSegText({ type: 'text', data: { text: '在' } }), '在')
  assert.equal(forwardSegText({ type: 'image', data: {} }), '[图片]')
  assert.equal(forwardSegText({ type: 'mface', data: {} }), '[表情]')
  assert.equal(forwardSegText({ type: 'face', data: {} }), '[表情]')
  assert.equal(forwardSegText({ type: 'record', data: {} }), '[语音]')
  assert.equal(forwardSegText({ type: 'video', data: {} }), '[视频]')
  assert.equal(forwardSegText({ type: 'file', data: { name: 'a.pdf' } }), '[文件:a.pdf]')
  assert.equal(forwardSegText({ type: 'at', data: { qq: '3448932873' } }), '@3448932873')
  assert.equal(forwardSegText({ type: 'forward', data: {} }), '[嵌套转发]')
  assert.equal(forwardSegText({ type: 'reply', data: { id: '1' } }), '')
  assert.equal(forwardSegText('纯字符串'), '纯字符串')
})

test('forwardNodeBody: message / content / 字符串三种形态都认', () => {
  assert.equal(forwardNodeBody({ message: [{ type: 'text', data: { text: 'a' } }] }), 'a')
  assert.equal(forwardNodeBody({ content: [{ type: 'text', data: { text: 'b' } }] }), 'b')
  assert.equal(forwardNodeBody({ message: '  c  ' }), 'c')
  assert.equal(forwardNodeBody({}), '')
})

test('forwardNodes: 节点放在 messages / message / data 里都找得到', () => {
  const n = [{ message: [{ type: 'text', data: { text: 'hi' } }] }]
  assert.equal(forwardNodes({ messages: n }).length, 1)
  assert.equal(forwardNodes({ message: n }).length, 1)
  assert.equal(forwardNodes({ data: { messages: n } }).length, 1)
  assert.equal(forwardNodes({}).length, 0)
})

test('formatForwardNodes: 昵称 + 内容，空节点跳过', () => {
  const data = {
    messages: [
      { sender: { nickname: '黄宝雨' }, message: [{ type: 'text', data: { text: '国赛名单出来了' } }] },
      { sender: { card: '组委会' }, message: [{ type: 'image', data: {} }] },
      { sender: { user_id: 42 }, message: [] },
    ],
  }
  assert.deepEqual(formatForwardNodes(data), ['黄宝雨：国赛名单出来了', '组委会：[图片]'])
})

test('formatForwardNodes: 单节截断从 200 提到 600（以前正文字数被砍一半）', () => {
  const long = 'x'.repeat(900)
  const line = formatForwardNodes({ messages: [{ sender: { nickname: 'A' }, message: [{ type: 'text', data: { text: long } }] }] })[0]
  assert.equal(FORWARD_NODE_MAX_CHARS, 600)
  assert.equal(line.length, 'A：'.length + 600 + 1)
  assert.ok(line.endsWith('…'))
  // 短一点的不该被截
  assert.equal(line.includes('…'), true)
})

test('formatForwardNodes: 上限可调，但不许调到比 40 还小', () => {
  const text = 'y'.repeat(100)
  const data = { messages: [{ sender: { nickname: 'A' }, message: [{ type: 'text', data: { text } }] }] }
  assert.ok(formatForwardNodes(data, { maxChars: 0 })[0].length > 40)
  assert.ok(formatForwardNodes(data, { maxChars: 50 })[0].endsWith('…'))
})

test('renderForward: 读不到就说读不到，不返回空串', () => {
  assert.equal(renderForward({}), '（这条转发是空的，或者已经过期读不到了）')
  assert.equal(renderForward({ messages: [] }), '（这条转发是空的，或者已经过期读不到了）')
  assert.ok(renderForward({ messages: [{ sender: { nickname: 'A' }, message: '一句话' }] }).startsWith('A：一句话'))
})

/* ── 正文拼接 ───────────────────────────────────────────────────────── */

const emptyCollected = { images: [], files: [], voices: [], videos: [], skipped: 0 }

test('buildInboundText: 不多传参数时和以前完全一样（回归）', () => {
  assert.equal(buildInboundText('在吗', emptyCollected), '在吗')
  assert.equal(buildInboundText('', emptyCollected), '')
})

test('buildInboundText: 有合并转发就点她用 qq_read_forward', () => {
  const text = buildInboundText('[合并转发:abc]', emptyCollected, { forwards: 1 })
  assert.ok(text.includes('qq_read_forward'), '没叫她展开')
  assert.ok(text.includes('1 条合并转发'))
  // 没转发就一句都不许多
  assert.equal(buildInboundText('在吗', emptyCollected, { forwards: 0 }), '在吗')
})

test('buildInboundText: 图一张都没取到，要明说没收到', () => {
  const text = buildInboundText('[图片]', emptyCollected, { imagesMissing: 2 })
  assert.ok(text.includes('2 张图'))
  assert.ok(text.includes('没收到'))
  assert.ok(text.includes('重发'))
})

test('buildInboundText: 引用里那张图没取到，要跟引文分开说', () => {
  const collected = {
    ...emptyCollected,
    images: [{ file: 'a.jpg', path: 'D:\\x\\a.jpg', width: 10, height: 10, bytes: 100 }],
  }
  const text = buildInboundText('[引用 Never]: [图片]乖', collected, {
    nativeImages: true,
    quotedImagesMissing: 1,
  })
  assert.ok(text.includes('引用的那条里还有 1 张图没取到'))
})

test('buildInboundText: 已经收到图了就不许再说「没取到」（别自相矛盾）', () => {
  const collected = {
    ...emptyCollected,
    images: [{ file: 'a.jpg', path: 'D:\\x\\a.jpg', width: 10, height: 10, bytes: 100 }],
  }
  const text = buildInboundText('[图片]', collected, { nativeImages: true, imagesMissing: 1 })
  assert.equal(text.includes('一张都没取到'), false)
})

test('buildInboundText: 三件事同时来也各说各的', () => {
  const text = buildInboundText('[合并转发:abc]', emptyCollected, { forwards: 1, imagesMissing: 1 })
  assert.ok(text.includes('合并转发'))
  assert.ok(text.includes('1 张图'))
})
