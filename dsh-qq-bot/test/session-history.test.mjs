/**
 * 会话履历模块的测试。
 *
 * 这个模块被换局路径调用，所以测的重点不是「功能全不全」，而是
 * **搞不坏主流程**：坏文件、坏条目、空数据、超上限，全都不许抛。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HISTORY_MAX_PER_UIN,
  bumpMessages,
  closeEntry,
  describeReason,
  emptyHistory,
  hasSession,
  listFor,
  loadHistory,
  normalizeHistory,
  openEntry,
  prune,
  saveHistory,
} from '../lib/session-history.mjs'

const UIN = '123456789'

/* ───────────────────── 规整 / 容错 ───────────────────── */

test('normalizeHistory：垃圾输入一律给空表，不抛', () => {
  for (const junk of [null, undefined, 42, 'x', [], {}, { sessions: null }, { sessions: 1 }]) {
    const out = normalizeHistory(junk)
    assert.equal(out.version, 1)
    assert.deepEqual(out.sessions, {})
  }
})

test('normalizeHistory：坏条目丢掉，好条目留下', () => {
  const out = normalizeHistory({
    sessions: {
      [UIN]: [
        null,
        'x',
        { sessionId: '' },
        { sessionId: '  ' },
        { sessionId: 'session-a', startedAt: '2026-11-01T00:00:00.000Z' },
        { sessionId: 'session-b', endedAt: 123, reason: 5, percentAtEnd: 'x', messages: {} },
      ],
    },
  })
  assert.equal(out.sessions[UIN].length, 2)
  assert.equal(out.sessions[UIN][0].sessionId, 'session-a')
  assert.equal(out.sessions[UIN][1].endedAt, null, '非字符串的 endedAt 要变成 null')
  assert.equal(out.sessions[UIN][1].reason, null)
  assert.equal(out.sessions[UIN][1].percentAtEnd, null)
  assert.equal(out.sessions[UIN][1].messages, null)
})

/* ───────────────────── 记账 ───────────────────── */

test('openEntry：同一局重复打开不新增，只把结束标记清掉', () => {
  const data = emptyHistory()
  openEntry(data, UIN, { sessionId: 'session-a', startedAt: '2026-11-01T00:00:00.000Z' })
  assert.equal(data.sessions[UIN].length, 1)
  assert.equal(data.sessions[UIN][0].endedAt, null)

  closeEntry(data, UIN, { sessionId: 'session-a', reason: 'context', endedAt: '2026-11-02T00:00:00.000Z' })
  assert.equal(data.sessions[UIN][0].endedAt, '2026-11-02T00:00:00.000Z')

  openEntry(data, UIN, { sessionId: 'session-a' })
  assert.equal(data.sessions[UIN].length, 1, '同一 id 不许长出第二条')
  assert.equal(data.sessions[UIN][0].endedAt, null, '切回来之后要显示成活的')
  assert.equal(data.sessions[UIN][0].reason, null)
})

test('closeEntry：表里没有这一局也能补一条（手动开新局走这条）', () => {
  const data = emptyHistory()
  closeEntry(data, UIN, {
    sessionId: 'session-b',
    startedAt: '2026-11-05T04:40:11.357Z',
    reason: 'manual',
    percentAtEnd: 12.4,
    messages: 42,
  })
  const [item] = data.sessions[UIN]
  assert.equal(item.sessionId, 'session-b')
  assert.equal(item.startedAt, '2026-11-05T04:40:11.357Z')
  assert.equal(item.reason, 'manual')
  assert.equal(item.percentAtEnd, 12.4)
  assert.equal(item.messages, 42)
  assert.ok(typeof item.endedAt === 'string' && item.endedAt !== '')
})

test('closeEntry：已经结束的那一局不再改（不许把原因覆盖两次）', () => {
  const data = emptyHistory()
  closeEntry(data, UIN, { sessionId: 'session-c', reason: 'context', endedAt: '2026-11-02T00:00:00.000Z' })
  closeEntry(data, UIN, { sessionId: 'session-c', reason: 'gone', endedAt: '2026-11-03T00:00:00.000Z' })
  assert.equal(data.sessions[UIN].length, 1)
  assert.equal(data.sessions[UIN][0].reason, 'context')
  assert.equal(data.sessions[UIN][0].endedAt, '2026-11-02T00:00:00.000Z')
})

test('closeEntry / openEntry：空 sessionId 直接忽略，不抛', () => {
  const data = emptyHistory()
  closeEntry(data, UIN, { sessionId: '' })
  closeEntry(data, UIN, {})
  closeEntry(data, UIN, null)
  openEntry(data, UIN, { sessionId: '   ' })
  assert.deepEqual(data.sessions, {})
})

test('bumpMessages：只给已存在的条目加，不新建', () => {
  const data = emptyHistory()
  bumpMessages(data, UIN, 'session-x')
  assert.deepEqual(data.sessions, {}, '没有条目时不许凭空造一条')
  openEntry(data, UIN, { sessionId: 'session-x' })
  bumpMessages(data, UIN, 'session-x', 3)
  bumpMessages(data, UIN, 'session-x')
  assert.equal(data.sessions[UIN][0].messages, 4)
})

test('hasSession：认得出「这一局 QQ 用过」', () => {
  const data = emptyHistory()
  openEntry(data, UIN, { sessionId: 'session-y' })
  assert.equal(hasSession(data, UIN, 'session-y'), true)
  assert.equal(hasSession(data, UIN, 'session-z'), false)
  assert.equal(hasSession(data, '999', 'session-y'), false, '别的号的不算')
  assert.equal(hasSession(null, UIN, 'session-y'), false)
})

/* ───────────────────── 排序 / 上限 ───────────────────── */

test('listFor：新的在前', () => {
  const data = emptyHistory()
  closeEntry(data, UIN, { sessionId: 'session-1', endedAt: '2026-11-01T00:00:00.000Z' })
  closeEntry(data, UIN, { sessionId: 'session-2', endedAt: '2026-11-02T00:00:00.000Z' })
  closeEntry(data, UIN, { sessionId: 'session-3', endedAt: '2026-11-03T00:00:00.000Z' })
  assert.deepEqual(listFor(data, UIN).map((i) => i.sessionId), ['session-3', 'session-2', 'session-1'])
  assert.deepEqual(listFor(data, '999'), [])
})

test('prune：超过上限砍最老的，留在表里的永远是最新那批', () => {
  const data = emptyHistory()
  for (let i = 0; i < HISTORY_MAX_PER_UIN + 5; i += 1) {
    openEntry(data, UIN, { sessionId: `session-${i}`, startedAt: new Date(2026, 0, 1, 0, i).toISOString() })
  }
  assert.equal(data.sessions[UIN].length, HISTORY_MAX_PER_UIN)
  assert.equal(data.sessions[UIN][0].sessionId, 'session-5', '最早那 5 条要被砍掉')
  assert.equal(data.sessions[UIN][HISTORY_MAX_PER_UIN - 1].sessionId, `session-${HISTORY_MAX_PER_UIN + 4}`)
})

test('prune：对不存在的号是安全的空操作', () => {
  const data = emptyHistory()
  prune(data, '999')
  prune(null, UIN)
  assert.deepEqual(data.sessions, {})
})

/* ───────────────────── 落盘 ───────────────────── */

test('saveHistory / loadHistory：往返一致，且是原子写（不留 .tmp）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-history-'))
  try {
    const file = join(dir, 'qq-session-history.json')
    const data = emptyHistory()
    openEntry(data, UIN, { sessionId: 'session-a', startedAt: '2026-11-01T00:00:00.000Z' })
    closeEntry(data, UIN, { sessionId: 'session-a', reason: 'context', percentAtEnd: 80.1 })

    assert.equal(saveHistory(file, data), true)
    assert.equal(existsSync(`${file}.tmp`), false, '临时文件必须已经改名，不能留在盘上')

    const back = loadHistory(file)
    assert.equal(back.sessions[UIN].length, 1)
    assert.equal(back.sessions[UIN][0].sessionId, 'session-a')
    assert.equal(back.sessions[UIN][0].reason, 'context')
    assert.equal(back.sessions[UIN][0].percentAtEnd, 80.1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadHistory：文件不在 / JSON 坏了 / 带 BOM，都不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-history-'))
  try {
    const missing = join(dir, 'nope.json')
    assert.deepEqual(loadHistory(missing).sessions, {})

    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{ this is not json', 'utf8')
    assert.deepEqual(loadHistory(broken).sessions, {})

    const bom = join(dir, 'bom.json')
    writeFileSync(bom, `\uFEFF${JSON.stringify({ version: 1, sessions: { [UIN]: [{ sessionId: 'session-bom' }] } })}`, 'utf8')
    assert.equal(loadHistory(bom).sessions[UIN][0].sessionId, 'session-bom', 'BOM 要剥掉')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('saveHistory：目录写不进去时返回 false，不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-history-'))
  try {
    const file = join(dir, 'sub', 'deep', 'qq-session-history.json')
    assert.equal(saveHistory(file, emptyHistory()), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('saveHistory：落盘内容永远是规整过的（脏数据进不去）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-history-'))
  try {
    const file = join(dir, 'h.json')
    saveHistory(file, { version: 9, sessions: { [UIN]: [{ sessionId: 'session-ok' }, { nope: 1 }] } })
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(raw.version, 1, '版本号写回当前版本')
    assert.equal(raw.sessions[UIN].length, 1)
    assert.equal(raw.sessions[UIN][0].sessionId, 'session-ok')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ───────────────────── 文案 ───────────────────── */

test('describeReason：认识的给人话，不认识的原样显示', () => {
  assert.equal(describeReason('manual'), '手动开新局')
  assert.equal(describeReason('context'), '上下文到阈值')
  assert.equal(describeReason('stuck'), '她卡住了')
  assert.equal(describeReason('node-switch'), '节点切换')
  assert.equal(describeReason('gone'), '会话失效')
  assert.equal(describeReason('backfill'), '历史遗留')
  assert.equal(describeReason('weird-reason'), 'weird-reason')
  assert.equal(describeReason(null), '未知')
  assert.equal(describeReason(undefined), '未知')
})
