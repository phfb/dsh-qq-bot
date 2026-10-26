# dsh-qq-bot

把你的 QQ **私聊**接到 DSH 的 AI agent 上。手机上像跟人聊天一样给她发消息，她带着上下文回你。

**这是私聊陪伴插件，不是群聊管理机器人。** 定位就一句话：让 DSH 常驻在你的手机 QQ 里，随时能找她说话。

```
手机 QQ → QQ 客户端(QQNT) → SnowLuma(注入 hook, OneBot v11 WS) → dsh-qq-bot 插件 → DSH agent → 回复原路返回
```

---

## 它是什么 / 不是什么

**是：**

- 一个 DSH 宿主插件，零运行时依赖（只用 `node:*`），装进 DSH profile 就跑。
- 只处理**私聊**：你在手机上给 BOT 号发一句话，消息经 OneBot 进来，交给 DSH 的 agent 处理，回复再原路发回 QQ。
- 带上下文管理：同一段对话有连续记忆，上下文快满了会自动开新局，并在 QQ 里告诉你一声。
- 会把回复切成几条发、会模拟"正在输入"的停顿，看起来像人在打字。
- 装了 `dsh-alive`（另一个插件）的话，她还能在你安静太久的时候主动开口。
- 能发表情包（模型自己决定什么时候发，有频率闸门，不会一句话一张）。

**不是：**

- ❌ **不支持群聊管理**。群消息、群管、群公告、撤回、禁言、踢人、自动同意好友——一概不做。群消息进来直接忽略。
- ❌ **不支持自动加好友 / 自动同意好友请求**。
- ❌ **不做多账号同时在线**。一次只挂一个 QQ 号；想换号就换 `selfId` 并重启插件。
- ❌ 不会保存你的 QQ 密码。它连的是 SnowLuma，SnowLuma 走的是客户端 hook，根本没有密码这一环。
- ❌ 不下载图片、不转写语音。图片/语音只留一个 `[图片]` `[语音]` 占位，不进上下文。

---

## 装好之后是什么样

- 你在手机上给小号发"今天累死了"，几秒后她回你一句"怎么了"，接着能聊下去——因为上下文是连续的，她记得你上一句说了什么。
- 长回复会被拆成几条，中间有间隔和打字延迟，不是一整坨糊过来。
- 她不会把 markdown 的 `**` `` ` `` 漏到 QQ 里（出站会清洗）。
- 表情包偶尔出现一张，不是每句都贴。
- 上下文用到 80%（可调）时她会说一句"我换个新脑子"，然后接着聊。
- 你在 QQ 里发 `/qq off` 可以让她闭嘴（连接不断，随时 `/qq on` 回来）。

---

## 前置条件

| 需要什么 | 说明 |
|---|---|
| **Node ≥ 22** | 插件用内置 WebSocket，没有依赖包；DSH 本身也跑在 node 上，`node -v` 确认一下版本 |
| **DSH** | 插件跑在 DSH 宿主进程里，DSH 关了 bot 就下线 |
| **SnowLuma** | OneBot v11 协议端，**必须自己部署**，不在本仓库里 |
| **登录了 BOT 号的 QQ 客户端** | QQNT 客户端，BOT 号要在客户端里真登录，并且在 SnowLuma 里挂载 |

> SnowLuma 是**注入 QQNT 客户端进程的 hook**，不是账号密码登录 —— 所以本插件既不需要、也不会存 QQ 密码。你要做的只是：在 QQ 客户端里登录那个 BOT 小号，然后在 SnowLuma 的 WebUI 里把该账号「加载/挂载」。

---

## 安装

两种方式，装出来的效果不一样，看清再选。

### 方式一：`pnpm add`（推荐，能出现在插件页）

在 DSH 的 profile 目录里把它加成依赖：

```powershell
cd <你的 DSH profile 目录>
pnpm add dsh-qq-bot
```

（本地包就写路径：`pnpm add file:<本目录>` 或 `pnpm add link:<本目录>`。）

装完重启 DSH，然后：

**设置 → 插件 → dsh-qq-bot**，这就是它的配置页，所有参数都能图形化改，改完插件自动重载。

> 面板没出来？（插件页里有条目但点进去是空的）用 `tools\settings-ui.cmd` —— 一个独立的 Windows 设置窗口，改的是同一份配置文件，见下面「[图形化设置窗口](#图形化设置窗口settings-uips1)」。

> 只有走 `dependencies` 装进来的插件，才会出现在插件页的已安装列表里 —— 因为 Loader 是按**包名**从 `node_modules` 解析的。

### 方式二：手动放进 `plugins\`

1. 把整个目录复制到：

   ```
   <profile>\plugins\dsh-qq-bot\
   ```

2. 在 profile 的 `cordis.patch.yml` **末尾**加一段 insert：

   ```yaml
   - insert:
       - id: dsh-qq-bot
         name: dsh-qq-bot
         config:
           baseUrl: 'ws://127.0.0.1:3001/'
           accessToken: '<SnowLuma 里的 accessToken>'
           allowUsers: ['<你的 QQ 号>']
           selfId: '<BOT 的 QQ 号>'
           enabled: true
           dryRun: true        # 第一次先 true，看日志确认进出都通了再改 false
   ```

3. 重启 DSH。

> ⚠️ **这样装不会出现在插件页的已安装列表里**，也没有图形化配置页 —— 插件页只列 `dependencies` 里的包。参数得改 `cordis.patch.yml`，改完重启。
>
> 如果你非要它出现在插件页：在 `node_modules` 里给它建个同名 junction（`New-Item -ItemType Junction`）指向 `plugins\dsh-qq-bot`，Loader 就能按包名解析到；但列表仍然以 `dependencies` 为准，最省事的还是方式一。

---

## SnowLuma 从零配一遍

SnowLuma 不在本仓库，得你自己下、自己起。整个过程大概十分钟，其中三分钟纯等。

### 1. 下载 / 解压 SnowLuma

解压到一个固定目录（比如 `C:\Tools\SnowLuma`），**这个目录以后别挪**——托盘脚本要靠它定位。

### 2. 启动

双击解压目录里的 `launcher.bat`。

### 3. 打开 WebUI

浏览器开 `http://127.0.0.1:5099`（默认端口，被占了就看它的日志）。

### 4. 在 QQ 客户端登录 BOT 号

在你的 QQNT 客户端里登录那个要当 BOT 的小号。**这一步必须你自己做**，脚本替不了。

### 5. 在 WebUI 里挂载该账号

WebUI 的进程列表里会出现这个 QQ 进程，点它的「加载 / 挂载」。

**然后等约 3 分钟。** 首次挂载要做登录检测和好友预热，急也没用。

### 6. 判断成功

SnowLuma 日志里出现这一行就对了：

```
[Hook] login detected: ... UIN=<你的小号>
```

UIN 后面那个号，应该等于你之后填进插件的 `selfId`。对不上 = 挂错号了（多开 QQ 时最容易这样）。

### 7. 配 OneBot WebSocket 服务端

在 SnowLuma 该账号的 OneBot 配置里：

```
Network → WebSocket 服务端
地址：ws://127.0.0.1:3001/
```

**记下这里的 accessToken**，下一步要填。

（SnowLuma 会把它写在自己目录的 `config\onebot_<UIN>.json` 里，`networks.wsServers[0].accessToken`；HTTP 服务端的端口和 token 也在同一份文件里，`tools\` 下的脚本就是从那读的。）

### 8. 填进插件设置页

**设置 → 插件 → dsh-qq-bot**：

| 字段 | 填什么 |
|---|---|
| `baseUrl` | `ws://127.0.0.1:3001/` |
| `accessToken` | 第 7 步记下的 token |
| `selfId` | **BOT 的 QQ 号**（SnowLuma 挂的那个） |
| `allowUsers` | **你自己的 QQ 号**（只有这个号能指挥她） |

先保持 `dryRun: true`，在 QQ 里发一句，看日志里有没有：

```
← QQ <你的号>：xxx
[dryRun] 本应发给 <你的号>：xxx
```

两条都出现 = 进出链路都通了，把 `dryRun` 改成 `false`，重启插件。搞定。

---

## 配置项

全部可以在 **设置 → 插件 → dsh-qq-bot** 里改；方式二装的、或者插件页的面板出不来，就用 **`tools\settings-ui.cmd`**（见上文「图形化设置窗口」）；两种都不行才去改 `cordis.patch.yml`。

### 连接

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `baseUrl` | `ws://127.0.0.1:3001/` | SnowLuma 的 OneBot WebSocket 服务端地址 |
| `accessToken` | `''` | SnowLuma 的 accessToken；插件会拼成 `?access_token=` 走 query（内置 WebSocket 不能带 header） |
| `reconnect.baseMs` | `3000` | 断线重连的起始间隔（毫秒） |
| `reconnect.maxMs` | `30000` | 重连退避的上限（毫秒） |

### 安全

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `allowUsers` | `[]` | **只服务这些 QQ 号**。空数组 = 谁都不理（安全的默认值） |
| `selfId` | `''` | BOT 自己的 QQ 号。用来过滤自己发的消息，也用来核对 SnowLuma 挂的是不是这个号 |
| `enabled` | `true` | 总开关。`false` = 不连接、不转发、插件直接退出监听 |
| `dryRun` | `false` | `true` = 照常跑 agent，但回复只写日志、不真发到 QQ。第一次装务必先用它验链路 |

### 行为

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `dataDir` | `''` | 数据目录。空 = `~/.dsh-qq-bot`（Windows 是 `C:\Users\<你>\.dsh-qq-bot`） |
| `workspacePath` | `''` | QQ 会话的工作目录，空 = 用 DSH 默认。建议单独指一个目录，别和你干活的工作区混 |
| `sessionIdPrefix` | `qq-` | QQ 会话的 DSH sessionId 前缀 |
| `rateLimit.windowMs` | `60000` | 限流窗口（毫秒） |
| `rateLimit.max` | `30` | 窗口内最多几条，超了丢弃并回一句 |
| `maxQueue` | `3` | 上一轮还没跑完时最多积压几条，超了丢最老的 |
| `segment.shortMax` | `25` | **已停用（2026-10-27）**。原先"不超过这个字数就整条发"的闸门已经拆掉 —— 切分只认语意，不认字数。留着只为不炸老配置，改它没有任何效果 |
| `segment.longMin` | `60` | **已停用**。原先"≥60 字合并成一条"的规则 2026-10-25 取消。同上，改它没有效果 |
| `segment.intervalMs` | `[2000, 4000]` | 多条之间的随机间隔（毫秒区间）。**分段规则只有两条**：工作内容整条发；其他一切按**实际语意停顿**分条（换行 > 句末标点（。！？…~）> 逗号顿号分号 > 语气词/连词），多长都切、不设上限。没有停顿的长句整条发，不硬切。这套规则不依赖句号——回复里本来就不爱用句号，只靠 `。` 切是切不开的 |
| `stripTrailingPeriod` | `true` | **非特殊必要场景不用句号收尾**。每条发出前抹掉结尾的「。」（叠几个都抹），问号、感叹号、省略号、波浪号一律不动 |
| `mergeOnWork` | `true` | **聊正事、干活时整条发**，不分条。两条通道：① 回复开头写 `[[整条]]`（发出前会被剥掉，QQ 里看不到）；② 内容里有代码围栏、三行以上列表、两行以上表格、命令行清单——这种切开发出去会碎。`false` = 关掉这条通道，全部走语意分条 |
| `typingDelayMs` | `[800, 2200]` | 发出前的"正在输入"延迟（毫秒区间） |
| `cleanMarkdown` | `true` | 去掉 `**`、`` ` ``、`#` 这类 QQ 不认的记号 |
| `maxCharsPerMessage` | `1500` | 单条消息字符上限，超了切块 |
| `rateLimitReply` | `'说慢点，我一条一条回。'` | 被限流时回的话。空串 = 不回 |
| `busyReply` | `''` | 队列满 / 上一轮没跑完时的提示语。空串 = 不回 |
| `commandPrefix` | `/qq` | QQ 里控制 bot 的命令前缀 |

### 上下文

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `contextLimitPercent` | `80` | 上下文用到这个百分比就自动开新局。`0` = 关掉这个功能 |
| `contextWindow` | `1000000` | 拿不到模型元信息时的兜底上下文窗口（token）。deepseek-flash / deepseek-v4-pro 的真实窗口都是 1,000,000；写成 128000 会让换局提前十几倍触发 |
| `rolloverNotice` | `'上下文快满了哦，我先换个新脑子。…'` | 换新局时在 QQ 里说的那句 |

### 表情包

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `memesDir` | `''` | 图库目录。空 = `<dataDir>/memes` |
| `memeMinIntervalMin` | `6` | 两张表情之间的最小间隔（分钟）。`0` = 不限间隔 |
| `memeMaxPerHour` | `3` | 每小时最多几张 |
| `memeProbability` | `0.75` | 过了间隔和配额之后再掷一次骰子的通过率。`0` = 必发，`1` = 永不发 |

### 收图

他发的每一张图都会落盘、存档、交给她看。

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `imageEnabled` | `true` | 总开关。关掉就退回原来的「[图片]」占位，模型一个字都看不到图 |
| `imageDir` | `''` | 图片目录。空 = `<dataDir>/images` |
| `imageCacheLimitMB` | `2048` | 缓存上限（MB）。**允许范围 512 ~ 6144（6 GB）**，超了从最老的删起 |
| `imageCachePurgeMB` | `300` | 到了上限一次删掉多少（MB）。不会因为超一点点就把图库清空 |
| `imageMaxMB` | `20` | 单张上限（MB），超了不存（防长图把盘吃满） |
| `imageTimeoutMs` | `20000` | 单张下载超时 |

---

## QQ 里的命令

不用加好友、不用开群，直接和 BOT 号私聊发这些：

| 命令 | 作用 |
|---|---|
| `/qq off` | 闭嘴。**连接保持不断**，消息只记日志、不送进 agent |
| `/qq on` | 回来 |
| `/qq status` | 看状态：转发开没开、当前是哪个会话（第几局）、上下文占用多少 |
| `/qq pic` | 看图库：多少张、占多少、上限多少、最近三张叫什么 |
| `/qq pic clean` | 手动清一次超限的旧图 |

`/qq status` 里如果显示 `上下文：读不到`，说明宿主没挂 tokenMeter，或者还没有活会话——见下面 FAQ。

命令前缀可以用 `commandPrefix` 改。

---

## 表情包

1. 把图片丢进 `<dataDir>/memes/`（默认 `C:\Users\<你>\.dsh-qq-bot\memes\`，子目录也认）。
2. 模型通过 `send_meme` 工具自己挑一张发。
3. 频率由三个参数一起卡：`memeMinIntervalMin`（间隔）、`memeMaxPerHour`（每小时配额）、`memeProbability`（掷骰子）。
4. 图库是空的、或者这一轮被闸门拦了，她会照常说话，只是不发图。

支持 jpg / png / gif / webp。文件名随便起，中文也行。

---

## 收到图片怎么办（2026-10-25 加的）

以前收到图只写「[图片]」四个字，模型等于瞎的 —— 她会一本正经地回一句"图没显示出来"。
现在整条链路是这样：

1. **下载**：从 OneBot 的 image 段取 `url` 拉原图（没 url 的跳过，不存坏文件）
2. **落盘**：`<数据Dir>/images/20261025-173012-1-a1b2c3d4.png`
   —— 时间-序号-内容 sha256 前 8 位.扩展名。**按文件名排序就是按时间排序**
3. **挂原生附件**：同一份字节再写进 DSH 自己的附件库
   `<DSH_HOME>/attachments/v1/objects/<sha 前两位>/<完整 sha256>`，
   然后作为 `{type:'image', attachment:{attachmentId:'sha256:…'}}` 塞进 user message 的
   `content` 数组 —— **模型不用调任何工具，直接就看得见图。**
4. **记索引**：同目录 `INDEX.md`，一张表：

   | 时间 | 文件 | 大小 | 尺寸 | 他说了什么 | 我当时怎么回的 |
   |---|---|---|---|---|---|

   「我当时怎么回的」在**这一轮回复结束时自动回填** —— 不然过一个月翻起来只有
   "他发了一张图"，根本想不起那张图是干嘛的。

**为什么两套都留着**：索引里那份给人翻、能清缓存腾空间，附件库那份给模型看。
原生附件依赖 DSH 的内部格式（`attachmentId` / 目录结构），宿主一升级就可能变 ——
所以全程容错：**写不进附件就自动退回「存本地 + 在文本里给绝对路径 + 让她 read_image」**，
不会因为宿主换了实现就整条链路停摆。

### 缓存怎么清

- 上限可调：**512 MB ~ 6 GB**，默认 2 GB（设置页 / `imageCacheLimitMB`）
- 超了从**最老的开始删**，一次删 `imageCachePurgeMB`（默认 300 MB）就停手
- 无论如何**至少留 10 张**，免得图少的时候一次删光
- 被清掉的行不会消失，在 INDEX.md 里变成 `~~文件名~~ 🧹 2026-11-01`，记录还在
- **只清 `<dataDir>/images` 里的拷贝**，`attachments` 里那份归 DSH 自己管
- 手动：QQ 里发 `/qq pic` 看占用，`/qq pic clean` 立刻清一次

---

## 表情 / 文件 / 语音 / 视频 分别是什么情况

QQ 的消息段有好几种，**能看的和不能看的分清楚**，别让她编：

| 消息段 | 里面有什么 | 现在怎么处理 |
|---|---|---|
| `image` | 原图 url | ✅ 下载 → 原生附件 → 模型直接看得见 |
| `mface`（商城大表情 / 动图表情） | **有 url，是真正的图片字节** | ✅ 同上。以前被当成「[表情]」丢掉 —— 这就是"表情类图片看不见"的元凶 |
| `face`（小黄脸） | **没有图片**，只有一个 id | ⚠️ 翻成中文名，如 `[表情:鼓掌]`、`[表情#9999]`。它本来就不是图片，谁也没法"看"它的字节 |
| `file` | 文件名 / 大小 / 下载 url | ✅ 下载到 `<dataDir>/files/`，把路径交给模型，让她用对应工具打开 |
| `record`（语音） | silk 音频 | ❌ **听不了**。模型没有耳朵，也没接 ASR。会明确告诉她"这条打不开，让他打字"，禁止假装听懂 |
| `video` | 视频文件 | ❌ **看不了**。同上，明说做不到 |
| `forward`（合并转发） | 一串消息 | ✅ 留 `[合并转发:id]` 标记，她调 `qq_read_forward` 就能展开读里面每条内容 |

语音那条要说清楚：不是插件偷懒，是**模型本身吃不下音频**。真要做，
得在中间加一层 ASR（本地 whisper.cpp 或云端接口）把 silk 转成文字再喂给她 ——
`record` 段现在的 url 已经抽出来了，加一步转写就能接上。

---

## 她能自己动手做什么（工具，2026-10-26 加的）

以前她只能「说话」和「发表情」。现在给了她一层手，六个工具：

| 工具 | 干什么 |
|---|---|
| `qq_poke` | 戳他一下（QQ 的拍一拍） |
| `qq_read_forward` | 展开一条合并转发，读里面到底写了什么 |
| `qq_forward` | 把几句话打包成一条合并转发发出去，不刷屏 |
| `qq_typing` | 显示「正在输入…」 |
| `qq_qzone` | QQ 空间：列说说 / 看详情 / 好友动态 / 发说说 / 点赞 / 评论 |
| `qq_api` | 通用口，白名单里的 93 个 OneBot 接口都能直接调 |

### 什么被挡在外面（故意的）

SnowLuma 那边一共 188 个 Action，这里只放行 93 个。挡住的是：

- **群聊相关 77 个** —— 群消息、群文件、群相册、群待办、精华、群管。这个 Bot 只管私聊
- **登录凭证 5 个** —— `get_cookies` / `get_credentials` / `get_csrf_token` / `get_clientkey` / `get_rkey_server`。拿到那几个等于把整个 QQ 交出去
- **破坏性 8 个** —— `set_restart` / `bot_exit` / `clean_cache` / 改资料改头像 / `delete_friend`
- **空间里危险的那 3 个** —— `delete_qzone_msg`（删说说）、`set_qzone_msg_right`（改可见范围）、`set_qzone_ban`（封禁）

调被挡的接口不会炸，只会返回 `ok:false` 和一句「这是故意不开放的」加原因 ——
这样她（和以后改代码的人）一眼就知道不是 bug。

### 收件人是钉死的

`send_private_msg` / `send_poke` / `send_msg` / `like_qzone` 这些的「发给谁」，
参数里写谁的号都没用，一律改成他本人。**她没法私聊别人。**

`set_friend_remark` 这类不在此列 —— 那里的 `user_id` 指的是"给哪个好友改备注"，
一起钉成他就成 bug 了。

### 她现在也会收到通知类事件

以前事件总入口第一行是 `if (event?.post_type !== 'message') return`，
下面这些全被扔掉，连日志都不留：

| 事件 | 她会看到 |
|---|---|
| 戳一戳 | 「他戳了戳你」 |
| 私聊撤回 | 「他把刚发的一条消息撤回了」 |
| 加好友 | 「他把你加为好友了」 |
| 名片赞 | 「他给你的名片点了赞」 |
| 好友申请 | 「有个 xxx 想加你好友，附言：…（申请号 abcdefgh）」 |

自己的动作回声（比如自己设的「正在输入」）和群里的事件不会往上送 ——
不送是因为会自激成死循环，不是漏了。

---

## 多开 QQ 怎么办

插件一次只服务**一个** BOT 号。多开时 hook 很容易挂到错的号上，所以：

1. QQ 客户端里只让**一个**号登录，并且在 SnowLuma WebUI 里只挂载那一个。
2. 把 `selfId` 填成那个号的 QQ 号。
3. 插件启动时会调 OneBot 的 `get_login_info` 核对实际登录的 UIN，不一致会在日志里报 WARN：

   ```
   [WARN] SnowLuma 实际挂的号是 X，和设置的 BOT 号 Y 不一致（多开 QQ 时挂错）
   ```

   看到这句就去 SnowLuma 里把错的号卸下来，或者把 `selfId` 改成实际挂的那个。

`tools\check-bot.ps1` 和 `tools\start-bot.ps1` 也做同一项检查，报告里会单独列一行。

---

## Windows 工具（可选）

`tools\` 里是一套 Windows 用的脚本：一个图形化设置窗口 + 自检 + 启动器 + 托盘，纯 PowerShell（设置窗口用 WinForms），不需要装别的东西：

| 文件 | 用途 |
|---|---|
| `settings-ui.ps1` | **图形化设置窗口**，改配置不用碰 YAML（见下一节） |
| `settings-ui.cmd` | 双击入口（隐藏控制台，只弹设置窗） |
| `check-bot.ps1` | 链路自检，打印一份中文报告（`-Json` 输出 JSON） |
| `start-bot.ps1` | 一键拉起 SnowLuma + DSH，然后自检 |
| `bot-tray.ps1` | 托盘图标，绿/黄/红反映链路状态，右键有常用操作 |
| `BOT-TRAY.vbs` | **推荐的双击入口**：WScript 拉起托盘，零窗口、零黑框 |
| `start-bot.cmd` / `bot-tray.cmd` | 老的双击入口（`.cmd` 会先开一个控制台，双击时还是会闪一下） |
| `bot-config.example.json` | 配置模板，复制成 `bot-config.json` 再改 |

两个实现上的坑，改动这些脚本前先读一遍：

- **`.cmd` / `.bat` 藏不住窗口。** `Start-Process -WindowStyle Hidden` 对它们无效（走 ShellExecute，窗口样式被忽略），
  要静默只能用 `ProcessStartInfo` + `CreateNoWindow`，并且用 `cmd /c "x.bat" < nul` 包一层
  （`UseShellExecute=false` 时 `Process.Start` 不能直接启动 `.bat`；`< nul` 是为了让脚本末尾的 `pause` 读到 EOF 立刻返回）。
  仓库里的 `Start-HiddenProcess` 就是干这个的，起 SnowLuma 一律走它。
- **托盘的自检不能跑在 UI 线程上。** 一轮自检要 2~4 秒（`Get-NetTCPConnection` 一次 300~1000 ms、
  `Get-CimInstance Win32_Process` 一次 200~1300 ms、`get_login_info` 走 HTTP），
  放在 WinForms 的 `Timer` 里就等于每 5 秒把消息循环钉死 4 秒 —— 表现是鼠标划过图标没反应、换个位置又不灵。
  现在的做法是独立 runspace 后台自检、结果丢进 `[hashtable]::Synchronized`，
  UI 线程 800 ms 轮询一次只负责贴字符串。

路径来源优先级：**插件数据目录的 `config.json` → `tools\bot-config.json` → 自动探测**常见安装位置。PID、端口全部现查，不写死。

脚本是 **UTF-8 with BOM** 保存的（Windows PowerShell 5.1 不带 BOM 读中文会乱码）。要改的话记得保持这个编码。

> `settings-ui.ps1` 和 `settings-alive.ps1` 是同一套做法，但**分在两个包里**：`dsh-alive` 的设置窗口在 `dsh-alive\tools\settings-alive.cmd`，写的是 `<dataDir>\alive-config.json`。两个插件装成两个包，配置也各管各的。

---

## 图形化设置窗口（`settings-ui.ps1`）

双击 `tools\settings-ui.cmd`，弹一个深色小窗口，五组：**连接 / 安全 / 行为 / 表情包频率 / 路径**。

什么时候用它，而不是 DSH 插件页：

- 走「方式二」手动 insert 装的 —— 插件页里根本没有这个插件，自然也没有面板；
- 插件页里有条目，但**面板不出来**（这台机器上第三方插件的前端半侧没被宿主加载，就踩过一次）；
- 只想快速改个数字，不想为了改参数重启 DSH 去翻 YAML —— YAML 改错会让整个宿主起不来。

### 它改的是哪份文件

**`<dataDir>\config.json`** —— 插件自己读写的那一份，不是 `cordis.patch.yml`。窗口顶部会把完整路径打出来，别猜。

- 点「保存」→ 写进 `config.json`（UTF-8 **无 BOM**，带 BOM 会让插件的 `JSON.parse` 直接挂）→ 插件 `watchFile` 到变化**立刻热应用**，日志里会出现 `配置文件变了，已热应用`。
- **立刻生效的**：`dryRun`、切条阈值、打字延迟、`commandPrefix`、表情包三个频率闸门、`contextLimitPercent`、各种路径。这些都是在用的时候现读配置，存完就变。
- **要重载插件才生效的**：连接那四项 `baseUrl` / `accessToken` / `allowUsers` / `selfId`（连接是插件启动时建的，改参数不会自己重连）、`reconnect.baseMs` / `reconnect.maxMs`（同理，是建连时传给客户端的），以及 `enabled`（关掉插件不真断链，只是下次启动不连）。重连的按钮在 **DSH 的插件页**（`POST /api/dsh-qq-bot/reconnect`），面板出不来就直接重启 DSH —— 这两条路都通。
- 界面上没露出来的字段，保存时**原样保留**，不会被清空。
- 这一份的值**优先于** `cordis.patch.yml` 里的出厂值（插件按 `{...YAML, ...config.json}` 合并）。所以窗口里改的东西一定压得住 YAML。

### `dataDir` 是怎么找到的（最容易踩空的一步）

窗口启动时按这个顺序定位：

1. 读 `tools\bot-config.json` 的 `dataDir`；
2. 没有这个文件、或者里面没填 → 退回 `~/.dsh-qq-bot`（`C:\Users\<你>\.dsh-qq-bot`）。

而插件自己走的是 `config.json` 里的 `dataDir`（空 = 也落 `~/.dsh-qq-bot`）。**两边必须是同一个目录**，否则窗口写的那份和插件读的那份不是一份 —— 现象是「点了保存，插件一点反应没有」，或者「窗口里显示的都是默认值，我明明配过」。

第一次用，先建一份：

```powershell
cd <本目录>\tools
Copy-Item bot-config.example.json bot-config.json
```

把 `dataDir` 填成**插件实际在用的那个绝对路径**（比如 `D:/你的目录/data`），再开窗口。窗口里「路径」那一组的 `dataDir` 建议不要在这里改 —— 它同时也是窗口下次找配置的依据，在这儿改容易两边错位；要换目录，改 `tools\bot-config.json` 然后重启 DSH。

### 「读取」按钮

`selfId`（BOT 的 QQ 号）右边的「读取」，会调 OneBot 的 `get_login_info` 问 SnowLuma 现在挂的是哪个号，读到就填进下拉框 —— **多开 QQ 挂错号时靠它确认**。

它走 HTTP 接口，端口默认按 `ws://127.0.0.1:3001/` 推成 `3000`（`bot-config.json` 里填了 `httpPort` 就按那个来）。读不到只有两种原因：SnowLuma 没起，或者小号没在 SnowLuma 里挂载。

### 其他两个按钮

- **打开数据目录** —— 直接开 `<dataDir>`，里面能翻到 `config.json`、`memes\`、`logs\qq-bot.log`、`qq-session-map.json`。
- **保存** 成功会在左下角打出目标路径；失败会把异常原样显示出来（最常见是目录不可写）。

### 它管不到的

窗口只动 `config.json`；**运行时开关是另一份文件** —— 你在 QQ 里发 `/qq off`，插件把状态写进 `<dataDir>\qq-bot-control.json`，跟配置互不覆盖。想开想关，在 QQ 里发命令，别在窗口里改。

---

## 常见问题

### 消息进来了她不回

先看日志 `<dataDir>\logs\qq-bot.log`。

- 有 `← QQ xxx：...` 但没有 `→ QQ xxx：...` → 进站通了、出站没通。检查 `dryRun` 是不是还开着。
- 有 `agent id "undefined" does not match session id ...` → **旧版 bug**（建会话时没传对 sessionId），已修。升级到当前版本即可。
- 有 `忽略非白名单私聊 user_id=...` → `allowUsers` 里没填你自己这个号。
- 完全没有 `← QQ` 行 → 消息压根没进来，问题在 SnowLuma 那一侧（见下面 1006）。

### 插件页看不到这个插件

因为你是按「方式二」手动 insert 装的。插件页只列 `dependencies` 里的包，靠 `cordis.patch.yml` 的 insert 加载的插件不会出现在已安装列表里。要能点进去改参数，就用「方式一」`pnpm add` 重装一次；不想折腾就双击 `tools\settings-ui.cmd`，一样能改，而且改的是同一份 `config.json`。

### 双击 `settings-ui.cmd` 什么都没弹出来

`powershell.exe` 被策略挡住了。手动跑一遍看报错：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\settings-ui.ps1
```

或者右键 → 编辑，确认 `.cmd` 里的路径指向的是**你自己**的目录（发布包里的入口脚本用的是相对路径 `%~dp0`，别把整个 `tools\` 拆开单独拷）。

### 设置窗口保存了，插件没反应

九成是两边指的不是同一个 `dataDir`。窗口顶部写的那条路径，和 `<你的数据目录>\config.json` 必须是同一份文件 —— 详见上文「`dataDir` 是怎么找到的」。

### `/qq status` 显示 `上下文：读不到`

两种可能，日志里那条自检行会告诉你是哪种：

- `自检：拿不到 tokenMeter` → 宿主没挂 `dsh-token-meter` 插件，「到 X% 自动换新局」不会触发（其余功能照常）。
- `自检：tokenMeter 就绪` 但会话还是测不出数 → 还没有活会话，发一条消息建一局就有了。

### 连接一直断开，日志里 `code 1006`

1006 = 握手就没成，跟 agent 无关，问题在这条链的两头：

1. SnowLuma 没起来 —— `http://127.0.0.1:5099` 打不开就是它没起。
2. OneBot 的 WebSocket 服务端没开，或者端口不是 3001。
3. `accessToken` 填错了 —— 大小写敏感，别多空格。

`tools\check-bot.ps1` 会把这三段分开报，跑一遍比翻日志快。

### 多开 QQ 时挂错号

现象：你在手机上发消息，BOT 号那边毫无反应，或者回的号不是你预期的那个。

原因：SnowLuma 的 hook 注入到了另一个 QQ 进程上。处理：

1. QQ 里把别的号全退了，只留 BOT 号。
2. SnowLuma WebUI 里把错的号卸下、只挂 BOT 号。
3. 等 1-3 分钟重新做登录检测。
4. 跑 `tools\check-bot.ps1`，看「挂的哪个号」那行是不是 `[ OK ]`。

### 表情包发不出去

按顺序排除：

1. 图库是空的 —— `<dataDir>/memes/` 里得有图片文件，插件启动时会打一行 `图库索引：N 张`。
2. 频率闸门 —— `memeMinIntervalMin` / `memeMaxPerHour` / `memeProbability` 三道关，任意一道没过就不发。
3. `dryRun: true` —— 只写日志不发。

---

## 隐私

- 插件**不联网上传任何东西**。它只连你自己机器上的 SnowLuma（`127.0.0.1`）。
- **不保存 QQ 密码**，也不需要 —— SnowLuma 走的是客户端 hook。
- 所有状态只写在本地 `dataDir` 里：会话映射、控制开关、表情闸门状态、日志。
- 聊天内容会进 DSH 的上下文（否则她记不住你），这部分由你自己的 DSH 配置决定，跟插件无关。
- 删除数据目录 = 清空所有本地状态，插件下次启动会当新人重新开始。

---

## License

MIT
