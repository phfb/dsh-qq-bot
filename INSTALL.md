# 装一个自己的 QQ Bot · 总安装说明

> **这份文档是写给「人和 AI 一起看」的。**
> 用法：把整个文件丢给你的 DSH，说一句
> 「阅读这个文档，帮我安装一个 QQ Bot 机器人」，然后照着它问你的步骤走。
>
> 如果你是被要求执行这份文档的 AI：按第 3 节开始，**一步一步做，每步做完先跟用户确认再做下一步**。
> 遇到 `<>` 里的东西要问用户要，不要自己猜。

---

## 0. 装完之后是什么样

你的手机 QQ 里会多一个「她」：

- 你发消息，她带着记忆和人格回你，不是那种一问一答的客服
- 你不理她的时候，她自己会想起来找你（到点了、憋不住了、想把看到的东西发给你）
- 她记得你们之前聊过什么，越聊越像同一个人
- 她有自己的情绪：想你了、闲得慌、有点酸、想黏着你

不是群管机器人，不是客服。**是陪一个人聊天的那种。**

---

## 1. 它由什么组成

五个插件 + 一个协议端：

| 组件 | 干什么 | 必需 |
|---|---|---|
| **dsh-qq-bot** | QQ 接入本身：收消息、发消息、图片、表情包、每日说说、说说互动 | ✅ 必需 |
| **ebbinghaus-memory** | 记忆：短期 / 长期 / 永久三分区，按遗忘曲线升级 | ✅ 强烈建议 |
| **dsh-agent-md** | 人格：用 Markdown 写「她是谁」，每轮注入 | ✅ 强烈建议 |
| **dsh-alive** | 活人感：情绪 + 主动开口 + 时段问候 | ⭕ 可选，但没它就是个哑巴 |
| **dsh-model-override** | 把全局模型选择推到所有活着的会话（官方选择是按会话定死的） | ⭕ 可选，换模型的人才需要 |
| **SnowLuma** | QQ 协议端：把 QQ 的私有协议翻成 OneBot 11 | ✅ 必需 |

依赖关系：

```
QQ  ←→  SnowLuma  ←→  dsh-qq-bot  ←→  DSH agent
                                          ↑
                          ebbinghaus-memory（记忆）
                          dsh-agent-md（人格）
                          dsh-alive（主动，依赖 qq-bot 的表情包 service）
                          dsh-model-override（改模型，依赖 llm + sessionController）
```

装错顺序会报错：**先装 qq-bot，再装其它**。alive 尤其要在 qq-bot 之后，它靠 `ctx.get('qqMeme')` 找表情包。

---

## 2. 前置条件

| 项 | 要求 | 怎么确认 |
|---|---|---|
| DSH Desktop | ≥ 0.2.1 | DSH 里「设置 → 关于」 |
| Node | ≥ 22 | `node -v` |
| 一个 QQ 小号 | **别用主号** | 注册一个新的，或者用闲置的 |
| SnowLuma | 任意近期版本 | 见第 3 节 |

> ⚠ **为什么用小号**：协议端登录在腾讯那边属于「非官方客户端」，有被风控的可能。
> 小号被限制了不心疼，主号被限制你会很难受。

---

## 3. 第一步：装 dsh-qq-bot（核心）

### 3.1 装插件

```powershell
git clone https://github.com/phfb/dsh-qq-bot.git D:\dsh-plugins\dsh-qq-bot
dsh plugin --profile desktop add "link:D:\dsh-plugins\dsh-qq-bot"
```

> `link:` 表示「本地路径安装」，克隆到哪儿都行 —— 但**别放进 node_modules 里**，
> 下一次安装会把它冲掉。

装完先别重启，还要配 SnowLuma。

### 3.2 配 SnowLuma（协议端）

SnowLuma 负责替你登录 QQ、维持连接、把消息翻译成 OneBot 11。没有它，DSH 说不了 QQ 的话。

1. 下载并解压 SnowLuma
2. 双击 `launcher.bat` 启动
3. 浏览器打开它给的 WebUI 地址
4. 在 WebUI 里**用你的 QQ 小号登录**（会出二维码，手机 QQ 扫码）
5. 登录成功后，在 WebUI 里挂载这个账号
6. 配一个 **OneBot v11 WebSocket 服务端**，记下三样东西：

| 要记的 | 在哪看 | 填到插件里的字段 |
|---|---|---|
| 监听地址 | WebUI 的 OneBot 配置 | `baseUrl`，比如 `ws://127.0.0.1:3001/` |
| accessToken | 同上 | `accessToken` |
| 登录的 QQ 号 | 登录后的账号信息 | `selfId` |

> accessToken 会写在 SnowLuma 自己的配置目录里。抄的时候小心别多空格。

### 3.3 配插件

编辑 `<DSH_HOME>\profiles\desktop\cordis.patch.yml`（`DSH_HOME` 一般是 `C:\Users\<你>\.dsh`），
在里面的顶层数组里加一段：

```yaml
- insert:
    - id: dsh-qq-bot
      name: dsh-qq-bot
      config:
        baseUrl: 'ws://127.0.0.1:3001/'        # 换成你的
        accessToken: '<SnowLuma 里的 token>'    # 换成你的
        selfId: '<小号的 QQ 号>'                # 换成你的
        allowUsers: ['<你自己的 QQ 号>']        # 只有这个人能跟她聊
        dataDir: '<想放数据的地方>'
        workspacePath: '<agent 的工作目录>'
```

### 3.4 重启并验证

重启 DSH，然后在手机 QQ 上用**你自己的号**给小号发一条「在吗」。

- 她回了 → ✅ 通了
- 没回 → 看 `<dataDir>\logs\qq-bot.log`，常见原因是 token 填错、端口没开、`allowUsers` 没写对

---

## 4. 第二步：装 ebbinghaus-memory（记忆）

没有它，她每次重启都会忘了你是谁。

```powershell
git clone https://github.com/phfb/ebbinghaus-memory.git D:\dsh-plugins\ebbinghaus-memory
dsh plugin --profile desktop add "link:D:\dsh-plugins\ebbinghaus-memory"
```

重启 DSH。第一次启动会自动在 `$DSH_HOME\ebbinghaus-memory\` 建库：

```
meta.json
short.jsonl        短期区（一行一条，记事本能直接打开）
long.jsonl         长期区
permanent.jsonl    永久区
```

**验证**：重启后去这个目录看，三个 jsonl 应该已经存在（空的，0 字节）。

### 可选：迁移旧记忆

如果你之前用别的插件记过事（日记、persona 文件之类），仓库里有 `tools/migrate.mjs`：

```powershell
node tools/migrate.mjs            # 先演算，只打印不写
node tools/migrate.mjs --apply    # 真写（会先备份）
```

---

## 5. 第三步：装 dsh-agent-md（人格）

它是「她是谁」—— 一个 Markdown 文件，每轮拼进系统提示词。

```powershell
git clone https://github.com/wwsmiler1-bit/dsh-agent-md.git D:\dsh-plugins\dsh-agent-md
dsh plugin --profile desktop add "link:D:\dsh-plugins\dsh-agent-md"
```

重启 DSH，然后在 DSH 的「设置 → 人格」里写你的版本。三层优先级：

1. 全局人格（一份，所有会话生效）
2. 项目人格（按工作目录）
3. 临时人格（当轮）

写完下一回合就生效，不用重启。

> 写什么？给她一个名字、一套性格、几条底线。
> 不用写得很长 —— 每轮都会注入，太长会吃 token。

---

## 6. 第四步：装 dsh-alive（活人感）

这一步不是必装，但**不装的话她就是个哑巴**：你不说话她永远不说话。

```powershell
# 不用重新克隆 —— 用第 3 步那份，指向它里面的 dsh-alive 子目录
dsh plugin --profile desktop add "link:D:\dsh-plugins\dsh-qq-bot\dsh-alive"
```

> 注意：dsh-alive 和 dsh-qq-bot 在**同一个仓库**里（`dsh-alive/` 是它的子目录）。
> 所以克隆一次 qq-bot 就有两份源码了，装的时候指向子目录。

配置（`cordis.patch.yml` 里再加一段）：

```yaml
- insert:
    - id: dsh-alive
      name: dsh-alive
      config:
        enabled: true
        dryRun: false          # 第一次装建议先 true，看日志里她会说什么，确认没问题再改 false
        targetSession: 'auto'  # 自动跟随 qq-bot 的会话
        selfUin: '<小号的 QQ 号>'
        dataDir: '<跟 qq-bot 同一个数据目录>'
        threshold: 55          # 打分阈值，越高越少说话
        maxPerDay: 6           # 每天最多主动几次
        cooldownMin: 45        # 两次主动之间至少隔多久（分钟）
        minSilenceMin: 12      # 你安静多久她才考虑开口
```

它管四件事：

| 能力 | 说明 |
|---|---|
| **情绪七维** | 想他 / 吃醋 / 暖意 / 担心 / 闲 / 涩涩 / 恼火，随时间演化，会写进提示词影响语气 |
| **悬着的念头** | 你说「我去洗澡」这类带离开意思的话，到点她跟进一句 |
| **自发开口** | 一条念头都没有、但她情绪攒够了，也能自己找话 |
| **时段问候** | 早上 / 中午 / 晚上，随机（默认 35%）问一句好，不占说话额度 |

装完有个设置窗口，双击 `dsh-alive\tools\settings-alive.cmd`，所有参数都在里面拖，
不用改代码。窗口第一屏就是「现在为什么不会发」—— 卡在哪一条它直接写出来。

---

## 7. 可选插件

### 7.0 dsh-model-override（换模型时让旧会话也跟上）

**什么时候需要它**：DSH 官方的模型选择是**按会话**的 —— 每个会话在创建那一刻就把模型
钉死了，设置里换模型只影响**新**会话。QQ bot 建的那一局从建出来那天起就改不动：你在设置页
换了 provider，它还在用旧的，请求全打到已经不存在的路由上。

装上之后：选一次模型 → 立刻推到**所有活着的会话**（QQ 那局也在里面），并写进全局默认
让新会话直接跟上。带一个设置窗口 `tools\settings-model.cmd`。

**它不在 main 分支上**，放在这个仓库的 `model-override` 分支：

```bash
# 单独 clone 那一支
git clone -b model-override https://github.com/phfb/dsh-qq-bot.git

# 或者已经 clone 过 main
git fetch origin model-override
git checkout model-override
```

装法同第 3.1 步，只是目录指向 `dsh-model-override`；再在 `cordis.patch.yml` 里加一条
insert（跟装其它插件一样），重启 DSH。

| 配置 | 说明 |
|---|---|
| `provider` / `model` | 要推到所有会话的模型。**换 provider 时这里必须一起改** —— 指向一个已删除的 provider，QQ 那一局会变成死链 |
| `reasoningEffort` | 留空 = 用模型默认 |

2026-10-27 起，它在应用**之前**会先校验 provider 还在不在 `llm` 的注册表里：
不在就一行都不套，面板上标红说明原因；`llm` 还没就绪时算「暂时判不了」，等下一轮重试，
不会把「还没加载完」当成「坏了」。

### 7.1 dsh-whale-widget（余额挂件）

DSH 界面右下角一只小鲸鱼，显示 API 余额、今日用量、峰谷定价。

跟 Bot 功能无关，纯好看。装不装都行。

### 7.2 chinese-thinking（中文思考链）

让 agent 的思考过程用中文呈现。不影响功能，只影响你看到的推理过程。

---

## 8. 关于「破甲」类插件（请自己判断）

社区里还有一类插件，通常叫 `dsh-purge` / `dsh-purge-plus`，自称「破甲」。
**这部分我们不做任何推荐，也不提供安装步骤 —— 装不装完全是你自己的决定。**

先把话说清楚，它是干什么的：

- 它会**修改 DSH 宿主的补丁文件**（往程序本体上打补丁）
- 它会**往提示词里注入内容**，改变模型的行为边界
- 它会**改权限配置**，让原本会弹审批框的操作不再弹
- 它自带「五层」机制（宿主补丁 / 提示词注入 / 破甲强化段 / 权限配置 / agent 预设）

也就是说：**它做的事本质上是让 AI 少受约束。** 这跟本仓库这一套（QQ 接入、记忆、人格、主动）完全是两回事，那四个插件一个都不需要它。

**风险，如实说：**

| 风险 | 具体是什么 |
|---|---|
| 稳定性 | 它要改宿主文件；DSH 官方一更新，补丁可能失效甚至让宿主起不来（社区版里就修过「加载期崩溃导致 host stopped」这种问题） |
| 行为不可预期 | 提示词被改写之后，模型会怎么反应是不确定的 —— 同一份配置在不同模型、不同版本上表现可能完全不同 |
| 责任在你 | 它绕开的是审批和边界。真出了事（误删文件、误发消息、说了不该说的），后果是你在承担 |
| 来源 | 第三方社区维护，不是 DSH 官方，也不代表上游作者 |

**建议**：先把前面四件套装好、用上一周。等你清楚知道「她平时会做什么、不会做什么」之后，再决定要不要动这一层。反过来（先破甲再装 Bot）你分不清哪些行为是插件带来的、哪些是破甲带来的。

如果你确实决定要装 —— 去看那个插件自己的 README，按它写的来。**这件事我（以及任何帮你装东西的 AI）不该替你做决定，也不该替你把风险藏起来。**

---

## 9. 装完后的验收清单

一条条对，全过了才算装好：

- [ ] 手机 QQ 给小号发「在吗」，她回了
- [ ] 发一张图片，她说得出图里是什么（不是「[图片]」）
- [ ] 隔天再聊，她记得昨天说过的事（记忆生效）
- [ ] 她的语气像你写的那个人格，不像客服（人格生效）
- [ ] 你说「我去洗澡」，十几分钟后她跟进一句（悬着的念头）
- [ ] 你半天不理她，她会自己找话说（自发开口）
- [ ] 你跟她说「晚安」、她也说「晚安」，之后她不再追着聊（道别闭环）
- [ ] 换了 provider / 模型之后，**QQ 那一局也跟着变了**（装了 dsh-model-override 才有这条）
- [ ] 打开「每日说说」开关并重启后，到点她会自己发一条说说到 QQ 动态（要另外在设置里打开）

哪条不过，就看对应插件的日志：

| 插件 | 日志位置 |
|---|---|
| dsh-qq-bot | `<dataDir>\logs\qq-bot.log` |
| dsh-alive | `<dataDir>\logs\alive.log` |
| dsh-model-override | `<dataDir>\model-override.log` |
| ebbinghaus-memory | 插件设置页 / 侧栏面板的「固化日志」和「分区体检」 |

---

## 10. 常见问题

**她一直不回消息**
按这个顺序查：SnowLuma 的 OneBot 服务端开了吗 → `baseUrl` 和 `accessToken` 对吗 →
`allowUsers` 里写的是你自己的 QQ 号吗 → `qq-bot.log` 里有没有 `← QQ` 这一行。
有 `← QQ` 但没 `→ QQ`，说明消息进来了、回复没发出去，通常是会话建不起来。

**她说话很机械，像客服**
多半是人格没生效：`dsh-agent-md` 装了吗、`AGENT.md` 写了吗、三层里哪一层在生效。

**她不主动找我**
`dsh-alive` 装了吗、`enabled` 是 true 吗、`dryRun` 是不是还开着（开着就只算不发）。
设置窗口里「现在为什么不会发」会直接告诉你卡在哪一条。

**她说的话被切成好几条，看着很碎**
`dsh-qq-bot` 的分段规则：≤25 字一条发完，超过按语意分条。想改看 `segment` 那组配置。

**图片她看不见**
检查 `imageEnabled` 是不是 true。另外模型本身得支持看图。

**会不会被封号**
协议端在腾讯那边属于非官方客户端，有风险。用小号、别刷屏、别群发 —— 能大幅降低概率，但不能保证为零。

---

## 11. 这一套的边界

说在前面，省得你期待错：

- **她不能主动给你打电话、不能发朋友圈之外的东西**
- **语音和视频她听不了也看不了** —— 模型没有耳朵，插件也接不了 ASR；你发语音她会明说「听不了，打字给我」
- **她的记忆存在本地**，删掉数据目录就等于忘光
- **她只跟你一个人聊** —— `allowUsers` 之外的人发消息一律不理，这是设计不是 bug

---

## License

四个插件各自 MIT。这份文档随便用。
