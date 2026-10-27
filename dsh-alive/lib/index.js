/**
 * dsh-alive —— 活人感插件。
 *
 * 她心里挂着没落地的事，到期了他还没回来，就由她自己开口说一句。
 *
 * 三条铁律：
 *   1. 每次开口必须能指回一个具体的 open loop（指不回去的不许发）
 *   2. 闸门是白名单式的：一闸不过就放弃，不补偿、不补发
 *   3. 话由主 agent 说，插件只投一条"念头"
 *
 * 它不自己连 QQ。投递目标默认是 QQ 会话，dsh-qq-bot 会把回复转发到他手机。
 *
 * @module dsh-alive
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unwatchFile, watchFile, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'

import { parseConfig } from './config.js'
import {
  buildFreeLoop,
  buildGreetingLoop,
  checkGate,
  dayKey,
  detectControl,
  extractLoopIntent,
  greetingLabelOf,
  greetingSlotOf,
  inQuietHours,
  jitterMs,
  maxAttemptsFor,
  parseTime,
  pickGreetingMinute,
  renderImpulse,
  saidGoodbyeLast,
  scoreImpulse,
  shortForLog,
  timeNoteFor,
} from './policy.mjs'
// 情绪模块：六个维度（想他 / 吃醋 / 恼火 / 暖意 / 担心 / 闲），纯函数、可单测。
// 演化规则全在那边，这个文件只负责"什么时候喂给哪个事件"。
import * as moodModule from './mood.mjs'

export const name = 'dsh-alive'

// 日志跟着 dataDir 走：apply 里会按解析出的 config.dataDir 重设（<dataDir>\logs\alive.log）。
// 下面这两个只是 apply 之前的兜底值 —— 别的地方别再写死绝对路径，2026-10-25 的自检误报
// 就是「插件写一处、脚本读另一处」引起的。
let LOG_DIR = join(homedir(), '.dsh-qq-bot', 'logs')
let LOG_FILE = join(LOG_DIR, 'alive.log')

// 设置页 API 前缀。面板画在 dsh-qq-bot 那一页里（他常开的就是那个），
// 但状态和开关归这个插件管 —— 宿主注册在同一个 webServer 上，同源 fetch 就能读。
const API_PREFIX = '/api/dsh-alive'

/**
 * 同一个 dataDir 上现在挂着几个活实例。
 *
 * 宿主重载插件时如果旧实例的 cleanup 没跑完，两份心跳会同时跑：
 * 各自演化情绪、各自抢配额、各自投递 —— 表现就是"她突然话特别多"。
 * 不在这里强行关掉谁（那会更乱），只记一条能查的日志。
 */
const LIVE_INSTANCES = new Map()

/** 好听的话 —— 在 QQ 里识别到就给她一点暖意。宁可少认，别把普通闲聊都当成哄。 */
const SWEET_RE = /(想你|想我|乖|宝贝|抱抱|抱一下|亲一下|听话|喜欢你|爱你|辛苦|好孩子|摸摸)/

/** 哪些字段允许写进 alive-config.json（就是设置窗口能改的那些）。 */
function pickConfigForFile(config) {
  return {
    enabled: config.enabled,
    dryRun: config.dryRun,
    targetSession: config.targetSession,
    selfUin: config.selfUin,
    muteEnabled: config.muteEnabled,
    softMuteEnabled: config.softMuteEnabled,
    hardMuteMin: config.hardMuteMin,
    minSilenceMin: config.minSilenceMin,
    cooldownMin: config.cooldownMin,
    maxPerHour: config.maxPerHour,
    maxPerDay: config.maxPerDay,
    threshold: config.threshold,
    maxAttempts: config.maxAttempts,
    quietHours: config.quietHours,
    deepNightHours: config.deepNightHours,
    tickMs: config.tickMs,
    staleMin: config.staleMin,
    includeRecall: config.includeRecall,
    moodFillHours: config.moodFillHours,
    moodRates: config.moodRates,
    // 涩涩那一组（两层开关 + 五个可调数字），面板改完写回文件时也要带上
    lustModeEnabled: config.lustModeEnabled,
    lustFloorPercent: config.lustFloorPercent,
    lustSelfCapPercent: config.lustSelfCapPercent,
    lustDecayHours: config.lustDecayHours,
    lustFillHours: config.lustFillHours,
    lustTeaseStepPercent: config.lustTeaseStepPercent,
    moodSnapshotIntervalMin: config.moodSnapshotIntervalMin,
    // 情绪驱动那一组（注入 / 两个豁免 / 表情概率）
    moodInjection: config.moodInjection,
    emotionBypassQuota: config.emotionBypassQuota,
    emotionBypassMaster: config.emotionBypassMaster,
    memeChancePercent: config.memeChancePercent,
    // 自发开口那一组（没有念头也能找你）
    freeTalkEnabled: config.freeTalkEnabled,
    freeTalkSilenceMin: config.freeTalkSilenceMin,
    freeTalkGapMin: config.freeTalkGapMin,
    freeTalkMoodPercent: config.freeTalkMoodPercent,
    goodnightSilenceMin: config.goodnightSilenceMin,
    greetingEnabled: config.greetingEnabled,
    greetingChancePercent: config.greetingChancePercent,
    greetingWindows: config.greetingWindows,
    dataDir: config.dataDir,
  }
}
/**
 * 日志上限：到 2MB 就把旧的滚成 alive.log.1（只留一份，更老的直接丢）。
 *
 * 为什么要它：这插件可能是 24 小时不停跑的。日志是追加写，不轮转就只会一直长；
 * 一旦哪天真出了循环报错，一天能刷几百 KB，几个月就是几十 MB —— 不是内存泄漏，
 * 但会把小机器的盘吃满，最后写不进去反而更难查。
 */
const LOG_MAX_BYTES = 2 * 1024 * 1024

function rollLogIfNeeded() {
  try {
    if (!existsSync(LOG_FILE)) return
    if (statSync(LOG_FILE).size < LOG_MAX_BYTES) return
    renameSync(LOG_FILE, `${LOG_FILE}.1`) // rename 会直接覆盖上一份 .1
  } catch {
    // 轮转失败就当没这回事，日志照写
  }
}

function writeLog(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}`
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    rollLogIfNeeded()
    appendFileSync(LOG_FILE, `${line}\n`)
  } catch {
    // 日志写不进去也不能影响运行
  }
  if (level === 'ERROR') console.error(`[dsh-alive] ${message}`)
  else if (level === 'WARN') console.warn(`[dsh-alive] ${message}`)
  else console.log(`[dsh-alive] ${message}`)
}

/** 给设置页回 JSON。 */
function sendJson(res, status, payload) {
  try {
    const body = JSON.stringify(payload)
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(body)
  } catch {
    try { res.statusCode = 500; res.end('{"ok":false}') } catch { /* 连接已经断了 */ }
  }
}

/** 读 POST 体（带 1MB 上限，别让面板把宿主内存打爆）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1_048_576) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') { resolve(null); return }
      try { resolve(JSON.parse(text)) } catch (err) { reject(new Error(`请求体不是 JSON：${err.message}`)) }
    })
    req.on('error', reject)
  })
}

/** ISO → 本地 HH:mm，面板上显示"静音到几点"用。 */
function fmtClock(value) {
  const t = parseTime(value)
  if (t === null) return ''
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 本地时间的"今天 24:00"（明天零点）。
 *  他一句"别发了"，当天剩下的时间都不再主动 —— 但第二天零点自动放开。 */
function nextLocalMidnight(at) {
  const d = new Date(at)
  d.setHours(24, 0, 0, 0)
  return d.toISOString()
}

/** 空状态。 */
function emptyState(config) {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    control: {
      enabled: config.enabled,
      mutedUntil: null,
      muteReason: null,
      hardOff: false,
      lastWasStop: false,
      lastToggleAt: null,
      lastToggleBy: 'default',
    },
    quota: {
      hourWindowStart: null,
      hourCount: 0,
      dayWindowStart: null,
      dayCount: 0,
      lastProactiveAt: null,
      consecutiveIgnored: 0,
      consecutiveReplied: 0,
    },
    mood: {
      missing: 0,
      jealousy: 0,
      annoyanceDebt: 0,
      warmth: 0,
      worry: 0,
      boredom: 0,
      lust: 0,
      // 涩涩的相位：grow = 随时间自己爬（首次就是这个），decay = 刚被挑逗过、正往回落到余温下限
      lustPhase: 'grow',
      lastWarmthAt: null,
      lastRejectedAt: null,
      lastTeasedAt: null,
    },
    rhythm: { hourly: new Array(24).fill(0), samples: 0 },
    greetings: { day: '', slots: {} },
    loops: [],
    episodes: [],
    stats: { byKind: {}, totalDelivered: 0, totalReplied: 0, abandoned: 0 },
    focus: { sessionId: null, lastHumanAt: null, lastQqAt: null, lastAssistantAt: null, lastTickAt: null, shortTerm: [] },
  }
}

/** 补齐缺失字段（老状态文件 + 新代码）。 */
function normalizeState(state, config) {
  const base = emptyState(config)
  if (state === null || typeof state !== 'object') return base
  const merged = {
    ...base,
    ...state,
    control: { ...base.control, ...(state.control ?? {}) },
    quota: { ...base.quota, ...(state.quota ?? {}) },
    mood: { ...base.mood, ...(state.mood ?? {}) },
    rhythm: { ...base.rhythm, ...(state.rhythm ?? {}) },
    focus: { ...base.focus, ...(state.focus ?? {}) },
    stats: { ...base.stats, ...(state.stats ?? {}) },
    greetings: state.greetings !== null && typeof state.greetings === 'object'
      ? {
          day: String(state.greetings.day ?? ''),
          slots: state.greetings.slots !== null && typeof state.greetings.slots === 'object'
            ? state.greetings.slots
            : {},
        }
      : base.greetings,
    loops: Array.isArray(state.loops) ? state.loops : [],
    episodes: Array.isArray(state.episodes) ? state.episodes : [],
  }
  if (!Array.isArray(merged.rhythm.hourly) || merged.rhythm.hourly.length !== 24) {
    merged.rhythm.hourly = new Array(24).fill(0)
  }
  if (!Array.isArray(merged.focus.shortTerm)) merged.focus.shortTerm = []
  return merged
}

/** 从事件里取纯文本。 */
function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
}

/**
 * @param {any} ctx
 * @param {unknown} rawConfig
 */
export function apply(ctx, rawConfig) {
  const parsedBase = parseConfig(rawConfig)

  /* 配置文件（设置窗口 tools\settings-alive.ps1 写的就是它）：优先于 cordis 里的出厂值。
     首次启动落一份基线，这样设置窗口一打开读到的就是当前真实生效值。 */
  const cfgPath = join(parsedBase.config.dataDir, 'alive-config.json')
  let savedCfg = null
  /** 读失败的原因（null = 没失败）。失败时**绝不能**拿出厂值把它覆盖掉。 */
  let cfgReadError = null
  try {
    if (existsSync(cfgPath)) savedCfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  } catch (err) {
    savedCfg = null
    cfgReadError = err instanceof Error ? err.message : String(err)
  }
  const { config, problems } = savedCfg !== null && typeof savedCfg === 'object'
    ? parseConfig({ ...(rawConfig ?? {}), ...savedCfg })
    : parsedBase
  /* 2026-10-28 修：原来读失败就静默 savedCfg=null，然后**用出厂值把用户配置覆盖掉** ——
     dryRun 被重置回 true（她彻底不开口），而且一句日志都没有，谁也查不出来。
     现在：读失败只报错、不覆盖（旧文件留着，人还能手工救）。 */
  if (cfgReadError !== null) {
    writeLog('ERROR', `配置读不出来（${cfgReadError}）—— 这次用出厂值跑，但**不会覆盖** ${cfgPath}，请手工检查那一份`)
  } else if (savedCfg === null) {
    try {
      mkdirSync(config.dataDir, { recursive: true })
      writeFileSync(cfgPath, `${JSON.stringify(pickConfigForFile(config), null, 2)}\n`, 'utf8')
    } catch { /* 写不进去不影响运行 */ }
  }

  // 日志统一落到 <dataDir>\logs，和 dsh-qq-bot、托盘、自检脚本保持同一个位置。
  LOG_DIR = join(config.dataDir, 'logs')
  LOG_FILE = join(LOG_DIR, 'alive.log')
  try { mkdirSync(LOG_DIR, { recursive: true }) } catch { /* 目录建不出来也不影响运行 */ }

  /* 同一个 dataDir 上是不是已经有一份在跑（上一次卸载没跑完 → 双心跳）。
     只记日志，不强行关旧的 —— 强行关更容易把宿主状态搞乱。 */
  const instanceToken = { at: Date.now() }
  try {
    if (LIVE_INSTANCES.has(config.dataDir)) {
      writeLog('WARN', `同一个数据目录（${config.dataDir}）上已经挂着一份 dsh-alive 了，可能上次卸载没跑完 —— 两份心跳会双倍投递，建议重启 DSH`)
    }
    LIVE_INSTANCES.set(config.dataDir, instanceToken)
  } catch { /* 忽略 */ }

  for (const p of problems) writeLog('WARN', `配置：${p}`)

  /* 设置窗口（tools\settings-alive.ps1）保存后立刻热应用，不用重启 DSH。 */
  try {
    watchFile(cfgPath, { interval: 800 }, () => {
      try {
        const next = JSON.parse(readFileSync(cfgPath, 'utf8'))
        const parsed = parseConfig({ ...(rawConfig ?? {}), ...next })
        Object.assign(config, parsed.config)
        writeLog('INFO', '配置文件变了，已热应用')
      } catch (err) {
        writeLog('WARN', `配置热载失败：${err instanceof Error ? err.message : String(err)}`)
      }
    })
    ctx.effect(() => () => {
      try { unwatchFile(cfgPath) } catch { /* 忽略 */ }
    }, 'dsh-alive: config watch')
  } catch { /* 挂不上就重载插件 */ }
  const statePath = join(config.dataDir, 'alive-state.json')
  /** 情绪快照：单独一份小文件，肉眼能看，也在 state 丢了时兜底。 */
  const moodPath = join(config.dataDir, 'alive-mood.json')
  /**
   * 首次运行标记（2026-10-26 加）。
   *
   * 这个文件**在** = 已经跑过至少一次，情绪从 alive-state.json 继承；
   * 这个文件**不在** = 本次按"第一次装"处理：七个数全归 0，alive-state.json 重写成空的。
   * 所以删掉它就是一键重置 —— 比去翻 JSON 删字段省事。
   */
  const firstRunPath = join(config.dataDir, 'Notfirstrun.md')

  /** 标记文件的人话内容（新建时写一次，之后不再动）。 */
  function firstRunMarkdown(now) {
    return [
      '# dsh-alive 首次运行标记',
      '',
      `第一次运行：${new Date(now).toISOString()}`,
      '',
      '这个文件在，就说明 dsh-alive 已经跑过至少一次：',
      '情绪七个数（想他 / 吃醋 / 暖意 / 担心 / 闲 / 涩涩 / 恼火）从 `alive-state.json` 继承，接着往上攒。',
      '',
      '**删掉这个文件 = 把插件当成第一次装**：所有情绪归 0，`alive-state.json` 会被重写成空的，重新开始攒。',
      '',
    ].join('\n')
  }

  /** @type {any} */
  let state
  /* 先判"是不是第一次跑"，再决定要不要继承 —— 不再靠"状态文件在不在"猜。 */
  let isFirstRun = false
  try {
    mkdirSync(config.dataDir, { recursive: true })
    if (existsSync(firstRunPath)) {
      // 标记在：不是第一次，下面正常继承
    } else {
      isFirstRun = true
      writeFileSync(firstRunPath, firstRunMarkdown(Date.now()), 'utf8')
      writeLog('INFO', '首次运行：七个数全从 0 起算（写了 Notfirstrun.md 做标记）')
    }
  } catch (err) {
    writeLog('WARN', `首次运行标记写不进去（不影响运行）：${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    if (isFirstRun) {
      // 第一次跑：谁都不继承，把状态文档直接重写成空的
      state = emptyState(config)
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    } else if (existsSync(statePath)) {
      state = normalizeState(JSON.parse(readFileSync(statePath, 'utf8')), config)
    } else {
      // 标记在但状态文档没了：新建一份空的（后面 save() 会把它落盘）
      state = emptyState(config)
      writeLog('WARN', '状态文件不在，新建一份空状态（情绪从 0 起算）')
    }
  } catch (err) {
    writeLog('WARN', `状态文件读不出来，按空状态启动：${err instanceof Error ? err.message : String(err)}`)
    state = emptyState(config)
  }

  /* 修历史脏数据。
     旧版本把「他说别发了」实现成 dayCount = maxPerDay，但那个计数是按 24 小时窗口滚的：
     一旦顶满，静音解除之后也还不回来（10-25 17:42 踩过 —— 那天到现在一条主动都没发出去）。
     现在这种"当天封顶"改用独立的 dayQuotaSuspendedUntil 表达，旧状态里被顶满的额度在这里一次性纠正。 */
  {
    const ctl = state.control
    if (ctl.dayQuotaSuspendedUntil === undefined) ctl.dayQuotaSuspendedUntil = null
    const count = Number(state.quota.dayCount) || 0
    const stillMuted = typeof ctl.mutedUntil === 'string' && (parseTime(ctl.mutedUntil) ?? 0) > Date.now()
    const dayQuotaBlocked = typeof ctl.dayQuotaSuspendedUntil === 'string' &&
      (parseTime(ctl.dayQuotaSuspendedUntil) ?? 0) > Date.now()
    if (!stillMuted && !dayQuotaBlocked && ctl.lastWasStop !== true && count >= config.maxPerDay) {
      state.quota.dayCount = 0
      state.quota.dayWindowStart = new Date().toISOString()
      writeLog('WARN', `修额度：旧版本把当天额度顶到了 ${count}/${config.maxPerDay}，已归零`)
    }
  }

  let saveTimer = null
  /** 目标会话唤醒失败的去重：同一个 id 十分钟只记一次，别刷日志 */
  let wakeFailId = null
  let wakeFailAt = 0
  /** "拿不到目标会话"这条也是每跳都会走到，同样十分钟只记一次 */
  let noSessionLoggedAt = 0

  /**
   * 情绪快照：每次落盘都顺手写一份，带百分比和倍率。
   * 好处是能直接打开看，而且万一 alive-state.json 被删了，下次启动还能把上次的情绪捡回来。
   */
  let lastMoodSnapKey = ''
  let lastMoodSnapAt = 0
  function saveMoodSnapshot(force = false) {
    try {
      const snap = moodModule.snapshot(state.mood, {
        rates: config.moodRates,
        fillHours: config.moodFillHours,
        lust: lustConfig(),
      })
      const key = snap.rows.map((r) => r.percent).join('/')
      const nowMs = Date.now()
      /* 快照不是每次心跳都值得写：state 里那份才是权威，快照只是给人看的。
         百分比没变、而且距上次不到 moodSnapshotIntervalMin 分钟 → 跳过。
         这个分钟数在设置窗口「其他」组里能改（默认 5，范围 1~1440），
         24 小时常开时它能把"每分钟两个文件"降到"有变化才写"。 */
      const minGapMs = Math.max(1, Number(config.moodSnapshotIntervalMin) || 5) * 60_000
      if (!force && key === lastMoodSnapKey && nowMs - lastMoodSnapAt < minGapMs) return
      const payload = {
        savedAt: new Date().toISOString(),
        fillHours: snap.fillHours,
        lustUnlocked: snap.lustUnlocked,
        lustEnabled: snap.lustEnabled,
        lust: snap.lust,
        snapshotIntervalMin: config.moodSnapshotIntervalMin,
        rates: config.moodRates,
        mood: {
          missing: Number(state.mood.missing) || 0,
          jealousy: Number(state.mood.jealousy) || 0,
          warmth: Number(state.mood.warmth) || 0,
          worry: Number(state.mood.worry) || 0,
          boredom: Number(state.mood.boredom) || 0,
          lust: Number(state.mood.lust) || 0,
          annoyanceDebt: Number(state.mood.annoyanceDebt) || 0,
          lastWarmthAt: state.mood.lastWarmthAt ?? null,
          lastRejectedAt: state.mood.lastRejectedAt ?? null,
        },
        percent: snap.rows.map((r) => ({ key: r.key, label: r.label, percent: r.percent, rate: r.rate, fillHours: r.fillHours })),
      }
      writeFileSync(moodPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      lastMoodSnapKey = key
      lastMoodSnapAt = nowMs
    } catch (err) {
      // 快照写不进去不算错：state 里那份才是权威
    }
  }

  function save(now = false) {
    if (saveTimer !== null && !now) return
    if (now) {
      if (saveTimer !== null) clearTimeout(saveTimer)
      saveTimer = null
    } else {
      saveTimer = setTimeout(() => {
        saveTimer = null
        save(true)
      }, 500)
      return
    }
    try {
      state.updatedAt = new Date().toISOString()
      // 只留最近 200 条 episode
      if (state.episodes.length > 200) state.episodes = state.episodes.slice(-200)
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      saveMoodSnapshot()
    } catch (err) {
      writeLog('WARN', `状态落盘失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /* 兜底：state 读不出来 / 第一次跑，但上次留下的情绪快照还在 —— 别让她的心情归零。 */
  if (!existsSync(statePath) && existsSync(moodPath)) {
    try {
      const snap = JSON.parse(readFileSync(moodPath, 'utf8'))
      if (snap !== null && typeof snap === 'object' && snap.mood !== null && typeof snap.mood === 'object') {
        state.mood = { ...state.mood, ...snap.mood }
        writeLog('INFO', `状态文件不在，用情绪快照（${snap.savedAt ?? '未知时间'}）恢复了上次的数值`)
      }
    } catch { /* 快照坏了就当没有 */ }
  }

  const freeTag = config.freeTalkEnabled
    ? `开（安静满 ${config.freeTalkSilenceMin} 分 / 情绪 ${config.freeTalkMoodPercent}% / 间隔 ${config.freeTalkGapMin} 分）`
    : '关'
  writeLog('INFO', `启动 enabled=${state.control.enabled} dryRun=${config.dryRun} target=${config.targetSession} 自发开口=${freeTag}`)

  /* ───────────── 采集 ───────────── */

  /**
   * 决定"主动开口"投进哪个会话。
   *   - 固定 id：配置里写死的那个，原样用。
   *   - 'auto'：跟 qq-bot 的会话映射走 —— 他在 QQ 里聊的那一局就是目标
   *             （宿主生成的是 session-<uuid>，重启也不会变）。
   *             读不到就退到"他最近说话的那个会话"；再拿不到就返回空串，
   *             这一轮不投 —— 宁可不说，也别把念头丢进一个不存在的会话。
   */
  function resolveTargetSession() {
    if (config.targetSession !== 'auto') return config.targetSession

    try {
      const mapPath = join(config.dataDir, 'qq-session-map.json')
      const raw = JSON.parse(readFileSync(mapPath, 'utf8'))
      const record = raw !== null && typeof raw === 'object' ? raw[config.selfUin] : null
      const id = record?.sessionId
      if (typeof id === 'string' && id !== '' && id.startsWith('session-')) return id
    } catch {
      // 映射文件还没有：qq-bot 还没建过会话，往下退
    }

    const focused = state?.focus?.sessionId
    if (typeof focused === 'string' && focused !== '') return focused

    return ''
  }

  /**
   * 涩涩那一组参数的现状。每次现读 config —— 面板改完存盘，下一句话就按新值走。
   */
  function lustConfig() {
    return {
      enabled: config.lustModeEnabled === true,
      floorPercent: config.lustFloorPercent,
      selfCapPercent: config.lustSelfCapPercent,
      decayHours: config.lustDecayHours,
      fillHours: config.lustFillHours,
      teaseStepPercent: config.lustTeaseStepPercent,
    }
  }

  /**
   * 挑逗识别（2026-10-26 加）。涩涩是"被对话顶上去"的，这一层就负责认这句话算不算挑逗。
   *
   * 两层开关没全亮就直接返回 —— 关着的时候连正则都不跑，更不会花 token。
   *
   * 两道闸：
   *   强信号 TEASE_STRONG_RE → 直接算，不问模型
   *   弱信号 TEASE_WEAK_RE   → 拿不准，问一次模型（temperature 0，只让回 是/否），
   *                            带 20 秒冷却，免得他连发五条就烧五次调用
   */
  const TEASE_STRONG_RE = /(亲你|吻你|舔|咬你|脱(衣服|掉|光)|裸|想上你|要你|睡你|做爱|摸摸|撩你|勾引|色色|涩涩|硬了|湿了|压你|按在|骑|含住|伸进去|插)/
  const TEASE_WEAK_RE = /(抱|腰|腿|胸|贴|蹭|暧昧|陪我|夜里|亲密|亲亲|啵|想我|宝贝|乖|撩|摸)/
  const TEASE_JUDGE_COOLDOWN_MS = 20_000
  let lastTeaseJudgeAt = 0

  /** 问一次模型：这句话算不算挑逗。拿不到模型 / 出错都当"不是"。 */
  async function judgeTease(text) {
    try {
      const llm = ctx.get('llm')
      if (!llm || typeof llm.stream !== 'function') return null
      const sel = ctx.get('agentDefaultModel')?.currentSelection?.() ?? {}
      if (typeof sel?.provider !== 'string' || typeof sel?.model !== 'string') return null
      const stream = llm.stream({
        provider: sel.provider,
        model: sel.model,
        maxTokens: 8,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            '判断一句话是不是性挑逗 / 调情：他把话往那方面带、明显在撩，算；随口一句关心、正常闲聊、说干活，不算。',
            '只回一个字：是 或 否。',
            '',
            `「${text.slice(0, 200)}」`,
          ].join('\n'),
        }],
      })
      let out = ''
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
        if (out.length > 24) break
      }
      const t = out.trim()
      if (/^(是|对|有|算|yes)/i.test(t)) return true
      if (/^(否|不是|没有|不算|no)/i.test(t)) return false
      return null
    } catch {
      return null
    }
  }

  /** 认出来就顶上去一截，日志里记一笔（他事后能看出是哪句话把数顶上去的）。 */
  function applyTease(at, source) {
    const before = Number(state.mood.lust) || 0
    moodModule.onTeased(state.mood, at, { lust: lustConfig() })
    const after = Number(state.mood.lust) || 0
    if (after > before) {
      writeLog('INFO', `挑逗（${source}）→ 涩涩 ${Math.round(before * 100)}% → ${Math.round(after * 100)}%`)
      save()
    }
  }

  async function maybeTease(text, at) {
    // 代码开关没拧开（面板里根本看不见那一组）就整段跳过，别白跑正则、更别花钱问模型
    if (!moodModule.LUST_ENABLED || config.lustModeEnabled !== true) return
    if (TEASE_STRONG_RE.test(text)) {
      applyTease(at, '强信号')
      return
    }
    if (!TEASE_WEAK_RE.test(text)) return
    if (Date.now() - lastTeaseJudgeAt < TEASE_JUDGE_COOLDOWN_MS) return
    lastTeaseJudgeAt = Date.now()
    const yes = await judgeTease(text)
    if (yes === true) applyTease(at, '模型判定')
  }

  /** 他说话了：关掉所有 loop、降欠账、更新作息。 */
  function onHumanSpeech(text, at, sessionIdFromEvent, channel) {
    // 优先用事件自带的会话 id：那才是"他此刻正在说话的那个会话"。
    // 只有拿不到时才去猜（auto 模式下的兜底）。
    const sessionId = typeof sessionIdFromEvent === 'string' && sessionIdFromEvent !== ''
      ? sessionIdFromEvent
      : resolveTargetSession()
    if (sessionId !== '') state.focus.sessionId = sessionId
    state.focus.lastHumanAt = new Date(at).toISOString()
    // 只有 QQ 里的话才算"他在跟她说话"—— 闸门 G5 认的就是这一条。
    // GUI 里他在跟 agent 干别的活，不该把她的静默期一直重置掉。
    if (channel === 'qq') state.focus.lastQqAt = new Date(at).toISOString()

    // 作息画像
    const h = new Date(at).getHours()
    state.rhythm.hourly[h] = (Number(state.rhythm.hourly[h]) || 0) + 1
    state.rhythm.samples = (Number(state.rhythm.samples) || 0) + 1

    // 短期记忆
    state.focus.shortTerm.push({ role: 'user', text: text.slice(0, 400), at: new Date(at).toISOString() })
    if (state.focus.shortTerm.length > 24) state.focus.shortTerm.splice(0, state.focus.shortTerm.length - 24)

    /* 下面这三件事全都只认 QQ 里的话：情绪回落、上一次主动的回执、关掉悬着的念头。
       他在 GUI 里跟 agent 干别的活，不等于他回到她身边 —— 老逻辑不分渠道，
       结果他在电脑前忙的时候，QQ 那边挂着的念头被悄悄关掉、想念值也被一起压下去，
       她就永远不开口（2026-10-25 晚上他亲口点掉的那条）。 */
    if (channel === 'qq') {
      // 情绪：他回来了，想念、吃醋、闲、担心一起往下掉
      moodModule.onHeCameBack(state.mood)
      // 说了句好听的 → 暖意上脸（"乖""想你""抱抱"这类）
      if (SWEET_RE.test(text)) moodModule.onSweetTalk(state.mood, at, { rates: config.moodRates })
      // 挑逗 → 涩涩往上顶（两层开关都亮才动；强信号直接算，弱信号问一次模型）
      void maybeTease(text, at)

      // 上一次主动：他回了没有
      const pending = state.episodes[state.episodes.length - 1]
      if (pending && pending.outcome === 'pending') {
        const gap = at - (parseTime(pending.at) ?? at)
        pending.outcome = 'replied'
        pending.repliedAfterSec = Math.round(gap / 1000)
        state.quota.consecutiveReplied = (Number(state.quota.consecutiveReplied) || 0) + 1
        state.quota.consecutiveIgnored = 0
        moodModule.onReplied(state.mood, { rates: config.moodRates })
        const bucket = state.stats.byKind[pending.loopKind] ?? { sent: 0, hit: 0 }
        bucket.hit = (bucket.hit ?? 0) + 1
        state.stats.byKind[pending.loopKind] = bucket
        state.stats.totalReplied = (Number(state.stats.totalReplied) || 0) + 1
        writeLog('INFO', `上次主动他回了（${pending.repliedAfterSec}s 后）`)
      }

      // 关闭 open loop
      let closed = 0
      for (const loop of state.loops) {
        if (loop.status === 'open' || loop.status === 'due' || loop.status === 'delivered') {
          loop.status = 'answered'
          loop.closedAt = new Date(at).toISOString()
          closed += 1
        }
      }
      if (closed > 0) writeLog('INFO', `他回来了，关掉 ${closed} 个悬着的事`)
    }

    // 控制词（"别发了 / 我忙完了"）：渠道不限。他在哪儿说都该听 ——
    // 哪怕是在 GUI 里说"别吵"，QQ 那边也该跟着闭嘴。
    const ctl = detectControl(text, {
      muteEnabled: config.muteEnabled,
      softMuteEnabled: config.softMuteEnabled,
      hardMuteMin: config.hardMuteMin,
    })
    if (ctl !== null) applyControl(ctl, at)

    // 抽新 loop（"别吵"之类不抽）
    if (ctl === null || ctl.action === 'unmute') {
      const intent = extractLoopIntent(text, { now: at })
      if (intent !== null && intent.confidence >= 0.55) {
        addLoop(intent, at)
      }
    }

    save()
  }

  /** 登记一个 open loop。 */
  function addLoop(intent, at) {
    const dup = state.loops.find((l) => l.status === 'open' && l.what === intent.what)
    if (dup) {
      writeLog('INFO', `同一个「${intent.what}」已经挂着，不重复建`)
      return
    }
    const soft = at + jitterMs(intent.backInMin, intent.kind)
    const loop = {
      id: `lp_${Date.now().toString(36)}_${randomUUID().slice(0, 4)}`,
      kind: intent.kind,
      what: intent.what,
      quote: intent.quote,
      createdAt: new Date(at).toISOString(),
      expectedBackAt: new Date(soft).toISOString(),
      hardDeadlineAt: new Date(soft + (intent.backInMin * 60_000)).toISOString(),
      confidence: intent.confidence,
      source: 'keyword',
      status: 'open',
      attempts: 0,
      lastAttemptAt: null,
      moodHint: intent.moodHint,
      sessionId: config.targetSession,
    }
    state.loops.push(loop)
    if (state.loops.length > 40) state.loops = state.loops.slice(-40)
    writeLog('INFO', `挂上一件事：${loop.kind}「${loop.what}」，${Math.round((soft - at) / 60000)} 分钟后到点`)
  }

  /** 应用静音 / 解静音。 */
  function applyControl(ctl, at) {
    if (ctl.action === 'mute') {
      const until = new Date(at + ctl.minutes * 60_000).toISOString()
      state.control.mutedUntil = until
      state.control.muteReason = ctl.reason
      state.control.lastWasStop = ctl.hard === true
      if (ctl.hard === true) {
        moodModule.onRejected(state.mood, at)
        // 今天剩下的时间都不主动。别用 dayCount 顶满来实现 —— 那是 24 小时滚动窗口，
        // 顶满之后就再也还不回来了，静音解除也没用（踩过，见上面修脏数据那段）。
        state.control.dayQuotaSuspendedUntil = nextLocalMidnight(at)
      }
      writeLog('INFO', `静音 ${ctl.minutes} 分钟（${ctl.reason}）${ctl.hard === true ? '，今天不再主动' : ''}`)
      return
    }
    state.control.mutedUntil = null
    state.control.muteReason = null
    state.control.lastWasStop = false
    // 他自己说"好了/聊会儿"，就是收回"别发了"，当天封顶跟着一起撤
    if (typeof state.control.dayQuotaSuspendedUntil === 'string') {
      state.control.dayQuotaSuspendedUntil = null
      writeLog('INFO', '解除静音，今日主动额度恢复')
    } else {
      writeLog('INFO', '解除静音')
    }
  }

  const offSession = ctx.on('session/event', (session, event) => {
    try {
      const at = Date.now()
      const sessionId = session?.id
      if (typeof sessionId !== 'string') return

      if (event?.type === 'user/message') {
        const kind = event.data?.source?.kind
        // 她自己的主动念头不算"他说话了"，否则会自激
        if (kind === 'proactive') return
        // 真人在 GUI 里打的（user），或者从 QQ 来的（qq）
        if (kind !== 'user' && kind !== 'qq') return
        const text = textOfContent(event.data?.content)
        if (text === '') return
        // kind: 'user' = GUI 里打的，'qq' = 从 QQ 来的。两个一定要分开记 ——
        // 他在 GUI 里跑别的活，不代表他在 QQ 里找她；混着记会让静默期永远重置，
        // 结果就是"她从来不主动"（2026-10-25 晚上的真实故障）。
        onHumanSpeech(text, at, sessionId, kind)
        return
      }

      if (event?.type === 'assistant/message') {
        const text = textOfContent(event.data?.message?.content)
        state.focus.lastAssistantAt = new Date(at).toISOString()
        if (text !== '') {
          state.focus.shortTerm.push({ role: 'assistant', text: text.slice(0, 400), at: new Date(at).toISOString() })
          if (state.focus.shortTerm.length > 24) state.focus.shortTerm.splice(0, state.focus.shortTerm.length - 24)
        }
        save()
      }
    } catch (err) {
      writeLog('ERROR', `采集失败：${err instanceof Error ? err.message : String(err)}`)
    }
  })

  /* ───────────── 心跳 ───────────── */

  /** 情绪随时间演化（真正的规则在 lib/mood.mjs，这里只负责把"过了多久"算出来）。 */
  function evolveMood(now) {
    const last = parseTime(state.focus.lastTickAt)
    if (last === null) {
      state.focus.lastTickAt = new Date(now).toISOString()
      return
    }
    const hours = Math.min(6, (now - last) / 3_600_000) // 一次最多补 6 小时，防休眠唤醒后暴涨
    if (hours <= 0) return
    const lastQq = parseTime(state.focus.lastQqAt) ?? parseTime(state.focus.lastHumanAt)
    moodModule.evolve(state.mood, hours, {
      hourOfDay: new Date(now).getHours(),
      hoursSinceQq: lastQq === null ? Infinity : (now - lastQq) / 3_600_000,
      // 速率倍率 / 满值基准都从配置来：设置窗口拖完滑条，下一跳心跳就按新倍率走
      rates: config.moodRates,
      fillHours: config.moodFillHours,
      // 涩涩自己那套（回落 / 自涨 / 封顶），跟全局基准不相干
      lust: lustConfig(),
    })
    state.focus.lastTickAt = new Date(now).toISOString()
  }

  /** 到期的 loop 能不能投。 */
  /* ── 情绪注入：让她"知道自己现在什么状态" ── */

  /** 已经注册过情绪段的 agent（agent 重建后对象会换，所以按对象存）。 */
  const moodFibers = new WeakMap()

  /** 主情绪 → 表情包关键词（发图时用）。 */
  const MEME_KEYWORD = Object.freeze({
    missing: '喜欢',
    jealousy: '生气',
    warmth: '比心',
    worry: '难过',
    boredom: '日常',
    annoyance: '拒绝',
    lust: '好色',
    calm: '日常',
  })

  /**
   * 渲染情绪段（进系统提示词）。
   *
   * 只写「现在什么状态 + 该怎么说话」，不写具体事件 —— 事件由念头负责。
   * 情绪很淡（主情绪 < 25%）时返回空串，等于不注入，省 token 也不出戏。
   */
  function renderMoodSection() {
    if (config.moodInjection !== true) return ''
    try {
      const opts = { lust: lustConfig() }
      const top = moodModule.dominant(state.mood, opts)
      if (top.key === 'calm') return ''
      const pct = Math.round((Number(top.value) || 0) * 100)
      const tone = moodModule.moodHintOf(state.mood, opts)
      const TONE_LINE = {
        clingy: '黏人、想贴着他，说话带点撒娇和「你都不理我」。',
        pouty: '在闹小脾气，句子短一点、语气冷半分，等他来哄。',
        warm: '心情很好，软、爱笑，愿意多说两句。',
        worried: '有点放不下心，会追问他的状况，语气关切但不唠叨。',
        light: '闲着没事，随口找话说，轻飘飘的那种。',
        flirty: '有点想要他，主动、直白，但不硬来 —— 看场合收敛。',
        sulky: '还堵着一口气，说话不客气但不会伤人，是闹不是骂。',
        flat: '平常状态。',
      }
      const NAME = {
        missing: '想他',
        jealousy: '吃醋',
        warmth: '暖意',
        worry: '担心',
        boredom: '闲',
        annoyance: '恼火',
        lust: '涩涩',
      }
      const label = NAME[top.key] ?? top.key

      /**
       * 涩涩主导时额外追加的一段（2026-10-27 他要的）。
       *
       * 他的原话：「多一些动作和语气词，篇幅长一点，第一人称」。
       * 只在 lust 当主情绪时加 —— 别的情绪下说一大段反而是负担。
       */
      const LUST_EXTRA =
        '→ 这种时候可以多一些动作和语气词，篇幅放长一点，用第一人称写（我的手…／声音有点…／忍不住…），别只回一句短的。'

      const lines = [
        `【你现在的心情】${label} ${pct}%（活人感插件自动给的，不必复述数字）`,
        `→ ${TONE_LINE[tone] ?? TONE_LINE.flat}`,
      ]
      if (top.key === 'lust') lines.push(LUST_EXTRA)
      return lines.join('\n')
    } catch (err) {
      // 2026-10-28：原来这里静默 return ''，情绪段渲染失败没有任何痕迹 ——
      // 表现就是「她突然没情绪了」，查无可查。每分钟最多报一次，别刷屏。
      if (Date.now() - moodRenderWarnAt > 60_000) {
        moodRenderWarnAt = Date.now()
        writeLog('WARN', `情绪段渲染失败（这一轮不注入情绪）：${err instanceof Error ? err.message : String(err)}`)
      }
      return ''
    }
  }

  /** 上次报「情绪段渲染失败」的时间：一分钟最多一条，别刷屏。 */
  let moodRenderWarnAt = 0

  /** 给这个 agent 注册情绪段（幂等；agent 重建会自动重新注册）。 */
  function ensureMoodSection(agent) {
    if (config.moodInjection !== true) return
    if (!agent || typeof agent !== 'object') return
    if (moodFibers.has(agent)) return
    if (typeof agent.ctx?.inject !== 'function') return
    try {
      const fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
        scope.systemPrompt.section({
          name: 'alive-mood',
          order: 4950,
          text: () => renderMoodSection(),
          interpolate: false,
        })
      })
      moodFibers.set(agent, fiber)
      writeLog('INFO', '已注册情绪段（她的心情会写进系统提示词）')
    } catch (err) {
      writeLog('WARN', `注册情绪段失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 这一轮可以提哪些动作给她挑。
   *
   * 注意：这里**不是**在做额度硬限制 —— 真正的额度在 qq-bot 那边，
   * 只有它知道她真调了什么。这里只回答一个问题：
   * 「现在这个情绪下，她最可能想做哪几件事」。
   * 给多了她会乱选，给少了又绑手绑脚，所以按情绪一维一维地放。
   */
  function buildInteractionMenu(now) {
    const menu = ['speak']
    const mood = state.mood
    const missing = Number(mood.missing) || 0
    const lust = Number(mood.lust) || 0
    const jealousy = Number(mood.jealousy) || 0
    const boredom = Number(mood.boredom) || 0
    const warmth = Number(mood.warmth) || 0

    // 想他 / 涩涩 / 吃醋 → 戳一下最自然，而且不用说任何话
    if (missing >= 0.3 || lust >= 0.35 || jealousy >= 0.3) menu.push('poke')

    // 表情：跟原来一样，由 memeChancePercent 说了算
    if (config.memeChancePercent > 0) menu.push('meme')

    // 凌晨发说说太怪，也容易让别人多想；分享东西同理
    const hour = new Date(now).getHours()
    const isNight = hour >= 23 || hour < 7

    // 闲得慌 / 心里暖 → 才会想发条说说
    if (!isNight && (boredom >= 0.3 || warmth >= 0.4)) menu.push('qzone')

    // 闲到发慌 → 才会去翻东西分享给他
    if (!isNight && boredom >= 0.5) menu.push('link')

    return menu
  }

  /** 本地当天 00:00 的毫秒时间戳。 */
  function startOfLocalDay(now) {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }

  /**
   * 时段问候：早上 / 中午 / 晚上，随机，不是到点必发。
   *
   * 三个要点：
   *   ① 每个窗口每天只**掷一次**骰子（rolled 标记）——
   *      要是每跳都掷，概率会累积成必然，那就成闹钟了
   *   ② 掷中之后不立刻发，排在窗口里的**随机一分钟**（七点整准时问好太假）
   *   ③ 它走自己那条路：不占说话额度、不看打分阈值
   *
   * 但它**绕不过**静音 / 深夜 / 「别发了」/ 道别闭环 ——
   * 「到点了」不是打扰他的理由。
   */
  function rollGreetings(now) {
    if (config.greetingEnabled !== true) return

    const today = dayKey(now)
    if (state.greetings.day !== today) {
      state.greetings = { day: today, slots: {} }
    }

    const slot = greetingSlotOf(now, config.greetingWindows)
    if (slot < 0) return

    const key = String(slot)
    let rec = state.greetings.slots[key]

    if (rec === undefined) {
      const hit = Math.random() * 100 < config.greetingChancePercent
      const minute = hit ? pickGreetingMinute(config.greetingWindows[slot]) : null
      const plannedAt = minute === null ? null : startOfLocalDay(now) + minute * 60_000
      state.greetings.slots[key] = { rolled: true, plannedAt, sent: false }
      if (plannedAt !== null) {
        const hh = String(new Date(plannedAt).getHours()).padStart(2, '0')
        const mm = String(new Date(plannedAt).getMinutes()).padStart(2, '0')
        writeLog('INFO', `今天「${greetingLabelOf(slot)}」这个窗口掷中了，排在 ${hh}:${mm}`)
      }
      save()
      return
    }

    if (rec.sent === true || rec.plannedAt === null) return
    if (now < rec.plannedAt) return

    // 同一条问候还没投出去就别再造了
    if (state.loops.some((l) => l.kind === 'greeting' && l.status === 'open')) return

    const loop = buildGreetingLoop(now, slot, {
      targetSession: config.targetSession,
      staleMin: config.staleMin,
    })
    state.loops.push(loop)
    if (state.loops.length > 40) state.loops = state.loops.slice(-40)
    rec.sent = true
    writeLog('INFO', `到点了，攒一条「${loop.what}」的念头`)
    save()
  }

  async function tryDeliver(now) {
    const agents = ctx.get('agents')
    if (!agents) return

    /* 2026-10-28 修：情绪段的注册原来挂在链路**末尾**（要等所有闸门都过了才走到），
       于是只要上面任何一条 return（说完晚安、拿不到目标会话…），情绪就永远注入不进去，
       而且失败也没痕迹。现在一进门先挂上：这一跳能拿到 agent 就注册，和投递成败无关。 */
    try {
      const earlyId = resolveTargetSession()
      if (earlyId !== '') {
        const earlyAgent = agents.get?.(earlyId)
        if (earlyAgent) ensureMoodSection(earlyAgent)
      }
    } catch (err) {
      writeLog('WARN', `情绪段提前注册失败（不影响投递）：${err instanceof Error ? err.message : String(err)}`)
    }

    /* 说完晚安就别再找了（2026-10-27 加的）。
       她最后一句是道别、之后他没再说话 —— 那就是闭环了。
       qq-bot 那边会把他的「晚安」吞掉（不再回），于是这里看到的就是
       「她说了晚安」结尾，正好用来判断。 */
    if (saidGoodbyeLast(state.focus.shortTerm, { now, gapMin: config.goodnightSilenceMin })) {
      // 但「早上好」这种按时段来的问候不算追着聊 —— 它是新的一天，不是旧话题的续集
      const greetingWaiting = state.loops.some((l) => l.kind === 'greeting' && l.status === 'open')
      if (!greetingWaiting) return
    }

    const sessionId = resolveTargetSession()
    if (sessionId === '') {
      // 这条每跳都会走到：24 小时跑一天就是 1440 行日志（以前会这样刷）。
      // 十分钟说一遍足够判断"她为什么一直不开口"。
      if (now - noSessionLoggedAt > 600_000) {
        noSessionLoggedAt = now
        writeLog('INFO', '拿不到目标会话（auto 模式下 qq-bot 还没建过会话），这轮不投')
      }
      return
    }

    // 会话冷着（插件重载 / 宿主重启后 agent 全被回收）就把它叫醒。
    // 不叫醒的话，"主动开口"只能在刚聊完那几分钟里工作，等于废掉一半。
    let agent = agents.get?.(sessionId)
    if (!agent) {
      const sc = ctx.get('sessionController')
      if (sc && typeof sc.resolveAgent === 'function') {
        try {
          const resolved = await sc.resolveAgent(sessionId)
          if (resolved && !('error' in resolved) && resolved.agent) {
            agent = resolved.agent
          } else {
            // 同一个 id 十分钟内只抱怨一次，别把日志刷满
            if (wakeFailId !== sessionId || now - wakeFailAt > 600_000) {
              wakeFailId = sessionId
              wakeFailAt = now
              writeLog('WARN', `目标会话 ${sessionId} 唤醒不了（${String(resolved?.error?.message ?? resolved?.error ?? 'unknown')}），这轮不投`)
            }
            return
          }
        } catch (err) {
          if (wakeFailId !== sessionId || now - wakeFailAt > 600_000) {
            wakeFailId = sessionId
            wakeFailAt = now
            writeLog('WARN', `唤醒会话失败：${err instanceof Error ? err.message : String(err)}`)
          }
          return
        }
      }
    }
    const agentExists = agent !== undefined && agent !== null
    const agentRunning = agentExists && agent.status === 'running'

    // 顺手把情绪段挂上去：这一跳拿到 agent 就注册，之后每轮 assemble 都读最新心情。
    if (agentExists) ensureMoodSection(agent)

    // 先把超期太久的 loop 作废：投过但硬到期还没回来，或者一次都没投就已经过期很久
    for (const loop of state.loops) {
      if (loop.status !== 'open' && loop.status !== 'delivered') continue
      if (now >= (parseTime(loop.hardDeadlineAt) ?? Infinity) && (Number(loop.attempts) || 0) >= 1) {
        loop.status = 'abandoned'
        state.stats.abandoned = (Number(state.stats.abandoned) || 0) + 1
        /* 2026-10-28 修：原来这里会 onIgnored（+12 恼火）+ consecutiveIgnored++（冷却 2ⁿ 翻倍）。
           问题是「他没接这句话」不等于「他无视我」—— 她发「我去洗澡了」「早安」这种根本不需要回。
           连续三次没回就攒够 45 直接触发全线禁言，这是最容易被冤枉的一条。
           现在只记 abandoned，不罚情绪、不计 ignored。 */
        writeLog('INFO', `放弃「${loop.what}」（到期没等到回应；不记作「被无视」）`)
      }
    }

    // 没到点的不算候选
    let due = state.loops.filter((l) => l.status === 'open' && now >= (parseTime(l.expectedBackAt) ?? Infinity))

    // 一条悬着的事都没有 → 看看情绪够不够自己造一条。
    //
    // 2026-10-26 晚上补的缺口：原来这里直接 return，所以「他一句"好"结束对话 →
    // 所有 loop 都关成 answered → 她一整晚一声不吭」是必然结果，想他 100% 也没用。
    // 自发念头不靠事件，靠情绪；造出来之后跟别的 loop 一样过闸门、一样打分，
    // 该被静音 / 深夜 / 配额 / 冷却拦住的时候一条都绕不过去。
    let freeLoop = null
    if (due.length === 0) {
      freeLoop = buildFreeLoop(state, config, now)
      if (freeLoop === null) return
      state.loops.push(freeLoop)
      if (state.loops.length > 40) state.loops = state.loops.slice(-40)
      due = [freeLoop]
      writeLog('INFO', `没有悬着的事，靠情绪攒出一条自发念头：${freeLoop.what}（${freeLoop.freePercent}%）`)
    }

    // 逐个过闸门 + 打分，取最高分
    /** @type {{loop:any, score:number, parts:any} | null} */
    let best = null
    /** 自发念头被拦的原因。攒着写日志 —— 面板上"为什么还不发"要用得上。 */
    const freeFailed = []
    for (const loop of due) {
      const gate = checkGate(state, config, loop, {
        now,
        agentRunning,
        agentExists,
        // 情绪驱动的豁免：只放行「配额」和（可选）「总开关」两类，
        // 深夜 / 静音 / 他说过「别发了」照旧拦 —— 那些是底线，不是额度。
        exempt: {
          // 问候是「到点了」，不是「情绪上来了」—— 它不占说话额度
          quota: config.emotionBypassQuota === true || loop.kind === 'greeting',
          master: config.emotionBypassMaster === true,
        },
      })
      if (!gate.pass) {
        if (loop === freeLoop) freeFailed.push(...gate.failed)
        continue
      }
      const { score, parts } = scoreImpulse(state, loop, config, now)
      // 问候不走打分：它该不该发由时钟和骰子决定，不是「值不值得」
      const need = loop.kind === 'greeting' ? 0 : config.threshold
      if (score < need) {
        if (loop === freeLoop) freeFailed.push(`分数 ${score} < 阈值 ${config.threshold}`)
        continue
      }
      if (best === null || score > best.score) best = { loop, score, parts }
    }
    if (best === null) {
      if (freeLoop !== null) {
        // 留着但标成 stale：这一条不投，但要让 buildFreeLoop 的 gapMin 记住"刚试过了"，
        // 否则每跳心跳都会重造一条、重算一遍、再拦一遍，日志能刷满。
        freeLoop.status = 'stale'
        freeLoop.closedAt = new Date(now).toISOString()
        freeLoop.staleReason = freeFailed.join(', ') || '分数不够'
        save()
        writeLog('INFO', `自发的念头这次没投：${freeLoop.staleReason}`)
      }
      return
    }

    const { loop, score, parts } = best
    // 自发念头没有"他说了要走"这回事，沉默的时间要从他上次在 QQ 说话算
    const silentMin = loop.kind === 'free'
      ? Math.round((now - (parseTime(state.focus.lastQqAt) ?? now)) / 60_000)
      : Math.round((now - (parseTime(loop.createdAt) ?? now)) / 60_000)
    const text = renderImpulse(loop, {
      moodHint: moodModule.moodHintOf(state.mood, { lust: lustConfig() }),
      silentMin,
      timeNote: timeNoteFor(now),
      recallNote: config.includeRecall ? recallNote(loop) : '',
      // 「主动」不只是开口：这一轮她还能戳他、发说说、分享东西
      menu: buildInteractionMenu(now),
    })

    if (config.dryRun) {
      writeLog('INFO', `[dryRun] 分数 ${score} ${JSON.stringify(parts)} 本来会投：${shortForLog(loop.what, 30)}（念头 ${[...text].length} 字）`)
      // dryRun 下也记账，但不真正 followup，避免它影响会话
      loop.status = 'due'
      loop.lastAttemptAt = new Date(now).toISOString()
      loop.dryRunAt = new Date(now).toISOString()
      loop.status = 'open'
      loop.attempts = (Number(loop.attempts) || 0) + 1
      loop.status = 'delivered'
      save()
      return
    }

    // ── 先甩一张表情？（概率可调，0 = 永不） ──
    // 掷中之后随机二选一：一半「先发图再说话」，一半「只发图，这次不说话」。
    // 表情本身还要过 qq-bot 那道闸门（最小间隔 / 每小时上限 / 概率），那边拒了就当没发生。
    let imageOnly = false
    if (config.memeChancePercent > 0) {
      const qqMeme = typeof ctx.get === 'function' ? ctx.get('qqMeme') : undefined
      if (qqMeme && typeof qqMeme.send === 'function' && Math.random() * 100 < config.memeChancePercent) {
        try {
          const topMood = moodModule.dominant(state.mood, { lust: lustConfig() })
          const sent = await qqMeme.send(MEME_KEYWORD[topMood.key] ?? '日常')
          if (sent && sent.ok === true) {
            imageOnly = Math.random() < 0.5
            writeLog('INFO', `先发了一张表情「${String(sent.sent ?? '')}」${imageOnly ? '（这次只发图）' : '（接着再说一句）'}`)
          } else {
            writeLog('INFO', `表情没发成（${String(sent?.note ?? '未知')}），照常开口`)
          }
        } catch (err) {
          writeLog('WARN', `发表情失败（不影响这次开口）：${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    // 「只发图」这一支：图已经出去了，这次不再投念头，但账要记（否则配额和冷却不会走）。
    if (imageOnly) {
      loop.attempts = (Number(loop.attempts) || 0) + 1
      loop.lastAttemptAt = new Date(now).toISOString()
      loop.status = 'delivered'
      // 问候不占说话额度（hour/day / 冷却都不算它的），只进统计
      if (loop.kind !== 'greeting') {
        state.quota.lastProactiveAt = new Date(now).toISOString()
        state.quota.hourCount = (Number(state.quota.hourCount) || 0) + 1
        state.quota.dayCount = (Number(state.quota.dayCount) || 0) + 1
      }
      state.stats.totalDelivered = (Number(state.stats.totalDelivered) || 0) + 1
      const bImg = state.stats.byKind[loop.kind] ?? { sent: 0, hit: 0 }
      bImg.sent = (bImg.sent ?? 0) + 1
      state.stats.byKind[loop.kind] = bImg
      writeLog('INFO', `只发图：${shortForLog(loop.what, 30)}（这次不投文字）`)
      save(true)
      return
    }

    if (!agent || typeof agent.followup !== 'function') {
      writeLog('WARN', `会话 ${sessionId} 拿不到 agent，这次放弃`)
      return
    }

    try {
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: Object.freeze({ kind: 'proactive', loopId: loop.id, at: new Date(now).toISOString() }),
      })
    } catch (err) {
      writeLog('ERROR', `投递失败：${err instanceof Error ? err.message : String(err)}`)
      return
    }

    // 记账
    loop.attempts = (Number(loop.attempts) || 0) + 1
    loop.lastAttemptAt = new Date(now).toISOString()
    // 投出去之后是"等回应"，不是"放弃"。次数用尽与否由闸门 G10 拦，
    // 真正的 abandoned 只在硬到期还没人回来时才标（见 tryDeliver 开头）。
    loop.status = 'delivered'

    state.quota.lastProactiveAt = new Date(now).toISOString()
    state.quota.hourCount = (Number(state.quota.hourCount) || 0) + 1
    state.quota.dayCount = (Number(state.quota.dayCount) || 0) + 1
    state.stats.totalDelivered = (Number(state.stats.totalDelivered) || 0) + 1
    const bucket = state.stats.byKind[loop.kind] ?? { sent: 0, hit: 0 }
    bucket.sent = (bucket.sent ?? 0) + 1
    state.stats.byKind[loop.kind] = bucket

    state.episodes.push({
      id: `ep_${Date.now().toString(36)}`,
      loopId: loop.id,
      loopKind: loop.kind,
      at: new Date(now).toISOString(),
      score,
      parts,
      outcome: 'pending',
      repliedAfterSec: null,
    })

    writeLog('INFO', `投递「${loop.what}」（分数 ${score}，第 ${loop.attempts} 次）`)
    save(true)
  }

  /** 记忆召回（可选）。拿不到就返回空串。 */
  function recallNote(loop) {
    try {
      const memory = ctx.get('ebbinghausMemory')
      if (!memory || typeof memory.recall !== 'function') return ''
      const hits = memory.recall(loop.quote, { top: 1 })
      const first = Array.isArray(hits) ? hits[0] : null
      const line = first?.title ?? first?.text ?? ''
      return line ? `（你们以前聊到过：${String(line).slice(0, 60)}）` : ''
    } catch {
      return ''
    }
  }

  /** 每小时 / 每天的窗口滚动。 */
  function rollWindows(now) {
    const hourStart = parseTime(state.quota.hourWindowStart)
    if (hourStart === null || now - hourStart >= 3_600_000) {
      state.quota.hourWindowStart = new Date(now).toISOString()
      state.quota.hourCount = 0
    }
    const dayStart = parseTime(state.quota.dayWindowStart)
    if (dayStart === null || now - dayStart >= 86_400_000) {
      state.quota.dayWindowStart = new Date(now).toISOString()
      state.quota.dayCount = 0
    }
    // 欠账衰减已经挪进 mood 模块（evolve 里按小时算），这里不用再算一遍
  }

  /* ───────────── 设置页 API（面板画在 dsh-qq-bot 那一页） ───────────── */

  /**
   * 自发开口为什么还没动 —— 全通了返回 null（意思是"她现在随时可以自己找话"）。
   *
   * 跟 buildFreeLoop 的判定一一对应，只是这里不造 loop、只解释原因，
   * 好让设置面板把"卡在哪一条"直接摊给他看，不用他猜。
   */
  function freeTalkBlockReason(now) {
    const lastQq = parseTime(state.focus.lastQqAt)
    if (lastQq === null) return '自发开口在待命：你还没在 QQ 里说过话，它不知道该几点算你安静了'

    const idleMin = Math.round((now - lastQq) / 60_000)
    if (idleMin < config.freeTalkSilenceMin) {
      return `自发开口还没动：你 ${idleMin} 分钟前刚在 QQ 说过话，要安静满 ${config.freeTalkSilenceMin} 分钟`
    }

    let lastFree = null
    for (const loop of state.loops) {
      if (loop?.source !== 'free') continue
      const at = parseTime(loop.createdAt)
      if (at !== null && (lastFree === null || at > lastFree)) lastFree = at
    }
    if (lastFree !== null && now - lastFree < config.freeTalkGapMin * 60_000) {
      const since = Math.round((now - lastFree) / 60_000)
      return `自发开口还没动：上次自发是 ${since} 分钟前，两次之间至少隔 ${config.freeTalkGapMin} 分钟`
    }

    // 情绪：跟 buildFreeLoop 一样取最主导的一维（涩涩要两层开关全亮）
    const lustOn = moodModule.LUST_ENABLED === true && config.lustModeEnabled === true
    const dims = [
      ['missing', '想他'],
      ['lust', '涩涩'],
      ['boredom', '闲得慌'],
      ['worry', '担心'],
      ['jealousy', '吃醋'],
    ]
    let topKey = ''
    let topLabel = ''
    let topVal = 0
    for (const [key, label] of dims) {
      if (key === 'lust' && !lustOn) continue
      const v = Number(state.mood[key]) || 0
      if (v > topVal) {
        topVal = v
        topKey = key
        topLabel = label
      }
    }
    const need = config.freeTalkMoodPercent / 100
    if (topVal < need) {
      return `自发开口还没动：情绪最高的一维是「${topLabel || topKey}」${Math.round(topVal * 100)}%，还没到 ${config.freeTalkMoodPercent}%`
    }
    return null
  }

  /** 一条人能看懂的状态快照。 */
  function collectState() {
    const now = Date.now()
    const openLoops = state.loops.filter((l) => l.status === 'open')
    const muted = typeof state.control.mutedUntil === 'string' &&
      (parseTime(state.control.mutedUntil) ?? 0) > now
    const stopUntil = parseTime(state.control.dayQuotaSuspendedUntil)
    const stopToday = stopUntil !== null && now < stopUntil
    const dayCount = Number(state.quota.dayCount) || 0
    const hourCount = Number(state.quota.hourCount) || 0
    const dayLeft = Math.max(0, config.maxPerDay - dayCount)
    const hourLeft = Math.max(0, config.maxPerHour - hourCount)

    // 现在为什么不会发 —— 把能判断的都跑一遍，面板直接摊开给他看
    const blocked = []
    /* 2026-10-28 修：原来只认 state.control.enabled（运行期开关），
       而设置页那个「启用活人感」写的是 config.enabled —— 于是那个勾选框是死的。
       现在两个都要开：config 那个是「装不装这个功能」，state 那个是「运行期临时闭嘴」。 */
    if (!config.enabled) blocked.push('总开关关着（设置页「启用活人感」没勾）')
    if (!state.control.enabled) blocked.push('运行期开关关着（说过「别吵」之类）')
    if (config.dryRun) blocked.push('dryRun 开着：只算不投')
    if (openLoops.length === 0) {
      if (config.freeTalkEnabled !== true) {
        blocked.push('没有挂着的念头，自发开口也关着（「自发开口」那组没勾）—— 要说「我去洗澡」这类话才会挂上一件')
      } else {
        const why = freeTalkBlockReason(now)
        if (why !== null) blocked.push(why)
      }
    }
    if (muted) blocked.push(`静音中，到 ${fmtClock(state.control.mutedUntil)}（${state.control.muteReason ?? '—'}）`)
    if (stopToday) blocked.push(`今天说过「别发了」，封顶到 24:00`)
    if (dayLeft <= 0) blocked.push(`今日额度用完（${dayCount}/${config.maxPerDay}）`)
    if (hourLeft <= 0) blocked.push(`本小时额度用完（${hourCount}/${config.maxPerHour}）`)
    const lastHuman = parseTime(state.focus.lastQqAt)
    if (lastHuman !== null && now - lastHuman < config.minSilenceMin * 60_000) {
      blocked.push(`你刚在 QQ 说过话，${Math.max(1, Math.ceil((config.minSilenceMin * 60_000 - (now - lastHuman)) / 60_000))} 分钟后再看`)
    }
    const lastPro = parseTime(state.quota.lastProactiveAt)
    const ignored = Math.min(Number(state.quota.consecutiveIgnored) || 0, 3)
    const cooldownMs = config.cooldownMin * 60_000 * Math.pow(2, ignored)
    if (lastPro !== null && now - lastPro < cooldownMs) {
      blocked.push(`冷却中，还要 ${Math.max(1, Math.ceil((cooldownMs - (now - lastPro)) / 60_000))} 分钟`)
    }

    return {
      ok: true,
      configFile: cfgPath,
      stateFile: statePath,
      moodFile: moodPath,
      logFile: LOG_FILE,
      config: pickConfigForFile(config),
      runtime: {
        enabled: state.control.enabled === true,
        hardOff: state.control.hardOff === true,
        muted,
        mutedUntil: state.control.mutedUntil,
        muteReason: state.control.muteReason,
        stopToday,
        dayQuotaSuspendedUntil: state.control.dayQuotaSuspendedUntil,
        dayCount,
        dayLeft,
        hourCount,
        hourLeft,
        lastProactiveAt: state.quota.lastProactiveAt,
        lastHumanAt: state.focus.lastHumanAt,
        lastQqAt: state.focus.lastQqAt,
        lastTickAt: state.focus.lastTickAt,
        openLoops: openLoops.map((l) => ({ what: l.what, kind: l.kind, at: l.expectedBackAt })),
        loopsTotal: state.loops.length,
        delivered: Number(state.stats.totalDelivered) || 0,
        replied: Number(state.stats.totalReplied) || 0,
        abandoned: Number(state.stats.abandoned) || 0,
        annoyanceDebt: Number(state.mood.annoyanceDebt) || 0,
        mood: (() => {
          const d = moodModule.dominant(state.mood, { lust: lustConfig() })
          const snap = moodModule.snapshot(state.mood, {
            rates: config.moodRates,
            fillHours: config.moodFillHours,
            lust: lustConfig(),
          })
          return {
            missing: Number(state.mood.missing) || 0,
            jealousy: Number(state.mood.jealousy) || 0,
            warmth: Number(state.mood.warmth) || 0,
            worry: Number(state.mood.worry) || 0,
            boredom: Number(state.mood.boredom) || 0,
            lust: Number(state.mood.lust) || 0,
            annoyanceDebt: Number(state.mood.annoyanceDebt) || 0,
            dominant: d.key,
            label: moodModule.labelOf(d.key),
            digest: moodModule.digest(state.mood, { lust: lustConfig() }),
            hint: moodModule.moodHintOf(state.mood, { lust: lustConfig() }),
            // 百分比 + 每条滑条的倍率 + 满值时间，设置窗口直接用
            rows: snap.rows,
            fillHours: snap.fillHours,
            lustUnlocked: snap.lustUnlocked,
            lustAvailable: snap.lustAvailable,
            lustEnabled: snap.lustEnabled,
            lustParams: snap.lust,
          }
        })(),
        targetSession: resolveTargetSession(),
      },
      blocked,
      logTail: readLogTail(20),
    }
  }

  /**
   * 日志尾巴，面板里放进收起区。
   *
   * 只从文件末尾读 32KB，不整份读进来 —— 日志跑久了可能好几 MB，
   * readFileSync 整读会在每次 /state 时把整份字符串塞进内存，24 小时面版刷起来不划算。
   */
  function readLogTail(lines) {
    try {
      if (!existsSync(LOG_FILE)) return ''
      const size = statSync(LOG_FILE).size
      if (size === 0) return ''
      const want = Math.min(32 * 1024, size)
      const start = size - want
      const buf = Buffer.allocUnsafe(want)
      const fd = openSync(LOG_FILE, 'r')
      try {
        readSync(fd, buf, 0, want, start)
      } finally {
        closeSync(fd)
      }
      let text = buf.toString('utf8')
      // 从中间切进去的时候第一行可能是半个字，扔掉
      if (start > 0) {
        const nl = text.indexOf('\n')
        if (nl >= 0) text = text.slice(nl + 1)
      }
      return text.trimEnd().split('\n').slice(-lines).join('\n')
    } catch {
      return ''
    }
  }

  /** 面板点保存：只收 pickConfigForFile 认识的字段。 */
  function saveFromPanel(body) {
    const input = body !== null && typeof body === 'object' ? body : {}
    const merged = { ...pickConfigForFile(config), ...input }
    const parsed = parseConfig(merged)
    Object.assign(config, parsed.config)
    try {
      writeFileSync(cfgPath, `${JSON.stringify(pickConfigForFile(config), null, 2)}\n`, 'utf8')
    } catch (err) {
      writeLog('WARN', `设置页保存失败：${err instanceof Error ? err.message : String(err)}`)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    // watchFile 那边还会再热应用一次，幂等，不冲突
    writeLog('INFO', '设置页保存了配置（已落盘并热应用）')
    save(true)
    return { ok: true, config: pickConfigForFile(config), problems: parsed.problems, note: '已保存，即时生效' }
  }

  /** 面板点「马上解除静音」。 */
  function doUnmute() {
    const hadStop = state.control.dayQuotaSuspendedUntil !== null && state.control.dayQuotaSuspendedUntil !== undefined
    state.control.mutedUntil = null
    state.control.muteReason = null
    state.control.lastWasStop = false
    state.control.dayQuotaSuspendedUntil = null
    state.mood.annoyanceDebt = 0
    writeLog('INFO', `设置页解除了静音${hadStop ? '（当天封顶一并撤销）' : ''}`)
    save(true)
    return { ok: true, note: hadStop ? '静音和当天封顶都撤了' : '已解除静音' }
  }

  /** 面板点「今日额度清零」：连冷却一起清，点完就能发。 */
  function resetQuota() {
    state.quota.dayCount = 0
    state.quota.dayWindowStart = new Date().toISOString()
    state.quota.hourCount = 0
    state.quota.hourWindowStart = new Date().toISOString()
    state.quota.consecutiveIgnored = 0
    state.quota.lastProactiveAt = null
    writeLog('INFO', '设置页把额度清零了（冷却也一起清）')
    save(true)
    return { ok: true, note: '今日 / 本小时额度都清零了，冷却也清了' }
  }

  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  /** 注销句柄。宿主重载插件时先卸再装，旧路由没注销会报 duplicate prefix route。 */
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
            if (route === '/unmute' && req.method === 'POST') {
              sendJson(res, 200, doUnmute())
              return
            }
            if (route === '/reset-quota' && req.method === 'POST') {
              sendJson(res, 200, resetQuota())
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
        ? ' —— 宿主里还挂着上一次注册的路由，重启一次 DSH 就恢复'
        : ''
      writeLog('WARN', `设置页 API 注册失败：${msg}${hint}`)
    }
  } else {
    writeLog('INFO', '宿主没有 webServer 服务：设置页 API 未注册')
  }

  /* ───────────── 控制文件（设置窗口 → 运行中的插件） ─────────────
     设置窗口是另一个进程，改不了这里的内存状态：直接写 alive-state.json 会被
     插件下一次 save() 冲掉。所以走一个信箱文件：
       窗口写 { cmd: 'unmute', id: '<guid>' }
       插件扫到没见过的 id 就执行，执行完把 cmd 清空、写上 doneAt 回执
       窗口轮询到 cmd 空了 = 办完了
     HTTP 那条路试过了：宿主对没有浏览器凭证的请求一律 403（qq-bot 的接口也一样），
     所以独立进程只能这么说话。 */
  const controlPath = join(config.dataDir, 'alive-control.json')
  let lastControlId = null

  function handleControlFile() {
    try {
      if (!existsSync(controlPath)) return
      const raw = JSON.parse(readFileSync(controlPath, 'utf8'))
      const cmd = typeof raw?.cmd === 'string' ? raw.cmd : ''
      const id = typeof raw?.id === 'string' ? raw.id : ''
      if (cmd === '' || id === '') return
      if (id === lastControlId) return
      lastControlId = id

      if (cmd === 'unmute') {
        doUnmute()
      } else if (cmd === 'reset-quota') {
        resetQuota()
      } else if (cmd === 'pause') {
        state.control.enabled = false
        writeLog('INFO', '设置窗口关掉了总开关')
        save(true)
      } else if (cmd === 'resume') {
        state.control.enabled = true
        writeLog('INFO', '设置窗口打开了总开关')
        save(true)
      } else {
        writeLog('WARN', `设置窗口给了个不认识的命令：${cmd}`)
        lastControlId = null
        return
      }
      try {
        writeFileSync(controlPath, `${JSON.stringify({ cmd: '', id, doneAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
      } catch { /* 回执写不进去也不影响已执行 */ }
    } catch {
      // 文件正写到一半，下一轮再看
    }
  }

  try {
    handleControlFile()
    watchFile(controlPath, { interval: 800 }, handleControlFile)
    ctx.effect(() => () => {
      try { unwatchFile(controlPath) } catch { /* 忽略 */ }
    }, 'dsh-alive: control watch')
  } catch { /* 挂不上就只能在设置窗口里改配置 */ }

  const timer = setInterval(() => {
    try {
      if (state.control.hardOff === true) return
      const now = Date.now()
      rollWindows(now)
      evolveMood(now)
      // 时段问候：到窗口里掷一次骰子、到点就攒一条念头（不占说话额度）
      rollGreetings(now)
      // 每跳都把演化后的情绪落盘：这样不管 DSH 是正常关、还是被强杀，
      // 下次启动读到的都是"关掉前最后一跳"的数值，而不是最早的快照。
      save()
      void tryDeliver(now).catch((err) => {
        writeLog('ERROR', `心跳失败：${err instanceof Error ? err.message : String(err)}`)
      })
    } catch (err) {
      writeLog('ERROR', `心跳异常：${err instanceof Error ? err.message : String(err)}`)
    }
  }, config.tickMs)

  /* ───────────── 清理 ───────────── */

  ctx.effect(() => () => {
    try {
      clearInterval(timer)
      if (saveTimer !== null) clearTimeout(saveTimer)
      offSession?.()
      if (typeof offRoute === 'function') {
        try { offRoute() } catch { /* 宿主可能已经自己清掉了 */ }
        offRoute = null
      }
      save(true)
      // 关的这一刻不管有没有变化，都强制把快照刷一遍
      saveMoodSnapshot(true)
      // 只有"我还是那个登记过的实例"才注销，别把后来者抹掉
      if (LIVE_INSTANCES.get(config.dataDir) === instanceToken) LIVE_INSTANCES.delete(config.dataDir)
      writeLog('INFO', `插件已卸载，状态和情绪已落盘（${statePath}）`)
    } catch (err) {
      writeLog('WARN', `卸载清理出错：${err instanceof Error ? err.message : String(err)}`)
    }
  }, 'dsh-alive: cleanup')

  // 卸载时给外面看一眼当前状态（调试用）
  return {
    status() {
      return {
        enabled: state.control.enabled,
        dryRun: config.dryRun,
        mutedUntil: state.control.mutedUntil,
        loops: state.loops.filter((l) => l.status === 'open').map((l) => ({ what: l.what, at: l.expectedBackAt })),
        dayCount: state.quota.dayCount,
        hourCount: state.quota.hourCount,
        debt: state.mood.annoyanceDebt,
      }
    },
  }
}

export default { name, apply }
