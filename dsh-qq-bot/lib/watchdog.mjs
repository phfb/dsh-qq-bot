/**
 * 看门狗：她这一轮跑太久没有任何输出，就该有人管。
 *
 * 为什么需要它 —— 2026-10-27 那晚的两种死法它都管得住：
 *   1. 模型把整段回复写进思考通道、正文空（零正文）
 *   2. 请求发出去了，一直没回包（今晚实测有一轮等了 110 秒）
 * 第二种「零正文判定」抓不到，因为那一轮压根还没结束 —— 只能靠时间。
 *
 * 判定只看一件事：**这一轮还在跑，但已经多久没有任何事件了**。
 * 不看思考内容 —— 插件的视角里没有 thinking 的流，逐 token 增量只喂界面，
 * 想盯内容得往宿主里挂钩子，那是另一层的事。
 *
 * 处理顺序（一次比一次硬）：
 *   超时 → 中断 + 临时关思考 + 催一句
 *   再超时 → 中断 + 催
 *   达到上限 → 开新对话
 */

/** 默认参数：300 秒是保守值（今晚那次「慢」到了 110 秒，但它没卡死，别误杀）。 */
export const WATCHDOG_DEFAULTS = Object.freeze({
  seconds: 300,
  maxStrikes: 2,
})

/**
 * 该不该动手。
 *
 * @param {object} input
 * @param {boolean} input.inTurn 这一轮还在跑吗（turn/start 之后、turn/end 之前）
 * @param {number} input.idleMs 距最后一次事件过了多久
 * @param {number} input.thresholdMs 阈值（<=0 表示关掉）
 * @param {number} input.strikes 这一轮已经被救过几次
 * @param {number} input.maxStrikes 最多救几次，到了就换局（<=0 表示不换局）
 * @returns {'off' | 'idle' | 'wait' | 'rescue' | 'rollover'}
 */
export function judgeWatchdog({ inTurn, idleMs, thresholdMs, strikes, maxStrikes }) {
  if (!(thresholdMs > 0)) return 'off'
  if (inTurn !== true) return 'idle'
  // 时间戳可能来自别的时钟/被打断：不是有限正数就当「刚动过」，宁可不动手
  if (!Number.isFinite(idleMs) || idleMs < 0) return 'wait'
  if (idleMs < thresholdMs) return 'wait'
  const used = Number(strikes) || 0
  const limit = Number(maxStrikes) || 0
  if (limit > 0 && used >= limit) return 'rollover'
  return 'rescue'
}
