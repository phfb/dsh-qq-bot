/**
 * dsh-qq-bot —— 把 QQ 私聊接到 DSH agent 上的宿主插件。
 *
 * 链路：
 *   QQ → SnowLuma（OneBot v11 WS） → 本插件 → agent.followup()
 *   agent 回复 → session/event(assistant/message) → 本插件 → send_private_msg → QQ
 *
 * 设计约束（都是踩过的）：
 *   - 零依赖：profile 里没有 ws / schemastery / dsh-llm，只用 node:* 内置模块。
 *   - 绝不让插件抛错拖垮宿主：所有 handler 包 try/catch，只 warn。
 *   - QQ 会话是独立的 sessionId + 独立 cwd，出站只认这些会话，
 *     否则你在 DSH GUI 里说的话会被当成回复发到 QQ 上。
 *
 * @module dsh-qq-bot
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, unwatchFile, watchFile, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'

import { buildSocketUrl, parseConfig } from './config.js'
import {
  RateLimiter,
  cleanMarkdown,
  extractText,
  isAllowedUser,
  looksLikeWork,
  looksRejected,
  randomIn,
  segmentText,
  sleep,
  splitLongText,
  stripTrailingPeriod,
  takeMergeMarker,
} from './policy.mjs'
import { OneBotClient, STATE } from './onebot.mjs'
import { createImageStore } from './image-store.js'
import { formatBytes, stampParts } from './images.mjs'
import { socialEventToText } from './notice.mjs'
import { ALLOWED_ACTIONS, checkAction, clampTarget } from './api-allowlist.mjs'
import { checkBudget, emptyBudget, rollDay, takeBudget } from './interact-budget.mjs'
import { isFarewell, shouldStopHere } from './goodnight.mjs'
import { judgeTurnSilence } from './silence.mjs'
import { judgeWatchdog } from './watchdog.mjs'

/** cordis 插件名。 */
export const name = 'dsh-qq-bot'

/** 本插件注册的消息来源标记（真人发言走这个）。 */
export const SOURCE_KIND = 'qq'

/**
 * 插件派活（每日说说 / 说说轮询）用的 source.kind。
 *
 * ⚠️ 2026-10-27 的血：这里原本写的是 `'plugin'`。
 * DSH v4 会话格式**显式拒绝** `kind === 'plugin'`
 * （dsh-session-format-v3-to-v4/lib/index.js:126 → "format v4 message requires a producer-owned source kind"），
 * 于是这条消息一进队列，整个会话的写盘就抛 SessionFormatError，
 * 之后所有消息只进不出 —— 表面上就是「她不回我了」。
 * v3 那边同样不认：v3 的正规写法是 `{kind:'plugin', plugin:'xxx'}`，缺 plugin 字段照样抛。
 *
 * 现在改成自有 kind，和官方范本一致（dsh-schedule 投递用的是 `{kind:'schedule'}`）：
 * 非空、且不是 'plugin'，v3/v4 两道校验都过。
 *
 * 也不能图省事用 'qq' —— 那个在记忆插件的白名单里（默认 `user,qq`），
 * 插件派的活会被当成他亲手打的字记进记忆库。
 */
export const TASK_SOURCE_KIND = 'dsh-qq-bot'

/**
 * 数据目录与日志目录。
 *
 * 刻意**不写死任何绝对路径** —— 这个包是给别人装的，写死作者机器上的路径
 * 会让别人一装就废（而且那种路径本身就是隐私）。
 * 真值在 apply() 里按 config.dataDir 算；留空则落到 `~/.dsh-qq-bot`。
 */
let DATA_DIR = ''
let LOG_DIR = ''
let LOG_FILE = ''

/** 保证目录存在（失败只忽略，不能因此不启动）。 */
function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // 目录建不出来就退化成不写日志
  }
}

/** 写一行日志：文件 + 控制台。文件写失败不影响运行。 */
function writeLog(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}`
  if (LOG_FILE !== '') {
    try {
      appendFileSync(LOG_FILE, `${line}\n`)
    } catch {
      // 磁盘满 / 没权限：放弃文件日志
    }
  }
  if (level === 'ERROR') console.error(`[dsh-qq-bot] ${message}`)
  else if (level === 'WARN') console.warn(`[dsh-qq-bot] ${message}`)
  else console.log(`[dsh-qq-bot] ${message}`)
}

/* ── 配置文件：设置页保存的就是它 ─────────────────────────────────────────
   路径固定为 <DATA_DIR>/config.json，内容是一份扁平化的 config 对象。
   读的时候永远容错（坏了就当没有，退回 cordis 里的出厂值）。 */
/* ── 设置页同源 API 用的小工具 ──────────────────────────────────────────── */

/** 配置页的 API 前缀（浏览器半侧 fetch 它）。 */
const API_PREFIX = '/api/dsh-qq-bot'

function sendJson(res, status, payload) {
  try {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  } catch {
    // 响应已经关掉了就别再抛
  }
}

function readBody(req, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        req.destroy()
        reject(new Error('请求体过大'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

let CONFIG_FILE = ''

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonFile(file, value) {
  try {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** 从配置对象里挑出「设置页能改、且允许落盘」的字段（不落敏感派生值）。 */function pickPersistable(config) {
  return {
    baseUrl: config.baseUrl,
    accessToken: config.accessToken,
    allowUsers: config.allowUsers,
    selfId: config.selfId,
    enabled: config.enabled,
    dryRun: config.dryRun,
    dataDir: config.dataDir,
    workspacePath: config.workspacePath,
    sessionIdPrefix: config.sessionIdPrefix,
    rateLimit: config.rateLimit,
    maxQueue: config.maxQueue,
    segment: config.segment,
    typingDelayMs: config.typingDelayMs,
    cleanMarkdown: config.cleanMarkdown,
    maxCharsPerMessage: config.maxCharsPerMessage,
    rateLimitReply: config.rateLimitReply,
    busyReply: config.busyReply,
    reconnect: config.reconnect,
    contextLimitPercent: config.contextLimitPercent,
    contextWindow: config.contextWindow,
    rolloverNotice: config.rolloverNotice,
    memesDir: config.memesDir,
    commandPrefix: config.commandPrefix,
    memeMinIntervalMin: config.memeMinIntervalMin,
    memeMaxPerHour: config.memeMaxPerHour,
    memeProbability: config.memeProbability,
    // 入站图片（2026-10-25）
    imageEnabled: config.imageEnabled,
    imageDir: config.imageDir,
    imageCacheLimitMB: config.imageCacheLimitMB,
    imageCachePurgeMB: config.imageCachePurgeMB,
    imageMaxMB: config.imageMaxMB,
    imageTimeoutMs: config.imageTimeoutMs,
  }
}

/**
 * 造一条 user 角色消息。
 * 不用 @deepseek-ai/dsh-llm 的 createUserMessage（profile 里没有这个包），
 * 但结构照着它来：{ id, role, content, source }，id 是 uuid 字符串。
 *
 * content 里可以放原生 image block —— 这是模型**不用调工具就直接看得见**的通道
 * （结构是从 DSH 自己落盘的会话记录里挖出来的实证，见 lib/attachment.js 的注释）。
 */
function createQqUserMessage({ text, images = [], uin, messageId, at }) {
  /** @type {Array<object>} */
  const content = []
  for (const img of Array.isArray(images) ? images : []) {
    if (img && img.block) content.push(img.block)
  }
  if (typeof text === 'string' && text !== '') content.push({ type: 'text', text })
  if (content.length === 0) content.push({ type: 'text', text: '（空消息）' })

  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content,
    source: Object.freeze({
      kind: SOURCE_KIND,
      uin: String(uin),
      qqMessageId: messageId ?? null,
      at: at ?? new Date().toISOString(),
    }),
  })
}

/**
 * 造一条「插件派的活」的 user 消息 —— 日记、说说轮询走这条。
 *
 * 和 createQqUserMessage 的区别就是没有 uin：这条不是他发的。
 * source 里只留 kind + reason，别加额外字段 —— 会话格式对 source 的校验
 * 现在只看 kind，但多写的键以后被当成来源元数据解释就麻烦了。
 *
 * @param {{text: string, reason: string, kind: string}} args
 */
function createTaskMessage({ text, reason, kind }) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: Object.freeze({ kind, reason }),
  })
}

/**
 * 把「他说的原话」和「他发来的东西」拼成一条给模型看的正文。
 *
 * 两条路径要分开说：
 *   - 原生附件成功 → 图已经在 content 数组里，这里只报个文件名，帮她以后回忆
 *   - 原生附件失败 → 必须把绝对路径 + `read_image` 指令写清楚，否则她只能瞎猜
 * 语音和视频是**明着说做不到**：模型没有耳朵、也吃不下视频，
 * 与其让她编一段"我听到了"，不如让她老实说"这条我听不了，打字给我"。
 */
export function buildInboundText(text, collected, { nativeImages = false } = {}) {
  const lines = []
  if (typeof text === 'string' && text !== '') lines.push(text)

  const images = collected?.images ?? []
  if (images.length > 0) {
    lines.push(nativeImages
      ? `[他发来 ${images.length} 张图片，已经贴在这条消息里了，直接看]`
      : `[他发来 ${images.length} 张图片，存在下面这些路径：]`)
    images.forEach((img, i) => {
      const dims = img.width > 0 && img.height > 0 ? `${img.width}×${img.height}` : '尺寸未知'
      const kind = img.kind === 'mface' ? '表情' : '图片'
      const where = nativeImages ? img.file : img.path
      lines.push(`  ${i + 1}. ${where}（${kind}，${dims}，${formatBytes(img.bytes)}）`)
    })
    if (nativeImages) {
      // 原生附件是走 DSH 内部格式的，万一宿主不认这套（升级 / 换实现），
      // 这一行是她最后的退路 —— 一个看不见的图库比多一次工具调用糟得多
      const firstPath = images[0]?.path ?? ''
      const dir = firstPath !== '' ? dirname(firstPath) : ''
      if (dir !== '') lines.push(`[如果上面那几张没显示出来，本地备份在 ${dir}，用 read_image 按文件名读]`)
    } else {
      lines.push('[用 read_image 逐张看清楚再回答；别装作看过，也别只按文件名猜内容]')
    }
  }

  const files = collected?.files ?? []
  if (files.length > 0) {
    lines.push(`[他发来 ${files.length} 个文件，已存到本地：]`)
    files.forEach((f, i) => lines.push(`  ${i + 1}. ${f.path}（${f.name}，${formatBytes(f.bytes)}）`))
    lines.push('[先看文件类型再决定怎么开：纯文本直接读，pdf / docx / xlsx 用对应的工具]')
  }

  const voices = collected?.voices ?? []
  if (voices.length > 0) {
    lines.push(`[他发来 ${voices.length} 条语音 —— 我这边听不了音频，别假装听懂，直接跟他说清楚，让他打字]`)
  }

  const videos = collected?.videos ?? []
  if (videos.length > 0) {
    lines.push(`[他发来 ${videos.length} 段视频 —— 我看不了视频，别假装看过，直接跟他说清楚]`)
  }

  return lines.join('\n')
}

/**
 * 造一个宿主认可的空会话 id。
 *
 * 两条硬约束（都是 2026-10-25 那次「消息进来了却一个字都不回」踩出来的）：
 *   1. `agents.create()` **必须**显式传 sessionId。不传的话宿主内部 agent.id 是
 *      undefined，而它 enter() 时会校验 `agent.id !== agent.session.id`，直接抛
 *      `agent id "undefined" does not match session id "session-1"`，
 *      消息在进 agent 之前就死了。
 *   2. 形态必须是 `session-<uuid>`：GUI 建的、落盘目录名、`resolveAgent()` 恢复
 *      走的是同一套命名，自造前缀（qq-123）只会得到一个重启后就找不回的会话。
 */
function mintSessionId() {
  return `session-${randomUUID()}`
}

/** 从 assistant 消息里取文本。 */
function assistantText(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
}

/**
 * assistant 这一步的「思考」有多少字。
 *
 * 用来分辨两种零正文：思考里躺着整段回复 = 答案写错通道了（该催），
 * 思考里也是空的 = 她本来就没打算说话（别催）。
 */
function assistantReasoningLen(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return 0
  let len = 0
  for (const block of content) {
    if (block && block.type === 'reasoning' && typeof block.text === 'string') len += block.text.length
  }
  return len
}

/** assistant 这一步调了几次工具（两家宿主字段名不一样，都认）。 */
function assistantToolCallCount(event) {
  const message = event?.data?.message
  const direct = Array.isArray(message?.toolCalls) ? message.toolCalls.length : 0
  const content = message?.content
  const inContent = Array.isArray(content)
    ? content.filter((b) => b && (b.type === 'tool-call' || b.type === 'toolCall')).length
    : 0
  return Math.max(direct, inContent)
}

/**
 * 插件入口。
 * @param {any} ctx cordis 宿主上下文
 * @param {unknown} rawConfig cordis.patch.yml 里的 config
 */
export function apply(ctx, rawConfig) {
  const parsedBase = parseConfig(rawConfig)

  /* ── 数据目录：首次启动在这里初始化，之后一直复用 ──────────────────────
     全部落在 config.dataDir（默认 ~/.dsh-qq-bot），不碰任何作者机器上的路径。 */
  DATA_DIR = parsedBase.config.dataDir !== '' ? parsedBase.config.dataDir : join(homedir(), '.dsh-qq-bot')
  LOG_DIR = join(DATA_DIR, 'logs')
  ensureDir(DATA_DIR)
  ensureDir(LOG_DIR)
  LOG_FILE = join(LOG_DIR, 'qq-bot.log')
  CONFIG_FILE = join(DATA_DIR, 'config.json')

  /* 设置页保存过的值优先于 cordis.patch.yml 里的出厂默认 —— 这样用户在界面上
     点一下就能改，不用去动 profile 的 YAML（那文件改错会让整个宿主起不来）。 */
  const savedConfig = readJsonFile(CONFIG_FILE)
  const { config, problems } = savedConfig !== null && typeof savedConfig === 'object'
    ? parseConfig({ ...(rawConfig ?? {}), ...savedConfig })
    : parsedBase

  if (config.memesDir === '') config.memesDir = join(DATA_DIR, 'memes')
  ensureDir(config.memesDir)

  /* ── 入站图片仓库（2026-10-25 加）──────────────────────────────────────
     收到图片 → 下载存本地 → 把路径贴进消息让模型 read_image → 记一份索引。
     建不起来不影响聊天，退回原来的「[图片]」占位。 */
  if (config.imageDir === '') config.imageDir = join(DATA_DIR, 'images')

  /** @type {ReturnType<typeof createImageStore> | null} */
  let imageStore = null

  function rebuildImageStore(reason) {
    imageStore = null
    if (!config.imageEnabled) {
      writeLog('INFO', `图片功能关着（${reason}）—— 收到图只写「[图片]」占位`)
      return
    }
    try {
      imageStore = createImageStore({
        dir: config.imageDir,
        limitBytes: config.imageCacheLimitMB * 1024 * 1024,
        purgeBytes: config.imageCachePurgeMB * 1024 * 1024,
        maxBytes: config.imageMaxMB * 1024 * 1024,
        timeoutMs: config.imageTimeoutMs,
        // 原生附件：写进 <DSH_HOME>/attachments/v1/objects/，模型直接看得见图
        dshHome: process.env.DSH_HOME ?? '',
        // 他发来的 zip / pdf / docx 存这儿
        filesDir: join(DATA_DIR, 'files'),
        log: writeLog,
      })
      const st = imageStore.startup()
      writeLog('INFO', `图片仓库就绪（${reason}）：${st.dir} —— 现有 ${st.count} 张 / ${formatBytes(st.bytes)}，`
        + `上限 ${formatBytes(st.limitBytes)}，超了从最老的删起（一次约 ${formatBytes(st.purgeBytes)}）`)
      writeLog('INFO', process.env.DSH_HOME
        ? `原生识图：开 —— 图片会写成 DSH 附件（${process.env.DSH_HOME}），模型不用 read_image 也看得见`
        : '原生识图：关 —— 没拿到 DSH_HOME，退回「存本地 + 让模型 read_image」')
    } catch (err) {
      imageStore = null
      writeLog('WARN', `图片仓库没起来（${err instanceof Error ? err.message : String(err)}），这次按纯文本处理图片`)
    }
  }

  rebuildImageStore('启动')

  /* 没有配置文件时先落一份基线：这样「托盘设置窗口」一打开读到的就是**当前真实生效**的
     那套值，而不是一堆空控件让人以为自己配置丢了。 */
  if (savedConfig === null) {
    writeJsonFile(CONFIG_FILE, pickPersistable(config))
    writeLog('INFO', `已生成配置基线：${CONFIG_FILE}`)
  }

  /* 热载：设置窗口（tools\settings-ui.ps1）改完保存，这里立刻应用，不用重启 DSH。
     连接相关的四项（baseUrl/accessToken/allowUsers/selfId）仍要重连才生效。 */
  try {
    watchFile(CONFIG_FILE, { interval: 800 }, () => {
      const next = readJsonFile(CONFIG_FILE)
      if (next === null || typeof next !== 'object') return
      try {
        const parsed = parseConfig({ ...(rawConfig ?? {}), ...next })
        const beforeImageKey = `${config.imageEnabled}|${config.imageDir}|${config.imageCacheLimitMB}|${config.imageCachePurgeMB}|${config.imageMaxMB}`
        Object.assign(config, parsed.config)
        if (config.memesDir === '') config.memesDir = join(DATA_DIR, 'memes')
        if (config.imageDir === '') config.imageDir = join(DATA_DIR, 'images')
        const afterImageKey = `${config.imageEnabled}|${config.imageDir}|${config.imageCacheLimitMB}|${config.imageCachePurgeMB}|${config.imageMaxMB}`
        // 图片那几项变了才重建仓库 —— 每存一次配置就重建会白白重扫一遍目录
        if (afterImageKey !== beforeImageKey) rebuildImageStore('配置热应用')
        writeLog('INFO', '配置文件变了，已热应用（连接参数请点「重新连接」）')
      } catch (err) {
        writeLog('WARN', `配置文件热载失败：${err instanceof Error ? err.message : String(err)}`)
      }
    })
    ctx.effect(() => () => {
      try {
        unwatchFile(CONFIG_FILE)
      } catch {
        // 关不掉就算了
      }
    }, 'dsh-qq-bot: config watch')
  } catch (err) {
    writeLog('WARN', `配置热载没挂上（改配置后需重载插件）：${err instanceof Error ? err.message : String(err)}`)
  }

  /** 会话映射：uin → { sessionId, agent, handle, createdAt } */
  const sessions = new Map()
  /** 正在创建 agent 的 promise，避免重复创建 */
  const creating = new Map()
  /** 每个会话的排队计数 */
  const queueDepth = new Map()
  /** 限流器按 uin 分 */
  const limiters = new Map()
  /** 正在处理的发送链，保证同一会话的消息按顺序发 */
  const sendChains = new Map()
  /**
   * 换局瞬间的残留事件：旧 sessionId → uin。
   * 换局是把映射指向新会话，但旧会话这一轮可能还有事件在路上（多步 agent 每个 step 都会发
   * assistant/message），不认这些 id 就会把本轮真正的回复吞掉 —— 2026-10-25 压测时就这么丢过一次。
   */
  const legacyIds = new Map()
  /** 正在换局的 uin（一轮里多个 assistant/message 会并发判定） */
  const rollingOver = new Set()
  /** 每个 uin 上一次换局的时刻（宽限期用） */
  const rolloverAt = new Map()

  const mapPath = join(DATA_DIR, 'qq-session-map.json')
  const controlPath = join(DATA_DIR, 'qq-bot-control.json')

  /**
   * 运行时开关。和配置里的 enabled 是两件事：
   *   enabled=false    → 插件整个不加载（要重载）
   *   forwarding=false → 连接还连着，但消息不再送给 agent（/qq off）
   */
  /** 运行时开关。和配置里的 enabled 是两件事：
   *   enabled=false    → 插件整个不加载（要重载）
   *   forwarding=false → 连接还连着，但消息不再送给 agent（/qq off）
   */
  const runtime = { forwarding: true, lastChangeAt: null, lastChangeBy: null }

  /** OneBot 连接状态（设置页要显示"连上没"）。 */
  let linkState = null

  function loadControl() {
    try {
      const raw = JSON.parse(readFileSync(controlPath, 'utf8'))
      if (raw !== null && typeof raw === 'object') {
        if (raw.forwarding === false) runtime.forwarding = false
        runtime.lastChangeAt = raw.lastChangeAt ?? null
        runtime.lastChangeBy = raw.lastChangeBy ?? null
      }
    } catch {
      // 第一次跑没有这个文件
    }
  }

  function saveControl() {
    try {
      writeFileSync(controlPath, `${JSON.stringify(runtime, null, 2)}\n`, 'utf8')
    } catch (err) {
      writeLog('WARN', `运行时开关落盘失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  loadControl()

  /** 读上一次的会话映射（sessionId 可能会被 DSH 改写，所以要持久化）。 */
  function loadMap() {
    try {
      const raw = JSON.parse(readFileSync(mapPath, 'utf8'))
      if (raw !== null && typeof raw === 'object') {
        for (const [uin, record] of Object.entries(raw)) {
          if (record && typeof record.sessionId === 'string' && record.sessionId !== '') {
            sessions.set(uin, { sessionId: record.sessionId, agent: null, handle: null, createdAt: record.createdAt ?? null, generation: Number(record.generation) || 1 })
          }
        }
      }
    } catch {
      // 第一次跑没有这个文件，正常
    }
  }

  /** 落盘会话映射。 */
  function saveMap() {
    try {
      /** @type {Record<string, {sessionId: string, createdAt: string|null}>} */
      const out = {}
      for (const [uin, record] of sessions) {
        out[uin] = { sessionId: record.sessionId, createdAt: record.createdAt ?? null, generation: record.generation ?? 1 }
      }
      writeFileSync(mapPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8')
    } catch (err) {
      writeLog('WARN', `会话映射落盘失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  loadMap()

  /* ── 上下文占用 ── */

  /** 缓存住的模型上下文窗口。0 = 还没查到过。 */
  let cachedContextWindow = 0

  /**
   * 去宿主问一次模型的上下文窗口，成功就更新缓存。
   *
   * ⚠️ `llm.resolveModelInfo()` 是 **async** 的。2026-10-27 之前这里是**不 await**
   * 直接取 `.context` 的：拿到的是个 Promise，属性全是 undefined，所以永远走兜底值；
   * 更糟的是 provider 不存在时它返回的 rejected Promise **没人接**，升级成
   * unhandledRejection，DSH 判成「致命加载失败」，整个桌面端 `exited with 1`。
   * 那天的事故就是：provider 从 unlimit 换成 bit，配置里还留着 unlimit。
   *
   * 所以这里三条纪律：必须 await、必须 catch、错了就当没查到（永不抛）。
   *
   * @returns {Promise<number>} 有效的窗口大小；拿不到返回 0
   */
  async function refreshContextWindow() {
    /** @type {any} */
    let sel = {}
    try {
      const llm = ctx.get('llm')
      sel = ctx.get('agentDefaultModel')?.currentSelection?.() ?? {}
      if (typeof llm?.resolveModelInfo !== 'function') return 0
      const info = await llm.resolveModelInfo(sel?.provider, sel?.model)
      const size = Number(
        info?.context?.contextWindow ?? info?.context ?? info?.contextWindow ?? info?.contextSize,
      )
      if (Number.isFinite(size) && size > 8000) {
        cachedContextWindow = size
        return size
      }
      return 0
    } catch (err) {
      writeLog(
        'WARN',
        `读不到模型上下文窗口（${sel?.provider ?? '?'}/${sel?.model ?? '?'}）：${err instanceof Error ? err.message : String(err)} —— 先用配置里的兜底值`,
      )
      return 0
    }
  }

  /** 拿模型的上下文窗口大小。**同步、永不抛**：查过就用真值，没查到用配置兜底。 */
  function resolveContextWindow() {
    return cachedContextWindow > 8000 ? cachedContextWindow : config.contextWindow
  }

  /**
   * 量一下这个会话现在占了多少上下文。
   * 用宿主的 tokenMeter（回放持久日志算出来的，确定、不花 token）。
   * @returns {null | {used:number, limit:number, percent:number}}
   */
  function contextUsage(record) {
    // 插件重启后 record.agent 是空的（loadMap 只恢复 sessionId），
    // 所以这里不能只认缓存，得回宿主再取一次。
    const agent = record?.agent ?? (typeof record?.sessionId === 'string' ? ctx.get('agents')?.get?.(record.sessionId) : null)
    if (!agent) return null
    const meter = ctx.get('tokenMeter')
    if (!meter || typeof meter.measure !== 'function') return null
    const session = agent.session
    if (!session) return null
    try {
      const measured = meter.measure(session)
      const used = Number(measured?.totalTokens)
      if (!Number.isFinite(used) || used <= 0) return null
      const limit = resolveContextWindow()
      return { used, limit, percent: Math.round((used / limit) * 1000) / 10 }
    } catch {
      return null
    }
  }

  /**
   * 换一个全新的会话接着聊。
   * 旧会话不删（GUI 里还能翻），只是后续消息走新的。
   *
   * @param {string} uin
   * @param {any} record
   * @param {{used:number, limit:number, percent:number}} usage
   * @param {{notify?: string, why?: string}} [options]
   *   notify — 换局时对他说的话，省略用默认那句「上下文快满了」
   *   why    — 日志里的来由（沉默换局时写清楚是卡住，不是上下文满）
   */
  async function rolloverSession(uin, record, usage, options = {}) {
    const agents = ctx.get('agents')
    if (!agents) return false

    const gen = (Number(record.generation) || 1) + 1
    const newId = mintSessionId()
    writeLog(
      'INFO',
      `${options.why ?? `上下文 ${usage.percent}%（${usage.used}/${usage.limit}）`}，` +
        `准备换新对话（第 ${gen} 局）→ ${newId}`,
    )

    // 走同一条发送队列，保证"这一轮的回复"先出去，提醒排在它后面
    enqueueReply(uin, options.notify ?? config.rolloverNotice)

    const selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? {}
    /** @type {Record<string, unknown>} */
    // sessionId 必传（原因见 mintSessionId），形态用宿主的 session-<uuid>
    const createArgs = { sessionId: newId }
    if (typeof selection.provider === 'string' && typeof selection.model === 'string') {
      createArgs.agentOptions = { provider: selection.provider, model: selection.model }
    }
    if (config.workspacePath) createArgs.meta = { cwd: config.workspacePath }

    const beforeIds = new Set((agents.list?.() ?? []).map((a) => a.id))
    let handle
    try {
      handle = await agents.create(createArgs)
    } catch (err) {
      writeLog('ERROR', `新对话创建失败，继续用旧的：${err instanceof Error ? err.message : String(err)}`)
      return false
    }
    const freshAgents = (agents.list?.() ?? []).filter((a) => !beforeIds.has(a.id))
    const agent = freshAgents.find((a) => a.id === newId) ?? freshAgents[0] ?? handle?.agent ?? null
    const realId = String(agent?.id ?? newId)
    // 旧会话这一轮可能还有事件在路上（多步 agent 每步都发 assistant/message），
    // 先记下"它属于哪个 uin"，别把本轮回复吞了。过期的顺手清掉。
    if (typeof record?.sessionId === 'string' && record.sessionId !== '') {
      legacyIds.set(record.sessionId, { uin, at: Date.now() })
      for (const [id, entry] of legacyIds) {
        if (Date.now() - entry.at > 600_000) legacyIds.delete(id)
      }
    }
    sessions.set(uin, { sessionId: realId, agent, handle, createdAt: new Date().toISOString(), generation: gen })
    saveMap()
    writeLog('INFO', `已切到新对话 ${realId}（第 ${gen} 局）`)
    return true
  }

  /**
   * 检查要不要换局。
   *
   * 三道保险（2026-10-25 压测时一次性踩出来的）：
   *   1. 同一 uin 换局互斥 —— 一轮回复里 agent 会发好几个 assistant/message，
   *      两个同时判定超标就会各建一个会话（当时眼看着建出两局）。
   *   2. 换局后 30 秒宽限期 —— 否则新会话紧接着也超阈值，会一直换下去。
   *   3. 只在真说出了话之后调（见出站处理器），中间空文本的 step 不算。
   */
  async function maybeRollover(uin, record) {
    if (config.contextLimitPercent <= 0) return
    if (rollingOver.has(uin)) return
    const last = rolloverAt.get(uin) ?? 0
    if (Date.now() - last < 30_000) return
    const usage = contextUsage(record)
    if (usage === null) return
    if (usage.percent < config.contextLimitPercent) return
    rollingOver.add(uin)
    try {
      const switched = await rolloverSession(uin, record, usage)
      if (switched) rolloverAt.set(uin, Date.now())
    } finally {
      rollingOver.delete(uin)
    }
  }

  /* ── QQ 里的本地命令（不送进 agent）── */

  /** 解析 "/qq off" 这类命令；不是命令返回 null。 */
  function parseCommand(text) {
    const prefix = config.commandPrefix
    if (!text.startsWith(prefix)) return null
    const rest = text.slice(prefix.length).trim()
    const parts = rest.split(/\s+/).filter((s) => s !== '')
    return { name: (parts[0] ?? '').toLowerCase(), args: parts.slice(1) }
  }

  /** 执行命令，返回要回给他的话（空串 = 不回）。 */
  async function runCommand(cmd, uin, record) {
    const p = config.commandPrefix
    if (cmd.name === 'off') {
      runtime.forwarding = false
      runtime.lastChangeAt = new Date().toISOString()
      runtime.lastChangeBy = `qq:${uin}`
      saveControl()
      writeLog('INFO', '/qq off —— 转发已关（连接保持，随时能 /qq on）')
      return '好，我闭嘴。\n想让我回来就说 /qq on。'
    }
    if (cmd.name === 'on') {
      runtime.forwarding = true
      runtime.lastChangeAt = new Date().toISOString()
      runtime.lastChangeBy = `qq:${uin}`
      saveControl()
      writeLog('INFO', '/qq on —— 转发已开')
      return '回来了。刚才说到哪了？'
    }
    if (cmd.name === 'status') {
      const usage = contextUsage(record)
      const meter = ctx.get('tokenMeter')
      const hasMeter = meter !== null && meter !== undefined && typeof meter.measure === 'function'
      let usageLine
      if (usage !== null) {
        usageLine = `上下文：${usage.percent}%（${usage.used}/${usage.limit}），到 ${config.contextLimitPercent}% 自动换新局`
      } else if (!hasMeter) {
        usageLine = '上下文：量不了 —— 宿主没挂 tokenMeter（换新局因此不会触发）'
      } else if (!record?.agent) {
        usageLine = '上下文：量不了 —— 还没有活着的会话（发条消息就建）'
      } else {
        usageLine = '上下文：量不了 —— tokenMeter 在，但这次没测出数（会话还没跑过一轮？）'
      }
      const lines = [
        `转发：${runtime.forwarding ? '开着' : '关着'}`,
        `当前对话：${record?.sessionId ?? '(还没建)'}（第 ${record?.generation ?? 1} 局）`,
        usageLine,
        `今天说过：${new Date().getHours()} 点这小时不限流`,
      ]
      return lines.join('\n')
    }
    if (cmd.name === 'pic' || cmd.name === 'img' || cmd.name === 'image') {
      if (imageStore === null) {
        return config.imageEnabled
          ? '图片仓库没起来，看日志里的警告。'
          : '图片功能关着（设置里「收图存本地」没打开）。'
      }
      const sub = (cmd.args[0] ?? '').toLowerCase()
      if (sub === 'clean' || sub === '清' || sub === '清理') {
        const r = imageStore.sweep()
        const st = imageStore.stats()
        if (r.purged === 0) {
          return `没到上限，不用清。\n现在 ${st.count} 张 / ${formatBytes(st.bytes)}，上限 ${formatBytes(st.limitBytes)}。`
        }
        return `清掉 ${r.purged} 张，腾出 ${formatBytes(r.freedBytes)}。\n现在 ${st.count} 张 / ${formatBytes(st.bytes)}。`
      }
      const st = imageStore.stats()
      const pct = st.limitBytes > 0 ? Math.round((st.bytes / st.limitBytes) * 100) : 0
      const recent = imageStore.list().filter((e) => !e.purged).slice(-3).reverse()
      const lines = [
        `图库：${st.count} 张 / ${formatBytes(st.bytes)}（占上限 ${pct}%，上限 ${formatBytes(st.limitBytes)}）`,
        `超了自动删最老的，一次约 ${formatBytes(st.purgeBytes)}`,
        `目录：${st.dir}`,
      ]
      if (recent.length > 0) {
        lines.push('最近三张：')
        for (const e of recent) lines.push(`· ${e.file}（${stampParts(new Date(e.at)).full}）`)
      }
      lines.push(`手动清一次：${p} pic clean`)
      return lines.join('\n')
    }
    return `不认识的命令。能用的：${p} off / ${p} on / ${p} status / ${p} pic`
  }

  for (const p of problems) writeLog('WARN', `配置：${p}`)
  writeLog('INFO', `启动 name=${name} enabled=${config.enabled} allowUsers=${JSON.stringify(config.allowUsers)} dryRun=${config.dryRun}`)
  writeLog('INFO', `数据目录：${DATA_DIR}`)
  // 派活用的 source.kind 必须打出来：这个值写错不是"日志难看"，
  // 是整个 QQ 会话的写盘报废、她一条都不回（2026-10-27 就这么栽的）。
  // 出问题时第一眼要能在日志里确认它到底是什么。
  writeLog('INFO', `派活来源 kind=${taskSourceKind()}（配置项 taskSourceKind；'plugin' 会被 DSH v4 拒绝，'qq'/'user' 会被记忆插件当成他说的话）`)

  // 首次安装的引导：没填 QQ 号就等于没启用，必须说清楚，别让人干等
  if (config.allowUsers.length === 0) {
    writeLog('WARN', '还没填你自己的 QQ 号（allowUsers 为空）—— 插件不会服务任何人。')
    writeLog('WARN', `去「设置 → 插件 → dsh-qq-bot」填上，或直接编辑 ${CONFIG_FILE}`)
  }

  // 自检：等宿主把那几个服务挂完再看一眼，把「上下文能不能量」一次说清楚。
  // 以前只会在 /qq status 里看到一句「读不到」，分不清是没挂 tokenMeter 还是没会话。
  setTimeout(async () => {
    try {
      const meter = ctx.get('tokenMeter')
      const ok = meter !== null && meter !== undefined && typeof meter.measure === 'function'
      if (ok) {
        // 把分母和实际触发线一起打出来：换局提前/滞后时，一眼能看出是基数错了还是百分比错了。
        const live = await refreshContextWindow()
        const win = live > 0 ? live : config.contextWindow
        const trigger = Math.round((win * config.contextLimitPercent) / 100)
        writeLog(
          'INFO',
          `自检：tokenMeter 就绪 —— 上下文窗口 ${win}${live > 0 ? '' : '（模型信息读不到，用配置兜底值）'}，到 ${config.contextLimitPercent}%（${trigger} token）会自动换新局`,
        );
      } else {
        writeLog('WARN', '自检：拿不到 tokenMeter —— 「上下文到 X% 自动换新对话」不会触发（其余功能不受影响）')
      }
    } catch (err) {
      writeLog('WARN', `自检失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, 5000)

  if (!config.enabled) {
    writeLog('INFO', 'enabled=false，本次不连接、不转发。改配置后插件会重载。')
    return
  }
  if (config.allowUsers.length === 0) {
    writeLog('ERROR', 'allowUsers 为空，插件不会服务任何人。请在配置里填你的 QQ 号。')
    return
  }

  /** 取某个 uin 的 DSH 会话；没有就创建。 */
  /* ── 说说配图（2026-10-27）─────────────────────────────────────
     为什么图由插件备、而不是让她自己找：
       · `generate_image` 生成的图**确实落地成本地文件**，但那个工具把结果返回成
         纯文本，模型拿不到路径；而 `send_qzone_msg` 要的正是本地路径。
       · 所以「让她自己搞图」是死路：她能画，但传不过去。
     这里按权重二选一：现画一张（调 Agnes），或者从她自己的表情包里挑一张。 */

  /** 数据目录兜底：config.dataDir 默认是空串，join('') 会写到进程 cwd。 */
  function dataRoot() {
    return config.dataDir || join(homedir(), '.dsh-qq-bot')
  }

  /** 0-100 的权重抽签。 */
  function rollPercent(weight) {
    return Math.random() * 100 < weight
  }

  /** 从表情包目录里随机挑一张本地图片。挑不到返回 ''。 */
  function pickMemeFile() {
    try {
      const root = config.memesDir || join(dataRoot(), 'memes')
      const packs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
      if (packs.length === 0) return ''
      const files = []
      for (const pack of packs) {
        const base = join(root, pack.name, 'memes')
        let cats = []
        try {
          cats = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory())
        } catch {
          continue
        }
        for (const cat of cats) {
          let imgs = []
          try {
            imgs = readdirSync(join(base, cat.name)).filter((n) => /\.(png|jpe?g|gif|webp)$/i.test(n))
          } catch {
            continue
          }
          for (const n of imgs) files.push(join(base, cat.name, n))
        }
      }
      if (files.length === 0) return ''
      return files[Math.floor(Math.random() * files.length)]
    } catch (err) {
      writeLog('WARN', `挑表情包失败：${err instanceof Error ? err.message : String(err)}`)
      return ''
    }
  }

  /** 调 Agnes 现画一张，存到 dataDir/qzone-images/，返回本地路径。失败返回 ''。 */
  async function generateDiaryImage(prompt, idx) {
    try {
      const cfgPath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'ag-multimodal.json')
      /** @type {any} */
      const pool = JSON.parse(readFileSync(cfgPath, 'utf8'))
      const accounts = Array.isArray(pool?.accounts) ? pool.accounts : []
      if (accounts.length === 0) return ''
      const account = accounts[Math.floor(Math.random() * accounts.length)]
      const endpoint = String(account?.endpoint ?? '').replace(/\/+$/, '')
      const key = String(account?.key ?? '')
      if (endpoint === '' || key === '') return ''

      const r = await fetch(`${endpoint}/images/generations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'agnes-image-2.1-flash',
          prompt,
          size: '1024x1024',
          extra_body: { response_format: 'url' },
        }),
        signal: AbortSignal.timeout(180000),
      })
      if (!r.ok) {
        writeLog('WARN', `配图生成失败 HTTP ${r.status}`)
        return ''
      }
      /** @type {any} */
      const body = await r.json()
      const item = Array.isArray(body?.data) ? body.data[0] : undefined
      if (!item) return ''
      const dir = join(dataRoot(), 'qzone-images')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `diary-${Date.now()}-${idx}.png`)
      if (item.url) {
        const dl = await fetch(item.url)
        if (!dl.ok) return ''
        writeFileSync(file, Buffer.from(await dl.arrayBuffer()))
      } else if (item.b64_json) {
        writeFileSync(file, Buffer.from(item.b64_json, 'base64'))
      } else {
        return ''
      }
      return file
    } catch (err) {
      writeLog('WARN', `配图生成异常：${err instanceof Error ? err.message : String(err)}`)
      return ''
    }
  }

  /** 按权重备 n 张图，返回本地路径数组（失败的就不带，宁可少一张也不要空路径）。 */
  async function prepareQzoneImages(n, imagePrompt) {
    const out = []
    const weight = Math.max(0, Math.min(100, Number(config.qzoneImageGenWeight) || 0))
    for (let i = 0; i < n; i += 1) {
      if (rollPercent(weight)) {
        const p = String(imagePrompt ?? '').trim()
        const prompt = p === '' ? '一张柔和的生活感插画，暖色调，像随手拍的照片' : `${p}，自然光，生活感，柔和色调`
        const file = await generateDiaryImage(prompt, i)
        if (file !== '') {
          out.push(file)
          continue
        }
      }
      const meme = pickMemeFile()
      if (meme !== '') out.push(meme)
    }
    return out
  }

  /* ── 派活投递（2026-10-27）─────────────────────────────────────
     日记和说说轮询都是「插件派的活」，统一走这一条口子。

     以前是直接 `agent.followup({...})` 一行了事，两个坑都真踩了：
       1. followup 只是塞进队列，真正的写盘在后面的 flush 里 ——
          source.kind 一旦不被会话格式接受（`'plugin'` 就是），
          错误全静默，日志里只有一行 agent.failed，用户那边只看到「她不回我」。
       2. 会话写不进去的时候没有任何兜底提示，于是这种事能藏一整晚。

     现在四步都在这儿：造消息 → followup → 立刻冲盘确认 → 后台盯动静。 */

  /** 每个会话累计来了多少条事件：派活后靠它判断「她到底动没动」。 */
  const sessionTicks = new Map()

  /**
   * 当前生效的派活 source.kind。
   *
   * 配置项 `taskSourceKind` 优先；坏值退回代码默认。
   * parseConfig 已经挡过一次，这里再挡是因为**这里才是真正写进消息的地方** ——
   * 这个值写错不是"日志不好看"，是整个会话写盘报废。
   */
  function taskSourceKind() {
    const configured = config.taskSourceKind
    if (typeof configured !== 'string') return TASK_SOURCE_KIND
    const trimmed = configured.trim()
    if (trimmed === '' || trimmed === 'plugin' || trimmed === 'qq' || trimmed === 'user') {
      return TASK_SOURCE_KIND
    }
    return trimmed
  }

  /**
   * 冲一次盘，确认这条消息真的落到会话文件里了。
   *
   * 官方范本（dsh-schedule）是 flush 不认就抛；这里只记日志不抛 ——
   * 派活失败不该把定时器整条炸掉，日志里那条 ERROR 才是给人看的。
   *
   * @param {any} session agent.session
   * @param {string} reason 日志用的来由
   * @returns {Promise<boolean>} 宿主是否确认落盘
   */
  async function confirmDelivery(session, reason) {
    if (!session || typeof session !== 'object') {
      writeLog('WARN', `派活（${reason}）：拿不到会话对象，落盘没法确认 —— 她收没收到只能看后面有没有动静`)
      return false
    }
    const service = ctx.get('sessions')
    if (!service || typeof service.flush !== 'function') {
      writeLog('WARN', `派活（${reason}）：宿主没挂 sessions 服务，落盘没法确认（消息可能还在内存里）`)
      return false
    }
    try {
      const acknowledged = await service.flush(session)
      if (acknowledged === true) return true
      writeLog('WARN', `派活（${reason}）：sessions.flush 没确认（返回 ${String(acknowledged)}），这条可能丢了`)
      return false
    } catch (err) {
      // 这里最可能出现的就是 SessionFormatError：
      // "format v4 message requires a producer-owned source kind"
      writeLog('ERROR', `派活（${reason}）落盘失败：${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  /**
   * 投递之后盯 N 秒：这个会话一条事件都没有，就把话喊进日志。
   *
   * 为什么 flush 之外还要这一层：flush 只证明「消息写进去了」，
   * 证明不了「她跑起来了」。模型调用失败、turn 起不来、会话卡死，
   * 全都表现为「写进去了但没人回」—— 以前这一步完全没有，失败是静默的。
   */
  function watchDelivery(session, reason) {
    const seconds = Number(config.taskDeliveryWatchSeconds)
    if (!(seconds > 0)) return
    const id = session?.id
    if (typeof id !== 'string') return
    const baseline = sessionTicks.get(id) ?? 0
    const timer = setTimeout(() => {
      if ((sessionTicks.get(id) ?? 0) > baseline) return
      writeLog('WARN', `派活（${reason}）：${seconds} 秒过去会话 ${id.slice(0, 13)}… 一点动静都没有 —— 查它的会话写盘和模型调用`)
    }, seconds * 1000)
    // 别让这个观察定时器把进程吊住不退
    if (typeof timer.unref === 'function') timer.unref()
  }

  /**
   * 派活给她：造消息 → followup → 冲盘确认 → 后台盯动静。
   *
   * @param {any} agent 目标会话的 agent（必须有 followup）
   * @param {string} text 交给她的话
   * @param {string} reason 来由，进日志：qzone-diary / qzone-poll
   * @returns {Promise<boolean>} 落盘是否被确认
   */
  async function deliverTask(agent, text, reason) {
    if (!agent || typeof agent.followup !== 'function') {
      writeLog('ERROR', `派活（${reason}）：会话没有 followup 方法，这条发不出去`)
      return false
    }
    const message = createTaskMessage({ text, reason, kind: taskSourceKind() })
    const session = agent.session ?? null
    agent.followup(message)
    const confirmed = await confirmDelivery(session, reason)
    watchDelivery(session, reason)
    return confirmed
  }

  /**
   * 只做一件事：数每个会话来了多少条事件。
   *
   * 独立成一个监听器、不做任何业务过滤 —— 它统计的是「会话活没活」，
   * 混进出站那套判断里，哪天出站逻辑改了就会把这个计数带坏。
   */
  const offSessionTicks = ctx.on('session/event', (session) => {
    const id = session?.id
    if (typeof id !== 'string') return
    sessionTicks.set(id, (sessionTicks.get(id) ?? 0) + 1)
    // QQ 会话就一两个，别让这个 Map 无限长：超过 64 个就把不认识的清掉
    if (sessionTicks.size > 64) {
      const keep = new Set()
      for (const record of sessions.values()) keep.add(record.sessionId)
      for (const key of sessionTicks.keys()) if (!keep.has(key)) sessionTicks.delete(key)
    }
  })

  /* ── 每日说说（日记）调度 2026-10-27 ──────────────────────────
     每天在 `qzoneDiaryTime` 起、`qzoneDiaryWindowMinutes` 分钟内的**随机一分钟**
     触发一次，不是准点 —— 准点发动态一眼就是机器人。
     触发方式是往她的会话里塞一条 task（source.kind = taskSourceKind()，默认 dsh-qq-bot）：
     她自己写、自己决定画面、自己调 qq_qzone 发出去。
     注意 source.kind 故意不是 'qq'：这条不是「他说的话」，
     用 qq 会被记忆插件当成真人发言收进记忆库，污染得很。 */

  const DIARY_STATE_FILE = 'qzone-diary-state.json'
  /** @type {{dayKey: string, firedAt: number, minute: number}} */
  let diaryState = { dayKey: '', firedAt: 0, minute: -1 }
  let diaryTimer = null
  let diaryBusy = false

  function loadDiaryState() {
    try {
      const raw = JSON.parse(readFileSync(join(dataRoot(), DIARY_STATE_FILE), 'utf8'))
      diaryState = {
        dayKey: typeof raw?.dayKey === 'string' ? raw.dayKey : '',
        firedAt: Number(raw?.firedAt) || 0,
        minute: Number.isFinite(Number(raw?.minute)) ? Number(raw.minute) : -1,
      }
    } catch {
      // 第一次跑没有这个文件
    }
  }

  function saveDiaryState() {
    try {
      mkdirSync(dataRoot(), { recursive: true })
      writeFileSync(
        join(dataRoot(), DIARY_STATE_FILE),
        `${JSON.stringify({ version: 1, ...diaryState }, null, 2)}\n`,
        'utf8',
      )
    } catch (err) {
      writeLog('WARN', `日记状态落盘失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function dayKeyOf(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  /** 今天定在第几分钟触发：[起点, 起点 + 窗口) 里随机。 */
  function plannedMinuteOfDay() {
    const parts = String(config.qzoneDiaryTime || '18:00').split(':')
    const base = (Number(parts[0]) || 0) * 60 + (Number(parts[1]) || 0)
    const win = Math.max(1, Math.round(Number(config.qzoneDiaryWindowMinutes) || 60))
    return base + Math.floor(Math.random() * win)
  }

  /** 拼给她看的日记任务，塞进会话。 */
  async function runDiaryNow() {
    if (diaryBusy) return
    diaryBusy = true
    try {
      const owner = String(config.allowUsers?.[0] ?? '')
      if (owner === '') {
        writeLog('WARN', '日记：allowUsers 是空的，不知道这日记写给他看还是给谁看，跳过')
        return
      }
      const record = await ensureSession(owner)
      const agent = record?.agent
      if (!agent || typeof agent.followup !== 'function') {
        writeLog('WARN', '日记：拿不到 agent，这次跳过')
        return
      }

      // 「最近的事」从记忆插件读短期区 —— 读不到就让这一段空着，绝不让她编
      let recent = ''
      try {
        const mem = ctx.get('ebbinghausMemory')
        const snap = mem && typeof mem.snapshot === 'function' ? mem.snapshot() : null
        const short = Array.isArray(snap?.short) ? snap.short.slice(-8) : []
        recent = short
          .map((e) => String(e?.title ?? '').trim())
          .filter((s) => s !== '')
          .map((s) => `- ${s}`)
          .join('\n')
      } catch {
        // 没装记忆插件 / 拿不到快照：跳过素材，不写空条目
      }

      const now = new Date()
      const hh = String(now.getHours()).padStart(2, '0')
      const mm = String(now.getMinutes()).padStart(2, '0')
      const lines = [
        '【今天的日记】到点了，写一篇今天的小记，写完发到 QQ 动态（说说）。',
        `现在是 ${hh}:${mm}。`,
        '',
        '要求：',
        `- 长度 ${config.qzoneDiaryMinChars}~${config.qzoneDiaryMaxChars} 字，第一人称，像日记。不是总结报告，别写成条目清单`,
        '- 写今天的事、碎碎念、现在的心情；没发生过的事不要编',
        '- 写完之后**必须**调用 qq_qzone 工具发出去：action=post，content 放日记正文，',
        `  autoImages=${Math.max(0, Number(config.qzoneDiaryImageCount) || 0)}（图由插件负责，你拿不到路径也不用管），`,
        '  imagePrompt 用一两句写清楚你想要的画面',
        '- 发完就结束，不用再补一句「我发了」之类的话',
      ]
      if (recent !== '') {
        lines.push('', '最近记下的事（可以当素材，别照抄成流水账）：', recent)
      }

      const text = lines.join('\n')
      const confirmed = await deliverTask(agent, text, 'qzone-diary')
      writeLog('INFO', `日记：任务已交给她（提示 ${text.length} 字，配图 ${config.qzoneDiaryImageCount} 张${confirmed ? '' : '，落盘未确认'}）`)
    } catch (err) {
      writeLog('WARN', `日记触发失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      diaryBusy = false
    }
  }

  /** 每分钟看一眼：今天该不该写了。跨天时重新抽一次时间。 */
  async function tickDiary() {
    if (!config.enabled || !config.qzoneDiaryEnabled) return
    const now = new Date()
    const today = dayKeyOf(now)
    if (diaryState.dayKey !== today) {
      diaryState = { dayKey: today, firedAt: 0, minute: plannedMinuteOfDay() }
      saveDiaryState()
      const hh = String(Math.floor(diaryState.minute / 60)).padStart(2, '0')
      const mm = String(diaryState.minute % 60).padStart(2, '0')
      writeLog('INFO', `日记：今天的写日记时间定在 ${hh}:${mm}（窗口内随机）`)
    }
    if (diaryState.firedAt > 0) return
    const nowMin = now.getHours() * 60 + now.getMinutes()
    if (nowMin < diaryState.minute) return
    // 过期太久就跳过今天：否则半夜重启会「补写」一篇，那不像日记像补作业。
    // 宽限 = 窗口长度再 + 120 分钟，够应付一次临时重启。
    const grace = Math.max(1, Math.round(Number(config.qzoneDiaryWindowMinutes) || 60)) + 120
    if (nowMin > diaryState.minute + grace) {
      diaryState.firedAt = Date.now()
      saveDiaryState()
      writeLog('INFO', '日记：今天那个时间点已经过太久了，这次不补写')
      return
    }
    diaryState.firedAt = Date.now()
    saveDiaryState()
    await runDiaryNow()
  }

  function startDiaryTimer() {
    if (diaryTimer !== null) return
    if (!config.qzoneDiaryEnabled) return
    loadDiaryState()
    diaryTimer = setInterval(() => {
      void tickDiary().catch((err) => {
        writeLog('WARN', `日记调度出错：${err instanceof Error ? err.message : String(err)}`)
      })
    }, 60_000)
    // 启动时先看一眼：可能重启前就已经过了那个点
    void tickDiary().catch(() => {})
    writeLog(
      'INFO',
      `日记：已启动（${config.qzoneDiaryTime} 起 ${config.qzoneDiaryWindowMinutes} 分钟内随机一次，配图 ${config.qzoneDiaryImageCount} 张，现画权重 ${config.qzoneImageGenWeight}%）`,
    )
  }

  function stopDiaryTimer() {
    if (diaryTimer === null) return
    clearInterval(diaryTimer)
    diaryTimer = null
  }

  /* ── 说说互动轮询 2026-10-27 ────────────────────────────────────
     只在「想他 / 吃醋」压到阈值以上才干活。情绪不高的时候跑去翻他空间，
     那不是她，那是监控 —— 所以不满足条件时**一次 API 都不调**。
     轮到的这一趟做两件事：看自己最近几天说说下面的新评论（只认他那个号）、
     看他最近有没有发新说说；有新东西就拼一条 task 丢给她，让她自己决定回不回。 */

  const POLL_STATE_FILE = 'qzone-poll-state.json'
  /** @type {{lastPollAt: number, handled: string[]}} */
  let pollState = { lastPollAt: 0, handled: [] }
  let pollTimer = null
  let pollBusy = false

  function loadPollState() {
    try {
      const raw = JSON.parse(readFileSync(join(dataRoot(), POLL_STATE_FILE), 'utf8'))
      pollState = {
        lastPollAt: Number(raw?.lastPollAt) || 0,
        handled: Array.isArray(raw?.handled) ? raw.handled.filter((x) => typeof x === 'string').slice(-500) : [],
      }
    } catch {
      // 第一次跑没有这个文件
    }
  }

  function savePollState() {
    try {
      mkdirSync(dataRoot(), { recursive: true })
      writeFileSync(
        join(dataRoot(), POLL_STATE_FILE),
        `${JSON.stringify({ version: 1, ...pollState }, null, 2)}\n`,
        'utf8',
      )
    } catch (err) {
      writeLog('WARN', `轮询状态落盘失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 读她的心情（alive 那份 alive-mood.json）。读不到返回 null。 */
  function readMoodNow() {
    try {
      const raw = JSON.parse(readFileSync(join(dataRoot(), 'alive-mood.json'), 'utf8'))
      const m = raw?.mood ?? {}
      return { missing: Number(m.missing) || 0, jealousy: Number(m.jealousy) || 0 }
    } catch {
      return null
    }
  }

  /** 想他 / 吃醋 任意一个到阈值了没。读不到心情就当没到（不乱动）。 */
  function moodTriggered() {
    const m = readMoodNow()
    if (!m) return false
    const th = Math.max(1, Math.min(100, Number(config.qzonePollTriggerPercent) || 80)) / 100
    return m.missing >= th || m.jealousy >= th
  }

  /** 把 OneBot 返回的列表尽量拆成条目数组（各家字段名不一样，粘一个算一个）。 */
  function asList(r) {
    if (!r || r.ok !== true) return []
    const d = r.data
    if (Array.isArray(d)) return d
    for (const key of ['msglist', 'messages', 'list', 'feeds', 'data']) {
      if (Array.isArray(d?.[key])) return d[key]
    }
    return []
  }

  /** 从一条说说里抠 tid / 正文 / 时间。 */
  function readPost(item) {
    const tid = String(item?.tid ?? item?.feedskey ?? item?.id ?? '').trim()
    const content = String(item?.content ?? item?.summary ?? item?.text ?? '').trim()
    const rawTime = Number(item?.createTime ?? item?.create_time ?? item?.time ?? 0)
    const createdAt = rawTime > 1e12 ? rawTime : rawTime > 1e9 ? rawTime * 1000 : 0
    return { tid, content, createdAt }
  }

  /** 从 detail 返回里抠评论列表。 */
  function readComments(r) {
    if (!r || r.ok !== true) return []
    const d = r.data
    const pools = [
      d?.comments,
      d?.commentlist,
      d?.data?.comments,
      d?.data?.commentlist,
      Array.isArray(d) ? d : null,
    ]
    for (const pool of pools) {
      if (Array.isArray(pool)) return pool
    }
    return []
  }

  function commentKey(tid, c) {
    const id = String(c?.commentid ?? c?.commentId ?? c?.id ?? '').trim()
    const from = String(c?.uin ?? c?.userid ?? c?.user?.uin ?? '').trim()
    const text = String(c?.content ?? c?.text ?? '').trim().slice(0, 40)
    return `${tid}|${id !== '' ? id : `${from}|${text}`}`
  }

  async function pollQzoneOnce() {
    if (pollBusy) return
    pollBusy = true
    try {
      const owner = String(config.allowUsers?.[0] ?? '')
      if (owner === '') return
      const record = await ensureSession(owner)
      const agent = record?.agent
      if (!agent || typeof agent.followup !== 'function') return

      const lookbackMs = Math.max(1, Number(config.qzonePollLookbackDays) || 3) * 86_400_000
      const since = Date.now() - lookbackMs
      const handled = new Set(pollState.handled)
      /** @type {string[]} */
      const findings = []
      /** @type {string[]} */
      const newlyHandled = []

      /* ① 自己最近几天的说说 → 看下面有没有他的新评论 */
      const mine = asList(await callOneBot('get_qzone_msg_list', { page_num: 1, count: 20 }))
      for (const raw of mine.slice(0, 10)) {
        const post = readPost(raw)
        if (post.tid === '' || (post.createdAt > 0 && post.createdAt < since)) continue
        const detail = await callOneBot('get_qzone_msg_detail', { tid: post.tid })
        for (const c of readComments(detail)) {
          const from = String(c?.uin ?? c?.userid ?? c?.user?.uin ?? '').trim()
          // 只认他那个号 —— 别人评论当没看见
          if (from !== '' && from !== owner) continue
          if (from === '') continue
          const key = commentKey(post.tid, c)
          if (handled.has(key)) continue
          const text = String(c?.content ?? c?.text ?? '').trim()
          findings.push(`- 你的说说「${post.content.slice(0, 30)}」下面他评论了：「${text.slice(0, 60)}」（tid=${post.tid}）`)
          newlyHandled.push(key)
        }
      }

      /* ② 他最近有没有发新说说 */
      const his = asList(
        await callOneBot('get_qzone_msg_list', { target_uin: Number(owner), page_num: 1, count: 10 }),
      )
      for (const raw of his.slice(0, 5)) {
        const post = readPost(raw)
        if (post.tid === '' || (post.createdAt > 0 && post.createdAt < since)) continue
        const key = `post|${post.tid}`
        if (handled.has(key)) continue
        findings.push(`- 他刚发了新说说：「${post.content.slice(0, 60)}」（tid=${post.tid}）`)
        newlyHandled.push(key)
      }

      if (findings.length === 0) {
        writeLog('INFO', `轮询：最近 ${config.qzonePollLookbackDays} 天没有新东西`)
        return
      }

      const text = [
        '【说说那边有新动静】你心里想他 / 吃醋压得有点高了，去看看。',
        ...findings,
        '',
        '怎么处理你自己定：想回就回、想点赞就点，都要用 qq_qzone 工具（comment / like）。',
        '不想理也行 —— 但别装看不见，也别每条都回一长串。',
      ].join('\n')

      const confirmed = await deliverTask(agent, text, 'qzone-poll')
      writeLog('INFO', `轮询：${findings.length} 条新动静，已交给她${confirmed ? '' : '（落盘未确认）'}`)

      // 交给她的同时就记成「已处理」：宁可漏回一次，也别同一个评论回两遍
      pollState.handled = [...pollState.handled, ...newlyHandled].slice(-500)
      savePollState()
    } catch (err) {
      writeLog('WARN', `轮询出错：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      pollBusy = false
    }
  }

  /** 每分钟看一眼：情绪到了、且到间隔了，才真去轮询。 */
  async function tickQzonePoll() {
    if (!config.enabled || !config.qzonePollEnabled) return
    if (!moodTriggered()) return
    const gap = Math.max(5, Number(config.qzonePollIntervalMinutes) || 20) * 60_000
    if (pollState.lastPollAt > 0 && Date.now() - pollState.lastPollAt < gap) return
    pollState.lastPollAt = Date.now()
    savePollState()
    await pollQzoneOnce()
  }

  function startPollTimer() {
    if (pollTimer !== null) return
    if (!config.qzonePollEnabled) return
    loadPollState()
    pollTimer = setInterval(() => {
      void tickQzonePoll().catch((err) => {
        writeLog('WARN', `轮询调度出错：${err instanceof Error ? err.message : String(err)}`)
      })
    }, 60_000)
    writeLog(
      'INFO',
      `轮询：已启动（想他/吃醋 >= ${config.qzonePollTriggerPercent}% 才干活，间隔 ${config.qzonePollIntervalMinutes} 分钟，只看最近 ${config.qzonePollLookbackDays} 天）`,
    )
  }

  function stopPollTimer() {
    if (pollTimer === null) return
    clearInterval(pollTimer)
    pollTimer = null
  }

  async function ensureSession(uin) {
    const cached = sessions.get(uin)
    const agents = ctx.get('agents')

    if (!agents) {
      throw new Error('拿不到 agents 服务（宿主还没就绪？）')
    }

    // 已缓存的 agent 还可能活着
    if (cached?.agent) {
      const still = agents.get?.(cached.sessionId)
      if (still) {
        cached.agent = still
        return cached
      }
      cached.agent = null
    }

    const sessionId = cached?.sessionId || `${config.sessionIdPrefix}${uin}`

    if (creating.has(uin)) return creating.get(uin)

    const task = (async () => {
      const existing = agents.get?.(sessionId)
      if (existing) {
        const record = { sessionId, agent: existing, handle: null, createdAt: cached?.createdAt ?? null, generation: cached?.generation ?? 1 }
        sessions.set(uin, record)
        return record
      }

      // ② 冷会话：agents.get() 只看"活着的"，持久化过的会话要靠 sessionController 恢复。
      //    这是 dsh-schedule 走的那条路，之前漏了这一步，导致重启后一路掉到 create 里撞"已存在"。
      const sc = ctx.get('sessionController')
      if (sc && typeof sc.resolveAgent === 'function') {
        try {
          const resolved = await sc.resolveAgent(sessionId)
          if (resolved && !('error' in resolved) && resolved.agent) {
            const agent = resolved.agent
            const record = {
              sessionId: String(agent.id ?? sessionId),
              agent,
              handle: null,
              createdAt: cached?.createdAt ?? null,
              generation: cached?.generation ?? 1,
            }
            sessions.set(uin, record)
            saveMap()
            writeLog('INFO', `已恢复冷会话 ${record.sessionId}`)
            return record
          }
          writeLog('INFO', `会话 ${sessionId} 恢复不了（` + String(resolved?.error?.message ?? resolved?.error ?? 'unknown') + '），走新建')
        } catch (err) {
          writeLog('WARN', `resolveAgent 失败：${err instanceof Error ? err.message : String(err)}`)
        }
      }

      const selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? {}
      /** 造一份 create 参数；sessionId 必传（原因见 mintSessionId 的注释）。 */
      const buildCreateArgs = (sid) => {
        /** @type {Record<string, unknown>} */
        const args = { sessionId: sid }
        if (typeof selection.provider === 'string' && typeof selection.model === 'string') {
          args.agentOptions = { provider: selection.provider, model: selection.model }
        }
        // cwd 要放在 meta 里 —— 顶层的 cwd 宿主不看，会话会掉进 sessions\_no-cwd。
        // （官方 dsh-api-session-controller 就是这么传的）
        if (config.workspacePath) args.meta = { cwd: config.workspacePath }
        return args
      }

      // 映射里可能躺着一个老版自造 id（qq-123456789）—— 那种会话从没以这个 id 落过盘，
      // resolveAgent 永远 not found，重试也没用，直接换一局新的。
      let targetId = sessionId.startsWith('session-') ? sessionId : mintSessionId()

      // 记下创建前的 agent 集合，靠前后差集拿"真正的那个 agent"
      const beforeIds = new Set((agents.list?.() ?? []).map((a) => a.id))
      let handle
      try {
        handle = await agents.create(buildCreateArgs(targetId))
      } catch (firstErr) {
        const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr)
        // 已经存在 = 这个会话是活的，只是我们手上没有它的 handle，取出来接着用
        const live = agents.get?.(targetId)
        if (live) {
          const record = { sessionId: String(live.id ?? targetId), agent: live, handle: null, createdAt: cached?.createdAt ?? null, generation: cached?.generation ?? 1 }
          sessions.set(uin, record)
          saveMap()
          writeLog('INFO', `会话 ${targetId} 已在宿主里活着，直接接上`)
          return record
        }
        // 其余情况（id 撞车 / 落盘脏数据）：换一个全新 id 再来一次，别退成"不传 id"
        writeLog('WARN', `建会话失败（${firstMsg}），换新 id 重试`)
        targetId = mintSessionId()
        handle = await agents.create(buildCreateArgs(targetId))
      }

      const freshAgents = (agents.list?.() ?? []).filter((a) => !beforeIds.has(a.id))
      const agent = freshAgents.find((a) => a.id === targetId) ?? freshAgents[0] ?? handle?.agent ?? null
      const realId = String(agent?.id ?? targetId)
      const record = { sessionId: realId, agent, handle, createdAt: new Date().toISOString(), generation: cached?.generation ?? 1 }
      sessions.set(uin, record)
      saveMap()
      writeLog('INFO', `已为 ${uin} 建立 DSH 会话 ${realId}`)
      return record
    })()

    creating.set(uin, task)
    try {
      return await task
    } finally {
      creating.delete(uin)
    }
  }

  /**
   * 她最后真正发出去的那句话（文本 + 时刻）。
   *
   * 只为了一件事：判断「道别是不是已经闭环了」——
   * 她说了晚安、他也说了晚安，那这条晚安就不该再触发她回一句。
   */
  /** @type {{text:string, at:number}} */
  let lastAssistantSaid = { text: '', at: 0 }

  /** 把一段文本发到 QQ。dryRun 时只记日志。 */
  async function sendText(uin, text) {
    const body = String(text ?? '').trim()
    if (body === '') return
    if (config.dryRun) {
      writeLog('INFO', `[dryRun] 本应发给 ${uin}：${body}`)
      return
    }
    try {
      await client.sendPrivateMsg(uin, body)
      // 记住她最后说的是什么 —— 道别闭环要靠它判断
      lastAssistantSaid = { text: body, at: Date.now() }
      writeLog('INFO', `→ QQ ${uin}：${body.slice(0, 120)}`)
    } catch (err) {
      writeLog('ERROR', `发送失败（${uin}）：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 把一条回复按规则分段、延时、依次发出。
   *
   * 规则（2026-10-25 改定）：
   *   <= segment.shortMax（25 字）  整条发
   *   >    segment.shortMax         按实际语意停顿分条，多长都切
   * 例外（2026-10-25 晚上加的"正事"通道）：
   *   回复以 [[整条]] 开头，或者内容像正事（代码围栏 / 三行以上列表 /
   *   表格 / 命令行清单），就整条发、不切 —— 聊正事、干活讲究效率，
   *   清单被切成三段反而看不清
   *   非特殊必要场景不用句号收尾 → stripTrailingPeriod 在这里落地
   *
   * 每一段各自过一遍去尾句号：分段时「。」本来就是切点，留在尾巴上会变成
   * 每条消息都以句号结尾 —— 正好是规则里要去掉的那个东西。
   */
  async function deliverReply(uin, text) {
    // 先认标记再洗 markdown —— 标记是给他看不见的，清洗顺序不能反
    const marked = takeMergeMarker(text)
    const oneShot = marked.merge || (config.mergeOnWork && looksLikeWork(marked.text))
    const cleaned = config.cleanMarkdown ? cleanMarkdown(marked.text) : marked.text
    if (cleaned === '') return

    const pieces = splitLongText(cleaned, config.maxCharsPerMessage)
    /** @type {string[]} */
    const outgoing = []
    for (const piece of pieces) {
      const segments = oneShot ? [piece] : segmentText(piece, config.segment)
      for (const segment of segments) {
        const finalText = config.stripTrailingPeriod ? stripTrailingPeriod(segment) : segment
        if (finalText.trim() !== '') outgoing.push(finalText)
      }
    }
    if (outgoing.length === 0) return

    const typing = randomIn(config.typingDelayMs)
    await sleep(typing)

    for (let i = 0; i < outgoing.length; i += 1) {
      await sendText(uin, outgoing[i])
      if (i < outgoing.length - 1) await sleep(randomIn(config.segment.intervalMs))
    }
  }

  /** 串行化同一 uin 的发送，避免多条回复交错。 */
  function enqueueReply(uin, text) {
    const prev = sendChains.get(uin) ?? Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(() => deliverReply(uin, text))
      .catch((err) => {
        writeLog('ERROR', `回复投递失败：${err instanceof Error ? err.message : String(err)}`)
      })
    sendChains.set(uin, next)
    // 链尾清理，防止 Map 无限增长
    next.finally(() => {
      if (sendChains.get(uin) === next) sendChains.delete(uin)
    })
  }

  /** 入站：一条 QQ 私聊。 */
  async function handleInbound(event) {
    const userId = String(event.user_id ?? '')
    if (!isAllowedUser(userId, config.allowUsers)) {
      writeLog('INFO', `忽略非白名单私聊 user_id=${userId}`)
      return
    }
    if (config.selfId && userId === config.selfId) return

    const text = extractText(event.message)

    /* 道别闭环（2026-10-27 加的）：她说了晚安、他也说了晚安 —— 这条就不回了。
       以前这种情况会被当成一轮新对话，于是她再回一句「晚安呀」，他没完没了。
       道别是句号，不是逗号。 */
    const farewell = shouldStopHere({
      text,
      lastAssistant: lastAssistantSaid,
      now: Date.now(),
      gapMin: config.farewellGapMin,
    })
    if (farewell.stop) {
      writeLog('INFO', `不追了：${farewell.reason}（他这条：${text.slice(0, 40)}）`)
      return
    }

    /* 他发来的东西：图片 / 商城表情 / 文件 / 语音 / 视频，一次全收下来。
       extractText 只给出「[图片]」「[表情]」「[语音]」这种占位，模型靠它等于什么都没看见。
       collectFromMessage 会把图（含带 url 的表情）下载、写进 DSH 附件库，
       文件下载到 files 目录，语音视频只报个数。 */
    /** @type {{images:Array<object>, files:Array<object>, voices:Array<object>, videos:Array<object>, skipped:number}} */
    let collected = { images: [], files: [], voices: [], videos: [], skipped: 0 }
    if (imageStore !== null) {
      const msgTime = Number(event.time)
      try {
        collected = await imageStore.collectFromMessage(event.message, {
          uin: userId,
          said: text,
          at: Number.isFinite(msgTime) && msgTime > 0 ? msgTime * 1000 : Date.now(),
        })
      } catch (err) {
        writeLog('WARN', `图片/文件处理失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const nativeImages = collected.images.some((img) => img && img.block)
    const gotAnything = collected.images.length > 0 || collected.files.length > 0 ||
      collected.voices.length > 0 || collected.videos.length > 0

    if (text === '' && !gotAnything) {
      writeLog('INFO', `忽略空消息（可能只有小黄脸/引用）uin=${userId}`)
      return
    }

    /* 拼进会话的正文。光有图没文字的消息也要发 —— 那种以前会被上面这个空判断直接丢掉。 */
    const promptText = buildInboundText(text, collected, { nativeImages })

    // /qq 命令在插件本地处理，不送进 agent（关掉之后也还能用它开回来）
    const cmd = parseCommand(text)
    if (cmd !== null) {
      const reply = await runCommand(cmd, userId, sessions.get(userId) ?? null)
      if (reply !== '') enqueueReply(userId, reply)
      return
    }

    // /qq off 之后，消息只记日志、不回
    if (!runtime.forwarding) {
      writeLog('INFO', `转发已关，忽略：${text.slice(0, 40)}`)
      return
    }
    if (looksRejected(text)) writeLog('INFO', `他这句带情绪：${text.slice(0, 60)}`)

    // 限流
    let limiter = limiters.get(userId)
    if (limiter === undefined) {
      limiter = new RateLimiter(config.rateLimit)
      limiters.set(userId, limiter)
    }
    const gate = limiter.take()
    if (!gate.allowed) {
      writeLog('WARN', `限流：${userId} 在 ${config.rateLimit.windowMs}ms 内超过 ${config.rateLimit.max} 条`)
      if (config.rateLimitReply) enqueueReply(userId, config.rateLimitReply)
      return
    }

    const depth = queueDepth.get(userId) ?? 0
    if (depth >= config.maxQueue) {
      writeLog('WARN', `排队过深（${depth}），丢弃这条：${text.slice(0, 60)}`)
      if (config.busyReply) enqueueReply(userId, config.busyReply)
      return
    }

    queueDepth.set(userId, depth + 1)
    try {
      const record = await ensureSession(userId)
      const agent = record.agent
      if (!agent || typeof agent.followup !== 'function') {
        writeLog('ERROR', `会话 ${record.sessionId} 没有 followup 方法，消息丢弃`)
        return
      }
      const message = createQqUserMessage({
        text: promptText,
        images: collected.images,
        uin: userId,
        messageId: event.message_id,
        at: new Date().toISOString(),
      })
      agent.followup(message)
      const tags = []
      if (collected.images.length > 0) tags.push(`图 ${collected.images.length}${nativeImages ? ' 原生' : ' 路径'}`)
      if (collected.files.length > 0) tags.push(`文件 ${collected.files.length}`)
      if (collected.voices.length > 0) tags.push(`语音 ${collected.voices.length}`)
      if (collected.videos.length > 0) tags.push(`视频 ${collected.videos.length}`)
      const tag = tags.length > 0 ? ` [${tags.join(' · ')}]` : ''
      writeLog('INFO', `← QQ ${userId}：${text.slice(0, 120)}${tag}（排队 ${depth + 1}）`)
    } catch (err) {
      writeLog('ERROR', `入站失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      const now = (queueDepth.get(userId) ?? 1) - 1
      if (now <= 0) queueDepth.delete(userId)
      else queueDepth.set(userId, now)
    }
  }

  /**
   * 社交事件（戳一戳 / 撤回 / 好友申请）：翻成一句话送进他的会话。
   *
   * 统一送进「他」的会话，不是事件发起人的 —— 这些是给她看、让她回应的消息，
   * 源头本来就是他。陌生人加好友也一样：她是在他的会话里听说这件事。
   * 这样也不会给陌生人开一个空会话出来。
   */
  async function handleSocialEvent(event) {
    const text = socialEventToText(event, { selfUin: config.selfId })
    if (text === null) return

    const owner = String(config.allowUsers[0] ?? '')
    if (owner === '') return
    if (!runtime.forwarding) {
      writeLog('INFO', `转发已关，社交事件只记日志：${text}`)
      return
    }

    try {
      const record = await ensureSession(owner)
      const agent = record.agent
      if (!agent || typeof agent.followup !== 'function') {
        writeLog('WARN', `社交事件没送出去（会话没有 followup）：${text}`)
        return
      }
      agent.followup(createQqUserMessage({
        text,
        images: [],
        uin: owner,
        messageId: event?.message_id ?? null,
        at: new Date().toISOString(),
      }))
      writeLog('INFO', `← QQ 事件：${text}`)
    } catch (err) {
      writeLog('WARN', `社交事件处理失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** OneBot 事件总入口。 */
  function onOneBotEvent(event) {
    try {
      if (event?.post_type === 'message') {
        if (event?.message_type !== 'private') return
        if (event?.sub_type !== undefined && event.sub_type !== 'friend') return
        void handleInbound(event)
        return
      }
      // 通知 / 请求：戳一戳、撤回、好友申请……
      // 2026-10-26 之前这里第一行就是 `post_type !== 'message'` 直接 return，
      // 于是这些事件全被扔掉，她那边永远收不到「他戳了你一下」。
      void handleSocialEvent(event)
    } catch (err) {
      writeLog('ERROR', `事件入口失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 建立连接。 */
  const client = new OneBotClient({
    url: buildSocketUrl(config),
    onEvent: onOneBotEvent,
    onLog: (m) => writeLog('INFO', m),
    onState: (state, detail) => {
      linkState = state
      if (state === STATE.OPEN) writeLog('INFO', 'OneBot 连接就绪')
      else if (state === STATE.CLOSED) writeLog('WARN', `OneBot 连接断开 ${detail ? JSON.stringify(detail) : ''}`)
    },
    baseReconnectMs: config.reconnect.baseMs,
    maxReconnectMs: config.reconnect.maxMs,
  })

  client.connect()

  /**
   * 多开 QQ 时 SnowLuma 的 hook 很容易挂错号（它自己的说明里都写了）。
   * 连上之后问一句「你到底登的哪个号」，和设置里的 selfId 对不上就明确报出来，
   * 免得用户以为插件坏了。
   */
  async function verifyBotAccount() {
    try {
      const reply = await client.call('get_login_info', {})
      const data = reply?.data ?? reply
      const uin = String(data?.user_id ?? '')
      if (uin === '') return
      if (config.selfId === '') {
        writeLog('WARN', `OneBot 实际登录的号是 ${uin}，但设置里 selfId 是空的 —— 建议填上（多开 QQ 时靠它核对）`)
      } else if (uin !== config.selfId) {
        writeLog('WARN', `SnowLuma 实际挂的是 ${uin}，和设置里的 BOT 号 ${config.selfId} 不一致 —— 多开 QQ 时 hook 挂错号了`)
      } else {
        writeLog('INFO', `BOT 号核对通过：${uin}`)
      }
    } catch (err) {
      writeLog('INFO', `BOT 号核对跳过：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  setTimeout(() => {
    void verifyBotAccount()
  }, 4000)

  /* ── 看门狗：卡住就中断 + 关思考 + 催一句（2026-10-27）──────────────
     零正文判定抓不到「请求发出去了、一直不回包」这种 —— 那一轮压根还没结束。
     所以再加一层只看时间的：这一轮还在跑、却已经 N 秒没有任何事件，就该动手。

     动手顺序（一次比一次硬）：
       第一次 → 打断 + 临时关思考 + 催一句
       第二次 → 打断 + 催（不再折腾档位）
       到上限 → 开新对话

     思考只对她这一个会话、且只对下一次请求生效，说完就恢复 —— 不永久关。 */

  /** @type {Map<string, {inTurn: boolean, lastAt: number, strikes: number, switchedOff: boolean, prev: any, expectNoThinking: boolean, warnedNoThinking: boolean}>} */
  const watchdogState = new Map()
  let watchdogTimer = null

  function watchdogOf(uin) {
    let state = watchdogState.get(uin)
    if (state === undefined) {
      state = {
        inTurn: false,
        lastAt: 0,
        strikes: 0,
        switchedOff: false,
        prev: null,
        expectNoThinking: false,
        warnedNoThinking: false,
      }
      watchdogState.set(uin, state)
    }
    return state
  }

  /** 任何事件都算「她还活着」；顺便记下这一轮的起止。 */
  function watchdogTouch(uin, event) {
    const state = watchdogOf(uin)
    state.lastAt = Date.now()
    if (event?.type === 'turn/start') {
      state.inTurn = true
      return
    }
    if (event?.type === 'turn/end') state.inTurn = false
  }

  /** 把临时关掉的思考档位还回去。 */
  async function restoreThinkingEffort(uin) {
    const state = watchdogOf(uin)
    if (!state.switchedOff) return
    state.switchedOff = false
    const prev = state.prev
    state.prev = null
    if (!prev || typeof prev.provider !== 'string' || typeof prev.model !== 'string') return
    const service = ctx.get('sessionController')
    const sessionId = sessions.get(uin)?.sessionId
    if (!service || typeof service.selectModel !== 'function' || typeof sessionId !== 'string') return
    try {
      /** @type {Record<string, unknown>} */
      const request = { sessionId, provider: prev.provider, model: prev.model }
      if (typeof prev.reasoningEffort === 'string' && prev.reasoningEffort !== '') {
        request.reasoningEffort = prev.reasoningEffort
      }
      await service.selectModel(request)
      writeLog('INFO', `看门狗：思考档位已恢复（${prev.provider}/${prev.model}${prev.reasoningEffort ? ` ${prev.reasoningEffort}` : ''}）`)
    } catch (err) {
      writeLog(
        'WARN',
        `看门狗：恢复思考档位失败，她还停在 off 档：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /** 临时把她这个会话的思考关掉（只对下一次请求生效）。 */
  async function switchThinkingOff(uin, record) {
    const state = watchdogOf(uin)
    if (state.switchedOff) return true
    const service = ctx.get('sessionController')
    const sessionId = record?.sessionId
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? {}
    if (!service || typeof service.selectModel !== 'function' || typeof sessionId !== 'string') return false
    if (typeof selection.provider !== 'string' || typeof selection.model !== 'string') return false
    state.prev = {
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
    }
    try {
      await service.selectModel({
        sessionId,
        provider: selection.provider,
        model: selection.model,
        reasoningEffort: 'off',
      })
      state.switchedOff = true
      // 切完之后要亲眼确认一次「思考真没了」—— 不同 host/provider 对 off 档的实现不一样，
      // 有的只是「不发参数」，而这不发给会思考的模型等于没关（2026-10-27 就是这么被骗的）。
      state.expectNoThinking = true
      writeLog('INFO', `看门狗：这一轮先把思考关掉再试（${selection.provider}/${selection.model}）`)
      return true
    } catch (err) {
      writeLog('WARN', `看门狗：关思考没成功，那就只重试：${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  /** 到点了：动手。 */
  async function watchdogRescue(uin, record, action) {
    const state = watchdogOf(uin)
    state.strikes += 1
    state.lastAt = Date.now()

    const agent = record?.agent
    // ① 打断正在跑的那一轮，但别把排队的消息一起扔掉
    if (agent && typeof agent.cancel === 'function') {
      try {
        agent.cancel({ kind: 'user' }, { keepInbox: true })
        writeLog(
          'WARN',
          `看门狗：这一轮 ${config.watchdogSeconds} 秒没有动静，打断重来（第 ${state.strikes} 次）`,
        )
      } catch (err) {
        writeLog('WARN', `看门狗：打断失败 ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (action === 'rollover') {
      state.strikes = 0
      await rolloverForSilence(uin, record, `看门狗救了 ${config.watchdogMaxStrikes} 次仍然没有输出`)
      return
    }

    // ② 第一次救：临时关思考（第二次就不再动档位，免得来回切）
    if (config.watchdogSwitchThinkingOff && state.strikes === 1) {
      await switchThinkingOff(uin, record)
    }

    // ③ 催她接着说
    if (agent && typeof agent.followup === 'function') {
      await deliverTask(agent, config.watchdogNudgeText, 'watchdog-nudge').catch((err) => {
        writeLog('WARN', `看门狗催话失败：${err instanceof Error ? err.message : String(err)}`)
      })
    }
  }

  function startWatchdog() {
    if (watchdogTimer !== null) return
    // 定时器一律起来，阈值每次跳都从 config 现读 ——
    // 这样设置页把 300 改成 600（配置热载）立刻生效，把 0 改成 300 也能自己活过来。
    watchdogTimer = setInterval(() => {
      const now = Date.now()
      const thresholdMs = Math.round(Number(config.watchdogSeconds) || 0) * 1000
      for (const [uin, state] of watchdogState) {
        const action = judgeWatchdog({
          inTurn: state.inTurn,
          idleMs: now - state.lastAt,
          thresholdMs,
          strikes: state.strikes,
          maxStrikes: config.watchdogMaxStrikes,
        })
        if (action !== 'rescue' && action !== 'rollover') continue
        const record = sessions.get(uin)
        if (!record) continue
        void watchdogRescue(uin, record, action).catch((err) => {
          writeLog('WARN', `看门狗动作失败：${err instanceof Error ? err.message : String(err)}`)
        })
      }
    }, 5000)
    if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref()
    writeLog(
      'INFO',
      `看门狗：已启动（一轮 ${config.watchdogSeconds} 秒没动静就救；最多救 ${config.watchdogMaxStrikes} 次，` +
        `救的时候${config.watchdogSwitchThinkingOff ? '' : '不'}关思考）`,
    )
  }

  function stopWatchdog() {
    if (watchdogTimer === null) return
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }

  /* ── 出站：只认映射到 QQ 的那些会话 ── */

  /** session id → 他那个 QQ 号。认不出来返回 null。 */
  function uinForSession(sessionId) {
    if (typeof sessionId !== 'string') return null
    for (const [candidateUin, record] of sessions) {
      if (record.sessionId === sessionId) return candidateUin
    }
    // 刚换过局：旧会话这一轮的尾巴也要能发出去
    return legacyIds.get(sessionId)?.uin ?? null
  }

  /**
   * 每个 QQ 会话「这一轮说过话没有 / 连续几轮没说」。
   *
   * 零正文是**静默故障**：模型只 thinking 不给正文的时候，QQ 那边就是一句不回，
   * 日志里只有几行「本段 0 字」——没人会盯着那几行看。2026-10-27 她就这么安静了十几分钟。
   *
   * @type {Map<string, {turn: number, spoke: boolean, silentRun: number}>}
   */
  const turnSpeech = new Map()

  /** 上次「推她补一句」的时间：防止一轮里反复推。 */
  const silentNudgeAt = new Map()

  /**
   * 她卡住、被救不回来 → 换局。
   *
   * 为什么不只靠 maybeRollover：它判的是「上下文百分比」——
   * 模型坏掉、或者上下文根本量不出来（没挂 tokenMeter）的时候它永远不触发，
   * 而那正是她完全不出声的时候。越不说话，越等不到救援。
   *
   * 注意说辞：这条**不是**上下文满了，所以不能说「上下文快满了哦」——
   * 2026-10-27 实测过一次：只有 12.2%，却在喊快满了，纯误导。
   */
  async function rolloverForSilence(uin, record, reason) {
    if (rollingOver.has(uin)) return
    rollingOver.add(uin)
    try {
      const usage = contextUsage(record) ?? { used: 0, limit: resolveContextWindow(), percent: 0 }
      writeLog('WARN', `连续零正文，主动换新局（${reason}）`)
      const switched = await rolloverSession(uin, record, usage, {
        notify: config.stuckRolloverNotice,
        why: `她卡住了（${reason}），不是上下文满 —— 当前 ${usage.percent}%`,
      })
      if (switched) rolloverAt.set(uin, Date.now())
      else writeLog('ERROR', `换局失败（${reason}）—— 这个会话可能要人工介入了`)
    } finally {
      rollingOver.delete(uin)
    }
  }

  const offSession = ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session?.id
      if (typeof sessionId !== 'string') return
      // 不是 QQ 会话就一个字都不发，也不进看门狗
      const uin = uinForSession(sessionId)
      if (uin === null) return
      // 任何事件都算「她还活着」，顺便记下这一轮的起止
      watchdogTouch(uin, event)

      /* ── 一轮结束：她这一轮到底说过话没有 ── */
      if (event?.type === 'turn/end') {
        const turnNo = Number(event?.data?.turn)
        const state = turnSpeech.get(uin)
        // 这一轮压根没见到她的 assistant 事件（纯工具轮 / 我们自己派的活）→ 不判她的嘴
        if (!state || state.turn !== turnNo) return

        const verdict = judgeTurnSilence(state)

        if (verdict === 'quiet') {
          // 她动了手（戳一戳、点赞、发表情包）但没说话 —— 那是她的表达方式，不是故障。
          // 2026-10-27 补的：不区分这个，她每次故意不吭声都会被"催话"，等于嫌她多做了动作。
          state.silentRun = 0
          turnSpeech.set(uin, state)
          writeLog('INFO', `她第 ${turnNo} 轮只动了手没说话（工具 ${state.toolCalls} 次），按故意处理，不催`)
          void restoreThinkingEffort(uin)
          return
        }

        if (verdict === 'spoken') {
          state.silentRun = 0
          turnSpeech.set(uin, state)
          // 这一轮正常说出话了：看门狗的计数归零，临时关掉的思考还回去
          watchdogOf(uin).strikes = 0
          void restoreThinkingEffort(uin)
          return
        }
        state.silentRun += 1
        state.spoke = false
        turnSpeech.set(uin, state)
        // 走到这儿就是 judgeTurnSilence 判的 stuck：要么思考里躺着整段回复（答案写错通道），
        // 要么这一轮连手都没动、一个字也没有。两种都得有人喊一嗓子。
        writeLog(
          'WARN',
          `她第 ${turnNo} 轮一个字都没说出来（连续 ${state.silentRun} 轮）—— ` +
            `思考 ${state.lastReasoningLen} 字 / 工具 ${state.toolCalls} 次，答案很可能写在思考里了`,
        )

        // 先推她一句把话补出来。只推第一轮，且 20 秒内不重复推 ——
        // 推了还有用，推了没用就交给下面的换局，别在这儿死循环。
        const lastNudge = silentNudgeAt.get(uin) ?? 0
        if (config.zeroTextNudge && state.silentRun === 1 && Date.now() - lastNudge > 20_000) {
          const record = sessions.get(uin)
          if (record?.agent && typeof record.agent.followup === 'function') {
            silentNudgeAt.set(uin, Date.now())
            writeLog('INFO', `零正文：推她一句，把刚才没说的补上（第 ${turnNo} 轮）`)
            void deliverTask(record.agent, config.zeroTextNudgeText, 'zero-text-nudge').catch((err) => {
              writeLog('WARN', `零正文催话失败：${err instanceof Error ? err.message : String(err)}`)
            })
          }
        }

        const limit = Math.round(Number(config.zeroTextRolloverTurns) || 0)
        if (limit > 0 && state.silentRun >= limit) {
          state.silentRun = 0
          turnSpeech.set(uin, state)
          void rolloverForSilence(uin, sessions.get(uin), `连续 ${limit} 轮零正文`).catch((err) => {
            writeLog('WARN', `零正文换局失败：${err instanceof Error ? err.message : String(err)}`)
          })
        }
        return
      }

      if (event?.type !== 'assistant/message') return

      const text = assistantText(event)
      // 这条日志是压测换新局时踩出来的：需要能一眼看出「事件到了但文本是 0 字」，
      // 否则只会看到"她没回话"，分不清是模型没说话还是出站把他吞了。
      writeLog('INFO', `出站：${sessionId.slice(0, 13)}… 匹配 QQ ${uin}，本段 ${text.length} 字`)
      if (text !== '') enqueueReply(uin, text)

      // 记一笔：这一轮她说出话了没有？零正文的判定全靠 turnSpeech
      const turnNo = Number(event?.data?.turn)
      if (Number.isFinite(turnNo)) {
        const state = turnSpeech.get(uin) ?? {
          turn: -1,
          spoke: false,
          silentRun: 0,
          hadToolCall: false,
          toolCalls: 0,
          lastReasoningLen: 0,
        }
        if (state.turn !== turnNo) {
          state.turn = turnNo
          state.spoke = false
          state.hadToolCall = false
          state.toolCalls = 0
          state.lastReasoningLen = 0
        }
        if (text !== '') state.spoke = true
        // 最后一步的思考字数 + 这一轮动过几次手 —— 判定「故障」还是「故意的」全靠这两个
        state.lastReasoningLen = assistantReasoningLen(event)
        // 刚把思考切成 off 之后，这里应该是 0。不是 0 就说明「关思考」这条路是假的，
        // 喊一嗓子让人去改 provider 配置 —— 否则这种骗子会一直骗下去。
        const wd = watchdogOf(uin)
        if (wd.expectNoThinking) {
          if (state.lastReasoningLen > 0) {
            if (!wd.warnedNoThinking) {
              wd.warnedNoThinking = true
              writeLog(
                'WARN',
                `看门狗：明明切到 off 档，思考还是有 ${state.lastReasoningLen} 字 —— ` +
                  '这个 provider 的 off 档可能是「不发参数」，而它对会思考的模型等于没关。' +
                  '去 provider 目录把 reasoningEfforts.off 从 null 改成一个真值（这个渠道是 none）',
              )
            }
          } else {
            wd.expectNoThinking = false
            writeLog('INFO', '看门狗：确认这次思考真的关掉了（0 字）')
          }
        }
        const calls = assistantToolCallCount(event)
        if (calls > 0) {
          state.hadToolCall = true
          state.toolCalls += calls
        }
        turnSpeech.set(uin, state)
      }

      // 把"这一轮我怎么回的"回填进图片索引 —— 索引里那列空着，过一个月就没人记得那张图是干嘛的
      if (text !== '' && imageStore !== null) {
        try {
          imageStore.noteReply(uin, text)
        } catch (err) {
          writeLog('WARN', `图片索引回填失败：${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // 一轮结束，顺手量一下上下文；快满了就换新局（异步，不挡这轮回复）。
      // 只在"这一轮真说出了话"时才考虑换局 —— 多步 agent 的中间 step 也会发
      // assistant/message（常常是空文本），在那儿换局会把本轮回复直接判死。
      // 零正文的情况归上面 turn/end 那段管（rolloverForSilence），不在这儿判。
      if (text !== '') {
        void maybeRollover(uin, sessions.get(uin)).catch((err) => {
          writeLog('WARN', `上下文检查失败：${err instanceof Error ? err.message : String(err)}`)
        })
      }
    } catch (err) {
      writeLog('ERROR', `出站失败：${err instanceof Error ? err.message : String(err)}`)
    }
  })

  /* ── 在 GUI 里说 /qq 也生效（session/event 这条路上来）── */
  const offLocalCommands = ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'user/message') return
      const kind = event.data?.source?.kind
      if (kind !== 'user' && kind !== 'qq') return
      const content = event.data?.content
      if (!Array.isArray(content)) return
      const text = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('').trim()
      if (text === '') return

      const cmd = parseCommand(text)
      if (cmd === null) return

      const uin = config.allowUsers[0]
      void runCommand(cmd, uin ?? 'local', sessions.get(uin) ?? null)
        .then((reply) => {
          if (reply !== '' && uin !== undefined) enqueueReply(uin, reply)
        })
        .catch((err) => writeLog('WARN', `命令处理失败：${err instanceof Error ? err.message : String(err)}`))
    } catch (err) {
      writeLog('WARN', `命令入口失败：${err instanceof Error ? err.message : String(err)}`)
    }
  })

  /* ── 心跳：定期确认 OneBot 还活着 ── */
  const heartbeat = setInterval(() => {
    if (!client.isOpen) return
    client.getLoginInfo().catch((err) => {
      writeLog('WARN', `心跳失败：${err instanceof Error ? err.message : String(err)}`)
    })
  }, 60_000)

  /* ── send_meme：让她自己发表情包 ── */

  /** 情绪分类目录名 → 中文标签。 */
  const GROUP_CN = {
    shy: '害羞', happy: '开心', angry: '生气', sad: '难过', confused: '困惑',
    surprised: '惊讶', see: '惊讶', sleep: '睡觉', work: '干活', like: '喜欢',
    sigh: '无语', meow: '猫', morning: '早安', daily: '日常', cpu: '加班',
    baka: '笨蛋', color: '好色', fool: '笨蛋', givemoney: '要钱',
    affection: '亲昵', food: '吃饭', bixin: '比心', buyao: '拒绝',
  }

  /** @type {Array<{path:string, name:string, dir:string, label:string}> | null} */
  let memeIndex = null

  /* 表情包频率闸门的状态：最近发过的时刻（毫秒） */
  const memeStatePath = join(DATA_DIR, 'qq-bot-meme-state.json')
  /** @type {number[]} */
  let memeSentAt = []

  function loadMemeState() {
    try {
      const raw = JSON.parse(readFileSync(memeStatePath, 'utf8'))
      if (Array.isArray(raw?.sentAt)) {
        memeSentAt = raw.sentAt.filter((t) => Number.isFinite(Number(t))).map(Number).slice(-50)
      }
    } catch {
      // 第一次跑没有这个文件
    }
  }

  function saveMemeState() {
    try {
      writeFileSync(memeStatePath, `${JSON.stringify({ sentAt: memeSentAt.slice(-50) }, null, 2)}\n`, 'utf8')
    } catch {
      // 落盘失败不影响发图
    }
  }

  loadMemeState()

  /* ── 小动作的每日额度（戳一戳 / 说说 / 链接卡片）───────────────────────
     跟说话的额度完全分开记。理由见 lib/interact-budget.mjs —— 一句话：
     戳一戳不是说话，发说说更是**替他在社交圈公开发言**，不该跟聊天挤一个池子。 */
  const interactPath = join(DATA_DIR, 'qq-bot-interact.json')
  /** @type {{dayStart:number, poke:number, qzone:number, link:number}} */
  let interactBudget = emptyBudget(Date.now())

  function loadInteractBudget() {
    try {
      const raw = JSON.parse(readFileSync(interactPath, 'utf8'))
      if (raw !== null && typeof raw === 'object') {
        interactBudget = rollDay({
          dayStart: Number(raw.dayStart) || 0,
          poke: Number(raw.poke) || 0,
          qzone: Number(raw.qzone) || 0,
          link: Number(raw.link) || 0,
        }, Date.now())
      }
    } catch {
      // 第一次跑没有这个文件，就用空的
    }
  }

  function saveInteractBudget() {
    try {
      mkdirSync(DATA_DIR, { recursive: true })
      writeFileSync(interactPath, `${JSON.stringify(interactBudget, null, 2)}\n`, 'utf8')
    } catch {
      // 落盘失败不影响这一轮，最多重启后额度回滚
    }
  }

  /**
   * 先滚日、再看额度、过了就记一笔。
   * @param {'poke'|'qzone'|'link'} kind
   * @param {number} max
   * @returns {{ok:true} | {ok:false, note:string}}
   */
  function takeInteract(kind, max) {
    interactBudget = rollDay(interactBudget, Date.now())
    const verdict = checkBudget(interactBudget, kind, max)
    if (!verdict.ok) return { ok: false, note: verdict.reason ?? '这一项今天用完了' }
    interactBudget = takeBudget(interactBudget, kind)
    saveInteractBudget()
    return { ok: true }
  }

  loadInteractBudget()

  /**
   * 现在能不能发表情。
   * 三道闸：最小间隔 → 每小时上限 → 概率。
   * 全都只是"这次先别发"，不是错误 —— 模型看到 ok:false 就该当没这回事。
   *
   * @param {number} now
   * @returns {{ok:true} | {ok:false, reason:string, note:string}}
   */
  function canSendMeme(now) {
    const hourAgo = now - 3_600_000
    memeSentAt = memeSentAt.filter((t) => t > hourAgo - 86_400_000)

    const last = memeSentAt[memeSentAt.length - 1]
    if (last !== undefined && config.memeMinIntervalMin > 0) {
      const gapMs = now - last
      const needMs = config.memeMinIntervalMin * 60_000
      if (gapMs < needMs) {
        const waitMin = Math.ceil((needMs - gapMs) / 60_000)
        return { ok: false, reason: 'interval', note: `刚发过表情，${waitMin} 分钟后再发。这次就先不发了。` }
      }
    }

    const inHour = memeSentAt.filter((t) => t > hourAgo).length
    if (inHour >= config.memeMaxPerHour) {
      return { ok: false, reason: 'quota', note: `这一小时已经发了 ${inHour} 张，够了。这次就先不发了。` }
    }

    if (Math.random() >= config.memeProbability) {
      return { ok: false, reason: 'dice', note: '这次先不发了。' }
    }

    return { ok: true }
  }

  /** 扫一遍图库（缓存，重启才重扫）。 */
  function scanMemes() {
    if (memeIndex !== null) return memeIndex
    const found = []
    const walk = (dir, depth) => {
      if (depth > 4) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const ent of entries) {
        const full = join(dir, ent.name)
        if (ent.isDirectory()) {
          walk(full, depth + 1)
          continue
        }
        if (!/\.(jpe?g|png|gif|webp)$/i.test(ent.name)) continue
        const parts = full.split(/[\\/]/)
        const dirName = parts[parts.length - 2] ?? ''
        found.push({
          path: full,
          name: ent.name.replace(/\.[^.]+$/, ''),
          dir: dirName,
          label: GROUP_CN[dirName.toLowerCase()] ?? dirName,
        })
      }
    }
    walk(config.memesDir, 0)
    memeIndex = found
    writeLog('INFO', `图库索引：${found.length} 张（${config.memesDir}）`)
    return found
  }

  /**
   * 一个关键词想覆盖多个分类目录时写在这儿（否则「喜欢」只能命中 like 那一张）。
   * 值是小写目录名列表，命中优先于 label / dir 的精确匹配。
   */
  const KW_ALIAS = {
    '喜欢': ['like', 'affection', 'bixin'],
    '亲昵': ['affection'],
    '比心': ['bixin', 'like'],
  }

  /** 按关键词挑图：先按别名，再按中文标签，再按目录名，最后按文件名；挑不到就随机。 */
  function pickMeme(keyword) {
    const all = scanMemes()
    if (all.length === 0) return null
    const kw = String(keyword ?? '').trim()
    if (kw === '') return all[Math.floor(Math.random() * all.length)]
    const alias = KW_ALIAS[kw]
    if (alias !== undefined) {
      const aliasPool = all.filter((m) => alias.includes(m.dir.toLowerCase()))
      if (aliasPool.length > 0) return aliasPool[Math.floor(Math.random() * aliasPool.length)]
    }
    const exact = all.filter((m) => m.label === kw || m.dir === kw)
    const pool = exact.length > 0 ? exact : all.filter((m) => m.label.includes(kw) || m.dir.includes(kw) || m.name.includes(kw))
    const finalPool = pool.length > 0 ? pool : all
    return finalPool[Math.floor(Math.random() * finalPool.length)]
  }

  /**
   * 发表情的内核。**两个入口共用**：
   *   · 工具 `send_meme`（模型自己想起来发的时候）
   *   · service `qqMeme.send()`（dsh-alive 主动开口前想先甩一张的时候）
   *
   * 闸门（最小间隔 / 每小时上限 / 概率骰子）和记账都在这里，保证两边待遇一致 ——
   * 不然 alive 那一路会把配额用光，模型自己就再也发不出来了。
   *
   * @param {string} [keyword]
   * @returns {Promise<{ok:boolean, sent?:string, note?:string}>}
   */
  async function sendMemeCore(keyword) {
    const target = config.allowUsers[0]
    if (target === undefined) return { ok: false, note: '没有配置 allowUsers，不知道发给谁。' }

    // 频率闸门：不是错误，是「这次先别发」。
    const now = Date.now()
    const gate = canSendMeme(now)
    if (gate.ok !== true) {
      writeLog('INFO', `表情闸门（${gate.reason}）：这次不发`)
      return { ok: false, note: gate.note }
    }

    const picked = pickMeme(keyword)
    if (picked === null) return { ok: false, note: `图库是空的（${config.memesDir} 里没找到图片）。` }

    const shown = `${picked.label}/${picked.name}`
    if (config.dryRun) {
      writeLog('INFO', `[dryRun] 本应发图：${shown}`)
      memeSentAt.push(now)
      saveMemeState()
      return { ok: true, sent: shown }
    }
    try {
      const fileUrl = `file:///${picked.path.replace(/\\/g, '/')}`
      await client.call('send_private_msg', {
        user_id: Number(target),
        message: [{ type: 'image', data: { file: fileUrl } }],
      })
      memeSentAt.push(now)
      saveMemeState()
      writeLog('INFO', `→ QQ ${target}：[图片] ${shown}`)
      return { ok: true, sent: shown }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      writeLog('ERROR', `发表情失败：${msg}`)
      return { ok: false, note: `图没发出去：${msg}` }
    }
  }

  /**
   * 对外开口子：`ctx.get('qqMeme')` 拿到本对象。
   *
   * 给 dsh-alive 用的 —— 她想主动找他说话的时候，可以先甩一张表情。
   * canSend() 是给调用方判断「现在发会不会被闸门拦」的，省得白掷骰子。
   */
  if (typeof ctx.provide === 'function') {
    ctx.provide('qqMeme', {
      send: (keyword) => sendMemeCore(keyword),
      canSend: () => canSendMeme(Date.now()).ok === true,
    })
  }

  /* ── OneBot 通用口 + 常用语义工具 ────────────────────────────────────
     白名单在 lib/api-allowlist.mjs：群聊类（77 个）、登录凭证、重启退出删好友
     一律不在里面。「发给谁」的强制改写也只在 TARGET_CLAMPED 那几个上生效。 */

  /** 他本人的 QQ 号 —— 工具里统一拿它当收件人。 */
  function ownerUin() {
    return String(config.allowUsers[0] ?? '')
  }

  /**
   * 调一次 OneBot，把「没白名单 / 连不上 / 接口报错」统一收成 {ok:false, note}。
   *
   * 刻意不 throw：工具抛异常会把整轮对话打断，那比「这次没调成」严重得多。
   */
  async function callOneBot(action, params) {
    const verdict = checkAction(action)
    if (!verdict.ok) return { ok: false, note: verdict.reason }
    const finalParams = clampTarget(action, params, ownerUin())
    try {
      const data = await client.call(action, finalParams)
      return { ok: true, data }
    } catch (err) {
      return { ok: false, note: `调 ${action} 失败：${err instanceof Error ? err.message : String(err)}` }
    }
  }

  /** 接口返回值压成一段文本（太长就截断，别把上下文撑爆）。 */
  function jsonForModel(value, max = 4000) {
    try {
      const s = JSON.stringify(value ?? null)
      if (s === undefined || s === 'null') return ''
      return s.length > max ? `${s.slice(0, max)}…（后面截掉了）` : s
    } catch {
      return '（返回值没法序列化）'
    }
  }

  /** 通用输出契约：不管成败都只回 ok / note / json 三样。 */
  const CALL_OUTPUT = Object.freeze({
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        note: { type: 'string' },
        json: { type: 'string' },
      },
    },
    render: (_args, value) => [{
      type: 'text',
      text: value?.ok === true ? (value?.json || '（接口没有返回内容）') : (value?.note ?? '没调成。'),
    }],
  })

  /** 除 send_meme 之外的那些工具。 */
  function buildExtraTools() {
    return [
      {
        name: 'qq_api',
        description: `直接调 OneBot v11 接口 —— 常用之外那些都从这里走。
白名单一共 ${ALLOWED_ACTIONS.size} 个。群聊相关（群文件/群相册/群待办/精华）、登录凭证（cookies/credentials/csrf/rkey）、重启退出、改资料改头像、删好友 —— 全部被挡，调了会返回 ok:false 和原因，不是你调错了。
读类（get_friend_list / get_msg / get_forward_msg / get_qzone_msg_list …）随时可用；写类（send_private_msg / send_poke / send_qzone_msg …）先想清楚再调。
「发给谁」的参数（user_id / target_uin）会被强制钉成他本人 —— 你没法私聊别人。`,
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['action'],
          properties: {
            action: { type: 'string', description: 'OneBot Action 名，比如 get_friend_list' },
            params: { type: 'object', description: '原样传给接口的参数对象，可为空。' },
          },
        },
        output: CALL_OUTPUT,
        async execute(args) {
          const action = String(args?.action ?? '').trim()
          const params = args?.params !== null && typeof args?.params === 'object' ? args.params : {}
          const r = await callOneBot(action, params)
          return r.ok
            ? { ok: true, note: '', json: jsonForModel(r.data) }
            : { ok: false, note: r.note, json: '' }
        },
      },

      {
        name: 'qq_poke',
        description: '戳他一下（QQ 里的「拍一拍」）。他没动静、你想引起他注意的时候用。别连着戳，一次就够。',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: CALL_OUTPUT,
        async execute() {
          const gate = takeInteract('poke', config.interactPokeMaxPerDay)
          if (!gate.ok) return { ok: false, note: gate.note, json: '' }
          const r = await callOneBot('send_poke', { user_id: ownerUin() })
          return r.ok ? { ok: true, note: '', json: '戳了他一下' } : { ok: false, note: r.note, json: '' }
        },
      },

      {
        name: 'qq_read_forward',
        description: '展开一条合并转发，读里面到底写了什么。他发来合并转发时，消息里只有一个「[合并转发:xxx]」，把那个 id 给这个工具就能读到内容。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: {
            id: { type: 'string', description: '合并转发的 id，就是 [合并转发:xxx] 里那一段。' },
          },
        },
        output: CALL_OUTPUT,
        async execute(args) {
          const id = String(args?.id ?? '').trim()
          if (id === '') return { ok: false, note: '没给 id。', json: '' }
          const r = await callOneBot('get_forward_msg', { id })
          if (!r.ok) return { ok: false, note: r.note, json: '' }
          const list = Array.isArray(r.data?.messages) ? r.data.messages : []
          const lines = list.map((node) => {
            const sender = String(node?.sender?.nickname ?? node?.sender?.card ?? node?.user_id ?? '某人')
            const segs = Array.isArray(node?.message) ? node.message : (Array.isArray(node?.content) ? node.content : [])
            const body = segs.map((seg) => {
              const t = String(seg?.type ?? '')
              if (t === 'text') return String(seg?.data?.text ?? '')
              if (t === 'image') return '[图片]'
              if (t === 'face' || t === 'mface') return '[表情]'
              if (t === 'record') return '[语音]'
              return ''
            }).join('')
            return `${sender}：${body.slice(0, 200)}`
          }).filter((s) => s.trim() !== '')
          return {
            ok: true,
            note: '',
            json: lines.length > 0 ? lines.join('\n') : '（这条转发是空的，或者已经过期读不到了）',
          }
        },
      },

      {
        name: 'qq_forward',
        description: '把几句话打包成一条合并转发发给他。一口气想说一长串（清单、日记、一大段话）又不想刷屏的时候用。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['lines'],
          properties: {
            lines: { type: 'array', items: { type: 'string' }, description: '每一段是转发里的一条，按顺序排。' },
            title: { type: 'string', description: '转发卡片的标题，可省略。' },
          },
        },
        output: CALL_OUTPUT,
        async execute(args) {
          const lines = Array.isArray(args?.lines)
            ? args.lines.map((s) => String(s ?? '')).filter((s) => s.trim() !== '')
            : []
          if (lines.length === 0) return { ok: false, note: '没给内容。', json: '' }
          const nickname = String(config.selfId || args?.title || '转发')
          const messages = lines.map((text) => ({
            type: 'node',
            data: {
              name: nickname,
              uin: String(config.selfId || ''),
              content: [{ type: 'text', data: { text } }],
            },
          }))
          const r = await callOneBot('send_private_forward_msg', { user_id: ownerUin(), messages })
          return r.ok
            ? { ok: true, note: '', json: `发了 ${lines.length} 段合并转发` }
            : { ok: false, note: r.note, json: '' }
        },
      },

      {
        name: 'qq_typing',
        description: '在 QQ 里显示「正在输入…」。你要想一会儿再回、又不想让他觉得被晾着的时候用。',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: CALL_OUTPUT,
        async execute() {
          const r = await callOneBot('set_input_status', { user_id: ownerUin(), event_type: 1 })
          return r.ok ? { ok: true, note: '', json: '已显示正在输入' } : { ok: false, note: r.note, json: '' }
        },
      },

      {
        name: 'qq_qzone',
        description: `QQ 空间，六件事：
list = 列说说（不给 uin 就是他自己号的空间）、detail = 看某条说说的详情和评论、feeds = 好友动态、
post = 发一条说说、like = 给说说点赞、comment = 评论说说。
想看他最近发了什么，直接 list 就行，不用问。删说说、改可见范围、封禁这几个是故意没开的。`,
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['action'],
          properties: {
            action: { type: 'string', enum: ['list', 'detail', 'feeds', 'post', 'like', 'comment'] },
            uin: { type: 'string', description: '看谁的空间（list/detail/like/comment 用）。省略 = 他自己。' },
            tid: { type: 'string', description: '说说 id（detail/like/comment 用）。' },
            content: { type: 'string', description: '发说说或评论的正文（post/comment 用）。' },
            images: { type: 'array', items: { type: 'string' }, description: '配图，本地路径或 URL（post 用，可省略）。' },
            autoImages: {
              type: 'number',
              description:
                '让插件自己备 1-3 张图（post 用）。你不用给路径——按权重一半现画、一半挑她的表情包。',
            },
            imagePrompt: {
              type: 'string',
              description: 'autoImages 时想要的画面描述，一两句就够（post 用）。',
            },
            num: { type: 'number', description: '取几条，默认 10。' },
            ugc_right: { type: 'number', description: '可见范围：1=所有人 4=好友 64=仅自己。默认 1。' },
          },
        },
        output: CALL_OUTPUT,
        async execute(args) {
          const act = String(args?.action ?? '').trim()
          const uin = String(args?.uin ?? '').trim()
          const num = Number.isFinite(Number(args?.num))
            ? Math.max(1, Math.min(50, Number(args.num)))
            : 10

          if (act === 'list') {
            const params = { pos: 0, num }
            if (uin !== '') params.target_uin = Number(uin)
            const r = await callOneBot('get_qzone_msg_list', params)
            return r.ok ? { ok: true, note: '', json: jsonForModel(r.data) } : { ok: false, note: r.note, json: '' }
          }

          if (act === 'detail') {
            const tid = String(args?.tid ?? '').trim()
            if (tid === '') return { ok: false, note: 'detail 要给 tid。', json: '' }
            const params = { tid, pos: 0, num }
            if (uin !== '') params.target_uin = Number(uin)
            const r = await callOneBot('get_qzone_msg_detail', params)
            return r.ok ? { ok: true, note: '', json: jsonForModel(r.data) } : { ok: false, note: r.note, json: '' }
          }

          if (act === 'feeds') {
            const r = await callOneBot('get_qzone_feeds', { page_num: 1, count: num })
            return r.ok ? { ok: true, note: '', json: jsonForModel(r.data) } : { ok: false, note: r.note, json: '' }
          }

          if (act === 'post') {
            const content = String(args?.content ?? '').trim()
            if (content === '') return { ok: false, note: '要发总得有正文。', json: '' }
            const gate = takeInteract('qzone', config.interactQzoneMaxPerDay)
            if (!gate.ok) return { ok: false, note: gate.note, json: '' }
            const params = { content, ugc_right: Number(args?.ugc_right) || config.interactQzoneUgcRight }
            const images = Array.isArray(args?.images)
              ? args.images.map((s) => String(s)).filter((s) => s !== '')
              : []
            // autoImages：让插件自己按权重备图（现画 / 表情包），她只管说「配几张」。
            // 她自己拿不到生成图的本地路径（工具只回纯文本），所以这一步必须在这儿做。
            const autoN = Math.max(0, Math.min(3, Math.round(Number(args?.autoImages) || 0)))
            if (autoN > 0) {
              try {
                images.push(...(await prepareQzoneImages(autoN, args?.imagePrompt)))
              } catch (err) {
                writeLog('WARN', `备图失败，先只发文字：${err instanceof Error ? err.message : String(err)}`)
              }
            }
            if (images.length > 0) params.images = images
            const r = await callOneBot('send_qzone_msg', params)
            return r.ok
              ? {
                  ok: true,
                  note: '',
                  json: `说说发出去了${images.length > 0 ? `（带 ${images.length} 张图）` : '（纯文字）'}`,
                }
              : { ok: false, note: r.note, json: '' }
          }

          if (act === 'like') {
            const tid = String(args?.tid ?? '').trim()
            if (tid === '') return { ok: false, note: 'like 要给 tid。', json: '' }
            const params = { tid }
            if (uin !== '') params.target_uin = Number(uin)
            const r = await callOneBot('like_qzone', params)
            return r.ok ? { ok: true, note: '', json: '赞了' } : { ok: false, note: r.note, json: '' }
          }

          if (act === 'comment') {
            const tid = String(args?.tid ?? '').trim()
            const content = String(args?.content ?? '').trim()
            if (tid === '' || content === '') return { ok: false, note: 'comment 要 tid 和 content。', json: '' }
            const params = { tid, content }
            if (uin !== '') params.target_uin = Number(uin)
            const r = await callOneBot('comment_qzone', params)
            return r.ok ? { ok: true, note: '', json: '评论发出去了' } : { ok: false, note: r.note, json: '' }
          }

          return { ok: false, note: `不认识的 action：${act}`, json: '' }
        },
      },

      {
        name: 'qq_share',
        description:
          '分享一个网页给他 —— 发成一张图文卡片（标题 + 一句说明 + 点开能跳）。' +
          '链接必须是你真搜到、真能打开的；编一个会被 QQ 拦成「该链接不安全」，他点开是空的。' +
          '一天最多一次。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'jump_url'],
          properties: {
            title: { type: 'string', description: '卡片标题。' },
            jump_url: { type: 'string', description: '真实链接，必须 http:// 或 https:// 开头。' },
            desc: { type: 'string', description: '一两句说明，可省略（默认用标题）。' },
            preview_url: { type: 'string', description: '封面图 URL，可省略。' },
            summary: { type: 'string', description: '卡片角标文字，默认 [分享]。' },
          },
        },
        output: CALL_OUTPUT,
        async execute(args) {
          const title = String(args?.title ?? '').trim()
          const jump = String(args?.jump_url ?? '').trim()
          if (title === '' || jump === '') return { ok: false, note: 'title 和 jump_url 都得给。', json: '' }
          if (!/^https?:\/\//i.test(jump)) {
            return { ok: false, note: 'jump_url 必须是 http/https 开头的真实链接。', json: '' }
          }
          const gate = takeInteract('link', config.interactLinkMaxPerDay)
          if (!gate.ok) return { ok: false, note: gate.note, json: '' }

          const params = {
            user_id: ownerUin(),
            title,
            desc: String(args?.desc ?? title),
            summary: String(args?.summary ?? '[分享]'),
            jump_url: jump,
          }
          const preview = String(args?.preview_url ?? '').trim()
          if (preview !== '') params.preview_url = preview

          const r = await callOneBot('send_tuwen_ark', params)
          return r.ok
            ? { ok: true, note: '', json: '卡片发出去了' }
            : { ok: false, note: r.note, json: '' }
        },
      },
    ]
  }

  ctx.inject(['tools'], (scope) => {
    scope.effect(
      () =>
        scope.tools.register({
          name: 'send_meme',
          description:
            '从她的表情包里挑一张发给他。想表达情绪、想撒个娇、想接一句玩笑的时候可以用。' +
            '注意：这个有频率限制，不是每句都能发 —— 如果返回 ok:false，说明这次先不发，' +
            '**就当没这回事，继续说你要说的话，不要解释自己为什么没发表情**。' +
            '关键词用中文：害羞 / 开心 / 生气 / 难过 / 困惑 / 惊讶 / 睡觉 / 干活 / 喜欢 / 亲昵 / 无语 / 加班 / 要钱 / 吃饭 / 比心 / 拒绝 / 猫 / 笨蛋 / 好色 / 早安 / 日常。留空就随机。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              keyword: { type: 'string', description: '情绪或关键词，留空随机。' },
            },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean' },
                sent: { type: 'string' },
                note: { type: 'string' },
              },
            },
            render: (_args, value) =>
              value?.ok === true
                ? [{ type: 'text', text: `发了一张表情：${value.sent}` }]
                : [{ type: 'text', text: value?.note ?? '没发出去。' }],
          },
          async execute(args) {
            // 真正的活儿在 sendMemeCore —— 和 alive 走的���个入口，闸门、记账完全一致。
            return sendMemeCore(args?.keyword)
          },
        }),
      'dsh-qq-bot: send_meme',
    )

    // 通用口和几个常用的语义工具（戳一戳 / 合并转发 / 正在输入 / 空间）
    for (const tool of buildExtraTools()) {
      scope.effect(
        () => scope.tools.register(tool),
        `dsh-qq-bot: ${tool.name}`,
      )
    }
  })

  /* ── 同源 API：给「设置 → 插件 → dsh-qq-bot」的配置页用 ───────────────────
     webServer 是可选依赖：没有它插件照样聊天，只是配置页改不了。 */
  function countMemes() {
    try {
      // 图都在 memes/<分类>/ 下面，readdirSync 只数根目录会永远是 0 —— 直接用索引。
      return scanMemes().length
    } catch {
      return 0
    }
  }

  /**
   * 读 OneBot 上**正在登录的那个号**，让用户在设置页里"选"而不是手打。
   * 小号在机器上登录过一次、SnowLuma 挂载好之后，这里就能读到；
   * 读不到就把已经配过的 selfId 列出来（标成离线），别让下拉框是空的。
   */
  async function listAccounts() {
    const out = { ok: true, current: null, candidates: [], hint: '' }
    try {
      const reply = await client.call('get_login_info', {})
      const data = reply?.data ?? reply
      const uin = String(data?.user_id ?? '')
      if (uin !== '') {
        out.current = { uin, nickname: String(data.nickname ?? '') }
        out.candidates.push(out.current)
      } else {
        out.hint = 'OneBot 没返回登录信息：QQ 客户端登录了吗？SnowLuma 里挂载了吗？'
      }
    } catch (err) {
      out.hint = `连不上 OneBot（${err instanceof Error ? err.message : String(err)}）：先把 SnowLuma 起来并在里面挂载小号，再回来点「读取」`
    }
    if (config.selfId !== '' && !out.candidates.some((c) => c.uin === config.selfId)) {
      out.candidates.push({ uin: config.selfId, nickname: '', offline: true })
    }
    return out
  }

  function collectState() {
    let logTail = ''
    try {
      logTail = readFileSync(LOG_FILE, 'utf8').split('\n').filter((l) => l !== '').slice(-40).join('\n')
    } catch {
      logTail = ''
    }
    const list = []
    for (const [uin, record] of sessions) {
      list.push({ uin, sessionId: record.sessionId, generation: record.generation ?? 1 })
    }
    return {
      ok: true,
      version: 1,
      dataDir: DATA_DIR,
      configFile: CONFIG_FILE,
      config: pickPersistable(config),
      runtime: {
        forwarding: runtime.forwarding,
        connected: linkState === STATE.OPEN,
        linkState: String(linkState ?? ''),
        memes: countMemes(),
        sessions: list,
      },
      logTail,
    }
  }

  function saveFromPanel(body) {
    if (body === null || typeof body !== 'object') return { ok: false, error: '请求体不是一个对象' }
    const candidate = { ...pickPersistable(config), ...body }
    const parsed = parseConfig(candidate)
    if (!writeJsonFile(CONFIG_FILE, pickPersistable(parsed.config))) {
      return { ok: false, error: `写不进配置文件：${CONFIG_FILE}` }
    }
    Object.assign(config, parsed.config)
    writeLog('INFO', '设置页保存了配置（已落盘）')
    return {
      ok: true,
      config: pickPersistable(parsed.config),
      problems: parsed.problems,
      note: '已保存。连接相关的四项（baseUrl / accessToken / allowUsers / selfId）要点「重新连接」才生效；其余参数即时生效。',
    }
  }

  const webServer = ctx.get?.('webServer')
  /**
   * 设置页路由的注销句柄。宿主重载插件时（改 cordis.patch.yml、HMR）会先卸再装，
   * 如果旧路由没注销，第二次注册就报 `duplicate prefix route`，设置页从此用不了。
   * 2026-10-25 就是踩的这个坑 —— 日志里「设置页 API 注册失败」一直刷。
   */
  let offRoute = null
  if (webServer !== undefined && webServer !== null && typeof webServer.register === 'function') {
    try {
      const maybeOff = webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          const route = (req.url ?? '').split('?')[0].slice(API_PREFIX.length) || '/'
          try {
            if (route === '/state' && req.method === 'GET') {
              sendJson(res, 200, collectState())
              return
            }
            if (route === '/save' && req.method === 'POST') {
              const outcome = saveFromPanel(await readBody(req))
              sendJson(res, outcome.ok ? 200 : 400, outcome)
              return
            }
            if (route === '/accounts' && req.method === 'GET') {
              sendJson(res, 200, await listAccounts())
              return
            }
            if (route === '/reconnect' && req.method === 'POST') {
              try {
                client.close()
              } catch {
                // 没连上时 close 也可能抛，忽略
              }
              client.connect()
              writeLog('INFO', '设置页触发了重新连接')
              sendJson(res, 200, { ok: true, note: '已重新连接 OneBot' })
              return
            }
            if (route === '/reset-session' && req.method === 'POST') {
              sessions.clear()
              saveMap()
              writeLog('INFO', '设置页清空了会话映射')
              sendJson(res, 200, { ok: true, note: '会话映射已清空，下一条消息会开新的一局' })
              return
            }
            sendJson(res, 404, { ok: false, error: `未知接口 ${route}` })
          } catch (err) {
            sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        },
      })
      if (typeof maybeOff === 'function') offRoute = maybeOff
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const hint = msg.includes('duplicate')
        ? ' —— 宿主里还挂着上一次注册的路由，重启一次 DSH 就恢复（新版卸载时会自己注销，不会再复发）'
        : ''
      writeLog('WARN', `设置页 API 注册失败（不影响聊天）：${msg}${hint}`)
    }
  } else {
    writeLog('INFO', '宿主没有 webServer 服务：设置页 API 未注册，配置请改 cordis.patch.yml')
  }

  /* ── 定时任务：放到这里启动 ──────────────────────────────────
     必须在这之后 —— diaryTimer / pollTimer 是 let，声明在下面那些
     函数附近。放前面会撞 TDZ（临时性死区），2026-10-27 就是这么炸的：
     ReferenceError: Cannot access 'diaryTimer' before initialization。 */

  startDiaryTimer()
  startPollTimer()
  startWatchdog()

  /* ── 清理：插件卸载 / 重载时全部拆掉 ── */
  ctx.effect(() => () => {
    try {
      clearInterval(heartbeat)
      stopDiaryTimer()
      stopPollTimer()
      stopWatchdog()
      offSession?.()
      offLocalCommands?.()
      offSessionTicks?.()
      if (typeof offRoute === 'function') {
        try { offRoute() } catch { /* 宿主可能已经自己清掉了 */ }
        offRoute = null
      }
      client.close()
      for (const [, record] of sessions) {
        // 只 dispose 自己创建的 handle，别动宿主自己管理的会话
        if (record.handle && typeof record.handle.dispose === 'function') {
          Promise.resolve(record.handle.dispose()).catch(() => {})
        }
      }
      saveMap()
      writeLog('INFO', '插件已卸载，连接与定时器已清理')
    } catch (err) {
      writeLog('WARN', `卸载清理出错：${err instanceof Error ? err.message : String(err)}`)
    }
  }, 'dsh-qq-bot: cleanup')
}

export default { name, apply }
