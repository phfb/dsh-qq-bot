/**
 * 「SnowLuma 随宿主启停」这个开关的单测（2026-10-30）。
 *
 * 起因：他要求「把 snowluma 随宿主启停关掉」，一查才发现这个开关是死的 ——
 * `startSnowLuma()` 里明明写着 `config.snowLumaAutoStart === false` 就返回，
 * 可 `config.js` 的 parseConfig 是照已知字段重建对象的，**从没解析过这个键**，
 * 写进 config.json 也被丢掉，`=== false` 永远不成立。
 * `snowLumaDir` 同理（`snowLumaDir()` 一直在读一个不存在的键）。
 *
 * 这个文件把「它现在是真的」钉住：默认值、解析、面板表、落盘四处都得对得上。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS, parseConfig } from '../lib/config.js'
import { BOT_GROUPS } from '../lib/settings-schema.mjs'
import { pickPersistable } from '../lib/index.js'

const schemaFields = () => BOT_GROUPS.flatMap((g) => g.fields)

test('DEFAULTS：两个键都必须在（否则界面上改不动）', () => {
  assert.equal(DEFAULTS.snowLumaAutoStart, true)
  assert.equal(DEFAULTS.snowLumaDir, '')
})

test('parseConfig：snowLumaAutoStart=false 要真的变成 false', () => {
  assert.equal(parseConfig({ snowLumaAutoStart: false }).config.snowLumaAutoStart, false)
})

test('parseConfig：不写、写坏、写 true 都当开着（默认行为不变）', () => {
  assert.equal(parseConfig({}).config.snowLumaAutoStart, true)
  assert.equal(parseConfig({ snowLumaAutoStart: true }).config.snowLumaAutoStart, true)
  assert.equal(parseConfig({ snowLumaAutoStart: 'false' }).config.snowLumaAutoStart, true, '字符串 false 不算关，避免手改 json 时写成字符串反而悄悄关掉')
  assert.equal(parseConfig(null).config.snowLumaAutoStart, true)
})

test('parseConfig：snowLumaDir 会被 trim，非字符串退回空串', () => {
  assert.equal(parseConfig({ snowLumaDir: '  D:\\DSHBot\\SnowLuma  ' }).config.snowLumaDir, 'D:\\DSHBot\\SnowLuma')
  assert.equal(parseConfig({ snowLumaDir: 123 }).config.snowLumaDir, '')
  assert.equal(parseConfig({}).config.snowLumaDir, '')
})

test('面板表里有这两个字段 —— 否则界面上看不见、也就改不了', () => {
  const paths = schemaFields().map((f) => f.path)
  assert.ok(paths.includes('snowLumaAutoStart'), '调参表里没有 snowLumaAutoStart')
  assert.ok(paths.includes('snowLumaDir'), '调参表里没有 snowLumaDir')
  const onOff = schemaFields().find((f) => f.path === 'snowLumaAutoStart')
  assert.equal(onOff.type, 'bool')
})

test('pickPersistable：关掉之后点保存，这个 false 不能被顺手抹掉', () => {
  const config = { ...DEFAULTS, snowLumaAutoStart: false, snowLumaDir: 'D:\\x\\SnowLuma' }
  const saved = pickPersistable(config)
  assert.equal(saved.snowLumaAutoStart, false, '落盘时被丢掉了，等于改了没用')
  assert.equal(saved.snowLumaDir, 'D:\\x\\SnowLuma')
})

test('端到端：json → parseConfig → pickPersistable 一轮下来还是关着', () => {
  const raw = JSON.parse(JSON.stringify({ ...DEFAULTS, snowLumaAutoStart: false }))
  const cfg = parseConfig(raw).config
  assert.equal(cfg.snowLumaAutoStart, false)
  assert.equal(pickPersistable(cfg).snowLumaAutoStart, false)
})
