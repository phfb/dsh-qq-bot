/**
 * 纯函数区：白名单、限流、分段、清洗、OneBot 消息解析。
 *
 * 这一层**不碰 IO、不碰 ctx、不碰网络**，所以可以脱离 DSH 单独跑测试：
 *   node --test dsh-qq-bot\test\policy.test.mjs
 */

/** 区间随机整数。 */
export function randomIn([a, b]) {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  return lo + Math.floor(Math.random() * (hi - lo + 1))
}

/** 睡一会儿。 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

/**
 * 这个 QQ 号是否在白名单里。
 * @param {string|number} userId
 * @param {string[]} allowUsers
 */
export function isAllowedUser(userId, allowUsers) {
  if (!Array.isArray(allowUsers) || allowUsers.length === 0) return false
  const id = String(userId ?? '').trim()
  if (id === '') return false
  return allowUsers.includes(id)
}

/**
 * 滑动窗口限流。
 * 用时间戳数组实现，条数很少，不需要环形缓冲。
 */
export class RateLimiter {
  /** @param {{windowMs:number, max:number}} opts */
  constructor({ windowMs, max }) {
    this.windowMs = windowMs
    this.max = max
    /** @type {number[]} */
    this.stamps = []
  }

  /** 清掉窗口外的记录。 */
  #prune(now) {
    const floor = now - this.windowMs
    while (this.stamps.length > 0 && this.stamps[0] <= floor) this.stamps.shift()
  }

  /**
   * 试吃一个名额。
   * @param {number} [now]
   * @returns {{allowed: boolean, used: number, max: number, retryAfterMs: number}}
   */
  take(now = Date.now()) {
    this.#prune(now)
    if (this.stamps.length >= this.max) {
      const oldest = this.stamps[0] ?? now
      return {
        allowed: false,
        used: this.stamps.length,
        max: this.max,
        retryAfterMs: Math.max(0, oldest + this.windowMs - now),
      }
    }
    this.stamps.push(now)
    return { allowed: true, used: this.stamps.length, max: this.max, retryAfterMs: 0 }
  }

  /** 还一个名额（比如发送失败时回滚）。 */
  refund() {
    this.stamps.pop()
  }
}

/**
 * 从 OneBot v11 的 message 字段里抽纯文本。
 * message 可能是 array（SnowLuma 配的是 array）也可能是 CQ 码字符串，两种都认。
 * 非文本段转成可读占位，方便模型知道"这里有张图"。
 * @param {unknown} message
 * @returns {string}
 */
export function extractText(message) {
  if (typeof message === 'string') {
    // CQ 码：把 [CQ:image,...] / [CQ:face,...] 换成占位
    return message
      .replace(/\[CQ:image[^\]]*\]/g, '[图片]')
      .replace(/\[CQ:face[^\]]*\]/g, '[表情]')
      .replace(/\[CQ:record[^\]]*\]/g, '[语音]')
      .replace(/\[CQ:video[^\]]*\]/g, '[视频]')
      .replace(/\[CQ:file[^\]]*\]/g, '[文件]')
      .replace(/\[CQ:[a-z_]+[^\]]*\]/gi, '')
      .trim()
  }

  if (!Array.isArray(message)) return ''

  const parts = []
  for (const seg of message) {
    if (seg === null || typeof seg !== 'object') continue
    const type = String(seg.type ?? '')
    const data = seg.data ?? {}
    switch (type) {
      case 'text':
        parts.push(String(data.text ?? ''))
        break
      case 'face':
        parts.push('[表情]')
        break
      case 'mface':
        parts.push(`[表情:${String(data.summary ?? '')}]`)
        break
      case 'image':
        parts.push('[图片]')
        break
      case 'record':
        parts.push('[语音]')
        break
      case 'video':
        parts.push('[视频]')
        break
      case 'file':
        parts.push(`[文件:${String(data.name ?? '')}]`)
        break
      case 'at':
        parts.push(`@${String(data.qq ?? '')}`)
        break
      case 'reply':
        // 引用只记个标记，不展开
        parts.push('[引用]')
        break
      case 'forward':
        parts.push('[合并转发]')
        break
      default:
        // 不认识的消息段直接忽略，别把 JSON 丢给模型
        break
    }
  }
  return parts.join('').trim()
}

/**
 * 去掉 markdown 记号 —— QQ 不渲染这些，留着只会显得很机器。
 * @param {string} text
 * @returns {string}
 */
export function cleanMarkdown(text) {
  return String(text ?? '')
    // 代码围栏 ```lang ... ``` → 保留内容
    .replace(/```[a-zA-Z0-9_+-]*\n?/g, '')
    // 行内代码
    .replace(/`([^`]+)`/g, '$1')
    // 图片 ![alt](url) → alt
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 链接 [text](url) → text url
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 $2')
    // 粗体 / 斜体 / 删除线
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    // 标题
    .replace(/^#{1,6}\s+/gm, '')
    // 分隔线
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    // 连续空行压成一行
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 按 AstrBot 那套规则分段。
 *
 *   <= shortMax          整条
 *   shortMax..longMin    按句末标点切，段间隔由调用方控制
 *   >  longMin           整条（长解释拆开像刷屏）
 *
 * 切分后会做一次"碎段合并"：单独一个"嗯。"不单独成段，并进前一段。
 *
 * @param {string} text
 * @param {{shortMax:number, longMin:number}} cfg
 * @returns {string[]}
 */
export function segmentText(text, cfg) {
  const body = String(text ?? '').trim()
  if (body === '') return []
  const len = [...body].length
  if (len <= cfg.shortMax) return [body]
  if (len > cfg.longMin) return [body]

  // 按 。？！~… 切，标点跟着前一段
  const raw = body.match(/[^。？！~…!?]*[。？！~…!?]+|[^。？！~…!?]+$/g) ?? [body]
  const pieces = raw.map((s) => s.trim()).filter((s) => s !== '')
  if (pieces.length <= 1) return [body]

  /** @type {string[]} */
  const merged = []
  for (const piece of pieces) {
    const prev = merged[merged.length - 1]
    const tooShort = [...piece].length < 4
    // 太碎的段往前并；但如果前一段已经很长了就别并，免得一条变巨长
    if (prev !== undefined && tooShort && [...prev].length + [...piece].length <= cfg.longMin) {
      merged[merged.length - 1] = prev + piece
    } else {
      merged.push(piece)
    }
  }
  return merged
}

/**
 * 超长文本切成 QQ 能接受的大小。
 * @param {string} text
 * @param {number} limit 单条上限（字符数）
 * @returns {string[]}
 */
export function splitLongText(text, limit) {
  const body = String(text ?? '')
  if ([...body].length <= limit) return body === '' ? [] : [body]
  const chars = [...body]
  const out = []
  for (let i = 0; i < chars.length; i += limit) {
    out.push(chars.slice(i, i + limit).join(''))
  }
  return out
}

/**
 * 是不是"被骂"的那类消息 —— 用来在日志里标记，不影响回复。
 * @param {string} text
 */
export function looksRejected(text) {
  const t = String(text ?? '')
  return /(别|不要|甭).{0,2}(吵|烦|打扰|说|发|刷)|滚|闭嘴|安静|噤声/.test(t)
}
