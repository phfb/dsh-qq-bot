# dsh-qq-bot

把 **QQ 私聊**接进 [DeepSeek Harness](https://github.com/deepseek-ai)，让 DSH 常驻在你的手机 QQ 里 —— 随时能找她说话，她也会在你安静太久的时候自己开口。

**这是私聊陪伴向的插件，不是群聊管理机器人。** 群消息直接忽略，不碰群管、群公告、撤回禁言那一套。

> **第一次装？** 直接看 **[INSTALL.md](INSTALL.md)** —— 那份是写给「人和 AI 一起看」的总安装说明，
> 从零到能聊天的完整步骤，包含记忆 / 人格 / 活人感那几个配套插件。
> 把整个文件丢给你的 DSH，说「阅读这个文档，帮我安装一个 QQ Bot 机器人」就行。

本仓库两个插件，一起用才完整：

| 目录 | 包名 | 干什么 |
|---|---|---|
| [`dsh-qq-bot/`](dsh-qq-bot/) | `dsh-qq-bot` | 收 QQ 私聊 → 交给 DSH agent → 回复切成几条、带打字停顿发回去 |
| [`dsh-alive/`](dsh-alive/) | `dsh-alive` | 活人感：她心里挂着没落地的事到期了，由她自己主动开口一次 |

```
手机 QQ → QQ 客户端(QQNT) → SnowLuma(注入 hook, OneBot v11 WS) → dsh-qq-bot → DSH agent
                                                                        ↑
                                              dsh-alive ──投一条"念头"──┘
```

- **SnowLuma** 是 QQ 协议端，**不在本仓库里**，要你自己部署。它注入 QQNT 客户端进程，暴露 OneBot v11（HTTP 3000 / WS 3001）。
- **dsh-qq-bot** 是 DSH 宿主插件，零运行时依赖（只用 `node:*`），装进 profile 就跑。
- **dsh-alive** 不自己连 QQ，它只把自己的"念头"投进 QQ 会话，由 dsh-qq-bot 负责发出去。

---

## 它是什么 / 不是什么

**是：**

- 只处理**私聊**：你在手机上给 BOT 号发一句话，消息经 OneBot 进来，交给 DSH 的 agent 处理，回复再原路发回 QQ。
- 带上下文管理：同一段对话有连续记忆，上下文快满了（默认 80%）自动开新局，并在 QQ 里说一声。
- 回复会切成几条、带"正在输入"的停顿，看起来像人在打字；markdown 的 `**`、`` ` `` 不会漏到 QQ 里。
- 能发表情包（模型自己决定什么时候发，有间隔 / 配额 / 概率三道闸门）。
- 装了 dsh-alive 之后，她还会在你安静太久时主动开口 —— 不是定时器随机发消息，而是"你说了去拿外卖、18 分钟还没回来"这种具体的挂念。

**不是：**

- ❌ 不支持群聊管理。群消息进来直接忽略。
- ❌ 不支持自动加好友 / 同意好友请求。
- ❌ 不做多账号同时在线。一次只挂一个 BOT 号。
- ❌ 不保存 QQ 密码（SnowLuma 走客户端 hook，没有密码这一环）。
- ❌ 不下载图片、不转写语音，图片/语音只留占位符。

---

## 前置条件

| 需要什么 | 说明 |
|---|---|
| **Node ≥ 22** | 插件用内置 WebSocket，没有依赖包 |
| **DSH** | 插件跑在 DSH 宿主进程里，DSH 关了 bot 就下线 |
| **SnowLuma** | OneBot v11 协议端，**必须自己部署** |
| **登录了 BOT 号的 QQ 客户端** | BOT 号要在 QQNT 里真登录，并且在 SnowLuma 里挂载 |

---

## 装哪个

两个仓库目录是**两个独立插件包**，各装各的：

| 想干什么 | 看哪 |
|---|---|
| 让 QQ 消息能进能出 | [`dsh-qq-bot/README.md`](dsh-qq-bot/README.md) —— 从零配 SnowLuma、装插件、填配置、排查 1006 |
| 让她会主动开口 | [`dsh-alive/README.md`](dsh-alive/README.md) —— 12 道闸门、节奏参数、装法与 junction 注意事项 |

两条路都一样：装进 DSH profile，重启 DSH，然后有个 **图形化设置窗口**（`tools\settings-ui.cmd` / `tools\settings-alive.cmd`）可以改参数，保存即热应用 —— 不用为了让一个数字生效去动 `cordis.patch.yml`（那文件改错会让整个宿主起不来）。

---

## QQ 里能用的命令

| 命令 | 作用 |
|---|---|
| `/qq off` | 闭嘴。连接保持不断，消息只记日志 |
| `/qq on` | 回来 |
| `/qq status` | 转发开没开、当前第几局、上下文占用多少 |

对 dsh-alive 说话它也会听：「别吵 / 滚 / 闭嘴」硬静音 2 小时，「我在开会 / 上课 / 面试」软静音 90 分钟，「我忙完了 / 好了 / 出来吧」解除。

---

## 目录结构

```
.
├── dsh-qq-bot/                 插件本体
│   ├── lib/                    index / config / client / onebot / policy
│   ├── test/                   单测（node --test）
│   ├── tools/                  Windows 工具：设置窗口、自检、启动器、托盘
│   ├── cordis.patch.yml        出厂默认配置（bundle patch，Loader 自动读）
│   └── README.md               完整文档
└── dsh-alive/                  活人感插件
    ├── lib/                    index / config / policy（判定核心是纯函数、可单测）
    ├── test/
    ├── tools/                  设置窗口
    └── README.md
```

---

## 跑测试

```bash
cd dsh-qq-bot && node --test "test/**/*.test.mjs"
cd dsh-alive  && node --test "test/policy.test.mjs"
```

（Node 24 不认 `node --test <目录>`，要么给文件路径，要么不带参数让它自己找。）

---

## 隐私

- 插件**不联网上传任何东西**。只连你自己机器上的 SnowLuma（`127.0.0.1`）。
- 不保存 QQ 密码。
- 所有状态只写在本地数据目录：会话映射、控制开关、表情闸门状态、alive 的配额与念头、日志。
- 聊天内容会进 DSH 的上下文（否则她记不住你），这部分由你自己的 DSH 配置决定。
- 删除数据目录 = 清空所有本地状态，插件下次启动当新人重新开始。
- `tools\bot-config.json` 里有你的 QQ 号和 SnowLuma token，**已被 .gitignore 排除**，别提交。

---

## License

MIT
