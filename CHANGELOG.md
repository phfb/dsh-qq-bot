# 更新日志

这个仓库一次装两个插件：`dsh-qq-bot/`（QQ 私聊接入）和 `dsh-alive/`（活人感 / 主动开口）。
版本号两边同步。

> ⚠️ 例外：**1.2.0 只改了 `dsh-qq-bot/`**，`dsh-alive/` 这一版没有任何改动，
> 所以它的版本号停在 1.1.1，两边不同步是有意的。

## [1.2.1] - 2026-11-08

### 修：会话履历的回填从来没跑过

1.2.0 把懒回填挂在 `GET /sessions` 上，而**面板只调 `/state`、从不调 `/sessions`** ——
于是回填一次都没执行，履历一直是空表。现场表现：面板上「切回历史会话」只有当前那一局，
以前被换掉的局一条都看不见，而这正是这个功能存在的理由。

两处一起改：

1. **启动后就异步回填一次**（`setImmediate`，不阻塞启动、不拖慢第一条消息）。
   放在 `if (!config.enabled) return` 之前 —— 关着插件也该能翻履历。
2. **加扫盘兜底**：宿主没挂 `sessionQuery`（或它报错）时，直接扫
   `<DSH_HOME>/sessions/--C-DSH-DSHBot-workspace--/session-*/`。
   目录名就是 cwd 把 `: \ /` 换成 `-` 再包一层 `--`，所以不用解压日志就知道
   哪些会话属于 QQ 的工作目录；时间只能用日志文件的 mtime 近似，标成「历史遗留」。

实测这台机器上 QQ 工作区里有 24 个会话，回填后全部进了下拉。

### 数据

`qq-session-history.json` 手动补进了 `session-18d9bbf7`（11-05 那局，11-07 23:10 被换掉）——
用户点名要的。重启后 `ensureHistoryLoaded()` 读到它就能切。

---

## [1.2.0] - 2026-11-07

### 新：会话履历 + 面板上「切回历史会话」

**他的要求**：第三方 API 出问题的时候 Qbot 会自动换新对话，等线路恢复了，
想切回之前那一局却没有任何入口 —— 旧 id 从 `qq-session-map.json` 里消失了。

**改法**：换局时把旧的那一局记进 `<dataDir>/qq-session-history.json`：

| 字段 | 含义 |
|---|---|
| `sessionId` | 哪一局 |
| `startedAt` / `endedAt` | 开始 / 被换掉的时刻 |
| `reason` | `manual`（面板点「换新一局」）/ `context`（到阈值）/ `stuck`（卡住）/ `node-switch`（节点切换）/ `gone`（会话失效）/ `backfill`（功能上线前留下的） |
| `percentAtEnd` | 换掉那一刻的上下文百分比 |
| `messages` | 这一局她说过几句 |

面板上多了一块「切回历史会话」：下拉选一局 → 「切回这一局」→ 再点一次「确定切回？」。

**四条边界**（都是刻意收窄的）：

1. **只列 QQ 自己用过的会话。** 别的会话不在履历里，后端直接拒绝 ——
   `session/event` 是全局监听，绑到 GUI 会话上的话，你在电脑上说的每句话都会被发到 QQ。
2. **先验证能活再改映射。** 目标会话被删 / 被归档就当场报错，不会切到一个「发消息没反应」的绑定上。
   归档会话由 `ArchivedSessionGate` 在 `agent/pre-step` 直接 reject，切过去只会静默不响应。
3. **不做锁定。** 切回去的那一局如果本来就超了阈值，下一条消息照样触发自动换局 ——
   那是它该做的。下拉里会把当前百分比标出来。
4. **和自动换局共用 `rollingOver` 互斥**，避免一边手动切、一边被自动换掉。

**记录点四处**：`rolloverSession`（自动换局）、`/reset-session`（面板换新一局，
以前这里只有 `sessions.clear()`，旧会话直接失忆）、`switchSession`（手动切走）、
`ensureSession` 新建时（旧局恢复不了 → `gone`）。

**懒回填**：面板第一次要列表时，把 `cwd === workspacePath` 的历史会话补进履历
（只扫 QQ 专用的那个工作目录，GUI 里别处的活不会混进来）。
宿主没挂 `sessionQuery` 就跳过，并在面板上写清原因。

### 修：`enabled=false` 时看面板会 500（TDZ）

`apply()` 底下有两条早退（`enabled=false` / `allowUsers` 为空），早退之后的行不执行。
新加的 `backfillState` 一开始声明在早退之后，`let` 留在 TDZ 里 →
关了插件再打开设置页，`/state` 直接返回
`Cannot access 'backfillState' before initialization`。
已经把它挪到 `apply()` 早期。这个 bug 是 `tools/smoke-session-switch.mjs` 抓到的。

### 修：面板渲染测试的期望值早就过期了

`settings-render.test.cjs` 还按「11 组 / 56 字段」断言，而 `settings-schema.mjs`
2026-11-03 加上「宿主守护」组之后是 12 组 / 63 字段 —— 这两个断言一直红着。
已修正，并补了两条针对新面板的断言（有履历时画下拉、没履历时不画）。

### 新增文件

- `lib/session-history.mjs` —— 履历的纯函数 + 原子写，**任何失败都不抛**。
- `test/session-history.test.mjs` —— 16 条，专测「搞不坏主流程」。
- `tools/smoke-session-switch.mjs` —— 用假宿主把插件真加载起来跑一遍新接口。

### 测试

`node --test` 279/279 通过（仓库副本）。

---

## [1.1.1] - 2026-11-05

### 修：零正文催话 100% 推不出去 —— 她说的话被写进思考通道之后救不回来

模型偶尔会把整段回答写进 reasoning 通道，正文一个字不给就正常 `stop`。
插件本来有补救：判到「思考里有整段回复 + 正文空白」就推一句让她补上。

但那句补救推不出去 —— `followup` 是在 `session/event` 的 `turn/end`
处理器里**同步**调的，那一刻 session 还在发布「零正文」那条 append，宿主
直接判重入：

```
session append cannot reenter while another append is being published
```

11-04 实测两次（10:50 第 426 轮、16:21 第 54 轮），都是几毫秒内被打回来。
更糟的是 `silentNudgeAt` 在调用**之前**就占了位、失败也不回滚，配合 20 秒
防抖和 `silentRun === 1` 的条件，第二次机会也一起锁死了 —— 一次失败等于
这个机制永久报废。最后只能靠「连续 2 轮零正文 → 换局」兜底，把整个上下文
断掉。

改法：

- `followup` 推到 `setImmediate`，躲开 append 发布过程
- 推失败时把 `silentNudgeAt` 退掉，别让一次失败吃光后面的机会

只动零正文这一个调用点。`deliverTask` 还喂着日记、说说互动、看门狗三条路，
它们各有时序，一个都没碰。

### 修：hostguard 心跳永远读不到 —— 每 90 秒拉起一个守护，1246 次全是空转

`hostguard.ps1` 写 `hostguard-state.json` 用的是 `UTF8Encoding($true)`，
`$true` 就是**带 BOM**。插件这边 `JSON.parse` 读到开头的 U+FEFF 直接抛
`Unexpected token`，被 `catch` 成 `null` → 判「没有心跳」→ 拉起新的
hostguard。

而老那个从 11:55 起一直活着。新拉起的每个动起来一看 pid 文件里那个还在，
被自己的单实例锁挡回去立刻退出 —— 所以 `hostguard.log` 里那之后一条记录
都没有，全是被挡回来的。空转记录刷了 1246 条，真正的原因埋在最底下。

两头都堵：

- `hostguard.ps1` 写状态改成 `UTF8Encoding($false)`
- 插件 `readJsonFile` 读之前剥一次 BOM，别的程序写歪了也不会再炸

### 新：守护保活加一层进程探测

心跳会骗人（就像上面那样：进程好好的、文件坏了），进程不会。心跳过期时先
`process.kill(pid, 0)` 探一下状态文件里记的那个 pid：

| 探测结果 | 动作 |
|---|---|
| 进程还在 | 只记一条 WARN（同一个 pid 只报一次，不刷屏），**不拉起** |
| 进程没了 | 照旧拉起 |

### 带上 11-03 没推的：SnowLuma 直启

`hostguard.ps1` 里拉起 SnowLuma 时优先直接起 bundled 的 `node.exe`，
不再走 `launcher.bat`。`launcher.bat` 里是 `node ./index.mjs` 加一个死循环，
光杀 node 的话它 20 秒后又拉一个回来，于是两个实例抢 3000/3001 ——
11-03 升 2.4.0 时撞上过。重启这件事交给守护就够了，不需要 launcher 再来一层。

---

`dsh-alive` 本次没有功能改动，版本号跟着对齐到 `1.1.1`（本文件顶上那条规矩）。

## [1.1.0] - 2026-11-03

### 新：宿主守护 —— 开机按序拉起 + 定时整机重启 + 三层互保

给「这台机器 7×24 只跑 QQ bot」这个用法配的。三个程序（QQ → SnowLuma → DSH）
现在有人看着了，挂了会自己补，到点会自己重启整机，重启完自己爬回来。

守护是**独立进程**（`hostguard/hostguard.ps1`），不在插件里 —— 放插件里的话
DSH 一挂，看门狗跟着一起死，就没人拉 DSH 了。

**三层保护，少一层都不成立：**

| 层 | 是谁 | 盯什么 | 怎么判断 |
|---|---|---|---|
| 1 | `hostguard.ps1` | QQ / SnowLuma / DSH | 每 30 秒枚举一次进程 |
| 2 | `dsh-qq-bot` 插件 | hostguard | 它每轮写 `hostguard-state.json` 的心跳，超过 3 个周期没更新就拉一个新的 |
| 3 | 登录项 | 全部 | `Startup\DSH-HostGuard.vbs` → `start-hostguard.ps1` |

拉起顺序是硬性的：QQ 没到位就不管后面两个，SnowLuma 没到位就不管 DSH ——
因为 SnowLuma 是往 QQ 进程里注入 hook 的，QQ 没起来它挂了也是白挂。

**面板新增「宿主守护」一组**（设置 → 插件 → dsh-qq-bot）：

- 总开关
- 每天整机重启时间（默认 `04:00`，可写多个，如 `04:00,16:00`）
- 重启前倒数（默认 60 秒，期间 `shutdown /a` 能撤销）
- 连续拉几次放弃（默认 5 次）
- 多久查一遍 / 拉起后给多久启动

按钮行多了「重启整机」和「取消重启」。

**时间字段的四种行为**（都有测试）：

| 填什么 | 结果 |
|---|---|
| `undefined`（从没填过） | `04:00` |
| `''`（手动清空） | 不重启 |
| `4:0` | `04:00`（补零） |
| `25:00, xx`（全写错） | 退回 `04:00` + 记一条 problem |

最后一条是特意这么做的：填错不该变成「从此不重启」，否则第二天等到 4 点
才发现什么都没发生，还不知道为什么。

### 修：三个会让人查一晚上的坑

**一、按命令行匹配杀进程会误杀自己。**

原来的清理逻辑是「找出命令行里含 `hostguard.ps1` 的 powershell 杀掉」。
问题是任何命令行里提到这个路径的进程都会被算进去 —— 包括正在执行清理的
那一条。实测把自己杀了，退出码 `0xFFFFFFFF`。

改成 pid 文件（`hostguard.pid`），只认那一个号。

**二、从工具调用里启动的进程活不过那次调用。**

这个坑最难查：守护进程起来后跑一阵子就无声无息地没了，日志里连一行退出记录
都没有。原因是宿主（DSH）的工具调用带进程树，调用结束 / 被取消 / 被
`job_kill` 时整棵树一起清 —— 从里面起的进程全在树上。

改用 `Invoke-CimMethod Win32_Process Create`：新进程的父进程是 `WmiPrvSE.exe`，
根本不在调用方那棵树里，宿主怎么重启都带不走它。

**三、`launcher.bat` 结尾是 `pause`。**

SnowLuma 崩了窗口就停在那儿等人按键，不会自己起来。看起来像「卡死」，
其实是进程已经没了。改成崩溃后 20 秒自动重启的循环。

### 配套脚本（`hostguard/`）

| 文件 | 作用 |
|---|---|
| `hostguard.ps1` | 守护主程序 |
| `start-hostguard.ps1` | 唯一的启动入口，带单实例检查，走 WMI |
| `start-hostguard.vbs` | 登录项，静默调用上面那个 |
| `restart-dsh-now.ps1` | 延迟重启 DSH（守护让位 → 重启 → 守护回来） |
| `do-autologon.ps1` | 开 Windows 自动登录（重启后没人守，必须能自己进桌面） |

**所有路径都是自动推导的**，没有写死任何一台机器的目录：

```
<BotDir>\hostguard\hostguard.ps1
<BotDir>\data\config.json
<BotDir>\SnowLuma\
```

猜不到就用环境变量覆盖：`DSH_HOSTGUARD_QQ_EXE` / `DSH_HOSTGUARD_SNOWLUMA_DIR`
/ `DSH_HOSTGUARD_DSH_EXE` / `DSH_HOSTGUARD_CONFIG`。

`-Status` 会把推导结果打出来，装错了一眼就能看见。

### 测试

252 项全绿（新增的时间解析用例覆盖上面那张表）。

## [1.0.8] - 2026-11-02

### 改：情绪注入从 system prompt 挪到消息 —— 前缀缓存不再每轮作废

情绪段（`alive-mood`）以前是 system prompt 的一个 section（order 4950），每轮 assemble 重算。
百分比每浮动一次（84% → 83%），它后面的静态前缀和**整段对话历史**就全部失配，
provider 的前缀缓存每轮从头重算。

实测（一个 95 轮 / 9.2M token 的会话）：

| 场景 | 命中率 |
|---|---|
| 每轮第一步（新消息 → 重算） | **0.4%**（input 21 万，cacheRead 768） |
| 同一轮内后续 step（文本没变） | 99.9% |
| 整局累计 | 17.9% |

当时 system 的断点在第 18251 字符处 —— 前面记忆块已经做了会话级冻结，
所以只剩情绪这一处在动，但它一处在动就够毁掉全部。

**改法**：走 `agent/pre-step`，往请求末尾追加一条 user 消息。
追加不破坏已有前缀 —— 这是官方 `@deepseek-ai/dsh-time-context` 处理
「每轮都变的时间」用的同一套机制，它的 README 原话是
"Append-only; ... does not invalidate existing KV Cache entries"。

三个约束：

1. 只在 `step === 1` 注入（否则一条消息里调 30 次工具就追加 30 条）
2. 签名（主情绪 + 强度 + 语气）没变就不注入 —— 一个会话通常只说三五次
3. `source.kind` 用 `dsh-alive`（DSH v4 拒收 `kind: 'plugin'`，只认 producer-owned kind）

**顺带改的两处**：

- 百分比换成三档强度词（轻 / 中 / 强）。提示里本来就写着「不必复述数字」，
  模型要的是「多想要」这个量级，不是 84% 还是 79%。
- `makeMoodMessage` 手搓消息对象，不 import `@deepseek-ai/dsh-llm` ——
  插件是独立目录，靠宿主环境解析模块，实测 `ERR_MODULE_NOT_FOUND`。
  `createUserMessage` 本体就三行（`{...input, role:'user', id: randomUUID()}` 再冻结）。

**没动的**：情绪怎么算 ——`missing += 0.06 * hours` 随时间涨、`lustPhase: grow/decay`
两个相位、`onTeased` 挑逗识别（正则快判 + 模型二次判断）、`scoreImpulse` / `checkGate`
十二道闸和定时器，全部原样。改的只是「怎么告诉模型」。

**效果**：每轮第一步 input 26 万 → 172，cacheRead 768 → 33 万，命中 99.9%。
重启的代价只有一轮（system 重新组装），下一轮就回到 99.9%。

**配置**：`moodInjectionMode`，`'system'` | `'message'`（默认）| `'off'`。
填 `system` 就退回旧行为，一个字都不用改代码。

测试：`node --test` 111/111 通过（dsh-alive）。

### 补推：撤回消息时把原文找回来（之前漏推的改动）

`friend_recall` 事件只带 `message_id`，不带内容。原来那句「他把刚发的一条消息撤回了」
永远是空指，她没法知道撤掉的是哪句。

现在留一个内存环形表（最近 50 条入站消息的 id → 原文），撤回事件一来：

1. 先查本地表
2. 查不到再试一次 `get_msg`（部分 OneBot 实现撤回后短时间内还取得到）
3. 都拿不到就退回原来那句，不编

```js
text = `他把刚发的一条消息撤回了：「${recalled.slice(0, 200)}」`
```

不写盘，重启即清。

这份改动在运行版里躺了一段时间才推上来 —— 之前只对齐了 `dsh-alive`，
`dsh-qq-bot/lib/` 漏掉了。测试：`node --test` 261/261 通过（dsh-qq-bot）。

## [1.0.7] - 2026-11-02

### 新增：节点池切上游就开新对话（可关，默认门槛 5000 万 token）

换 baseURL = 换 prompt 缓存池。老会话几十万 token 的历史，切过去要整段重算一遍。

但不是「一切就换」—— A-B-A 切回来时，原节点那边的缓存还在。那个 465 轮的长会话实测：

```
切走前  bit                hit= 48512
切过去  deepseek-account   hit=   640   miss=70839
切回    bit                hit= 30208   miss=34300   ← 接回了六成
        bit                hit= 64640              ← 第二次就超过原来
```

所以「一切都换」反而会把那份缓存白白废掉。判定链是方案 2 + 3 串联：

1. 这局累计 token 用量没到门槛（默认 5000 万）→ 不换。短会话重算也就几万，换局亏
2. 当前节点 == 这局开工时那个 → 不换（缓存能接回）
3. 连续 N 轮（默认 3）都在新节点 → 换（真留下来了）
4. 最近 X 轮（默认 8）里够 M 轮（默认 5）在新节点 → 换（来回抖，大半时间不在原节点）
5. 都不满足 → pending 挂着，下一轮再看

信号来自 `node-switch.json`（`node-pool.mjs` 每次真改了 baseURL 就写一份，seq 递增）。
四个参数都能在设置页「行为」组里改，`rotateOnNodeSwitch: false` 直接关掉。

判定逻辑单独放在 `lib/node-rotate.mjs`——纯函数，不碰 ctx、不读写文件，
30 条单测覆盖（A-B-A 不换、门槛、冷却、两条判定、真实节奏串联）。

### 门槛为什么定 5000 万

按中转价算，一次 400K 历史的全量重算大约六分钱。门槛低了会让稍微长点的会话
动不动就换局，为几分钱丢一整段上下文不划算。一局跑掉五千万 token 的会话，
历史动辄三四十万，那时候重算才是真的肉疼。
## [1.0.6] - 2026-10-31

### 修复：在我自己发的说说下面评论 / 点赞 / 读详情，一律报「该条内容已被删除」

`comment_qzone`、`like_qzone` 都在 `TARGET_CLAMPED` 里，「发给谁」会被强制钉成用户本人。
以前不给 uin 时 `withTarget` 会补上 `target_uin = 他的号`；可我自己发的说说属于 bot 自己的号，
拿他的号到他那个空间里找这个 tid 必然找不到，服务端只回一句：

```
code=-10052 qzone comment failed: 该条内容已被删除
```

这句提示会把人带到「内容已经没了」的错方向上去，实际是空间找错了。

现在加了一步「认门」：先翻我这号的列表，翻不到再翻他的，按 tid 实际在哪一边决定要不要带 `target_uin`。
`detail` 一起修了——否则读自己那条说说连评论都读不出来，「看到他评论再回复」这条根本走不通。
判断结果按 tid 缓存，同一条不会反复翻列表；两边都翻不到时（比如刚发完还没进列表）退回旧行为；
显式传了 uin 的照传的走。
## [1.0.5] - 2026-10-30

### 修复：自更新 100% 失效 —— 校验时用 spawnSync 建管道，被宿主环境挡住

反馈里那两条日志是同一个事故：

```
更新：发现新版本 v1.0.4（来源 tag），开始下载…
更新：新版本校验失败，已丢弃：dsh-qq-bot/lib\client.js: 语法检查没过
      （PostQueuedCompletionStatus: (6) 句柄无效。）
```

`lib/client.js` 在 1.0.3 和 1.0.4 里逐字节相同、手跑 `node --check` 退出码 0 ——
它压根没语法问题。真凶是校验那一步：

```js
spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })   // ← 1.0.4 及以前
```

`encoding` 会让 libuv 给子进程开 stdout/stderr **两条管道**，而插件跑在 Electron 宿主
进程里（`ELECTRON_RUN_AS_NODE=1` 的 Node），那个环境建管道会失败，`spawnSync` 直接返回
`status: null` + `error.message = "PostQueuedCompletionStatus: (6) 句柄无效。"`。
老判断只写 `r.status !== 0`，而 `null !== 0` 成立 —— 于是**每个新版本**都被判「语法检查不过」，
下载成功也整包删掉，自更新永远装不上。日志里那条错误还跟语法毫无关系，看着像谜。

- `dsh-qq-bot/lib/self-update.mjs`：新增 `checkSyntaxViaNode()`，三层降级 ——
  ① `stdio: 'ignore'` 只取退出码（不建管道，宿主里能过）
  ② 真报错了再单开 stderr 捞具体那一行（`encoding` 只在这一步用）
  ③ 两种姿势都起不来 → `{ ok: null }`：这是**环境不给子进程**，不是代码坏了
- `dsh-qq-bot/lib/self-update.mjs`：新增 `checkTextGuard()` —— 空文件 / 只有空白 /
  含 `U+FFFD` 乱码一律拦下（下载被截断时 zip 照样能解开，这种坏法比语法错更常见）
- `dsh-qq-bot/lib/self-update.mjs`：新增 `classifyStagedFile()` 把「坏文件」和
  「没法校验」分成两件事 —— `ok:null` 只进 `unverified` 并告警，**不再整包丢弃**；
  继续丢弃的代价（自更新永久死掉）比放行大得多，而 `applyPending()` 本来就是逐文件备份再覆盖
- `dsh-qq-bot/lib/self-update.mjs`：新增 `pickSyntaxErrorLine()` —— 报错行优先取
  `SyntaxError` / `Error:` / `ERR_` 那一行，不再取尾巴上的 `Node.js v24.x.x`
- `dsh-qq-bot/lib/self-update.mjs`：`checkAndStage()` 失败分支把**本次探测到的 tag**
  写进 `state.json`（以前沿用上一次成功写入的 `latestTag`，于是「刚丢弃了 v1.0.4」
  在 state 里显示成 v1.0.2，排查时被带偏）
- 测试：新增 `test/self-update-verify.test.mjs` 17 条 —— 三态判定、报错行挑选、
  编码守卫、真文件（好 / 坏 / 空）各走一遍

验证（都是真跑，不是纸面推演）：

```
① 真仓库端到端：checkAndStage() → 发现 v1.0.4（来源 tag）→ 下载 61 个文件 → 校验通过
   → applyPending() 装到临时目录：新增 61 / 未变 0
② 现场注入（execPath 指到不存在的文件，让子进程真的起不来）：
   老姿势 spawnSync(...{encoding}) → status = null, error = ENOENT
   新 checkAndStage() → WARN「语法校验子进程不可用，已按编码守卫放行」
                      → result { ok: true, staged: true }   ← 不再丢包
③ node --test：231 条全绿
```

## [1.0.4] - 2026-10-30

### 修复：取不到内容的时候，正文里不再一声不吭

三个症状（引用看不到内容、发图片看不到图片、转发看不到内容）挨个查下来，
**接口全是通的** —— 日志里 `get_msg` / `get_forward_msg` 都成功返回过，
引用文字展开过十几次。问题出在「取不到之后的收尾」：正文里那个占位跟
「本来就没有」长得一模一样，她只能回一句「图没传过来」。

- `dsh-qq-bot/lib/index.js`：图下载失败（日志里的 `fetch failed`）或者拿不到可用地址时，
  正文补一句「本来有 N 张图，一张都没取到（下载失败或者没有可用地址），别假装看见，
  让他重发」；以前这种消息只剩一个裸的 `[图片]`
- `dsh-qq-bot/lib/index.js`：引用里的图没取到（协议端只回 `file`、不给能直接下载的 `url`）
  时，在引文后面单独点明「引用里还有 N 张图没取到」—— 引文有、图没有，她以前以为
  引用里只有文字
- `dsh-qq-bot/lib/index.js`：`withImageUrls` 拿不到可下载 url 时打 WARN。
  以前静默放过，事后只能看到一句「没有可下载的 url」，分不清是谁的问题
- `dsh-qq-bot/lib/index.js`：引用展开彻底失败时，占位由 `[引用]` 换成
  `[引用·原文没取到]`，跟「已展开但内容为空」区分开
- `dsh-qq-bot/lib/index.js`：合并转发在正文里补硬指令 —— 内容不在正文里，
  必须调 `qq_read_forward` 展开，不展开等于没看见。以前只丢一个 id，
  没人叫她读，十次里八次直接跳过
- `dsh-qq-bot/lib/index.js`：`qq_read_forward` 打接口前先剥壳，
  她照抄整段 `[合并转发:xxx]` 过来也能用
- `dsh-qq-bot/lib/forward.mjs`（新文件）：转发格式化从工具里抽成纯函数并补测 ——
  单节截断 200 → 600 字，图 / 表情 / 语音 / 视频 / 文件 / @ / 嵌套转发都留占位，
  不再静默丢掉（丢掉之后模型会以为那条里只有文字）
- `dsh-qq-bot/lib/policy.mjs`：新增 `countImageSegments` / `countForwardSegments` /
  `normalizeForwardId` / `QUOTE_MISSING`。`normalizeForwardId` 剥掉
  `[合并转发:…]`、方括号、引号，base64 里的 `+` `/` `=` 一个都不动
- `dsh-qq-bot/lib/image-store.js`：图片下载失败重试一次（QQ 图床偶发 reset），
  「太大」这类非暂时性错误不重试

测试：`node --test` 207 条全绿，新增 `test/inbound-fallbacks.test.mjs` 19 条，
把上面每一条「不许再沉默」的断言都钉住。

### 修复：`snowLumaAutoStart` / `snowLumaDir` 两个开关是死的

`startSnowLuma()` 里 2026-10-28 就写好了「`config.snowLumaAutoStart === false` 就别拉」，
`snowLumaDir()` 也一直在读 `config.snowLumaDir` —— 可 `config.js` 的 `parseConfig()`
是照已知字段重建对象的，**这两个键从来没被解析过**，写进 `config.json` 直接被丢掉。
于是 `=== false` 永远不成立：想关掉「随宿主启停」根本没地方关。

- `dsh-qq-bot/lib/config.js`：`DEFAULTS` 补 `snowLumaAutoStart: true` / `snowLumaDir: ''`，
  `parseConfig` 补两行解析（`snowLumaAutoStart` 只认布尔 false，写成字符串 `"false"`
  仍按开着算，免得手改 json 时反而悄悄关掉）
- `dsh-qq-bot/lib/settings-schema.mjs`：连接组补这两项，面板上能看见、能改、能落盘
- 测试：新增 `test/snowluma-autostart.test.mjs` 7 条（默认值 / 解析 / 面板表 /
  `pickPersistable` 落盘 / 端到端）；面板渲染断言从 48 项改成 50 项

## [1.0.3] - 2026-10-29

### 新增：活人感那一页把独立设置窗口的内容全搬过来了

1.0.1 起 DSH 里就有「活人感（dsh-alive）」这一页，但顶部状态卡只搬了 6 行，
`tools\settings-alive.ps1` 那个独立窗口里的东西**缺了一大半** ——
最要命的是「现在为什么不会发」整块没有，她莫名不开口的时候只能干瞪眼。

- `dsh-qq-bot/lib/client.js`：状态卡按老窗口逐行重画 —— 今日额度（已投 / 上限 / 还剩）、
  本小时、静音到几点 + 原因、今天封顶、挂着的念头（几条 / 什么事 / 约几点到点）、
  七维情绪（恼火按 `n/60`，涩涩分「未开放 / 未启用 / 真开着」三种说法）、主情绪、上次主动、
  你上次说话（QQ 里 / DSH 里两个时间）、累计（投出 / 回 / 作废 / 连续被忽略）、状态更新时间，
  最后是**「现在为什么不会发」逐条列出**（闸门全过时写「现在能发」）
- `dsh-qq-bot/lib/client.js`：卡片右上角补齐四个按钮 —— **刷新 / 马上解除静音 /
  今日额度清零 / 打开状态文件**，跟独立窗口那排一一对应
- `dsh-qq-bot/lib/index.js`：`GET /panel` 的 `status` 给全（上限、剩余、封顶、
  `openLoops`、`lastTickAt`、恼火满值 60、涩涩三态、`blocked`、四个文件路径）；
  顺带读一次 `dsh-alive/lib/mood.mjs` 的两行常量，好分清涩涩的三种状态
- `dsh-qq-bot/lib/index.js`：新增 `POST /api/dsh-qq-bot/alive-command`
  （`unmute` / `reset-quota`）与 `POST /api/dsh-qq-bot/open-file`。
  前者不碰内存，照老窗口那套往 `alive-control.json` 写一条命令、等插件回执；
  后者只认白名单里的四个文件，用记事本打开
- `dsh-alive/lib/index.js`：把闸门判断抽成 `blockedReasons()`，每轮心跳落盘前算一遍写进
  `alive-state.json` 的 `runtime.blocked`（带 `at` 时间戳）。**闸门规则只此一份**，
  面板和 PowerShell 窗口都只读不算 —— 以前窗口在外面抄了一遍规则，插件一改它就跟着错

### 修复：插件关着的时候，设置页整个打不开

`apply` 在「`enabled: false`」和「`allowUsers` 为空」这两条早退分支里直接 `return` 了，
而设置页路由是挂在 `apply` 末尾的 —— 结果就是**把插件关掉之后 DSH-BOT 面板整页 404**，
想再打开都没地方点，只能去手改 json。

- 路由注册挪到早退之前（`installPanelRoutes()`），关着也能开面板改配置
- `OneBotClient` 的 `const client` 提前成 `let client = null`：关着的时候面板点「重新连接」
  会得到一句「插件现在是关着的」而不是 TDZ 报错；卸载清理里也加了空值判断

### 顺带（上一轮没提交的）

- `dsh-alive/lib/policy.mjs` / `lib/index.js`：`renderImpulse()` 和情绪注入段里各加一句
  「这里提到的『他』就是正在跟你说话的那个人，说出口一律叫『你』」——
  不写死这句，模型会把「他」原样说出口

### 测试

- `dsh-qq-bot/test/settings-render.test.cjs` 加 4 条：老窗口那十行状态一行都不能少、
  「现在为什么不会发」逐条渲染、四个按钮都在、调参那 10 组照样渲染
- 另有用例脚本在临时目录里真跑过一遍：两跳心跳后 `runtime.blocked` 落盘、`/panel` 字段齐全、
  命令信箱被真插件执行并回执、任意路径被白名单挡掉（不进仓库）
- 全套：`dsh-qq-bot` 188 项、`dsh-alive` 111 项，全绿

## [1.0.2] - 2026-10-28

### 修复：调参面板只渲染了三分之二（DSH-BOT）

`tools/settings-ui.ps1` 有 9 组 34 项，DSH 里那张表只渲染了 **6 组 24 项** ——
「每日说说（日记）7 项 / 说说互动 4 项 / 看门狗 3 项」三整组 14 项根本不存在，
`安全` 组里的 `selfId`（带「读取」按钮那个）也漏了。

- `lib/settings-schema.mjs`：BOT_GROUPS 6 组 24 项 → **11 组 48 项**：补齐那 14 项、
  找回 `selfId`、新增「互动额度（每天最多几次）」4 项 +「其他」6 项，
  收图组补 `imageTimeoutMs`；每项都带 hint
- `lib/client.js`：删掉手抄的那张字段表，改成按宿主 `/state` 下发的 `schema.bot` 渲染
  （和「活人感」那半边同一套机制）；顺手修掉整文件乱码（69 行 —— UTF-8 被当 GBK 读过一轮，
  面板顶部的横幅、状态条、按钮文案全是「姝ｅ湪璇诲彇」这种）
- `lib/index.js`：`pickPersistable()` 改**表驱动**（只认 `settings-schema.mjs` 里的 path），
  另加 `PERSIST_EXTRA` 保住界面上故意不露的嵌套对象/长文案项。
  上一版是手抄白名单，漏了 18 项 —— 表现是「面板上能改、点保存也返回成功，
  但写进 `config.json` 那一步被静默丢掉，重启又变回老值」
- 新增测试：`test/settings-panel.test.mjs`（9 条：字段 ↔ DEFAULTS ↔ 落盘三方对齐）、
  `test/settings-render.test.cjs`（2 条：真的把面板渲染一遍再数组数，少一组就红）

### 修复：自更新把仓库地址拼错（qq-bot 与记忆插件同一份模块）

- `lib/self-update.mjs` 把 `repo` 直接拼进 `https://api.github.com/repos/${repo}/...`，
  调用方一旦传整条网址（`repository.url` 那种）就变成 `repos/https://github.com/...` → 每次 404，
  自更新等于死的。现在先过 `normalizeRepoSlug()`：`owner/repo`、`https://…`、`git+https://…`、
  `git@github.com:…` 都认，认不出来返回空串（不再拿半截地址去拼 API）
- 安装前**逐文件比字节**：一样的跳过，不一样的先备份到 `_update/backup/<时间戳>/` 再覆盖，
  并写 `report.json` 记「替换了哪些 / 新增哪些 / 没动哪些」；`state.json` 成功一次就抹掉旧 `lastError`
- `compareVersion`：`1.0` 与 `1.0.0` 现在算相等（以前缺位当 `undefined`，会误判方向）
- mounts 收窄：只覆盖 `lib / package.json / cordis.patch.yml / README.md / LICENSE / tools`，
  `test/`、`.gitignore` 不再跟着上游走 —— 免得盖掉本机手改过的同名文件

## [1.0.1] - 2026-10-28

### 新增：调参面板（DSH-BOT）

侧栏多一个 **DSH-BOT** 入口（`sidebar.panellist` + `main`），点开整页，两个标签：

- **QQ 机器人（dsh-qq-bot）**：复用插件自带那张表单（33 项 / 9 组），外加运行状态、
  读 BOT 号、重新连接、清空会话、日志尾巴。按钮在字段**上面**。
- **活人感（dsh-alive）**：表驱动生成 **48 项 / 10 组**，顶部一块只读状态卡
  （七维情绪 + 今日开口次数 + 上次主动 + 连续被忽略 + 投递统计）。

调参表在 `dsh-qq-bot/lib/settings-schema.mjs`：两个 PowerShell 设置窗的字段逐项抄成数据，
以后加字段只改这一处。接口 `GET/POST /api/dsh-qq-bot/panel`：
读配置 + 调参表 + 只读状态；写只认表里的键，数字按 min/max/step 夹紧，数组字段逗号分隔。

### 新增：自更新

`dsh-qq-bot/lib/self-update.mjs`，一次更新同时覆盖 `dsh-qq-bot/` 与 `dsh-alive/` 两个子目录。
只认发版 tag；下载 → 自解 zip → 逐文件校验 → 暂存 → 下次启动安装（装前备份）。
直连优先、镜像兜底；`DSH_NO_AUTOUPDATE=1` 可关。

### 新增：SnowLuma 随宿主启停

- 宿主启动 3 秒后，若 `baseUrl` 的 host:port 没人监听，就静默拉起
  `<SnowLuma>/node.exe index.mjs`（目录默认「数据目录的同级 /SnowLuma」，可用 `snowLumaDir` 改）
- 卸载/重载时 `taskkill /PID <pid> /T /F`，**只杀我们自己拉起来的那个**，手动开着的不动
- 开关：`snowLumaAutoStart` / `snowLumaStopOnExit`（都默认开）

### 修复

- **qzone 的默认目标号**：`list/detail/like/comment` 不给 `uin` 时原来落到**挂载 bot 那个号**的空间，
  于是她把自己的说说当成他的、又把自己的说成他的。现在默认是**他的**号，看自己发过的要显式 `uin="me"`。
- **设置页 API 从来没注册成功过**：`apply` 里 `ctx.get('webServer')` 取的时候宿主还没有这个服务，
  改成 defer 注入 `ctx.inject(['webServer'])`，服务起来才挂路由、卸载时注销。
- **alive 的「主动开口」会把念头投进桌面会话**：`resolveTargetSession()` 原来在读不到 QQ 映射时
  会退到「他最近说话的那个会话」，而那个可能是 GUI 里的。现在读不到就这一轮不投，
  她主动开口只有 QQ 一条通道。
- **会话映射被空表覆盖**：`saveMap()` 在内存里 `sessions` 为空时会写 `{}`，把真实映射抹掉
  （离线冒烟 / 异常重载都能触发）。现在内存空、磁盘有 → 拒绝写盘，只 warn。

### 新增：情绪速率整组（alive）

`moodFillHours` + `moodRates.{missing,jealousy,warmthGain,warmthDecay,worry,boredom,annoyanceDecay,lust}`，
调参面板里是 8 颗滑条（0.1x ~ 10x，步进 0.1），右边实时显示「N.Nx · 满值约 X 小时」
（「暖意·涨」显示「每次哄 +N%」）。宿主读写支持点号路径，否则 `moodRates.missing` 会被写成平铺怪键。

### 其他

- 调参面板删掉「长句阈值（已停用）」字段与标题下那行说明
- `test/smoke-client.cjs` 在 `node --test` 下不再假红（无参时正常跳过）

## [1.0.0] - 2026-10-28

首次以 1.0.0 发版：qzone 号源修正、设置页路由复活、会话映射防覆盖。
