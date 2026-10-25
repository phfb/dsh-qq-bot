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

import { appendFileSync, existsSync, mkdirSync, readFileSync, unwatchFile, watchFile, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'

import { parseConfig } from './config.js'
import {
  checkGate,
  detectControl,
  extractLoopIntent,
  inQuietHours,
  jitterMs,
  maxAttemptsFor,
  parseTime,
  renderImpulse,
  scoreImpulse,
  shortForLog,
  timeNoteFor,
} from './policy.mjs'

export const name = 'dsh-alive'

// 日志跟着 dataDir 走：apply 里会按解析出的 config.dataDir 重设（<dataDir>\logs\alive.log）。
// 下面这两个只是 apply 之前的兜底值 —— 别的地方别再写死绝对路径，2026-10-25 的自检误报
// 就是「插件写一处、脚本读另一处」引起的。
let LOG_DIR = join(homedir(), '.dsh-qq-bot', 'logs')
let LOG_FILE = join(LOG_DIR, 'alive.log')

/** 哪些字段允许写进 alive-config.json（就是设置窗口能改的那些）。 */
function pickConfigForFile(config) {
  return {
    enabled: config.enabled,
    dryRun: config.dryRun,
    targetSession: config.targetSession,
    selfUin: config.selfUin,
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
    dataDir: config.dataDir,
  }
}
function writeLog(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}`
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_FILE, `${line}\n`)
  } catch {
    // 日志写不进去也不能影响运行
  }
  if (level === 'ERROR') console.error(`[dsh-alive] ${message}`)
  else if (level === 'WARN') console.warn(`[dsh-alive] ${message}`)
  else console.log(`[dsh-alive] ${message}`)
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
      lastWarmthAt: null,
      lastRejectedAt: null,
    },
    rhythm: { hourly: new Array(24).fill(0), samples: 0 },
    loops: [],
    episodes: [],
    stats: { byKind: {}, totalDelivered: 0, totalReplied: 0, abandoned: 0 },
    focus: { sessionId: null, lastHumanAt: null, lastAssistantAt: null, lastTickAt: null, shortTerm: [] },
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
  try {
    if (existsSync(cfgPath)) savedCfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  } catch (err) {
    savedCfg = null
  }
  const { config, problems } = savedCfg !== null && typeof savedCfg === 'object'
    ? parseConfig({ ...(rawConfig ?? {}), ...savedCfg })
    : parsedBase
  if (savedCfg === null) {
    try {
      writeFileSync(cfgPath, `${JSON.stringify(pickConfigForFile(config), null, 2)}\n`, 'utf8')
    } catch { /* 写不进去不影响运行 */ }
  }

  // 日志统一落到 <dataDir>\logs，和 dsh-qq-bot、托盘、自检脚本保持同一个位置。
  LOG_DIR = join(config.dataDir, 'logs')
  LOG_FILE = join(LOG_DIR, 'alive.log')
  try { mkdirSync(LOG_DIR, { recursive: true }) } catch { /* 目录建不出来也不影响运行 */ }

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

  /** @type {any} */
  let state
  try {
    mkdirSync(config.dataDir, { recursive: true })
    state = normalizeState(existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null, config)
  } catch (err) {
    writeLog('WARN', `状态文件读不出来，按空状态启动：${err instanceof Error ? err.message : String(err)}`)
    state = emptyState(config)
  }

  let saveTimer = null
  /** 目标会话唤醒失败的去重：同一个 id 十分钟只记一次，别刷日志 */
  let wakeFailId = null
  let wakeFailAt = 0
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
    } catch (err) {
      writeLog('WARN', `状态落盘失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  writeLog('INFO', `启动 enabled=${state.control.enabled} dryRun=${config.dryRun} target=${config.targetSession}`)

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

  /** 他说话了：关掉所有 loop、降欠账、更新作息。 */
  function onHumanSpeech(text, at, sessionIdFromEvent) {
    // 优先用事件自带的会话 id：那才是"他此刻正在说话的那个会话"。
    // 只有拿不到时才去猜（auto 模式下的兜底）。
    const sessionId = typeof sessionIdFromEvent === 'string' && sessionIdFromEvent !== ''
      ? sessionIdFromEvent
      : resolveTargetSession()
    if (sessionId !== '') state.focus.sessionId = sessionId
    state.focus.lastHumanAt = new Date(at).toISOString()

    // 作息画像
    const h = new Date(at).getHours()
    state.rhythm.hourly[h] = (Number(state.rhythm.hourly[h]) || 0) + 1
    state.rhythm.samples = (Number(state.rhythm.samples) || 0) + 1

    // 短期记忆
    state.focus.shortTerm.push({ role: 'user', text: text.slice(0, 400), at: new Date(at).toISOString() })
    if (state.focus.shortTerm.length > 24) state.focus.shortTerm.splice(0, state.focus.shortTerm.length - 24)

    // 情绪：他回来了，欠账清零一部分
    state.mood.missing = Math.max(0, (Number(state.mood.missing) || 0) - 0.25)
    state.mood.jealousy = Math.max(0, (Number(state.mood.jealousy) || 0) - 0.1)
    state.mood.annoyanceDebt = Math.max(0, (Number(state.mood.annoyanceDebt) || 0) - 20)

    // 上一次主动：他回了没有
    const pending = state.episodes[state.episodes.length - 1]
    if (pending && pending.outcome === 'pending') {
      const gap = at - (parseTime(pending.at) ?? at)
      pending.outcome = 'replied'
      pending.repliedAfterSec = Math.round(gap / 1000)
      state.quota.consecutiveReplied = (Number(state.quota.consecutiveReplied) || 0) + 1
      state.quota.consecutiveIgnored = 0
      const bucket = state.stats.byKind[pending.loopKind] ?? { sent: 0, hit: 0 }
      bucket.hit = (bucket.hit ?? 0) + 1
      state.stats.byKind[pending.loopKind] = bucket
      state.stats.totalReplied = (Number(state.stats.totalReplied) || 0) + 1
      writeLog('INFO', `上次主动他回了（${pending.repliedAfterSec}s 后）`)
    }

    // 控制词
    const ctl = detectControl(text)
    if (ctl !== null) applyControl(ctl, at)

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
        state.mood.annoyanceDebt = Math.min(60, (Number(state.mood.annoyanceDebt) || 0) + 30)
        state.mood.lastRejectedAt = new Date(at).toISOString()
        state.quota.dayCount = config.maxPerDay // 今天不再主动
      }
      writeLog('INFO', `静音 ${ctl.minutes} 分钟（${ctl.reason}）`)
      return
    }
    state.control.mutedUntil = null
    state.control.muteReason = null
    state.control.lastWasStop = false
    writeLog('INFO', '解除静音')
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
        onHumanSpeech(text, at, sessionId)
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

  /** 情绪随时间演化。 */
  function evolveMood(now) {
    const last = parseTime(state.focus.lastTickAt)
    if (last === null) {
      state.focus.lastTickAt = new Date(now).toISOString()
      return
    }
    const hours = Math.min(6, (now - last) / 3_600_000) // 一次最多补 6 小时，防休眠唤醒后暴涨
    if (hours <= 0) return
    state.mood.missing = Math.min(1, (Number(state.mood.missing) || 0) + 0.06 * hours)
    if (state.focus.lastHumanAt && now - (parseTime(state.focus.lastHumanAt) ?? now) > 30 * 60_000) {
      state.mood.jealousy = Math.min(1, (Number(state.mood.jealousy) || 0) + 0.02 * hours)
    }
    state.focus.lastTickAt = new Date(now).toISOString()
  }

  /** 到期的 loop 能不能投。 */
  async function tryDeliver(now) {
    const agents = ctx.get('agents')
    if (!agents) return

    const sessionId = resolveTargetSession()
    if (sessionId === '') {
      writeLog('INFO', '拿不到目标会话（auto 模式下 qq-bot 还没建过会话），这轮不投')
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

    // 先把超期太久的 loop 作废：投过但硬到期还没回来，或者一次都没投就已经过期很久
    for (const loop of state.loops) {
      if (loop.status !== 'open' && loop.status !== 'delivered') continue
      if (now >= (parseTime(loop.hardDeadlineAt) ?? Infinity) && (Number(loop.attempts) || 0) >= 1) {
        loop.status = 'abandoned'
        state.stats.abandoned = (Number(state.stats.abandoned) || 0) + 1
        state.quota.consecutiveIgnored = (Number(state.quota.consecutiveIgnored) || 0) + 1
        state.mood.annoyanceDebt = Math.min(60, (Number(state.mood.annoyanceDebt) || 0) + 12)
        writeLog('INFO', `放弃「${loop.what}」（他一直没有回来）`)
      }
    }

    // 没到点的不算候选
    const due = state.loops.filter((l) => l.status === 'open' && now >= (parseTime(l.expectedBackAt) ?? Infinity))
    if (due.length === 0) return

    // 逐个过闸门 + 打分，取最高分
    /** @type {{loop:any, score:number, parts:any} | null} */
    let best = null
    for (const loop of due) {
      const gate = checkGate(state, config, loop, { now, agentRunning, agentExists })
      if (!gate.pass) continue
      const { score, parts } = scoreImpulse(state, loop, config, now)
      if (score < config.threshold) continue
      if (best === null || score > best.score) best = { loop, score, parts }
    }
    if (best === null) return

    const { loop, score, parts } = best
    const silentMin = Math.round((now - (parseTime(loop.createdAt) ?? now)) / 60_000)
    const text = renderImpulse(loop, {
      moodHint: loop.moodHint,
      silentMin,
      timeNote: timeNoteFor(now),
      recallNote: config.includeRecall ? recallNote(loop) : '',
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
    // 每 6 小时，欠账自然衰减
    if (state.mood.annoyanceDebt > 0) {
      const decay = Math.min(1, ((now - (parseTime(state.focus.lastTickAt) ?? now)) / 21_600_000))
      if (decay > 0) state.mood.annoyanceDebt = Math.max(0, state.mood.annoyanceDebt * (1 - 0.25 * decay))
    }
  }

  const timer = setInterval(() => {
    try {
      if (state.control.hardOff === true) return
      const now = Date.now()
      rollWindows(now)
      evolveMood(now)
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
      save(true)
      writeLog('INFO', '插件已卸载，状态已落盘')
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
