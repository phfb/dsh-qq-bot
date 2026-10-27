/**
 * dsh-model-override —— 真正能改「全局模型」的插件。
 *
 * ## 它解决的是什么问题
 *
 * DSH 官方那个模型选择框是**按会话**的：你在 A 会话里换成第三方 API，
 * B 会话（比如 QQ bot 建的那一局）还挂在原来的 provider 上，怎么点都动不了它。
 *
 * 更具体一点，`dsh-qq-bot` 建会话时是这么拿模型的：
 *
 *     const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
 *     agents.create({ sessionId, agentOptions: { provider, model } })
 *
 * **只在创建那一刻读一次**。所以 bot 那局的模型从它被建出来那天就定死了。
 *
 * ## 它是怎么改的
 *
 * DSH 内部其实留了运行时改的口子 —— `sessionController.selectForNextRequest()`：
 *
 *     agent.session.append('model/selection', selection)
 *     this.selectionFor(agent).current = selection
 *
 * 也就是说：改完之后下一轮请求立刻用新模型，而且会往会话里写一条
 * `model/selection` 事件，**重启也记得**。
 *
 * 所以这个插件做三件事：
 *   1. `agentDefaultModel.saveSelection()` —— 写进 profile 配置，以后**新建的会话**默认就用它
 *   2. 遍历所有活着的 agent，`selectForNextRequest()` —— **已经开着的会话立刻切换**，bot 那局也算
 *   3. 把「谁切了、谁没切」写进快照，设置窗口能看见
 *
 * ## 和设置窗口怎么说话
 *
 * 跟 dsh-alive 一个模式：宿主里没有 webServer（独立进程拿不到 HTTP 口），
 * 所以走**文件信箱**：
 *
 *     窗口写 control.json  { cmd:'apply', id:<guid>, payload:{provider,model,reasoningEffort} }
 *     插件扫到没见过的 id → 执行 → 把 cmd 清空、写 doneAt 回执
 *     窗口轮询到 cmd 空了 = 办完了
 *
 * 反向是 snapshot.json：插件把 provider 目录、当前选择、每个会话的模型写进去，窗口读它显示。
 *
 * @module dsh-model-override
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import z from '@deepseek-ai/schemastery'

export const name = 'dsh-model-override'

/**
 * 设置页里那张表。
 *
 * 声明 `Config` 之后，DSH 的「设置 → 插件 → dsh-model-override」会自动生成表单 ——
 * 填完保存，插件重载时 apply() 会拿新值应用一次，等于热应用。
 *
 * 字段说明写得具体一点，因为表单里只有这一行提示：
 * 「unlimit」这种 id 光看名字猜不出来，得告诉用户去哪抄。
 */
export const Config = z.object({
  provider: z
    .string()
    .default('')
    .description('服务商 id。在「设置 → 模型」里看到的组名就是它，比如 unlimit、deepseek-account。'),
  model: z
    .string()
    .default('')
    .description('模型 id。填 provider 下那个模型的 id，比如 deepseek-v4.1-flash、deepseek-flash。'),
  reasoningEffort: z
    .string()
    .default('')
    .description('推理等级：留空 = 用模型默认。常见值 off / low / high / max，具体看 provider 支持哪些。'),
  dataDir: z
    .string()
    .default('')
    .description('数据目录（快照、日志、目标文件放这儿）。留空 = 跟 dsh-qq-bot / dsh-alive 同一个目录。'),
})

/** 上次处理过的命令 id —— 同一个 id 不重复执行（watchFile 会重复触发）。 */
let lastControlId = null

/**
 * @param {any} ctx
 * @param {{dataDir?: string}} [config]
 */
export function apply(ctx, config) {
  const dataDir = typeof config?.dataDir === 'string' && config.dataDir.trim() !== ''
    ? config.dataDir.trim()
    : join(homedir(), '.dsh-model-override')

  const snapshotPath = join(dataDir, 'snapshot.json')
  const controlPath = join(dataDir, 'control.json')

  function log(message) {
    try {
      const line = `${new Date().toISOString()} [model-override] ${message}\n`
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(join(dataDir, 'model-override.log'), line, { flag: 'a', encoding: 'utf8' })
    } catch {
      // 日志写不进去不影响主流程
    }
  }

  /* ────────────────────────── 读目录 ────────────────────────── */

  /**
   * 把 llm 服务里的 provider / model 目录整理成窗口能直接用的形状。
   *
   * `listProviders()` 是同步的、返回 adapter 里注册的元数据；
   * `listModels(provider)` 是异步的（基类返回空数组，具体 adapter 自己实现）。
   * 字段名各家不一样，所以这里用「粘一个算一个」的取法。
   */
  async function readCatalog() {
    const llm = ctx.get('llm')
    if (!llm || typeof llm.listProviders !== 'function') return []

    let providers = []
    try {
      providers = await llm.listProviders()
    } catch (err) {
      log(`listProviders 失败：${err instanceof Error ? err.message : String(err)}`)
      return []
    }

    const out = []
    for (const raw of Array.isArray(providers) ? providers : []) {
      const id = String(raw?.id ?? raw?.provider ?? raw?.route ?? '').trim()
      if (id === '') continue

      let models = []
      try {
        models = typeof llm.listModels === 'function' ? await llm.listModels(id) : []
      } catch (err) {
        log(`listModels(${id}) 失败：${err instanceof Error ? err.message : String(err)}`)
      }

      out.push({
        id,
        name: String(raw?.displayName ?? raw?.name ?? id),
        models: (Array.isArray(models) ? models : [])
          .map((m) => ({
            id: String(m?.id ?? m?.model ?? '').trim(),
            name: String(m?.name ?? m?.id ?? ''),
            contextWindow: Number(m?.contextWindow ?? m?.context_window) || 0,
            efforts: Object.keys(m?.reasoningEfforts ?? {}),
          }))
          .filter((m) => m.id !== ''),
      })
    }
    return out
  }

  /** 现在「全局默认」是什么。 */
  function readCurrent() {
    try {
      const dm = ctx.get('agentDefaultModel')
      if (dm && typeof dm.currentSelection === 'function') {
        const sel = dm.currentSelection()
        return {
          provider: String(sel?.provider ?? ''),
          model: String(sel?.model ?? ''),
          reasoningEffort: sel?.reasoningEffort === undefined ? '' : String(sel.reasoningEffort),
        }
      }
    } catch (err) {
      log(`currentSelection 失败：${err instanceof Error ? err.message : String(err)}`)
    }
    return { provider: '', model: '', reasoningEffort: '' }
  }

  /**
   * 每个活着的会话实际挂着哪个模型。
   *
   * 优先读「待生效」的 selection（`modelSelection` projection 的 pending）——
   * 因为 `selectModel()` 改的是下一次请求要用的选择，而 `requestHeader().config`
   * 记的是**上一次真跑过**的。刚切完还没跑新的一轮时，只有 pending 是新的。
   *
   * 这是这个插件最有用的一个视图：官方 UI 只让你看见当前会话，
   * 这里能一次看见「QQ bot 那局到底在用哪个 provider」。
   */
  function readSessions() {
    const agents = ctx.get('agents')
    const list = typeof agents?.list === 'function' ? (agents.list() ?? []) : []
    const projections = ctx.get('sessionProjections')

    return list.map((agent) => {
      const id = String(agent?.id ?? '')
      let provider = ''
      let model = ''
      let source = ''

      // ① 待生效的选择
      try {
        const state = projections?.stateOf?.(agent?.session, 'modelSelection')
        const pending = state?.pending ?? null
        if (pending && typeof pending.provider === 'string') {
          provider = pending.provider
          model = String(pending.model ?? '')
          source = 'pending'
        }
      } catch {
        // projection 没注册或者读不到，退回 ②
      }

      // ② 上一次请求真正用的
      if (provider === '') {
        try {
          const cfg = agent?.session?.requestHeader?.()?.config ?? null
          if (cfg) {
            provider = String(cfg.provider ?? '')
            model = String(cfg.model ?? '')
            source = provider === '' ? '' : 'last-request'
          }
        } catch {
          // 会话还没跑过任何请求
        }
      }

      return { id, provider, model, source }
    })
  }

  /* ────────────────────────── 应用选择 ────────────────────────── */

  /**
   * 真正干活的地方。
   *
   * 用 `sessionController.selectModel({ sessionId, provider, model })` ——
   * 这是官方的对外方法（探针实测出来的，不是 `selectForNextRequest` 那个内部名）。
   * 它内部做三件事：校验路由 → `selectForNextRequest()` 应用到会话 →
   * 后台 `saveSelection()` 存默认。一步到位，自己不用碰事务。
   *
   * @param {{provider?:string, model?:string, reasoningEffort?:string}} next
   * @returns {Promise<{ok:boolean, details:string[], note?:string}>}
   */
  async function applySelection(next) {
    const provider = String(next?.provider ?? '').trim()
    const model = String(next?.model ?? '').trim()
    const effortRaw = String(next?.reasoningEffort ?? '').trim()
    const effort = effortRaw === '' ? undefined : effortRaw

    if (provider === '' || model === '') {
      return { ok: false, details: [], note: 'provider 和 model 都不能空着' }
    }

    // 校验这条路由还在不在。**不能盲目套** —— 套一个不存在的 provider 上去，
    // 每个会话都会变成死链，而且会让别的插件（比如 qq-bot）在查询模型信息时炸掉。
    const av = await checkRoute(provider)
    if (!av.ok) {
      availability.ok = av.ok
      availability.provisional = av.provisional
      availability.reason = av.reason
      availability.checkedAt = Date.now()
      availability.providers = av.providers
      return {
        ok: false,
        details: [],
        note: av.provisional
          ? `暂时没法校验 provider（${av.reason}），等 llm 注册完再试一次`
          : `拒绝应用：${av.reason}`,
      }
    }

    const request = { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
    const details = []
    const sc = ctx.get('sessionController')

    if (!sc || typeof sc.selectModel !== 'function') {
      return { ok: false, details, note: '拿不到 sessionController.selectModel —— DSH 版本可能不匹配' }
    }

    /* ① 挨个切活着的会话（bot 那局也在里面）。
          注意每个都要单独走一遍：selectModel 是按 sessionId 定位的。 */
    const targets = readSessions()
      .map((s) => s.id)
      .filter((id) => typeof id === 'string' && id !== '')

    let switched = 0
    const failures = []
    for (const sessionId of targets) {
      try {
        await sc.selectModel({ sessionId, ...request })
        switched += 1
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        failures.push(`${sessionId.slice(0, 12)}…: ${msg}`)
      }
    }

    details.push(targets.length === 0
      ? '当前没有活着的会话（下次建会话会用新的全局默认）'
      : `已切换 ${switched}/${targets.length} 个会话`)
    if (failures.length > 0) details.push(`失败 ${failures.length} 个：${failures.slice(0, 4).join('；')}`)

    /* ② 全局默认单独补一次。
          正常情况下 selectModel 内部已经后台存过了，但那条是 .catch 吞掉的；
          这里显式再存一次，好让窗口能确定「新会话也会用它」。
          HMR 事务里不能嵌套编辑，所以扔到下一个宏任务。 */
    const dm = ctx.get('agentDefaultModel')
    if (dm && typeof dm.saveSelection === 'function') {
      try {
        await new Promise((resolve) => setTimeout(resolve, 0))
        await dm.saveSelection(request)
        details.push('已写入全局默认（之后新建的会话都用它）')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        details.push(`写全局默认失败：${msg}`)
        details.push('不过没关系：目标已经记下来了，新会话出现后 20 秒内会自动跟上')
      }
    } else {
      details.push('拿不到 agentDefaultModel —— 只切了现有会话，新会话不受影响')
    }

    log(`apply ${provider}/${model}${effort === undefined ? '' : ` (${effort})`} → ${switched}/${targets.length}`)

    /* ③ 记下目标：以后新冒出来的会话（bot 换局）靠它自动跟上，
          不依赖 saveSelection 那条被 HMR 挡着的路。 */
    target = request
    saveTarget(request)
    for (const id of targets) seenSessions.add(id)

    return { ok: switched > 0 || targets.length === 0, details }
  }

  /* ────────────────────────── 新会话跟手 ────────────────────────── */

  /**
   * 为什么要有这一段：
   *
   * `agentDefaultModel.saveSelection()` 在插件侧调用会撞
   * "HMR transactions cannot be nested"（cordis 不允许在 effect 事务里编辑配置）。
   * 官方 UI 能存，是因为它走的是 client→host 的 RPC，不在事务里。
   *
   * 与其跟那个事务较劲，不如自己兜一层：把用户选的目标记下来，
   * 每 20 秒扫一遍会话表，**只对没见过的会话**补一次。
   * 这样 QQ bot 半夜换局建出新会话时，也会自动跟上。
   *
   * 已经见过的不再动 —— 你手动在某个会话里换了模型，不会被抢回去。
   */
  const targetPath = join(dataDir, 'target.json')

  /** @type {{provider:string, model:string, reasoningEffort?:string} | null} */
  let target = null
  const seenSessions = new Set()

  function loadTarget() {
    try {
      const raw = JSON.parse(readFileSync(targetPath, 'utf8'))
      if (raw && typeof raw.provider === 'string' && raw.model) {
        target = {
          provider: raw.provider,
          model: raw.model,
          ...(typeof raw.reasoningEffort === 'string' && raw.reasoningEffort !== ''
            ? { reasoningEffort: raw.reasoningEffort }
            : {}),
        }
      }
    } catch {
      // 第一次跑没有这个文件
    }
  }

  function saveTarget(next) {
    try {
      writeFileSync(targetPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    } catch (err) {
      log(`写 target.json 失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 校验一条路由现在还在不在 llm 的注册表里。
   *
   * 2026-10-27 的事故：provider 从 `unlimit` 换成 `bit`，`unlimit` 的定义从
   * `llm-pi-ai` 里删了，但 `target.json` 里还留着 `unlimit/deepseek-v4.1-flash`。
   * 插件照着 target 往所有会话上套，套出一堆死链；qq-bot 去问这个 provider 的
   * 上下文窗口时抛出未接住的异步错误，整个桌面端 `exited with 1`。
   *
   * 所以：**应用之前必须先问一句「这个 provider 还存在吗」**，不存在就一行都不套。
   *
   * `provisional: true` = 现在判不了（llm 还没注册完 / 拿不到目录）。
   * 这时候也**不套**，但不算故障 —— 等下一轮轮询再判，别把「还没就绪」当成「坏了」。
   *
   * @param {string} provider
   * @returns {Promise<{ok:boolean, provisional:boolean, reason:string, providers:string[]}>}
   */
  async function checkRoute(provider) {
    const out = { ok: false, provisional: true, reason: '', providers: [] };
    const llm = ctx.get('llm');
    if (!llm || typeof llm.listProviders !== 'function') {
      out.reason = 'llm 服务还没就绪';
      return out;
    }
    let list = [];
    try {
      list = await llm.listProviders();
    } catch (err) {
      out.reason = `listProviders 失败：${err instanceof Error ? err.message : String(err)}`;
      return out;
    }
    const ids = (Array.isArray(list) ? list : [])
      .map((p) => String(p?.id ?? p?.provider ?? p?.route ?? '').trim())
      .filter((id) => id !== '');
    out.providers = ids;
    if (ids.length === 0) {
      out.reason = 'llm 还没注册任何 provider';
      return out;
    }
    out.provisional = false;
    const want = String(provider ?? '').trim();
    if (want === '') {
      out.reason = 'provider 是空的';
      return out;
    }
    if (!ids.includes(want)) {
      out.reason = `provider「${want}」已经不在注册表里了（现在有：${ids.join(' / ')}）`;
      return out;
    }
    out.ok = true;
    return out;
  }

  /** 最近一次校验的结果，写给面板看（面板据此标红）。 */
  const availability = { ok: true, provisional: false, reason: '', checkedAt: 0, providers: [] };

  /** 扫一遍，给没见过的会话补上目标模型。 */
  async function catchUpNewSessions() {
    if (target === null) return
    const sc = ctx.get('sessionController')
    if (!sc || typeof sc.selectModel !== 'function') return

    // 先校验目标路由还在不在。**不在就一条都不套** —— 套上去等于给每个会话挂死链。
    const av = await checkRoute(target.provider)
    availability.ok = av.ok
    availability.provisional = av.provisional
    availability.reason = av.reason
    availability.checkedAt = Date.now()
    availability.providers = av.providers
    if (!av.ok) {
      if (!av.provisional) log(`跳过自动跟随：${av.reason}`)
      return
    }

    for (const s of readSessions()) {
      if (s.id === '' || seenSessions.has(s.id)) continue
      seenSessions.add(s.id)
      // 已经是目标值就不用再切（省一次校验 + 少写一条 selection 事件）
      if (s.provider === target.provider && s.model === target.model) continue
      try {
        await sc.selectModel({ sessionId: s.id, ...target })
        log(`新会话 ${s.id.slice(0, 12)}… 自动跟上 ${target.provider}/${target.model}`)
      } catch (err) {
        log(`新会话 ${s.id.slice(0, 12)}… 跟上失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /** 把「目录 + 当前 + 各会话」写成一个文件，窗口读它。 */
  async function writeSnapshot(extra = {}) {
    try {
      const payload = {
        savedAt: new Date().toISOString(),
        catalog: await readCatalog(),
        current: readCurrent(),
        sessions: readSessions(),
        // 路由可用性：面板拿它标红 + 显示「配置的这个 provider 已经没了」
        availability: { ...availability },
        target,
        ...extra,
      }
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(snapshotPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      return payload
    } catch (err) {
      log(`写快照失败：${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  /* ────────────────────────── 信箱 ────────────────────────── */

  let busy = false

  /**
   * 探针：sessionController 上到底有哪些方法。
   *
   * 2026-10-27 实测踩到的坑：`selectForNextRequest` 在
   * `dsh-api-session-controller` 的源码里是公共方法，但从插件侧
   * `ctx.get('sessionController')` 拿到的对象上不一定有 —— 需要摸清楚它到底暴露了什么。
   */
  function probeServices() {
    const out = {}
    const names = ['sessionController', 'agents', 'agentDefaultModel', 'llm', 'settings', 'configEditor']
    for (const n of names) {
      let svc = null
      try { svc = ctx.get(n) } catch { svc = null }
      if (!svc) { out[n] = { found: false }; continue }
      const proto = Object.getPrototypeOf(svc)
      out[n] = {
        found: true,
        type: svc?.constructor?.name ?? '',
        protoMethods: proto ? Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor') : [],
        ownProps: Object.getOwnPropertyNames(svc),
      }
    }
    return out
  }

  async function handleControlFile() {
    if (busy) return
    try {
      if (!existsSync(controlPath)) return
      const raw = JSON.parse(readFileSync(controlPath, 'utf8'))
      const cmd = typeof raw?.cmd === 'string' ? raw.cmd : ''
      const id = typeof raw?.id === 'string' ? raw.id : ''
      if (cmd === '' || id === '') return
      if (id === lastControlId) return
      lastControlId = id
      busy = true

      let result = { ok: false, note: `不认识的命令：${cmd}`, details: [] }
      try {
        if (cmd === 'apply') {
          result = await applySelection(raw?.payload ?? {})
        } else if (cmd === 'refresh') {
          result = { ok: true, note: '', details: ['已刷新'] }
        } else if (cmd === 'probe') {
          result = { ok: true, note: '', details: [JSON.stringify(probeServices(), null, 2)] }
        }
      } finally {
        await writeSnapshot({ lastResult: result })
        try {
          writeFileSync(
            controlPath,
            `${JSON.stringify({ cmd: '', id, doneAt: new Date().toISOString(), result }, null, 2)}\n`,
            'utf8',
          )
        } catch {
          // 回执写不进去也不影响已执行
        }
        busy = false
      }
    } catch {
      // 文件正写到一半，下一跳再看
    }
  }

  /* ────────────────────────── 启动 ────────────────────────── */

  try {
    mkdirSync(dataDir, { recursive: true })
    /* 用纯定时器轮询，不用 watchFile。
       2026-10-27 实测：watchFile 的回调跑在 cordis 的 effect 事务里，
       在里面调 configEditor.edit() 会撞 "HMR transactions cannot be nested"，
       全局默认就存不进去。setInterval 是干净的宏任务，不沾任何事务。 */
    let lastMtime = 0
    const poller = setInterval(() => {
      try {
        if (!existsSync(controlPath)) return
        const st = statSync(controlPath)
        if (st.mtimeMs === lastMtime) return
        lastMtime = st.mtimeMs
        void handleControlFile()
      } catch {
        // 文件正写到一半，下一跳再看
      }
    }, 1000)
    ctx.effect(() => () => {
      try { clearInterval(poller) } catch { /* 忽略 */ }
    }, 'dsh-model-override: control poll')
  } catch (err) {
    log(`挂不上信箱：${err instanceof Error ? err.message : String(err)}`)
  }

  // 首次进来先写一份快照，窗口打开就能看到东西
  setTimeout(() => { void writeSnapshot() }, 100)
  setTimeout(() => { void handleControlFile() }, 300)

  // 定期刷一遍快照（会话可能来来去去，模型也可能被别处改），顺手让新会话跟上
  loadTarget()
  const timer = setInterval(() => {
    void catchUpNewSessions().then(() => writeSnapshot())
  }, 20_000)
  ctx.effect(() => () => {
    try { clearInterval(timer) } catch { /* 忽略 */ }
  }, 'dsh-model-override: snapshot timer')

  log(`已就绪，数据目录 ${dataDir}`)

  /* ────────────────────────── 设置页表单驱动 ──────────────────────────
     用户在「设置 → 插件 → dsh-model-override」里填了 provider / model，
     保存后插件会重载（cordis 的 HMR），重载走到这里就拿新值应用一次 ——
     所以从设置页改也是热应用，不用重启 DSH。

     已经一致的话跳过：不然每次重载都要往每个会话里写一条 model/selection。 */
  const cfgProvider = String(config?.provider ?? '').trim()
  const cfgModel = String(config?.model ?? '').trim()
  const cfgEffort = String(config?.reasoningEffort ?? '').trim()

  if (cfgProvider !== '' && cfgModel !== '') {
    setTimeout(() => {
      try {
        const cur = readCurrent()
        const already = target !== null
          && target.provider === cfgProvider
          && target.model === cfgModel
          && (cfgEffort === '' || String(target.reasoningEffort ?? '') === cfgEffort)
          && cur.provider === cfgProvider
          && cur.model === cfgModel
        if (already) return
        void applySelection({
          provider: cfgProvider,
          model: cfgModel,
          ...(cfgEffort === '' ? {} : { reasoningEffort: cfgEffort }),
        }).then((r) => {
          log(`设置页配置生效：${r.ok ? 'ok' : '有失败'} — ${(r.details ?? []).join(' | ')}`)
        })
      } catch (err) {
        log(`设置页配置应用失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }, 1500)
  }

  /* ────────────────────────── HTTP 接口（给 GUI 侧栏面板用） ──────────────────────────
     用 `ctx.inject(['webServer'], scope => ...)`，不要用 `ctx.get('webServer')` ——
     后者在插件启动早期常常是空的（dsh-qq-bot 和 dsh-alive 的设置页就是栽在这上面，
     日志里那句「宿主没有 webServer 服务」就是它）。

     没有 webServer 的组合（headless / 纯 CLI）里这段自动跳过，插件照常工作。 */
  try {
    ctx.inject(['webServer'], (scope) => {
      const base = '/model-override'
      const off = scope.webServer.register({
        kind: 'prefix',
        path: base,
        handler: async (req, res) => {
          const send = (code, obj) => {
            try {
              res.statusCode = code
              res.setHeader('Content-Type', 'application/json; charset=utf-8')
              res.end(JSON.stringify(obj))
            } catch {
              // 连接已经断了
            }
          }
          const route = (req.url ?? '').split('?')[0].slice(base.length) || '/'
          try {
            if (route === '/state' && req.method === 'GET') {
              send(200, {
                ok: true,
                catalog: await readCatalog(),
                current: readCurrent(),
                sessions: readSessions(),
              })
              return
            }
            if (route === '/apply' && req.method === 'POST') {
              const chunks = []
              for await (const chunk of req) chunks.push(chunk)
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
              const result = await applySelection(body)
              send(200, { ok: result.ok, details: result.details ?? [], note: result.note ?? '' })
              return
            }
            send(404, { ok: false, note: `未知接口 ${route}` })
          } catch (err) {
            send(500, { ok: false, note: err instanceof Error ? err.message : String(err) })
          }
        },
      })
      if (typeof off === 'function') {
        ctx.effect(() => () => {
          try { off() } catch { /* 忽略 */ }
        }, 'dsh-model-override: routes')
      }
      log('已注册 GUI 接口 /model-override/state | /apply')
    })
  } catch (err) {
    log(`注册 HTTP 路由失败：${err instanceof Error ? err.message : String(err)}`)
  }

  /* ────────────────────────── 给别的插件/工具用 ────────────────────────── */

  if (typeof ctx.provide === 'function') {
    ctx.provide('modelOverride', {
      catalog: readCatalog,
      current: readCurrent,
      sessions: readSessions,
      apply: applySelection,
      snapshot: writeSnapshot,
    })
  }

  return {
    status() {
      return { dataDir, current: readCurrent(), sessions: readSessions() }
    },
  }
}

export default { name, apply }
