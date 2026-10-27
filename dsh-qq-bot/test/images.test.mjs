/**
 * images.mjs 的单元测试。全是纯函数，不需要 DSH、不需要网络。
 *
 * 跑法（系统没装 node，用 SnowLuma 自带的）：
 *   node --test dsh-qq-bot\test\images.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  QQ_FACE_NAMES,
  describeImages,
  faceLabel,
  formatBytes,
  formatIndexRow,
  guessImageExt,
  imageSize,
  makeImageFileName,
  parseImageSegments,
  parseRichSegments,
  pickImageUrl,
  renderIndex,
  selectForPurge,
  stampParts,
} from '../lib/images.mjs'
import { guessMimeFromBytes, resolveDshHome, writeDshAttachment } from '../lib/attachment.js'
import { buildInboundText } from '../lib/index.js'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* ── 造字节：只需要文件头正确，后面的内容随便填 ───────────────────────── */

function pngBytes(width, height) {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8) // IHDR 长度
  Buffer.from('IHDR', 'ascii').copy(b, 12)
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

function gifBytes(width, height) {
  const b = Buffer.alloc(20)
  Buffer.from('GIF89a', 'ascii').copy(b, 0)
  b.writeUInt16LE(width, 6)
  b.writeUInt16LE(height, 8)
  return b
}

function jpegBytes(width, height) {
  // FFD8 + APP0 段（长度 16）+ SOF0 段
  const b = Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x00, 0x00, 0x00, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ])
  b.writeUInt16BE(height, 25) // SOF0: 段长(2) 精度(1) 高(2) 宽(2)
  b.writeUInt16BE(width, 27)
  return b
}

/* ── imageSize ─────────────────────────────────────────────────────────── */

test('imageSize: PNG 读得出宽高', () => {
  const r = imageSize(pngBytes(2127, 600))
  assert.equal(r.format, 'png')
  assert.equal(r.width, 2127)
  assert.equal(r.height, 600)
})

test('imageSize: GIF 读得出宽高', () => {
  const r = imageSize(gifBytes(320, 240))
  assert.equal(r.format, 'gif')
  assert.equal(r.width, 320)
  assert.equal(r.height, 240)
})

test('imageSize: JPEG 能跳过 APP0 找到 SOF0', () => {
  const r = imageSize(jpegBytes(800, 450))
  assert.equal(r.format, 'jpeg')
  assert.equal(r.width, 800)
  assert.equal(r.height, 450)
})

test('imageSize: 认不出来的返回 0，不抛错', () => {
  assert.deepEqual(imageSize(Buffer.from('not an image at all')), { width: 0, height: 0, format: '' })
  assert.deepEqual(imageSize(Buffer.alloc(4)), { width: 0, height: 0, format: '' })
})

/* ── parseImageSegments ────────────────────────────────────────────────── */

test('parseImageSegments: array 形态（SnowLuma 用的这种）', () => {
  const msg = [
    { type: 'text', data: { text: '看看这个' } },
    { type: 'image', data: { url: 'https://gchat.qpic.cn/a.jpg', file: 'abc.image', file_size: '1234' } },
    { type: 'image', data: { file: 'def.image' } },
  ]
  const segs = parseImageSegments(msg)
  assert.equal(segs.length, 2)
  assert.equal(segs[0].url, 'https://gchat.qpic.cn/a.jpg')
  assert.equal(segs[0].fileName, 'abc.image')
  assert.equal(segs[1].url, '')
})

test('parseImageSegments: CQ 码字符串形态', () => {
  const msg = '看[图片][CQ:image,file=1.jpg,url=https://x.cn/1.jpg?x=1&amp;y=2]完了'
  const segs = parseImageSegments(msg)
  assert.equal(segs.length, 1)
  assert.equal(segs[0].url, 'https://x.cn/1.jpg?x=1&y=2')
  assert.equal(segs[0].file, '1.jpg')
})

test('parseImageSegments: 没有图片时返回空数组', () => {
  assert.deepEqual(parseImageSegments([{ type: 'text', data: { text: 'hi' } }]), [])
  assert.deepEqual(parseImageSegments('纯文字'), [])
  assert.deepEqual(parseImageSegments(null), [])
})

/* ── pickImageUrl ──────────────────────────────────────────────────────── */

test('pickImageUrl: 优先 url，其次 file 是 http，都没有就空', () => {
  assert.equal(pickImageUrl({ url: 'https://a/1.png', file: 'x' }), 'https://a/1.png')
  assert.equal(pickImageUrl({ url: '', file: 'https://b/2.png' }), 'https://b/2.png')
  assert.equal(pickImageUrl({ url: '', file: 'abc.image' }), '')
  assert.equal(pickImageUrl({}), '')
})

/* ── guessImageExt ─────────────────────────────────────────────────────── */

test('guessImageExt: mediaType / url / 文件名 / 兜底', () => {
  assert.equal(guessImageExt({ mediaType: 'image/jpeg' }), 'jpg')
  assert.equal(guessImageExt({ mediaType: 'image/png' }), 'png')
  assert.equal(guessImageExt({ url: 'https://x/a.GIF?z=1' }), 'gif')
  assert.equal(guessImageExt({ fileName: 'b.webp' }), 'webp')
  assert.equal(guessImageExt({}), 'png')
  assert.equal(guessImageExt({ url: 'https://x/a.jpeg' }), 'jpg')
})

/* ── 文件名 / 时间 ─────────────────────────────────────────────────────── */

test('stampParts: 各字段格式固定', () => {
  const d = new Date(2026, 9, 25, 17, 30, 12) // 本地时区
  const p = stampParts(d)
  assert.equal(p.date, '2026-10-25')
  assert.equal(p.clock, '17:30:12')
  assert.equal(p.full, '2026-10-25 17:30:12')
  assert.equal(p.filePart, '20261025-173012')
})

test('makeImageFileName: 时间-序号-哈希.扩展名', () => {
  const d = new Date(2026, 9, 25, 17, 30, 12)
  assert.equal(makeImageFileName(d, 1, 'a1b2c3d4e5f6', 'png'), '20261025-173012-1-a1b2c3d4.png')
  assert.equal(makeImageFileName(d, 2, 'zzz', 'JPG'), '20261025-173012-2-zzz.jpg')
  // 哈希缺失也不能造出 'undefined'
  assert.equal(makeImageFileName(d, 0, '', ''), '20261025-173012-1-00000000.png')
})

test('formatBytes: B / KB / MB / GB', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(2048 * 1024), '2.0 MB')
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3.00 GB')
  assert.equal(formatBytes(0), '0 B')
})

/* ── selectForPurge（缓存淘汰，最该守住的一块）───────────────────────────── */

const MB = 1024 * 1024

function entry(i, bytes, atOffsetMin) {
  return {
    file: `20261025-00000${i}-${i}-0000000${i}.png`,
    bytes,
    at: new Date(Date.UTC(2026, 9, 25, 0, atOffsetMin, 0)).toISOString(),
  }
}

test('selectForPurge: 没到上限，一张都不删', () => {
  const entries = [entry(1, 100 * MB, 1), entry(2, 100 * MB, 2)]
  const r = selectForPurge(entries, { limitBytes: 512 * MB, purgeBytes: 300 * MB })
  assert.equal(r.victims.length, 0)
  assert.equal(r.totalBytes, 200 * MB)
})

test('selectForPurge: 超上限就删最老的，一次删够 300 MB 就停', () => {
  // 10 张 × 100 MB = 1000 MB，上限 512 MB → 该删 300 MB = 3 张
  const entries = Array.from({ length: 10 }, (_, i) => entry(i + 1, 100 * MB, i))
  const r = selectForPurge(entries, { limitBytes: 512 * MB, purgeBytes: 300 * MB, minKeep: 1 })
  assert.equal(r.victims.length, 3)
  assert.equal(r.freedBytes, 300 * MB)
  // 删的必须是最早的三张
  assert.deepEqual(r.victims.map((v) => v.at).sort(), entries.slice(0, 3).map((e) => e.at).sort())
})

test('selectForPurge: 至少保留 minKeep 张，哪怕还没删够', () => {
  const entries = Array.from({ length: 12 }, (_, i) => entry(i + 1, 100 * MB, i))
  const r = selectForPurge(entries, { limitBytes: 100 * MB, purgeBytes: 6000 * MB, minKeep: 10 })
  assert.equal(r.victims.length, 2) // 12 - 10
})

test('selectForPurge: 已清理的不参与统计', () => {
  const entries = [
    { ...entry(1, 500 * MB, 1), purged: true },
    entry(2, 100 * MB, 2),
  ]
  const r = selectForPurge(entries, { limitBytes: 512 * MB, purgeBytes: 300 * MB })
  assert.equal(r.victims.length, 0)
  assert.equal(r.totalBytes, 100 * MB)
})

test('selectForPurge: purgeBytes=0 或 limit<=0 时不动手', () => {
  const entries = Array.from({ length: 5 }, (_, i) => entry(i + 1, 500 * MB, i))
  assert.equal(selectForPurge(entries, { limitBytes: 512 * MB, purgeBytes: 0 }).victims.length, 0)
  assert.equal(selectForPurge(entries, { limitBytes: 0, purgeBytes: 300 * MB }).victims.length, 0)
})

test('selectForPurge: 全是小图也能正常工作（不会一次删光）', () => {
  const entries = Array.from({ length: 100 }, (_, i) => entry(i + 1, 5 * MB, i))
  const r = selectForPurge(entries, { limitBytes: 512 * MB, purgeBytes: 300 * MB, minKeep: 10 })
  assert.equal(r.totalBytes, 500 * MB)
  assert.equal(r.victims.length, 0) // 500 < 512，不超
})

/* ── 索引渲染 ──────────────────────────────────────────────────────────── */

test('describeImages: 给出绝对路径 + 尺寸 + 明确要求 read_image', () => {
  const text = describeImages([
    { path: 'D:\\DSHBot\\data\\images\\a.png', width: 2127, height: 600, bytes: 139422, at: new Date(2026, 9, 25, 17, 30, 12).toISOString() },
    { path: 'D:\\DSHBot\\data\\images\\b.jpg', width: 0, height: 0, bytes: 2048, at: new Date(2026, 9, 25, 17, 30, 13).toISOString() },
  ])
  assert.match(text, /他发来 2 张图片/)
  assert.match(text, /2127×600/)
  assert.match(text, /尺寸未识别/)
  assert.match(text, /read_image/)
  assert.match(text, /2026-10-25 17:30:12/)
})

test('describeImages: 没有图返回空串', () => {
  assert.equal(describeImages([]), '')
  assert.equal(describeImages(null), '')
})

test('formatIndexRow: 普通行 / 已清理行', () => {
  const base = {
    file: 'a.png', bytes: 139422, width: 2127, height: 600,
    at: new Date(2026, 9, 25, 17, 30, 12).toISOString(),
    said: '爸爸要养不起你了', note: '我看了一眼账单',
  }
  const row = formatIndexRow(base)
  assert.match(row, /2026-10-25 17:30:12/)
  assert.match(row, /136\.2 KB/)
  assert.match(row, /2127×600/)
  assert.match(row, /爸爸要养不起你了/)
  assert.match(row, /`a\.png`/)

  const purged = formatIndexRow({ ...base, purged: true, purgedAt: new Date(2026, 10, 1, 3, 0, 0).toISOString() })
  assert.match(purged, /~~a\.png~~/)
  assert.match(purged, /🧹/)
})

test('formatIndexRow: 竖线和换行不会把表格撑坏', () => {
  const row = formatIndexRow({
    file: 'a.png', bytes: 1, width: 1, height: 1,
    at: new Date(2026, 9, 25, 0, 0, 0).toISOString(),
    said: '第一行\n第二行 | 带竖线', note: '',
  })
  assert.equal(row.split('\n').length, 1)
  assert.ok(row.includes('\\|'))
  assert.match(row, /—/) // 空的"我的回应"占位
})

test('renderIndex: 带表头、倒序、统计脚注', () => {
  const entries = [
    { file: 'old.png', bytes: 100, width: 1, height: 1, at: new Date(2026, 9, 24, 1, 0, 0).toISOString(), said: 'a', note: '' },
    { file: 'new.png', bytes: 200, width: 1, height: 1, at: new Date(2026, 9, 25, 1, 0, 0).toISOString(), said: 'b', note: '' },
  ]
  const md = renderIndex(entries, { dir: 'D:\\x', limitBytes: 2 * 1024 * 1024 })
  assert.match(md, /^# QQ 图片索引/)
  assert.match(md, /\| 时间 \| 文件 \|/)
  assert.ok(md.indexOf('new.png') < md.indexOf('old.png'), '新的应该在上面')
  assert.match(md, /共 2 条，现存 2 张/)
})

/* ══ 2026-10-25 晚上加的：表情 / 文件 / 语音 / 原生附件 ═══════════════════ */

/* ── 小黄脸（face 段）────────────────────────────────────────────────── */

test('faceLabel: 认得出的翻中文，认不出的带编号', () => {
  assert.equal(faceLabel(0), '[表情:惊讶]')
  assert.equal(faceLabel('41'), '[表情:鼓掌]')
  assert.equal(faceLabel(13), '[表情:呲牙]')
  assert.equal(faceLabel(9999), '[表情#9999]')  // 认不出也要把编号带给模型
  assert.equal(faceLabel(''), '[表情]')
  assert.equal(faceLabel(null), '[表情]')
})

test('QQ_FACE_NAMES: 表本身就是个像样的映射', () => {
  assert.ok(Object.keys(QQ_FACE_NAMES).length >= 100)
  assert.equal(QQ_FACE_NAMES[14], '微笑')
  assert.equal(QQ_FACE_NAMES[69], '炸弹')
})

/* ── parseRichSegments：图片 / 表情 / 文件 / 语音 / 视频 分类 ──────────── */

test('parseRichSegments: mface 带 url 当成图片收，不带 url 就不收', () => {
  const msg = [
    { type: 'mface', data: { url: 'https://gchat.qpic.cn/e.gif', summary: '[开心]', emoji_id: 'abc' } },
    { type: 'mface', data: { summary: '[旧表情]' } },
  ]
  const r = parseRichSegments(msg)
  assert.equal(r.images.length, 1)
  assert.equal(r.images[0].kind, 'mface')
  assert.equal(r.images[0].fileName, 'mface-abc.gif')
})

test('parseRichSegments: 文件 / 语音 / 视频 各自归位', () => {
  const msg = [
    { type: 'text', data: { text: '给你' } },
    { type: 'file', data: { name: '图纸.pdf', url: 'https://x/a.pdf', file_size: '2048' } },
    { type: 'record', data: { file: 'a.silk', url: 'https://x/a.silk' } },
    { type: 'video', data: { file: 'b.mp4', url: 'https://x/b.mp4' } },
  ]
  const r = parseRichSegments(msg)
  assert.equal(r.files.length, 1)
  assert.equal(r.files[0].name, '图纸.pdf')
  assert.equal(r.files[0].bytes, 2048)
  assert.equal(r.voices.length, 1)
  assert.equal(r.videos.length, 1)
})

test('parseRichSegments: CQ 码字符串里的文件也认', () => {
  const r = parseRichSegments('[CQ:file,file=a.zip,name=a.zip,url=https://x/a.zip]')
  assert.equal(r.files.length, 1)
  assert.equal(r.files[0].url, 'https://x/a.zip')
})

test('parseImageSegments: includeEmotes=false 时把 mface 排除', () => {
  const msg = [{ type: 'mface', data: { url: 'https://x/e.gif' } }]
  assert.equal(parseImageSegments(msg).length, 1)
  assert.equal(parseImageSegments(msg, { includeEmotes: false }).length, 0)
})

/* ── 原生附件 ────────────────────────────────────────────────────────── */

test('resolveDshHome: 只认环境变量，没有就空串', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'D:\\DSH\\dsh-home' }), 'D:\\DSH\\dsh-home')
  assert.equal(resolveDshHome({}), '')
  assert.equal(resolveDshHome(null), '')
})

test('guessMimeFromBytes: 认 png / jpeg / gif / webp', () => {
  assert.equal(guessMimeFromBytes(pngBytes(1, 1)), 'image/png')
  assert.equal(guessMimeFromBytes(jpegBytes(1, 1)), 'image/jpeg')
  assert.equal(guessMimeFromBytes(gifBytes(1, 1)), 'image/gif')
  assert.equal(guessMimeFromBytes(Buffer.from('RIFFxxxxWEBP')), 'image/webp')
})

test('writeDshAttachment: 按 sha256 写进 objects/<前两位>/<完整 sha>', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-att-'))
  try {
    const buf = pngBytes(640, 480)
    const r = writeDshAttachment(buf, { mediaType: 'image/png', width: 640, height: 480, name: 'a.png' }, home)
    const hash = createHash('sha256').update(buf).digest('hex')

    assert.equal(r.error, '')
    assert.equal(r.attachmentId, `sha256:${hash}`)
    assert.equal(r.block.type, 'image')
    assert.equal(r.block.attachment.attachmentId, `sha256:${hash}`)
    assert.equal(r.block.attachment.mediaType, 'image/png')
    assert.equal(r.block.attachment.width, 640)
    assert.equal(r.block.attachment.height, 480)
    assert.equal(r.block.attachment.bytes, buf.length)

    // 落盘位置就是 DSH 自己的那套：objects/<前2位>/<完整 sha>
    const file = join(home, 'attachments', 'v1', 'objects', hash.slice(0, 2), hash)
    assert.deepEqual(readFileSync(file), buf)

    // 同一个字节再写一次：去重，不重复写
    const again = writeDshAttachment(buf, {}, home)
    assert.equal(again.attachmentId, r.attachmentId)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('writeDshAttachment: 没有 DSH_HOME 就返回错误，不抛', () => {
  const r = writeDshAttachment(pngBytes(1, 1), {}, '')
  assert.equal(r.block, null)
  assert.match(r.error, /DSH_HOME/)
})

/* ── buildInboundText：拼给模型看的正文 ──────────────────────────────── */

test('buildInboundText: 原生模式下不提 read_image', () => {
  const t = buildInboundText('看图', {
    images: [{ file: 'a.png', path: 'D:\\x\\a.png', width: 100, height: 50, bytes: 2048, kind: 'image', block: { type: 'image' } }],
    files: [], voices: [], videos: [],
  }, { nativeImages: true })
  assert.match(t, /已经贴在这条消息里/)
  assert.match(t, /a\.png/)
  // 原生模式下**不主动要求**调工具，但必须留一句兜底（宿主不认附件时还有救）
  assert.ok(!t.includes('逐张看清楚'), '原生模式不该再命令她去调工具')
  assert.match(t, /如果上面那几张没显示出来/, '失败兜底的那句必须在')
})

test('buildInboundText: 退回路径模式时给绝对路径 + read_image 指令', () => {
  const t = buildInboundText('看图', {
    images: [{ file: 'a.png', path: 'D:\\x\\a.png', width: 100, height: 50, bytes: 2048, kind: 'image', block: null }],
    files: [], voices: [], videos: [],
  }, { nativeImages: false })
  assert.match(t, /D:\\\\x\\\\a\.png|D:\\x\\a\.png/)
  assert.match(t, /read_image/)
})

test('buildInboundText: 文件给路径，语音、视频明说做不到', () => {
  const t = buildInboundText('', {
    images: [],
    files: [{ path: 'D:\\files\\a.pdf', name: 'a.pdf', bytes: 4096 }],
    voices: [{ kind: 'record' }],
    videos: [{ kind: 'video' }],
  })
  assert.match(t, /a\.pdf/)
  assert.match(t, /听不了音频/)
  assert.match(t, /看不了视频/)
  assert.ok(!t.includes('我听懂了'))
})

test('buildInboundText: 什么都没有就只剩原话', () => {
  assert.equal(buildInboundText('在吗', { images: [], files: [], voices: [], videos: [] }), '在吗')
})

/* ── 引用里带图（2026-10-28）──────────────────────────────────────────
   他引一张图问「这个怎么办」：图要真的贴进来，而且要说明白
   「这几张是引用里的」，别跟她刚发的那张混成一堆。 */

test('buildInboundText: 区分「他刚发的」和「他引用那条里的」', () => {
  const block = { type: 'image' }
  const img = (file) => ({ file, path: `D:\\x\\${file}`, width: 10, height: 10, bytes: 100, kind: 'image', block })
  const t = buildInboundText('[引用 Never]: [图片] 这个怎么办', {
    images: [img('now.png'), img('quoted.png')],
    files: [], voices: [], videos: [],
  }, { nativeImages: true, quotedCount: 1 })
  assert.match(t, /2 张图片/)
  assert.match(t, /其中 1 张来自他引用的那条/)
})

test('buildInboundText: 没有引用时还是老说法（别把常走的那条路改了）', () => {
  const img = { file: 'a.png', path: 'D:\\x\\a.png', width: 10, height: 10, bytes: 100, kind: 'image', block: { type: 'image' } }
  const t = buildInboundText('看图', { images: [img], files: [], voices: [], videos: [] }, { nativeImages: true })
  assert.match(t, /他发来 1 张图片/)
  assert.ok(!t.includes('来自他引用的那条'))
})

test('buildInboundText: quotedCount 离谱也不崩（越界就夹住）', () => {
  const img = { file: 'a.png', path: 'D:\\x\\a.png', width: 10, height: 10, bytes: 100, kind: 'image', block: { type: 'image' } }
  const t = buildInboundText('看图', { images: [img], files: [], voices: [], videos: [] }, { nativeImages: true, quotedCount: 99 })
  assert.match(t, /其中 1 张来自他引用的那条/)
})
