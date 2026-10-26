/**
 * 白名单 + 事件翻译的单元测试。纯函数，不需要连接、不需要 DSH。
 *
 *   node --test "test/*.test.mjs"     （在 dsh-qq-bot 目录下跑）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ALLOWED_ACTIONS,
  DENIED_REASONS,
  READ_ACTIONS,
  WRITE_ACTIONS,
  checkAction,
  clampTarget,
} from '../lib/api-allowlist.mjs'
import { socialEventToText } from '../lib/notice.mjs'
import { extractText } from '../lib/policy.mjs'

/* ── 白名单：放行的 ── */

test('checkAction: 私聊常用的都放行', () => {
  for (const a of ['send_private_msg', 'get_friend_list', 'send_poke', 'get_msg', 'set_input_status']) {
    assert.equal(checkAction(a).ok, true, `${a} 应该放行`)
  }
})

test('checkAction: 空间读 + 发 + 赞评都放行', () => {
  for (const a of ['get_qzone_msg_list', 'get_qzone_msg_detail', 'get_qzone_feeds',
    'send_qzone_msg', 'like_qzone', 'unlike_qzone', 'comment_qzone']) {
    assert.equal(checkAction(a).ok, true, `${a} 应该放行`)
  }
})

/* ── 白名单：挡住的 ── */

test('checkAction: 群聊接口全挡（这个 Bot 只管私聊）', () => {
  for (const a of ['send_group_msg', 'set_group_ban', 'get_group_member_list',
    'upload_group_file', 'get_group_album_list', 'set_group_todo', 'get_group_tags']) {
    const r = checkAction(a)
    assert.equal(r.ok, false, `${a} 不该放行`)
    assert.match(r.reason, /群聊/)
  }
})

test('checkAction: 登录凭证一个都不给', () => {
  for (const a of ['get_cookies', 'get_credentials', 'get_csrf_token', 'get_clientkey', 'get_rkey_server']) {
    const r = checkAction(a)
    assert.equal(r.ok, false, `${a} 绝对不该放行`)
    assert.ok(Object.prototype.hasOwnProperty.call(DENIED_REASONS, a), `${a} 该有明确的拒绝理由`)
  }
})

test('checkAction: 破坏性操作全挡', () => {
  for (const a of ['set_restart', 'bot_exit', 'clean_cache', 'delete_friend',
    'set_qq_profile', 'set_qq_avatar', 'set_online_status']) {
    assert.equal(checkAction(a).ok, false, `${a} 不该放行`)
  }
})

test('checkAction: 空间里危险的那三个挡掉', () => {
  for (const a of ['delete_qzone_msg', 'set_qzone_msg_right', 'set_qzone_ban']) {
    assert.equal(checkAction(a).ok, false, `${a} 不该放行`)
  }
})

test('checkAction: 不认识的名字给个能看懂的理由', () => {
  const r = checkAction('no_such_action_xyz')
  assert.equal(r.ok, false)
  assert.match(r.reason, /白名单/)
  assert.equal(checkAction('').ok, false)
})

test('白名单读写两组不重叠、都进了总表', () => {
  const overlap = READ_ACTIONS.filter((a) => WRITE_ACTIONS.includes(a))
  assert.equal(overlap.length, 0, `读写两组不该重叠：${overlap.join(', ')}`)
  for (const a of [...READ_ACTIONS, ...WRITE_ACTIONS]) {
    assert.equal(ALLOWED_ACTIONS.has(a), true, `${a} 没进总表`)
  }
})

/* ── 收件人钉死 ── */

const OWNER = '10001'

test('clampTarget: 发消息的对象被改成他', () => {
  const p = clampTarget('send_private_msg', { user_id: 999999, message: [] }, OWNER)
  assert.equal(String(p.user_id), OWNER)
})

test('clampTarget: 指向他本人的保持原样', () => {
  const p = clampTarget('send_private_msg', { user_id: Number(OWNER) }, OWNER)
  assert.equal(p.user_id, Number(OWNER))
})

test('clampTarget: send_msg 自动补成私聊 + 他', () => {
  const p = clampTarget('send_msg', {}, OWNER)
  assert.equal(p.message_type, 'private')
  assert.equal(String(p.user_id), OWNER)
})

test('clampTarget: 给好友改备注不该被钉成他（回归）', () => {
  // set_friend_remark 的 user_id 指的是「给谁改备注」，改成他就成了 bug
  const p = clampTarget('set_friend_remark', { user_id: 888888, remark: '老王' }, OWNER)
  assert.equal(String(p.user_id), '888888')
  assert.equal(p.remark, '老王')
})

test('clampTarget: 读接口不动参数', () => {
  const p = clampTarget('get_qzone_msg_list', { target_uin: 55555, num: 10 }, OWNER)
  assert.equal(p.target_uin, 55555)
})

test('clampTarget: 没配 owner 就原样返回', () => {
  const p = clampTarget('send_private_msg', { user_id: 999 }, '')
  assert.equal(p.user_id, 999)
})

/* ── 事件翻译 ── */

const SELF = '10002'

test('socialEventToText: 戳一戳', () => {
  const t = socialEventToText(
    { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: 20002, target_id: Number(SELF) },
    { selfUin: SELF },
  )
  assert.equal(t, '他戳了戳你')
})

test('socialEventToText: 戳的是别人就不管', () => {
  const t = socialEventToText(
    { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: 123, target_id: 456 },
    { selfUin: SELF },
  )
  assert.equal(t, null)
})

test('socialEventToText: 自己的动作回声丢掉（不然会自激）', () => {
  const t = socialEventToText(
    { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: Number(SELF) },
    { selfUin: SELF },
  )
  assert.equal(t, null)
})

test('socialEventToText: 撤回', () => {
  const t = socialEventToText({ post_type: 'notice', notice_type: 'friend_recall', user_id: 20002 })
  assert.match(t, /撤回/)
})

test('socialEventToText: 他把你加为好友', () => {
  const t = socialEventToText({ post_type: 'notice', notice_type: 'friend_add', user_id: 20002 })
  assert.match(t, /好友/)
})

test('socialEventToText: 正在输入这种噪音不送进去', () => {
  const t = socialEventToText(
    { post_type: 'notice', notice_type: 'notify', sub_type: 'input_status', user_id: 20002 },
  )
  assert.equal(t, null)
})

test('socialEventToText: 群事件一律不管', () => {
  assert.equal(socialEventToText({ post_type: 'notice', notice_type: 'group_recall', group_id: 1, user_id: 2 }), null)
  assert.equal(socialEventToText({ post_type: 'request', request_type: 'group', group_id: 1, user_id: 2 }), null)
})

test('socialEventToText: 好友申请带上号码和短 flag', () => {
  const t = socialEventToText({
    post_type: 'request',
    request_type: 'friend',
    user_id: 77778888,
    comment: '我是小明',
    flag: 'ABCDEFGH12345678',
  })
  assert.match(t, /77778888/)
  assert.match(t, /我是小明/)
  assert.match(t, /ABCDEFGH/)          // 只留前 8 位
  assert.ok(!t.includes('12345678'), 'flag 后半段不该塞进上下文')
})

test('socialEventToText: 普通消息不走这条路', () => {
  assert.equal(socialEventToText({ post_type: 'message', message_type: 'private', user_id: 1 }), null)
  assert.equal(socialEventToText({ post_type: 'meta_event', meta_event_type: 'heartbeat' }), null)
})

/* ── 合并转发要带 id ── */

test('extractText: 合并转发带上 id，才能展开看内容', () => {
  const msg = [{ type: 'forward', data: { id: 'abc123' } }]
  assert.equal(extractText(msg), '[合并转发:abc123]')
})

test('extractText: 没 id 的转发退回旧写法', () => {
  assert.equal(extractText([{ type: 'forward', data: {} }]), '[合并转发]')
})
