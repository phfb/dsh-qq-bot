# 更新日志

这个仓库一次装两个插件：`dsh-qq-bot/`（QQ 私聊接入）和 `dsh-alive/`（活人感 / 主动开口）。
版本号两边同步。

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
