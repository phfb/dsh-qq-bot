/**
 * dsh-alive 的配置解析。和 dsh-qq-bot 一样：手写默认值 + 校验，配置错了只 warn，绝不 throw。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_FILL_HOURS, DEFAULT_RATES, LUST_DEFAULTS, normalizeFillHours, normalizeRates } from './mood.mjs'

export const DEFAULTS = Object.freeze({
  /** 总开关（运行时真值在 alive-state.json，这里只是首次默认）。 */
  enabled: true,
  /** true = 只算不投，日志里能看到"她本来会说什么"。第一次装建议先 true。 */
  dryRun: true,

  /** 投到哪个会话。投进 QQ 会话，dsh-qq-bot 会自动发到他手机上。 */
  targetSession: 'auto',

  /** 他本人的 QQ 号（从 qq-bot 那条消息的 source.uin 兜底用）。 */
  selfUin: '',

  /** 禁言机制总开关。false = 他说"别发了"也不再静音、不封当天额度（设置页里能关）。 */
  muteEnabled: true,
  /** 软静音开关：开会 / 室友在 / 我在忙这类场景。 */
  softMuteEnabled: true,
  /** 硬静音时长（分钟）。他说"别发了"之后闭嘴多久。 */
  hardMuteMin: 120,

  /** 他刚说完话之后的静默期。 */
  minSilenceMin: 12,
  /** 两次主动之间的基础冷却，被忽略时指数退避。 */
  cooldownMin: 45,
  maxPerHour: 1,
  maxPerDay: 4,

  /** 打分阈值，达到才投。 */
  threshold: 55,
  /** 每条 loop 最多追几次（代码里再按 kind clamp 到 ≤2）。 */
  maxAttempts: 2,

  /** 完全禁言的时段（本地时间，跨午夜也支持）。 */
  quietHours: Object.freeze([]),
  /** 深夜：只放 sleep 型。 */
  deepNightHours: Object.freeze(['03:00-06:00']),

  /** 心跳间隔。 */
  tickMs: 60_000,
  /** 念头超过这么久还没投出去就作废（他多半已经不在电脑前）。 */
  staleMin: 30,

  /** 是否调用 ebbinghaus 记忆召回。第一版默认关。 */
  includeRecall: false,

  /**
   * 情绪速率的基准：1.0x 倍率下，从 0 攒到 100% 要几个小时。
   * 设置窗口里每颗滑条旁边那句"满值约 X 小时"就是它除以倍率算出来的。
   */
  moodFillHours: DEFAULT_FILL_HOURS,

  /**
   * 每个情绪维度的速率倍率（0.1x ~ 10x）。详见 lib/mood.mjs。
   * 涩涩（lust）在 LUST_SLIDER_ENABLED = false 时会被强制拉回 1.0。
   */
  moodRates: DEFAULT_RATES,

  /**
   * 涩涩（lust）mode 的那颗真开关。**默认 false**。
   *
   * 只有 lib/mood.mjs 的 LUST_ENABLED（代码开关）也亮着，面板上才会露出这一组；
   * 露出来之后勾不勾，看这一个。两层都亮才算真启用。
   */
  lustModeEnabled: LUST_DEFAULTS.enabled,
  /**
   * 余温下限（%）：事后回落到这儿就停住，不再往下掉。
   */
  lustFloorPercent: LUST_DEFAULTS.floorPercent,
  /**
   * 自涨封顶（%）：靠自己随「想他」爬，最多爬到这儿；再往上只能靠他挑逗。
   */
  lustSelfCapPercent: LUST_DEFAULTS.selfCapPercent,
  /**
   * 回落耗时（小时）：从 100% 落回余温下限要多久。这就是"事后慢慢回落"那份时间。
   */
  lustDecayHours: LUST_DEFAULTS.decayHours,
  /**
   * 自涨基准（小时）：从余温下限爬到自涨封顶要多久（想他越高爬得越快）。
   */
  lustFillHours: LUST_DEFAULTS.fillHours,
  /**
   * 单次涨幅（%）：他挑逗一次顶上去多少。
   */
  lustTeaseStepPercent: LUST_DEFAULTS.teaseStepPercent,

  /**
   * 情绪快照（alive-mood.json）最短多久写一次，单位分钟。
   * 百分比有变化仍然照旧立刻写；这个数只卡"同一组数字反复重写"的最小间隔。
   * 1 = 每跳心跳都写；1440 = 一天最多写一次。
   */
  moodSnapshotIntervalMin: 5,

  /**
   * 情绪注入：把当前情绪压成一两行进系统提示词，让她"知道自己现在什么状态"。
   *
   * 关掉的话情绪只用来打分（决定要不要主动开口），模型本身看不见 —— 说话语气不受影响。
   */
  moodInjection: true,

  /**
   * 情绪驱动能不能突破「每小时 / 每天」配额。
   *
   * 打开后，情绪顶上去时即使配额已经用完也照发；但**深夜、静音、他说过「别发了」永远守**，
   * 那些闸门跟这个开关无关。
   */
  emotionBypassQuota: true,

  /**
   * 情绪驱动能不能连 alive 总开关（enabled / hardOff）一起绕过。
   *
   * **默认关**。打开之后：你亲手关掉总开关，她情绪上来了照样会找你。
   */
  emotionBypassMaster: false,

  /**
   * 主动开口时，先甩一张表情包的概率（0-100，0 = 永不）。
   *
   * 掷中之后随机二选一：一半「先发图再说文字」，一半「只发图不说话」。
   * 表情本身还要过 qq-bot 那道频率闸门（最小间隔 / 每小时上限 / 概率）。
   */
  memeChancePercent: 40,

  /**
   * 自发开口总开关。
   *
   * 原来整条投递链只认「悬着的事」（open loop），而没有 loop 就永远不开口。
   * 打开这个之后：他安安静静待着、情绪攒够了，她也能自己找话。
   */
  freeTalkEnabled: true,
  /** 他在 QQ 里安静多久，才允许自发开口（分钟）。 */
  freeTalkSilenceMin: 15,
  /** 两次自发之间至少隔多久（分钟）。自发比"他说要走"更轻，别太密。 */
  freeTalkGapMin: 45,
  /** 最主导的那一维情绪到这个百分比，才够自发开口的劲。 */
  freeTalkMoodPercent: 45,

  /**
   * 「想他」到多少百分比，才给她开「去翻他空间」这个动作。
   *
   * 翻说说是**只读**的：看了不一定要说话，但翻了才有的说。
   * 所以门槛比自发开口（45）低一点。设 100 = 关掉这个动作。
   */
  qzoneReadMissingPercent: 35,

  /**
   * 说完晚安之后，多久之内不再主动（分钟）。
   *
   * 她最后一句是道别、之后他没再说话 —— 那就是闭环了，别追着聊。
   * 默认 600 分钟（10 小时）：一句话封住整晚，天亮他说话了自然恢复。
   */
  goodnightSilenceMin: 600,

  /**
   * 时段问候（早上 / 中午 / 晚上）。
   *
   * 它跟情绪驱动是两条路：这条是「到点了」，那条是「憋不住了」。
   * 所以它**不占说话额度**（小时/天/冷却都不算它的），只过底线闸门。
   * 而且每天每个窗口先掷一次骰子 —— 不是到点必发。
   */
  greetingEnabled: true,
  /** 每个窗口掷中的概率（%）。35 = 三次里大概一次。 */
  greetingChancePercent: 35,
  /** 问候窗口，本地时间。每天每个窗口最多一次。 */
  greetingWindows: Object.freeze(['07:00-09:00', '11:30-13:00', '18:00-20:00']),

  /** 状态文件目录。写死，别用 volatile。 */
  dataDir: join(homedir(), '.dsh-qq-bot'),
})

function num(v, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function strArray(v, fallback) {
  if (!Array.isArray(v)) return [...fallback]
  return v.map((x) => String(x).trim()).filter((x) => x !== '')
}

/**
 * @param {unknown} raw
 * @returns {{config: object, problems: string[]}}
 */
export function parseConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const problems = []

  const targetSession = typeof input.targetSession === 'string' && input.targetSession.trim() !== ''
    ? input.targetSession.trim()
    : DEFAULTS.targetSession
  if (!/^[A-Za-z0-9_-]+$/.test(targetSession)) {
    problems.push(`targetSession 看起来不像会话 id（${targetSession}），请确认是不是 qq-<你的QQ号>`)
  }

  const threshold = num(input.threshold, DEFAULTS.threshold, { min: 0, max: 100 })
  const config = {
    enabled: input.enabled !== false,
    dryRun: input.dryRun !== false, // 注意：默认 true，必须显式写 false 才真发
    targetSession,
    selfUin: String(input.selfUin ?? DEFAULTS.selfUin).trim(),

    muteEnabled: input.muteEnabled !== false,
    softMuteEnabled: input.softMuteEnabled !== false,
    hardMuteMin: num(input.hardMuteMin, DEFAULTS.hardMuteMin, { min: 5, max: 1440 }),

    minSilenceMin: num(input.minSilenceMin, DEFAULTS.minSilenceMin, { min: 1, max: 600 }),
    cooldownMin: num(input.cooldownMin, DEFAULTS.cooldownMin, { min: 1, max: 720 }),
    maxPerHour: Math.floor(num(input.maxPerHour, DEFAULTS.maxPerHour, { min: 1, max: 20 })),
    maxPerDay: Math.floor(num(input.maxPerDay, DEFAULTS.maxPerDay, { min: 1, max: 50 })),

    threshold,
    maxAttempts: Math.floor(num(input.maxAttempts, DEFAULTS.maxAttempts, { min: 1, max: 2 })),

    quietHours: strArray(input.quietHours, DEFAULTS.quietHours),
    deepNightHours: strArray(input.deepNightHours, DEFAULTS.deepNightHours),

    tickMs: num(input.tickMs, DEFAULTS.tickMs, { min: 10_000, max: 600_000 }),
    staleMin: num(input.staleMin, DEFAULTS.staleMin, { min: 5, max: 600 }),
    includeRecall: input.includeRecall === true,
    moodFillHours: normalizeFillHours(input.moodFillHours),
    moodRates: normalizeRates(input.moodRates),
    lustModeEnabled: input.lustModeEnabled === true,
    lustFloorPercent: num(input.lustFloorPercent, DEFAULTS.lustFloorPercent, { min: 0, max: 100 }),
    lustSelfCapPercent: num(input.lustSelfCapPercent, DEFAULTS.lustSelfCapPercent, { min: 0, max: 100 }),
    lustDecayHours: num(input.lustDecayHours, DEFAULTS.lustDecayHours, { min: 0.1, max: 240 }),
    lustFillHours: num(input.lustFillHours, DEFAULTS.lustFillHours, { min: 0.1, max: 240 }),
    lustTeaseStepPercent: num(input.lustTeaseStepPercent, DEFAULTS.lustTeaseStepPercent, { min: 0, max: 100 }),
    moodSnapshotIntervalMin: Math.round(num(input.moodSnapshotIntervalMin, DEFAULTS.moodSnapshotIntervalMin, { min: 1, max: 1440 })),
    moodInjection: input.moodInjection !== false,
    emotionBypassQuota: input.emotionBypassQuota !== false,
    emotionBypassMaster: input.emotionBypassMaster === true,
    memeChancePercent: num(input.memeChancePercent, DEFAULTS.memeChancePercent, { min: 0, max: 100 }),
    freeTalkEnabled: input.freeTalkEnabled !== false,
    freeTalkSilenceMin: num(input.freeTalkSilenceMin, DEFAULTS.freeTalkSilenceMin, { min: 1, max: 600 }),
    freeTalkGapMin: num(input.freeTalkGapMin, DEFAULTS.freeTalkGapMin, { min: 1, max: 1440 }),
    freeTalkMoodPercent: num(input.freeTalkMoodPercent, DEFAULTS.freeTalkMoodPercent, { min: 0, max: 100 }),
    qzoneReadMissingPercent: num(input.qzoneReadMissingPercent, DEFAULTS.qzoneReadMissingPercent, { min: 0, max: 100 }),
    goodnightSilenceMin: num(input.goodnightSilenceMin, DEFAULTS.goodnightSilenceMin, { min: 10, max: 1440 }),
    greetingEnabled: input.greetingEnabled !== false,
    greetingChancePercent: num(input.greetingChancePercent, DEFAULTS.greetingChancePercent, { min: 0, max: 100 }),
    greetingWindows: strArray(input.greetingWindows, DEFAULTS.greetingWindows),
    dataDir: typeof input.dataDir === 'string' && input.dataDir.trim() !== '' ? input.dataDir.trim() : DEFAULTS.dataDir,
  }

  if (config.dryRun) problems.push('dryRun=true —— 只会记录"她本来会说什么"，不会真的发')
  return { config, problems }
}
