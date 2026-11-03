<#
  DSH 宿主守护 · hostguard.ps1
  ------------------------------------------------------------------
  三件套：QQ  ->  SnowLuma  ->  DSH
  - 开机（登录）后按顺序把它们拉起来
  - 常驻看门狗：谁没了就拉谁；连续拉不起来就放弃那一个，不再无脑重启
  - 定时整机重启：到点关机重启，重启后再按顺序拉起

  配置：读 <数据目录>\config.json 里的 hostGuard* 字段
        （设置 → 插件 → dsh-qq-bot 面板上改，改完下一轮自动生效）

  用法：
    .\hostguard.ps1 -Status      看一眼现在什么状态，不动手
    .\hostguard.ps1 -Once        检查一轮就退出（调试）
    .\hostguard.ps1 -DryRun      只检查+记日志，不真的拉进程、不真的重启
    .\hostguard.ps1 -Install     注册「登录时自动运行」计划任务
    .\hostguard.ps1 -Uninstall   删掉计划任务并还原开机项
#>
param(
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Status,
  [switch]$Once,
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'

# ── 路径：一律从脚本自己所在的位置推，不写死任何本机目录 ──────────────
#   假定目录形状：
#     <BotDir>\hostguard\hostguard.ps1   ← 本脚本
#     <BotDir>\data\config.json          ← dsh-qq-bot 的配置
#     <BotDir>\SnowLuma\                 ← 协议端
#   装到别处就用环境变量覆盖（见 Resolve-Targets），不覆盖也不会猜错。
$Root   = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
$BotDir = Split-Path -Parent $Root

$BotConfig   = if ($env:DSH_HOSTGUARD_CONFIG) { $env:DSH_HOSTGUARD_CONFIG } else { Join-Path $BotDir 'data\config.json' }
$LogPath     = Join-Path $Root 'hostguard.log'
$StatePath   = Join-Path $Root 'hostguard-state.json'
$PidFile     = Join-Path $Root 'hostguard.pid'
$TaskName    = 'DSH-HostGuard'

# 这几个由 Resolve-Targets 填 —— 要读完配置才知道 SnowLuma / DSH 装在哪
$QQExe       = ''
$SnowDir     = ''
$SnowLaunch  = ''
$SnowLogDir  = ''
$DshExe      = ''

# 出厂默认（面板上也会有一份同样的默认值）
$Defaults = @{
  enabled         = $false
  restartTimes    = ''
  retryLimit      = 5
  intervalSec     = 30
  readyTimeoutSec = 150
  restartDelaySec = 60
}

function Write-Log {
  param([string]$Level, [string]$Message)
  $line = '[{0}] {1,-5} {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
  try {
    $dir = Split-Path -Parent $LogPath
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
    # 日志超过 5MB 就砍掉前半
    if ((Test-Path $LogPath) -and ((Get-Item $LogPath).Length -gt 5MB)) {
      $keep = @(Get-Content $LogPath -Tail 3000 -Encoding UTF8)
      [System.IO.File]::WriteAllLines($LogPath, $keep, (New-Object System.Text.UTF8Encoding($true)))
    }
  } catch { }
  Write-Host $line
}

function Read-BotConfig {
  $cfg = @{}
  foreach ($k in $Defaults.Keys) { $cfg[$k] = $Defaults[$k] }
  if (-not (Test-Path $BotConfig)) { return $cfg }
  try {
    $raw = Get-Content -Path $BotConfig -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    Write-Log 'WARN' ('config.json 解析失败，用默认配置：' + $_.Exception.Message)
    return $cfg
  }
  if ($null -ne $raw.hostGuardEnabled)      { $cfg.enabled = [bool]$raw.hostGuardEnabled }
  if ($null -ne $raw.hostGuardRestartTimes) { $cfg.restartTimes = [string]$raw.hostGuardRestartTimes }
  if ($null -ne $raw.hostGuardRetryLimit) {
    $n = 0
    if ([int]::TryParse([string]$raw.hostGuardRetryLimit, [ref]$n) -and $n -ge 1) { $cfg.retryLimit = [Math]::Min($n, 50) }
  }
  if ($null -ne $raw.hostGuardIntervalSec) {
    $n = 0
    if ([int]::TryParse([string]$raw.hostGuardIntervalSec, [ref]$n) -and $n -ge 5) { $cfg.intervalSec = [Math]::Min($n, 3600) }
  }
  if ($null -ne $raw.hostGuardReadyTimeoutSec) {
    $n = 0
    if ([int]::TryParse([string]$raw.hostGuardReadyTimeoutSec, [ref]$n) -and $n -ge 20) { $cfg.readyTimeoutSec = [Math]::Min($n, 1800) }
  }
  if ($null -ne $raw.hostGuardRestartDelaySec) {
    $n = 0
    if ([int]::TryParse([string]$raw.hostGuardRestartDelaySec, [ref]$n) -and $n -ge 0) { $cfg.restartDelaySec = [Math]::Min($n, 3600) }
  }
  return $cfg
}

<#
  把 QQ / SnowLuma / DSH 三个位置定下来。

  顺序一律是「环境变量 → 配置 → 猜常见位置」，猜不到就留空 ——
  留空只影响那一个目标（日志里会写明找不到哪个），不会让整个守护罢工。
  覆盖用的环境变量：
    DSH_HOSTGUARD_QQ_EXE / DSH_HOSTGUARD_SNOWLUMA_DIR / DSH_HOSTGUARD_DSH_EXE
#>
function Resolve-Targets {
  # ── SnowLuma ──
  $snow = ''
  if ($env:DSH_HOSTGUARD_SNOWLUMA_DIR) { $snow = $env:DSH_HOSTGUARD_SNOWLUMA_DIR }
  if ($snow -eq '' -and (Test-Path $BotConfig)) {
    try {
      $raw = Get-Content -Path $BotConfig -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($raw.snowLumaDir -is [string] -and $raw.snowLumaDir.Trim() -ne '') { $snow = $raw.snowLumaDir.Trim() }
    } catch { }
  }
  if ($snow -eq '') { $snow = Join-Path $BotDir 'SnowLuma' }
  if (Test-Path $snow) {
    $script:SnowDir    = $snow
    $script:SnowLaunch = Join-Path $snow 'launcher.bat'
    $script:SnowLogDir = Join-Path $snow 'logs'
  }

  # ── QQ ──
  $qq = ''
  if ($env:DSH_HOSTGUARD_QQ_EXE -and (Test-Path $env:DSH_HOSTGUARD_QQ_EXE)) { $qq = $env:DSH_HOSTGUARD_QQ_EXE }
  if ($qq -eq '') {
    $pf86 = ${env:ProgramFiles(x86)}
    $cands = @(
      (Join-Path $env:ProgramFiles 'Tencent\QQNT\QQ.exe'),
      $(if ($pf86) { Join-Path $pf86 'Tencent\QQNT\QQ.exe' }),
      (Join-Path $env:LOCALAPPDATA 'Tencent\QQNT\QQ.exe')
    )
    foreach ($c in $cands) { if ($c -and (Test-Path $c)) { $qq = $c; break } }
  }
  if ($qq -eq '') {
    foreach ($k in @(
      'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\QQ.exe',
      'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\QQ.exe'
    )) {
      try {
        $v = (Get-ItemProperty -Path $k -ErrorAction Stop).'(default)'
        if ($v -and (Test-Path $v)) { $qq = $v; break }
      } catch { }
    }
  }
  $script:QQExe = $qq

  # ── DSH ──
  $dsh = ''
  if ($env:DSH_HOSTGUARD_DSH_EXE -and (Test-Path $env:DSH_HOSTGUARD_DSH_EXE)) { $dsh = $env:DSH_HOSTGUARD_DSH_EXE }
  if ($dsh -eq '') {
    $parent = Split-Path -Parent $BotDir
    foreach ($c in @(
      (Join-Path $parent 'DSH NEXT\DSH NEXT.exe'),
      (Join-Path $BotDir 'DSH NEXT\DSH NEXT.exe')
    )) {
      if (Test-Path $c) { $dsh = $c; break }
    }
  }
  if ($dsh -eq '') {
    # 最后一条路：它要是正在跑，直接问进程要路径
    $p = @(Get-Process -Name 'DSH NEXT' -ErrorAction SilentlyContinue) | Select-Object -First 1
    if ($null -ne $p) { try { $dsh = $p.Path } catch { } }
  }
  $script:DshExe = $dsh
}

function Read-State {
  $s = @{
    qq        = @{ fails = 0; lastStart = 0; givenUp = $false }
    snowluma  = @{ fails = 0; lastStart = 0; givenUp = $false }
    dsh       = @{ fails = 0; lastStart = 0; givenUp = $false }
    lastRestartKey = ''
    pid       = 0
    heartbeat = 0
  }
  if (-not (Test-Path $StatePath)) { return $s }
  try {
    $raw = Get-Content -Path $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($name in 'qq','snowluma','dsh') {
      if ($null -ne $raw.$name) {
        $s[$name].fails     = [int]$raw.$name.fails
        $s[$name].lastStart = [long]$raw.$name.lastStart
        $s[$name].givenUp   = [bool]$raw.$name.givenUp
      }
    }
    if ($null -ne $raw.lastRestartKey) { $s.lastRestartKey = [string]$raw.lastRestartKey }
    if ($null -ne $raw.pid)       { $s.pid       = [int]$raw.pid }
    if ($null -ne $raw.heartbeat) { $s.heartbeat = [long]$raw.heartbeat }
  } catch { }
  return $s
}

function Save-State {
  param($State)
  try {
    $json = $State | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($StatePath, $json, (New-Object System.Text.UTF8Encoding($true)))
  } catch {
    Write-Log 'WARN' ('状态写盘失败：' + $_.Exception.Message)
  }
}

# ── 进程探测 ────────────────────────────────────────────────────────────

function Get-QQRunning {
  try {
    $all = @(Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" -ErrorAction Stop)
  } catch { $all = @() }
  if ($all.Count -eq 0) { return $false }
  # 主进程 = 命令行里没有 --type= 的那个；读不到命令行就按「有进程就算」
  $main = @($all | Where-Object { $_.CommandLine -and ($_.CommandLine -notmatch '--type=') })
  if ($main.Count -gt 0) { return $true }
  $noCmd = @($all | Where-Object { -not $_.CommandLine })
  return ($noCmd.Count -gt 0)
}

function Get-SnowLumaRunning {
  try {
    $all = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)
  } catch { return $false }
  foreach ($p in $all) {
    if ($p.CommandLine -and ($p.CommandLine -match 'SnowLuma[\\/]+index\.mjs')) { return $true }
  }
  return $false
}

function Get-DshRunning {
  $p = @(Get-Process -Name 'DSH NEXT' -ErrorAction SilentlyContinue)
  return ($p.Count -gt 0)
}

function Get-SnowLumaLoggedIn {
  # 最近的日志里出现过 login detected，说明 hook 挂上了号
  if (-not (Test-Path $SnowLogDir)) { return $false }
  $today = Join-Path $SnowLogDir ('snowluma-' + (Get-Date -Format 'yyyy-MM-dd') + '.log')
  if (-not (Test-Path $today)) { return $false }
  try {
    $tail = @(Get-Content $today -Tail 400 -Encoding UTF8 -ErrorAction Stop)
  } catch { return $false }
  foreach ($l in $tail) { if ($l -match 'login detected') { return $true } }
  return $false
}

# ── 拉起 ────────────────────────────────────────────────────────────────

function Start-QQ {
  if (-not (Test-Path $QQExe)) { Write-Log 'ERROR' ('找不到 QQ：' + $QQExe); return $false }
  if ($DryRun) { Write-Log 'DRYRUN' '本该拉起 QQ'; return $true }
  try {
    Start-Process -FilePath $QQExe -ArgumentList '/background' -ErrorAction Stop
    Write-Log 'INFO' '拉起 QQ（/background）'
    return $true
  } catch {
    Write-Log 'ERROR' ('拉起 QQ 失败：' + $_.Exception.Message)
    return $false
  }
}

function Start-SnowLuma {
  if (-not (Test-Path $SnowLaunch)) { Write-Log 'ERROR' ('找不到 launcher.bat：' + $SnowLaunch); return $false }
  if ($DryRun) { Write-Log 'DRYRUN' '本该拉起 SnowLuma'; return $true }
  try {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + $SnowLaunch + '"') -WindowStyle Hidden -ErrorAction Stop
    Write-Log 'INFO' '拉起 SnowLuma（launcher.bat）'
    return $true
  } catch {
    Write-Log 'ERROR' ('拉起 SnowLuma 失败：' + $_.Exception.Message)
    return $false
  }
}

function Start-Dsh {
  if (-not (Test-Path $DshExe)) { Write-Log 'ERROR' ('找不到 DSH：' + $DshExe); return $false }
  if ($DryRun) { Write-Log 'DRYRUN' '本该拉起 DSH'; return $true }
  try {
    Start-Process -FilePath $DshExe -ErrorAction Stop
    Write-Log 'INFO' '拉起 DSH'
    return $true
  } catch {
    Write-Log 'ERROR' ('拉起 DSH 失败：' + $_.Exception.Message)
    return $false
  }
}

# ── 一轮检查 ────────────────────────────────────────────────────────────

$script:Unhealthy = ''

function Test-One {
  param(
    [string]$Name,
    [string]$Label,
    [scriptblock]$Probe,
    [scriptblock]$Launcher,
    $State,
    $Cfg
  )

  $running = & $Probe
  if ($running) {
    if ($State[$Name].fails -ne 0 -or $State[$Name].givenUp) {
      Write-Log 'OK' ($Label + ' 已就位（失败计数清零）')
    }
    $State[$Name].fails     = 0
    $State[$Name].givenUp   = $false
    $State[$Name].lastStart = 0
    return $true
  }

  $script:Unhealthy = $script:Unhealthy + $Label + ' '

  if ($State[$Name].givenUp) { return $false }

  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $sinceStart = if ($State[$Name].lastStart -gt 0) { $now - $State[$Name].lastStart } else { [long]::MaxValue }

  # 刚拉起不久 -> 给它就绪时间，别急着判死
  if ($sinceStart -lt $Cfg.readyTimeoutSec) {
    return $false
  }

  if ($State[$Name].fails -ge $Cfg.retryLimit) {
    $State[$Name].givenUp = $true
    Write-Log 'ERROR' ($Label + ' 连续 ' + $Cfg.retryLimit + ' 次拉不起来，放弃这一个（不再尝试）')
    return $false
  }

  $State[$Name].fails = $State[$Name].fails + 1
  $State[$Name].lastStart = $now
  Write-Log 'WARN' ('{0} 不在，第 {1}/{2} 次尝试拉起' -f $Label, $State[$Name].fails, $Cfg.retryLimit)
  & $Launcher | Out-Null
  return $false
}

function Invoke-Round {
  param($Cfg, $State)

  $script:Unhealthy = ''

  # 顺序：QQ -> SnowLuma -> DSH。QQ 没到位就先只管 QQ，后面的等下一轮。
  $qqOk = Test-One -Name 'qq' -Label 'QQ' -Probe { Get-QQRunning } -Launcher { Start-QQ } -State $State -Cfg $Cfg
  if (-not $qqOk) { return }

  $snowOk = Test-One -Name 'snowluma' -Label 'SnowLuma' -Probe { Get-SnowLumaRunning } -Launcher { Start-SnowLuma } -State $State -Cfg $Cfg
  if (-not $snowOk) { return }

  Test-One -Name 'dsh' -Label 'DSH' -Probe { Get-DshRunning } -Launcher { Start-Dsh } -State $State -Cfg $Cfg | Out-Null
}

function Test-AllGivenUp {
  param($State)
  return ($State['qq'].givenUp -and $State['snowluma'].givenUp -and $State['dsh'].givenUp)
}

# ── 定时整机重启 ────────────────────────────────────────────────────────

function Get-RestartSlots {
  param([string]$Spec)
  $out = @()
  if ([string]::IsNullOrWhiteSpace($Spec)) { return $out }
  foreach ($part in ($Spec -split '[,;，；\s]+')) {
    $t = $part.Trim()
    if ($t -match '^([01]?\d|2[0-3]):([0-5]\d)$') {
      $out += ('{0:00}:{1:00}' -f [int]$Matches[1], [int]$Matches[2])
    }
  }
  return $out
}

function Invoke-ScheduledRestart {
  param($Cfg, $State)

  $slots = Get-RestartSlots -Spec $Cfg.restartTimes
  if ($slots.Count -eq 0) { return }

  $now = Get-Date
  $hm = $now.ToString('HH:mm')
  if ($slots -notcontains $hm) { return }

  $key = $now.ToString('yyyy-MM-dd') + ' ' + $hm
  if ($State.lastRestartKey -eq $key) { return }

  $State.lastRestartKey = $key
  Save-State $State

  $delay = [int]$Cfg.restartDelaySec
  $reason = 'DSH hostguard 定时重启'
  if ($DryRun) {
    Write-Log 'DRYRUN' ('本该重启整机（' + $hm + '，延迟 ' + $delay + ' 秒）')
    return
  }
  Write-Log 'WARN' ('到点 ' + $hm + '，' + $delay + ' 秒后重启整机')
  try {
    & shutdown.exe /r /t $delay /f /c $reason 2>&1 | Out-Null
    Write-Log 'INFO' ('重启指令已下（' + $delay + ' 秒后）。要取消：shutdown /a')
  } catch {
    Write-Log 'ERROR' ('下重启指令失败：' + $_.Exception.Message)
  }
}

# ── 状态展示 ────────────────────────────────────────────────────────────

function Show-Status {
  $cfg   = Read-BotConfig
  $state = Read-State
  $qq    = Get-QQRunning
  $snow  = Get-SnowLumaRunning
  $dsh   = Get-DshRunning

  Write-Host ''
  Write-Host '  DSH 宿主守护 · 当前状态' -ForegroundColor Cyan
  Write-Host '  --------------------------------------------------------'
  Write-Host ('  开关          : ' + $(if ($cfg.enabled) { '开' } else { '关' }))
  Write-Host ('  定时重启      : ' + $(if ([string]::IsNullOrWhiteSpace($cfg.restartTimes)) { '（未设置）' } else { $cfg.restartTimes }))
  Write-Host ('  检查间隔      : ' + $cfg.intervalSec + ' 秒')
  Write-Host ('  连续失败上限  : ' + $cfg.retryLimit + ' 次')
  Write-Host ''
  $fmt = { param($ok, $label, $st) '{0,-12}: {1,-8} 失败={2} 放弃={3}' -f $label, $(if ($ok) { '运行中' } else { '不在' }), $st.fails, $st.givenUp }
  Write-Host (& $fmt $qq   'QQ'       $state['qq'])
  Write-Host (& $fmt $snow 'SnowLuma' $state['snowluma'])
  Write-Host (& $fmt $dsh  'DSH'      $state['dsh'])
  Write-Host ('  SnowLuma 登录 : ' + $(if (Get-SnowLumaLoggedIn) { '已挂号' } else { '未见 login detected' }))
  Write-Host ''
  Write-Host '  三个目标的位置（自动推导，可用环境变量覆盖）：' -ForegroundColor DarkGray
  Write-Host ('    QQ        : ' + $(if ($QQExe) { $QQExe } else { '（没找到）' })) -ForegroundColor DarkGray
  Write-Host ('    SnowLuma  : ' + $(if ($SnowDir) { $SnowDir } else { '（没找到）' })) -ForegroundColor DarkGray
  Write-Host ('    DSH       : ' + $(if ($DshExe) { $DshExe } else { '（没找到）' })) -ForegroundColor DarkGray
  Write-Host ('  日志          : ' + $LogPath)
  Write-Host ''
}

# ── 计划任务 ────────────────────────────────────────────────────────────

function Install-Guard {
  $self = $PSCommandPath
  if (-not $self) { $self = Join-Path $Root 'hostguard.ps1' }
  $action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $self + '"')
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 2)
  $ok = $false
  try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
      -Settings $settings -Description 'DSH 宿主守护：QQ -> SnowLuma -> DSH' -Force -ErrorAction Stop | Out-Null
    Write-Log 'OK' ('计划任务已注册：' + $TaskName + '（登录时启动）')
    $ok = $true
  } catch {
    Write-Log 'WARN' ('计划任务注册被拒（' + $_.Exception.Message + '）—— 改用启动文件夹')
  }

  # 普通用户注册不了计划任务（本机就是），退回启动文件夹：登录后一样会跑
  if (-not $ok) {
    $startupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
    if (-not (Test-Path $startupDir)) { New-Item -ItemType Directory -Path $startupDir -Force | Out-Null }
    $vbsPath = Join-Path $startupDir 'DSH-HostGuard.vbs'
    $vbsLines = @(
      'Set sh = CreateObject("WScript.Shell")',
      ('sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""' + $self + '""", 0, False')
    )
    try {
      [System.IO.File]::WriteAllText($vbsPath, ($vbsLines -join "`r`n"), (New-Object System.Text.ASCIIEncoding))
      Write-Log 'OK' ('启动文件夹已放入：' + $vbsPath + '（登录时自动跑）')
      $ok = $true
    } catch {
      Write-Host ('写启动文件夹也失败了：' + $_.Exception.Message) -ForegroundColor Red
      return
    }
  }

  # 把 DSH 自己的开机项挪开，免得它和守护抢着启 DSH（那个脚本一上来就 Stop-Process）
  $startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
  $vbs = Join-Path $startup 'DSH-NEXT-Autostart.vbs'
  if (Test-Path $vbs) {
    $aside = Join-Path $Root 'disabled-DSH-NEXT-Autostart.vbs'
    Move-Item -Path $vbs -Destination $aside -Force -ErrorAction SilentlyContinue
    Write-Log 'INFO' ('已停用原来的 DSH 开机项（挪到 ' + $aside + '），改由守护统一拉起')
  }

  Write-Host ''
  Write-Host '装好了。' -ForegroundColor Green
  Write-Host ('  立即先跑一轮：powershell -File "' + $self + '" -Once')
  Write-Host ('  看状态      ：powershell -File "' + $self + '" -Status')
  Write-Host '  开关和定时重启都在「设置 → 插件 → dsh-qq-bot」里改'
  Write-Host ''
}

function Uninstall-Guard {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Log 'INFO' ('计划任务已删除：' + $TaskName)
  $startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
  $guardVbs = Join-Path $startup 'DSH-HostGuard.vbs'
  if (Test-Path $guardVbs) {
    Remove-Item -Path $guardVbs -Force -ErrorAction SilentlyContinue
    Write-Log 'INFO' '启动文件夹里的 DSH-HostGuard.vbs 已删除'
  }
  $aside = Join-Path $Root 'disabled-DSH-NEXT-Autostart.vbs'
  if (Test-Path $aside) {
    Move-Item -Path $aside -Destination (Join-Path $startup 'DSH-NEXT-Autostart.vbs') -Force -ErrorAction SilentlyContinue
    Write-Log 'INFO' '原来的 DSH 开机项已还原'
  }
  Write-Host '已卸载。' -ForegroundColor Yellow
}

# ── 入口 ────────────────────────────────────────────────────────────────

# 先把三个目标的位置定下来 —— 状态查询也要看这个结果
Resolve-Targets

if ($Install)   { Install-Guard;   return }
if ($Uninstall) { Uninstall-Guard; return }
if ($Status)    { Show-Status;     return }

Write-Log 'INFO' ('hostguard 启动（pid=' + $PID + '）')

# 单实例：只看 pid 文件里那个还在不在。
# 曾经用「命令行里含 hostguard.ps1」来认自己人 —— 那是坑：任何命令行里
# 提到这个路径的进程都会被算进去，包括正在执行清理的那条 powershell 自己。
if (Test-Path $PidFile) {
  $oldPid = 0
  $rawPid = ''
  try { $rawPid = (Get-Content -Path $PidFile -Raw -Encoding UTF8) } catch { }
  if ($rawPid -and [int]::TryParse($rawPid.Trim(), [ref]$oldPid) -and $oldPid -ne $PID -and $oldPid -gt 0) {
    if (@(Get-Process -Id $oldPid -ErrorAction SilentlyContinue).Count -gt 0) {
      Write-Log 'INFO' ('已经有一个在跑（pid=' + $oldPid + '），本次退出')
      return
    }
  }
}
try {
  [System.IO.File]::WriteAllText($PidFile, [string]$PID, (New-Object System.Text.UTF8Encoding($false)))
} catch {
  Write-Log 'WARN' ('pid 文件写不了：' + $_.Exception.Message)
}

$lastCfg = $null

while ($true) {
  $cfg   = Read-BotConfig
  $state = Read-State

  # 心跳：DSH 那边靠这个判断守护还活没活
  $state.pid = $PID
  $state.heartbeat = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

  if (-not $cfg.enabled) {
    if ($null -eq $lastCfg -or $lastCfg -ne $false) {
      Write-Log 'INFO' '开关是关的 —— 不检查、不拉起、不定时重启，只挂着等开关打开'
    }
    $lastCfg = $false
    Start-Sleep -Seconds 20
    continue
  }
  $lastCfg = $true

  try {
    Invoke-Round -Cfg $cfg -State $state
  } catch {
    Write-Log 'ERROR' ('检查轮次异常：' + $_.Exception.Message)
  }

  try {
    Invoke-ScheduledRestart -Cfg $cfg -State $state
  } catch {
    Write-Log 'ERROR' ('定时重启判定异常：' + $_.Exception.Message)
  }

  Save-State $state

  if (Test-AllGivenUp -State $state) {
    Write-Log 'ERROR' '三个都连续拉不起来，守护放弃运行（进程退出）。处理完手动重开。'
    break
  }

  if ($Once) { break }

  Start-Sleep -Seconds ($cfg.intervalSec)
}

Write-Log 'INFO' 'hostguard 退出'

# 只删自己那份，别误删后来者的
try {
  if (Test-Path $PidFile) {
    $still = (Get-Content -Path $PidFile -Raw -Encoding UTF8)
    if ($still -and $still.Trim() -eq [string]$PID) { Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue }
  }
} catch { }