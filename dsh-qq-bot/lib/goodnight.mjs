/**
 * 道别闭环：双方都说过「晚安」之后，就别再追一句了。
 *
 * 真实场景（他 2026-10-27 报的）：
 *   她说「晚安，早点睡」→ 他回「晚安」→ **系统把这条当成一轮新对话**，
 *   于是她又回一句「晚安呀」→ 他可能再回一句 → 没完没了。
 *
 * 道别不是话题，是话题的句号。双方都说过之后，就该真的安静下来。
 *
 * 这里的规矩（刻意保守，宁可漏拦也别把他真说的话吞了）：
 *   1. 只有「她最后一句是道别」+「他这句也是道别」同时成立才吞
 *   2. 隔太久（默认 3 小时）就当新的一轮，不再拦
 *   3. 他要是说了别的内容，照常回
 *   4. 太长的不算道别（「我睡觉前记得把那个参数改了」是在说事）
 *
 * 纯函数，不碰 IO。
 */

/** 道别词。注意「睡」和「晚安」是最常见的两种收尾。 */
const FAREWELL_RE = /(晚安|睡了|睡啦|睡觉|先睡|去睡|眯一会|眯了|困了|拜拜|再见|明天见|回聊|早点睡|我下了|下线了|安啦|睡咯|歇了)/

/** 默认多久之后就不再算「同一轮道别」。 */
export const DEFAULT_GAP_MIN = 180

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
 * 这条消息该不该直接吞掉（不回）。
 *
 * @param {object} input
 * @param {string} input.text 他刚发来的文本
 * @param {{text:string, at:number}|null} input.lastAssistant 她最后说出的一句话
 * @param {number} input.now
 * @param {number} [input.gapMin] 超过这么久就不算同一轮
 * @returns {{stop:boolean, reason?:string}}
 */
export function shouldStopHere(input) {
  const { text, lastAssistant, now } = input ?? {}
  const gapMin = Number(input?.gapMin) > 0 ? Number(input.gapMin) : DEFAULT_GAP_MIN

  if (!isFarewell(text)) return { stop: false }

  const said = lastAssistant ?? null
  if (said === null || typeof said !== 'object') return { stop: false }
  if (!isFarewell(said.text)) return { stop: false }

  const at = Number(said.at) || 0
  if (at <= 0) return { stop: false }
  if (Number(now) < at) return { stop: false }
  if (Number(now) - at > gapMin * 60_000) return { stop: false }

  const minutes = Math.max(1, Math.round((Number(now) - at) / 60_000))
  return {
    stop: true,
    reason: `她 ${minutes} 分钟前已经说过「${String(said.text).slice(0, 12)}」，这条不追`,
  }
}
