<#
  bot-tray.ps1 —— dsh-qq-bot 状态托盘（通用版）

  右下角一个小圆点：绿 = 链路全通，黄 = 部分没通，红 = 关键环节断了。
  鼠标停上去看摘要，双击看完整报告，右键有常用操作。

  所有路径来自 check-bot.ps1 的配置解析（插件 config.json → tools\bot-config.json → 自动探测）；
  所有 PID / 端口都每次现查（Get-NetTCPConnection / Get-Process / get_login_info），
  不存任何 PID —— 重启之后 PID 全变，写死必然错。

  由 bot-tray.cmd 拉起（隐藏控制台窗口）。
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
  # 这个进程是用 -WindowStyle Hidden 起的：弹 MessageBox 会变成一个看不见的窗口
  # 永远等人点，进程就卡在那儿了。所以第二个实例直接走人。
  exit 0
}

# ── 托盘自己的小日志（排查"图标不刷新"这种问题用）─────────────────────────
function Write-TrayLog {
  param([string]$Message)
  try {
    $cfg = Resolve-BotConfig
    $dir = $cfg.LogDir
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $path = Join-Path $dir 'tray.log'
    Add-Content -LiteralPath $path -Encoding UTF8 -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message)
  } catch { }
}

<#
  NotifyIcon.Text 在 .NET Framework 里上限 63 个字符，超了会直接抛异常，
  而异常一抛整个刷新就中断（图标颜色也不更新），看起来就像"托盘死了"。
#>
function Set-TrayText {
  param([string]$Text)
  if ($null -eq $Text) { $Text = '' }
  if ($Text.Length -gt 62) { $Text = $Text.Substring(0, 59) + '...' }
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

# ── 常用动作（都现查状态，不依赖启动时那份快照）───────────────────────────

function Invoke-OpenDsh {
  $s = Get-BotStatus -Force
  if ($s.DshRunning -and $s.DshWebPort -gt 0) {
    Start-Process "http://127.0.0.1:$($s.DshWebPort)"
  } else {
    [System.Windows.Forms.MessageBox]::Show('DSH 没在跑，先开 DSH。', 'dsh-qq-bot 托盘') | Out-Null
  }
}

function Invoke-OpenSnowLumaUi {
  $cfg = Resolve-BotConfig
  Start-Process "http://127.0.0.1:$($cfg.SnowLumaWebUiPort)"
}

function Invoke-OpenPath {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return }
  if (-not (Test-Path -LiteralPath $Path)) {
    try { New-Item -ItemType Directory -Path $Path -Force | Out-Null } catch { return }
  }
  Start-Process explorer.exe $Path
}

function Invoke-RunStartScript {
  Start-Process powershell.exe -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', (Join-Path $ScriptDir 'start-bot.ps1'), '-Wait'
  )
  Start-Sleep -Milliseconds 800
}

<#
  重启 SnowLuma：现查现杀。
  认两个条件之一 —— 进程路径等于配置里的 snowlumaExe，或者命令行里带着 SnowLuma 目录。
  绝不按写死的 PID 杀，也绝不按进程名 "node" 全杀（那会连带杀掉别的 node）。
#>
function Invoke-RestartSnowLuma {
  $cfg = Resolve-BotConfig -Force
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
    Start-Process -FilePath $cfg.SnowLumaLauncher -WorkingDirectory $cfg.SnowLumaDir -WindowStyle Hidden | Out-Null
    $started = $true
  } elseif ($cfg.SnowLumaExe -and $cfg.SnowLumaScript -and
            (Test-Path -LiteralPath $cfg.SnowLumaExe -PathType Leaf) -and
            (Test-Path -LiteralPath $cfg.SnowLumaScript -PathType Leaf)) {
    Start-Process -FilePath $cfg.SnowLumaExe -ArgumentList $cfg.SnowLumaScript `
      -WorkingDirectory $cfg.SnowLumaDir -WindowStyle Hidden | Out-Null
    $started = $true
  }

  $msg = if ($started) {
    "已结束 $killed 个 SnowLuma 进程，正在重启。`n大约 1-3 分钟后再自检（首次 hook 要等 QQ 登录检测）。"
  } else {
    "已结束 $killed 个 SnowLuma 进程，但没找到可用的启动方式。`n到 tools\bot-config.json 里填 snowlumaDir / snowlumaExe / snowlumaScript。"
  }
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
  $btnRefresh.Add_Click({ Update-StatusWindow })

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
  $btnLogs.Add_Click({ Invoke-OpenPath (Resolve-BotConfig).LogDir })

  $btnStart = New-Object System.Windows.Forms.Button
  $btnStart.Text = '一键启动'
  $btnStart.Width = 96
  $btnStart.Add_Click({
      Invoke-RunStartScript
      Update-StatusWindow
    })

  $panel.Controls.AddRange(@($btnRefresh, $btnCopy, $btnLogs, $btnStart))
  $form.Controls.Add($box)
  $form.Controls.Add($panel)

  $script:statusForm = $form
  $script:statusBox = $box
  Update-StatusWindow
  $form.Show()
}

function Update-StatusWindow {
  if ($null -eq $script:statusBox -or $script:statusBox.IsDisposed) { return }
  try {
    $status = Get-BotStatus -Force
    $script:statusBox.Text = Format-BotStatus -Status $status
  } catch {
    $script:statusBox.Text = "自检本身出错了：$($_.Exception.Message)"
  }
}

# ── 刷新托盘 ──────────────────────────────────────────────────────────────
$script:lastLight = ''

function Get-Light($status) {
  if ($status.AllGreen) { return 'green' }
  # 任何一个底座没了就是红；只是某个环节没通算黄
  if (-not $status.SnowLumaRunning -or -not $status.DshRunning) { return 'red' }
  if (-not $status.WsPortListening -or -not $status.QqOnline) { return 'red' }
  return 'yellow'
}

function Update-Tray {
  try {
    $status = Get-BotStatus
    $light = Get-Light $status

    if ($light -ne $script:lastLight) {
      switch ($light) {
        'green' { $script:notify.Icon = $script:iconGreen }
        'yellow' { $script:notify.Icon = $script:iconYellow }
        'red' { $script:notify.Icon = $script:iconRed }
      }
      Write-TrayLog ("状态 {0} -> {1} | 在线={2} DSH={3} WS={4} pid_snow={5} pid_dsh={6}" -f
        $(if ($script:lastLight) { $script:lastLight } else { 'start' }), $light,
        $status.QqOnline, $status.DshRunning, $status.OneBotLinkUp,
        $status.SnowLumaPid, $status.DshPid)
      $script:lastLight = $light
    }

    $qqPart = if ($status.QqOnline) { "号 $($status.QqUin) 在线" } else { '号离线' }
    $dshPart = if ($status.DshRunning) { "DSH:$($status.DshWebPort)" } else { 'DSH 没开' }
    $linkPart = if ($status.OneBotLinkUp) { 'WS 已连' } else { 'WS 断开' }
    Set-TrayText "dsh-qq-bot · $qqPart · $dshPart · $linkPart"

    $script:miQq.Text = "挂的号：$(if ($status.QqOnline) { "$($status.QqUin)（$($status.QqNick)）" } else { '离线' })"
    if ($status.SelfIdWarn) { $script:miQq.Text = "挂的号：$(if ($status.QqOnline) { $status.QqUin } else { '离线' })（和 selfId 不一致）" }
    $script:miLink.Text = "OneBot 连接：$(if ($status.OneBotLinkUp) { '已连上' } else { '断开' })"
    $script:miSession.Text = "当前对话：$(if ($status.SessionId) { $status.SessionId.Substring(0, [Math]::Min(20, $status.SessionId.Length)) } else { '(还没建)' })"

    if ($null -ne $script:statusForm -and -not $script:statusForm.IsDisposed -and $script:statusForm.Visible) {
      Update-StatusWindow
    }
  } catch {
    Write-TrayLog "刷新失败：$($_.Exception.Message)"
    Set-TrayText "dsh-qq-bot · 自检出错"
  }
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
$miLogs.Add_Click({ Invoke-OpenPath (Resolve-BotConfig).LogDir })

$miData = $menu.Items.Add('打开数据目录')
$miData.Add_Click({ Invoke-OpenPath (Resolve-BotConfig).DataDir })

$miMemes = $menu.Items.Add('打开表情包目录')
$miMemes.Add_Click({ Invoke-OpenPath (Resolve-BotConfig).MemesDir })

$null = $menu.Items.Add('-')

$miAlive = $menu.Items.Add('活人感设置')
$miAlive.Add_Click({
    $aliveUi = Join-Path (Split-Path -Parent $ScriptDir) 'dsh-alive\tools\settings-alive.ps1'
    if (-not (Test-Path $aliveUi)) { $aliveUi = Join-Path $env:USERPROFILE '.dsh\settings-alive.ps1' }
    if (Test-Path $aliveUi) {
      Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$aliveUi)
    } else {
      [System.Windows.Forms.MessageBox]::Show('找不到 settings-alive.ps1', 'QQ Bot 托盘') | Out-Null
    }
  })
$miSettings = $menu.Items.Add('设置（图形化配置）')
$miSettings.Add_Click({
    Start-Process powershell.exe -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', (Join-Path $ScriptDir 'settings-ui.ps1')
    )
  })
$miStart = $menu.Items.Add('一键启动（启动器）')
$miStart.Add_Click({ Invoke-RunStartScript })

$miRestartSnow = $menu.Items.Add('重启 SnowLuma')
$miRestartSnow.Add_Click({ Invoke-RestartSnowLuma })

$miRedetect = $menu.Items.Add('重新探测配置')
$miRedetect.Add_Click({
    $cfg = Resolve-BotConfig -Force
    Write-TrayLog ("重新探测：snow={0} dsh={1} onebot={2} data={3}" -f $cfg.SnowLumaDir, $cfg.DshExe, $cfg.OneBotConfigFile, $cfg.DataDir)
    Update-Tray
    [System.Windows.Forms.MessageBox]::Show(
      "SnowLuma：$($cfg.SnowLumaDir)`nDSH：$($cfg.DshExe)`nOneBot 配置：$($cfg.OneBotConfigFile)`n数据目录：$($cfg.DataDir)",
      'dsh-qq-bot 托盘') | Out-Null
  })

$null = $menu.Items.Add('-')

$miQuit = $menu.Items.Add('退出托盘')
$miQuit.Add_Click({
    $script:timer.Stop()
    $script:notify.Visible = $false
    $script:notify.Dispose()
    [System.Windows.Forms.Application]::Exit()
  })

$script:notify.ContextMenuStrip = $menu
$script:notify.Add_DoubleClick({ Show-StatusWindow })

# Windows 11 默认把新托盘图标塞进溢出区（那个 ^），不弹一下根本不知道有这东西。
$script:notify.ShowBalloonTip(6000, 'dsh-qq-bot 托盘已启动',
  '绿=链路全通，黄=部分不通，红=断了。没看到图标就点任务栏的 ^ 展开，右键把它固定到任务栏。双击看完整状态。',
  [System.Windows.Forms.ToolTipIcon]::Info)

$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 5000
$script:timer.Add_Tick({ Update-Tray })
$script:timer.Start()

Update-Tray
[System.Windows.Forms.Application]::Run()

# 退出时收尾
try { $script:notify.Visible = $false; $script:notify.Dispose() } catch { }
try { $mutex.ReleaseMutex() } catch { }
