/**
 * 合并转发 → 给人看的几行字。
 *
 * 为什么单独拆一个模块（2026-10-30）：
 *   以前这段逻辑直接写在 index.js 的 `qq_read_forward` 工具里，一个字都测不到。
 *   结果就是「转发读不出来」的时候没人分得清是接口坏了还是格式化坏了 ——
 *   实际是接口好的（日志里两次 get_forward_msg 都拿到了内容），只是每条
 *   被截到 200 字、图和文件只剩个空壳，读起来像「里面没东西」。
 *
 * 现在这里是纯函数：给它 get_forward_msg 的返回体，还给调用方一份能直接
 * 塞给模型的文本。截断、类型映射、空结果三件事都在这里定死，好测。
 */

/** 单条转发里，每个消息节点最多留多少字（原来是 200，200 常常把正文截断）。 */
export const FORWARD_NODE_MAX_CHARS = 600

/**
 * 一个消息段 → 一行占位文字。
 *
 * 图/表情/语音这些没有字节可读的，宁可明写占位，也不要静默丢掉 ——
 * 丢掉之后模型会以为那条里只有文字，回答就会漏掉一半。
 *
 * @param {unknown} seg
 * @returns {string}
 */
export function forwardSegText(seg) {
  if (typeof seg === 'string') return seg
  if (seg === null || typeof seg !== 'object') return ''
  const type = String(seg.type ?? '')
  const data = seg.data ?? {}
  switch (type) {
    case 'text':
      return String(data.text ?? '')
    case 'image':
      return '[图片]'
    case 'mface':
    case 'face':
      return '[表情]'
    case 'record':
      return '[语音]'
    case 'video':
      return '[视频]'
    case 'file':
      return `[文件:${String(data.name ?? '')}]`
    case 'at':
      return `@${String(data.qq ?? '')}`
    case 'forward':
      return '[嵌套转发]'
    case 'reply':
      // 转发里的引用段没有可展示的内容，别把它当正文
      return ''
    default:
      return ''
  }
}

/**
 * 把一个转发节点里的消息体拼成一行。
 *
 * 三种形态都认：`message` 是段数组（SnowLuma 用的）、`content` 是段数组、
 * `message` 是纯字符串。
 *
 * @param {any} node
 * @returns {string}
 */
export function forwardNodeBody(node) {
  const raw = node?.message ?? node?.content
  if (typeof raw === 'string') return raw.trim()
  if (!Array.isArray(raw)) return ''
  return raw.map(forwardSegText).join('').trim()
}

/**
 * 取一个节点的发件人名。
 *
 * @param {any} node
 * @returns {string}
 */
export function forwardNodeSender(node) {
  return String(
    node?.sender?.nickname ?? node?.sender?.card ?? node?.sender?.user_id ?? node?.user_id ?? node?.name ?? '某人',
  ).trim() || '某人'
}

/**
 * 从 `get_forward_msg` 的返回体里挑出节点数组。
 *
 * 协议端有的把节点放在 `messages`，有的放在 `message`，还有的套一层 `data`
 * —— 都认，省得为了一个字段名再改一次。
 *
 * @param {any} data
 * @returns {any[]}
 */
export function forwardNodes(data) {
  const pick = (v) => (Array.isArray(v) ? v : null)
  return (
    pick(data?.messages) ??
    pick(data?.message) ??
    pick(data?.data?.messages) ??
    pick(data?.data?.message) ??
    []
  )
}

/**
 * 转发 → 每行一条「昵称：内容」。
 *
 * 空内容、取不到发件人的节点会被跳过；全都空就返回空数组，交给
 * `renderForward` 说「这条是空的或者过期了」。
 *
 * @param {any} data  get_forward_msg 的返回体
 * @param {{maxChars?: number}} [opts]
 * @returns {string[]}
 */
export function formatForwardNodes(data, { maxChars = FORWARD_NODE_MAX_CHARS } = {}) {
  const cap = Math.max(40, Math.floor(Number(maxChars) || FORWARD_NODE_MAX_CHARS))
  const out = []
  for (const node of forwardNodes(data)) {
    const body = forwardNodeBody(node)
    if (body === '') continue
    const sender = forwardNodeSender(node)
    out.push(`${sender}：${body.length > cap ? `${body.slice(0, cap)}…` : body}`)
  }
  return out
}

/**
 * 转发 → 直接能给模型看的一段文本（含「读不到」的兜底话术）。
 *
 * @param {any} data
 * @param {{maxChars?: number}} [opts]
 * @returns {string}
 */
export function renderForward(data, opts = {}) {
  const lines = formatForwardNodes(data, opts)
  if (lines.length === 0) return '（这条转发是空的，或者已经过期读不到了）'
  return lines.join('\n')
}
