<#
  bot-tray.ps1 —— dsh-qq-bot 状态托盘（通用版）

  右下角一个小圆点：绿 = 链路全通，黄 = 部分没通，红 = 关键环节断了。
  鼠标停上去看摘要，双击看完整报告，右键有常用操作。

  所有路径来自 check-bot.ps1 的配置解析（插件 config.json → tools\bot-config.json → 自动探测）；
  所有 PID / 端口都每次现查（Get-NetTCPConnection / Get-Process / get_login_info），
  不存任何 PID —— 重启之后 PID 全变，写死必然错。

  ── 为什么要拆线程（2026-10-25 改）────────────────────────────────────────
  自检本身要 2~5 秒：Get-NetTCPConnection 一次 300~1000 ms，Get-CimInstance 一次
  200~1300 ms，get_login_info 走 HTTP，Resolve-BotConfig 要探磁盘。
  以前这些东西全跑在 WinForms 的 UI 线程上、每 5 秒一轮 —— 消息循环几乎没有空闲，
  表现就是：鼠标划过图标没反应、划一下换个位置又不灵、右键要等半天才弹。

  现在自检整个搬到独立 runspace 的后台线程，UI 线程只干一件事：每 800 ms 看一眼
  有没有新结果，有就把几条现成的字符串贴到图标和菜单上（微秒级，不碰任何 IO）。
  另外托盘自己就是「托盘进程」，自检不必再扫一遍 CIM 全表去确认它存在。

  由 BOT-TRAY.vbs 拉起（WScript 启动，零窗口，连一闪的黑框都没有）。
#>

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not ('Win32.User32' -as [type])) {
  Add-Type -Namespace Win32 -Name User32 -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)]
public static extern bool DestroyIcon(IntPtr hIcon);
'@
}

$ErrorActionPreference = 'SilentlyContinue'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $ScriptDir 'check-bot.ps1')

# ── 单实例：重复双击不再开第二个图标 ──────────────────────────────────────
$mutex = New-Object System.Threading.Mutex($false, 'Global\DshQqBotTray')
$hasLock = $false
try { $hasLock = $mutex.WaitOne(0) } catch { $hasLock = $false }
if (-not $hasLock) {
  # 这个进程是用隐藏窗口起的：弹 MessageBox 会变成一个看不见的窗口
  # 永远等人点，进程就卡在那儿了。所以第二个实例直接走人。
  exit 0
}

# ── 托盘自己的小日志（排查"图标不刷新"这种问题用）─────────────────────────
# 日志路径只解析一次：Write-TrayLog 会被状态变化回调，不能每次都去探磁盘。
$script:TrayLogPath = $null

function Write-TrayLog {
  param([string]$Message)
  try {
    if (-not $script:TrayLogPath) {
      $dir = $script:Cfg.LogDir
      if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      $script:TrayLogPath = Join-Path $dir 'tray.log'
    }
    Add-Content -LiteralPath $script:TrayLogPath -Encoding UTF8 -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message)
  } catch { }
}

<#
  NotifyIcon.Text 在 .NET Framework 里上限 63 个字符，超了会直接抛异常，
  而异常一抛整个刷新就中断（图标颜色也不更新），看起来就像"托盘死了"。
#>
$script:lastTrayText = ''
function Set-TrayText {
  param([string]$Text)
  if ($null -eq $Text) { $Text = '' }
  if ($Text.Length -gt 62) { $Text = $Text.Substring(0, 59) + '...' }
  if ($Text -eq $script:lastTrayText) { return }
  $script:lastTrayText = $Text
  $script:notify.Text = $Text
}

# ── 画图标 ────────────────────────────────────────────────────────────────
function New-StatusIcon {
  param([System.Drawing.Color]$Color)
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $solid = New-Object System.Drawing.SolidBrush($Color)
  $g.FillEllipse($solid, 3, 3, 26, 26)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(235, 255, 255, 255)), 2.0
  $g.DrawEllipse($pen, 4, 4, 24, 24)
  $solid.Dispose()
  $pen.Dispose()
  $g.Dispose()
  $handle = $bmp.GetHicon()
  $icon = [System.Drawing.Icon]::FromHandle($handle)
  $copy = $icon.Clone()
  [Win32.User32]::DestroyIcon($handle) | Out-Null
  $icon.Dispose()
  $bmp.Dispose()
  return $copy
}

$script:iconGreen = New-StatusIcon -Color ([System.Drawing.Color]::FromArgb(63, 185, 80))
$script:iconYellow = New-StatusIcon -Color ([System.Drawing.Color]::FromArgb(210, 153, 34))
$script:iconRed = New-StatusIcon -Color ([System.Drawing.Color]::FromArgb(248, 81, 73))

# ── 配置：只在启动时解析一次（约 250 ms），之后全部复用 ────────────────────
$script:Cfg = Resolve-BotConfig -Force

# ══════════════════════════════════════════════════════════════════════════
#  后台自检线程
#  UI 线程绝不调用 Get-BotStatus —— 那会直接卡住消息循环，鼠标就没反应了。
# ══════════════════════════════════════════════════════════════════════════
$script:Shared = [hashtable]::Synchronized(@{
    stop        = $false
    trigger     = $false
    intervalSec = 8
    seq         = 0
    state       = $null
    ScriptDir   = $ScriptDir
  })

$script:workerRs = [runspacefactory]::CreateRunspace()
$script:workerRs.ApartmentState = 'MTA'
$script:workerRs.ThreadOptions = 'ReuseThread'
$script:workerRs.Open()
$script:workerRs.SessionStateProxy.SetVariable('Shared', $script:Shared)

$script:workerScript = {
  param($Shared)
  $ErrorActionPreference = 'SilentlyContinue'
  . (Join-Path $Shared.ScriptDir 'check-bot.ps1')
  # 我自己就是托盘进程：别让自检再扫一遍 CIM 全表去找托盘（那是 0.2~1.3 秒）
  $script:TraySelfRunning = $true

  $round = 0
  while (-not $Shared.stop) {
    $at = (Get-Date).ToString('HH:mm:ss')
    try {
      # 每 6 轮（约 1 分钟）强制重扫一次配置：换了路径、换了号能自己跟上
      $st = Get-BotStatus -Force:($round % 6 -eq 0)

      $light = 'yellow'
      if ($st.AllGreen) { $light = 'green' }
      elseif ((-not $st.SnowLumaRunning) -or (-not $st.DshRunning) -or
              (-not $st.WsPortListening) -or (-not $st.QqOnline)) { $light = 'red' }

      $qqPart = if ($st.QqOnline) { "号 $($st.QqUin) 在线" } else { '号离线' }
      $dshPart = if ($st.DshRunning) { "DSH:$($st.DshWebPort)" } else { 'DSH 没开' }
      $linkPart = if ($st.OneBotLinkUp) { 'WS 已连' } else { 'WS 断开' }

      $menuQq = if ($st.QqOnline) { "挂的号：$($st.QqUin)（$($st.QqNick)）" } else { '挂的号：离线' }
      if ($st.SelfIdWarn) {
        $menuQq = "挂的号：$(if ($st.QqOnline) { $st.QqUin } else { '离线' })（和 selfId 不一致）"
      }
      $sid = if ($st.SessionId) { [string]$st.SessionId } else { '' }
      if ($sid.Length -gt 20) { $sid = $sid.Substring(0, 20) }

      $Shared.state = @{
        light       = $light
        trayText    = "dsh-qq-bot · $qqPart · $dshPart · $linkPart"
        menuQq      = $menuQq
        menuLink    = "OneBot 连接：$(if ($st.OneBotLinkUp) { '已连上' } else { '断开' })"
        menuSession = "当前对话：$(if ($sid) { $sid } else { '(还没建)' })"
        report      = (Format-BotStatus -Status $st)
        dshRunning  = [bool]$st.DshRunning
        dshPort     = [int]$st.DshWebPort
        dryRun      = [bool]$st.DryRun
        error       = ''
        at          = $at
      }
    } catch {
      $Shared.state = @{
        light       = 'red'
        trayText    = 'dsh-qq-bot · 自检出错'
        menuQq      = '挂的号：-'
        menuLink    = 'OneBot 连接：-'
        menuSession = '当前对话：-'
        report      = "自检本身出错了：$($_.Exception.Message)"
        dshRunning  = $false
        dshPort     = 0
        dryRun      = $false
        error       = $_.Exception.Message
        at          = $at
      }
    }
    $Shared.seq = [int]$Shared.seq + 1
    $round++
    $Shared.trigger = $false

    $deadline = [DateTime]::UtcNow.AddSeconds([int]$Shared.intervalSec)
    while ([DateTime]::UtcNow -lt $deadline -and -not $Shared.stop) {
      if ($Shared.trigger) { break }
      Start-Sleep -Milliseconds 250
    }
  }
}

$script:worker = [powershell]::Create()
$script:worker.Runspace = $script:workerRs
$null = $script:worker.AddScript($script:workerScript).AddArgument($script:Shared)
$script:workerHandle = $script:worker.BeginInvoke()

# ── 用后台结果刷新界面（只贴字符串，零 IO）─────────────────────────────────
$script:lastSeq = -1
$script:lastLight = ''
$script:lastReport = '正在自检，等 2~5 秒…'

function Apply-WorkerState {
  $s = $script:Shared.state
  if ($null -eq $s) { return }
  if ($script:lastSeq -eq [int]$script:Shared.seq) { return }
  $script:lastSeq = [int]$script:Shared.seq

  if ($s.light -ne $script:lastLight) {
    switch ($s.light) {
      'green' { $script:notify.Icon = $script:iconGreen }
      'yellow' { $script:notify.Icon = $script:iconYellow }
      'red' { $script:notify.Icon = $script:iconRed }
    }
    Write-TrayLog ("状态 {0} -> {1} | {2}（{3} 自检）" -f
      $(if ($script:lastLight) { $script:lastLight } else { 'start' }), $s.light, $s.trayText, $s.at)
    $script:lastLight = $s.light
  }

  Set-TrayText $s.trayText
  if ($s.menuQq) { $script:miQq.Text = $s.menuQq }
  if ($s.menuLink) { $script:miLink.Text = $s.menuLink }
  if ($s.menuSession) { $script:miSession.Text = $s.menuSession }
  if ($s.report) { $script:lastReport = $s.report }

  if ($null -ne $script:statusForm -and -not $script:statusForm.IsDisposed -and $script:statusForm.Visible) {
    Update-StatusWindow
  }
}

# ── 常用动作（全部读后台缓存 / 静默起进程，绝不阻塞 UI）────────────────────

function Invoke-OpenDsh {
  $s = $script:Shared.state
  if ($null -ne $s -and $s.dshRunning -and $s.dshPort -gt 0) {
    Start-Process "http://127.0.0.1:$($s.dshPort)"
  } else {
    [System.Windows.Forms.MessageBox]::Show('DSH 没在跑，先开 DSH。', 'dsh-qq-bot 托盘') | Out-Null
  }
}

function Invoke-OpenSnowLumaUi {
  Start-Process "http://127.0.0.1:$($script:Cfg.SnowLumaWebUiPort)"
}

function Invoke-OpenPath {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return }
  if (-not (Test-Path -LiteralPath $Path)) {
    try { New-Item -ItemType Directory -Path $Path -Force | Out-Null } catch { return }
  }
  Start-Process explorer.exe $Path
}

<#
  一键启动：完全静默地跑 start-bot.ps1，输出重定向进 data\logs\start-bot-manual.log。
  以前这里是 Start-Process powershell 不带 -WindowStyle Hidden —— 那就是第一个黑框的来源。
#>
function Invoke-RunStartScript {
  $logDir = $script:Cfg.LogDir
  try {
    if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
  } catch { }
  $logPath = Join-Path $logDir 'start-bot-manual.log'
  try {
    Add-Content -LiteralPath $logPath -Encoding UTF8 -Value ("`r`n=== {0} 托盘「一键启动」 ===" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
  } catch { }

  $inner = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' +
           (Join-Path $ScriptDir 'start-bot.ps1') + '" >> "' + $logPath + '" 2>&1'
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'cmd.exe'
  $psi.Arguments = '/c ' + $inner
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  try { [System.Diagnostics.Process]::Start($psi) | Out-Null } catch { }

  $script:Shared.trigger = $true
  Write-TrayLog "一键启动：输出在 $logPath"
}

<#
  重启 SnowLuma：现查现杀。
  认两个条件之一 —— 进程路径等于配置里的 snowlumaExe，或者命令行里带着 SnowLuma 目录。
  绝不按写死的 PID 杀，也绝不按进程名 "node" 全杀（那会连带杀掉别的 node）。
#>
function Invoke-RestartSnowLuma {
  $cfg = Resolve-BotConfig -Force
  $script:Cfg = $cfg
  $killed = 0
  $victims = @()

  $wsPid = Get-PortOwnerPid -Port $cfg.WsPort
  if ($wsPid -gt 0) {
    $p = Get-Process -Id $wsPid -ErrorAction SilentlyContinue
    if ($p -and $p.Path -eq $cfg.SnowLumaExe) { $victims += $wsPid }
  }
  if ($cfg.SnowLumaDir) {
    foreach ($proc in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '(?i)^(node|bun)\.exe$' })) {
      $cl = [string]$proc.CommandLine
      if ([string]::IsNullOrWhiteSpace($cl)) { continue }
      if ([int]$proc.ProcessId -eq $PID) { continue }
      if ($cl.ToLowerInvariant().Contains($cfg.SnowLumaDir.ToLowerInvariant())) {
        $victims += [int]$proc.ProcessId
      }
    }
  }
  $victims = @($victims | Sort-Object -Unique)

  foreach ($id in $victims) {
    if ($id -eq $PID) { continue }
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    $killed++
  }
  Start-Sleep -Seconds 2

  $started = $false
  if ($cfg.SnowLumaLauncher -and (Test-Path -LiteralPath $cfg.SnowLumaLauncher -PathType Leaf)) {
    Start-HiddenProcess -FilePath $cfg.SnowLumaLauncher -WorkingDirectory $cfg.SnowLumaDir | Out-Null
    $started = $true
  } elseif ($cfg.SnowLumaExe -and $cfg.SnowLumaScript -and
            (Test-Path -LiteralPath $cfg.SnowLumaExe -PathType Leaf) -and
            (Test-Path -LiteralPath $cfg.SnowLumaScript -PathType Leaf)) {
    Start-HiddenProcess -FilePath $cfg.SnowLumaExe -ArgumentList @($cfg.SnowLumaScript) `
      -WorkingDirectory $cfg.SnowLumaDir | Out-Null
    $started = $true
  }

  $msg = if ($started) {
    "已结束 $killed 个 SnowLuma 进程，正在静默重启。`n大约 1-3 分钟后再自检（首次 hook 要等 QQ 登录检测）。"
  } else {
    "已结束 $killed 个 SnowLuma 进程，但没找到可用的启动方式。`n到 tools\bot-config.json 里填 snowlumaDir / snowlumaExe / snowlumaScript。"
  }
  $script:Shared.trigger = $true
  [System.Windows.Forms.MessageBox]::Show($msg, 'dsh-qq-bot 托盘') | Out-Null
}

# ── 状态窗口（懒加载，只开一个）─────────────────────────────────────────────
$script:statusForm = $null
$script:statusBox = $null

function Show-StatusWindow {
  if ($null -ne $script:statusForm -and -not $script:statusForm.IsDisposed) {
    $script:statusForm.Show()
    $script:statusForm.Activate()
    Update-StatusWindow
    return
  }

  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'dsh-qq-bot 链路状态'
  $form.Size = New-Object System.Drawing.Size 760, 580
  $form.StartPosition = 'CenterScreen'
  $form.TopMost = $true

  $box = New-Object System.Windows.Forms.TextBox
  $box.Multiline = $true
  $box.ReadOnly = $true
  $box.ScrollBars = 'Vertical'
  $box.Dock = 'Fill'
  $box.Font = New-Object System.Drawing.Font 'Consolas', 10
  $box.BackColor = [System.Drawing.Color]::FromArgb(30, 30, 30)
  $box.ForeColor = [System.Drawing.Color]::FromArgb(220, 220, 220)
  $box.BorderStyle = 'None'

  $panel = New-Object System.Windows.Forms.FlowLayoutPanel
  $panel.Dock = 'Bottom'
  $panel.Height = 44
  $panel.FlowDirection = 'LeftToRight'
  $panel.Padding = New-Object System.Windows.Forms.Padding 8, 7, 8, 7
  $panel.BackColor = [System.Drawing.Color]::FromArgb(45, 45, 45)

  $btnRefresh = New-Object System.Windows.Forms.Button
  $btnRefresh.Text = '立即自检'
  $btnRefresh.Width = 96
  # 只打一个"现在就跑"的标记给后台线程，UI 立刻返回 —— 不在这里跑自检
  $btnRefresh.Add_Click({
      $script:Shared.trigger = $true
      if ($null -ne $script:statusBox) {
        $script:statusBox.Text = $script:lastReport + "`r`n`r`n（正在重新自检，2~5 秒后刷新…）"
      }
    })

  $btnCopy = New-Object System.Windows.Forms.Button
  $btnCopy.Text = '复制报告'
  $btnCopy.Width = 96
  $btnCopy.Add_Click({
      if ($null -ne $script:statusBox) {
        [System.Windows.Forms.Clipboard]::SetText($script:statusBox.Text)
      }
    })

  $btnLogs = New-Object System.Windows.Forms.Button
  $btnLogs.Text = '打开日志目录'
  $btnLogs.Width = 110
  $btnLogs.Add_Click({ Invoke-OpenPath $script:Cfg.LogDir })

  $btnStart = New-Object System.Windows.Forms.Button
  $btnStart.Text = '一键启动'
  $btnStart.Width = 96
  $btnStart.Add_Click({ Invoke-RunStartScript })

  $panel.Controls.AddRange(@($btnRefresh, $btnCopy, $btnLogs, $btnStart))
  $form.Controls.Add($box)
  $form.Controls.Add($panel)

  $script:statusForm = $form
  $script:statusBox = $box
  Update-StatusWindow
  $form.Show()
}

# 状态窗口只贴后台已经算好的报告，不自己跑自检 —— 否则点开窗口那一下又卡一次
function Update-StatusWindow {
  if ($null -eq $script:statusBox -or $script:statusBox.IsDisposed) { return }
  if ($script:lastReport) { $script:statusBox.Text = $script:lastReport }
}

# ── 托盘本体 ──────────────────────────────────────────────────────────────
$script:notify = New-Object System.Windows.Forms.NotifyIcon
$script:notify.Icon = $script:iconRed
$script:notify.Text = 'dsh-qq-bot · 正在自检...'
$script:notify.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miHeader = $menu.Items.Add('dsh-qq-bot 链路')
$miHeader.Enabled = $false
$script:miQq = $menu.Items.Add('挂的号：-')
$script:miQq.Enabled = $false
$script:miLink = $menu.Items.Add('OneBot 连接：-')
$miLink.Enabled = $false
$script:miSession = $menu.Items.Add('当前对话：-')
$miSession.Enabled = $false

$null = $menu.Items.Add('-')

$miStatus = $menu.Items.Add('查看完整状态')
$miStatus.Add_Click({ Show-StatusWindow })

$miDsh = $menu.Items.Add('打开 DSH 界面')
$miDsh.Add_Click({ Invoke-OpenDsh })

$miSnow = $menu.Items.Add('打开 SnowLuma 控制台')
$miSnow.Add_Click({ Invoke-OpenSnowLumaUi })

$miLogs = $menu.Items.Add('打开日志目录')
$miLogs.Add_Click({ Invoke-OpenPath $script:Cfg.LogDir })

$miData = $menu.Items.Add('打开数据目录')
$miData.Add_Click({ Invoke-OpenPath $script:Cfg.DataDir })

$miMemes = $menu.Items.Add('打开表情包目录')
$miMemes.Add_Click({ Invoke-OpenPath $script:Cfg.MemesDir })

$null = $menu.Items.Add('-')

$miStart = $menu.Items.Add('一键启动（启动器）')
$miStart.Add_Click({ Invoke-RunStartScript })

$miRestartSnow = $menu.Items.Add('重启 SnowLuma')
$miRestartSnow.Add_Click({ Invoke-RestartSnowLuma })

$miRedetect = $menu.Items.Add('重新探测配置')
$miRedetect.Add_Click({
    $cfg = Resolve-BotConfig -Force
    $script:Cfg = $cfg
    $script:Shared.trigger = $true
    Write-TrayLog ("重新探测：snow={0} dsh={1} onebot={2} data={3}" -f $cfg.SnowLumaDir, $cfg.DshExe, $cfg.OneBotConfigFile, $cfg.DataDir)
    [System.Windows.Forms.MessageBox]::Show(
      "SnowLuma：$($cfg.SnowLumaDir)`nDSH：$($cfg.DshExe)`nOneBot 配置：$($cfg.OneBotConfigFile)`n数据目录：$($cfg.DataDir)",
      'dsh-qq-bot 托盘') | Out-Null
  })

$null = $menu.Items.Add('-')

$miQuit = $menu.Items.Add('退出托盘')
$miQuit.Add_Click({
    $script:uiTimer.Stop()
    $script:Shared.stop = $true
    try { $script:worker.Dispose() } catch { }
    try { $script:workerRs.Close(); $script:workerRs.Dispose() } catch { }
    try { $script:notify.Visible = $false; $script:notify.Dispose() } catch { }
    [System.Windows.Forms.Application]::Exit()
  })

$script:notify.ContextMenuStrip = $menu
$script:notify.Add_DoubleClick({ Show-StatusWindow })

# Windows 11 默认把新托盘图标塞进溢出区（那个 ^），不弹一下根本不知道有这东西。
$script:notify.ShowBalloonTip(6000, 'dsh-qq-bot 托盘已启动',
  '绿=链路全通，黄=部分不通，红=断了。没看到图标就点任务栏的 ^ 展开，右键把它固定到任务栏。双击看完整状态。',
  [System.Windows.Forms.ToolTipIcon]::Info)

# UI 计时器只做一件事：把后台算好的结果贴上去。800 ms 一次，开销可以忽略。
$script:uiTimer = New-Object System.Windows.Forms.Timer
$script:uiTimer.Interval = 800
$script:uiTimer.Add_Tick({ Apply-WorkerState })
$script:uiTimer.Start()

[System.Windows.Forms.Application]::Run()

# 退出时收尾
try { $script:Shared.stop = $true } catch { }
try { $script:uiTimer.Stop() } catch { }
try { $script:worker.Dispose() } catch { }
try { $script:workerRs.Close(); $script:workerRs.Dispose() } catch { }
try { $script:notify.Visible = $false; $script:notify.Dispose() } catch { }
try { $mutex.ReleaseMutex() } catch { }
