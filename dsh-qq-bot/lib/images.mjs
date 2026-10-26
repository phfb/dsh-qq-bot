/**
 * 入站图片相关的**纯函数**区：解析、识别尺寸、缓存淘汰策略、索引渲染。
 *
 * 这一层不碰 IO、不碰网络、不碰 ctx —— 和 policy.mjs 一样可以脱离 DSH 单跑测试：
 *   node --test dsh-qq-bot\test\images.test.mjs
 *
 * 真正的下载、存盘、写索引在 image-store.js。
 */

/* ── 文件头 → 宽高 ─────────────────────────────────────────────────────── */

/**
 * 从图片字节流里读出宽高。只认 QQ 上常见的四种：PNG / JPEG / GIF / WebP。
 * 读不出来就返回 0，调用方按"尺寸未知"处理，不影响其它流程。
 *
 * 为什么自己解析：这个插件零依赖（profile 里没有 sharp / image-size），
 * 而尺寸是给人看索引用的，不值得为它引一个原生模块。
 *
 * @param {Buffer|Uint8Array} buf
 * @returns {{width:number, height:number, format:string}}
 */
export function imageSize(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf ?? [])
  const none = { width: 0, height: 0, format: '' }
  if (b.length < 12) return none

  // PNG：89 50 4E 47 0D 0A 1A 0A，IHDR 紧跟在 8 字节签名 + 4 字节长度 + 4 字节类型 之后
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    if (b.length < 24) return { ...none, format: 'png' }
    const width = readUInt32BE(b, 16)
    const height = readUInt32BE(b, 20)
    return { width, height, format: 'png' }
  }

  // GIF：47 49 46 38，宽高是 6..10 的小端 uint16
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    const width = b[6] | (b[7] << 8)
    const height = b[8] | (b[9] << 8)
    return { width, height, format: 'gif' }
  }

  // WebP：RIFF....WEBP，然后 VP8 / VP8L / VP8X 三种变体
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    if (b.length < 30) return { ...none, format: 'webp' }
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15])
    if (chunk === 'VP8X') {
      // 24 位宽高，各减 1
      const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16))
      const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16))
      return { width: w, height: h, format: 'webp' }
    }
    if (chunk === 'VP8 ') {
      // 有损：帧头 3 字节 + 起始码 9D 01 2A，然后 14 位宽、14 位高
      const w = (b[26] | (b[27] << 8)) & 0x3fff
      const h = (b[28] | (b[29] << 8)) & 0x3fff
      return { width: w, height: h, format: 'webp' }
    }
    if (chunk === 'VP8L') {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
      const w = 1 + ((bits >> 0) & 0x3fff)
      const h = 1 + ((bits >> 14) & 0x3fff)
      return { width: w, height: h, format: 'webp' }
    }
    return { ...none, format: 'webp' }
  }

  // JPEG：FF D8，然后逐个扫段找 SOFn（C0-C3 / C5-C7 / C9-CB / CD-CF）
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i += 1; continue }
      const marker = b[i + 1]
      // 填充字节
      if (marker === 0xff) { i += 1; continue }
      // 无载荷的段
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2
        continue
      }
      const segLen = (b[i + 2] << 8) | b[i + 3]
      const isSof = marker >= 0xc0 && marker <= 0xcf &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof) {
        const height = (b[i + 5] << 8) | b[i + 6]
        const width = (b[i + 7] << 8) | b[i + 8]
        return { width, height, format: 'jpeg' }
      }
      if (segLen < 2) break
      i += 2 + segLen
    }
    return { ...none, format: 'jpeg' }
  }

  return none
}

function readUInt32BE(b, offset) {
  return ((b[offset] << 24) >>> 0) + (b[offset + 1] << 16) + (b[offset + 2] << 8) + b[offset + 3]
}

/* ── OneBot 消息 → 图片段 ──────────────────────────────────────────────── */

/**
 * 从 OneBot v11 的 `message` 里挑出图片。
 * 两种形态都认：array（SnowLuma 用的就是这个）和 CQ 码字符串。
 *
 * @param {unknown} message
 * @returns {Array<{url:string, file:string, fileName:string, summary:string}>}
 */
export function parseImageSegments(message, { includeEmotes = true } = {}) {
  const out = []

  if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg === null || typeof seg !== 'object') continue
      const type = String(seg.type ?? '')
      const data = seg.data ?? {}
      if (type === 'image') {
        out.push({
          url: str(data.url),
          file: str(data.file),
          fileName: str(data.file_name ?? data.file),
          summary: str(data.summary),
          kind: 'image',
        })
      } else if (includeEmotes && type === 'mface') {
        // 带 url 的 mface 是真正的图片字节（商城大表情 / 动图表情），能存能看；
        // 只有 emoji_id 的老式 mface 仍然走文本占位
        const emoteUrl = str(data.url)
        if (/^https?:\/\//i.test(emoteUrl)) {
          out.push({
            url: emoteUrl,
            file: str(data.file),
            fileName: `mface-${str(data.emoji_id) || 'unknown'}.gif`,
            summary: str(data.summary),
            kind: 'mface',
          })
        }
      }
    }
    return out
  }

  if (typeof message === 'string') {
    // [CQ:image,file=xxx.jpg,url=http://...,subType=0] / [CQ:mface,...]
    const re = /\[CQ:(image|mface),([^\]]*)\]/g
    let m
    while ((m = re.exec(message)) !== null) {
      const kind = m[1]
      if (kind === 'mface' && !includeEmotes) continue
      const params = parseCqParams(m[2])
      out.push({
        url: str(params.url),
        file: str(params.file),
        fileName: str(params.file),
        summary: str(params.summary),
        kind,
      })
    }
  }

  return out
}

/* ── QQ 小黄脸（face 段）：没有图片，只有一个 id ───────────────────────── */

/**
 * QQ 经典表情 id → 中文名。
 *
 * `face` 段和 image / mface 不一样：它**没有图片字节**，只是腾讯内置表情集里的一个编号，
 * 客户端按编号画。所以它永远"看不了图"，能做的只是把编号翻成人话 ——
 * 以前一律写「[表情]」，等于把"他发了个捂脸"和"他发了个炸弹"抹成同一个东西。
 */
export const QQ_FACE_NAMES = Object.freeze({
  0: '惊讶', 1: '撇嘴', 2: '色', 3: '发呆', 4: '得意', 5: '流泪', 6: '害羞', 7: '闭嘴',
  8: '睡', 9: '大哭', 10: '尴尬', 11: '发怒', 12: '调皮', 13: '呲牙', 14: '微笑', 15: '难过',
  16: '酷', 17: '抓狂', 18: '吐', 19: '偷笑', 20: '可爱', 21: '白眼', 22: '傲慢', 23: '饥饿',
  24: '困', 25: '惊恐', 26: '流汗', 27: '憨笑', 28: '悠闲', 29: '奋斗', 30: '咒骂', 31: '疑问',
  32: '嘘', 33: '晕', 34: '折磨', 35: '衰', 36: '骷髅', 37: '敲打', 38: '再见', 39: '擦汗',
  40: '抠鼻', 41: '鼓掌', 42: '糗大了', 43: '坏笑', 44: '左哼哼', 45: '右哼哼', 46: '哈欠',
  47: '鄙视', 48: '委屈', 49: '快哭了', 50: '阴险', 51: '亲亲', 52: '吓', 53: '可怜',
  54: '菜刀', 55: '西瓜', 56: '啤酒', 57: '篮球', 58: '乒乓', 59: '咖啡', 60: '饭', 61: '猪头',
  62: '玫瑰', 63: '凋谢', 64: '示爱', 65: '爱心', 66: '心碎', 67: '蛋糕', 68: '闪电', 69: '炸弹',
  70: '刀', 71: '足球', 72: '瓢虫', 73: '便便', 74: '月亮', 75: '太阳', 76: '礼物', 77: '拥抱',
  78: '强', 79: '弱', 80: '握手', 81: '胜利', 82: '抱拳', 83: '勾引', 84: '拳头', 85: '差劲',
  86: '爱你', 87: 'NO', 88: 'OK', 89: '爱情', 90: '飞吻', 91: '跳跳', 92: '发抖', 93: '怄火',
  94: '转圈', 95: '磕头', 96: '回头', 97: '跳绳', 98: '挥手', 99: '激动', 100: '街舞',
  101: '献吻', 102: '左太极', 103: '右太极', 104: '开心', 105: '花痴', 106: '倒立', 107: '忧桑',
  108: '面瘫', 109: '摸头', 110: '怒骂', 111: '打脸', 112: '大笑', 113: '喷血', 114: '偷看',
  115: '狂笑', 116: '傻笑', 117: '嘿嘿', 118: '哼哼', 119: '赞', 120: '踩',
})

/**
 * 把一个 face id 翻成人话。认不出来就 `[表情#123]` ——
 * 至少把编号带给模型，比一个光秃秃的「[表情]」有用。
 */
export function faceLabel(rawId) {
  const id = String(rawId ?? '').trim()
  if (id === '') return '[表情]'
  const name = QQ_FACE_NAMES[Number(id)]
  return name ? `[表情:${name}]` : `[表情#${id}]`
}

/* ── 文件 / 语音 / 视频：把信息捞出来，别丢成光秃秃的占位 ─────────────── */

/**
 * 把一条 OneBot 消息里的各类非文本资源分类抽出来。
 *
 * 为什么要分类：文本里那些「[图片]」「[语音]」「[文件:x.zip]」占位，
 * 对模型来说等于什么都没说。这里把能拿到的 url / 名字 / 大小全捞出来，
 * 上层再决定哪些真能下载、哪些只能老实说"我这边打不开"。
 *
 * @param {unknown} message
 * @param {{includeEmotes?:boolean}} [opts]
 */
export function parseRichSegments(message, { includeEmotes = true } = {}) {
  const images = parseImageSegments(message, { includeEmotes })
  const files = []
  const voices = []
  const videos = []

  const push = (list, type, data) => {
    list.push({
      kind: type,
      url: str(data.url),
      file: str(data.file),
      name: str(data.name ?? data.file_name ?? data.file),
      bytes: Number(data.file_size ?? data.fileSize ?? 0) || 0,
    })
  }

  if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg === null || typeof seg !== 'object') continue
      const type = String(seg.type ?? '')
      const data = seg.data ?? {}
      if (type === 'file') push(files, 'file', data)
      else if (type === 'record') push(voices, 'record', data)
      else if (type === 'video') push(videos, 'video', data)
    }
  } else if (typeof message === 'string') {
    for (const type of ['file', 'record', 'video']) {
      const re = new RegExp(`\\[CQ:${type},([^\\]]*)\\]`, 'g')
      let m
      while ((m = re.exec(message)) !== null) {
        const params = parseCqParams(m[1])
        push(type === 'file' ? files : type === 'record' ? voices : videos, type, params)
      }
    }
  }

  return { images, files, voices, videos }
}

/** 解析 CQ 码里 `k=v,k=v` 的部分（值里可能有转义的 &#44; 之类，这里只做基础反转义）。 */
function parseCqParams(raw) {
  const out = {}
  for (const pair of String(raw ?? '').split(',')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const key = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1)
      .replace(/&#44;/g, ',')
      .replace(/&#91;/g, '[')
      .replace(/&#93;/g, ']')
      .replace(/&amp;/g, '&')
    out[key] = value
  }
  return out
}

function str(v) {
  return typeof v === 'string' ? v : (v === undefined || v === null ? '' : String(v))
}

/**
 * 挑一个能直接 GET 的地址。
 * SnowLuma 一般会给 `url`；没有 url 的时候，`file` 有时本身就是一个 http 链接。
 * 两个都没有就返回空串 —— 调用方据此跳过这张图（宁可不存，也不存个坏文件）。
 */
export function pickImageUrl(seg) {
  const url = str(seg?.url).trim()
  if (/^https?:\/\//i.test(url)) return url
  const file = str(seg?.file).trim()
  if (/^https?:\/\//i.test(file)) return file
  return ''
}

/**
 * 猜扩展名。优先看 mediaType，其次看 URL / 文件名尾巴，最后按 PNG 兜底。
 * @returns {string} 不含点，小写
 */
export function guessImageExt({ mediaType, url, fileName } = {}) {
  const mt = str(mediaType).toLowerCase()
  if (mt.includes('jpeg') || mt.includes('jpg')) return 'jpg'
  if (mt.includes('png')) return 'png'
  if (mt.includes('gif')) return 'gif'
  if (mt.includes('webp')) return 'webp'
  if (mt.includes('bmp')) return 'bmp'

  for (const candidate of [str(url), str(fileName)]) {
    if (candidate === '') continue
    const m = candidate.toLowerCase().match(/\.(jpe?g|png|gif|webp|bmp)(?:\?|#|$)/)
    if (m) return m[1] === 'jpeg' ? 'jpg' : m[1]
  }
  return 'png'
}

/* ── 文件名 / 时间 ─────────────────────────────────────────────────────── */

const pad = (n) => String(n).padStart(2, '0')

/**
 * 把一个时刻拆成索引需要的几种写法。
 * @param {Date|number} when
 */
export function stampParts(when = Date.now()) {
  const d = when instanceof Date ? when : new Date(when)
  const y = d.getFullYear()
  const mo = pad(d.getMonth() + 1)
  const da = pad(d.getDate())
  const hh = pad(d.getHours())
  const mi = pad(d.getMinutes())
  const ss = pad(d.getSeconds())
  return {
    /** 2026-10-25 */
    date: `${y}-${mo}-${da}`,
    /** 17:30:12 */
    clock: `${hh}:${mi}:${ss}`,
    /** 2026-10-25 17:30:12 */
    full: `${y}-${mo}-${da} ${hh}:${mi}:${ss}`,
    /** 20261025-173012 —— 用在文件名里，按名字排序就等于按时间排序 */
    filePart: `${y}${mo}${da}-${hh}${mi}${ss}`,
  }
}

/**
 * 生成落盘文件名：`20261025-173012-1-a1b2c3d4.png`
 *   时间戳（秒）- 同一秒内的第几张 - 内容 sha256 前 8 位 - 扩展名
 * 哈希进去是为了同一秒连发两张一模一样的图时不会互相覆盖。
 */
export function makeImageFileName(when, seq, hash, ext) {
  const { filePart } = stampParts(when)
  const safeSeq = Math.max(1, Math.floor(Number(seq) || 1))
  const short = str(hash).slice(0, 8) || '00000000'
  const safeExt = (str(ext).replace(/[^a-z0-9]/gi, '') || 'png').toLowerCase()
  return `${filePart}-${safeSeq}-${short}.${safeExt}`
}

/** 字节数 → 人看得懂的写法。 */
export function formatBytes(n) {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/* ── 缓存淘汰 ─────────────────────────────────────────────────────────── */

/**
 * 挑出这一轮该删掉的旧图。
 *
 * 规则就是他定的那套：
 *   - 总量没超过上限 → 一张都不删
 *   - 超了 → 从**最老的开始删**，一次删够 purgeBytes（默认 300 MB）就停手，
 *     不会因为超了 1 MB 就把半个图库清空
 *   - 无论如何至少保留 minKeep 张，免得图少的时候一次删光
 *
 * 纯函数：只吃数组、吐数组，删不删由调用方去 unlink。
 *
 * @param {Array<{file:string, bytes:number, at:string, purged?:boolean}>} entries
 * @param {{limitBytes:number, purgeBytes:number, minKeep?:number}} opts
 * @returns {{victims:Array<object>, freedBytes:number, totalBytes:number}}
 */
export function selectForPurge(entries, { limitBytes, purgeBytes, minKeep = 10 }) {
  const alive = (Array.isArray(entries) ? entries : []).filter((e) => e && !e.purged)
  const totalBytes = alive.reduce((sum, e) => sum + (Number(e.bytes) || 0), 0)

  const limit = Number(limitBytes) || 0
  const purge = Math.max(0, Number(purgeBytes) || 0)
  if (limit <= 0 || totalBytes <= limit || purge === 0) {
    return { victims: [], freedBytes: 0, totalBytes }
  }

  // 按时间升序（老的在前）；时间相同就按文件名，保证顺序稳定
  const ordered = [...alive].sort((a, b) => {
    const ta = Date.parse(a.at) || 0
    const tb = Date.parse(b.at) || 0
    if (ta !== tb) return ta - tb
    return String(a.file ?? '').localeCompare(String(b.file ?? ''))
  })

  const keepFloor = Math.max(0, Math.floor(Number(minKeep) || 0))
  const victims = []
  let freedBytes = 0
  for (const entry of ordered) {
    if (freedBytes >= purge) break
    if (ordered.length - victims.length <= keepFloor) break
    victims.push(entry)
    freedBytes += Number(entry.bytes) || 0
  }

  return { victims, freedBytes, totalBytes }
}

/* ── 索引（给人看的 Markdown）──────────────────────────────────────────── */

/** 索引文件开头那段说明。 */
export function indexHeader({ dir = '', limitBytes = 0 } = {}) {
  return [
    '# QQ 图片索引',
    '',
    '她收到的每一张图都记在这里：什么时候发来的、多大、他说了什么、我当时怎么回的。',
    '图片本身按 `时间-序号-哈希.扩展名` 存在同一目录下，**按文件名排序就是按时间排序**。',
    '',
    `- 目录：\`${dir}\``,
    `- 缓存上限：${formatBytes(limitBytes)}（超了自动删最老的，一次删 300 MB 上下）`,
    '- 这张表由插件自动维护，手改会被下一次写入覆盖',
    '',
    '| 时间 | 文件 | 大小 | 尺寸 | 他说了什么 | 我当时怎么回的 |',
    '|---|---|---|---|---|---|',
  ].join('\n')
}

/** 一格 Markdown 表格单元：竖线转义、换行压成空格、过长截断。 */
function cell(value, maxLen = 60) {
  let s = str(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()
  if (s === '') s = '—'
  if (s.length > maxLen) s = `${s.slice(0, maxLen - 1)}…`
  return s
}

/** 一条记录 → 一行表格。 */
export function formatIndexRow(entry) {
  const when = str(entry.at)
  const stamp = when !== '' ? stampParts(new Date(when)).full : '—'
  const size = formatBytes(entry.bytes)
  const dims = entry.width > 0 && entry.height > 0 ? `${entry.width}×${entry.height}` : '—'
  const emoteMark = entry.kind === 'mface' ? ' 🎨表情' : ''
  const file = entry.purged
    ? `~~${str(entry.file)}~~ 🧹${entry.purgedAt ? ` ${stampParts(new Date(entry.purgedAt)).date}` : ''}`
    : `\`${str(entry.file)}\`${emoteMark}`
  return `| ${stamp} | ${file} | ${size} | ${dims} | ${cell(entry.said)} | ${cell(entry.note)} |`
}

/** 整份索引渲染成 Markdown。 */
export function renderIndex(entries, opts = {}) {
  const rows = (Array.isArray(entries) ? entries : [])
    .slice()
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)) // 新的在上面
    .map((e) => formatIndexRow(e))
  const aliveBytes = (entries ?? []).filter((e) => e && !e.purged).reduce((s, e) => s + (Number(e.bytes) || 0), 0)
  const footer = [
    '',
    '---',
    '',
    `共 ${(entries ?? []).length} 条，现存 ${(entries ?? []).filter((e) => e && !e.purged).length} 张 / ${formatBytes(aliveBytes)}`,
    '',
  ].join('\n')
  return `${indexHeader(opts)}\n${rows.join('\n')}\n${footer}`
}

/* ── 给模型的提示 ─────────────────────────────────────────────────────── */

/**
 * 拼出贴进 DSH 会话的那段图片说明。
 *
 * 这是"识图"的关键：模型（deepseek-flash）能读图，但它得**知道有图、图在哪**。
 * 所以这里把绝对路径、尺寸、大小、发来时间都写清楚，并明确点名让它调用 read_image。
 * 路径用绝对路径 —— 会话的 cwd 是 QQ 专用工作区，相对路径不一定对得上。
 *
 * @param {Array<{path:string,width:number,height:number,bytes:number,at:string}>} records
 */
export function describeImages(records) {
  const list = Array.isArray(records) ? records.filter(Boolean) : []
  if (list.length === 0) return ''
  const lines = list.map((r, i) => {
    const dims = r.width > 0 && r.height > 0 ? `${r.width}×${r.height}` : '尺寸未识别'
    const when = r.at ? stampParts(new Date(r.at)).full : ''
    return `${i + 1}. ${r.path}（${dims}，${formatBytes(r.bytes)}${when ? `，发来于 ${when}` : ''}）`
  })
  return [
    `[他发来 ${list.length} 张图片，已存到本地：]`,
    ...lines,
    '[请用 read_image 逐张看清楚再回答；不要装作看过，也不要只根据文件名猜内容。]',
  ].join('\n')
}
