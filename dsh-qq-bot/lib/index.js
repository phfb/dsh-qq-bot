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
  looksRejected,
  randomIn,
  segmentText,
  sleep,
  splitLongText,
} from './policy.mjs'
import { OneBotClient, STATE } from './onebot.mjs'

/** cordis 插件名。 */
export const name = 'dsh-qq-bot'

/** 本插件注册的消息来源标记。 */
export const SOURCE_KIND = 'qq'

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
  }
}

/**
 * 造一条 user 角色消息。
 * 不用 @deepseek-ai/dsh-llm 的 createUserMessage（profile 里没有这个包），
 * 但结构照着它来：{ id, role, content, source }，id 是 uuid 字符串。
 */
function createQqUserMessage({ text, uin, messageId, at }) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: Object.freeze({
      kind: SOURCE_KIND,
      uin: String(uin),
      qqMessageId: messageId ?? null,
      at: at ?? new Date().toISOString(),
    }),
  })
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
        Object.assign(config, parsed.config)
        if (config.memesDir === '') config.memesDir = join(DATA_DIR, 'memes')
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

  /** 拿模型的上下文窗口大小；拿不到就用配置里的兜底值。 */
  function resolveContextWindow() {
    try {
      const llm = ctx.get('llm')
      const sel = ctx.get('agentDefaultModel')?.currentSelection?.() ?? {}
      const info = llm?.resolveModelInfo?.(sel?.provider, sel?.model) ?? llm?.resolveModelInfo?.(sel) ?? llm?.resolveModelInfo?.()
      const size = Number(info?.context ?? info?.contextWindow ?? info?.contextSize)
      if (Number.isFinite(size) && size > 8000) return size
    } catch {
      // 拿不到就兜底，不抛
    }
    return config.contextWindow
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
   * 上下文快满了：在 QQ 里说一声，然后换一个全新的会话接着聊。
   * 旧会话不删（GUI 里还能翻），只是后续消息走新的。
   */
  async function rolloverSession(uin, record, usage) {
    const agents = ctx.get('agents')
    if (!agents) return false

    const gen = (Number(record.generation) || 1) + 1
    const newId = mintSessionId()
    writeLog('INFO', `上下文 ${usage.percent}%（${usage.used}/${usage.limit}），准备换新对话（第 ${gen} 局）→ ${newId}`)

    // 走同一条发送队列，保证"这一轮的回复"先出去，提醒排在它后面
    enqueueReply(uin, config.rolloverNotice)

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
    return `不认识的命令。能用的：${p} off / ${p} on / ${p} status`
  }

  for (const p of problems) writeLog('WARN', `配置：${p}`)
  writeLog('INFO', `启动 name=${name} enabled=${config.enabled} allowUsers=${JSON.stringify(config.allowUsers)} dryRun=${config.dryRun}`)
  writeLog('INFO', `数据目录：${DATA_DIR}`)

  // 首次安装的引导：没填 QQ 号就等于没启用，必须说清楚，别让人干等
  if (config.allowUsers.length === 0) {
    writeLog('WARN', '还没填你自己的 QQ 号（allowUsers 为空）—— 插件不会服务任何人。')
    writeLog('WARN', `去「设置 → 插件 → dsh-qq-bot」填上，或直接编辑 ${CONFIG_FILE}`)
  }

  // 自检：等宿主把那几个服务挂完再看一眼，把「上下文能不能量」一次说清楚。
  // 以前只会在 /qq status 里看到一句「读不到」，分不清是没挂 tokenMeter 还是没会话。
  setTimeout(() => {
    try {
      const meter = ctx.get('tokenMeter')
      const ok = meter !== null && meter !== undefined && typeof meter.measure === 'function'
      if (ok) {
        // 把分母和实际触发线一起打出来：换局提前/滞后时，一眼能看出是基数错了还是百分比错了。
        const win = resolveContextWindow()
        const trigger = Math.round((win * config.contextLimitPercent) / 100)
        writeLog('INFO', `自检：tokenMeter 就绪 —— 上下文窗口 ${win}，到 ${config.contextLimitPercent}%（${trigger} token）会自动换新局`)
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
      writeLog('INFO', `→ QQ ${uin}：${body.slice(0, 120)}`)
    } catch (err) {
      writeLog('ERROR', `发送失败（${uin}）：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 把一条回复按规则分段、延时、依次发出。 */
  async function deliverReply(uin, text) {
    const cleaned = config.cleanMarkdown ? cleanMarkdown(text) : text
    if (cleaned === '') return

    const pieces = splitLongText(cleaned, config.maxCharsPerMessage)
    /** @type {string[]} */
    const outgoing = []
    for (const piece of pieces) {
      outgoing.push(...segmentText(piece, config.segment))
    }

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
    if (text === '') {
      writeLog('INFO', `忽略空消息（可能只有图片/表情）uin=${userId}`)
      return
    }

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
        text,
        uin: userId,
        messageId: event.message_id,
        at: new Date().toISOString(),
      })
      agent.followup(message)
      writeLog('INFO', `← QQ ${userId}：${text.slice(0, 120)}（排队 ${depth + 1}）`)
    } catch (err) {
      writeLog('ERROR', `入站失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      const now = (queueDepth.get(userId) ?? 1) - 1
      if (now <= 0) queueDepth.delete(userId)
      else queueDepth.set(userId, now)
    }
  }

  /** OneBot 事件总入口。 */
  function onOneBotEvent(event) {
    try {
      if (event?.post_type !== 'message') return
      if (event?.message_type !== 'private') return
      if (event?.sub_type !== undefined && event.sub_type !== 'friend') return
      void handleInbound(event)
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

  /* ── 出站：只认映射到 QQ 的那些会话 ── */
  const offSession = ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'assistant/message') return
      const sessionId = session?.id
      if (typeof sessionId !== 'string') return

      let uin = null
      for (const [candidateUin, record] of sessions) {
        if (record.sessionId === sessionId) {
          uin = candidateUin
          break
        }
      }
      // 刚换过局：旧会话这一轮的尾巴也要能发出去
      if (uin === null) uin = legacyIds.get(sessionId)?.uin ?? null
      if (uin === null) return // 不是 QQ 会话，一个字都不发

      const text = assistantText(event)
      // 这条日志是压测换新局时踩出来的：需要能一眼看出「事件到了但文本是 0 字」，
      // 否则只会看到"她没回话"，分不清是模型没说话还是出站把他吞了。
      writeLog('INFO', `出站：${sessionId.slice(0, 13)}… 匹配 QQ ${uin}，本段 ${text.length} 字`)
      if (text !== '') enqueueReply(uin, text)

      // 一轮结束，顺手量一下上下文；快满了就换新局（异步，不挡这轮回复）。
      // 只在"这一轮真说出了话"时才考虑换局 —— 多步 agent 的中间 step 也会发
      // assistant/message（常常是空文本），在那儿换局会把本轮回复直接判死。
      if (text !== '') {
        void maybeRollover(uin, sessions.get(uin)).catch((err) => {
          writeLog('WARN', `上下文检查失败：${err instanceof Error ? err.message : String(err)}`)
        })
      }

      // 一轮结束，顺手量一下上下文；快满了就换新局（异步，不挡这轮回复）
      void maybeRollover(uin, sessions.get(uin)).catch((err) => {
        writeLog('WARN', `上下文检查失败：${err instanceof Error ? err.message : String(err)}`)
      })
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
            const target = config.allowUsers[0]
            if (target === undefined) return { ok: false, note: '没有配置 allowUsers，不知道发给谁。' }

            // 频率闸门：不是错误，是"这次先别发"。模型看到这个就当没这回事，继续说自己的话。
            const now = Date.now()
            const gate = canSendMeme(now)
            if (gate.ok !== true) {
              writeLog('INFO', `表情闸门（${gate.reason}）：这次不发`)
              return { ok: false, note: gate.note }
            }

            const picked = pickMeme(args?.keyword)
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
          },
        }),
      'dsh-qq-bot: send_meme',
    )
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

  /* ── 清理：插件卸载 / 重载时全部拆掉 ── */
  ctx.effect(() => () => {
    try {
      clearInterval(heartbeat)
      offSession?.()
      offLocalCommands?.()
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
