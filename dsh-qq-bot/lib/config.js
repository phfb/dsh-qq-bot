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

  /**
   * 分段规则（2026-10-27 统一，**别再加字数档位**）。
   *
   *   工作内容（[[整条]] 或自动认出代码块/列表/表格/命令）→ 整条发
   *   其他一切 → 按实际语意停顿分条（换行 > 句末标点 > 逗号 > 语气词），多长都切
   *
   * `shortMax` / `longMin` 已经**彻底退出逻辑**：这条规则被他改过三轮
   * （60 字合并 → 25 字整条 → 取消区间），两个字段留着只为不炸老配置文件，
   * 读进来也不会影响任何切分。
   *
   * 真正还会用的只有 `intervalMs`：两条之间的停顿（像人在打字）。
   */
  segment: Object.freeze({ shortMax: 25, longMin: 60, intervalMs: Object.freeze([2000, 4000]) }),

  /**
   * 非特殊必要场景不用句号收尾。
   * 开着的时候，每条消息发出去之前会把结尾的「。」抹掉（问号 / 感叹号 / 省略号不动）。
   */
  stripTrailingPeriod: true,

  /**
   * 聊正事 / 干活时整条发，不分条（2026-10-25 晚上加）。
   * 两条通道：回复以 [[整条]] 开头；或者内容像正事（代码围栏、三行以上列表、
   * 表格、命令行清单）。命中就整条发 —— 清单被切成三段反而看不清，也慢。
   */
  mergeOnWork: true,

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

  /* ── 入站图片（2026-10-25 加）── */
  /** 总开关：收到图片时下载、存本地、交给模型看、记索引。关掉就退回原来的「[图片]」占位。 */
  imageEnabled: true,
  /** 图片目录。空串 = `<dataDir>/images`。 */
  imageDir: '',
  /**
   * 缓存上限（MB）。超出就从最老的开始删。
   * 允许范围 512 MB ~ 6144 MB（6 GB）—— 再小会连一天的图都存不下，再大不如直接换块盘。
   */
  imageCacheLimitMB: 2048,
  /** 一次清理掉多少（MB）。他定的是 300：超一点点就删 300，不会把图库清空。 */
  imageCachePurgeMB: 300,
  /** 单张图片存盘上限（MB），超了不存（防那种几十兆的长图把盘吃满）。 */
  imageMaxMB: 20,
  /** 单张下载超时（毫秒）。腾讯图床偶尔很慢，别让她等太久。 */
  imageTimeoutMs: 20_000,

  /* ── 表情包频率闸门（防止一句话一个表情包）── */
  /** 两张表情之间的最小间隔（分钟）。0 = 不限间隔。 */
  memeMinIntervalMin: 6,
  /** 每小时最多几张。 */
  memeMaxPerHour: 3,
  /** 满足间隔和配额后，再掷一次骰子；0 = 必发，1 = 永不发。 */
  memeProbability: 0.75,

  /* ── 「小动作」的每日额度（2026-10-26 加的）──────────────────────────
     戳一戳 / 发说说 / 分享链接，这三样不走说话的额度，各记各的。
     0 = 关掉这一项。
     说说那条尤其要小：它是所有人可见的，等于替他在社交圈发言。 */
  /** 一天最多戳几次。 */
  interactPokeMaxPerDay: 5,
  /** 一天最多发几条说说。 */
  interactQzoneMaxPerDay: 1,
  /** 一天最多分享几个链接卡片。 */
  interactLinkMaxPerDay: 1,
  /** 主动发的说说默认给谁看：1=所有人 4=好友 64=仅自己。 */
  interactQzoneUgcRight: 1,

  /* ── 每日说说（日记）2026-10-27 ─────────────────────────────── */

  /**
   * 到点让她写一篇日记发到说说。
   *
   * **默认关**：说说所有人可见，等于替用户在自己的社交圈发言。开源给别人装的时候
   * 默认就自动发动态太冒犯 —— 要用的自己去设置里打开。
   */
  qzoneDiaryEnabled: false,
  /** 每天大概几点写（HH:MM）。实际会在下面的窗口里随机挑一分钟，别太机械。 */
  qzoneDiaryTime: '18:00',
  /** 时间窗口（分钟）：在上面那个时间点之后的这段时间里随机触发一次。 */
  qzoneDiaryWindowMinutes: 60,
  /** 日记字数下限。太短不发（那是糊弄），记一条日志就跳过。 */
  qzoneDiaryMinChars: 80,
  /** 日记字数上限。超了让插件截断 —— 说说太长没人看。 */
  qzoneDiaryMaxChars: 2000,
  /** 配几张图（0-3）。0 = 纯文字。 */
  qzoneDiaryImageCount: 2,
  /**
   * 0-100：配图里「现画」的比例，剩下走她自己的表情包。
   *
   * 50 = 一半一半。写 0 就是全用表情包（不花钱、最快），写 100 就全现画。
   */
  qzoneImageGenWeight: 50,

  /* ── 说说互动轮询（2026-10-27）─────────────────────────────────
     只在「想他 / 吃醋」压到阈值以上才干活 —— 情绪不高的时候跑去翻他空间，
     那不是她，那是监控。所以她心情不够就什么都不做，一次 API 都不调。 */

  /** 总开关。默认关（跟日记一样，开源装的人自己去开）。 */
  qzonePollEnabled: false,
  /** 想他 / 吃醋（0-100）任意一个到这个数，才开始轮询。 */
  qzonePollTriggerPercent: 80,
  /** 轮询间隔（分钟）。 */
  qzonePollIntervalMinutes: 20,
  /** 只看最近几天的内容。 */
  qzonePollLookbackDays: 3,

  /**
   * 道别闭环的有效期（分钟）。
   *
   * 她说了「晚安」、他也说了「晚安」之后，这条就不再回了 —— 道别是句号。
   * 超过这么久就算新的一轮，不再拦（免得一句午睡把一整个下午都封掉）。
   */
  farewellGapMin: 180,
});

/** 图片缓存上限的允许范围（MB）：512 MB ~ 6 GB，2026-10-25 他定的。 */
export const IMAGE_LIMIT_MIN_MB = 512
export const IMAGE_LIMIT_MAX_MB = 6144

/** 取一个正数，非法就用默认值；超上限按上限算。 */
function num(value, fallback, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < min) return fallback
  return n > max ? max : n
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
    stripTrailingPeriod: input.stripTrailingPeriod !== false,
    mergeOnWork: input.mergeOnWork !== false,
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
    interactPokeMaxPerDay: Math.floor(num(input.interactPokeMaxPerDay, DEFAULTS.interactPokeMaxPerDay, { min: 0, max: 100 })),
    interactQzoneMaxPerDay: Math.floor(num(input.interactQzoneMaxPerDay, DEFAULTS.interactQzoneMaxPerDay, { min: 0, max: 20 })),
    interactLinkMaxPerDay: Math.floor(num(input.interactLinkMaxPerDay, DEFAULTS.interactLinkMaxPerDay, { min: 0, max: 20 })),
    interactQzoneUgcRight: Math.floor(num(input.interactQzoneUgcRight, DEFAULTS.interactQzoneUgcRight, { min: 1, max: 128 })),

    /* ── 每日说说（日记）── */
    qzoneDiaryEnabled: input.qzoneDiaryEnabled === true,
    qzoneDiaryTime: parseClock(input.qzoneDiaryTime, DEFAULTS.qzoneDiaryTime, problems),
    qzoneDiaryWindowMinutes: Math.round(
      num(input.qzoneDiaryWindowMinutes, DEFAULTS.qzoneDiaryWindowMinutes, { min: 1, max: 720 }),
    ),
    qzoneDiaryMinChars: Math.round(
      num(input.qzoneDiaryMinChars, DEFAULTS.qzoneDiaryMinChars, { min: 10, max: 2000 }),
    ),
    qzoneDiaryMaxChars: Math.round(
      num(input.qzoneDiaryMaxChars, DEFAULTS.qzoneDiaryMaxChars, { min: 100, max: 5000 }),
    ),
    qzoneDiaryImageCount: Math.round(
      num(input.qzoneDiaryImageCount, DEFAULTS.qzoneDiaryImageCount, { min: 0, max: 3 }),
    ),
    qzoneImageGenWeight: Math.round(
      num(input.qzoneImageGenWeight, DEFAULTS.qzoneImageGenWeight, { min: 0, max: 100 }),
    ),

    /* ── 说说互动轮询 ── */
    qzonePollEnabled: input.qzonePollEnabled === true,
    qzonePollTriggerPercent: Math.round(
      num(input.qzonePollTriggerPercent, DEFAULTS.qzonePollTriggerPercent, { min: 1, max: 100 }),
    ),
    qzonePollIntervalMinutes: Math.round(
      num(input.qzonePollIntervalMinutes, DEFAULTS.qzonePollIntervalMinutes, { min: 5, max: 720 }),
    ),
    qzonePollLookbackDays: Math.round(
      num(input.qzonePollLookbackDays, DEFAULTS.qzonePollLookbackDays, { min: 1, max: 30 }),
    ),
    farewellGapMin: num(input.farewellGapMin, DEFAULTS.farewellGapMin, { min: 10, max: 1440 }),

    imageEnabled: input.imageEnabled !== false,
    imageDir: typeof input.imageDir === 'string' ? input.imageDir.trim() : '',
    // 上限夹在 512 MB ~ 6 GB：这是他在 2026-10-25 明确给的范围
    imageCacheLimitMB: Math.round(num(input.imageCacheLimitMB, DEFAULTS.imageCacheLimitMB, { min: IMAGE_LIMIT_MIN_MB, max: IMAGE_LIMIT_MAX_MB })),
    // 一次清多少：至少 50 MB，最多不超过上限本身
    imageCachePurgeMB: Math.round(num(input.imageCachePurgeMB, DEFAULTS.imageCachePurgeMB, { min: 50, max: IMAGE_LIMIT_MAX_MB })),
    imageMaxMB: num(input.imageMaxMB, DEFAULTS.imageMaxMB, { min: 1, max: 200 }),
    imageTimeoutMs: num(input.imageTimeoutMs, DEFAULTS.imageTimeoutMs, { min: 2000, max: 120_000 }),
  }

  // 2026-10-27：shortMax / longMin 不再参与切分，那条互相拉扯的校验也一起去掉了。

  // 一次清理不能超过上限本身，否则一张图库里全删光比不清理更糟
  if (config.imageCachePurgeMB > config.imageCacheLimitMB) {
    problems.push(`imageCachePurgeMB（${config.imageCachePurgeMB}）大于上限 ${config.imageCacheLimitMB} MB，已压到上限`)
    config.imageCachePurgeMB = config.imageCacheLimitMB
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

/**
 * 校验 `HH:MM` 形式的时间。坏值退回默认并记一条 problem ——
 * 配置错了只 warn，绝不让插件起不来（这个文件顶上的总原则）。
 *
 * @param {unknown} value
 * @param {string} fallback 形如 '18:00'
 * @param {string[]} problems 收集问题用
 * @returns {string}
 */
function parseClock(value, fallback, problems) {
  const s = typeof value === 'string' ? value.trim() : ''
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s)
  if (m === null) {
    if (s !== '') problems.push(`时间格式不是 HH:MM，已退回 ${fallback}（原值：${s}）`)
    return fallback
  }
  return `${String(m[1]).padStart(2, '0')}:${m[2]}`
}
