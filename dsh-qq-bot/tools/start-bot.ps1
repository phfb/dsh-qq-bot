<#
  start-bot.ps1 —— 一键把 dsh-qq-bot 拉起来（通用版）

  顺序（少一步都不通）：
    1. QQ 客户端在跑（要你自己先登录 BOT 号，脚本没法替你扫码）
    2. SnowLuma 起来（OneBot 协议端，QQ 消息从这过）
    3. 等 OneBot WS 端口开始监听
    4. 问 get_login_info：号在线没有、挂的是不是 selfId 那个号
    5. DSH 起来（qq-bot 插件随宿主加载）
    6. 跑一遍链路自检，把结论打出来

  已经在跑的进程不会重复启动。所有路径来自 check-bot.ps1 的配置解析
  （插件 config.json → tools\bot-config.json → 自动探测），不写死任何路径。

  用法：
    start-bot.ps1              # 全部拉起来 + 自检
    start-bot.ps1 -NoDsh       # 只拉 SnowLuma（DSH 自己已经开着）
    start-bot.ps1 -NoCheck     # 不跑自检
    start-bot.ps1 -Wait        # 结束前停住，按回车才关窗口（双击 .cmd 时用）
#>

param(
  [switch]$NoDsh,
  [switch]$NoCheck,
  [switch]$Wait
)

$ErrorActionPreference = 'Continue'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $ScriptDir 'check-bot.ps1')

function Write-Step($msg) { Write-Host "`n$msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "  [OK]   $msg" -ForegroundColor Green }
function Write-Bad($msg) { Write-Host "  [X]    $msg" -ForegroundColor Red }
function Write-Info($msg) { Write-Host "  ...    $msg" -ForegroundColor DarkGray }
function Write-Warn2($msg) { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }

function Wait-Until {
  param([scriptblock]$Condition, [int]$TimeoutSec = 60, [string]$TickMessage = '')
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $n = 0
  while ((Get-Date) -lt $deadline) {
    if (& $Condition) { return $true }
    $n++
    if ($TickMessage -and ($n % 6 -eq 0)) { Write-Host "         $TickMessage" -ForegroundColor DarkGray }
    Start-Sleep -Milliseconds 800
  }
  return $false
}

function Exit-WithWait {
  param([int]$Code = 0)
  if ($Wait) { Read-Host '按回车关闭' | Out-Null }
  exit $Code
}

# 起 SnowLuma：优先 launcher.bat（它自己会处理 node 版本 / 工作目录），
# 没有 launcher 就 node.exe + index.mjs。
# 一律走 Start-HiddenProcess —— launcher.bat 用 Start-Process -WindowStyle Hidden 是藏不住的，
# 那个 cmd 黑框会一直挂在任务栏上。
function Start-SnowLuma {
  param($Config, [switch]$AsObject)
  if ($Config.SnowLumaLauncher -and (Test-Path -LiteralPath $Config.SnowLumaLauncher -PathType Leaf)) {
    Start-HiddenProcess -FilePath $Config.SnowLumaLauncher -WorkingDirectory $Config.SnowLumaDir | Out-Null
    return 'launcher.bat（静默）'
  }
  if (-not $Config.SnowLumaExe -or -not $Config.SnowLumaScript) { return $null }
  if (-not (Test-Path -LiteralPath $Config.SnowLumaExe -PathType Leaf)) { return $null }
  if (-not (Test-Path -LiteralPath $Config.SnowLumaScript -PathType Leaf)) { return $null }
  Start-HiddenProcess -FilePath $Config.SnowLumaExe -ArgumentList @($Config.SnowLumaScript) `
    -WorkingDirectory $Config.SnowLumaDir | Out-Null
  return "$($Config.SnowLumaExe) $($Config.SnowLumaScript)（静默）"
}

Write-Host '========================================' -ForegroundColor DarkCyan
Write-Host '   dsh-qq-bot 启动器' -ForegroundColor White
Write-Host '========================================' -ForegroundColor DarkCyan

$cfg = Resolve-BotConfig

Write-Host ("        配置文件：{0}" -f $(if ($cfg.PluginConfigFile) { $cfg.PluginConfigFile }
                                      elseif ($cfg.ToolsConfigUsed) { $cfg.ToolsConfigFile }
                                      else { '(没有，全靠自动探测)' })) -ForegroundColor DarkGray
Write-Host ("        数据目录：{0}" -f $cfg.DataDir) -ForegroundColor DarkGray
Write-Host ("        SnowLuma：{0}" -f $(if ($cfg.SnowLumaDir) { $cfg.SnowLumaDir } else { '(没探测到)' })) -ForegroundColor DarkGray
Write-Host ("        DSH     ：{0}" -f $(if ($cfg.DshExe) { $cfg.DshExe } else { '(没探测到)' })) -ForegroundColor DarkGray
Write-Host ("        BOT  号 ：{0}" -f $(if ($cfg.SelfId) { $cfg.SelfId } else { '(没设置 selfId)' })) -ForegroundColor DarkGray
foreach ($n in @($cfg.Notes)) { Write-Host ("        · {0}" -f $n) -ForegroundColor DarkGray }
if ($cfg.Missing -and $cfg.Missing.Count -gt 0) {
  Write-Host ''
  foreach ($m in @($cfg.Missing)) { Write-Warn2 $m }
  Write-Info '填好 tools\bot-config.json（照 bot-config.example.json 抄）再跑一次。'
}

if (-not $cfg.SnowLumaDir -and -not (Test-Path -LiteralPath $cfg.SnowLumaExe -PathType Leaf)) {
  Write-Bad '没有任何可用的 SnowLuma 路径，没法启动。'
  Write-Info '到 tools\bot-config.json 里填 snowlumaDir，或者把 SnowLuma 解压到常见位置。'
  Exit-WithWait -Code 1
}

# ── 阶段 1：QQ 客户端 ─────────────────────────────────────────────────────
Write-Step '1/6  QQ 客户端'
$qqProcs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'QQ' })
if ($qqProcs.Count -eq 0) {
  Write-Bad 'QQ 没在运行。请先打开 QQ 并登录 BOT 号（这一步得你自己来，要扫码）'
  Write-Info '登录完再跑一次这个脚本就行。'
  Exit-WithWait -Code 1
}
Write-Ok "QQ 进程在（$($qqProcs.Count) 个），登录的是哪个号脚本看不见 —— 下一步用 get_login_info 验"

# ── 阶段 2：SnowLuma ─────────────────────────────────────────────────────
Write-Step '2/6  SnowLuma（OneBot 协议端）'
if (Test-PortListening -Port $cfg.WsPort) {
  $owner = Get-PortOwnerPid -Port $cfg.WsPort
  Write-Ok "$($cfg.WsPort) 端口已经在听（pid=$owner），不重复启动"
} else {
  Write-Info "启动 SnowLuma（$($cfg.SnowLumaDir)）"
  $how = Start-SnowLuma -Config $cfg
  if (-not $how) {
    Write-Bad "找不到可用的启动方式：$($cfg.SnowLumaExe) $($cfg.SnowLumaScript)"
    Exit-WithWait -Code 1
  }
  Write-Info "用 $how 起的"
  if (Wait-Until -Condition { Test-PortListening -Port $cfg.WsPort } -TimeoutSec 90 -TickMessage '等 OneBot WS 端口...') {
    Write-Ok "$($cfg.WsPort) 端口起来了"
  } else {
    Write-Bad "90 秒内没等到 $($cfg.WsPort)。看 SnowLuma 目录下的 logs，或者 WebUI 有没有起来"
  }
}

# ── 阶段 3：BOT 号在线 + 挂对了没 ────────────────────────────────────────
Write-Step '3/6  BOT 号在线检查'
$login = $null
$ok = Wait-Until -Condition {
  $script:loginProbe = Get-LoginInfo -Config $cfg
  return ($null -ne $script:loginProbe)
} -TimeoutSec 45 -TickMessage '等 get_login_info 返回账号（SnowLuma 首次 hook 要 1-3 分钟）...'
if ($ok) { $login = $script:loginProbe }

if ($login) {
  $uin = [string](Get-Prop $login 'user_id' '')
  $nick = [string](Get-Prop $login 'nickname' '')
  Write-Ok "SnowLuma 挂的号：$uin（$nick）"
  if ([string]::IsNullOrWhiteSpace($cfg.SelfId)) {
    Write-Warn2 "selfId 还没填。建议填成 $uin，插件才能过滤自己发的消息、也能发现挂错号"
  } elseif ($uin -ne $cfg.SelfId) {
    Write-Bad "SnowLuma 实际挂的号是 $uin，和设置的 BOT 号 $($cfg.SelfId) 不一致（多开 QQ 时挂错）"
    Write-Info '去 QQ 里把别的号退掉，或者到 SnowLuma WebUI 里把该号卸下、只留给 BOT 号，再把 selfId 改成对上为止'
  } else {
    Write-Ok "挂的就是配置里的 BOT 号 $($cfg.SelfId)"
  }
} else {
  Write-Bad 'SnowLuma 拿不到登录信息 —— 多半是 QQ 里登录的不是 BOT 号、或者号还没被 SnowLuma 挂载'
  Write-Info '打开 SnowLuma WebUI，在进程列表里点那个号的「加载/挂载」，等 1-3 分钟，再跑一次'
}

# ── 阶段 4：DSH ──────────────────────────────────────────────────────────
if ($NoDsh) {
  Write-Step '4/6  DSH（按 -NoDsh 跳过）'
  Write-Info 'DSH 需要你自己开着，插件才会加载'
} else {
  Write-Step '4/6  DSH 宿主'
  $dsh = @()
  if ($cfg.DshExe) { $dsh = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $cfg.DshExe }) }
  if ($dsh.Count -eq 0) { $dsh = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '(?i)^dsh' }) }
  if ($dsh.Count -gt 0) {
    Write-Ok "已经在跑（$($dsh.Count) 个进程），不重复启动"
  } elseif ($cfg.DshExe -and (Test-Path -LiteralPath $cfg.DshExe -PathType Leaf)) {
    Write-Info "启动 $($cfg.DshExe)"
    Start-Process -FilePath $cfg.DshExe | Out-Null
    if (Wait-Until -Condition {
        @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '(?i)^dsh' }).Count -gt 0
      } -TimeoutSec 120 -TickMessage '等 DSH 起来（第一次开要久一点）...') {
      Write-Ok 'DSH 起来了'
    } else {
      Write-Bad '120 秒没等到 DSH 进程'
    }
  } else {
    Write-Bad "找不到 DSH 的可执行文件（配置里的 dshExe 是：$($cfg.DshExe)）"
    Write-Info '到 tools\bot-config.json 里填 dshExe，或者手动把 DSH 打开'
  }
}

# ── 阶段 5：等插件把 WS 连上 ─────────────────────────────────────────────
Write-Step '5/6  等插件连上 SnowLuma'
Write-Info '插件加载 + WS 重连要几秒（最多 45 秒）...'
$linked = Wait-Until -Condition {
  $log = Get-LogTail -Path $cfg.QqBotLog -Lines 80
  $up = Get-LastMatch -Lines $log -Pattern '已连上 OneBot WebSocket'
  $down = Get-LastMatch -Lines $log -Pattern 'OneBot 连接断开'
  $upTime = Get-LogLineTime -Line $up
  $downTime = Get-LogLineTime -Line $down
  return [bool]($upTime -and ((-not $downTime) -or ($upTime -ge $downTime)))
} -TimeoutSec 45 -TickMessage '还在等...'
if ($linked) { Write-Ok '插件的 WS 已连上' }
else { Write-Warn2 "没等到「已连上 OneBot WebSocket」。日志：$($cfg.QqBotLog)" }

# ── 阶段 6：链路自检 ─────────────────────────────────────────────────────
if ($NoCheck) {
  Write-Step '6/6  自检（按 -NoCheck 跳过）'
} else {
  Write-Step '6/6  链路自检'
  $status = Get-BotStatus -Force
  Write-Host ''
  Write-Host (Format-BotStatus -Status $status)

  $reportDir = $cfg.LogDir
  if (-not (Test-Path -LiteralPath $reportDir)) { New-Item -ItemType Directory -Path $reportDir -Force | Out-Null }
  $reportPath = Join-Path $reportDir ("startup-{0}.txt" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
  try { Format-BotStatus -Status $status | Out-File -FilePath $reportPath -Encoding UTF8 } catch { }

  Write-Host ''
  if ($status.AllGreen) {
    Write-Host '都通了。现在去 QQ 里给 BOT 号发一句，她会回。' -ForegroundColor Green
  } else {
    Write-Host '有环节没通，看上面 [FAIL] 那几行。' -ForegroundColor Yellow
  }
}

Exit-WithWait -Code 0
