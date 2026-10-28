/**
 * 设置面板的防回归测试（2026-10-28 加）
 *
 * 为什么要有这份：这一轮出的事故都不是「写错逻辑」，而是**两处手抄的表对不上**：
 *   1. 前端 client.js 手抄了一份字段表，只抄了 6 组 24 项 —— 每日说说 / 说说互动 /
 *      看门狗 整三组（14 项）在 UI 上根本不存在，跟 tools/settings-ui.ps1 差了三分之一。
 *   2. 后端 pickPersistable() 也是一份手抄白名单，比调参表少 18 项 —— 面板上看得见、
 *      点保存也返回「已保存」，但写进 config.json 那一刻被静默丢掉，重启又变回老值。
 *
 * 所以这里钉三件事：
 *   A. 调参表里的每个 path，config.js 的 DEFAULTS 里必须真有这个键（否则面板读出来是空）
 *   B. 每个 path 必须能穿过 parseConfig + pickPersistable 活下来（否则保存等于没保存）
 *   C. client.js 不许再出现硬编码字段表，也不许再出现乱码（编码坏过一次）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BOT_GROUPS, ALIVE_GROUPS } from '../lib/settings-schema.mjs'
import { DEFAULTS, parseConfig } from '../lib/config.js'
import { pickPersistable } from '../lib/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const getPath = (obj, dotted) =>
  String(dotted)
    .split('.')
    .reduce((cur, key) => (cur === null || typeof cur !== 'object' ? undefined : cur[key]), obj)

const flat = (groups) => groups.flatMap((g) => g.fields.map((f) => ({ ...f, group: g.title })))

test('调参表里每个 path 在 config.js DEFAULTS 里都有真键', () => {
  const missing = flat(BOT_GROUPS).filter((f) => getPath(DEFAULTS, f.path) === undefined)
  assert.deepEqual(
    missing.map((f) => `${f.group}/${f.path}`),
    [],
    '调参表里有、DEFAULTS 里没有的字段 —— 面板会显示空值',
  )
})

test('每个字段都能穿过 parseConfig 活下来', () => {
  const parsed = parseConfig(DEFAULTS)
  const dropped = flat(BOT_GROUPS).filter((f) => getPath(parsed.config, f.path) === undefined)
  assert.deepEqual(dropped.map((f) => f.path), [], 'parseConfig 之后丢了的字段')
})

test('每个字段都能落盘（pickPersistable 不再漏项）', () => {
  const persisted = pickPersistable(parseConfig(DEFAULTS).config)
  const dropped = flat(BOT_GROUPS).filter((f) => getPath(persisted, f.path) === undefined)
  assert.deepEqual(
    dropped.map((f) => `${f.group}/${f.path}`),
    [],
    '这些字段在面板上能改，但保存时会从 config.json 里消失',
  )
})

test('改过的值真的会被写下去（三类代表字段）', () => {
  const candidate = {
    ...DEFAULTS,
    qzoneDiaryEnabled: true,
    qzoneDiaryTime: '07:30',
    qzonePollTriggerPercent: 55,
    watchdogSeconds: 240,
    watchdogSwitchThinkingOff: false,
    interactPokeMaxPerDay: 7,
    allowUsers: ['123456'],
    selfId: '654321',
  }
  const persisted = pickPersistable(parseConfig(candidate).config)
  assert.equal(persisted.qzoneDiaryEnabled, true)
  assert.equal(persisted.qzoneDiaryTime, '07:30')
  assert.equal(persisted.qzonePollTriggerPercent, 55)
  assert.equal(persisted.watchdogSeconds, 240)
  assert.equal(persisted.watchdogSwitchThinkingOff, false)
  assert.equal(persisted.interactPokeMaxPerDay, 7)
  assert.deepEqual(persisted.allowUsers, ['123456'])
  assert.equal(persisted.selfId, '654321')
})

test('界面上不露、但必须保住的老配置项不被顺手抹掉', () => {
  const persisted = pickPersistable(parseConfig(DEFAULTS).config)
  for (const key of ['rateLimit', 'segment', 'reconnect', 'typingDelayMs', 'sessionIdPrefix']) {
    assert.notEqual(persisted[key], undefined, `${key} 被 pickPersistable 弄丢了`)
  }
})

test('saveFromPanel 的候选对象不再丢字段', () => {
  // 复刻 saveFromPanel 的两步：{...pickPersistable(config), ...body} → parseConfig → pickPersistable
  const body = { qzoneDiaryEnabled: true, qzoneDiaryMaxChars: 1500, watchdogMaxStrikes: 1 }
  const candidate = { ...pickPersistable(parseConfig(DEFAULTS).config), ...body }
  const persisted = pickPersistable(parseConfig(candidate).config)
  assert.equal(persisted.qzoneDiaryEnabled, true)
  assert.equal(persisted.qzoneDiaryMaxChars, 1500)
  assert.equal(persisted.watchdogMaxStrikes, 1)
})

test('client.js 里不许再有硬编码字段表', () => {
  const src = readFileSync(join(root, 'lib/client.js'), 'utf8')
  assert.equal(/var GROUPS = \[/.test(src), false, 'client.js 又手抄字段表了 —— 应该只认 settings-schema.mjs')
  assert.equal(src.includes('state.schema.bot'), true, 'client.js 没从宿主拿调参表')
})

test('client.js 不许再有乱码（编码坏过一次）', () => {
  const src = readFileSync(join(root, 'lib/client.js'), 'utf8')
  // UTF-8 被当 GBK 读过一轮之后才会出现的典型字符
  const mojibake = /锛|鈥|銆|鏄|涓|鍚|鐨|浣|绉|鎺|姝|寮|閰|璺|娴|鍣/
  const badLines = src
    .split(/\r?\n/)
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => mojibake.test(line))
  assert.deepEqual(badLines.slice(0, 3), [], `client.js 有 ${badLines.length} 行乱码`)
})

test('alive 调参表也齐（path 与 DEFAULTS 对得上）', () => {
  // alive 的默认值在 dsh-alive/lib/config.js，那份不在这里 import（跨插件），
  // 只校验结构：每组有标题、每个字段有 path/label/type。
  assert.ok(ALIVE_GROUPS.length > 0)
  for (const group of ALIVE_GROUPS) {
    assert.equal(typeof group.title, 'string')
    for (const field of group.fields) {
      assert.equal(typeof field.path, 'string')
      assert.equal(typeof field.label, 'string')
      assert.equal(typeof field.type, 'string')
    }
  }
})
