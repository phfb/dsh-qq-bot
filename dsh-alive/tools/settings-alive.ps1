<#
  settings-alive.ps1 —— dsh-alive（活人感）的图形化设置

  和 dsh-qq-bot 的 settings-ui.ps1 同一套做法：独立窗口，改完写 <dataDir>\alive-config.json，
  插件监听到文件变化立刻热应用。

  用法：双击 settings-alive.cmd
#>

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$ErrorActionPreference = 'SilentlyContinue'
$ScriptDir = Split-Path -Parent $PSCommandPath

function Read-JsonFile($path) {
  if (-not (Test-Path $path)) { return $null }
  try { return Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

# dataDir：优先 bot-config.json，其次 ~/.dsh-qq-bot
$botCfg = Read-JsonFile (Join-Path $ScriptDir 'bot-config.json')
$dataDir = $null
if ($botCfg -and $botCfg.dataDir) { $dataDir = $botCfg.dataDir }
if (-not $dataDir) { $dataDir = Join-Path $env:USERPROFILE '.dsh-qq-bot' }
$configPath = Join-Path $dataDir 'alive-config.json'
$statePath = Join-Path $dataDir 'alive-state.json'

function ConvertTo-Hashtable($obj) {
  if ($null -eq $obj) { return $null }
  if ($obj -is [System.Management.Automation.PSCustomObject]) {
    $h = @{}
    foreach ($p in $obj.PSObject.Properties) { $h[$p.Name] = ConvertTo-Hashtable $p.Value }
    return $h
  }
  if ($obj -is [System.Collections.IEnumerable] -and $obj -isnot [string]) {
    $list = @()
    foreach ($item in $obj) { $list += , (ConvertTo-Hashtable $item) }
    return $list
  }
  return $obj
}

$cfg = ConvertTo-Hashtable (Read-JsonFile $configPath)
if ($null -eq $cfg) { $cfg = @{} }

# 没有配置基线时，退一步读 alive-state.json 里的运行状态做展示
$stateRaw = Read-JsonFile $statePath
$runtimeNote = ''
if ($stateRaw -and $stateRaw.control) {
  $runtimeNote = "运行中：enabled=$($stateRaw.control.enabled)，静音到 $(if ($stateRaw.control.mutedUntil) { $stateRaw.control.mutedUntil } else { '（无）' })；今日已投 $(if ($stateRaw.quota) { $stateRaw.quota.dayCount } else { 0 }) 次"
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'DSH 活人感 · 设置'
$form.Size = New-Object System.Drawing.Size 660, 860
$form.StartPosition = 'CenterScreen'
$form.BackColor = [System.Drawing.Color]::FromArgb(30, 30, 30)
$form.ForeColor = [System.Drawing.Color]::FromArgb(225, 225, 225)
$form.Font = New-Object System.Drawing.Font 'Microsoft YaHei UI', 9

$panel = New-Object System.Windows.Forms.Panel
$panel.Dock = 'Fill'
$panel.AutoScroll = $true
$panel.Padding = New-Object System.Windows.Forms.Padding 12
$form.Controls.Add($panel)

$controls = @{}

function New-Group($title, $hint, $y) {
  $box = New-Object System.Windows.Forms.GroupBox
  $box.Text = " $title "
  $box.ForeColor = [System.Drawing.Color]::FromArgb(160, 200, 255)
  $box.Location = New-Object System.Drawing.Point 12, $y
  $box.Size = New-Object System.Drawing.Size 590, 10
  $panel.Controls.Add($box)
  $inner = 26
  if ($hint) {
    $lab = New-Object System.Windows.Forms.Label
    $lab.Text = $hint
    $lab.Size = New-Object System.Drawing.Size 550, 32
    $lab.Location = New-Object System.Drawing.Point 14, $inner
    $lab.ForeColor = [System.Drawing.Color]::FromArgb(150, 150, 150)
    $box.Controls.Add($lab)
    $inner += 34
  }
  return @{ Box = $box; Inner = $inner }
}

function Add-Text($box, [ref]$inner, $key, $label, $path, $placeholder, $isList) {
  $lab = New-Object System.Windows.Forms.Label
  $lab.Text = $label
  $lab.Size = New-Object System.Drawing.Size 190, 24
  $lab.Location = New-Object System.Drawing.Point 14, ($inner.Value + 3)
  $box.Controls.Add($lab)

  $tb = New-Object System.Windows.Forms.TextBox
  $tb.Location = New-Object System.Drawing.Point 210, $inner.Value
  $tb.Size = New-Object System.Drawing.Size 360, 24
  $tb.BackColor = [System.Drawing.Color]::FromArgb(45, 45, 45)
  $tb.ForeColor = [System.Drawing.Color]::FromArgb(230, 230, 230)
  $tb.BorderStyle = 'FixedSingle'
  if ($placeholder) { $tb.PlaceholderText = $placeholder }
  $val = $cfg[$path]
  if ($null -ne $val) {
    if ($val -is [array]) { $tb.Text = ($val -join ', ') } else { $tb.Text = [string]$val }
  }
  $box.Controls.Add($tb)
  $controls[$key] = @{ Kind = 'text'; Path = $path; Control = $tb; IsList = ($isList -eq $true) }
  $inner.Value += 32
}

function Add-Number($box, [ref]$inner, $key, $label, $path, $min, $max, $step, $decimals) {
  $lab = New-Object System.Windows.Forms.Label
  $lab.Text = $label
  $lab.Size = New-Object System.Drawing.Size 190, 24
  $lab.Location = New-Object System.Drawing.Point 14, ($inner.Value + 3)
  $box.Controls.Add($lab)

  $num = New-Object System.Windows.Forms.NumericUpDown
  $num.Location = New-Object System.Drawing.Point 210, $inner.Value
  $num.Size = New-Object System.Drawing.Size 120, 24
  $num.Minimum = $min
  $num.Maximum = $max
  $num.Increment = $step
  $num.DecimalPlaces = $decimals
  $num.BackColor = [System.Drawing.Color]::FromArgb(45, 45, 45)
  $num.ForeColor = [System.Drawing.Color]::FromArgb(230, 230, 230)
  $val = $cfg[$path]
  if ($null -ne $val) { try { $num.Value = [decimal]$val } catch { } }
  $box.Controls.Add($num)
  $controls[$key] = @{ Kind = 'number'; Path = $path; Control = $num; Decimals = $decimals }
  $inner.Value += 32
}

function Add-Bool($box, [ref]$inner, $key, $label, $path) {
  $cb = New-Object System.Windows.Forms.CheckBox
  $cb.Text = $label
  $cb.Location = New-Object System.Drawing.Point 14, $inner.Value
  $cb.Size = New-Object System.Drawing.Size 550, 24
  $cb.Checked = ($cfg[$path] -eq $true)
  $box.Controls.Add($cb)
  $controls[$key] = @{ Kind = 'bool'; Path = $path; Control = $cb }
  $inner.Value += 30
}

$tip = New-Object System.Windows.Forms.Label
$tip.Text = "改完点「保存」写入：`n$configPath`n插件监听到文件变化会立刻热应用。`n$runtimeNote"
$tip.Location = New-Object System.Drawing.Point 14, 10
$tip.Size = New-Object System.Drawing.Size 580, 86
$tip.ForeColor = [System.Drawing.Color]::FromArgb(170, 170, 170)
$panel.Controls.Add($tip)
$y = 104

$g = New-Group '开关与目标' '' $y
$inner = $g.Inner
Add-Bool $g.Box ([ref]$inner) 'enabled' '启用活人感（她会主动开口）' 'enabled'
Add-Bool $g.Box ([ref]$inner) 'dryRun' '只演练不发送（只在日志里看"她本来会说什么"）' 'dryRun'
Add-Text $g.Box ([ref]$inner) 'targetSession' '投递到哪个会话' 'targetSession' 'auto = 跟 qq-bot 的会话映射走'
Add-Text $g.Box ([ref]$inner) 'selfUin' '你自己的 QQ 号' 'selfUin' '填了才知道该找哪个会话'
$g.Box.Height = $inner + 8
$y += $g.Box.Height + 10

$g = New-Group '节奏（多久开口一次）' '静默不够久不开口；冷却不够长不开口；分数不够高不开口。' $y
$inner = $g.Inner
Add-Number $g.Box ([ref]$inner) 'minSilenceMin' '他安静多久才考虑开口（分钟）' 'minSilenceMin' 1 600 1 0
Add-Number $g.Box ([ref]$inner) 'cooldownMin' '两次主动之间至少隔（分钟）' 'cooldownMin' 1 720 5 0
Add-Number $g.Box ([ref]$inner) 'maxPerHour' '每小时最多几次' 'maxPerHour' 1 20 1 0
Add-Number $g.Box ([ref]$inner) 'maxPerDay' '每天最多几次' 'maxPerDay' 1 50 1 0
Add-Number $g.Box ([ref]$inner) 'threshold' '打分阈值（越高越少说话）' 'threshold' 0 100 5 0
Add-Number $g.Box ([ref]$inner) 'maxAttempts' '同一件事最多追几次' 'maxAttempts' 1 2 1 0
$g.Box.Height = $inner + 8
$y += $g.Box.Height + 10

$g = New-Group '时段' '格式 03:00-06:00，多个用逗号分隔。留空 = 不限制。' $y
$inner = $g.Inner
Add-Text $g.Box ([ref]$inner) 'quietHours' '完全禁言时段' 'quietHours' '例如 01:00-07:00' $true
Add-Text $g.Box ([ref]$inner) 'deepNightHours' '深夜只放睡觉类' 'deepNightHours' '例如 03:00-06:00' $true
$g.Box.Height = $inner + 8
$y += $g.Box.Height + 10

$g = New-Group '其他' '' $y
$inner = $g.Inner
Add-Bool $g.Box ([ref]$inner) 'includeRecall' '开口时带上记忆召回（以前聊过的事）' 'includeRecall'
Add-Number $g.Box ([ref]$inner) 'tickMs' '心跳间隔（毫秒）' 'tickMs' 10000 600000 1000 0
Add-Number $g.Box ([ref]$inner) 'staleMin' '念头多久没投就作废（分钟）' 'staleMin' 5 600 5 0
Add-Text $g.Box ([ref]$inner) 'dataDir' '数据目录' 'dataDir' '留空 = 默认'
$g.Box.Height = $inner + 8
$y += $g.Box.Height + 10

$bar = New-Object System.Windows.Forms.Panel
$bar.Dock = 'Top'
$bar.Height = 56
$bar.BackColor = [System.Drawing.Color]::FromArgb(40, 40, 40)
$form.Controls.Add($bar)

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point 14, 18
$status.Size = New-Object System.Drawing.Size 320, 24
$bar.Controls.Add($status)

function New-Btn($text, $x, $w, $primary) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.Location = New-Object System.Drawing.Point $x, 14
  $b.Size = New-Object System.Drawing.Size $w, 30
  $b.FlatStyle = 'Flat'
  if ($primary) {
    $b.BackColor = [System.Drawing.Color]::FromArgb(46, 90, 138)
    $b.ForeColor = [System.Drawing.Color]::White
  }
  $bar.Controls.Add($b)
  return $b
}

$btnSave = New-Btn '保存' 340 80 $true
$btnState = New-Btn '看运行状态' 426 110 $false
$btnClose = New-Btn '关闭' 542 60 $false

$btnState.Add_Click({
    if (-not (Test-Path $statePath)) { $status.Text = "还没有状态文件：$statePath"; return }
    Start-Process notepad.exe $statePath
  })

$btnClose.Add_Click({ $form.Close() })

$btnSave.Add_Click({
    foreach ($key in $controls.Keys) {
      $meta = $controls[$key]
      $c = $meta.Control
      $path = $meta.Path
      switch ($meta.Kind) {
        'text' {
          $text = $c.Text.Trim()
          if ($meta.IsList) {
            $arr = @()
            foreach ($part in ($text -split '[,，\s]+')) { if ($part -ne '') { $arr += $part } }
            $cfg[$path] = $arr
          } else {
            $cfg[$path] = $text
          }
        }
        'number' {
          if ($meta.Decimals -gt 0) { $cfg[$path] = [double]$c.Value } else { $cfg[$path] = [int]$c.Value }
        }
        'bool' { $cfg[$path] = [bool]$c.Checked }
      }
    }

    if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
    try {
      $json = $cfg | ConvertTo-Json -Depth 10
      # 无 BOM：带 BOM 的 JSON 会让插件的 JSON.parse 直接挂
      [System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
      $status.Text = "已保存 → $configPath"
      $status.ForeColor = [System.Drawing.Color]::FromArgb(63, 185, 80)
    } catch {
      $status.Text = "保存失败：$($_.Exception.Message)"
      $status.ForeColor = [System.Drawing.Color]::FromArgb(248, 81, 73)
    }
  })

[void]$form.ShowDialog()
