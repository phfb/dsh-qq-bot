/**
 * 入站图片的落盘层：下载 → 存本地 → 写索引 → 按上限清缓存。
 *
 * 和 images.mjs 的分工：那边全是纯函数（解析、尺寸、淘汰策略、渲染），
 * 这边只管副作用（fetch、writeFileSync、unlinkSync）。
 *
 * 落盘结构：
 *   <dataDir>/images/
 *     ├── 20261025-173012-1-a1b2c3d4.png   ← 时间-序号-内容哈希.扩展名
 *     ├── 20261025-173012-2-9f8e7d6c.jpg
 *     ├── INDEX.md                          ← 给人看的表（每次变更整体重生成）
 *     └── .index.json                       ← 给程序读的同一份数据
 *
 * 为什么用两套索引：Markdown 给人翻，JSON 给程序改。只解析 Markdown 太脆，
 * 只存 JSON 又没法用眼睛看 —— 两份都由这里同一份内存数据渲染出来，不会打架。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import {
  describeImages,
  formatBytes,
  guessImageExt,
  imageSize,
  makeImageFileName,
  parseRichSegments,
  pickImageUrl,
  renderIndex,
  selectForPurge,
  stampParts,
} from './images.mjs'
import { resolveDshHome, writeDshAttachment } from './attachment.js'

const INDEX_JSON = '.index.json'
const INDEX_MD = 'INDEX.md'

/** 记录里只留这些字段落盘（别把整个 OneBot 事件存进去）。 */
function slim(record) {
  return {
    id: record.id,
    file: record.file,
    bytes: record.bytes,
    width: record.width,
    height: record.height,
    mediaType: record.mediaType,
    kind: record.kind === 'mface' ? 'mface' : 'image',
    at: record.at,
    from: record.from,
    said: record.said,
    note: record.note,
    purged: record.purged === true,
    purgedAt: record.purgedAt ?? null,
  }
}

/**
 * 造一个图片仓库。
 *
 * @param {object} opts
 * @param {string} opts.dir            图片目录（调用方保证是绝对路径）
 * @param {number} opts.limitBytes     缓存上限
 * @param {number} opts.purgeBytes     一次清理掉多少
 * @param {number} [opts.maxBytes]     单张上限，超了不存
 * @param {number} [opts.timeoutMs]    单张下载超时
 * @param {string} [opts.dshHome]      DSH 数据根目录（写原生附件用）。空串 = 不写附件
 * @param {string} [opts.filesDir]     他发来的文件存哪。空 = `<图片目录>/files`
 * @param {(level:string, msg:string)=>void} [opts.log]
 */
export function createImageStore({
  dir,
  limitBytes,
  purgeBytes,
  maxBytes = 20 * 1024 * 1024,
  timeoutMs = 20_000,
  dshHome = resolveDshHome(),
  filesDir = '',
  log = () => {},
}) {
  const root = String(dir ?? '')
  if (root === '') throw new Error('image store 需要一个目录')

  const home = String(dshHome ?? '')
  const fileRoot = String(filesDir ?? '') !== '' ? String(filesDir) : join(root, 'files')

  try {
    mkdirSync(root, { recursive: true })
  } catch (err) {
    log('WARN', `图片目录建不出来（${root}）：${err instanceof Error ? err.message : String(err)}`)
  }

  /** @type {Array<object>} 全部记录，不含已清理的图片文件本身 */
  let entries = loadEntries()

  function jsonPath() {
    return join(root, INDEX_JSON)
  }

  function loadEntries() {
    try {
      const raw = JSON.parse(readFileSync(jsonPath(), 'utf8'))
      if (Array.isArray(raw?.entries)) return raw.entries.filter((e) => e && typeof e === 'object')
    } catch {
      // 第一次跑没有这个文件；坏了就当空的，别把插件带崩
    }
    return []
  }

  /** 内存 → 磁盘（JSON + Markdown 一起写）。 */
  function persist() {
    try {
      writeFileSync(jsonPath(), JSON.stringify({ version: 1, entries }, null, 2), 'utf8')
    } catch (err) {
      log('WARN', `图片索引 json 写失败：${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      writeFileSync(join(root, INDEX_MD), renderIndex(entries, { dir: root, limitBytes }), 'utf8')
    } catch (err) {
      log('WARN', `图片索引 md 写失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /* ── 下载 ───────────────────────────────────────────────────────────── */

  async function download(url) {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'dsh-qq-bot/image-fetch' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const declared = Number(res.headers.get('content-length') ?? 0)
    if (declared > maxBytes) throw new Error(`太大 ${formatBytes(declared)}（上限 ${formatBytes(maxBytes)}）`)

    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0) throw new Error('下载到 0 字节')
    if (buf.length > maxBytes) throw new Error(`太大 ${formatBytes(buf.length)}（上限 ${formatBytes(maxBytes)}）`)

    return { buf, mediaType: String(res.headers.get('content-type') ?? '') }
  }

  /* ── 存一张 ────────────────────────────────────────────────────────── */

  /**
   * @param {{url:string, file:string, fileName:string}} seg
   * @param {{uin:string, said:string, at:number, seq:number}} ctx
   * @returns {Promise<object|null>}
   */
  async function saveOne(seg, { uin, said, at, seq }) {
    const url = pickImageUrl(seg)
    if (url === '') {
      log('INFO', `图片没有可下载的 url，跳过（file=${seg?.file ?? ''}）`)
      return null
    }

    let got
    try {
      got = await download(url)
    } catch (err) {
      log('WARN', `图片下载失败：${err instanceof Error ? err.message : String(err)}`)
      return null
    }

    const { buf, mediaType } = got
    const hash = createHash('sha256').update(buf).digest('hex')
    const size = imageSize(buf)
    const ext = size.format === 'jpeg' ? 'jpg' : (size.format || guessImageExt({ mediaType, url, fileName: seg?.fileName }))
    const when = new Date(at)
    let file = makeImageFileName(when, seq, hash, ext)

    // 同一秒、同一序号撞名（理论上极少）——加个后缀，别覆盖别人的图
    let guard = 0
    while (existsSync(join(root, file)) && guard < 50) {
      guard += 1
      file = `${stampParts(when).filePart}-${seq}-${hash.slice(0, 8)}-${guard}.${ext}`
    }

    const path = join(root, file)
    try {
      writeFileSync(path, buf)
    } catch (err) {
      log('WARN', `图片写盘失败：${err instanceof Error ? err.message : String(err)}`)
      return null
    }

    // 同一份字节同时写进 DSH 的附件库 —— 这是「原生识图」的关键：
    // 有了 attachmentId，就能直接塞进 user message 的 content 数组，模型不用调工具就看得见。
    // 写不进去（拿不到 DSH_HOME / 目录只读）不算失败，退回「给路径 + read_image」那条老路。
    const att = writeDshAttachment(buf, {
      mediaType: mediaType || `image/${ext}`,
      width: size.width,
      height: size.height,
      name: file,
    }, dshHome)
    if (att.block === null && att.error !== '') {
      log('WARN', `原生附件没写成（${att.error}），这张退回 read_image 方式`)
    }

    const record = slim({
      id: `${hash.slice(0, 12)}-${at}-${seq}`,
      file,
      path,
      bytes: buf.length,
      width: size.width,
      height: size.height,
      mediaType: mediaType || `image/${ext}`,
      kind: seg?.kind === 'mface' ? 'mface' : 'image',
      at: when.toISOString(),
      from: String(uin ?? ''),
      said: String(said ?? ''),
      note: '',
      purged: false,
      purgedAt: null,
    })
    // path 是运行时算出来的，不落盘（换台机器目录就不同了）
    delete record.path

    entries.push(record)
    persist()
    const kindTag = seg?.kind === 'mface' ? '表情' : '图'
    const nativeTag = att.block !== null ? '，已挂附件' : ''
    log('INFO', `存${kindTag} ${file}（${formatBytes(buf.length)}${size.width > 0 ? `，${size.width}×${size.height}` : ''}${nativeTag}）`)
    return { ...record, path, block: att.block }
  }

  /* ── 文件：他发的 zip / pdf / docx 之类 ────────────────────────────── */

  async function saveFileOne(seg, { uin, at, seq }) {
    const url = pickImageUrl(seg)
    if (url === '') {
      log('INFO', `文件没有可下载的 url，跳过（${seg?.name ?? '未命名'}）`)
      return null
    }
    let got
    try {
      got = await download(url)
    } catch (err) {
      log('WARN', `文件下载失败（${seg?.name ?? ''}）：${err instanceof Error ? err.message : String(err)}`)
      return null
    }

    const hash = createHash('sha256').update(got.buf).digest('hex')
    const rawName = String(seg?.name ?? '').trim() || `${hash.slice(0, 8)}.bin`
    const safeName = basename(rawName).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120) || 'file.bin'
    const file = `${stampParts(new Date(at)).filePart}-${seq}-${hash.slice(0, 8)}-${safeName}`

    try {
      mkdirSync(filesDir, { recursive: true })
      writeFileSync(join(filesDir, file), got.buf)
    } catch (err) {
      log('WARN', `文件写盘失败：${err instanceof Error ? err.message : String(err)}`)
      return null
    }

    const path = join(filesDir, file)
    log('INFO', `存文件 ${safeName}（${formatBytes(got.buf.length)}）→ ${path}`)
    return { name: safeName, file, path, bytes: got.buf.length, mediaType: got.mediaType, from: String(uin ?? '') }
  }

  /* ── 对外：一条消息里的所有资源 ────────────────────────────────────── */

  /**
   * 把一条 QQ 消息里的图片 / 表情 / 文件全部收下来。
   *
   * @param {unknown} message OneBot 的 message 字段（array 或 CQ 码）
   * @param {{uin:string, said:string, at?:number}} ctx
   * @returns {Promise<{
   *   images: Array<object>,      // 有 block 的能直接进 content 数组
   *   files: Array<object>,
   *   voices: Array<object>,      // 只报告，不下载（silk 音频模型听不了）
   *   videos: Array<object>,
   *   skipped: number,
   * }>}
   */
  async function collectFromMessage(message, { uin, said, at = Date.now() }) {
    const rich = parseRichSegments(message, { includeEmotes: true })
    const result = { images: [], files: [], voices: rich.voices, videos: rich.videos, skipped: 0 }

    for (let i = 0; i < rich.images.length; i += 1) {
      const record = await saveOne(rich.images[i], { uin, said, at, seq: i + 1 })
      if (record !== null) result.images.push(record)
      else result.skipped += 1
    }
    for (let i = 0; i < rich.files.length; i += 1) {
      const saved = await saveFileOne(rich.files[i], { uin, at, seq: i + 1 })
      if (saved !== null) result.files.push(saved)
      else result.skipped += 1
    }

    if (result.images.length > 0) {
      // 存完就顺手查一次上限 —— 不等下一张图才清，免得一次性堆过头
      try {
        sweep()
      } catch (err) {
        log('WARN', `清理缓存失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return result
  }

  /** 拼"给模型看的图片说明"（没有图就返回空串）。 */
  function describe(records) {
    return describeImages(records)
  }

  /* ── 回填：这一轮我怎么回的 ────────────────────────────────────────── */

  /**
   * 把这一轮回复的前 200 字记到该 uin 最近一条"还没写回应"的图片上。
   * 索引里「我当时怎么回的」那一列就是靠这个填的 —— 不然只有"他发了一张图"，
   * 过一个月根本想不起来那张图是干嘛的。
   *
   * @param {string} uin
   * @param {string} text
   * @returns {boolean} 是否真的写进去了
   */
  function noteReply(uin, text) {
    const body = String(text ?? '').replace(/\s+/g, ' ').trim()
    if (body === '') return false
    const from = String(uin ?? '')
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const e = entries[i]
      if (e.purged) continue
      if (String(e.from ?? '') !== from) continue
      if (String(e.note ?? '') !== '') continue
      e.note = body.slice(0, 200)
      persist()
      return true
    }
    return false
  }

  /* ── 缓存清理 ──────────────────────────────────────────────────────── */

  /** 目录里真实的图片文件（索引文件和 md 不算）。 */
  function listFiles() {
    try {
      return readdirSync(root)
        .filter((n) => n !== INDEX_JSON && n !== INDEX_MD && n.toLowerCase() !== 'readme.md')
        .map((n) => {
          const p = join(root, n)
          try {
            const st = statSync(p)
            return st.isFile() ? { name: n, path: p, bytes: st.size } : null
          } catch {
            return null
          }
        })
        .filter(Boolean)
    } catch {
      return []
    }
  }

  /** 当前占用（按磁盘上的真实文件算，不信任索引里的 bytes）。 */
  function stats() {
    const files = listFiles()
    const bytes = files.reduce((s, f) => s + f.bytes, 0)
    return {
      dir: root,
      count: files.length,
      bytes,
      limitBytes,
      purgeBytes,
      over: bytes > limitBytes,
    }
  }

  /**
   * 超上限就删最老的，一次删 purgeBytes 上下。
   * @returns {{purged:number, freedBytes:number, totalBytes:number}}
   */
  function sweep() {
    const files = listFiles()
    const byName = new Map(files.map((f) => [f.name, f]))

    // 磁盘上有、索引里没有的（手塞进去的、或者索引丢过的）也纳入统计，
    // 否则"清不掉"会变成一个查不出来的悬案
    const known = new Set(entries.map((e) => e.file))
    const orphans = files.filter((f) => !known.has(f.name))

    const candidates = [
      ...entries.filter((e) => !e.purged).map((e) => ({
        file: e.file, bytes: byName.get(e.file)?.bytes ?? (Number(e.bytes) || 0), at: e.at, record: e,
      })),
      ...orphans.map((f) => ({ file: f.name, bytes: f.bytes, at: '', record: null })),
    ]

    const { victims, freedBytes, totalBytes } = selectForPurge(candidates, {
      limitBytes,
      purgeBytes,
      minKeep: 10,
    })
    if (victims.length === 0) return { purged: 0, freedBytes: 0, totalBytes }

    let purged = 0
    let freed = 0
    const now = new Date().toISOString()
    for (const v of victims) {
      const path = join(root, v.file)
      try {
        unlinkSync(path)
        purged += 1
        freed += v.bytes
        if (v.record) {
          v.record.purged = true
          v.record.purgedAt = now
        }
      } catch (err) {
        log('WARN', `删不掉 ${v.file}：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (purged > 0) {
      persist()
      log('INFO', `图片缓存清理：删了 ${purged} 张 / ${formatBytes(freed)}（上限 ${formatBytes(limitBytes)}）`)
    }
    return { purged, freedBytes: freed, totalBytes }
  }

  /** 索引里的全部记录（只读副本，界面/自检用）。 */
  function list() {
    return entries.map((e) => ({ ...e }))
  }

  /** 启动时跑一次：把索引和磁盘对齐、顺手清一次超限的。 */
  function startup() {
    // 索引里有、磁盘上已经没了的（被手动删了）→ 标成已清理，免得表格骗人
    const files = new Set(listFiles().map((f) => f.name))
    let changed = false
    for (const e of entries) {
      if (!e.purged && !files.has(e.file)) {
        e.purged = true
        e.purgedAt = e.purgedAt ?? new Date().toISOString()
        changed = true
      }
    }
    if (changed) persist()
    const result = sweep()
    if (result.purged === 0 && changed) persist()
    return { ...result, ...stats() }
  }

  return {
    dir: root,
    filesDir: fileRoot,
    indexFile: join(root, INDEX_MD),
    jsonFile: jsonPath(),
    /** 一条消息里的图片 / 表情 / 文件全收下来 */
    collectFromMessage,
    /** 旧名字，留着给还在用它的脚本兜底 */
    saveFromMessage: async (message, ctx) => (await collectFromMessage(message, ctx)).images,
    describe,
    noteReply,
    sweep,
    stats,
    list,
    startup,
  }
}
