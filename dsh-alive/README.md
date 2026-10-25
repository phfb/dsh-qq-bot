# dsh-alive

她心里挂着没落地的事到期了，由她自己主动开口一次。

不是定时器随机发消息 —— **随机只会让人烦，心里挂着事才会让人觉得有人在那儿。**

```
你说「我去拿个外卖」
        ↓  关键词快筛 → 建一个 open loop（18 分钟，已抖动）
18 分钟后你还没回来
        ↓  过 12 道闸门 + 打分 ≥ 55
插件投一条"她自己的念头"进 QQ 会话
        ↓
agent 带人格 + 记忆现场说一句  →  dsh-qq-bot 转发到你手机
```

---

## 依赖

必须和 **dsh-qq-bot** 一起用。它不自己连 QQ：投递目标是 `qq-<你的QQ号>` 这个会话，
`assistant/message` 出去之后由 dsh-qq-bot 负责发到 QQ。

---

## 装法

> 路径以本机 `D:\DSHBot\` 的布局为例，换机器就照你的实际路径替换。
> **本机现状**：`node_modules\dsh-alive` 是指向 **本目录（`D:\DSHBot\release\dsh-alive`）** 的 junction，这样改这里的代码就等于改在跑的插件，不用再来回拷。
> 第 3 步手写的 YAML 也可以完全跳过 —— 装好之后双击 `tools\settings-alive.cmd`，在窗口里点一遍就行，见下面「工具：图形化设置」。

1. 建 junction（**不做这一步 Loader 找不到包**，dsh-qq-bot 踩过）：

   ```powershell
   New-Item -ItemType Junction `
     -Path   "D:\DSH\dsh-home\profiles\desktop\node_modules\dsh-alive" `
     -Target "<本目录的绝对路径>"
   ```

   > ⚠️ 别用 `Copy-Item` 往 `plugins\` 里拷一份再把 junction 指过去 —— 那样会变成两份代码，改了 release 里的、跑的还是旧那份。本机 2026-10-25 就踩过：设置窗口写进去的 `alive-config.json` 一直没人读，因为 junction 指的那份是旧代码（没有配置热载）。

2. `cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: dsh-alive
         name: dsh-alive
         config:
           enabled: true
           dryRun: false
           targetSession: 'auto'
           selfUin: '<你的 QQ 号>'
           dataDir: '<数据目录，必须和 dsh-qq-bot 用同一个>'
           minSilenceMin: 12
           cooldownMin: 60
           maxPerHour: 1
           maxPerDay: 2
           threshold: 55
   ```

3. 重启 DSH。（`cordis.patch.yml` 改了不会自己热载，宿主只在启动/显式重载插件时读它。）

4. 装好之后：双击 `tools\settings-alive.cmd` 改参数，保存即热应用 —— 不用再动 YAML。

---

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `dryRun` | **true** | true = 只算不投，日志里能看到"她本来会说什么" |
| `targetSession` | `auto` | 投到哪个会话。`auto` = 跟着 dsh-qq-bot 的会话映射走（推荐，换号也不用改）；也可以写死 `qq-<你的QQ号>` |
| `selfUin` | `（空）` | 你本人的 QQ 号，兜底用来找会话（建议填上） |
| `minSilenceMin` | 12 | 你刚说完话的静默期 |
| `cooldownMin` | 45 | 两次主动的基础间隔（被忽略翻倍，封顶 6h） |
| `maxPerHour` / `maxPerDay` | 1 / 4 | 配额 |
| `threshold` | 55 | 打分阈值，越高越沉默 |
| `maxAttempts` | 2 | 每条事最多追几次（按类型还会再收） |
| `quietHours` | `[]` | 完全禁言时段，如 `['03:00-06:00']` |
| `deepNightHours` | `['03:00-06:00']` | 这个时段只放"睡了"型 |
| `staleMin` | 30 | 念头超过这么久没投就作废 |
| `includeRecall` | false | 是否调 ebbinghaus 召回旧事塞进念头 |
| `tickMs` | 60000 | 心跳间隔（毫秒）。**改了要重启 DSH**（定时器不会重建） |
| `dataDir` | `~/.dsh-qq-bot` | 状态 / 日志 / 配置都落这儿，和 dsh-qq-bot 用同一个。**改了要重启 DSH** |

---

## 工具：图形化设置（`tools\settings-alive.ps1`）

不想为了改个数字去动 `cordis.patch.yml` 就用它 —— 双击 **`tools\settings-alive.cmd`**，弹一个独立窗口（和 dsh-qq-bot 的 `settings-ui.ps1` 同一套做法，WinForms，深色皮）。

> 前提：跑的是**带配置热载的版本**（`lib/index.js` 里有 `watchFile(alive-config.json)`）。旧版没有这段，窗口存进去的文件没人读 —— 表现就是「保存成功，但一点变化都没有」。装的时候照上面「装法」把 junction 直接指到本目录，别另拷一份。

四组：

| 分组 | 字段 |
|---|---|
| 开关与目标 | `enabled` / `dryRun` / `targetSession` / `selfUin` |
| 节奏 | `minSilenceMin` / `cooldownMin` / `maxPerHour` / `maxPerDay` / `threshold` / `maxAttempts` |
| 时段 | `quietHours` / `deepNightHours`（多个用逗号分隔，格式 `03:00-06:00`） |
| 其他 | `includeRecall` / `tickMs` / `staleMin` / `dataDir` |

### 它改的是哪份文件

**`<dataDir>\alive-config.json`**。窗口顶部会把完整路径打出来。

- 点「保存」→ 写进 `alive-config.json`（UTF-8 **无 BOM**）→ 插件 `watchFile` 到变化**立刻热应用**，不用重启 DSH；日志里会多一行 `配置文件变了，已热应用`。
- 这份配置**优先于** `cordis.patch.yml` 里的出厂值（按 `{...YAML, ...alive-config.json}` 合并）。
- 插件首次启动时，如果还没有 `alive-config.json`，会按当时真正生效的那套值落一份基线 —— 所以窗口一打开看到的就是你正在跑的配置，不是一堆空控件。
- 界面上没露出来的字段，保存时原样保留。

**两个例外，改了要重启 DSH 才生效**（都是插件启动时就定死的东西）：

| 字段 | 为什么 |
|---|---|
| `tickMs` | 心跳用的是 `setInterval(config.tickMs)`，定时器已经建好，改数字不会重建 |
| `dataDir` | `alive-config.json` / `alive-state.json` / `logs\` 的路径在插件启动时就算出来了 |

其余字段（开关、节奏、时段、阈值）都是每轮心跳现读，存完下一分钟就按新值走。

### `dataDir` 怎么定

**插件侧**（插件往哪写）先看 `cordis.patch.yml` 里的 `dataDir` —— 这是唯一能打破「先有鸡还是先有蛋」的入口：插件得先知道目录，才能去那儿读 `alive-config.json`。YAML 里没写就用代码默认值 `~/.dsh-qq-bot`。

**窗口侧**（设置窗口读哪份）先看 `tools\bot-config.json` 的 `dataDir`，没有就退回 `~/.dsh-qq-bot`。

两边必须指同一个目录，否则就是那个经典症状：保存了，插件没反应。`alive-config.json` 里那个 `dataDir` 只是把当前值记下来，改它要重启 DSH 才生效。

换机器的做法：

```powershell
cd <本目录>\tools
Copy-Item bot-config.example.json bot-config.json
```

改掉里面的 `dataDir` / SnowLuma 路径 / DSH 路径，然后重启 DSH 让插件读到新目录。窗口里「其他」那一组的 `dataDir` 别随手改 —— 它同时也是窗口下次找配置的依据，在这儿改容易两边错位。

### 「看运行状态」

右边那个按钮用记事本直接打开 **`alive-state.json`**，能看到今天已经投了几次、静音到什么时候、现在挂着哪几个 open loop、各条被追了几次。窗口顶部的说明区也会先显示一遍摘要（`enabled` / 静音到点 / 今日已投）。

这个文件是运行状态，**不是配置** —— 别在那儿改，改了下一轮心跳会被插件覆写。

### 它管不到的

你在 QQ 里说「别吵」触发的硬静音、`我在开会` 触发的软静音，都是**运行时状态**，落在 `alive-state.json` 里，窗口不碰。要解就按上面那张表说「我忙完了」。

---

## 她什么时候不说话（12 道闸门，任一不过就放弃）

关着 / 强关 / 静音期 / 你正在跑 turn / 你刚说完话 12 分钟内 / 冷却中 /
小时或日配额满 / 打扰欠账 ≥ 45 / 这条已经追够次数 / 在禁言时段 / 你最后一句是"别吵"。

**闸门不过不补偿、不补发** —— 错过就错过，不会攒一波突袭。

---

## 你说一句它就照做

| 你说 | 它做什么 |
|---|---|
| 别吵 / 滚 / 闭嘴 | 硬静音 2 小时，欠账 +30，当天不再主动 |
| 我在开会 / 上课 / 面试 | 软静音 90 分钟 |
| 室友睡了 | 软静音 4 小时 |
| 我忙完了 / 好了 / 出来吧 | 解除静音 |

---

## 日志

跟着 `dataDir` 走，落在 **`<dataDir>\logs\alive.log`**（本机就是 `D:\DSHBot\data\logs\alive.log`）。和 dsh-qq-bot 的 `qq-bot.log`、托盘的 `tray.log` 在同一个目录里，排查时不用来回找。

关键几行：

```
挂上一件事：food「去拿个外卖」，18 分钟后到点
投递「去拿个外卖」（分数 73.1，第 1 次）
[dryRun] 分数 68.4 {...} 本来会投：去拿外卖（念头 320 字）
放弃「去拿外卖」（他一直没有回来）
```

---

## 调分寸

觉得太吵：`maxPerDay` 降到 1、`threshold` 提到 70、`cooldownMin` 提到 120。
觉得太木：`threshold` 降到 45、`minSilenceMin` 降到 8。

判定逻辑全在 `lib/policy.mjs`，纯函数，改完跑：

```
node --test "<本目录>\test\policy.test.mjs"
```

（本机没把 `node` 放 PATH 的话，用 DSH 自带或 SnowLuma 目录里那个 exe：`D:\Astrbot\Snowluma\node.exe`。Node 24 不认 `node --test <目录>`，得给文件路径或者不带参数。）

---

## 已知边界

- **DSH 关掉就不说话**（插件在宿主进程里）。
- QQ 会话必须先存在（你在 QQ 里说过一句话），否则拿不到 agent。
- 抽取是本地关键词 + 启发式，**不调模型** —— 宁可漏判，不要误判。
- `emotional` 型（你难受时陪着）还没做，容易越界，后置。

---

## License

MIT —— 和 dsh-qq-bot 一致。它是配套插件：单独装没有意义，需要 dsh-qq-bot 在同一个 DSH 里跑。
