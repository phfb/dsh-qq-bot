/**
 * 把图片写进 DSH 的原生附件库，换成 user message 里的 image block。
 *
 * 为什么走这条路（2026-10-25 晚上改）：
 *   之前是「存本地 → 在文本里给路径 → 让模型自己 read_image」。
 *   能看，但要多一次工具调用，而且模型有机会偷懒不看。
 *   原生 attachment 是直接塞进 content 数组的，模型**不用调工具就看得见图**。
 *
 * 存储是纯内容寻址，没有索引文件（实地数过 545 个对象，目录里只有 objects/ 和 tmp/）：
 *   <DSH_HOME>/attachments/v1/objects/<sha256 前两位>/<完整 sha256>
 * 所以「写一个文件」就等于「创建了一个附件」。
 *
 * 这条路依赖 DSH 的内部格式，属于跨版本会坏的东西 —— 所以调用方必须容错：
 * 写不进去就退回「给路径 + read_image」，不能因为 DSH 换了个实现就整条链路停摆。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 找 DSH 的数据根目录。插件跑在宿主进程里，直接继承它的环境变量。 */
export function resolveDshHome(env = process.env) {
  const fromEnv = String(env?.DSH_HOME ?? '').trim()
  if (fromEnv !== '') return fromEnv
  return ''
}

/** 附件库根目录；DSH_HOME 拿不到就返回空串（调用方据此关掉原生模式）。 */
export function attachmentsRoot(dshHome) {
  if (!dshHome) return ''
  return join(dshHome, 'attachments', 'v1', 'objects')
}

/**
 * 把一份图片字节写成 DSH 附件，返回可以塞进 content 数组的 image block。
 *
 * @param {Buffer} buf
 * @param {{mediaType?:string, width?:number, height?:number, name?:string}} meta
 * @param {string} dshHome
 * @returns {{block:object|null, attachmentId:string, path:string, error:string}}
 */
export function writeDshAttachment(buf, meta = {}, dshHome = '') {
  const empty = { block: null, attachmentId: '', path: '', error: '' }
  if (!Buffer.isBuffer(buf) || buf.length === 0) return { ...empty, error: '空字节' }

  const root = attachmentsRoot(dshHome)
  if (root === '') return { ...empty, error: '拿不到 DSH_HOME' }

  const hash = createHash('sha256').update(buf).digest('hex')
  const dir = join(root, hash.slice(0, 2))
  const file = join(dir, hash)

  try {
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, buf)
    }
  } catch (err) {
    return { ...empty, error: `写附件失败：${err instanceof Error ? err.message : String(err)}` }
  }

  const mediaType = String(meta.mediaType ?? '').trim() || guessMimeFromBytes(buf)
  const block = {
    type: 'image',
    attachment: {
      attachmentId: `sha256:${hash}`,
      mediaType,
      width: Math.max(0, Math.floor(Number(meta.width) || 0)),
      height: Math.max(0, Math.floor(Number(meta.height) || 0)),
      bytes: buf.length,
      name: String(meta.name ?? '').trim() || `${hash.slice(0, 8)}.${extFromMime(mediaType)}`,
    },
  }
  return { block, attachmentId: `sha256:${hash}`, path: file, error: '' }
}

/** 从字节头猜 MIME（附件 block 里 mediaType 必须像样，不然宿主可能拒收）。 */
export function guessMimeFromBytes(buf) {
  if (buf.length >= 4) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'image/webp'
    if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
  }
  return 'image/png'
}

function extFromMime(mediaType) {
  const mt = String(mediaType ?? '').toLowerCase()
  if (mt.includes('jpeg') || mt.includes('jpg')) return 'jpg'
  if (mt.includes('gif')) return 'gif'
  if (mt.includes('webp')) return 'webp'
  if (mt.includes('bmp')) return 'bmp'
  return 'png'
}
