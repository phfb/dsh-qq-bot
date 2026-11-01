/**
 * 节点池切换 → 换新对话：判定逻辑（纯函数，方便单测）。
 *
 * 这个模块不碰 ctx、不碰网络、不读写文件 —— 输入什么判什么，同样的输入永远
 * 同样的输出。真正的副作用（建会话、发 QQ 消息、落盘）留在 index.js。
 *
 * ## 为什么不是「一切节点就换局」
 *
 * 2026-11-02 的实测数据（那个 465 轮的长会话）：
 *
 *   A→B→A 第一次：切走前 bit hit=48512 → 切过去全 miss → 切回 hit=30208，
 *                  第二次请求就回到 64640
 *   A→B→A 第二次：切回 hit=7808 → 第三次请求 390656（历史全接上）
 *
 * 也就是说切回原节点时，那边的 prompt 缓存**还在**，前缀没变就能接回，
 * 只赔一两次请求。所以 A-B-A 的抖动根本不该换局 —— 换了反而把那份缓存废掉。
 *
 * ## 判定链（方案 2 → 方案 3，串联）
 *
 * 前置：这一局累计 token 用量没到 minTokens（默认 50M）→ 直接放过。
 *       短会话重算一次也就几万 token，换局反而亏；只有跑到这个量级，
 *       全量重算才够贵，换局才划算。
 *
 * 然后二选一，满足任一就换：
 *   A. 连续 streakN（默认 3）轮都跑在新节点上 —— 真留下来了
 *   B. 最近 windowX（默认 8）轮里，有 windowM（默认 5）轮跑在新节点上
 *      —— 来回抖，但大半时间不在原节点
 *
 * 两种都不满足就继续挂着（pending 不清），下一轮再判。
 */

/** evaluate() 的返回动作。 */
export const ROTATE_ACTION = Object.freeze({
  /** 没有待决的切换 */
  NOOP: 'noop',
  /** 这局用量还没到门槛 */
  BELOW_TOKENS: 'below-tokens',
  /** 离上次真换局太近 */
  COOLDOWN: 'cooldown',
  /** 已经切回这局开工时的节点，缓存能接回，不换 */
  BACK_TO_BASELINE: 'back-to-baseline',
  /** 条件还没攒够，下一轮再看 */
  NOT_YET: 'not-yet',
  /** 换局 */
  ROTATE: 'rotate',
})

/**
 * 把 node-switch.json 的原始内容解析成事件。
 *
 * 文件坏掉、字段缺失、seq 不是正整数 —— 一律返回 null，调用方当成"没有切换"。
 *
 * @param {unknown} raw 已经 JSON.parse 过的内容（读不到就是 null）
 * @returns {{seq:number, at:string, from:string, to:string}|null}
 */
export function parseSwitchEvent(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const seq = Number(raw.seq)
  if (!Number.isFinite(seq) || seq <= 0 || !Number.isInteger(seq)) return null
  return {
    seq,
    at: typeof raw.at === 'string' ? raw.at : '',
    from: typeof raw.from === 'string' ? raw.from : '',
    to: typeof raw.to === 'string' ? raw.to : '',
  }
}

/** 万/亿 的短标签，只给日志用。 */
function fmtTokens(n) {
  const v = Number(n) || 0
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)} 亿`
  if (v >= 1e4) return `${(v / 1e4).toFixed(0)} 万`
  return String(Math.round(v))
}

/** 日志里 url 太长，只留域名。 */
export function shortUrl(u) {
  const s = String(u || '')
  const m = s.match(/^https?:\/\/([^/]+)/i)
  return m ? m[1] : s || '(未定)'
}

/**
 * 解析 node-rotate-state.json。没跑过就给一份干净的初始状态。
 *
 * @param {unknown} raw
 * @returns {{lastSeq:number, lastAt:number, baselineUrl:string, genTokens:number, turnNodes:{at:number,url:string}[], pending:{seq:number,from:string,to:string,at:string}|null}}
 */
export function parseState(raw) {
  const base = { lastSeq: 0, lastAt: 0, baselineUrl: '', genTokens: 0, turnNodes: [], pending: null }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return base

  const seq = Number(raw.lastSeq)
  const at = Number(raw.lastAt)
  const tokens = Number(raw.genTokens)
  const state = {
    lastSeq: Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 0,
    lastAt: Number.isFinite(at) && at > 0 ? at : 0,
    baselineUrl: typeof raw.baselineUrl === 'string' ? raw.baselineUrl : '',
    genTokens: Number.isFinite(tokens) && tokens > 0 ? tokens : 0,
    turnNodes: [],
    pending: null,
  }

  if (Array.isArray(raw.turnNodes)) {
    for (const t of raw.turnNodes) {
      if (!t || typeof t !== 'object') continue
      const ts = Number(t.at)
      if (!Number.isFinite(ts) || ts <= 0) continue
      state.turnNodes.push({ at: ts, url: typeof t.url === 'string' ? t.url : '' })
    }
  }

  if (raw.pending && typeof raw.pending === 'object') {
    const pseq = Number(raw.pending.seq)
    if (Number.isFinite(pseq) && pseq > 0) {
      state.pending = {
        seq: Math.floor(pseq),
        from: typeof raw.pending.from === 'string' ? raw.pending.from : '',
        to: typeof raw.pending.to === 'string' ? raw.pending.to : '',
        at: typeof raw.pending.at === 'string' ? raw.pending.at : '',
      }
    }
  }

  return state
}

/**
 * 该不该换局。
 *
 * @param {object} input
 * @param {{seq:number,from:string,to:string,at:string}|null} input.pending 待决的切换（没有就是 null）
 * @param {string} input.baselineUrl 这局开工时的 baseURL
 * @param {{at:number,url:string}[]} input.turnNodes 最近若干轮各自跑在哪个 url
 * @param {number} input.genTokens 这局累计 token 用量
 * @param {number} input.minTokens 门槛（0 = 不看用量）
 * @param {number} input.streakN 连续几轮就算"留下了"
 * @param {number} input.windowX 窗口大小（轮）
 * @param {number} input.windowM 窗口里几轮就算"大半时间不在原节点"
 * @param {number} input.cooldownMs 两次真换局之间的冷却
 * @param {number} input.lastRotateAt 上次真换局的时间戳
 * @param {number} input.now 当前时间戳
 * @returns {{action:string, reason:string, matched?:string}}
 */
export function evaluate({
  pending,
  baselineUrl,
  turnNodes,
  genTokens,
  minTokens,
  streakN,
  windowX,
  windowM,
  cooldownMs,
  lastRotateAt,
  now,
}) {
  if (!pending) return { action: ROTATE_ACTION.NOOP, reason: '没有待决的节点切换' }

  const tokens = Number(genTokens) || 0
  const floor = Number(minTokens) || 0
  if (floor > 0 && tokens < floor) {
    return {
      action: ROTATE_ACTION.BELOW_TOKENS,
      reason: `这局才用了 ${fmtTokens(tokens)} token，没到门槛 ${fmtTokens(floor)}`,
    }
  }

  const cool = Number(cooldownMs) || 0
  const since = Number(lastRotateAt) > 0 ? now - Number(lastRotateAt) : Number.POSITIVE_INFINITY
  if (cool > 0 && since < cool) {
    return {
      action: ROTATE_ACTION.COOLDOWN,
      reason: `离上次换局才 ${Math.max(0, Math.round(since / 1000))} 秒，冷却 ${Math.round(cool / 1000)} 秒`,
    }
  }

  const current = pending.to
  const baseline = typeof baselineUrl === 'string' ? baselineUrl : ''
  if (baseline !== '' && current === baseline) {
    return {
      action: ROTATE_ACTION.BACK_TO_BASELINE,
      reason: `当前节点就是这局开工时的 ${shortUrl(baseline)}，缓存能接回，不换`,
    }
  }

  const nodes = Array.isArray(turnNodes) ? turnNodes : []
  const onCurrent = (t) => t && t.url === current

  // A 判定：连续 streakN 轮都在新节点上
  const n = Math.max(1, Math.floor(Number(streakN) || 1))
  const tail = nodes.slice(-n)
  if (tail.length >= n && tail.every(onCurrent)) {
    return {
      action: ROTATE_ACTION.ROTATE,
      reason: `连续 ${n} 轮都在 ${shortUrl(current)} 上`,
      matched: 'streak',
    }
  }

  // B 判定：最近 windowX 轮里够 windowM 轮在新节点上
  const x = Math.max(1, Math.floor(Number(windowX) || 1))
  const m = Math.max(1, Math.floor(Number(windowM) || 1))
  const recent = nodes.slice(-x)
  const hits = recent.filter(onCurrent).length
  if (recent.length >= m && hits >= m) {
    return {
      action: ROTATE_ACTION.ROTATE,
      reason: `最近 ${recent.length} 轮里有 ${hits} 轮在 ${shortUrl(current)} 上（阈值 ${m}）`,
      matched: 'window',
    }
  }

  const streak = tail.filter(onCurrent).length
  return {
    action: ROTATE_ACTION.NOT_YET,
    reason:
      `还没攒够：连续 ${streak}/${n} 轮，` +
      `最近 ${recent.length} 轮里 ${hits}/${m} 轮在 ${shortUrl(current)}`,
  }
}
