/**
 * dsh-qq-bot 的配置解析。
 *
 * profile 里没有 @deepseek-ai/schemastery，所以这里手写默认值 + 校验，
 * 保证任何 DSH 版本、任何配置残缺的情况下插件都能安全启动。
 *
 * 设计原则：配置错了只 warn，绝不 throw —— 一个聊天插件不该让宿主起不来。
 */

/** 所有默认值集中在这里，README 里的表格与这份对象一一对应。 */
export const DEFAULTS = Object.freeze({
  /** OneBot v11 WebSocket 地址（SnowLuma 的 wsServers）。 */
  baseUrl: 'ws://127.0.0.1:3001/',
  /** SnowLuma 的 accessToken；Node 内置 WebSocket 只能走 query，插件会自动拼。 */
  accessToken: '',
  /** 只服务这些 QQ 号。空数组 = 谁都不服务（安全默认）。 */
  allowUsers: [],
  /** bot 自己的 QQ 号，用来过滤自己发的消息。 */
  selfId: '',

  /** 总开关。false = 不连接、不转发。 */
  enabled: true,
  /** true = 走到发送那一步只打日志，不真发。 */
  dryRun: false,

  /** QQ 会话专用的 DSH 会话 id 前缀。 */
  sessionIdPrefix: 'qq-',
  /** QQ 会话的工作目录（尽量和干活的工作区隔离开）。空串 = 用 DSH 默认。 */
  workspacePath: '',

  /** 限流：windowMs 内最多 max 条，超了丢弃并回一句。 */
  rateLimit: Object.freeze({ windowMs: 60_000, max: 30 }),
  /** 排队上限：上一轮还在跑时最多积压几条，超了丢最老的。 */
  maxQueue: 3,

  /** 分段规则：<= shortMax 整条发；shortMax..longMin 之间按标点切；> longMin 整条发。 */
  segment: Object.freeze({ shortMax: 25, longMin: 60, intervalMs: Object.freeze([2000, 4000]) }),

  /** 发出前的"在打字"延迟（毫秒区间）。 */
  typingDelayMs: Object.freeze([800, 2200]),

  /** 出站清洗：去掉 markdown 记号，QQ 不认这些。 */
  cleanMarkdown: true,
  /** 单条消息上限字符数，超了转合并转发（OneBot 支持时）或截断。 */
  maxCharsPerMessage: 1500,

  /** 被限流 / 被排队丢弃时回的话。空串 = 不回。 */
  rateLimitReply: '说慢点，我一条一条回。',
  busyReply: '',

  /** 断线重连：起始间隔与上限。 */
  reconnect: Object.freeze({ baseMs: 3000, maxMs: 30_000 }),

  /** 上下文用到这个百分比就自动开新对话（0 = 关掉这个功能）。 */
  contextLimitPercent: 80,
  /**
   * 拿不到模型元信息时的兜底上下文窗口。
   * deepseek-flash / deepseek-v4-pro 的真实窗口都是 1,000,000
   * （@earendil-works/pi-ai/dist/providers/data/deepseek.json）。
   * 2026-10-25 之前这里写的 128_000 是个错基数，会让换局提前十几倍触发。
   */
  contextWindow: 1_000_000,
  /** 换新对话时在 QQ 里说的那句。 */
  rolloverNotice: '上下文快满了哦，我先换个新脑子。\n这是新的一局，接着陪你。',
  /**
   * 数据目录：会话映射、控制开关、表情闸门状态、日志全放这里。
   * 空串 = 默认落到 `<用户主目录>/.dsh-qq-bot`（插件首次启动时创建）。
   * 用户想换位置就在设置页里填绝对路径。
   */
  dataDir: '',
  /** 表情包目录（send_meme 工具用）。空串 = `<dataDir>/memes`。 */
  memesDir: '',
  /** QQ 里控制 bot 的命令前缀。 */
  commandPrefix: '/qq',

  /* ── 表情包频率闸门（防止一句话一个表情包）── */
  /** 两张表情之间的最小间隔（分钟）。0 = 不限间隔。 */
  memeMinIntervalMin: 6,
  /** 每小时最多几张。 */
  memeMaxPerHour: 3,
  /** 满足间隔和配额后，再掷一次骰子；0 = 必发，1 = 永不发。 */
  memeProbability: 0.75,
});

/** 取一个正数，非法就用默认值。 */
function num(value, fallback, { min = 0 } = {}) {
  const n = Number(value)
  return Number.isFinite(n) && n >= min ? n : fallback
}

/** 取一个 [a, b] 区间。 */
function range(value, fallback) {
  if (!Array.isArray(value) || value.length !== 2) return [...fallback]
  const a = Number(value[0])
  const b = Number(value[1])
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < a) return [...fallback]
  return [a, b]
}

/** 取字符串数组，去空、去重、全部转成字符串。 */
function strList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  const out = []
  for (const v of value) {
    const s = String(v ?? '').trim()
    if (s !== '' && !out.includes(s)) out.push(s)
  }
  return out
}

/**
 * 把任意传入的配置规范化。
 * @param {unknown} raw cordis 传来的 config
 * @returns {{ config: object, problems: string[] }} 规范化配置 + 非致命问题清单
 */
export function parseConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const problems = []

  const baseUrl = typeof input.baseUrl === 'string' && input.baseUrl.trim() !== ''
    ? input.baseUrl.trim()
    : DEFAULTS.baseUrl
  if (!/^wss?:\/\//i.test(baseUrl)) problems.push(`baseUrl 不是 ws:// 或 wss://，已退回默认值（原值：${baseUrl}）`)

  const accessToken = typeof input.accessToken === 'string' ? input.accessToken.trim() : ''
  if (accessToken === '' && input.accessToken !== undefined && input.accessToken !== '') {
    problems.push('accessToken 看起来不是字符串，已按空处理')
  }

  const allowUsers = strList(input.allowUsers, DEFAULTS.allowUsers)
  if (allowUsers.length === 0) problems.push('allowUsers 为空 —— 插件不会服务任何人')

  const rateRaw = input.rateLimit !== null && typeof input.rateLimit === 'object' ? input.rateLimit : {}
  const segRaw = input.segment !== null && typeof input.segment === 'object' ? input.segment : {}

  const config = {
    baseUrl: /^wss?:\/\//i.test(baseUrl) ? baseUrl : DEFAULTS.baseUrl,
    accessToken,
    allowUsers,
    selfId: String(input.selfId ?? '').trim(),

    enabled: input.enabled !== false,
    dryRun: input.dryRun === true,

    sessionIdPrefix: typeof input.sessionIdPrefix === 'string' && input.sessionIdPrefix !== ''
      ? input.sessionIdPrefix
      : DEFAULTS.sessionIdPrefix,
    workspacePath: typeof input.workspacePath === 'string' ? input.workspacePath.trim() : '',

    rateLimit: {
      windowMs: num(rateRaw.windowMs, DEFAULTS.rateLimit.windowMs, { min: 1000 }),
      max: Math.max(1, Math.floor(num(rateRaw.max, DEFAULTS.rateLimit.max, { min: 1 }))),
    },
    maxQueue: Math.max(1, Math.floor(num(input.maxQueue, DEFAULTS.maxQueue, { min: 1 }))),

    segment: {
      shortMax: Math.max(1, Math.floor(num(segRaw.shortMax, DEFAULTS.segment.shortMax, { min: 1 }))),
      longMin: Math.max(1, Math.floor(num(segRaw.longMin, DEFAULTS.segment.longMin, { min: 1 }))),
      intervalMs: range(segRaw.intervalMs, DEFAULTS.segment.intervalMs),
    },
    typingDelayMs: range(input.typingDelayMs, DEFAULTS.typingDelayMs),

    cleanMarkdown: input.cleanMarkdown !== false,
    maxCharsPerMessage: Math.max(100, Math.floor(num(input.maxCharsPerMessage, DEFAULTS.maxCharsPerMessage, { min: 100 }))),

    rateLimitReply: typeof input.rateLimitReply === 'string' ? input.rateLimitReply : DEFAULTS.rateLimitReply,
    busyReply: typeof input.busyReply === 'string' ? input.busyReply : DEFAULTS.busyReply,

    reconnect: {
      baseMs: num(input.reconnect?.baseMs, DEFAULTS.reconnect.baseMs, { min: 500 }),
      maxMs: num(input.reconnect?.maxMs, DEFAULTS.reconnect.maxMs, { min: 1000 }),
    },

    contextLimitPercent: num(input.contextLimitPercent, DEFAULTS.contextLimitPercent, { min: 0, max: 100 }),
    contextWindow: num(input.contextWindow, DEFAULTS.contextWindow, { min: 8000, max: 2_000_000 }),
    rolloverNotice: typeof input.rolloverNotice === 'string' ? input.rolloverNotice : DEFAULTS.rolloverNotice,
    dataDir: typeof input.dataDir === 'string' ? input.dataDir.trim() : '',
    memesDir: typeof input.memesDir === 'string' && input.memesDir.trim() !== '' ? input.memesDir.trim() : '',
    commandPrefix: typeof input.commandPrefix === 'string' && input.commandPrefix.trim() !== '' ? input.commandPrefix.trim() : DEFAULTS.commandPrefix,

    memeMinIntervalMin: num(input.memeMinIntervalMin, DEFAULTS.memeMinIntervalMin, { min: 0, max: 600 }),
    memeMaxPerHour: Math.floor(num(input.memeMaxPerHour, DEFAULTS.memeMaxPerHour, { min: 1, max: 60 })),
    memeProbability: num(input.memeProbability, DEFAULTS.memeProbability, { min: 0, max: 1 }),
  }

  if (config.segment.longMin <= config.segment.shortMax) {
    problems.push('segment.longMin 不大于 shortMax，已把 longMin 拉到 shortMax + 1')
    config.segment.longMin = config.segment.shortMax + 1
  }

  return { config, problems }
}

/**
 * 拼出真正要连的 URL。
 * Node 内置 WebSocket 的构造函数只接受 (url, protocols)，不能带 header，
 * 所以 accessToken 只能走 query —— SnowLuma 认这个。
 * @param {object} config 规范化配置
 * @returns {string}
 */
export function buildSocketUrl(config) {
  const raw = config.baseUrl
  if (!config.accessToken) return raw
  const sep = raw.includes('?') ? '&' : '?'
  return `${raw}${sep}access_token=${encodeURIComponent(config.accessToken)}`
}
