/**
 * 「小动作」的每日额度。
 *
 * 为什么要单独记一本账：说话有主额度（maxPerHour / maxPerDay）管着，
 * 但戳一戳、发说说、发链接卡片这些**不是说话** —— 它们打扰的方式不一样，
 * 混在同一个池子里就会互相挤占：
 *   她今天说了 50 句，就再也戳不了你一下；或者她为了戳你，把说话的额度吃光了。
 *
 * 尤其是「发说说」：那是**替他在社交圈公开发言**，一天一条都算多。
 * 所以这三样各记各的，跟说话完全分开。
 *
 * 放在 qq-bot 这一侧而不是 alive 那侧，是因为**只有这里知道她真调了什么**：
 * alive 投完念头就撒手了，她到底戳没戳、发没发，alive 看不见。
 *
 * 全是纯函数，不碰 IO。
 */

/** 默认额度。0 = 关掉这一项。 */
export const INTERACT_DEFAULTS = Object.freeze({
  pokeMaxPerDay: 5,
  qzoneMaxPerDay: 1,
  linkMaxPerDay: 1,
})

/** 三样分别叫什么，报错时用得上。 */
export const INTERACT_LABELS = Object.freeze({
  poke: '戳一戳',
  qzone: '发说说',
  link: '分享链接',
})

/** 一天的账本。dayStart 是毫秒时间戳。 */
export function emptyBudget(now = Date.now()) {
  return { dayStart: now, poke: 0, qzone: 0, link: 0 }
}

/**
 * 跨天了就归零。跟作息无关，就是自然日 24 小时滚动。
 * @param {object|null} budget
 * @param {number} now
 */
export function rollDay(budget, now) {
  const start = Number(budget?.dayStart) || 0
  if (start === 0 || now - start >= 86_400_000 || now < start) return emptyBudget(now)
  return {
    dayStart: start,
    poke: Number(budget?.poke) || 0,
    qzone: Number(budget?.qzone) || 0,
    link: Number(budget?.link) || 0,
  }
}

/**
 * 这一项还能不能用。
 *
 * @param {object} budget rollDay 之后的结果
 * @param {'poke'|'qzone'|'link'} kind
 * @param {number} max 0 表示这项关掉了
 * @returns {{ok:boolean, used:number, max:number, reason?:string}}
 */
export function checkBudget(budget, kind, max) {
  const cap = Number(max) || 0
  const used = Number(budget?.[kind]) || 0
  const label = INTERACT_LABELS[kind] ?? kind

  if (cap <= 0) {
    return { ok: false, used, max: 0, reason: `${label} 没开（额度设成 0 了）` }
  }
  if (used >= cap) {
    return { ok: false, used, max: cap, reason: `${label} 今天已经 ${used}/${cap} 次了，明天再说` }
  }
  return { ok: true, used, max: cap }
}

/**
 * 记一次。返回新对象，不改原来的。
 * @param {object} budget
 * @param {'poke'|'qzone'|'link'} kind
 */
export function takeBudget(budget, kind) {
  const next = rollDay(budget, Number(budget?.dayStart) || Date.now())
  next[kind] = (Number(next[kind]) || 0) + 1
  return next
}
