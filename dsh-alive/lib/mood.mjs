/**
 * dsh-alive 的情绪模块。
 *
 * 七个维度，全部数字化，有明确的演化函数和事件回调：纯函数、不碰 fs、可以单独测。
 *
 *   missing   想他 —— 他不在就往上走，深夜走得更快
 *   jealousy  吃醋 —— 他长时间不在 QQ 里出现，她又没别的事可做
 *   annoyance 恼火 —— 被忽视 / 被赶走，用 0..60 的"欠账"记，够 45 就闭嘴（闸门 G9）
 *   warmth    暖意 —— 被他哄出来的，衰减最快
 *   worry     担心 —— 深夜他还没消息
 *   boredom   闲得发慌 —— 想念的副产品，越闲越想找事
 *   lust      涩涩 —— 2026-10-26 加的第七维，**不是靠时间攒的，是靠对话顶上去的**：
 *
 *              ① 他在 QQ 里挑逗她 → 涨一截（teaseStepPercent，默认 +25%）
 *              ② 顶上去之后她说话更主动（参与打分，最多 +12 分；主情绪是它时语气变 flirty）
 *              ③ 事后慢慢往回落，落到「余温下限」（floorPercent，默认 20%）就停住；
 *                 回落耗时 = decayHours（默认 4 小时，从 100% 落到底正好这么多）
 *              ④ 落到下限之后靠自己随「想他」慢慢爬 —— 想他越重爬得越快，
 *                 但自涨封顶 selfCapPercent（默认 70%），70% 以上只能靠对话顶
 *
 *             两层开关，默认两层都不亮：
 *               LUST_ENABLED（下面那行，写在代码里的） = 面板上要不要露出「涩涩」这一组设置。
 *                                                        关着的话面板里看不见它，功能也不生效。
 *               lustModeEnabled（alive-config.json）    = 面板上那颗真开关，勾上才算真启用。
 *             再加第三样：LUST_SLIDER_ENABLED 管那颗速率滑条能不能拖（默认锁死，和上面两样不相干）。
 *
 * ── 速度怎么算（2026-10-26 改） ───────────────────────────────────────────
 * 每个维度都有一个"速率倍率"（设置窗口里的滑条，0.1x ~ 10x，默认 1.0x）。
 * 1.0x 时，从 0 攒到 100% 用的时间是 DEFAULT_FILL_HOURS = 6 小时。
 * 所以实际满值时间 = fillHours / 倍率：
 *     0.1x → 60 小时      0.5x → 12 小时      1.0x → 6 小时
 *     3.0x → 2 小时       10x → 0.6 小时（36 分钟）
 * 设置窗口会把每个滑条对应的时间当场算好写在旁边，不用自己算。
 *
 * 演算仍然是"每小时多少"的线性速率乘真实经过的小时数，一次最多补 6 小时，
 * 免得休眠一晚上回来情绪直接顶满。
 */

const clamp01 = (v) => Math.min(1, Math.max(0, v))
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

/* ────────────────────────────── 开关与常量 ────────────────────────────── */

/**
 * 彩蛋开关：涩涩的滑条要不要能拖。
 *
 * false（默认）= 涩涩固定 1.0x，滑条在设置窗口里是灰的，配置里写什么倍率都不作数 ——
 *                她这一维就是老老实实 6 小时攒满。
 * true          = 滑条解锁，可以和别的情绪一样在 0.1x ~ 10x 之间拖。
 *
 * 改这一行然后重启 DSH 就生效（设置窗口也会跟着变，它读的是这行源码）。
 */
export const LUST_SLIDER_ENABLED = false

/**
 * 涩涩这一层的代码开关（2026-10-26 加）。
 *
 * false（默认）= 面板里**根本不出现**「涩涩」那一组设置，功能也不生效 —— 眼不见心不烦。
 * true          = 面板上露出那颗真开关（`lustModeEnabled`）+ 余温下限 / 自涨封顶 /
 *                 回落耗时 / 自涨基准 / 单次涨幅这五个数字框。**勾不勾还是他说了算**，
 *                 代码这边只是把开关放出来，不代表就直接开了。
 *
 * 和下面那颗滑条锁（LUST_SLIDER_ENABLED）是两件事，别混：
 *   这里管「面板露不露 + 能不能启用」，那颗管「速率滑条能不能拖」。
 *
 * 改这一行然后重启 DSH 生效（设置窗口是读源码判断的，不用改窗口）。
 */
export const LUST_ENABLED = false

/** 1.0x 倍率下，从 0 攒到 100% 要几个小时。设置窗口里那句"满值约 6 小时"就是它。 */
export const DEFAULT_FILL_HOURS = 6

/**
 * 涩涩默认参数。全部可以在面板上改，这里只是出厂值。
 *
 *   floorPercent     余温下限 20% —— 事后落到这儿就停住，留着一点热度
 *   selfCapPercent   自涨封顶 70% —— 自己爬最多到这儿，再往上只能靠他挑逗
 *   decayHours       回落耗时 4 小时 —— 从 100% 落回下限用多久
 *   fillHours        自涨基准 6 小时 —— 从下限爬到封顶用多久（想他会让它更快）
 *   teaseStepPercent 单次涨幅 25% —— 他挑逗一次顶上去多少
 */
export const LUST_DEFAULTS = Object.freeze({
  enabled: false,
  floorPercent: 20,
  selfCapPercent: 70,
  decayHours: 4,
  fillHours: 6,
  teaseStepPercent: 25,
})

/** 滑条两端：0.1x ~ 10x。 */
export const RATE_MIN = 0.1
export const RATE_MAX = 10

/** 恼火用的是 0..60 的欠账刻度，不是 0..1。 */
export const ANNOYANCE_MAX = 60

/** 情绪字段的规范默认值。老状态文件缺哪个就补哪个。 */
export const DEFAULT_MOOD = Object.freeze({
  missing: 0,
  jealousy: 0,
  annoyanceDebt: 0,
  warmth: 0,
  worry: 0,
  boredom: 0,
  lust: 0,
  /** 涩涩现在在哪一段：grow = 随时间自己爬；decay = 刚被挑逗过，正在往余温下限落。 */
  lustPhase: 'grow',
  lastWarmthAt: null,
  lastRejectedAt: null,
  lastTeasedAt: null,
})

/** 面板上按这个顺序显示。 */
export const MOOD_LABELS = Object.freeze({
  missing: '想他',
  jealousy: '吃醋',
  warmth: '暖意',
  worry: '担心',
  boredom: '闲得慌',
  lust: '涩涩',
})

/** 速率倍率的所有键，顺序就是设置窗口里滑条从上到下的顺序。 */
export const RATE_KEYS = Object.freeze([
  'missing',
  'jealousy',
  'warmthGain',
  'warmthDecay',
  'worry',
  'boredom',
  'annoyanceDecay',
  'lust',
])

/** 默认倍率：全是 1.0x，也就是默认 6 小时满值。 */
export const DEFAULT_RATES = Object.freeze({
  missing: 1,
  jealousy: 1,
  warmthGain: 1,
  warmthDecay: 1,
  worry: 1,
  boredom: 1,
  annoyanceDecay: 1,
  lust: 1,
})

/** 每个倍率在界面上叫什么。 */
export const RATE_LABELS = Object.freeze({
  missing: '想他（增长速度）',
  jealousy: '吃醋（增长速度）',
  warmthGain: '暖意（被哄时涨多少）',
  warmthDecay: '暖意（自己冷掉的速度）',
  worry: '担心（增长速度）',
  boredom: '闲得慌（增长速度）',
  annoyanceDecay: '恼火（消气速度）',
  lust: '涩涩（增长速度）',
})

/* ────────────────────────────── 倍率 ────────────────────────────── */

function clampRate(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 1
  return Math.min(RATE_MAX, Math.max(RATE_MIN, n))
}

/**
 * 把配置里的倍率洗成合法值。缺的补 1.0，越界的夹到 0.1 / 10。
 * 涩涩在 LUST_SLIDER_ENABLED = false 时强制 1.0 —— 写多少都不作数。
 *
 * @param {unknown} raw
 * @param {{allowLust?:boolean}} [opts]
 * @returns {Record<string, number>}
 */
export function normalizeRates(raw, opts = {}) {
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  const allowLust = opts.allowLust === true || LUST_SLIDER_ENABLED
  const out = {}
  for (const key of RATE_KEYS) {
    out[key] = clampRate(src[key] ?? DEFAULT_RATES[key])
  }
  if (!allowLust) out.lust = 1
  return out
}

/** fillHours 夹紧：面板上填 0 或者 9999 都不至于把演化算炸。 */
export function normalizeFillHours(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_FILL_HOURS
  return Math.min(240, Math.max(0.1, n))
}

/**
 * 涩涩参数洗涤：五个数字都知道怎么夹，且**封顶不许低于下限**（不然回落/自涨会打架）。
 *
 * `enabled` 只有「代码开关亮着」并且「面板那颗开关勾着」才为真 —— 任何一层没开，
 * 这一维就整个不动（数值冻结在他上次留下的那个数上）。
 *
 * `src.codeEnabled` 是**内部 / 单测专用**的旁路：正常配置里永远没有这一项
 * （config.js 是白名单式解析，alive-config.json 里写了也传不进来），
 * 只有测试要验证"开起来之后是什么行为"时才手动塞 true。
 *
 * @param {unknown} raw alive-config.json 里那一组（floorPercent / selfCapPercent / ...）
 * @returns {{codeEnabled:boolean, enabled:boolean, floor:number, selfCap:number,
 *            floorPercent:number, selfCapPercent:number, decayHours:number,
 *            fillHours:number, teaseStepPercent:number, teaseStep:number}}
 */
export function normalizeLust(raw) {
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  const codeEnabled = src.codeEnabled === undefined ? LUST_ENABLED : src.codeEnabled === true
  const hours = (v, fallback) => {
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) return fallback
    return Math.min(240, Math.max(0.1, n))
  }
  const pct = (v, fallback) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return fallback
    return Math.min(100, Math.max(0, n))
  }
  const floorPercent = pct(src.floorPercent, LUST_DEFAULTS.floorPercent)
  const selfCapPercent = Math.max(floorPercent, pct(src.selfCapPercent, LUST_DEFAULTS.selfCapPercent))
  const decayHours = hours(src.decayHours, LUST_DEFAULTS.decayHours)
  const fillHours = hours(src.fillHours, LUST_DEFAULTS.fillHours)
  const teaseStepPercent = pct(src.teaseStepPercent, LUST_DEFAULTS.teaseStepPercent)
  return {
    codeEnabled,
    enabled: codeEnabled && src.enabled === true,
    floor: floorPercent / 100,
    selfCap: selfCapPercent / 100,
    floorPercent,
    selfCapPercent,
    decayHours,
    fillHours,
    teaseStepPercent,
    teaseStep: teaseStepPercent / 100,
  }
}

/**
 * 某个维度在"满倍率"下从 0 到 100% 要多久（小时）。
 * warmthGain 是事件型（被哄一次涨多少），没有"满值时间"，返回 null。
 * 涩涩返回的是"自涨基准"（从下限爬到封顶那段时间），回落耗时另算。
 *
 * @param {string} key
 * @param {{rates?:object, fillHours?:number, lust?:object}} [opts]
 * @returns {number|null}
 */
export function fillTimeHours(key, opts = {}) {
  if (key === 'warmthGain') return null
  const rates = normalizeRates(opts.rates)
  if (key === 'lust') {
    const p = normalizeLust(opts.lust)
    const rate = LUST_SLIDER_ENABLED ? (rates.lust ?? 1) : 1
    return p.fillHours / rate
  }
  const fill = normalizeFillHours(opts.fillHours)
  return fill / (rates[key] ?? 1)
}

/* ────────────────────────────── 归一化 ────────────────────────────── */

/** 补字段 + 夹紧范围，返回同一个对象（调用方持有引用）。 */
export function normalizeMood(raw) {
  const mood = raw !== null && typeof raw === 'object' ? raw : {}
  for (const key of ['missing', 'jealousy', 'warmth', 'worry', 'boredom', 'lust']) {
    mood[key] = clamp01(num(mood[key]))
  }
  mood.annoyanceDebt = Math.min(ANNOYANCE_MAX, Math.max(0, num(mood.annoyanceDebt)))
  if (mood.lastWarmthAt === undefined) mood.lastWarmthAt = null
  if (mood.lastRejectedAt === undefined) mood.lastRejectedAt = null
  if (mood.lastTeasedAt === undefined) mood.lastTeasedAt = null
  if (mood.lustPhase !== 'decay' && mood.lustPhase !== 'grow') mood.lustPhase = 'grow'
  return mood
}

/* ────────────────────────────── 演化 ────────────────────────────── */

/**
 * 时间流逝带来的自然变化。
 *
 * @param {object} mood
 * @param {number} hours 经过的小时数（调用方已经按 6 小时封顶）
 * @param {{hourOfDay?:number, hoursSinceQq?:number, rates?:object, fillHours?:number, lust?:object}} ctx
 * @returns {object} mood（原地改）
 */
export function evolve(mood, hours, ctx = {}) {
  const h = Math.min(6, Math.max(0, num(hours)))
  if (h <= 0) return mood
  normalizeMood(mood)

  const fill = normalizeFillHours(ctx.fillHours)
  const rates = normalizeRates(ctx.rates)
  /** 1.0x 时每小时的涨幅：6 小时 → 每小时 16.7%。 */
  const base = 1 / fill
  /** 涩涩不按"攒满"算，它自己一套：回落 / 自涨 / 封顶，全看这几个数。 */
  const lust = normalizeLust(ctx.lust)
  const lustRate = LUST_SLIDER_ENABLED ? (rates.lust ?? 1) : 1

  const hour = Number.isFinite(Number(ctx.hourOfDay)) ? Number(ctx.hourOfDay) : new Date().getHours()
  const sinceQq = Number.isFinite(Number(ctx.hoursSinceQq)) ? Number(ctx.hoursSinceQq) : Infinity
  const deepNight = hour >= 23 || hour < 3
  const smallHours = hour >= 0 && hour < 5

  // 想念：深夜更黏
  mood.missing = clamp01(num(mood.missing) + base * rates.missing * (deepNight ? 1.6 : 1) * h)

  // 吃醋：他半小时没在 QQ 冒头就开始攒
  if (sinceQq > 0.5) mood.jealousy = clamp01(num(mood.jealousy) + base * rates.jealousy * h)

  // 暖意：只会冷，冷到底就没了（1.0x 时 6 小时冷光）
  mood.warmth = clamp01(num(mood.warmth) - base * rates.warmthDecay * h)

  // 担心：凌晨他还没声音就涨，其余时间慢慢回落
  if (smallHours && sinceQq > 1) mood.worry = clamp01(num(mood.worry) + base * rates.worry * h)
  else mood.worry = clamp01(num(mood.worry) - base * h)

  // 闲：越想念越闲
  mood.boredom = clamp01(num(mood.boredom) + base * rates.boredom * (0.5 + 0.5 * num(mood.missing)) * h)

  // 涩涩：两层开关都亮着才动。两段式，靠 lustPhase 记现在在哪一段 ——
  //   decay（刚被挑逗过）→ 往余温下限落，落到了就翻成 grow
  //   grow（平时）       → 随「想他」往上爬，爬到自涨封顶就不动了，往上只能靠下一次挑逗
  // 任何一层开关没开，这一维就冻结在他上次留下的那个数上，不涨不掉。
  if (lust.enabled) {
    const cur = clamp01(num(mood.lust))
    if (mood.lustPhase === 'decay') {
      const drop = ((1 - lust.floor) / lust.decayHours) * lustRate * h
      const next = cur - drop
      if (next <= lust.floor) {
        mood.lust = lust.floor
        mood.lustPhase = 'grow'
      } else {
        mood.lust = next
      }
    } else if (cur < lust.selfCap) {
      const lift = ((lust.selfCap - lust.floor) / lust.fillHours) * lustRate * (0.5 + 0.5 * num(mood.missing)) * h
      mood.lust = Math.min(lust.selfCap, cur + lift)
    }
  }

  // 欠账自然消气（1.0x 时 6 小时消完 60 点）
  mood.annoyanceDebt = Math.max(0, num(mood.annoyanceDebt) - (ANNOYANCE_MAX / fill) * rates.annoyanceDecay * h)

  return mood
}

/* ────────────────────────────── 事件 ────────────────────────────── */

/**
 * 他从 QQ 出现了：想念、吃醋、闲、担心都往下掉，欠账消一大块。
 * 涩涩**不在这里动** —— 它事后往回落是自己那条回落曲线管的（见 evolve），
 * 他回来反而说明"人到了"，不该顺手把热度掐掉。
 */
export function onHeCameBack(mood) {
  normalizeMood(mood)
  mood.missing = Math.max(0, num(mood.missing) - 0.25)
  mood.jealousy = Math.max(0, num(mood.jealousy) - 0.1)
  mood.annoyanceDebt = Math.max(0, num(mood.annoyanceDebt) - 20)
  mood.boredom = Math.max(0, num(mood.boredom) - 0.2)
  mood.worry = Math.max(0, num(mood.worry) - 0.2)
  return mood
}

/**
 * 他挑逗她了（QQ 里认出来的）：涩涩直接顶上去一截。
 *
 * 涨多少 = 「单次涨幅」那个数（teaseStepPercent，默认 +25%），顶到 100% 就封顶。
 * 两层开关没全亮时什么都不做（默认就是不发动的，别因为一句话就把数改了）。
 *
 * @param {object} mood
 * @param {number|undefined} now
 * @param {{lust?:object}} [opts]
 */
export function onTeased(mood, now, opts = {}) {
  normalizeMood(mood)
  const lust = normalizeLust(opts.lust)
  if (!lust.enabled) return mood
  mood.lust = clamp01(num(mood.lust) + lust.teaseStep)
  mood.lustPhase = 'decay'
  mood.lastTeasedAt = now === undefined ? new Date().toISOString() : new Date(now).toISOString()
  return mood
}

/**
 * 他说了句好听的：暖意直接上脸，火气也没了。
 * 涨多少受「暖意（被哄时涨多少）」那条倍率影响。
 *
 * @param {object} mood
 * @param {number|undefined} now
 * @param {{rates?:object}} [opts]
 */
export function onSweetTalk(mood, now, opts = {}) {
  normalizeMood(mood)
  const gain = normalizeRates(opts.rates).warmthGain
  mood.warmth = clamp01(num(mood.warmth) + 0.3 * gain)
  mood.annoyanceDebt = Math.max(0, num(mood.annoyanceDebt) - 8)
  mood.missing = Math.max(0, num(mood.missing) - 0.1)
  mood.lastWarmthAt = now === undefined ? new Date().toISOString() : new Date(now).toISOString()
  return mood
}

/** 他说"别发了"：恼火欠账拉一块，暖意清零。 */
export function onRejected(mood, now) {
  normalizeMood(mood)
  mood.annoyanceDebt = Math.min(ANNOYANCE_MAX, num(mood.annoyanceDebt) + 30)
  mood.warmth = 0
  mood.lastRejectedAt = now === undefined ? new Date().toISOString() : new Date(now).toISOString()
  return mood
}

/** 投出去了，他一声不吭：记一笔忽略。 */
export function onIgnored(mood) {
  normalizeMood(mood)
  mood.annoyanceDebt = Math.min(ANNOYANCE_MAX, num(mood.annoyanceDebt) + 12)
  mood.missing = clamp01(num(mood.missing) + 0.05)
  return mood
}

/**
 * 投出去他回了：暖意涨一点。
 * @param {object} mood
 * @param {{rates?:object}} [opts]
 */
export function onReplied(mood, opts = {}) {
  normalizeMood(mood)
  const gain = normalizeRates(opts.rates).warmthGain
  mood.warmth = clamp01(num(mood.warmth) + 0.15 * gain)
  mood.missing = Math.max(0, num(mood.missing) - 0.1)
  return mood
}

/* ────────────────────────────── 读出来 ────────────────────────────── */

/** 0..1 的原始值 → 面板上显示的整数百分比。 */
export function percentOf(value) {
  return Math.round(clamp01(num(value)) * 100)
}

/** 恼火欠账 → 百分比。 */
export function annoyancePercent(debt) {
  return Math.round(Math.min(1, Math.max(0, num(debt) / ANNOYANCE_MAX)) * 100)
}

/**
 * 现在最突出的是哪种情绪。
 * 涩涩两层开关没全亮时它不参加评比（所以也永远不会出 flirty 那种语气）。
 *
 * @param {object} mood
 * @param {{lust?:object}} [opts]
 * @returns {{key:string, value:number}} 全都接近 0 时 key 是 'calm'
 */
export function dominant(mood, opts = {}) {
  normalizeMood(mood)
  const candidates = [
    ['missing', num(mood.missing)],
    ['jealousy', num(mood.jealousy)],
    ['warmth', num(mood.warmth)],
    ['worry', num(mood.worry)],
    ['boredom', num(mood.boredom)],
    ['annoyance', num(mood.annoyanceDebt) / ANNOYANCE_MAX],
  ]
  if (normalizeLust(opts.lust).enabled) candidates.push(['lust', num(mood.lust)])
  candidates.sort((a, b) => b[1] - a[1])
  const [key, value] = candidates[0]
  if (value < 0.25) return { key: 'calm', value }
  return { key, value }
}

const HINT_BY_MOOD = Object.freeze({
  annoyance: 'sulky',
  jealousy: 'pouty',
  worry: 'worried',
  warmth: 'warm',
  missing: 'clingy',
  boredom: 'light',
  lust: 'flirty',
  calm: 'flat',
})

/** 映射到 renderImpulse 认的语气键。 */
export function moodHintOf(mood, opts = {}) {
  return HINT_BY_MOOD[dominant(mood, opts).key] ?? 'flat'
}

/**
 * 面板用的一句话摘要，比如「想他 72% · 吃醋 12% · 涩涩 8%」。
 * 涩涩没开的时候写成「涩涩 8%（未启用）」，数字留着，一眼能看出是关着的。
 *
 * @param {object} mood
 * @param {{lust?:object}} [opts]
 */
export function digest(mood, opts = {}) {
  normalizeMood(mood)
  const lustOn = normalizeLust(opts.lust).enabled
  const parts = []
  parts.push(`想他 ${percentOf(mood.missing)}%`)
  parts.push(`吃醋 ${percentOf(mood.jealousy)}%`)
  parts.push(`暖意 ${percentOf(mood.warmth)}%`)
  parts.push(`担心 ${percentOf(mood.worry)}%`)
  parts.push(`闲 ${percentOf(mood.boredom)}%`)
  parts.push(`涩涩 ${percentOf(mood.lust)}%${lustOn ? '' : '（未启用）'}`)
  parts.push(`恼火 ${annoyancePercent(mood.annoyanceDebt)}%（${Math.round(num(mood.annoyanceDebt))}/${ANNOYANCE_MAX}）`)
  return parts.join(' · ')
}

/**
 * 面板要的完整快照：每一维的百分比 + 当前倍率 + 满值时间。
 *
 * 涩涩那行带两个标记：
 *   locked   滑条锁着（LUST_SLIDER_ENABLED = false），倍率固定 1.0x
 *   disabled 两层开关没全亮，这一维冻结、不打分
 * 涩涩的 fillHours 是「自涨基准」（从余温下限爬到自涨封顶要多久），不是攒满时间。
 *
 * @param {object} mood
 * @param {{rates?:object, fillHours?:number, lust?:object}} [opts]
 */
export function snapshot(mood, opts = {}) {
  normalizeMood(mood)
  const rates = normalizeRates(opts.rates)
  const fill = normalizeFillHours(opts.fillHours)
  const lust = normalizeLust(opts.lust)
  const rows = [
    { key: 'missing', label: MOOD_LABELS.missing, percent: percentOf(mood.missing) },
    { key: 'jealousy', label: MOOD_LABELS.jealousy, percent: percentOf(mood.jealousy) },
    { key: 'warmth', label: MOOD_LABELS.warmth, percent: percentOf(mood.warmth) },
    { key: 'worry', label: MOOD_LABELS.worry, percent: percentOf(mood.worry) },
    { key: 'boredom', label: MOOD_LABELS.boredom, percent: percentOf(mood.boredom) },
    { key: 'lust', label: MOOD_LABELS.lust, percent: percentOf(mood.lust) },
    { key: 'annoyance', label: '恼火', percent: annoyancePercent(mood.annoyanceDebt) },
  ]
  for (const row of rows) {
    const rateKey = row.key === 'annoyance' ? 'annoyanceDecay' : row.key
    row.rate = rates[rateKey] ?? 1
    row.locked = row.key === 'lust' && !LUST_SLIDER_ENABLED
    row.disabled = row.key === 'lust' && !lust.enabled
    row.fillHours = fillTimeHours(rateKey, { rates, fillHours: fill, lust })
  }
  return {
    fillHours: fill,
    lustUnlocked: LUST_SLIDER_ENABLED,
    // 代码里露没露这一组，和面板上台开关勾没勾，是两件事，都戴出来给面板判断
    lustAvailable: lust.codeEnabled,
    lustEnabled: lust.enabled,
    lust: {
      floorPercent: lust.floorPercent,
      selfCapPercent: lust.selfCapPercent,
      decayHours: lust.decayHours,
      fillHours: lust.fillHours,
      teaseStepPercent: lust.teaseStepPercent,
    },
    rows,
  }
}

/** 面板用的中文名。 */
export function labelOf(key) {
  if (key === 'calm') return '平静'
  if (key === 'annoyance') return '有点恼'
  return MOOD_LABELS[key] ?? key
}
