<#
  settings-ui.ps1 —— dsh-qq-bot 的图形化设置（独立窗口，不依赖 DSH 界面）

  为什么单独做：这台 DSH 上第三方插件的「前端半侧」没被加载，插件页里出不来配置面板。
  所以配置直接做成一个 Windows 小窗口，改完写进 <dataDir>\config.json，
  插件监听到文件变化会立刻热应用（连接那四项和 enabled 要重载插件才生效）。

  用法：
    双击 settings-ui.cmd
    或 powershell -File settings-ui.ps1
#>

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$ErrorActionPreference = 'SilentlyContinue'
$ScriptDir = Split-Path -Parent $PSCommandPath

# ── 定位配置 ──────────────────────────────────────────────────────────────
function Read-JsonFile($path) {
  if (-not (Test-Path $path)) { return $null }
  try { return Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

# dataDir：优先 bot-config.json，其次 ~/.dsh-qq-bot
$botCfg = Read-JsonFile (Join-Path $ScriptDir 'bot-config.json')
$dataDir = $null
if ($botCfg -and $botCfg.dataDir) { $dataDir = $botCfg.dataDir }
if (-not $dataDir) { $dataDir = Join-Path $env:USERPROFILE '.dsh-qq-bot' }
$configPath = Join-Path $dataDir 'config.json'
$memeDirDefault = Join-Path $dataDir 'memes'

# ── 配置读写（hashtable，保留没在界面上露出的字段）───────────────────────
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

function Get-Cfg($cfg, $path) {
  $parts = $path.Split('.')
  $cur = $cfg
  foreach ($p in $parts) {
    if ($null -eq $cur -or -not ($cur -is [hashtable]) -or -not $cur.ContainsKey($p)) { return $null }
    $cur = $cur[$p]
  }
  return $cur
}

function Set-Cfg($cfg, $path, $value) {
  $parts = $path.Split('.')
  $cur = $cfg
  for ($i = 0; $i -lt $parts.Length - 1; $i++) {
    $k = $parts[$i]
    if (-not $cur.ContainsKey($k) -or -not ($cur[$k] -is [hashtable])) { $cur[$k] = @{} }
    $cur = $cur[$k]
  }
  $cur[$parts[$parts.Length - 1]] = $value
  return $cfg
}

$raw = Read-JsonFile $configPath
$cfg = ConvertTo-Hashtable $raw
if ($null -eq $cfg) { $cfg = @{} }

# ── OneBot：读 BOT 号 / 测连接 ────────────────────────────────────────────
function Get-OneBotEndpoint {
  $url = $null
  $token = $null
  $v = Get-Cfg $cfg 'baseUrl'
  if ($v) { $url = [string]$v }
  if (-not $url -and $botCfg -and $botCfg.baseUrl) { $url = [string]$botCfg.baseUrl }
  if (-not $url) { $url = 'ws://127.0.0.1:3001/' }
  $v = Get-Cfg $cfg 'accessToken'
  if ($v) { $token = [string]$v }
  if (-not $token -and $botCfg -and $botCfg.accessToken) { $token = [string]$botCfg.accessToken }

  # ws://127.0.0.1:3001/ → http://127.0.0.1:3000（SnowLuma 的 httpServers 通常是 ws 端口 -1）
  $httpPort = 3000
  if ($botCfg -and $botCfg.httpPort) { $httpPort = [int]$botCfg.httpPort }
  elseif ($url -match ':(\d+)') { $wsPort = [int]$matches[1]; if ($wsPort -eq 3001) { $httpPort = 3000 } else { $httpPort = $wsPort - 1 } }
  return @{ HttpPort = $httpPort; Token = $token }
}

function Invoke-OneBot($action) {
  $ep = Get-OneBotEndpoint
  $headers = @{}
  if ($ep.Token) { $headers['Authorization'] = "Bearer $($ep.Token)" }
  $body = @{ action = $action; params = @{} } | ConvertTo-Json -Compress
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$($ep.HttpPort)/$action" -Method Post `
      -Headers $headers -Body $body -ContentType 'application/json' -TimeoutSec 5 -ErrorAction Stop
  } catch { return $null }
}

# ── 界面 ──────────────────────────────────────────────────────────────────
$form = New-Object System.Windows.Forms.Form
$form.Text = 'DSH QQ Bot · 设置'
$form.Size = New-Object System.Drawing.Size 660, 880
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
  $box.Size = New-Object System.Drawing.Size 580, 10
  $panel.Controls.Add($box)
  $inner = 26
  if ($hint) {
    $lab = New-Object System.Windows.Forms.Label
    $lab.Text = $hint
    $lab.AutoSize = $false
    $lab.Size = New-Object System.Drawing.Size 540, 32
    $lab.Location = New-Object System.Drawing.Point 14, $inner
    $lab.ForeColor = [System.Drawing.Color]::FromArgb(150, 150, 150)
    $box.Controls.Add($lab)
    $inner += 34
  }
  return @{ Box = $box; Inner = $inner }
}

function Add-Text($box, [ref]$inner, $key, $label, $path, $placeholder) {
  $lab = New-Object System.Windows.Forms.Label
  $lab.Text = $label
  $lab.Size = New-Object System.Drawing.Size 170, 24
  $lab.Location = New-Object System.Drawing.Point 14, ($inner.Value + 3)
  $box.Controls.Add($lab)

  $tb = New-Object System.Windows.Forms.TextBox
  $tb.Location = New-Object System.Drawing.Point 190, $inner.Value
  $tb.Size = New-Object System.Drawing.Size 370, 24
  $tb.BackColor = [System.Drawing.Color]::FromArgb(45, 45, 45)
  $tb.ForeColor = [System.Drawing.Color]::FromArgb(230, 230, 230)
  $tb.BorderStyle = 'FixedSingle'
  if ($placeholder) { $tb.PlaceholderText = $placeholder }
  $val = Get-Cfg $cfg $path
  if ($null -ne $val) {
    if ($val -is [array]) { $tb.Text = ($val -join ', ') } else { $tb.Text = [string]$val }
  }
  $box.Controls.Add($tb)
  $controls[$key] = @{ Kind = 'text'; Path = $path; Control = $tb }
  $inner.Value += 32
}

function Add-Number($box, [ref]$inner, $key, $label, $path, $min, $max, $step, $decimals) {
  $lab = New-Object System.Windows.Forms.Label
  $lab.Text = $label
  $lab.Size = New-Object System.Drawing.Size 170, 24
  $lab.Location = New-Object System.Drawing.Point 14, ($inner.Value + 3)
  $box.Controls.Add($lab)

  $num = New-Object System.Windows.Forms.NumericUpDown
  $num.Location = New-Object System.Drawing.Point 190, $inner.Value
  $num.Size = New-Object System.Drawing.Size 120, 24
  $num.Minimum = $min
  $num.Maximum = $max
  $num.Increment = $step
  $num.DecimalPlaces = $decimals
  $num.BackColor = [System.Drawing.Color]::FromArgb(45, 45, 45)
  $num.ForeColor = [System.Drawing.Color]::FromArgb(230, 230, 230)
  $val = Get-Cfg $cfg $path
  if ($null -ne $val) { try { $num.Value = [decimal]$val } catch { } }
  $box.Controls.Add($num)
  $controls[$key] = @{ Kind = 'number'; Path = $path; Control = $num; Decimals = $decimals }
  $inner.Value += 32
}

function Add-Bool($box, [ref]$inner, $key, $label, $path) {
  $cb = New-Object System.Windows.Forms.CheckBox
  $cb.Text = $label
  $cb.Location = New-Object System.Drawing.Point 14, $inner.Value
  $cb.Size = New-Object System.Drawing.Size 540, 24
  $val = Get-Cfg $cfg $path
  $cb.Checked = ($val -eq $true)
  $box.Controls.Add($cb)
  $controls[$key] = @{ Kind = 'bool'; Path = $path; Control = $cb }
  $inner.Value += 30
}

# --- 顶部说明 -------------------------------------------------------------
$tip = New-Object System.Windows.Forms.Label
$tip.Text = "改完点「保存」写入：`n$configPath`n插件监听到文件变化会立即热应用（dryRun、切条、表情频率等立刻生效）；连接那四项（地址/token/白名单/BOT 号）和 enabled 要重载插件才生效 —— 去 DSH 插件页点「重新连接」，没有那个按钮就重启 DSH。"
$tip.Location = New-Object System.Drawing.Point 14, 10
$tip.Size = New-Object System.Drawing.Size 570, 76
$tip.ForeColor = [System.Drawing.Color]::FromArgb(170, 170, 170)
$panel.Controls.Add($tip)
$y = 96

# --- 连接 -----------------------------------------------------------------
$g = New-Group '连接（和 SnowLuma 对接）' 'SnowLuma 是 QQ 协议端：让 QQ 客户端登录小号，再在 SnowLuma 里挂载该号，这里填它的地址。' $y
$inner = $g.Inner
Add-Text $g.Box ([ref]$inner) 'baseUrl' 'OneBot WS 地址' 'baseUrl' 'ws://127.0.0.1:3001/'
Add-Text $g.Box ([ref]$inner) 'accessToken' 'accessToken' 'accessToken' '留空也能连（看服务端配没配）'
$g.Box.Height = $inner + 8
$y += $g.Box.Height + 10

# --- 安全 -----------------------------------------------------------------
$g = New-Group '安全（只服务你自己）' '留空 = 谁都不服务。默认不响应任何人私聊。' $y
$inner = $g.Inner
Add-Text $g.Box ([ref]$inner) 'allowUsers' '你的 QQ 号（白名单）' 'allowUsers' '多个用逗号分隔，例如 123456,789012'

# selfId：下拉 + 读取按钮
$lab = New-Object System.Windows.Forms.Label
$lab.Text = 'BOT 的 QQ 号'
$lab.Size = New-Object System.Drawing.Size 170, 24
$lab.Location = New-Object System.Drawing.Point 14, ($inner + 3)
$g.Box.Controls.Add($lab)

$combo = New-Object System.Windows.Forms.ComboBox
$combo.Location = New-Object System.Drawing.Point 190, $inner
$combo.Size = New-Object System.Drawing.Size 250, 24
$combo.DropDownStyle = 'DropDown'
$combo.BackColor = [System.Drawing.Color]::FromArgb(45, 45, 45)
$combo.ForeColor = [System.Drawing.Color]::FromArgb(230, 230, 230)
$selfVal = Get-Cfg $cfg 'selfId'
if ($selfVal) { $combo.Items.Add([string]$selfVal) | Out-Null; $combo.Text = [string]$selfVal }
$g.Box.Controls.Add($combo)

$btnRead = New-Object System.Windows.Forms.Button
$btnRead.Text = '读取'
$btnRead.Location = New-Object System.Drawing.Point 450, $inner
$btnRead.Size = New-Object System.Drawing.Size 110, 26
$btnRead.FlatStyle = 'Flat'
$g.Box.Controls.Add($btnRead)
$controls['selfId'] = @{ Kind = 'combo'; Path = 'selfId'; Control = $combo }
$inner += 32

$readHint = New-Object System.Windows.Forms.Label
$readHint.Text = '点「读取」从 SnowLuma 读出正在登录的号，选中即可（多开 QQ 时靠它确认挂的是哪个号）'
$readHint.Location = New-Object System.Drawing.Point 190, $inner
$readHint.Size = New-Object System.Drawing.Size 370, 32
$readHint.ForeColor = [System.Drawing.Color]::FromArgb(140, 140, 140)
$g.Box.Controls.Add($readHint)
$inner += 34
$g.Box.Height = $inner + 4
$y += $g.Box.Height + 10

# --- 行为 -----------------------------------------------------------------
$g = New-Group '行为' '' $y
$inner = $g.Inner
Add-Bool $g.Box ([ref]$inner) 'enabled' '启用插件（关掉就不连、不转发）' 'enabled'
Add-Bool $g.Box ([ref]$inner) 'dryRun' '只演练不发送（只写日志，不发到 QQ）' 'dryRun'
Add-Number $g.Box ([ref]$inner) 'contextLimitPercent' '上下文用到 % 换新局' 'contextLimitPercent' 0 100 5 0
Add-Number $g.Box ([ref]$inner) 'shortMax' '短句阈值（字）' 'segment.shortMax' 1 500 5 0
Add-Number $g.Box ([ref]$inner) 'longMin' '长句阈值（字）' 'segment.longMin' 2 2000 5 0
Add-Number $g.Box ([ref]$inner) 'maxChars' '单条上限（字）' 'maxCharsPerMessage' 100 5000 100 0
Add-Text $g.Box ([ref]$inner) 'commandPrefix' 'QQ 命令前缀' 'commandPrefix' '/qq'
$g.Box.Height = $inner + 8
$y += $g.Box.Height + 10

# --- 表情包 ---------------------------------------------------------------
$g = New-Group '表情包频率' '这三个数决定她多久能发一张表情。嫌吵就把间隔调大、每小时张数调小。' $y
$inner = $g.Inner
Add-Number $g.Box ([ref]$inner) 'memeMin' '两张之间至少隔（分钟）' 'memeMinIntervalMin' 0 600 1 0
Add-Number $g.Box ([ref]$inner) 'memeMax' '每小时最多（张）' 'memeMaxPerHour' 1 60 1 0
Add-Number $g.Box ([ref]$inner) 'memeProb' '通过率（0~1）' 'memeProbability' 0 1 0.05 2
$g.Box.Height = $inner + 8
$y += $g.Box.Height + 10

# --- 收图 -----------------------------------------------------------------
$g = New-Group '收图（他发来的图片）' '收到图片先下载到本地，再把绝对路径贴进消息让她自己 read_image 看。同目录的 INDEX.md 记着每张图什么时候来的、他说了什么、她怎么回的。' $y
$inner = $g.Inner
Add-Bool $g.Box ([ref]$inner) 'imageEnabled' '收图并让她看（关掉就只剩「[图片]」占位）' 'imageEnabled'
Add-Number $g.Box ([ref]$inner) 'imageLimit' '缓存上限（MB，512 ~ 6144）' 'imageCacheLimitMB' 512 6144 128 0
Add-Number $g.Box ([ref]$inner) 'imagePurge' '一次清理掉（MB）' 'imageCachePurgeMB' 50 6144 50 0
Add-Number $g.Box ([ref]$inner) 'imageMaxMB' '单张上限（MB）' 'imageMaxMB' 1 200 1 0
Add-Text $g.Box ([ref]$inner) 'imageDir' '图片目录' 'imageDir' '默认 <数据目录>\images'
$g.Box.Height = $inner + 8
$y += $g.Box.Height + 10

# --- 路径 -----------------------------------------------------------------
$g = New-Group '路径' '留空就用默认值。' $y
$inner = $g.Inner
Add-Text $g.Box ([ref]$inner) 'dataDir' '数据目录' 'dataDir' '默认 ~/.dsh-qq-bot'
Add-Text $g.Box ([ref]$inner) 'workspacePath' 'QQ 会话工作目录' 'workspacePath' '留空 = DSH 默认'
Add-Text $g.Box ([ref]$inner) 'memesDir' '表情包目录' 'memesDir' '默认 <数据目录>/memes'
$g.Box.Height = $inner + 8
$y += $g.Box.Height + 10

# --- 底部按钮 -------------------------------------------------------------
$bar = New-Object System.Windows.Forms.Panel
$bar.Dock = 'Top'
$bar.Height = 56
$bar.BackColor = [System.Drawing.Color]::FromArgb(40, 40, 40)
$form.Controls.Add($bar)

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point 14, 18
$status.Size = New-Object System.Drawing.Size 300, 24
$status.Text = ''
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

$btnSave = New-Btn '保存' 330 80 $true
$btnOpen = New-Btn '打开数据目录' 416 110 $false
$btnClose = New-Btn '关闭' 532 60 $false

# ── 事件 ──────────────────────────────────────────────────────────────────
$btnRead.Add_Click({
    $info = Invoke-OneBot 'get_login_info'
    $uin = $null
    if ($info -and $info.data -and $info.data.user_id) { $uin = [string]$info.data.user_id }
    elseif ($info -and $info.user_id) { $uin = [string]$info.user_id }
    if (-not $uin) {
      $status.Text = '读不到号：先启动 SnowLuma 并在里面挂载小号'
      $status.ForeColor = [System.Drawing.Color]::FromArgb(210, 153, 34)
      return
    }
    $nick = ''
    if ($info.data -and $info.data.nickname) { $nick = [string]$info.data.nickname }
    $combo.Items.Clear()
    $combo.Items.Add($uin) | Out-Null
    $combo.Text = $uin
    $status.Text = "读到 $uin $nick"
    $status.ForeColor = [System.Drawing.Color]::FromArgb(63, 185, 80)
  })

$btnOpen.Add_Click({
    if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
    Start-Process explorer.exe $dataDir
  })

$btnSave.Add_Click({
    # 把控件值写回 cfg（未展示的字段原样保留）
    foreach ($key in $controls.Keys) {
      $meta = $controls[$key]
      $c = $meta.Control
      $path = $meta.Path
      switch ($meta.Kind) {
        'text' {
          $text = $c.Text.Trim()
          if ($path -eq 'allowUsers') {
            $arr = @()
            foreach ($part in ($text -split '[,，\s]+')) { if ($part -ne '') { $arr += $part } }
            $cfg = Set-Cfg $cfg $path $arr
          } elseif ($text -eq '') {
            $cfg = Set-Cfg $cfg $path ''
          } else {
            $cfg = Set-Cfg $cfg $path $text
          }
        }
        'number' {
          $val = $c.Value
          if ($meta.Decimals -gt 0) { $cfg = Set-Cfg $cfg $path ([double]$val) }
          else { $cfg = Set-Cfg $cfg $path ([int]$val) }
        }
        'bool' { $cfg = Set-Cfg $cfg $path ([bool]$c.Checked) }
        'combo' { $cfg = Set-Cfg $cfg $path $c.Text.Trim() }
      }
    }

    if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
    try {
      $json = $cfg | ConvertTo-Json -Depth 12
      # 必须无 BOM：带 BOM 的 JSON 会让宿主/插件的 JSON.parse 直接挂
      [System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
      $status.Text = "已保存 → $configPath"
      $status.ForeColor = [System.Drawing.Color]::FromArgb(63, 185, 80)
    } catch {
      $status.Text = "保存失败：$($_.Exception.Message)"
      $status.ForeColor = [System.Drawing.Color]::FromArgb(248, 81, 73)
    }
  })

$btnClose.Add_Click({ $form.Close() })

[void]$form.ShowDialog()
