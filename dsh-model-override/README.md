# dsh-model-override

**给 DSH 一个真正能用的「全局模型」开关。**

官方那个模型选择框是**按会话**的。你在 A 会话里换成第三方 API，B 会话还挂在原来的
provider 上 —— 尤其是 QQ bot 建的那一局，怎么点都动不了它。

这个插件改的是「全局」：选一次，**所有活着的会话立刻切换**，之后新冒出来的会话也会自动跟上。

---

## 为什么官方那个框管不了 bot

`dsh-qq-bot` 建会话时是这么拿模型的：

```js
const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
agents.create({ sessionId, agentOptions: { provider, model } })
```

**只在创建那一刻读一次。** 所以 bot 那局的模型从它被建出来那天就定死了，
你后来在 UI 里怎么换都改不到它。

这个插件实测就是这么找到症结的 —— 装上之后看会话表，一眼能看见：

```
session-e29f4ade…  →  deepseek-account / deepseek-flash   ← QQ bot 那局
session-5ae4ee53…  →  unlimit / deepseek-v4.1-flash       ← GUI 这个
```

---

## 它是怎么改的

DSH 内部有正门：`sessionController.selectModel({ sessionId, provider, model })`。
走它内部会做三件事 —— 校验路由、应用到该会话、后台存默认。

插件做的是：

1. 挨个对**所有活着的会话**调一次 `selectModel()` —— 已经开着的立刻切，bot 那局也算
2. 试一次 `agentDefaultModel.saveSelection()` —— 让新建会话默认就用它
   （这一步在插件侧可能撞 HMR 事务限制，撞上了也不影响，见下）
3. 把目标写进 `target.json`，之后每 20 秒扫一遍会话表，**只对没见过的会话**补一次 ——
   bot 半夜换局建出新会话时会自动跟上

第 3 步是兜底：`saveSelection()` 在插件侧有时会报
`HMR transactions cannot be nested`（cordis 不允许在 effect 事务里编辑配置），
失败的话**现有会话照样切好了**，只是「新会话默认值」这一条要靠第 3 步补上。

---

## 装

```powershell
git clone <本仓库> D:\dsh-plugins\dsh-model-override
dsh plugin --profile desktop add "link:D:\dsh-plugins\dsh-model-override"
```

然后在 profile 的 `cordis.patch.yml` 里加：

```yaml
- insert:
    - id: dsh-model-override
      name: dsh-model-override
      config:
        dataDir: '<跟 dsh-qq-bot / dsh-alive 同一个数据目录>'
```

重启 DSH。

---

## 用

有两种方式，功能完全一样，都是**热应用**（改完下一轮请求就生效，不用重启 DSH）。

### 方式一：DSH 设置页（推荐，不用翻文件）

**设置 → 插件 → 全局模型覆盖**，四个输入框：

| 字段 | 填什么 | 例子 |
|---|---|---|
| `provider` | 服务商 id。就是「设置 → 模型」里那个组名 | `unlimit`、`deepseek-account` |
| `model` | 该服务商下模型的 id | `deepseek-v4.1-flash`、`deepseek-flash` |
| `reasoningEffort` | 推理等级，留空 = 模型默认 | `off` / `low` / `high` / `max` |
| `dataDir` | 数据目录，留空用默认 | 跟 dsh-qq-bot 同一个目录 |

保存后插件会重载，`apply()` 拿新值应用一次 —— 所有活着的会话（含 QQ bot 那局）立刻切换。

> 值没把握的话，先去「设置 → 模型」看一眼：那里每个 provider 下面列的就是可用的 `model` id。

### 方式二：独立窗口（带下拉，看得见每个会话在用什么）

双击 `tools\settings-model.cmd`（或桌面快捷方式），窗口里：

1. **服务商** —— 列出 llm 服务注册的所有 provider（含你自己加的第三方）
2. **模型** —— 跟着服务商变
3. **推理等级** —— 该模型支持哪些等级由 provider 决定，留空 = 用模型默认
4. 点 **「应用到全部会话」**

窗口上半部分是状态区，会显示：

- 当前全局默认是什么
- **每个会话实际在用哪个 provider/model**（`pending` = 下一轮就生效；`last-request` = 上一轮跑的值）

这个视图本身就是个诊断工具 —— 它能告诉你「bot 到底在用哪家 API」。

---

## 数据文件（都在 `dataDir` 下）

| 文件 | 谁写 | 内容 |
|---|---|---|
| `snapshot.json` | 插件 | provider 目录 + 当前选择 + 每个会话的模型 |
| `target.json` | 插件 | 你最后选的目标（新会话跟随用） |
| `control.json` | 窗口 | 命令信箱，插件执行完回执 |
| `model-override.log` | 插件 | 每次切换的记录 |

**想停止「新会话自动跟随」**：删掉 `target.json` 就行，插件重启后不再补。
已经切好的会话不受影响。

---

## 已知边界

- **只改模型路由，不改模型的可用性** —— provider 的 API key 得你自己在
  `dsh-llm-pi-ai` 之类的配置里配好，这个插件不碰凭证
- **不会拦截你手动改** —— 已经见过的会话它不再动，你在某个会话里手动换了模型不会被抢回去
- **`pending` 状态要等下一轮请求才会变成 `last-request`** —— 这是 DSH 的机制，
  选择在下一次组装提示词时才落地

---

## License

MIT
