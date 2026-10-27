/**
 * 「她这一轮到底说没说话」的判定。
 *
 * 2026-10-27 的事故现场：那几轮她的 reasoning 里躺着**已经起草好的回复**
 * （"回应：配图看到了 / 两条 8G DDR4 3200…分条。"），正文留空就 stop 了，
 * QQ 那边一个字收不到。这是故障，得催。
 *
 * 但同样"零正文"还有另一种：**她动了手，本来就不打算说话** ——
 * 你让她戳你一下、她就戳了；让她点个赞、她就点了。这种沉默是她的表达方式，
 * 催一句"把话直接说出来"等于嫌她多做了动作，很蠢。
 *
 * 所以判定要能分开这两种。判据只有两条，都来自真实数据：
 *   1. 最后一步的思考里有没有实质内容 —— 有，就是"答案写错通道了"（turn 224 是 308 字）
 *   2. 这一轮有没有动过手 —— 没动手又没说话，那肯定是卡了（turn 225 就是这种）
 *
 * 两条都不占（动了手、思考里也没东西）→ 按"故意不说话"处理，不催不罚。
 */

/** 思考少于这个字数就不算「答案写在思考里」——避免把一句语气词当证据。 */
export const STUCK_REASONING_MIN_CHARS = 20

/**
 * @typedef {{spoke?: boolean, hadToolCall?: boolean, lastReasoningLen?: number}} TurnSignals
 */

/**
 * 判定这一轮属于哪种沉默。
 *
 * @param {TurnSignals} signals
 * @returns {'spoken' | 'stuck' | 'quiet'}
 *   spoken = 她说话了，一切正常
 *   stuck  = 故障：答案写在思考里 / 干脆什么都没干
 *   quiet  = 她动了手没说话，按故意处理
 */
export function judgeTurnSilence(signals) {
  const spoke = signals?.spoke === true
  if (spoke) return 'spoken'

  const reasoningLen = Number(signals?.lastReasoningLen) || 0
  if (reasoningLen >= STUCK_REASONING_MIN_CHARS) return 'stuck'

  if (signals?.hadToolCall !== true) return 'stuck'

  return 'quiet'
}
