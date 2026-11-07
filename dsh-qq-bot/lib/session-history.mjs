/**
 * QQ 会话履历 —— 「这个号以前用过哪几局对话」。
 *
 * 为什么要它：换局（手动开新一局 / 上下文超阈值 / 卡住 / 节点切换）之后，
 * 旧的那一局只是从 `qq-session-map.json` 里消失了，会话文件还在磁盘上，
 * 但插件这边再没有任何地方记得它 —— 想切回去就只能靠记忆里那个 id。
 * 这个文件把「谁、哪一局、什么时候开始、什么时候结束、为什么结束」记下来，
 * 面板的下拉框就靠它列。
 *
 * 三条纪律：
 *  1. **永远不抛。** 这个模块被换局路径调用，换局是不能被打断的：
 *     写不进去只少一条履历，不能让聊天卡住。所有导出函数自己兜住异常。
 *  2. **只读历史、不碰主链路。** 它不 import 插件里的任何东西，
 *     也不知道 agent / session 是什么，只认字符串和数字 —— 好测。
 *  3. **原子写。** 先写 .tmp 再改名，写一半断电也不会把整份履历变成坏 JSON。
 *     读的时候解析失败就当空表（履历丢了可以再攒，插件起不来不行）。
 */

import { existsSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'

/** 文件格式版本。以后加字段靠它判断怎么迁移。 */
export const HISTORY_VERSION = 1

/** 每个号最多留几条。一天换几次的话 200 条够翻好几个月。 */
export const HISTORY_MAX_PER_UIN = 200

/**
 * 结束原因 → 人话。面板上直接显示这个。
 * 不认识的 reason 原样显示，别把一条脏数据变成空白。
 */
export const REASON_TEXT = Object.freeze({
  manual: '手动开新局',
  context: '上下文到阈值',
  stuck: '她卡住了',
  'node-switch': '节点切换',
  gone: '会话失效',
  'switch-out': '手动切走',
  backfill: '历史遗留',
})

/** @param {unknown} reason */
export function describeReason(reason) {
  const key = typeof reason === 'string' ? reason : ''
  return REASON_TEXT[key] ?? (key === '' ? '未知' : key)
}

/** 空履历。 */
export function emptyHistory() {
  return { version: HISTORY_VERSION, sessions: {} }
}

/**
 * 把读到的任何东西规整成一份合法履历。
 * 坏条目直接丢掉，**不抛** —— 一条脏数据不该让整个下拉框空掉。
 *
 * @param {unknown} raw
 * @returns {{version:number, sessions:Record<string, object[]>}}
 */
export function normalizeHistory(raw) {
  const out = emptyHistory()
  if (raw === null || typeof raw !== 'object') return out
  const sessions = /** @type {any} */ (raw).sessions
  if (sessions === null || typeof sessions !== 'object') return out
  for (const [uin, list] of Object.entries(sessions)) {
    if (!Array.isArray(list)) continue
    const clean = []
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue
      const sessionId = typeof item.sessionId === 'string' ? item.sessionId.trim() : ''
      if (sessionId === '') continue
      clean.push({
        sessionId,
        startedAt: typeof item.startedAt === 'string' ? item.startedAt : null,
        endedAt: typeof item.endedAt === 'string' ? item.endedAt : null,
        reason: typeof item.reason === 'string' ? item.reason : null,
        percentAtEnd: Number.isFinite(item.percentAtEnd) ? item.percentAtEnd : null,
        messages: Number.isFinite(item.messages) ? item.messages : null,
      })
    }
    if (clean.length > 0) out.sessions[String(uin)] = clean.slice(-HISTORY_MAX_PER_UIN)
  }
  return out
}

/**
 * 读履历。文件不在 / JSON 坏了 / 读不了，一律返回空履历。
 *
 * @param {string} file
 */
export function loadHistory(file) {
  try {
    if (typeof file !== 'string' || file === '' || !existsSync(file)) return emptyHistory()
    const text = readFileSync(file, 'utf8')
    // 别的程序写的 JSON 可能带 BOM（这个坑在 qq-bot 里已经踩过一次，见 index.js 的 readJsonFile）
    const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    return normalizeHistory(JSON.parse(body))
  } catch {
    return emptyHistory()
  }
}

/**
 * 落盘。**原子写**：先写 `.tmp` 再 rename。
 * 返回写成功没有；失败只返回 false，不抛。
 *
 * @param {string} file
 * @param {unknown} data
 * @returns {boolean}
 */
export function saveHistory(file, data) {
  const tmp = `${file}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(normalizeHistory(data), null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      // 临时文件删不掉也没关系，下次会被覆盖
    }
    return false
  }
}

/** 某个号的履历（**新的在前**）。没有就返回空数组。 */
export function listFor(data, uin) {
  const list = data?.sessions?.[String(uin)]
  if (!Array.isArray(list)) return []
  return list.slice().reverse()
}

/**
 * 记一笔「这一局开始了」。
 *
 * 同一 sessionId 已经在表里（比如切回来过的）就不重复插，只把 endedAt 清掉
 * —— 那一局是活的，不该显示成「已结束」。
 *
 * @param {object} data
 * @param {string} uin
 * @param {{sessionId?: string, startedAt?: string|null, reason?: string|null}} entry
 */
export function openEntry(data, uin, entry) {
  const sessionId = typeof entry?.sessionId === 'string' ? entry.sessionId.trim() : ''
  if (sessionId === '') return data
  const key = String(uin)
  if (!data.sessions[key]) data.sessions[key] = []
  const list = data.sessions[key]
  const found = list.find((item) => item.sessionId === sessionId)
  if (found) {
    found.endedAt = null
    found.reason = null
    found.percentAtEnd = null
  } else {
    list.push({
      sessionId,
      startedAt: typeof entry.startedAt === 'string' ? entry.startedAt : new Date().toISOString(),
      endedAt: null,
      reason: null,
      percentAtEnd: null,
      messages: null,
    })
  }
  prune(data, key)
  return data
}

/**
 * 记一笔「这一局结束了」。
 *
 * 三种情况：
 *  - 表里已经有这一局、还没结束 → 补结束时间 / 原因 / 百分比（正常路径）
 *  - 表里没有这一局 → 补一条（startedAt 取手头那个时间，没有就留空）
 *  - 表里已经有并且已结束 → 不改（免得同一个 id 被记两次、把原因覆盖掉）
 *
 * @param {object} data
 * @param {string} uin
 * @param {{sessionId?: string, startedAt?: string|null, endedAt?: string|null,
 *          reason?: string|null, percentAtEnd?: number|null, messages?: number|null}} entry
 */
export function closeEntry(data, uin, entry) {
  const sessionId = typeof entry?.sessionId === 'string' ? entry.sessionId.trim() : ''
  if (sessionId === '') return data
  const key = String(uin)
  if (!data.sessions[key]) data.sessions[key] = []
  const list = data.sessions[key]
  const found = list.find((item) => item.sessionId === sessionId)
  const endedAt = typeof entry?.endedAt === 'string' ? entry.endedAt : new Date().toISOString()

  if (found) {
    if (found.endedAt !== null) return data
    found.endedAt = endedAt
    found.reason = typeof entry?.reason === 'string' ? entry.reason : found.reason
    found.percentAtEnd = Number.isFinite(entry?.percentAtEnd) ? entry.percentAtEnd : found.percentAtEnd
    found.messages = Number.isFinite(entry?.messages) ? entry.messages : found.messages
    if (found.startedAt === null && typeof entry?.startedAt === 'string') found.startedAt = entry.startedAt
    return data
  }

  list.push({
    sessionId,
    startedAt: typeof entry?.startedAt === 'string' ? entry.startedAt : null,
    endedAt,
    reason: typeof entry?.reason === 'string' ? entry.reason : null,
    percentAtEnd: Number.isFinite(entry?.percentAtEnd) ? entry.percentAtEnd : null,
    messages: Number.isFinite(entry?.messages) ? entry.messages : null,
  })
  prune(data, key)
  return data
}

/** 更新某一局的消息条数（出站时顺手加，不新建条目）。 */
export function bumpMessages(data, uin, sessionId, by = 1) {
  const key = String(uin)
  const list = data?.sessions?.[key]
  if (!Array.isArray(list)) return data
  const found = list.find((item) => item.sessionId === sessionId)
  if (!found) return data
  found.messages = (Number.isFinite(found.messages) ? found.messages : 0) + by
  return data
}

/** 表里有没有这个 sessionId 的记录（切换时用来判断「是不是 QQ 用过的」）。 */
export function hasSession(data, uin, sessionId) {
  const list = data?.sessions?.[String(uin)]
  if (!Array.isArray(list)) return false
  return list.some((item) => item.sessionId === sessionId)
}

/** 某个号的履历超过上限就砍最老的。 */
export function prune(data, uin) {
  const key = String(uin)
  const list = data?.sessions?.[key]
  if (!Array.isArray(list)) return data
  if (list.length > HISTORY_MAX_PER_UIN) {
    data.sessions[key] = list.slice(list.length - HISTORY_MAX_PER_UIN)
  }
  return data
}
