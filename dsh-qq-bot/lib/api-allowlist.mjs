/**
 * dsh-qq-bot 能让她调的 OneBot 接口清单。
 *
 * 为什么要有这么一份白名单：SnowLuma 那边一共暴露 188 个 Action，
 * 里面有一大半是群聊用的（群文件、群相册、群待办、精华、群管），
 * 还有一批是账号凭证和破坏性操作。她是「只跟他一个人聊」的私聊 Bot，
 * 那些能力给她没有意义，给错了就是现实伤害。
 *
 * 所以这里做的是「减法」：默认全不给，一个个人工放行。
 *
 * 三条硬规矩：
 *   1. 群聊相关的一律不放（`group_*` / 群文件 / 群相册 / 群待办 / 精华）
 *   2. 凭证类一律不放（cookies / credentials / csrf / clientkey / rkey）——
 *      拿到那玩意儿等于把整个 QQ 交出去
 *   3. 破坏性的一律不放（重启、退出、清缓存、改资料改头像、删好友）
 *
 * 分读写两组只为了让提示词能说清楚「哪些随便用、哪些要三思」，
 * 校验本身对两组一视同仁。
 */

/* ────────────────────────────── 只读 ────────────────────────────── */

/** 只读接口：查东西，不改任何状态。 */
export const READ_ACTIONS = Object.freeze([
  // 账号与连接
  'get_login_info', 'get_version_info', 'get_status', 'get_online_clients',
  'nc_get_user_status', 'nc_get_packet_status',

  // 好友与资料
  'get_friend_list', 'get_friends_with_category', 'get_stranger_info',
  'get_unidirectional_friend_list', 'get_doubt_friends_add_request',
  'get_recent_contact', 'get_profile_like',

  // 消息
  'get_msg', 'get_forward_msg', 'get_friend_msg_history',
  'get_msg_emoji_likes', 'get_emoji_likes', 'fetch_emoji_like', 'get_share_link',

  // 媒体与文件
  'get_image', 'get_record', 'get_file', 'get_private_file_url',
  'get_fileset_id', 'get_fileset_info', 'list_filesets',
  'get_flash_file_list', 'get_flash_file_url',
  'can_send_image', 'can_send_record',

  // 表情资源
  'fetch_sys_faces', 'search_sys_faces', 'fetch_face_entity', 'fetch_super_face_id',
  'fetch_custom_face', 'fetch_custom_face_detail',

  // 收藏 / 小程序 / AI
  'get_collection_list', 'get_mini_app_ark', 'get_ai_characters', 'get_ai_record',
  'check_url_safely',

  // QQ 空间（读）
  'get_qzone_msg_list', 'get_qzone_msg_detail', 'get_qzone_feeds',
])

/* ────────────────────────────── 会改状态 ────────────────────────────── */

/**
 * 写入 / 发送类：会真的发出去、或者改动某个东西。
 *
 * 注意这里面有几个「动人际」的（改备注、分类、同意好友申请）——
 * 按他的要求放行了，但调用方（模型）的描述里会写明「只有他明确要你这么做时才调」。
 */
export const WRITE_ACTIONS = Object.freeze([
  // 发消息
  'send_private_msg', 'send_msg', 'send_private_forward_msg', 'send_forward_msg',
  'upload_forward_msg', 'forward_friend_single_msg', 'delete_msg',
  'mark_msg_as_read', 'mark_private_msg_as_read',

  // 戳一戳 / 状态
  'send_poke', 'friend_poke', 'set_input_status',

  // 表情回应 / 名片赞 / 分享
  'set_msg_emoji_like', 'send_like', 'send_ark_share', 'send_tuwen_ark',
  'send_flash_msg', 'share_peer',

  // 自定义表情管理
  'add_custom_face', 'delete_custom_face', 'modify_custom_face',
  'move_custom_face_to_front', 'send_custom_face',

  // 文件上传 / 下载 / 闪传 / 收藏
  'upload_private_file', 'upload_file_stream', 'upload_foward_msg',
  'download_file', 'download_file_stream', 'download_file_image_stream',
  'download_file_record_stream', 'download_fileset', 'test_download_stream',
  'create_flash_task', 'delete_flash_file', 'rename_flash_file',
  'create_collection', 'request_decrypt_key', 'translate_en2zh',
  'click_inline_keyboard_button',

  // 好友相关（动人际，只在他明说时才该调）
  'set_friend_add_request', 'set_doubt_friends_add_request',
  'set_friend_remark', 'set_friends_category',

  // QQ 空间（写）
  'send_qzone_msg', 'like_qzone', 'unlike_qzone', 'comment_qzone',
])

/** 放行集合。 */
export const ALLOWED_ACTIONS = new Set([...READ_ACTIONS, ...WRITE_ACTIONS])

/* ────────────────────────────── 明确挡住 ────────────────────────────── */

/**
 * 挡住的接口 + 挡住的原因。写在这里不是为了报错好看，
 * 是为了她（或以后的我）调错时能立刻知道「这不是 bug，是故意不开」。
 */
export const DENIED_REASONS = Object.freeze({
  // 凭证：拿到就等于把账号交出去
  get_cookies: '能拿到登录态 cookies，等于把整个 QQ 账号交出去',
  get_credentials: '能拿到账号凭证',
  get_csrf_token: '能拿到 CSRF token，可以伪造写操作',
  get_clientkey: '能拿到 clientkey，属于登录凭证',
  get_rkey_server: '能拿到 rkey，能直接访问媒体资源',

  // 破坏性
  set_restart: '会把 QQ 进程重启，聊天当场断掉',
  bot_exit: '会让 Bot 退出登录',
  clean_cache: '会清缓存，可能丢图/丢文件',
  clean_stream_temp_file: '会清流式临时文件，可能中断正在传的东西',

  // 改自己
  set_qq_profile: '会改 QQ 资料（昵称/签名），这是他的账号不是她的',
  set_qq_avatar: '会换 QQ 头像，这是他的账号',
  set_self_longnick: '会改长昵称',
  set_online_status: '会改在线状态，可能让他在别人那儿显示异常',
  set_diy_online_status: '会改自定义在线状态',

  // 动人际
  delete_friend: '会删好友。这条是底线：不碰他的现实关系',

  // 空间里危险的那三个
  delete_qzone_msg: '会删说说，删了就没了',
  set_qzone_msg_right: '会改说说的可见范围，等于替他决定谁能看',
  set_qzone_ban: '会限制别人访问空间，是社交伤害',
})

/* ────────────────────────────── 判定 ────────────────────────────── */

/**
 * 这个 action 能不能调。
 *
 * @param {string} action
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
export function checkAction(action) {
  const name = String(action ?? '').trim()
  if (name === '') return { ok: false, reason: '没给 action 名' }

  if (Object.prototype.hasOwnProperty.call(DENIED_REASONS, name)) {
    return { ok: false, reason: `「${name}」是故意不开放的：${DENIED_REASONS[name]}` }
  }

  // 群聊相关的统一话术，省得一个个列
  if (/(^|_)group(_|$)|^get_qun|qun_album|essence|group_todo|group_tag/.test(name)) {
    return { ok: false, reason: `「${name}」是群聊用的接口，这个 Bot 只管私聊` }
  }

  if (!ALLOWED_ACTIONS.has(name)) {
    return { ok: false, reason: `「${name}」不在白名单里（可能是新接口，也可能是故意没开）` }
  }

  return { ok: true }
}

/**
 * 只有这些接口的「发给谁」参数会被强制钉成他本人。
 *
 * 为什么不能对所有写接口生效：`set_friend_remark` 里那个 user_id 指的是
 * 「要给哪个好友改备注」，钉成他就变成「给他改备注」了 —— 那是 bug 不是保护。
 * 所以要限制的只有两类：发消息 / 对他做动作。
 */
export const TARGET_CLAMPED = Object.freeze([
  'send_private_msg', 'send_msg', 'send_private_forward_msg', 'send_forward_msg',
  'upload_forward_msg', 'forward_friend_single_msg',
  'send_poke', 'friend_poke', 'set_input_status', 'send_like',
  'like_qzone', 'unlike_qzone', 'comment_qzone',
])

/**
 * 写类接口里，凡是指定「发给谁」的参数，一律强制改成他本人。
 *
 * 理由：她只跟他聊。放开通用的 user_id 等于给她一个「可以私聊任何人」的口子，
 * 那不是这个插件的设定，也不该由一次模型幻觉决定。
 *
 * @param {string} action
 * @param {object} params
 * @param {string} ownerUin 他的 QQ 号
 * @returns {object} 改过的 params（不改原对象）
 */
export function clampTarget(action, params, ownerUin) {
  const p = { ...(params ?? {}) }
  if (ownerUin === '') return p
  if (!TARGET_CLAMPED.includes(action)) return p

  // 这几个是「写给谁看/给谁发」的字段，统一钉死成他
  for (const key of ['user_id', 'target_uin', 'uin', 'peerUin']) {
    if (Object.prototype.hasOwnProperty.call(p, key)) {
      const n = Number(p[key])
      // 只在原本就指向别人的时候才改，指向自己的保持原样（省得动到 body 结构）
      if (Number.isFinite(n) && String(n) !== String(ownerUin)) p[key] = Number(ownerUin)
      else if (!Number.isFinite(n)) p[key] = Number(ownerUin)
    }
  }

  // send_msg 是通用接口，靠 message_type + user_id 定位，补上
  if (action === 'send_msg') {
    if (p.message_type === undefined) p.message_type = 'private'
    if (p.user_id === undefined) p.user_id = Number(ownerUin)
  }

  return p
}
