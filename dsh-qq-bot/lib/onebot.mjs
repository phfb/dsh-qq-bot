/**
 * OneBot v11 WebSocket 客户端（SnowLuma 的 wsServers）。
 *
 * 只用 Node 内置的全局 WebSocket（Node 22+ / Electron 宿主都有），
 * 不依赖 ws 包 —— profile 的 node_modules 里没有它。
 *
 * 职责：
 *   1. 连上去、断了自动重连（指数退避）
 *   2. 把收到的普通事件交给 onEvent 回调
 *   3. 提供 call(action, params) 发请求并按 echo 等回执
 */

/** 一条连接的连接状态。 */
export const STATE = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  OPEN: 'open',
  CLOSING: 'closing',
  CLOSED: 'closed',
})

/**
 * @typedef {object} OneBotOptions
 * @property {string} url            完整 URL（已含 access_token query）
 * @property {(event: any) => void} onEvent        普通事件回调
 * @property {(state: string, detail?: any) => void} [onState] 状态变化回调
 * @property {(message: string) => void} [onLog]   日志回调
 * @property {number} [baseReconnectMs]
 * @property {number} [maxReconnectMs]
 * @property {number} [callTimeoutMs]
 */

export class OneBotClient {
  /** @param {OneBotOptions} opts */
  constructor(opts) {
    this.url = opts.url
    this.onEvent = opts.onEvent
    this.onState = opts.onState ?? (() => {})
    this.onLog = opts.onLog ?? (() => {})
    this.baseReconnectMs = opts.baseReconnectMs ?? 3000
    this.maxReconnectMs = opts.maxReconnectMs ?? 30_000
    this.callTimeoutMs = opts.callTimeoutMs ?? 15_000

    /** @type {WebSocket | null} */
    this.ws = null
    this.state = STATE.IDLE
    /** @type {Map<string, {resolve:(v:any)=>void, reject:(e:any)=>void, timer:any}>} */
    this.pending = new Map()
    this.echoSeq = 0
    this.attempt = 0
    this.stopped = false
    /** @type {any} */
    this.reconnectTimer = null
    /** 最近一次收到事件的时间，给健康检查用。 */
    this.lastEventAt = 0
  }

  /** 设置状态并发通知。 */
  #setState(state, detail) {
    if (this.state === state) return
    this.state = state
    try {
      this.onState(state, detail)
    } catch {
      // 回调里抛错不能影响连接
    }
  }

  /** 建连。已经连上或已停止时是空操作。 */
  connect() {
    if (this.stopped) return
    if (this.state === STATE.CONNECTING || this.state === STATE.OPEN) return

    const WSImpl = globalThis.WebSocket
    if (typeof WSImpl !== 'function') {
      this.onLog('宿主没有全局 WebSocket（需要 Node >= 22），插件无法工作')
      this.#setState(STATE.CLOSED, { fatal: true })
      return
    }

    this.#setState(STATE.CONNECTING)
    let ws
    try {
      ws = new WSImpl(this.url)
    } catch (err) {
      this.onLog(`WebSocket 构造失败：${err instanceof Error ? err.message : String(err)}`)
      this.#scheduleReconnect()
      return
    }
    this.ws = ws

    ws.addEventListener('open', () => {
      this.attempt = 0
      this.#setState(STATE.OPEN)
      this.onLog('已连上 OneBot WebSocket')
    })

    ws.addEventListener('message', (ev) => {
      this.#handleFrame(ev?.data)
    })

    ws.addEventListener('error', (ev) => {
      // 浏览器的 error 事件几乎不带信息，别指望它
      this.onLog(`WebSocket 错误：${ev?.message ?? '(无详情)'}`)
    })

    ws.addEventListener('close', (ev) => {
      this.ws = null
      this.#rejectAllPending(`连接关闭 code=${ev?.code ?? '?'}`)
      this.#setState(STATE.CLOSED, { code: ev?.code })
      if (!this.stopped) this.#scheduleReconnect()
    })
  }

  /** 处理一帧。事件 → onEvent，回执 → resolve 对应的 promise。 */
  #handleFrame(raw) {
    if (typeof raw !== 'string') {
      // Node 的 WebSocket 在二进制帧下给 ArrayBuffer；OneBot 只用文本帧
      try {
        raw = Buffer.from(raw).toString('utf8')
      } catch {
        return
      }
    }
    let frame
    try {
      frame = JSON.parse(raw)
    } catch {
      this.onLog('收到非 JSON 帧，已忽略')
      return
    }
    if (frame === null || typeof frame !== 'object') return

    // 回执：带 echo 且 echo 是我们发出去的
    if (typeof frame.echo === 'string' && this.pending.has(frame.echo)) {
      const slot = this.pending.get(frame.echo)
      this.pending.delete(frame.echo)
      clearTimeout(slot.timer)
      if (frame.status === 'failed' || (typeof frame.retcode === 'number' && frame.retcode !== 0)) {
        slot.reject(new Error(`OneBot 返回失败：retcode=${frame.retcode} ${frame.wording ?? frame.message ?? ''}`))
      } else {
        slot.resolve(frame.data ?? {})
      }
      return
    }

    // 普通事件
    if (typeof frame.post_type === 'string') {
      this.lastEventAt = Date.now()
      try {
        this.onEvent(frame)
      } catch (err) {
        this.onLog(`事件处理抛错：${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }

    // 其它（心跳包等）忽略
  }

  /**
   * 发一个 action 并等回执。
   * @param {string} action
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  call(action, params = {}) {
    return new Promise((resolve, reject) => {
      const ws = this.ws
      if (ws === null || this.state !== STATE.OPEN) {
        reject(new Error(`连接未就绪（state=${this.state}）`))
        return
      }
      const echo = `qqbot-${Date.now()}-${++this.echoSeq}`
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`action ${action} 超时 ${this.callTimeoutMs}ms`))
      }, this.callTimeoutMs)
      this.pending.set(echo, { resolve, reject, timer })
      try {
        ws.send(JSON.stringify({ action, params, echo }))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(echo)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** 发一条私聊文本。 */
  async sendPrivateMsg(userId, text) {
    return this.call('send_private_msg', {
      user_id: Number(userId),
      message: [{ type: 'text', data: { text } }],
    })
  }

  /** 取登录信息（健康检查用）。 */
  async getLoginInfo() {
    return this.call('get_login_info', {})
  }

  /** 拒掉所有等待中的请求。 */
  #rejectAllPending(reason) {
    for (const [echo, slot] of this.pending) {
      clearTimeout(slot.timer)
      slot.reject(new Error(reason))
      this.pending.delete(echo)
    }
  }

  /** 排一次重连。 */
  #scheduleReconnect() {
    if (this.stopped) return
    if (this.reconnectTimer !== null) return
    const delay = Math.min(this.baseReconnectMs * Math.pow(2, Math.min(this.attempt, 5)), this.maxReconnectMs)
    this.attempt += 1
    this.onLog(`${delay}ms 后重连（第 ${this.attempt} 次）`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  /** 主动断开，不再重连。 */
  close() {
    this.stopped = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.#rejectAllPending('客户端已关闭')
    const ws = this.ws
    this.ws = null
    if (ws !== null) {
      this.#setState(STATE.CLOSING)
      try {
        ws.close(1000, 'plugin shutdown')
      } catch {
        // 已经关了
      }
    }
    this.#setState(STATE.CLOSED, { by: 'client' })
  }

  /** 当前是否连上。 */
  get isOpen() {
    return this.state === STATE.OPEN && this.ws !== null
  }
}
