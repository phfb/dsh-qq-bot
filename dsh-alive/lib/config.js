/**
 * dsh-alive 的配置解析。和 dsh-qq-bot 一样：手写默认值 + 校验，配置错了只 warn，绝不 throw。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULTS = Object.freeze({
  /** 总开关（运行时真值在 alive-state.json，这里只是首次默认）。 */
  enabled: true,
  /** true = 只算不投，日志里能看到"她本来会说什么"。第一次装建议先 true。 */
  dryRun: true,

  /** 投到哪个会话。投进 QQ 会话，dsh-qq-bot 会自动发到他手机上。 */
  targetSession: 'auto',

  /** 他本人的 QQ 号（从 qq-bot 那条消息的 source.uin 兜底用）。 */
  selfUin: '',

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
    dataDir: typeof input.dataDir === 'string' && input.dataDir.trim() !== '' ? input.dataDir.trim() : DEFAULTS.dataDir,
  }

  if (config.dryRun) problems.push('dryRun=true —— 只会记录"她本来会说什么"，不会真的发')
  return { config, problems }
}
