/**
 * 把 OneBot 的「非消息事件」翻成一句她看得懂的人话。
 *
 * 为什么需要这个：dsh-qq-bot 原来在事件总入口第一行就是
 *   `if (event?.post_type !== 'message') return`
 * 于是戳一戳、撤回、好友申请这些**全被扔掉了**，连日志都不留 ——
 * 他戳她一下，她那边一点动静都没有，还以为是插件坏了。
 *
 * 这里的规矩：
 *   - 只翻「跟他有关、她会想回应」的
 *   - 自己的动作回声（比如自己设的"正在输入"）不翻，否则会自激
 *   - 群里的、跟私聊无关的一律不管（这个 Bot 只管私聊）
 *   - 拿不准就返回 null（宁可不说，也别让她对着一条空事件瞎猜）
 */

/** 已经处理过、不必再往上送的 notify 子类型。 */
const SILENT_SUBTYPES = new Set(['input_status', 'online_file', 'honor'])

/**
 * @param {object} event OneBot 事件
 * @param {{selfUin?: string}} [opts]
 * @returns {string | null} 一句话；null = 这个事件不用管
 */
export function socialEventToText(event, opts = {}) {
  const selfUin = String(opts.selfUin ?? '')
  const postType = String(event?.post_type ?? '')
  if (postType === 'message' || postType === 'meta_event') return null

  // OneBot 标准是 user_id；有些实现用 sender_id / uin，三个都认
  const who = String(event?.user_id ?? event?.sender_id ?? event?.uin ?? '')

  // 自己的动作回声直接丢掉（否则「正在输入」会自己触发自己）
  if (selfUin !== '' && who === selfUin) return null

  /* ── 通知 ── */
  if (postType === 'notice') {
    const noticeType = String(event?.notice_type ?? '')
    const subType = String(event?.sub_type ?? '')

    if (SILENT_SUBTYPES.has(subType)) return null

    // 戳一戳：朋友之间最常见的小动作，她一定要有反应
    if (noticeType === 'notify' && subType === 'poke') {
      const target = String(event?.target_id ?? event?.target_uin ?? '')
      // 戳的是别人（群里的镜像事件）→ 跟她无关
      if (selfUin !== '' && target !== '' && target !== selfUin) return null
      return '他戳了戳你'
    }

    // 私聊撤回
    if (noticeType === 'friend_recall') {
      return '他把刚发的一条消息撤回了'
    }

    // 他把你加回来 / 通过了好友
    if (noticeType === 'friend_add') {
      return '他把你加为好友了'
    }

    // 名片赞
    if (noticeType === 'profile_like') {
      const times = Number(event?.times ?? 1)
      return times > 1 ? `他给你的名片点了 ${times} 个赞` : '他给你的名片点了赞'
    }

    // 群相关（group_recall / group_admin / group_upload…）一律不管
    return null
  }

  /* ── 请求 ── */
  if (postType === 'request') {
    const requestType = String(event?.request_type ?? '')

    if (requestType === 'friend') {
      const comment = String(event?.comment ?? '').trim()
      const flag = String(event?.flag ?? '')
      const tail = comment === '' ? '' : `，附言：${comment.slice(0, 60)}`
      // 带上 flag 的短哈希，她真要同意时能对上号，又不至于把整串塞进上下文
      const tag = flag === '' ? '' : `（申请号 ${flag.slice(0, 8)}）`
      return `有个 ${who} 想加你好友${tail}${tag}`
    }

    // 群邀请 / 群申请：这个 Bot 只管私聊，跳过
    return null
  }

  return null
}
