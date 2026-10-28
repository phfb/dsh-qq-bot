/**
 * 编码守卫：lib/ 与 tools/ 下任何文件都不许出现「UTF-8 被当 GBK 读过一轮」留下的乱码。
 *
 * 为什么值得单独一条测试：2026-10-28 lib/client.js 整份坏过一次 —— 某个工具按 GBK
 * 解码后原样写回，69 行中文变成「姝ｅ湪璇诲彇」这种。文件照样能跑、原来的测试照样全绿，
 * 只有人打开 DSH 面板才看得出顶部横幅和按钮全是乱码。这类事故只能扫字节。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')

/** UTF-8 → GBK → UTF-8 之后才会出现的典型字；加上两个替换字符。 */
const MOJIBAKE = /[\uFFFD锟]|锛|鈥|銆|鏄|涓|鍚|鐨|浣|绉|鎺|姝|寮|閰|璺|娴|鍣|缁|璇|鍦|鏂|鏃|鏈|瀹|鎵|鐩|褰|杩|妫|瑕|鏋|鍙|閭|杈|瀛|瑁|姘|鎬|浠|濂|鍜|鍐|閿|纭|璁/

const EXT = /\.(mjs|js|cjs|json|md|yml|ps1|cmd|vbs)$/

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (EXT.test(e.name)) out.push(p)
  }
  return out
}

test('lib/ 与 tools/ 下没有 GBK 乱码', () => {
  const dirs = ['lib', 'tools', 'test']
    .map((d) => path.join(root, d))
    .filter((d) => fs.existsSync(d))
  const bad = []
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      // 这两条测试自己写了乱码字面量（一条扫、一条断言），跳过
      if (file.endsWith('encoding.test.cjs') || file.endsWith('settings-panel.test.mjs')) continue
      const text = fs.readFileSync(file, 'utf8')
      text.split(/\r?\n/).forEach((line, i) => {
        if (MOJIBAKE.test(line)) bad.push(`${path.relative(root, file)}:${i + 1}  ${line.trim().slice(0, 60)}`)
      })
    }
  }
  assert.deepEqual(bad.slice(0, 8), [], `发现 ${bad.length} 行乱码（UTF-8 被当 GBK 读过一轮）`)
})

test('lib/ 下的文件没有 NUL 字节（被别的编码写过的痕迹）', () => {
  const bad = []
  for (const file of walk(path.join(root, 'lib'))) {
    if (fs.readFileSync(file).includes(0)) bad.push(path.relative(root, file))
  }
  assert.deepEqual(bad, [])
})
