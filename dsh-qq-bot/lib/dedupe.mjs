/**
 * 重复消息判定。
 *
 * 2026-10-27 现场：同一条话连发两次（他手滑 / 网络重发 / 复制粘贴），
 * 每一份都触发了一轮 —— 她于是把同一段回答了两遍，第二遍还带点不耐烦
 * （「听到了，第三遍了 / 你不用一遍一遍再讲」）。看着像她记不住，其实是重复投递。
 *
 * 判据三条，缺一不可：
 *   1. 同一个人的同一句话（去掉首尾空白后完全一样，不做模糊匹配 —— 模糊会误伤）
 *   2. 两次间隔在窗口内
 *   3. **前一条还在处理中**，或者前一条刚处理完不久 ——
 *      隔了一小时他自己再发一遍，那是他故意重讲，得让她听见
 *
 * 不带图不带文件的纯文本才合并：带图/文件的消息每份都是独立的「东西」，不能吞。
 */

/**
 * @param {object} input
 * @param {string | null} input.lastText 上一条正文（没有就 null）
 * @param {number} input.lastAt 上一条的时间戳
 * @param {number} input.now 现在
 * @param {number} input.windowMs 判定窗口
 * @param {boolean} input.lastInFlight 上一条还在处理中吗
 * @returns {boolean} true = 这条是重复的，丢掉
 */
export function isDuplicateMessage({ lastText, lastAt, now, windowMs, lastInFlight }) {
  if (typeof lastText !== 'string' || lastText === '') return false
  if (!(windowMs > 0)) return false
  if (!Number.isFinite(lastAt) || !Number.isFinite(now)) return false
  const gap = now - lastAt
  // 时间戳反了（时钟跳变 / 别的进程写的时间）就别乱合并
  if (gap < 0) return false
  // 还在处理中：隔多久都算重复（他可能等急了又发一遍）
  if (lastInFlight === true) return true
  return gap <= windowMs
}
