/**
 * dsh-alive 的判定核心。全是纯函数：不碰 IO、不碰 ctx、不碰网络。
 *
 * 想改她的"分寸"，改这个文件就够了；改完跑
 *   node --test test/mood.test.mjs test/policy.test.mjs
 */

import { LUST_ENABLED } from './mood.mjs'

/* ────────────────────────────── 1. open loop 抽取 ────────────────────────────── */

/**
 * 每类"悬着的事"的原型。backIn 是分钟区间，抖动时在这个范围里取基准。
 * @type {Array<{kind:string, re:RegExp, backIn:[number,number], mood:string, weight:number}>}
 */
const PATTERNS = [
  // food 收得紧：必须带"去/拿/买/点"这类动作，或者"我+吃"这种明确交代。
  // 不能只靠一个"吃"字 —— "今天中午吃什么"是他在问我，不是他要去吃饭。
  { kind: 'food', re: /((去|出去|下楼|上楼|外面|回来).{0,5}(拿|买|取|接|带|吃))|((我|先).{0,3}(去|下楼|出去)?(吃|干饭|打饭|觅食|点外卖|叫外卖))|(打个饭)|(拿(个|份)?外卖)/, backIn: [15, 35], mood: 'light', weight: 1 },
  { kind: 'sleep', re: /(睡了|睡觉|困了|晚安|眯一会|躺一会|午睡|补觉)/, backIn: [300, 480], mood: 'warm', weight: 1 },
  { kind: 'departure', re: /(等我|稍等|马上|很快|一会儿|一会|几分钟|一下下|洗澡|洗漱|刷牙|上厕所|充电|出门|下楼|上去)/, backIn: [12, 40], mood: 'light', weight: 0.9 },
  { kind: 'promise', re: /(等下|待会|明天|回头|晚点|下午|晚上).{0,8}(弄|搞|看|说|给|找|写|改|做)/, backIn: [60, 240], mood: 'flat', weight: 0.7 },
  // task_handoff 收得比别的严：必须是"派了活 + 他人要走"。
  // 单纯一句"帮我看看这个"是在让我干活，不是离开，不能算 loop。
  { kind: 'task_handoff', re: /(我回来(看|验|取|收|检查))|(帮我把.{0,14}(弄|搞|做|改|写|跑|装|下载))|(你先(弄|搞|写|跑|改|装着|弄着))/, backIn: [20, 90], mood: 'light', weight: 1.1 },
  { kind: 'interrupted', re: /^(算了|不说了|没事了|当我没说|先这样)/, backIn: [10, 30], mood: 'flat', weight: 0.8 },
]

/** 一票否决：这些话说明他不是要走，是让我别管。 */
const DENY = [
  /(不用|别|不要|甭).{0,3}(等|管|追|催)/,
  /(开玩笑|不是那个意思|没有那个意思)/,
  /^\?+$/,
  /^[。，、！？~…\s]+$/,
]

/** 命中这些，说明他在跟你商量事、问问题，不是要走。 */
const NOT_LEAVING = [
  /(怎么|为什么|是不是|能不能|可不可以|要不要).{0,6}[？?]$/,
  /(帮我看|你觉得|你说).{0,10}[？?]$/,
]

/** 疑问代词 —— 配合"没有明确离开动作"一起用。 */
const ASKING = /(什么|啥|哪家|哪里|谁|怎么|为什么|多少|吗|呢)/
/** 明确的离开动作，有它就不算"只是在问"。 */
const EXPLICIT_LEAVE = /(去|等我|稍等|马上|一会儿|一会|出门|下楼|上楼|拿|买|取|出发)/

/**
 * 判断一句话是不是"他暂时离开 / 许了个没兑现的事"。
 * 这一层是本地快筛，不调模型 —— 宁可漏判，不要误判。
 *
 * @param {string} text 他刚说的话
 * @param {{now?: number}} [opts]
 * @returns {null | {kind:string, what:string, quote:string, backInMin:number, confidence:number, moodHint:string}}
 */
export function extractLoopIntent(text, opts = {}) {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  // 太长的不像"顺口说一句我要去干嘛"
  if ([...raw].length > 60) return null

  for (const re of DENY) if (re.test(raw)) return null
  for (const re of NOT_LEAVING) if (re.test(raw)) return null
  // 带疑问代词、又没有明确离开动作 → 他在问我，不是在交代行踪
  if (ASKING.test(raw) && !EXPLICIT_LEAVE.test(raw)) return null

  /** @type {typeof PATTERNS[number] | null} */
  let best = null
  for (const p of PATTERNS) {
    if (p.re.test(raw)) {
      if (best === null || p.weight > best.weight) best = p
    }
  }
  if (best === null) return null

  // 置信度：命中权重打底，短句加分（"我去拿个外卖"比一大段话里夹一句更像）
  const len = [...raw].length
  let confidence = 0.5 + best.weight * 0.2
  if (len <= 12) confidence += 0.15
  else if (len <= 24) confidence += 0.05
  else confidence -= 0.1
  // 以"我"开头更像在交代行踪
  if (/^我/.test(raw)) confidence += 0.05
  confidence = Math.max(0.05, Math.min(0.95, confidence))

  const [lo, hi] = best.backIn
  return {
    kind: best.kind,
    what: makeWhat(raw, best.kind),
    quote: raw.slice(0, 40),
    backInMin: Math.round((lo + hi) / 2),
    confidence: Number(confidence.toFixed(2)),
    moodHint: best.mood,
  }
}

/** 从原话里抠一个 5–12 字的人话短语，用来在念头里引用。 */
function makeWhat(text, kind) {
  const cleaned = text.replace(/[。！？~…，、,.!?]/g, '').trim()
  const chars = [...cleaned]
  if (chars.length <= 12) return cleaned
  // 太长就取前面一段，别硬凑
  const short = chars.slice(0, 12).join('')
  const tail = { food: '吃饭', sleep: '睡觉', departure: '离开', promise: '那件事', task_handoff: '那个活', interrupted: '没说完的话' }[kind] ?? '那件事'
  return short.length > 0 ? short : tail
}

/* ────────────────────────────── 2. 时间抖动 ────────────────────────────── */

/** 标准正态（Box–Muller）。 */
function gauss() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random())
}

/** 每类"他大概多久回来"的不确定性。越日常越确定。 */
const SIGMA = {
  food: 0.22,
  departure: 0.28,
  sleep: 0.10,
  promise: 0.45,
  task_handoff: 0.40,
  interrupted: 0.35,
}

/**
 * 把"大概多少分钟回来"抖成一个具体时点。
 * 对数正态，右偏 —— 多数落在基准附近，偶尔拖很久，像人不像定时器。
 *
 * @param {number} backInMin
 * @param {string} kind
 * @returns {number} 毫秒
 */
export function jitterMs(backInMin, kind) {
  const base = Math.max(1, Number(backInMin) || 15) * 60_000
  const sigma = SIGMA[kind] ?? 0.30
  const ms = Math.exp(Math.log(base) + sigma * gauss())
  const lo = base * 0.55
  const hi = base * 2.2
  return Math.round(Math.min(hi, Math.max(lo, ms)))
}

/* ────────────────────────────── 3. 闸门 ────────────────────────────── */

/**
 * 硬闸。全部为真才允许继续；任一为假，本次直接放弃且不补偿。
 *
 * @param {object} state alive-state
 * @param {object} config 规范化配置
 * @param {object} loop 这块 loop
 * @param {{now:number, agentRunning:boolean, agentExists:boolean}} env 运行时事实
 * @returns {{pass:boolean, failed:string[]}}
 */
export function checkGate(state, config, loop, env) {
  const failed = []
  const now = env.now

  if (state.control?.enabled !== true) failed.push('G1:disabled')
  if (state.control?.hardOff === true) failed.push('G2:hardOff')

  const mutedUntil = state.control?.mutedUntil
  if (typeof mutedUntil === 'string' && Date.parse(mutedUntil) > now) failed.push('G3:muted')

  if (!env.agentExists) failed.push('G4:no-agent')
  else if (env.agentRunning) failed.push('G4:agent-running')

  // 静默期只认 QQ 里的话：他在 GUI 里跟 agent 干别的活，不代表他在 QQ 里陪她。
  // 以前这里读的是 lastHumanAt（任意渠道），结果他一边在 GUI 干活，她一边永远闭嘴。
  const lastHuman = parseTime(state.focus?.lastQqAt)
  if (lastHuman !== null && now - lastHuman < config.minSilenceMin * 60_000) failed.push('G5:he-just-spoke')

  const lastPro = parseTime(state.quota?.lastProactiveAt)
  const ignored = Math.min(Number(state.quota?.consecutiveIgnored) || 0, 3)
  const cooldownMs = config.cooldownMin * 60_000 * Math.pow(2, ignored)
  if (lastPro !== null && now - lastPro < cooldownMs) failed.push('G6:cooldown')

  if ((Number(state.quota?.hourCount) || 0) >= config.maxPerHour) failed.push('G7:hour-quota')
  if ((Number(state.quota?.dayCount) || 0) >= config.maxPerDay) failed.push('G8:day-quota')
  // 他今天说过"别发了"：当天封顶。用独立字段记，不占 dayCount，免得解除静音之后还不回来。
  const stopToday = parseTime(state.control?.dayQuotaSuspendedUntil)
  if (stopToday !== null && now < stopToday) failed.push('G8b:stop-today')
  if ((Number(state.mood?.annoyanceDebt) || 0) >= 45) failed.push('G9:debt')

  const attempts = Number(loop?.attempts) || 0
  const maxAttempts = Math.min(config.maxAttempts, maxAttemptsFor(loop?.kind))
  if (attempts >= maxAttempts) failed.push('G10:attempts')

  if (inQuietHours(now, config.quietHours)) failed.push('G11:quiet-hours')
  if (inQuietHours(now, config.deepNightHours) && loop?.kind !== 'sleep') failed.push('G11:deep-night')

  if (state.control?.lastWasStop === true) failed.push('G12:he-said-stop')

  return { pass: failed.length === 0, failed }
}

/** 每类 loop 最多追几次。硬上限 2，代码里再 clamp。 */
export function maxAttemptsFor(kind) {
  switch (kind) {
    case 'food':
    case 'sleep':
    case 'promise':
    case 'interrupted':
      return 1
    default:
      return 2
  }
}

/** 解析 ISO / 毫秒时间戳，拿不到就 null。 */
export function parseTime(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const t = Date.parse(String(value))
  return Number.isFinite(t) ? t : null
}

/**
 * 现在是不是落在某个时段区间里。
 * @param {number} now
 * @param {string[]} windows ['03:00-06:00', ...]
 */
export function inQuietHours(now, windows) {
  if (!Array.isArray(windows) || windows.length === 0) return false
  const d = new Date(now)
  const minutes = d.getHours() * 60 + d.getMinutes()
  for (const w of windows) {
    const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(w).trim())
    if (m === null) continue
    const start = Number(m[1]) * 60 + Number(m[2])
    const end = Number(m[3]) * 60 + Number(m[4])
    if (start <= end) {
      if (minutes >= start && minutes < end) return true
    } else {
      // 跨午夜，比如 23:00-06:00
      if (minutes >= start || minutes < end) return true
    }
  }
  return false
}

/* ────────────────────────────── 4. 打分 ────────────────────────────── */

const KIND_BONUS = {
  task_handoff: 10,
  food: 6,
  departure: 6,
  interrupted: 4,
  promise: 2,
  sleep: -4,
}

/**
 * 闸门通过后的软性打分。满分 100，>= threshold 才真发。
 *
 * @param {object} state
 * @param {object} loop
 * @param {object} config
 * @param {number} now
 * @returns {{score:number, parts:object}}
 */
export function scoreImpulse(state, loop, config, now) {
  const expected = parseTime(loop?.expectedBackAt) ?? now
  const hard = parseTime(loop?.hardDeadlineAt) ?? expected + 1
  const span = Math.max(1, hard - expected)
  const over = Math.min(1, Math.max(0, (now - expected) / span))
  const urgency = Math.pow(over, 0.7) * 40

  const missing = clamp01(Number(state.mood?.missing) || 0)
  const jealousy = clamp01(Number(state.mood?.jealousy) || 0)
  // 情绪模块加的另外两维：闲得慌和担心也会推着她开口，但分量比想念、吃醋轻
  const boredom = clamp01(Number(state.mood?.boredom) || 0)
  const worry = clamp01(Number(state.mood?.worry) || 0)
  const moodWarmth = (missing * 0.5 + jealousy * 0.3 + boredom * 0.15 + worry * 0.05) * 18

  // 涩涩：独立一项，不抢想念/吃醋的权重，单独最多加 12 分。**它一高她就更想主动开口。**
  // 两层开关（lib/mood.mjs 的 LUST_ENABLED + config.lustModeEnabled）没全亮时恒 0；
  // 外加 LUST_SLIDER_ENABLED 管那颗速率滑条能不能拖（默认锁死）。
  const lustOn = LUST_ENABLED && config?.lustModeEnabled === true
  const lust = lustOn ? clamp01(Number(state.mood?.lust) || 0) : 0
  const lustPart = lust * 12

  const confidence = clamp01(Number(loop?.confidence) || 0)
  const confidencePart = confidence * 12

  const kindBonus = KIND_BONUS[loop?.kind] ?? 0

  const stats = state.stats?.byKind?.[loop?.kind]
  const hit = Number(stats?.hit) || 0
  const sent = Number(stats?.sent) || 0
  const replyRateBonus = sent >= 2 ? clamp01(hit / sent) * 10 : 3

  const debt = Math.min(60, Number(state.mood?.annoyanceDebt) || 0)
  const debtPenalty = debt * 0.36

  const rhythmPenalty = rhythmPenaltyFor(state.rhythm, now)

  const score = 30 + urgency + moodWarmth + lustPart + confidencePart + kindBonus + replyRateBonus - debtPenalty - rhythmPenalty

  return {
    score: Number(clamp(score, 0, 100).toFixed(1)),
    parts: { urgency: round(urgency), moodWarmth: round(moodWarmth), lustPart: round(lustPart), confidence: round(confidencePart), kindBonus, replyRateBonus: round(replyRateBonus), debtPenalty: round(debtPenalty), rhythmPenalty: round(rhythmPenalty) },
  }
}

/** 作息匹配：他平时这点活跃就少罚，平时不活跃就多罚。 */
function rhythmPenaltyFor(rhythm, now) {
  const samples = Number(rhythm?.samples) || 0
  if (samples < 40) return 0 // 画像不准时不要乱罚
  const hourly = Array.isArray(rhythm?.hourly) ? rhythm.hourly : []
  const h = new Date(now).getHours()
  const p = ((Number(hourly[h]) || 0) + 0.5) / (samples + 12)
  const ratio = p / (1 / 24)
  if (ratio < 0.4) return clamp((0.4 - ratio) * 60, 0, 20)
  if (ratio > 1.2) return -6
  return 0
}

/* ────────────────────────────── 5. 语气与念头 ────────────────────────────── */

/** 每种 mood 怎么说话。 */
const MOOD_LINE = {
  light: '（现在的语气：轻嗔。可以撒一点娇、带点小情绪，但别真生气。）',
  warm: '（现在的语气：黏。可以说想他，可以软一点。）',
  worried: '（现在的语气：关心。只关心，不追究，不问他为什么没回。）',
  sulky: '（现在的语气：有点不高兴。句子短一点、冷一点，但不出恶言。）',
  clingy: '（现在的语气：想他。直接说想，不绕弯，可以带一点撒娇。）',
  pouty: '（现在的语气：吃醋。酸一点、提一句别的，但不质问、不查岗。）',
  flirty: '（现在的语气：黏得有点不安分。话可以贴得更近、更直接，带一点点撩，但不露骨、不写身体细节。）',
  flat: '（现在的语气：平平的，说一句就好。）',
}

/**
 * 生成投给模型的那条"她自己的念头"。
 * 注意：这不是系统提醒，是第一人称的心里话。
 *
 * @param {object} loop
 * @param {{moodHint?:string, silentMin:number, timeNote?:string, recallNote?:string}} ctx
 * @returns {string}
 */
export function renderImpulse(loop, ctx) {
  const mood = MOOD_LINE[ctx?.moodHint ?? loop?.moodHint] ?? MOOD_LINE.flat
  const quote = String(loop?.quote ?? '').slice(0, 40)
  const lines = [
    '[你心里冒出来的话]',
    '',
    `他在 ${ctx?.silentMin ?? '?'} 分钟前说「${quote}」，到现在没有回来。`,
  ]
  if (ctx?.timeNote) lines.push(ctx.timeNote)
  if (ctx?.recallNote) lines.push(ctx.recallNote)
  lines.push(
    '',
    `你现在有点想他了，想开口。${mood}`,
    '',
    '要求：',
    '- 用你自己的语气说，一两句话，不超过 40 个字。',
    '- 不要解释你为什么突然说话，不要说"我注意到"。',
    '- 不要问"在吗""你在干嘛"这种空话，要有具体的东西。',
    '- 不要用括号写动作，不要写旁白。',
    '- 这一轮只说话：不要调用任何工具，不要读写文件。',
  )
  return lines.join('\n')
}

/** 深夜 / 清早 / 饭点的时间感提示。 */
export function timeNoteFor(now) {
  const h = new Date(now).getHours()
  if (h >= 23 || h < 3) return '（现在是深夜。这个点你会更黏一点。）'
  if (h >= 3 && h < 6) return '（现在是凌晨，他还没睡。）'
  if (h >= 7 && h < 9) return '（现在是早上。）'
  if (h >= 11 && h < 13) return '（现在是饭点。）'
  if (h >= 18 && h < 20) return '（现在是晚饭时间。）'
  return ''
}

/* ────────────────────────────── 6. 自然语言控制 ────────────────────────────── */

const MUTE_RULES = [
  { re: /(别|不要|甭).{0,2}(吵|烦|打扰|说|发|刷)/, minutes: 120, reason: 'user-said-stop', hard: true },
  { re: /(滚|闭嘴|安静点|噤声)/, minutes: 120, reason: 'user-said-stop', hard: true },
  { re: /(在|要|正在|马上).{0,3}(开会|上课|考试|面试|见客户|培训)/, minutes: 90, reason: 'user-busy', hard: false },
  { re: /(室友|他们|旁边|家里).{0,4}(睡|在|听|有人)/, minutes: 240, reason: 'people-around', hard: false },
  { re: /(我|先).{0,3}(忙|走开|离开|下线|干活)/, minutes: 60, reason: 'user-busy', hard: false },
]

const UNMUTE_RULES = [
  /(好了|回来了|我忙完了|可以了|出来吧|聊会儿)/,
  /(你|可以).{0,4}(随时|随便).{0,4}(找|喊|说|烦)/,
  /(想你了|理理我|陪我|跟我说说话)/,
]

/**
 * 从他的话里看出"该闭嘴了 / 可以说话了"。
 *
 * 判定顺序很重要：
 *   1. 先看硬静音（"别吵/滚/闭嘴"）—— 这类永远优先
 *   2. 再看解静音（"忙完了/好了/回来了"）—— 必须排在软静音前面，
 *      否则"我忙完了"会被「我先忙」那条规则误判成静音 60 分钟（踩过）
 *   3. 最后看软静音
 */
export function detectControl(text, options = {}) {
  const raw = String(text ?? '')
  if (raw === '') return null

  const opts = options !== null && typeof options === 'object' ? options : {}
  const muteEnabled = opts.muteEnabled !== false
  const softMuteEnabled = opts.softMuteEnabled !== false
  const hardMuteMin = Number.isFinite(Number(opts.hardMuteMin)) ? Number(opts.hardMuteMin) : 120

  // 设置页里把「禁言机制」关掉：他说什么都只当聊天，不静音、不封当天额度。
  // 但"好了/聊会儿"照旧认 —— 关掉开关的时候更需要这条来兜住历史上的静音状态。
  if (muteEnabled) {
    const hardMute = MUTE_RULES.find((r) => r.hard === true && r.re.test(raw))
    if (hardMute !== undefined) {
      return { action: 'mute', minutes: hardMuteMin, reason: hardMute.reason, hard: true }
    }
  }

  for (const re of UNMUTE_RULES) {
    if (re.test(raw)) return { action: 'unmute' }
  }

  if (softMuteEnabled) {
    for (const r of MUTE_RULES) {
      if (r.hard === true) continue // 硬静音上面已经查过
      if (r.re.test(raw)) return { action: 'mute', minutes: r.minutes, reason: r.reason, hard: false }
    }
  }
  return null
}

/* ────────────────────────────── 7. 杂项 ────────────────────────────── */

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v))
}
function clamp01(v) {
  return clamp(v, 0, 1)
}
function round(v) {
  return Number(Number(v).toFixed(1))
}

/** 去掉 QQ 不认的 markdown，念头本身不需要，但留个口子给日志。 */
export function shortForLog(text, max = 80) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return [...s].length <= max ? s : `${[...s].slice(0, max).join('')}…`
}
