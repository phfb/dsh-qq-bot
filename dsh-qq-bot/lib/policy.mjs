/**
 * 纯函数区：白名单、限流、分段、清洗、OneBot 消息解析。
 *
 * 这一层**不碰 IO、不碰 ctx、不碰网络**，所以可以脱离 DSH 单独跑测试：
 *   node --test dsh-qq-bot\test\policy.test.mjs
 */

import { faceLabel } from './images.mjs'

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
        parts.push(faceLabel(data.id))
        break
      case 'mface':
        // 带 url 的 mface 会被单独下载成图片；这里只留个摘要当锚点，
        // 没有 url 的老式 mface 就只剩这行字了
        parts.push(`[表情:${String(data.summary ?? '大表情')}]`)
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
        // 带上 id：转发里的内容要靠它调 get_forward_msg 才展开得出来，
        // 只写「[合并转发]」等于告诉模型「这儿有一坨东西，但我拿不到」
        parts.push(data.id ? `[合并转发:${String(data.id)}]` : '[合并转发]')
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
 * 按他定的发送规则分段（2026-10-27 统一后的**唯一版本**）。
 *
 * 规则就两条：
 *
 *   工作内容（`[[整条]]` 标记，或自动认出代码块/列表/表格/命令）→ 整条发，不切。
 *   其他一切 → **按语意停顿分条**，多长都切，不设上限。
 *
 * 这里只实现后半条（前半条在 index.js 的 deliverReply 里：`oneShot` 为真就不调这个函数）。
 *
 * ⚠ **不要再加按字数的档位。** 这条规则被他改过三轮：
 *   ① 最初的 AstrBot 三段式："≥60 字合并成一条" → 2026-10-25 他取消
 *   ② 之后变成 "≤shortMax 整条发 / >shortMax 才切" → 跟①的残留打架
 *   ③ 2026-10-27 他拍板："不再设置区间规则"
 * 于是 shortMax / longMin 两个参数**彻底退出逻辑**，只留在配置里不炸老文件。
 * 切分只认语意，不认长度。
 *
 * 切分优先级：换行 > 句末标点（。！？!?…~～） > 逗号类（，、；;：:） > 语气词/连词。
 * 前一级切不动才退到下一级 —— 否则"今天真的好累啊。你都不会问我一句吗？"
 * 会先被中间那个逗号切成碎片。
 *
 * 注意：他的规则里"非必要不用句号收尾"，所以**不能只靠句号切**。
 * 大量回复里根本没有句号，硬停顿只剩换行和问号/叹号/省略号，
 * 再往下必须靠逗号和语气词接住 —— 这就是"按语意停顿"的实际含义。
 *
 * 切完只做一件事：碎段回收（不到 4 个字的小段并进前一段，"嗯"不该单独飞出去）。
 * 那是合并碎片，不是按字数合并段落，不算区间规则。
 *
 * @param {string} text
 * @param {{shortMax?:number, longMin?:number, intervalMs?:number[]}} _cfg 已不参与切分，保留签名兼容调用方
 * @returns {string[]}
 */
export function segmentText(text, cfg) {
  const body = String(text ?? '').trim()
  if (body === '') return []

  /* 规则只剩一条：按语意停顿分条（换行 > 句末标点 > 逗号 > 语气词）。
     2026-10-27 统一：以前这里还有「<= shortMax 整条发」和「贪心合并到 shortMax」
     两道按字数的闸门，跟「> shortMax 就切」互相打架 —— 同一段话按不同入口能得到
     完全不同的分法。现在把字数分档全部拆掉，只看语意。

     长度硬上限仍然有，在 splitLongText(maxCharsPerMessage) 那一层兜。 */
  let pieces = sliceByRegex(body, HARD_BREAK)
  if (pieces.length <= 1) pieces = sliceByRegex(body, SOFT_BREAK)
  if (pieces.length <= 1) pieces = sliceByPauseWord(body)

  // 连标点和语气词都没有 —— 不硬切。一句完整的话不该被腰斩。
  return mergeTiny(pieces)
}

/** 硬停顿：换行 + 句末标点。标点跟着前一段。 */
const HARD_BREAK = /[^。！？!?…~～\n]*[。！？!?…~～\n]+|[^。！？!?…~～\n]+$/g

/** 软停顿：逗号、顿号、分号、冒号 —— 一层语意说完的地方。 */
const SOFT_BREAK = /[^，、；;：:,]*[，、；;：:,]+|[^，、；;：:,]+$/g

/** 一点标点都没有时，还能喘气的地方：语气词和连词后面。 */
const PAUSE_WORD = /(?:啊|呀|呢|吧|哦|喔|诶|欸|嘛|啦|咯|耶|然后|但是|不过|所以|而且|因为|其实|就是|反正|可是|结果)/g

/**
 * 按正则切段，去空白、去空段。
 * @param {string} body
 * @param {RegExp} re
 * @returns {string[]}
 */
function sliceByRegex(body, re) {
  const raw = body.match(re) ?? [body]
  return raw.map((s) => s.trim()).filter((s) => s !== '')
}

/**
 * 无标点时的兜底 1：在最靠近正中间的语气词/连词后面切一刀。
 * 只在两头各留 6 个字以上的余量，避免切出"啊"这种孤立段。
 * @param {string} body
 * @returns {string[]}
 */
function sliceByPauseWord(body) {
  const chars = [...body]
  if (chars.length < 12) return [body]
  const mid = chars.length / 2
  let best = -1
  let bestDist = Infinity
  for (const m of body.matchAll(PAUSE_WORD)) {
    const cut = [...body.slice(0, m.index + m[0].length)].length
    if (cut < 6 || cut > chars.length - 6) continue
    const dist = Math.abs(cut - mid)
    if (dist < bestDist) {
      bestDist = dist
      best = cut
    }
  }
  if (best < 0) return [body]
  return [chars.slice(0, best).join(''), chars.slice(best).join('')]
}

/**
 * 碎段回收：不到 4 个字的一段并进前一段（"嗯"不该自己飞出去）。
 *
 * 这是唯一保留下来的「合并」逻辑 —— 它合并的是**碎片**，不是按字数合并段落，
 * 所以不算区间规则。
 * @param {string[]} pieces
 * @returns {string[]}
 */
function mergeTiny(pieces) {
  /** @type {string[]} */
  const out = []
  for (const piece of pieces) {
    if (out.length > 0 && [...piece].length < 4) {
      out[out.length - 1] += piece
    } else {
      out.push(piece)
    }
  }
  return out
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
 * 去掉结尾的句号 —— "非特殊必要场景，不用句号结束消息"。
 *
 * 只删句号。问号、感叹号、省略号（… 和 ...）、波浪号都是语气，动了就变味了：
 *   「你真行。」→「你真行」
 *   「你真行？」→「你真行？」（不动）
 *   「我等你很久了……」→ 原样（不动）
 *
 * 这条是发给 QQ 之前最后一道，模型爱写不写都拦得住。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripTrailingPeriod(text) {
  let out = String(text ?? '').replace(/\s+$/u, '')
  if (out === '') return out
  // 全角句号：一条尾巴上可能叠了好几个「。。」
  if (out.endsWith('。')) return out.replace(/。+$/u, '').replace(/\s+$/u, '')
  // 半角句点：只动单独一个，英文省略号 "..." 放过去
  if (out.endsWith('.') && !out.endsWith('...')) return out.slice(0, -1).replace(/\s+$/u, '')
  return out
}

/**
 * 显式要求"整条发"的标记。放在回复最开头，发出前会被剥掉，不会出现在 QQ 里。
 *
 * 他 2026-10-25 晚上的原话："规则加一条，换成聊正事/干活的时候可以合成一条消息进行发送，
 * 提高效率"。聊正事、给结论、贴代码参数的时候，分条反而拖时间、还容易看岔。
 * 模型自己判断要不要加，插件只管认标记。
 */
export const MERGE_MARKER = '[[整条]]'

const MERGE_MARKER_RE = /^\s*(?:\[\[整条\]\]|\[\[merge\]\])\s*/i

/**
 * 剥掉开头的"整条"标记。
 * @param {string} text
 * @returns {{merge: boolean, text: string}}
 */
export function takeMergeMarker(text) {
  const body = String(text ?? '')
  const hit = body.match(MERGE_MARKER_RE)
  if (hit === null) return { merge: false, text: body }
  return { merge: true, text: body.slice(hit[0].length) }
}

/**
 * 这段内容像不像"正事" —— 切开必碎的那种。
 *
 * 判据都是格式硬伤，不看语气：
 *   - 代码围栏 ```（切开发出去就是半截代码）
 *   - 三行以上的列表项（-、*、+、1. 开头）
 *   - 两行以上带竖线的表格
 *   - 两行以上以 $ / > / PS / node / npm / python 开头的命令行
 *
 * 命中就整条发，不再按语意停顿切。宁可长一点，也别把清单切成三段。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeWork(text) {
  const body = String(text ?? '')
  if (body === '') return false
  if (body.includes('```')) return true

  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')
  if (lines.length < 2) return false

  const listItems = lines.filter((l) => /^([-*+]\s|\d+[.)]\s)/.test(l)).length
  if (listItems >= 3) return true

  if (lines.filter((l) => l.includes('|')).length >= 2) return true

  const commandLines = lines.filter((l) => /^(\$|>|PS[ >]|node |npm |pnpm |python |python3 |pwsh |powershell |git )/.test(l)).length
  if (commandLines >= 2) return true

  return false
}

/**
 * 是不是"被骂"的那类消息 —— 用来在日志里标记，不影响回复。
 * @param {string} text
 */
export function looksRejected(text) {
  const t = String(text ?? '')
  return /(别|不要|甭).{0,2}(吵|烦|打扰|说|发|刷)|滚|闭嘴|安静|噤声/.test(t)
}
