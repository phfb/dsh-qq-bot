/**
 * 派活来源 kind 的回归测试。
 *
 * 为什么专门开一个文件盯这个：2026-10-27 那晚 source.kind 写成 `'plugin'`，
 * DSH v4 会话格式直接拒绝（dsh-session-format-v3-to-v4/lib/index.js:126），
 * 消息进队列 → 整个会话写盘抛 SessionFormatError → 她一条都不回，
 * 而错误全在 flush 里，日志只有一行 agent.failed，排查了一整晚。
 *
 * 所以这里守两件事：
 *   1. 配置层挡得住坏值（'plugin' / 'qq' / 'user' / 空串 / 非字符串）
 *   2. 代码里不会再冒出写死 `kind: 'plugin'` 的投递
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { DEFAULTS, parseConfig } from '../lib/config.js'

const here = dirname(fileURLToPath(import.meta.url))
const indexSource = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')

test('默认派活 kind 不是 plugin，也不是 qq', () => {
  assert.equal(DEFAULTS.taskSourceKind, 'dsh-qq-bot')
  assert.notEqual(DEFAULTS.taskSourceKind, 'plugin')
  assert.notEqual(DEFAULTS.taskSourceKind, 'qq')
})

test("taskSourceKind: 'plugin' 会被挡回默认值（v4 会拒绝它）", () => {
  const { config, problems } = parseConfig({ taskSourceKind: 'plugin' })
  assert.equal(config.taskSourceKind, DEFAULTS.taskSourceKind)
  assert.ok(problems.some((p) => p.includes('taskSourceKind')), '应该记一条 problem')
})

test("taskSourceKind: 'qq' / 'user' 会被挡回默认值（会被记忆插件当成他说的话）", () => {
  for (const bad of ['qq', 'user']) {
    const { config, problems } = parseConfig({ taskSourceKind: bad })
    assert.equal(config.taskSourceKind, DEFAULTS.taskSourceKind)
    assert.ok(problems.some((p) => p.includes('taskSourceKind')))
  }
})

test('taskSourceKind: 空串 / 非字符串退回默认值', () => {
  assert.equal(parseConfig({ taskSourceKind: '   ' }).config.taskSourceKind, DEFAULTS.taskSourceKind)
  const notString = parseConfig({ taskSourceKind: 123 })
  assert.equal(notString.config.taskSourceKind, DEFAULTS.taskSourceKind)
  assert.ok(notString.problems.some((p) => p.includes('taskSourceKind')))
})

test('taskSourceKind: 别人自己的 DSH 版本换了规则，改配置就能换 kind', () => {
  const { config, problems } = parseConfig({ taskSourceKind: 'my-bridge-task' })
  assert.equal(config.taskSourceKind, 'my-bridge-task')
  assert.equal(problems.filter((p) => p.includes('taskSourceKind')).length, 0)
})

test('源码里不许再出现写死的 kind: plugin（那是把会话写死的写法）', () => {
  // 只看真正的代码行 —— 注释里要能写「当年写错的就是 kind: 'plugin'」这种话
  const codeOnly = indexSource
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return t !== '' && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
    })
    .join('\n')
  assert.equal(/kind:\s*'plugin'/.test(codeOnly), false)
})

test('跟不上的会话由「盯动静」兜底：观察时长可配，0 = 关', () => {
  assert.equal(typeof DEFAULTS.taskDeliveryWatchSeconds, 'number')
  assert.equal(parseConfig({ taskDeliveryWatchSeconds: 0 }).config.taskDeliveryWatchSeconds, 0)
  assert.equal(parseConfig({ taskDeliveryWatchSeconds: 9999 }).config.taskDeliveryWatchSeconds, 3600)
})
