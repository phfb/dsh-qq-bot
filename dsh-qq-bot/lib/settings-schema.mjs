/**
 * dsh-qq-bot / dsh-alive 两个插件的调参表 —— **从两个 PowerShell 设置窗里逐项抄出来的**。
 *
 * 为什么抄成数据表而不是再写一遍表单：96 个字段如果各写一份，两边迟早对不上，
 * 而且新加一项就得改三处。这里只有「键 / 标题 / 类型 / 范围」四件事，界面按表生成。
 *
 * 抄自：
 *   - tools/settings-ui.ps1     （qq-bot，34 项 / 9 组）—— 2026-10-28 全量对齐：
 *     缺的「每日说说 / 说说互动 / 看门狗」14 项补回来了，selfId 也回到表里；
 *     另外把 ps1 里从来没露过、但 config.js 支持的「互动额度 / 杂项」也收进来
 *     （现在 48 项 / 11 组）。
 *   - tools/settings-alive.ps1  （alive，38 项 / 9 组，另加 2026-10-28 新加的
 *     qzoneReadMissingPercent —— 那个 PowerShell 窗口里还没有；现在 48 项 / 10 组）。
 *
 * `path` 是写进 json 里的真实键名；`key` 是界面上的稳定 id（有的字段两者不同，
 * 比如 maxChars → maxCharsPerMessage）。**别拿 key 当 path 用。**
 */

/** qq-bot —— 写 <DATA_DIR>/config.json */
export const BOT_GROUPS = [
  {
    title: '连接（和 SnowLuma 对接）',
    hint: 'SnowLuma 是 QQ 协议端：让 QQ 客户端登录小号，再在 SnowLuma 里挂载该号，这里填它的 WS 地址。',
    fields: [
      {
        key: 'baseUrl',
        path: 'baseUrl',
        label: 'OneBot WS 地址',
        type: 'text',
        placeholder: 'ws://127.0.0.1:3001/',
        hint: 'SnowLuma 里 wsServers 的地址',
      },
      {
        key: 'accessToken',
        path: 'accessToken',
        label: 'accessToken',
        type: 'password',
        placeholder: '留空也能连（看服务端配没配）',
        hint: '和 SnowLuma 该账号的 token 一致；留空也能连（看服务端配没配）',
      },
    ],
  },
  {
    title: '安全（只服务你自己）',
    hint: '留空 = 谁都不服务。插件默认不响应任何人的私聊。',
    fields: [
      {
        key: 'allowUsers',
        path: 'allowUsers',
        label: '你的 QQ 号（白名单）',
        type: 'list',
        placeholder: '多个用逗号分隔，例如 123456,789012',
        hint: '多个用逗号分隔，例如 123456,789012',
      },
      {
        key: 'selfId',
        path: 'selfId',
        label: 'BOT 的 QQ 号',
        type: 'account',
        hint: '点「读取」从 SnowLuma 直接读正在登录的号，选中即可。多开 QQ 时靠它确认挂的是哪个号',
      },
    ],
  },
  {
    title: '行为',
    hint: '',
    fields: [
      { key: 'enabled', path: 'enabled', label: '启用插件（关掉就不连、不转发）', type: 'bool', hint: '关掉后不连接、不转发' },
      { key: 'dryRun', path: 'dryRun', label: '只演练不发送（只写日志）', type: 'bool', hint: '开着只写日志，消息不会真的发到 QQ' },
      {
        key: 'contextLimitPercent',
        path: 'contextLimitPercent',
        label: '上下文用到 % 换新局',
        type: 'number',
        min: 0,
        max: 100,
        step: 5,
        decimals: 0,
        hint: '0 = 关掉这个功能。换局点 = 这个百分比 × 下面的窗口大小',
      },
      {
        key: 'contextWindow',
        path: 'contextWindow',
        label: '模型上下文窗口（token）',
        type: 'number',
        min: 8000,
        max: 2000000,
        step: 1000,
        decimals: 0,
        hint: 'deepseek-flash / deepseek-v4-pro 的真实窗口都是 1,000,000。填错会让换局提前或滞后十几倍',
      },
      {
        key: 'stripTrailingPeriod',
        path: 'stripTrailingPeriod',
        label: '结尾不留句号',
        type: 'bool',
        hint: '非必要场景不用句号收尾。开着时每条发出去前抹掉结尾的「。」，问号、感叹号、省略号一律不动',
      },
      {
        key: 'mergeOnWork',
        path: 'mergeOnWork',
        label: '正事整条发',
        type: 'bool',
        hint: '聊正事、干活时不分条，一条发完。两条通道：她在回复开头加 [[整条]]；或者内容里有代码块、三行以上列表、表格、命令行清单',
      },
      {
        key: 'maxChars',
        path: 'maxCharsPerMessage',
        label: '单条上限（字）',
        type: 'number',
        min: 100,
        max: 5000,
        step: 100,
        decimals: 0,
      },
      { key: 'commandPrefix', path: 'commandPrefix', label: 'QQ 命令前缀', type: 'text', placeholder: '/qq' },
    ],
  },
  {
    title: '表情包频率',
    hint: '这三个数决定她多久能发一张表情。嫌吵就把间隔调大、每小时张数调小。',
    fields: [
      { key: 'memeMin', path: 'memeMinIntervalMin', label: '两张之间至少隔（分钟）', type: 'number', min: 0, max: 600, step: 1, decimals: 0 },
      { key: 'memeMax', path: 'memeMaxPerHour', label: '每小时最多（张）', type: 'number', min: 1, max: 60, step: 1, decimals: 0 },
      {
        key: 'memeProb',
        path: 'memeProbability',
        label: '通过率（0~1）',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
        decimals: 2,
        hint: '过了前两道闸门后再掷一次骰子',
      },
    ],
  },
  {
    title: '每日说说（日记）',
    hint: '到点让她自己写一篇日记发到 QQ 动态。默认关 —— 说说所有人可见，不该默认替你在社交圈发言。时间不做准点：会在「时间 + 窗口」里随机挑一分钟，免得一眼看出是机器人。',
    fields: [
      { key: 'diaryOn', path: 'qzoneDiaryEnabled', label: '每天写一篇日记发说说', type: 'bool', default: false },
      { key: 'diaryTime', path: 'qzoneDiaryTime', label: '大概几点（HH:MM）', type: 'text', placeholder: '18:00' },
      { key: 'diaryWin', path: 'qzoneDiaryWindowMinutes', label: '时间窗口（分钟，在这段里随机）', type: 'number', min: 1, max: 720, step: 10, decimals: 0 },
      { key: 'diaryMinChars', path: 'qzoneDiaryMinChars', label: '最少多少字', type: 'number', min: 10, max: 2000, step: 10, decimals: 0 },
      { key: 'diaryMaxChars', path: 'qzoneDiaryMaxChars', label: '最多多少字', type: 'number', min: 100, max: 5000, step: 100, decimals: 0 },
      { key: 'diaryImgs', path: 'qzoneDiaryImageCount', label: '配几张图（0~3）', type: 'number', min: 0, max: 3, step: 1, decimals: 0 },
      {
        key: 'diaryImgW',
        path: 'qzoneImageGenWeight',
        label: '配图里「现画」的比例（%，剩下挑表情包）',
        type: 'number',
        min: 0,
        max: 100,
        step: 10,
        decimals: 0,
      },
    ],
  },
  {
    title: '说说互动（只在想他/吃醋时）',
    hint: '情绪没到阈值的时候一次都不会去翻他空间 —— 那不是她，那是监控。到了阈值才按间隔看看自己说说下的新评论（只认他那个号）、以及他有没有发新说说。',
    fields: [
      { key: 'pollOn', path: 'qzonePollEnabled', label: '开启说说互动轮询', type: 'bool', default: false },
      {
        key: 'pollTrig',
        path: 'qzonePollTriggerPercent',
        label: '想他/吃醋到多少 % 才开始',
        type: 'number',
        min: 1,
        max: 100,
        step: 5,
        decimals: 0,
      },
      { key: 'pollGap', path: 'qzonePollIntervalMinutes', label: '轮询间隔（分钟）', type: 'number', min: 5, max: 720, step: 5, decimals: 0 },
      { key: 'pollDays', path: 'qzonePollLookbackDays', label: '只看最近几天', type: 'number', min: 1, max: 30, step: 1, decimals: 0 },
    ],
  },
  {
    title: '她卡住时（看门狗）',
    hint: '她那一轮跑太久、一个字都没输出的时候，插件会先打断她、临时把思考关掉、再催一句「接着说」；还不行就开新局。太短会把「她在慢慢想」误杀（实测有一轮只是慢，整整 110 秒才回）。',
    fields: [
      { key: 'wdSecs', path: 'watchdogSeconds', label: '多久没动静就算卡住（秒）', type: 'number', min: 180, max: 900, step: 30, decimals: 0 },
      { key: 'wdStrikes', path: 'watchdogMaxStrikes', label: '一轮最多救几次（到了就开新局）', type: 'number', min: 0, max: 5, step: 1, decimals: 0 },
      {
        key: 'wdNoThink',
        path: 'watchdogSwitchThinkingOff',
        label: '救的时候临时关掉思考（说完自动恢复）',
        type: 'bool',
        default: true,
      },
    ],
  },
  {
    title: '互动额度（每天最多几次）',
    hint: '她主动去戳他 / 给他空间点互动 / 分享链接的天花板。全填 0 = 这类主动全关。',
    fields: [
      { key: 'pokeMax', path: 'interactPokeMaxPerDay', label: '每天最多拍一拍几次', type: 'number', min: 0, max: 100, step: 1, decimals: 0 },
      { key: 'qzoneMax', path: 'interactQzoneMaxPerDay', label: '每天最多在空间互动几次', type: 'number', min: 0, max: 20, step: 1, decimals: 0 },
      { key: 'linkMax', path: 'interactLinkMaxPerDay', label: '每天最多分享几个链接', type: 'number', min: 0, max: 20, step: 1, decimals: 0 },
      {
        key: 'ugcRight',
        path: 'interactQzoneUgcRight',
        label: '空间互动的可见范围',
        type: 'number',
        min: 1,
        max: 128,
        step: 1,
        decimals: 0,
        hint: '1 = 所有人可见，4 = 仅好友，64 = 仅自己',
      },
    ],
  },
  {
    title: '收图（他发来的图片）',
    hint: '收到图片先下载到本地，再把绝对路径贴进消息让她自己 read_image 看。同目录的 INDEX.md 记着每张图什么时候来的、他说了什么、她怎么回的。',
    fields: [
      { key: 'imageEnabled', path: 'imageEnabled', label: '收图并让她看（关掉就只剩「[图片]」占位）', type: 'bool', default: true },
      {
        key: 'imageLimit',
        path: 'imageCacheLimitMB',
        label: '缓存上限（MB，512 ~ 6144）',
        type: 'number',
        min: 512,
        max: 6144,
        step: 128,
        decimals: 0,
        hint: '超了从最老的开始删，一次删下面那个数，不会因为超一点点就清空图库',
      },
      { key: 'imagePurge', path: 'imageCachePurgeMB', label: '一次清理掉（MB）', type: 'number', min: 50, max: 6144, step: 50, decimals: 0, hint: '到了上限就一次性删掉这么多，默认 300' },
      { key: 'imageMaxMB', path: 'imageMaxMB', label: '单张上限（MB）', type: 'number', min: 1, max: 200, step: 1, decimals: 0, hint: '超过就不存，防止一张几十兆的长图把盘吃满' },
      { key: 'imageDir', path: 'imageDir', label: '图片目录', type: 'text', placeholder: '默认 <数据目录>\\images' },
      { key: 'imageTimeoutMs', path: 'imageTimeoutMs', label: '单张下载超时（毫秒）', type: 'number', min: 1000, max: 120000, step: 1000, decimals: 0 },
    ],
  },
  {
    title: '路径',
    hint: '留空就用默认值。数据目录里放会话映射、控制开关、日志和表情图库。',
    fields: [
      { key: 'dataDir', path: 'dataDir', label: '数据目录', type: 'text', placeholder: '默认 ~/.dsh-qq-bot' },
      { key: 'workspacePath', path: 'workspacePath', label: 'QQ 会话工作目录', type: 'text', placeholder: '留空 = DSH 默认' },
      { key: 'memesDir', path: 'memesDir', label: '表情包目录', type: 'text', placeholder: '默认 <数据目录>/memes' },
    ],
  },
  {
    title: '其他',
    hint: '平时不用动。误触发、重复回复、日志太肥的时候才来调。',
    fields: [
      { key: 'dedupeSeconds', path: 'dedupeSeconds', label: '同一条消息去重窗口（秒）', type: 'number', min: 1, max: 60, step: 1, decimals: 0 },
      { key: 'farewellGapMin', path: 'farewellGapMin', label: '说完再见后多久不再追（分钟）', type: 'number', min: 10, max: 1440, step: 10, decimals: 0 },
      { key: 'taskWatchSec', path: 'taskDeliveryWatchSeconds', label: '子任务投递等多久算超时（秒）', type: 'number', min: 10, max: 600, step: 10, decimals: 0 },
      { key: 'zeroTextTurns', path: 'zeroTextRolloverTurns', label: '连续几轮正文为空就换新局', type: 'number', min: 0, max: 10, step: 1, decimals: 0 },
      { key: 'zeroTextNudge', path: 'zeroTextNudge', label: '正文为空时催她一句', type: 'bool', default: true },
      { key: 'logRotateMB', path: 'logRotateMB', label: '日志滚到多大换新文件（MB）', type: 'number', min: 0, max: 512, step: 1, decimals: 0 },
    ],
  }
];

/** alive（活人感 / 主动开口）—— 写 <DATA_DIR>/alive-config.json */
export const ALIVE_GROUPS = [
    {
      "title": "禁言机制",
      "hint": "他说「别发了」「闭嘴」这类话时，插件要不要真的闭嘴。关掉总开关就只当聊天听：不静音、不封当天额度。",
      "fields": [
        {
          "key": "muteEnabled",
          "label": "启用禁言机制（认得出「别发了」就静音 + 当天不再主动）",
          "path": "muteEnabled",
          "type": "bool",
          "default": true
        },
        {
          "key": "softMuteEnabled",
          "label": "场景静音也算（开会 / 室友在 / 我在忙 → 60~240 分钟）",
          "path": "softMuteEnabled",
          "type": "bool",
          "default": true
        },
        {
          "key": "hardMuteMin",
          "label": "硬静音多久（分钟）",
          "path": "hardMuteMin",
          "type": "number",
          "min": 5,
          "max": 1440,
          "step": 5,
          "decimals": 0,
          "default": 120
        }
      ]
    },
    {
      "title": "情绪速率（多久攒满）",
      "hint": "每颗滑条是速率倍率 0.1x ~ 10x；1.0x = 用「基准」那栏的小时数从 0% 涨到 100%。涩涩那颗按上面的「启用涩涩模式」走，没勾也照样能调，只是她不会攒。",
      "fields": [
        { "key": "moodFillHours", "label": "基准：1.0x 时多久攒满（小时）", "path": "moodFillHours", "type": "number", "min": 1, "max": 72, "step": 0.5, "decimals": 1, "default": 6 },
        { "key": "rate.missing", "label": "想他（深夜更快）", "path": "moodRates.missing", "type": "range", "min": 0.1, "max": 10, "step": 0.1, "decimals": 1 },
        { "key": "rate.jealousy", "label": "吃醋（他没动静时）", "path": "moodRates.jealousy", "type": "range", "min": 0.1, "max": 10, "step": 0.1, "decimals": 1 },
        { "key": "rate.warmthGain", "label": "暖意·涨（每次哄 +30%）", "path": "moodRates.warmthGain", "type": "range", "min": 0.1, "max": 10, "step": 0.1, "decimals": 1 },
        { "key": "rate.warmthDecay", "label": "暖意·掉（冷到底）", "path": "moodRates.warmthDecay", "type": "range", "min": 0.1, "max": 10, "step": 0.1, "decimals": 1 },
        { "key": "rate.worry", "label": "担心（凌晨他还没消息）", "path": "moodRates.worry", "type": "range", "min": 0.1, "max": 10, "step": 0.1, "decimals": 1 },
        { "key": "rate.boredom", "label": "闲得慌（想他越久越快）", "path": "moodRates.boredom", "type": "range", "min": 0.1, "max": 10, "step": 0.1, "decimals": 1 },
        { "key": "rate.annoyanceDecay", "label": "恼火·消气（60 点全消）", "path": "moodRates.annoyanceDecay", "type": "range", "min": 0.1, "max": 10, "step": 0.1, "decimals": 1 },
        { "key": "rate.lust", "label": "涩涩", "path": "moodRates.lust", "type": "range", "min": 0.1, "max": 10, "step": 0.1, "decimals": 1 }
      ]
    },
    {
      "title": "涩涩（对话驱动）",
      "hint": "不是随时间攒的：你在 QQ 里挑逗她 → 顶上去一截 → 事后慢慢回落到「余温下限」→ 再随「想他」自己爬，但爬到「自涨封顶」就停住，往上只能靠对话。建议搭配 purge-plus 插件用。",
      "fields": [
        {
          "key": "lustModeEnabled",
          "label": "启用涩涩模式",
          "path": "lustModeEnabled",
          "type": "bool",
          "default": false
        },
        {
          "key": "lustFloorPercent",
          "label": "余温下限（%）：回落到这儿停住",
          "path": "lustFloorPercent",
          "type": "number",
          "min": 0,
          "max": 100,
          "step": 5,
          "decimals": 0,
          "default": 20
        },
        {
          "key": "lustSelfCapPercent",
          "label": "自涨封顶（%）：自己爬最多到这儿",
          "path": "lustSelfCapPercent",
          "type": "number",
          "min": 0,
          "max": 100,
          "step": 5,
          "decimals": 0,
          "default": 70
        },
        {
          "key": "lustDecayHours",
          "label": "回落到下限要多久（小时）",
          "path": "lustDecayHours",
          "type": "number",
          "min": 0.1,
          "max": 240,
          "step": 0.5,
          "decimals": 1,
          "default": 4
        },
        {
          "key": "lustFillHours",
          "label": "自涨基准（小时）：下限爬到封顶",
          "path": "lustFillHours",
          "type": "number",
          "min": 0.1,
          "max": 240,
          "step": 0.5,
          "decimals": 1,
          "default": 6
        },
        {
          "key": "lustTeaseStepPercent",
          "label": "你挑逗一次涨多少（%）",
          "path": "lustTeaseStepPercent",
          "type": "number",
          "min": 0,
          "max": 100,
          "step": 5,
          "decimals": 0,
          "default": 25
        }
      ]
    },
    {
      "title": "开关与目标",
      "hint": "",
      "fields": [
        {
          "key": "enabled",
          "label": "启用活人感（她会主动开口）",
          "path": "enabled",
          "type": "bool",
          "default": true
        },
        {
          "key": "dryRun",
          "label": "只演练不发送（只在日志里看\"她本来会说什么\"）",
          "path": "dryRun",
          "type": "bool",
          "default": true
        },
        {
          "key": "targetSession",
          "label": "投递到哪个会话",
          "path": "targetSession",
          "type": "text",
          "placeholder": "auto = 跟 qq-bot 的会话映射走"
        },
        {
          "key": "selfUin",
          "label": "你自己的 QQ 号",
          "path": "selfUin",
          "type": "text",
          "placeholder": "填了才知道该找哪个会话"
        }
      ]
    },
    {
      "title": "节奏（多久开口一次）",
      "hint": "静默不够久不开口；冷却不够长不开口；分数不够高不开口。上面前三行就是额度的实时数字。",
      "fields": [
        {
          "key": "minSilenceMin",
          "label": "他安静多久才考虑开口（分钟）",
          "path": "minSilenceMin",
          "type": "number",
          "min": 1,
          "max": 600,
          "step": 1,
          "decimals": 0,
          "default": 12
        },
        {
          "key": "cooldownMin",
          "label": "两次主动之间至少隔（分钟）",
          "path": "cooldownMin",
          "type": "number",
          "min": 1,
          "max": 720,
          "step": 5,
          "decimals": 0,
          "default": 45
        },
        {
          "key": "maxPerHour",
          "label": "每小时最多几次",
          "path": "maxPerHour",
          "type": "number",
          "min": 1,
          "max": 20,
          "step": 1,
          "decimals": 0,
          "default": 1
        },
        {
          "key": "maxPerDay",
          "label": "每天最多几次",
          "path": "maxPerDay",
          "type": "number",
          "min": 1,
          "max": 50,
          "step": 1,
          "decimals": 0,
          "default": 4
        },
        {
          "key": "threshold",
          "label": "打分阈值（越高越少说话）",
          "path": "threshold",
          "type": "number",
          "min": 0,
          "max": 100,
          "step": 5,
          "decimals": 0,
          "default": 55
        },
        {
          "key": "maxAttempts",
          "label": "同一件事最多追几次",
          "path": "maxAttempts",
          "type": "number",
          "min": 1,
          "max": 2,
          "step": 1,
          "decimals": 0,
          "default": 2
        }
      ]
    },
    {
      "title": "自发开口（没有悬着的事也能找你）",
      "hint": "三个门槛都过了才开口：你安静够久、距上次自发够久、最主导的那维情绪到线。造出来的念头一样要过静音 / 深夜 / 配额 / 冷却，一条都绕不过。",
      "fields": [
        {
          "key": "freeTalkEnabled",
          "label": "启用自发开口（关掉就退回「只在你走了之后才追」）",
          "path": "freeTalkEnabled",
          "type": "bool",
          "default": true
        },
        {
          "key": "freeTalkSilenceMin",
          "label": "你在 QQ 安静多久她才自己找话（分钟）",
          "path": "freeTalkSilenceMin",
          "type": "number",
          "min": 1,
          "max": 600,
          "step": 1,
          "decimals": 0,
          "default": 15
        },
        {
          "key": "freeTalkGapMin",
          "label": "两次自发之间至少隔（分钟）",
          "path": "freeTalkGapMin",
          "type": "number",
          "min": 1,
          "max": 1440,
          "step": 5,
          "decimals": 0,
          "default": 45
        },
        {
          "key": "freeTalkMoodPercent",
          "label": "情绪到多少才自发（%）",
          "path": "freeTalkMoodPercent",
          "type": "number",
          "min": 0,
          "max": 100,
          "step": 5,
          "decimals": 0,
          "default": 45
        },
        {
          "key": "goodnightSilenceMin",
          "label": "说完晚安后多久不再找你（分钟，0 不禁）",
          "path": "goodnightSilenceMin",
          "type": "number",
          "min": 10,
          "max": 1440,
          "step": 10,
          "decimals": 0,
          "default": 600
        },
        {
          "key": "qzoneReadMissingPercent",
          "label": "「想他」到 % 才去翻他的说说（100 = 关掉）",
          "path": "qzoneReadMissingPercent",
          "type": "number",
          "min": 0,
          "max": 100,
          "step": 5,
          "decimals": 0,
          "default": 35
        }
      ]
    },
    {
      "title": "时段问候（早上 / 中午 / 晚上）",
      "hint": "到点了才可能问一句好，但先掷骰子再决定 —— 不会每天都问。它不占说话额度，静音 / 深夜 / 「别发了」 / 说完晚安 照样拦得住。",
      "fields": [
        {
          "key": "greetingEnabled",
          "label": "启用时段问候",
          "path": "greetingEnabled",
          "type": "bool",
          "default": true
        },
        {
          "key": "greetingChancePercent",
          "label": "每个窗口掷中的概率（%）",
          "path": "greetingChancePercent",
          "type": "number",
          "min": 0,
          "max": 100,
          "step": 5,
          "decimals": 0,
          "default": 35
        },
        {
          "key": "greetingWindows",
          "label": "问候窗口（本地时间，逗号分隔）",
          "path": "greetingWindows",
          "type": "text",
          "placeholder": "例如 07:00-09:00, 11:30-13:00"
        }
      ]
    },
    {
      "title": "情绪驱动（她为什么非要找你）",
      "hint": "她的情绪不只给自己看：写进系统提示词会影响说话语气；情绪上来了还能突破额度主动开口。",
      "fields": [
        {
          "key": "moodInjection",
          "label": "把当前情绪写进系统提示词（她自己知道自己什么心情）",
          "path": "moodInjection",
          "type": "bool",
          "default": true
        },
        {
          "key": "emotionBypassQuota",
          "label": "情绪上来了可以突破每小时/每天额度（深夜和「别发了」仍然守）",
          "path": "emotionBypassQuota",
          "type": "bool",
          "default": true
        },
        {
          "key": "emotionBypassMaster",
          "label": "连总开关关着也照发（危险：你关了她还会找你）",
          "path": "emotionBypassMaster",
          "type": "bool",
          "default": false
        },
        {
          "key": "memeChancePercent",
          "label": "主动开口时先甩一张表情的概率（%）",
          "path": "memeChancePercent",
          "type": "number",
          "min": 0,
          "max": 100,
          "step": 5,
          "decimals": 0,
          "default": 40
        }
      ]
    },
    {
      "title": "时段",
      "hint": "格式 03:00-06:00，多个用逗号分隔。留空 = 不限制。",
      "fields": [
        {
          "key": "quietHours",
          "label": "完全禁言时段",
          "path": "quietHours",
          "type": "text",
          "placeholder": "例如 01:00-07:00"
        },
        {
          "key": "deepNightHours",
          "label": "深夜只放睡觉类",
          "path": "deepNightHours",
          "type": "text",
          "placeholder": "例如 03:00-06:00"
        }
      ]
    },
    {
      "title": "其他",
      "hint": "",
      "fields": [
        {
          "key": "includeRecall",
          "label": "开口时带上记忆召回（以前聊过的事）",
          "path": "includeRecall",
          "type": "bool",
          "default": false
        },
        {
          "key": "moodSnapshotIntervalMin",
          "label": "情绪快照最短多久写一次（分钟）",
          "path": "moodSnapshotIntervalMin",
          "type": "number",
          "min": 1,
          "max": 1440,
          "step": 1,
          "decimals": 0,
          "default": 5
        },
        {
          "key": "tickMs",
          "label": "心跳间隔（毫秒）",
          "path": "tickMs",
          "type": "number",
          "min": 10000,
          "max": 600000,
          "step": 1000,
          "decimals": 0,
          "default": 60000
        },
        {
          "key": "staleMin",
          "label": "念头多久没投就作废（分钟）",
          "path": "staleMin",
          "type": "number",
          "min": 5,
          "max": 600,
          "step": 5,
          "decimals": 0,
          "default": 30
        },
        {
          "key": "dataDir",
          "label": "数据目录",
          "path": "dataDir",
          "type": "text",
          "placeholder": "留空 = 默认"
        }
      ]
    }
  ];
