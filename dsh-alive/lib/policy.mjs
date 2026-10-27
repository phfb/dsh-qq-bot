/**
 * dsh-alive 的判定核心。全是纯函数：不碰 IO、不碰 ctx、不碰网络。
 *
 * 想改她的"分寸"，改这个文件就够了；改完跑
 *   node --test "test/*.test.mjs"
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
  /**
   * 情绪驱动的豁免。
   *
   * `master` —— 连总开关（enabled / hardOff）都绕过去，默认关。
   * `quota`  —— 绕开每小时 / 每天配额。
   *
   * **能绕的只有这两类。** 静音（G3）、他刚说过话（G5）、他说「别发了」（G8b / G12）、
   * 深夜（G11）永远不绕 —— 那是「别打扰他」的底线，不是额度问题。
   */
  const exempt = env?.exempt ?? {}

  // 2026-10-28：设置页那个「启用活人感」写的是 config.enabled，而这里原来只认 state.control.enabled
  // —— 于是那个勾选框根本不生效。现在两个都要开（config = 装不装，state = 运行期临时闭嘴）。
  if (config?.enabled === false && exempt.master !== true) failed.push('G1:disabled-by-config')
  if (state.control?.enabled !== true && exempt.master !== true) failed.push('G1:disabled')
  if (state.control?.hardOff === true && exempt.master !== true) failed.push('G2:hardOff')

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

  if ((Number(state.quota?.hourCount) || 0) >= config.maxPerHour && exempt.quota !== true) {
    failed.push('G7:hour-quota')
  }
  if ((Number(state.quota?.dayCount) || 0) >= config.maxPerDay && exempt.quota !== true) {
    failed.push('G8:day-quota')
  }
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
    // 自发念头（没事件、纯粹自己想说话）：一次就够，追第二遍像催命
    case 'free':
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

/* ──────────────────────── 4.5 自发念头（没事件也能开口） ──────────────────────── */

/**
 * 情绪维度 → 自发念头的语气 + 一句给人看的话。
 *
 * 顺序就是打分时的优先级：想他第一，其次是想黏、闲、担心、吃醋。
 */
const FREE_MOODS = [
  { key: 'missing', hint: 'clingy', what: '想他了，没理由也想说一句' },
  { key: 'lust', hint: 'flirty', what: '有点黏，想凑过去' },
  { key: 'boredom', hint: 'light', what: '闲得慌，想找点话说' },
  { key: 'worry', hint: 'worried', what: '有点担心他' },
  { key: 'jealousy', hint: 'pouty', what: '有点酸，想让他理我' },
]

/**
 * 「没有念头也能开口」：他安安静静待着，光靠情绪攒出一条自发念头。
 *
 * 2026-10-26 晚上加的。原来整条投递链只认 open loop，而 loop 只有
 * 「他说了带离开意思的话」才会挂上（见 extractLoopIntent）。于是：
 * 他一句「好」结束对话 → 所有 loop 被关成 answered → 她一整晚一声不吭，
 * 想他 100% 也没用，因为 tryDeliver 第一行就是「due 为空就 return」。
 *
 * 这一条补的就是那个缺口：不靠事件，靠自己攒起来的情绪。
 *
 * 三重门槛，缺一不进：
 *   ① 他在 QQ 里已经安静够久（freeTalkSilenceMin）——刚聊完不插嘴
 *   ② 距上次自发够久（freeTalkGapMin）——自发比"他说要走"轻，别太密
 *   ③ 最主导的那一维情绪到线（freeTalkMoodPercent）
 *
 * 闸门（静音 / 深夜 / 配额 / 冷却 / 他刚说过话）不在这里判 —— 造出来的
 * 这条 loop 会跟别的 loop 一样过 checkGate，一个都绕不过去。
 *
 * @param {object} state alive-state
 * @param {object} config 规范化配置
 * @param {number} now
 * @returns {null | object} kind='free' 的 loop；没到条件返回 null
 */
export function buildFreeLoop(state, config, now) {
  if (config?.freeTalkEnabled !== true) return null

  // 一次都没在 QQ 里说过话 → 不知道他什么时候在，别乱开口
  const lastQq = parseTime(state?.focus?.lastQqAt)
  if (lastQq === null) return null
  const silenceMin = Number(config.freeTalkSilenceMin) || 15
  if (now - lastQq < silenceMin * 60_000) return null

  // 两次自发之间至少隔这么久（自发比"他说要走"轻，别太密）
  const gapMin = Number(config.freeTalkGapMin) || 45
  let lastFree = null
  for (const loop of Array.isArray(state?.loops) ? state.loops : []) {
    if (loop?.source !== 'free') continue
    const at = parseTime(loop.createdAt)
    if (at !== null && (lastFree === null || at > lastFree)) lastFree = at
  }
  if (lastFree !== null && now - lastFree < gapMin * 60_000) return null

  // 情绪门槛：取最主导的一维（涩涩两层开关没全亮就不参与）
  const lustOn = LUST_ENABLED && config?.lustModeEnabled === true
  let top = null
  for (const m of FREE_MOODS) {
    if (m.key === 'lust' && !lustOn) continue
    const v = clamp01(Number(state?.mood?.[m.key]) || 0)
    if (top === null || v > top.v) top = { ...m, v }
  }
  if (top === null) return null
  const need = (Number(config.freeTalkMoodPercent) || 45) / 100
  if (top.v < need) return null

  // 到点即到期（现在就想说），但给 staleMin 这么长的时间窗口让人投
  const hard = now + (Number(config.staleMin) || 30) * 60_000
  return {
    id: `lp_free_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    kind: 'free',
    what: top.what,
    quote: '',
    createdAt: new Date(now).toISOString(),
    expectedBackAt: new Date(now).toISOString(),
    hardDeadlineAt: new Date(hard).toISOString(),
    confidence: 0.85,
    source: 'free',
    status: 'open',
    attempts: 0,
    lastAttemptAt: null,
    moodHint: top.hint,
    sessionId: config.targetSession,
    freeMood: top.key,
    freePercent: Math.round(top.v * 100),
  }
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
  flirty: '（现在的语气：黏得有点不安分。可以贴得更近、更直接，带一点撩；但看场合 —— 他在忙、在跟人说话的时候就收着。）',
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
/**
 * 这一轮她能用的动作 → 提示词里那一段。
 *
 * 2026-10-26 晚上加的：以前她「主动」只有两条路 —— 说一句话、或者发一张表情。
 * 现在 qq-bot 给了她手（戳一戳 / 发说说 / 分享卡片），主动就不该只剩「开口」。
 *
 * 菜单由调用方按情绪和当日额度算出来，这里只负责把菜单翻成人话。
 * 菜单里没有的动作一个字都不提 —— 提了她就会去试，试了被拒是浪费她一轮。
 */
function interactionLines(menu) {
  const has = (k) => Array.isArray(menu) && menu.includes(k)
  const lines = []
  if (has('speak')) lines.push('- 说一句话：用你自己的语气，一两句，不超过 40 个字。')
  if (has('poke')) lines.push('- 戳他一下：调 `qq_poke`。**这个不用说任何话**，戳完就戳完了。')
  if (has('meme')) lines.push('- 发一张表情：调 `send_meme`，关键词挑最像你现在心情的。')
  if (has('qzone')) lines.push('- 发一条说说：调 `qq_qzone`（action=post）。**所有人可见**，规则见下面。')
  if (has('link')) lines.push('- 分享个东西给他：调 `qq_share`（title + jump_url）。链接必须是你真搜到的，不许编。')
  return lines
}

/** 菜单里除「说话」之外没别的（或者根本没给菜单）→ 退回老行为。 */
function onlySpeak(menu) {
  return !Array.isArray(menu) || menu.filter((m) => m !== 'speak').length === 0
}

/**
 * 「要求」那一段。有菜单就给菜单，没菜单就还是「只说一句话」。
 * 发说说的内容闸门也在这里 —— 因为那条是所有人可见的，不能让她随手写。
 */
function requirementsSection(menu) {
  if (onlySpeak(menu)) {
    return [
      '- 用你自己的语气说，一两句话，不超过 40 个字。',
      '- 不要用括号写动作，不要写旁白。',
      '- 这一轮只说话：不要调用任何工具，不要读写文件。',
    ]
  }

  const lines = [
    '你现在不一定要说话 —— 从下面挑一个最像「你此刻真会做的事」：',
    ...interactionLines(menu),
    '- 只挑一件，别一次全用上。',
    '- 选了「戳一戳」就真的不用说话，别为了凑一句而凑。',
    '- 如果某个动作返回 ok:false（今天用完了 / 被挡了），别纠缠，改成直接跟他说话。',
    '- 不要用括号写动作，不要写旁白。',
  ]

  if (Array.isArray(menu) && menu.includes('qzone')) {
    lines.push(
      '',
      '【发说说前必读】这条是所有人可见的，等于替他在社交圈公开说话：',
      '- 不许出现「他」「我对象」「男朋友」这类关系词',
      '- 不许出现学校、课程、住址、具体行程',
      '- 只能写抽象心情、风景、吃的、日常感想（比如「今天下雨，突然很安静」）',
      '- 写不出这样的内容就别发，改成戳他一下，或者直接跟他说话',
    )
  }

  return lines
}

/**
 * 生成投给模型的那条"她自己的念头"。
 * 注意：这不是系统提醒，是第一人称的心里话。
 *
 * @param {object} loop
 * @param {{moodHint?:string, silentMin:number, timeNote?:string, recallNote?:string, menu?:string[]}} ctx
 * @returns {string}
 */
export function renderImpulse(loop, ctx) {
  const mood = MOOD_LINE[ctx?.moodHint ?? loop?.moodHint] ?? MOOD_LINE.flat
  const requirements = requirementsSection(ctx?.menu)

  // 时段问候：不是因为想他，是因为「现在这个时候」
  if (loop?.kind === 'greeting') {
    const label = String(loop?.what ?? '打个招呼')
    const when = label === '早上好' ? '早上' : label === '中午好' ? '中午' : label === '晚上好' ? '晚上' : '这会儿'
    const lines = [
      '[你心里冒出来的话]',
      '',
      `现在是${when}。`,
      '你想主动跟他说一句 —— 不是他找你，也不是你想他想得难受，就是到这个时候了。',
    ]
    if (ctx?.timeNote) lines.push(ctx.timeNote)
    if (ctx?.recallNote) lines.push(ctx.recallNote)
    lines.push(
      '',
      `你这会儿的心情：${mood}`,
      '',
      '要求：',
      '- 一句问候就够，口语一点，别像客服群发（不要"您好，祝您今天愉快"）。',
      '- 不要问"在吗""你在干嘛"这种空话。',
      '- 可以带一句你自己此刻的状态：刚醒、在吃早饭、外面天气、刚忙完。',
      '- 不要用括号写动作，不要写旁白。',
      '- 这一轮只说话：不要调用任何工具，不要读写文件。',
    )
    return lines.join('\n')
  }

  // 自发念头：没有"他说了要走"这回事，纯粹是她自己想说话
  if (loop?.kind === 'free') {
    const lines = [
      '[你心里冒出来的话]',
      '',
      `他已经 ${ctx?.silentMin ?? '?'} 分钟没在 QQ 上跟你说话了，也没交代去哪儿。`,
      `你心里那点「${String(loop?.what ?? '想他')}」攒到了 ${loop?.freePercent ?? '?'}%。`,
    ]
    if (ctx?.timeNote) lines.push(ctx.timeNote)
    if (ctx?.recallNote) lines.push(ctx.recallNote)
    lines.push(
      '',
      `你现在想主动找他。${mood}`,
      '',
      '要求：',
      '- 这是没人叫你、你自己憋不住 —— 别说"你怎么不回我""我等你半天了"这种讨债的话，也别解释你为什么突然开口。',
      '- 不要问"在吗""你在干嘛"这种空话，要有具体的东西：他手头那件事、你今天怎么样、吃了什么。',
      ...requirements,
    )
    return lines.join('\n')
  }

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
    `你现在有点想他了。${mood}`,
    '',
    '要求：',
    '- 不要解释你为什么突然说话，不要说"我注意到"。',
    '- 不要问"在吗""你在干嘛"这种空话，要有具体的东西。',
    ...requirements,
  )
  return lines.join('\n')
}

/* ──────────────────────── 6.6 时段问候（早上 / 中午 / 晚上） ──────────────────────── */

/**
 * 问候窗口。每天每个窗口**最多**发一次，而且要先掷骰子 —— 不是到点必发。
 *
 * 为什么单独一条路：这是**时间驱动**的，跟情绪驱动不一样。
 * 「想他 100%」是一种原因，「现在是早上七点」是另一种原因。
 * 后者不该占前者那份额度，也不该被前者的冷却压住。
 */
export const DEFAULT_GREETING_WINDOWS = Object.freeze([
  '07:00-09:00', // 早上
  '11:30-13:00', // 中午
  '18:00-20:00', // 晚上
])

/** "07:00-09:00" → { start: 420, end: 540 }（当天第几分钟）。格式不对返回 null。 */
export function parseClockWindow(text) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
  if (m === null) return null
  const start = Number(m[1]) * 60 + Number(m[2])
  const end = Number(m[3]) * 60 + Number(m[4])
  if (start < 0 || start >= 1440 || end <= 0 || end > 1440) return null
  // 问候窗口不跨午夜（跨午夜那叫睡觉，不叫问候）
  if (end <= start) return null
  return { start, end }
}

/** 现在落在第几个问候窗口里？不在任何窗口里返回 -1。 */
export function greetingSlotOf(now, windows) {
  const list = Array.isArray(windows) && windows.length > 0 ? windows : DEFAULT_GREETING_WINDOWS
  const d = new Date(now)
  const minutes = d.getHours() * 60 + d.getMinutes()
  for (let i = 0; i < list.length; i += 1) {
    const w = parseClockWindow(list[i])
    if (w === null) continue
    if (minutes >= w.start && minutes < w.end) return i
  }
  return -1
}

/** 本地日期键（用来判「今天这个窗口处理过没有」）。 */
export function dayKey(now) {
  const d = new Date(now)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/**
 * 在窗口里挑一个随机时刻（当天第几分钟）。
 *
 * 不取窗口开头 —— 七点整准时问好，比闹钟还假。
 */
export function pickGreetingMinute(windowText, rand = Math.random) {
  const w = parseClockWindow(windowText)
  if (w === null) return null
  const span = Math.max(1, w.end - w.start)
  return w.start + Math.floor(rand() * span)
}

/** 问候语按窗口轮着来，写死这三句就够（具体怎么说还是她自己组织）。 */
export function greetingLabelOf(slotIndex) {
  switch (Number(slotIndex)) {
    case 0: return '早上好'
    case 1: return '中午好'
    case 2: return '晚上好'
    default: return '打个招呼'
  }
}

/**
 * 造一条问候念头。
 *
 * 跟自发念头（kind='free'）的区别：
 *   - 它来自时钟，不来自情绪，所以打分时**不看阈值**、也**不占说话额度**
 *   - 它仍然要过静音 / 深夜 / 「别发了」/ 道别闭环这些底线闸门，
 *     一条都绕不过去 —— 「到点了」不是打扰他的理由
 *
 * @param {number} now
 * @param {number} slotIndex
 * @param {{targetSession?:string, staleMin?:number}} opts
 */
export function buildGreetingLoop(now, slotIndex, opts = {}) {
  const hard = now + (Number(opts.staleMin) || 30) * 60_000
  const label = greetingLabelOf(slotIndex)
  return {
    id: `lp_greet_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    kind: 'greeting',
    what: label,
    quote: '',
    createdAt: new Date(now).toISOString(),
    expectedBackAt: new Date(now).toISOString(),
    hardDeadlineAt: new Date(hard).toISOString(),
    confidence: 0.9,
    source: 'greeting',
    status: 'open',
    attempts: 0,
    lastAttemptAt: null,
    moodHint: 'warm',
    sessionId: opts.targetSession ?? 'auto',
    greetingSlot: Number(slotIndex),
  }
}

/* ──────────────────────── 6.5 道别闭环（说完晚安就别再找了） ──────────────────────── */

/**
 * 道别词。跟 qq-bot 的 lib/goodnight.mjs 是同一套判断 ——
 * 两个插件各存一份，因为它们是独立包，不该互相 import。
 */
const FAREWELL_RE = /(晚安|睡了|睡啦|睡觉|先睡|去睡|眯一会|眯了|困了|拜拜|再见|明天见|回聊|早点睡|我下了|下线了|安啦|睡咯|歇了)/

/**
 * 这句话是不是道别。
 * @param {string} text
 * @returns {boolean}
 */
export function isFarewell(text) {
  const t = String(text ?? '').trim()
  if (t === '') return false
  // 太长的多半在说事，不是单纯道别
  if ([...t].length > 30) return false
  return FAREWELL_RE.test(t)
}

/**
 * 她最后说的那句话是不是道别（而且之后他没再说话）。
 *
 * 场景：她说「晚安」→ 他回「晚安」→ qq-bot 那边把这条吞了（不再回），
 * 于是最后一条 assistant 还是她的晚安。这时候她绝不该再主动发任何东西 ——
 * 不然就是「道完别还追着聊」。
 *
 * @param {Array<{role:string, text:string, at:string}>} shortTerm
 * @param {{now?:number, gapMin?:number}} [opts]
 * @returns {boolean}
 */
export function saidGoodbyeLast(shortTerm, opts = {}) {
  const list = Array.isArray(shortTerm) ? shortTerm : []
  const now = Number(opts.now) || Date.now()
  // 默认 10 小时：一句话把一整个睡着的时间段都封住，天亮他说话了就自然恢复
  const gapMin = Number(opts.gapMin) > 0 ? Number(opts.gapMin) : 600

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i]
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue
    if (m.role === 'user') return false // 最后一句是他说的 → 没闭环，照常
    const at = Date.parse(String(m.at ?? ''))
    if (Number.isFinite(at) && now - at > gapMin * 60_000) return false // 隔太久，算新的一轮
    return isFarewell(m.text)
  }
  return false
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
