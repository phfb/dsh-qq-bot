/**
 * 自更新「校验」这一层的回归测试（2026-10-30）。
 *
 * 事故：`stage()` 里用 `spawnSync(..., { encoding: 'utf8' })` 做 `node --check`。
 * `encoding` 会要求 stdout/stderr 两条管道，而插件跑在 Electron 宿主进程里
 * （ELECTRON_RUN_AS_NODE=1 的 Node），那个环境建管道直接失败：
 *
 *   status: null
 *   error.message: "PostQueuedCompletionStatus: (6) 句柄无效。"
 *
 * 老判断只写 `r.status !== 0`，`null !== 0` 成立 —— 于是**每个新版本**都被判
 * 「语法检查没过」整包丢弃，自更新 100% 失效，而日志里那句错误跟语法毫无关系。
 *
 * 这里钉住三件事：
 *   1. 子进程起不来 ≠ 语法错（三态：true / false / null）
 *   2. 真要报错时，报错行取的是 `SyntaxError: ...`，不是尾巴上的 `Node.js v24.x`
 *   3. 空文件 / U+FFFD 乱码必须被编码守卫拦下
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  checkSyntaxViaNode,
  checkTextGuard,
  classifyStagedFile,
  pickSyntaxErrorLine,
} from '../lib/self-update.mjs'

/** 造一个临时目录，测完删掉。 */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'eb-selfupdate-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const GOOD = 'export const a = 1\n'
const BROKEN = 'export const a = {\n' // 少一个右括号 → SyntaxError

/* ── 语法校验：真文件 ───────────────────────────────────────────────── */

test('checkSyntaxViaNode：好文件 ok:true', (t) => {
  const dir = tempDir(t)
  const f = join(dir, 'good.mjs')
  writeFileSync(f, GOOD)
  const r = checkSyntaxViaNode(f)
  assert.equal(r.ok, true)
  assert.equal(r.detail, '')
})

test('checkSyntaxViaNode：坏文件 ok:false，且 detail 里有 SyntaxError', (t) => {
  const dir = tempDir(t)
  const f = join(dir, 'broken.mjs')
  writeFileSync(f, BROKEN)
  const r = checkSyntaxViaNode(f)
  assert.equal(r.ok, false)
  assert.match(r.detail, /SyntaxError/)
  // 尾巴上的版本号不该是唯一线索（老代码就是只捞到它）
  assert.doesNotMatch(r.detail, /^Node\.js v/)
})

/* ── 语法校验：宿主环境起不来子进程（这次事故的现场）───────────────── */

test('checkSyntaxViaNode：子进程起不来 → ok:null（不是 ok:false！）', () => {
  const hostError = new Error('PostQueuedCompletionStatus: (6) 句柄无效。')
  let calls = 0
  const r = checkSyntaxViaNode('whatever.mjs', {
    run: () => {
      calls += 1
      // 宿主里两种姿势都起不来：spawnSync 直接以 error 返回，status 是 null
      return { status: null, error: hostError, stderr: '', stdout: '' }
    },
  })
  assert.equal(calls, 2, '两种姿势都该试过')
  assert.equal(r.ok, null, '起不来子进程不能被当成语法错，否则自更新永远装不上')
  assert.match(r.detail, /PostQueuedCompletionStatus/)
})

test('checkSyntaxViaNode：第一次就成功（stdio:ignore 不建管道）', () => {
  let calls = 0
  const r = checkSyntaxViaNode('x.mjs', {
    run: () => {
      calls += 1
      return { status: 0, stdout: '', stderr: '' }
    },
  })
  assert.equal(calls, 1, '第一条路能过就别再开管道')
  assert.equal(r.ok, true)
})

test('checkSyntaxViaNode：第一次起不来、第二次拿到真报错 → ok:false 且带 SyntaxError', () => {
  let calls = 0
  const r = checkSyntaxViaNode('x.mjs', {
    run: () => {
      calls += 1
      if (calls === 1) return { status: null, error: new Error('spawn 失败'), stderr: '' }
      return { status: 1, stderr: 'file.mjs:3\n}\n^\n\nSyntaxError: Unexpected end of input\n\nNode.js v24.22.1\n' }
    },
  })
  assert.equal(calls, 2)
  assert.equal(r.ok, false)
  assert.match(r.detail, /SyntaxError: Unexpected end of input/)
})

test('checkSyntaxViaNode：run 直接抛异常也只算「起不来」', () => {
  const r = checkSyntaxViaNode('x.mjs', {
    run: () => {
      throw new Error('EPIPE')
    },
  })
  assert.equal(r.ok, null)
  assert.match(r.detail, /EPIPE/)
})

/* ── 报错行挑选 ─────────────────────────────────────────────────────── */

test('pickSyntaxErrorLine：优先 SyntaxError，不要 Node.js 版本尾巴', () => {
  const stderr = 'file.mjs:3\n}\n^\n\nSyntaxError: Unexpected end of input\n    at x\n\nNode.js v24.22.1\n'
  assert.match(pickSyntaxErrorLine(stderr, 1), /^SyntaxError: Unexpected end of input$/)
})

test('pickSyntaxErrorLine：没有关键字时退回第一条非噪音行', () => {
  const stderr = '\n\nsomething odd happened\n\nNode.js v24.22.1\n'
  assert.equal(pickSyntaxErrorLine(stderr, 1), 'something odd happened')
})

test('pickSyntaxErrorLine：什么都没有时给退出码', () => {
  assert.equal(pickSyntaxErrorLine('', 3), '退出码 3')
  assert.equal(pickSyntaxErrorLine('Node.js v24.22.1\n', 3), '退出码 3')
})

/* ── 编码守卫 ───────────────────────────────────────────────────────── */

test('checkTextGuard：好文件返回空串', (t) => {
  const dir = tempDir(t)
  const f = join(dir, 'ok.mjs')
  writeFileSync(f, GOOD)
  assert.equal(checkTextGuard(f), '')
})

test('checkTextGuard：空文件 / 只有空白 / U+FFFD 都要拦', (t) => {
  const dir = tempDir(t)
  const empty = join(dir, 'empty.mjs')
  const blank = join(dir, 'blank.mjs')
  const bad = join(dir, 'bad.mjs')
  writeFileSync(empty, '')
  writeFileSync(blank, '  \n\t\n')
  writeFileSync(bad, Buffer.from('export const a = "\uFFFD"\n', 'utf8'))
  assert.match(checkTextGuard(empty), /空的/)
  assert.match(checkTextGuard(blank), /空白/)
  assert.match(checkTextGuard(bad), /U\+FFFD/)
})

test('checkTextGuard：读不了也要说清楚，不能抛', () => {
  const r = checkTextGuard('不存在的文件.mjs', {
    read: () => {
      throw new Error('ENOENT')
    },
  })
  assert.match(r, /读不了/)
})

/* ── 三态归类（stage 里真正用的判断）──────────────────────────────── */

test('classifyStagedFile：编码坏了 → ok:false', () => {
  const r = classifyStagedFile('x.mjs', { guard: () => '文件是空的', syntax: () => ({ ok: true, detail: '' }) })
  assert.equal(r.ok, false)
  assert.equal(r.detail, '文件是空的')
})

test('classifyStagedFile：语法坏 → ok:false，detail 带前缀', () => {
  const r = classifyStagedFile('x.mjs', {
    guard: () => '',
    syntax: () => ({ ok: false, detail: 'SyntaxError: x' }),
  })
  assert.equal(r.ok, false)
  assert.match(r.detail, /语法检查没过（SyntaxError: x）/)
})

test('classifyStagedFile：环境起不了子进程 → ok:null，绝不能被当成失败', () => {
  const r = classifyStagedFile('x.mjs', {
    guard: () => '',
    syntax: () => ({ ok: null, detail: 'PostQueuedCompletionStatus: (6) 句柄无效。' }),
  })
  assert.equal(r.ok, null)
  assert.notEqual(r.ok, false, '就是这一句判断写错，才让自更新 100% 失效')
  assert.match(r.detail, /PostQueuedCompletionStatus/)
})

test('classifyStagedFile：都过了 → ok:true', () => {
  const r = classifyStagedFile('x.mjs', { guard: () => '', syntax: () => ({ ok: true, detail: '' }) })
  assert.equal(r.ok, true)
  assert.equal(r.detail, '')
})

/* ── 真文件端到端：好文件走完整条链 ─────────────────────────────────── */

test('classifyStagedFile：真文件（好 / 坏 / 空）三条路都对', (t) => {
  const dir = tempDir(t)
  const good = join(dir, 'good.mjs')
  const broken = join(dir, 'broken.mjs')
  const empty = join(dir, 'empty.mjs')
  writeFileSync(good, GOOD)
  writeFileSync(broken, BROKEN)
  writeFileSync(empty, '')

  assert.equal(classifyStagedFile(good).ok, true)

  const b = classifyStagedFile(broken)
  assert.equal(b.ok, false)
  assert.match(b.detail, /SyntaxError/)

  const e = classifyStagedFile(empty)
  assert.equal(e.ok, false)
  assert.match(e.detail, /空的/)
})
