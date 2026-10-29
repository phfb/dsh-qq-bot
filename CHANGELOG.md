# 更新日志

这个仓库一次装两个插件：`dsh-qq-bot/`（QQ 私聊接入）和 `dsh-alive/`（活人感 / 主动开口）。
版本号两边同步。

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
