<#
  settings-alive.ps1 —— dsh-alive（活人感）的图形化设置

  和 dsh-qq-bot 的 settings-ui.ps1 同一套做法：独立窗口，改完写 <dataDir>\alive-config.json，
  插件监听到文件变化立刻热应用。

  2026-10-25 晚加的东西：
    · 顶部「现在什么情况」——今日额度用了几条、还剩几条、本小时用了几条、静音到几点、
      今天有没有被封顶、挂着的念头、以及"现在为什么不会发"（把闸门摊开给他看，不用再猜）
    · 「禁言机制」一组——禁言总开关、场景静音开关、硬静音时长
    · 两个即时按钮——「马上解除静音」「今日额度清零」

  即时按钮为什么不走 HTTP：宿主对没有浏览器凭证的请求一律 403（qq-bot 的接口同样如此），
  独立进程调不通。所以改成写信箱文件 <dataDir>\alive-control.json，插件扫到就执行：

      窗口写  { "cmd": "unmute", "id": "<guid>" }
      插件执行完把 cmd 清空、写上 doneAt 当回执
      窗口轮询到 cmd 空了 = 办完了

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
$controlPath = Join-Path $dataDir 'alive-control.json'

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

function ConvertTo-LocalTime($iso) {
  if (-not $iso) { return $null }
  try {
    $dt = [datetime]::Parse($iso, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)
    if ($dt.Kind -eq 'Utc') { $dt = $dt.ToLocalTime() }
    return $dt
  } catch { return $null }
}

function Format-Clock($iso) {
  $t = ConvertTo-LocalTime $iso
  if ($null -eq $t) { return '' }
  return $t.ToString('HH:mm')
}

function Format-Ago($iso) {
  $dt = ConvertTo-LocalTime $iso
  if ($null -eq $dt) { return '—' }
  $span = (Get-Date) - $dt
  if ($span.TotalSeconds -lt 0) { return $dt.ToString('HH:mm') }
  if ($span.TotalMinutes -lt 1) { return '刚刚' }
  if ($span.TotalMinutes -lt 60) { return "$([int]$span.TotalMinutes) 分钟前" }
  if ($span.TotalHours -lt 24) { return "$([int]$span.TotalHours) 小时前（$($dt.ToString('HH:mm'))）" }
  return $dt.ToString('MM-dd HH:mm')
}

# ─────────────────────────────────────────────────────────────────────────────
# 自发开口为什么还没动（跟 lib/policy.mjs 的 buildFreeLoop 一一对应）
#
# 返回 $null = 三个门槛都过了，她随时可以自己找话；
# 返回一句话 = 卡在哪一条，直接贴到「现在为什么不会发」里。
# ─────────────────────────────────────────────────────────────────────────────

function Get-FreeTalkBlockReason($st, $nowTime) {
  $silenceNeed = 15
  if ($cfg.ContainsKey('freeTalkSilenceMin')) { $silenceNeed = [int]$cfg['freeTalkSilenceMin'] }
  $gapNeed = 45
  if ($cfg.ContainsKey('freeTalkGapMin')) { $gapNeed = [int]$cfg['freeTalkGapMin'] }
  $moodNeed = 45
  if ($cfg.ContainsKey('freeTalkMoodPercent')) { $moodNeed = [int]$cfg['freeTalkMoodPercent'] }

  $lastQqT = $null
  if ($st.focus) { $lastQqT = ConvertTo-LocalTime $st.focus.lastQqAt }
  if ($null -eq $lastQqT) { return '自发开口在待命：你还没在 QQ 里说过话，它不知道该从哪一刻算你安静了' }
  $idle = ($nowTime - $lastQqT).TotalMinutes
  if ($idle -lt $silenceNeed) {
    return "自发开口还没动：你 $([int]$idle) 分钟前刚在 QQ 说过话，要安静满 $silenceNeed 分钟"
  }

  $lastFree = $null
  foreach ($lp in @($st.loops)) {
    if (-not $lp) { continue }
    if ($lp.source -ne 'free') { continue }
    $t = ConvertTo-LocalTime $lp.createdAt
    if ($null -ne $t -and ($null -eq $lastFree -or $t -gt $lastFree)) { $lastFree = $t }
  }
  if ($null -ne $lastFree) {
    $since = ($nowTime - $lastFree).TotalMinutes
    if ($since -lt $gapNeed) {
      return "自发开口还没动：上次自发是 $([int]$since) 分钟前，两次之间至少隔 $gapNeed 分钟"
    }
  }

  $dims = [ordered]@{ missing = '想他'; lust = '涩涩'; boredom = '闲得慌'; worry = '担心'; jealousy = '吃醋' }
  $topKey = ''
  $topVal = 0.0
  if ($st.mood) {
    foreach ($k in $dims.Keys) {
      if ($k -eq 'lust' -and -not $script:lustOnNow) { continue }
      $v = [double]$st.mood.$k
      if ($v -gt $topVal) { $topVal = $v; $topKey = $k }
    }
  }
  $topPct = [int][math]::Round($topVal * 100)
  if ($topPct -lt $moodNeed) {
    $name = if ($topKey) { $dims[$topKey] } else { '还没攒起来' }
    return "自发开口还没动：情绪最高的一维是「$name」$topPct%，还没到 $moodNeed%"
  }

  return $null
}

# ─────────────────────────────────────────────────────────────────────────────
# 状态：读 alive-state.json（插件每次投递 / 收消息 / 落盘都会刷新它）
# ─────────────────────────────────────────────────────────────────────────────

function Get-AliveStatus {
  $maxDay = 20
  if ($cfg.ContainsKey('maxPerDay')) { $maxDay = [int]$cfg['maxPerDay'] }
  $maxHour = 7
  if ($cfg.ContainsKey('maxPerHour')) { $maxHour = [int]$cfg['maxPerHour'] }
  $muteEnabled = $true
  if ($cfg.ContainsKey('muteEnabled')) { $muteEnabled = $cfg['muteEnabled'] -ne $false }
  $minSilence = 10
  if ($cfg.ContainsKey('minSilenceMin')) { $minSilence = [int]$cfg['minSilenceMin'] }
  $cooldown = 20
  if ($cfg.ContainsKey('cooldownMin')) { $cooldown = [int]$cfg['cooldownMin'] }

  $st = Read-JsonFile $statePath
  if (-not $st) {
    return [pscustomobject]@{
      HasState = $false; DayCount = 0; DayLeft = $maxDay; MaxPerDay = $maxDay
      HourCount = 0; MaxPerHour = $maxHour; Muted = $false; MutedUntil = ''; MuteReason = ''
      StopToday = $false; OpenLoops = '读不到状态文件（插件还没跑过？）'
      Delivered = 0; Replied = 0; Abandoned = 0
      LastPro = '—'; LastHuman = '—'; LastQq = '—'; LastTick = '—'
      Blocked = @('状态文件不存在，说明插件还没启动过'); MuteEnabled = $muteEnabled
      MoodText = '—'; MoodTop = '—'
      Enabled = $true
    }
  }

  $dayCount = 0; $hourCount = 0; $lastPro = $null; $lastHuman = $null; $lastQq = $null; $lastTick = $null
  if ($st.quota) {
    if ($null -ne $st.quota.dayCount) { $dayCount = [int]$st.quota.dayCount }
    if ($null -ne $st.quota.hourCount) { $hourCount = [int]$st.quota.hourCount }
    $lastPro = $st.quota.lastProactiveAt
  }
  if ($st.focus) { $lastHuman = $st.focus.lastHumanAt; $lastQq = $st.focus.lastQqAt; $lastTick = $st.focus.lastTickAt }

  $mutedUntil = $null; $muteReason = ''; $stopUntil = $null; $lastWasStop = $false
  $enabled = $true
  if ($st.control) {
    $mutedUntil = $st.control.mutedUntil
    $muteReason = $st.control.muteReason
    $stopUntil = $st.control.dayQuotaSuspendedUntil
    $lastWasStop = $st.control.lastWasStop -eq $true
    if ($null -ne $st.control.enabled) { $enabled = $st.control.enabled -eq $true }
  }

  $nowTime = Get-Date
  $muted = $false
  if ($mutedUntil) { $t = ConvertTo-LocalTime $mutedUntil; if ($null -ne $t) { $muted = $t -gt $nowTime } }
  $stopToday = $false
  if ($stopUntil) { $t2 = ConvertTo-LocalTime $stopUntil; if ($null -ne $t2) { $stopToday = $t2 -gt $nowTime } }

  $openNames = @()
  foreach ($lp in @($st.loops)) {
    if ($lp -and $lp.status -eq 'open') { $openNames += "「$($lp.what)」（约 $(Format-Clock $lp.expectedBackAt) 到点）" }
  }
  $openText = if ($openNames.Count -eq 0) { '0 条' } else { "$($openNames.Count) 条 —— $($openNames -join '；')" }

  # 情绪模块快照（七个维度，由 lib/mood.mjs 演化；面板一律用百分比）
  $moodText = '—'
  $moodTop = '—'
  if ($st.mood) {
    $mv = [ordered]@{
      missing  = [double]$st.mood.missing
      jealousy = [double]$st.mood.jealousy
      warmth   = [double]$st.mood.warmth
      worry    = [double]$st.mood.worry
      boredom  = [double]$st.mood.boredom
      lust     = [double]$st.mood.lust
    }
    $debt = 0
    if ($null -ne $st.mood.annoyanceDebt) { $debt = [int]$st.mood.annoyanceDebt }
    $pct = @{}
    foreach ($k in $mv.Keys) { $pct[$k] = [int][math]::Round($mv[$k] * 100) }
    $debtPct = [int][math]::Round(($debt / 60) * 100)
    # 涩涩三种说法分开写：代码里没开 / 面板没勾 / 真开着 —— 别让人以为它在偷偷涨
    if (-not $script:lustEnabled) { $lustSeg = '涩涩 未开放' }
    elseif (-not $script:lustOnNow) { $lustSeg = ('涩涩 {0}%（未启用）' -f $pct.lust) }
    else { $lustSeg = ('涩涩 {0}%' -f $pct.lust) }
    # 没启用就不让它参与"主情绪"评比
    if (-not $script:lustOnNow) { $mv.Remove('lust') }
    $moodText = ("想他 {0}% · 吃醋 {1}% · 暖意 {2}% · 担心 {3}% · 闲 {4}% · {5} · 恼火 {6}%（{7}/60）" -f `
        $pct.missing, $pct.jealousy, $pct.warmth, $pct.worry, $pct.boredom, $lustSeg, $debtPct, $debt)
    $names = @{ missing = '想他'; jealousy = '吃醋'; warmth = '暖意'; worry = '担心'; boredom = '闲得慌'; lust = '涩涩' }
    $topKey = ''
    $topVal = 0
    foreach ($k in $mv.Keys) { if ($mv[$k] -gt $topVal) { $topVal = $mv[$k]; $topKey = $k } }
    if (($debt / 60) -gt $topVal) { $topKey = 'annoyance'; $topVal = $debt / 60 }
    if ($topVal -lt 0.25) { $moodTop = '平静（还没攒起什么情绪）' }
    elseif ($topKey -eq 'annoyance') { $moodTop = "有点恼（恼火 $debtPct%，到 45/60 就闭嘴）" }
    else { $moodTop = "$($names[$topKey]) $([int][math]::Round($topVal * 100))%" }
  }

  # 现在为什么不会发：跟插件里那些闸门对齐，能算的都在这里算
  $blocked = @()
  if (-not $enabled) { $blocked += '总开关关着（上面「启用活人感」没勾）' }
  if ($openNames.Count -eq 0) {
    $freeOn = $true
    if ($cfg.ContainsKey('freeTalkEnabled')) { $freeOn = $cfg['freeTalkEnabled'] -ne $false }
    if (-not $freeOn) {
      $blocked += '没有挂着的念头，自发开口也关着（下面「自发开口」那组没勾）—— 要说「我去洗澡」这类话才会挂上一件'
    } else {
      $why = Get-FreeTalkBlockReason $st $nowTime
      if ($why) { $blocked += $why }
    }
  }
  if ($muted) { $blocked += "静音中，到 $(Format-Clock $mutedUntil)（$muteReason）" }
  if ($lastWasStop) { $blocked += '上次说的是「别发了」，要你回一句「好了 / 聊会儿」才解' }
  if ($stopToday) { $blocked += '今天说过「别发了」，封顶到 24:00' }
  if ($dayCount -ge $maxDay) { $blocked += "今日额度用完（$dayCount/$maxDay）" }
  if ($hourCount -ge $maxHour) { $blocked += "本小时额度用完（$hourCount/$maxHour）" }
  $humanAt = ConvertTo-LocalTime $lastQq
  if ($null -ne $humanAt) {
    $idle = ($nowTime - $humanAt).TotalMinutes
    if ($idle -lt $minSilence) { $blocked += "你刚在 QQ 说过话，还要 $([math]::Ceiling($minSilence - $idle)) 分钟才考虑" }
  }
  $proAt = ConvertTo-LocalTime $lastPro
  if ($null -ne $proAt) {
    $sincePro = ($nowTime - $proAt).TotalMinutes
    if ($sincePro -lt $cooldown) { $blocked += "冷却中，还要 $([math]::Ceiling($cooldown - $sincePro)) 分钟" }
  }

  return [pscustomobject]@{
    HasState = $true
    DayCount = $dayCount
    DayLeft = [math]::Max(0, $maxDay - $dayCount)
    MaxPerDay = $maxDay
    HourCount = $hourCount
    MaxPerHour = $maxHour
    Muted = $muted
    MutedUntil = Format-Clock $mutedUntil
    MuteReason = $muteReason
    StopToday = $stopToday
    OpenLoops = $openText
    Delivered = if ($st.stats) { [int]$st.stats.totalDelivered } else { 0 }
    Replied = if ($st.stats) { [int]$st.stats.totalReplied } else { 0 }
    Abandoned = if ($st.stats) { [int]$st.stats.abandoned } else { 0 }
    LastPro = Format-Ago $lastPro
    LastHuman = Format-Ago $lastHuman
    LastQq = Format-Ago $lastQq
    LastTick = Format-Ago $lastTick
    Blocked = $blocked
    MoodText = $moodText
    MoodTop = $moodTop
    MuteEnabled = $muteEnabled
    Enabled = $enabled
  }
}

<#
  给插件下命令：写信箱文件，等它回执。
  返回 $true = 插件确认执行了；$false = 等了 5 秒没等到（插件没在跑 / 还是旧代码）。
#>
function Send-AliveCommand($cmd) {
  $id = [guid]::NewGuid().ToString()
  $payload = [ordered]@{
    cmd         = $cmd
    id          = $id
    requestedAt = (Get-Date).ToUniversalTime().ToString('o')
  } | ConvertTo-Json
  try {
    if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
    [System.IO.File]::WriteAllText($controlPath, $payload, (New-Object System.Text.UTF8Encoding($false)))
  } catch { return $false }

  for ($i = 0; $i -lt 13; $i++) {
    Start-Sleep -Milliseconds 400
    $cur = Read-JsonFile $controlPath
    if ($null -eq $cur) { continue }
    if ($cur.id -eq $id -and -not $cur.cmd) { return $true }
  }
  return $false
}

# ─────────────────────────────────────────────────────────────────────────────
# 窗口
# ─────────────────────────────────────────────────────────────────────────────

$form = New-Object System.Windows.Forms.Form
$form.Text = 'DSH 活人感 · 设置'
$form.Size = New-Object System.Drawing.Size 740, 1060
$form.StartPosition = 'CenterScreen'
$form.BackColor = [System.Drawing.Color]::FromArgb(30, 30, 30)
$form.ForeColor = [System.Drawing.Color]::FromArgb(225, 225, 225)
$form.Font = New-Object System.Drawing.Font 'Microsoft YaHei UI', 9

$panel = New-Object System.Windows.Forms.Panel
$panel.Dock = 'Fill'
$panel.AutoScroll = $true
$panel.Padding = New-Object System.Windows.Forms.Padding 12
$form.Controls.Add($panel)

# 注意顺序：先加 Fill 的 panel，再加 Top 的 bar。
# WinForms 按 z 顺序做 Dock 布局，后加的控件先占位 —— 反过来写的话
# panel 会把顶部那排按钮整个盖住（2026-10-26 实测：保存按钮点不到）。
$bar = New-Object System.Windows.Forms.Panel
$bar.Dock = 'Top'
$bar.Height = 92
$bar.BackColor = [System.Drawing.Color]::FromArgb(40, 40, 40)
$form.Controls.Add($bar)

$controls = @{}

function New-Group($title, $hint, $y) {
  $box = New-Object System.Windows.Forms.GroupBox
  $box.Text = " $title "
  $box.ForeColor = [System.Drawing.Color]::FromArgb(160, 200, 255)
  $box.Location = New-Object System.Drawing.Point 12, $y
  $box.Size = New-Object System.Drawing.Size 670, 10
  $panel.Controls.Add($box)
  $inner = 26
  if ($hint) {
    $lab = New-Object System.Windows.Forms.Label
    $lab.Text = $hint
    $lab.Size = New-Object System.Drawing.Size 630, 32
    $lab.Location = New-Object System.Drawing.Point 14, $inner
    $lab.ForeColor = [System.Drawing.Color]::FromArgb(150, 150, 150)
    $box.Controls.Add($lab)
    $inner += 34
  }
  return @{ Box = $box; Inner = $inner }
}

function Test-KeySet($path) { return $cfg.ContainsKey($path) }

function Add-Text($box, [ref]$inner, $key, $label, $path, $placeholder, $isList) {
  $lab = New-Object System.Windows.Forms.Label
  $lab.Text = $label
  $lab.Size = New-Object System.Drawing.Size 230, 24
  $lab.Location = New-Object System.Drawing.Point 14, ($inner.Value + 3)
  $box.Controls.Add($lab)

  $tb = New-Object System.Windows.Forms.TextBox
  $tb.Location = New-Object System.Drawing.Point 250, $inner.Value
  $tb.Size = New-Object System.Drawing.Size 400, 24
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

function Add-Number($box, [ref]$inner, $key, $label, $path, $min, $max, $step, $decimals, $default = $null) {
  $lab = New-Object System.Windows.Forms.Label
  $lab.Text = $label
  $lab.Size = New-Object System.Drawing.Size 230, 24
  $lab.Location = New-Object System.Drawing.Point 14, ($inner.Value + 3)
  $box.Controls.Add($lab)

  $num = New-Object System.Windows.Forms.NumericUpDown
  $num.Location = New-Object System.Drawing.Point 250, $inner.Value
  $num.Size = New-Object System.Drawing.Size 120, 24
  $num.Minimum = $min
  $num.Maximum = $max
  $num.Increment = $step
  $num.DecimalPlaces = $decimals
  $num.BackColor = [System.Drawing.Color]::FromArgb(45, 45, 45)
  $num.ForeColor = [System.Drawing.Color]::FromArgb(230, 230, 230)
  if (Test-KeySet $path) {
    $val = $cfg[$path]
    if ($null -ne $val) { try { $num.Value = [decimal]$val } catch { } }
  } elseif ($null -ne $default) {
    try { $num.Value = [decimal]$default } catch { }
  }
  $box.Controls.Add($num)
  $controls[$key] = @{ Kind = 'number'; Path = $path; Control = $num; Decimals = $decimals }
  $inner.Value += 32
}

function Add-Bool($box, [ref]$inner, $key, $label, $path, $default = $false) {
  $cb = New-Object System.Windows.Forms.CheckBox
  $cb.Text = $label
  $cb.Location = New-Object System.Drawing.Point 14, $inner.Value
  $cb.Size = New-Object System.Drawing.Size 630, 24
  if (Test-KeySet $path) { $cb.Checked = ($cfg[$path] -eq $true) } else { $cb.Checked = ($default -eq $true) }
  $box.Controls.Add($cb)
  $controls[$key] = @{ Kind = 'bool'; Path = $path; Control = $cb }
  $inner.Value += 30
}

$y = 8

# ── 现在什么情况 ─────────────────────────────────────────────────────────────

$gStatus = New-Object System.Windows.Forms.GroupBox
$gStatus.Text = ' 现在什么情况 '
$gStatus.ForeColor = [System.Drawing.Color]::FromArgb(160, 200, 255)
$gStatus.Location = New-Object System.Drawing.Point 12, $y
$gStatus.Size = New-Object System.Drawing.Size 670, 292
$panel.Controls.Add($gStatus)

$lblStatus = New-Object System.Windows.Forms.Label
$lblStatus.Location = New-Object System.Drawing.Point 14, 24
$lblStatus.Size = New-Object System.Drawing.Size 640, 256
$lblStatus.Font = New-Object System.Drawing.Font 'Consolas', 9
$lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(215, 215, 215)
$gStatus.Controls.Add($lblStatus)

$y += 300

# ── 禁言机制 ─────────────────────────────────────────────────────────────────

$g = New-Group '禁言机制' '他说「别发了」「闭嘴」这类话时，插件要不要真的闭嘴。关掉总开关就只当聊天听：不静音、不封当天额度。' $y
$inner = $g.Inner
Add-Bool $g.Box ([ref]$inner) 'muteEnabled' '启用禁言机制（认得出「别发了」就静音 + 当天不再主动）' 'muteEnabled' $true
Add-Bool $g.Box ([ref]$inner) 'softMuteEnabled' '场景静音也算（开会 / 室友在 / 我在忙 → 60~240 分钟）' 'softMuteEnabled' $true
Add-Number $g.Box ([ref]$inner) 'hardMuteMin' '硬静音多久（分钟）' 'hardMuteMin' 5 1440 5 0 120
$g.Box.Height = $inner + 8
$y += $g.Box.Height + 10

# ── 情绪速率（2026-10-26 加） ────────────────────────────────────────────────
# 每颗滑条 = 速率倍率（0.1x ~ 10x）。1.0x = 基准小时数（默认 6）从 0% 攒到 100%，
# 右边那列会把「按当前倍率算，满值要多久」当场算出来。
#
# 涩涩有两道互不相干的开关，都在 lib\mood.mjs 顶上：
#   LUST_ENABLED        = 总开关（默认 false）→ 关着就冻结，不涨不掉、不参与打分
#   滑条能不能拖：由面板上那颗正式开关（lustModeEnabled）决定，勾上才可拖
# 涩涩的两层开关都在 lib\mood.mjs 顶上：LUST_ENABLED 决定面板露不露这一组，
# 露出来之后面板上那颗勾选（lustModeEnabled）才是真启用。涩涩的时间参数也全在它自己那组里。

$script:lustUnlocked = $false
$script:lustEnabled = $false
try {
  $moodSrc = Join-Path (Split-Path -Parent $ScriptDir) 'lib\mood.mjs'
  if (Test-Path $moodSrc) {
    $moodRaw = Get-Content $moodSrc -Raw -Encoding UTF8
    if ($moodRaw -match 'export\s+const\s+LUST_SLIDER_ENABLED\s*=\s*true') { $script:lustUnlocked = $true }
    if ($moodRaw -match 'export\s+const\s+LUST_ENABLED\s*=\s*true') { $script:lustEnabled = $true }
  }
} catch { }

# 面板上那颗真开关：代码开关亮着、且配置里勾了，才算真启用（两层都亮）
$script:lustOnNow = $false
if ($script:lustEnabled -and $cfg.ContainsKey('lustModeEnabled') -and $cfg['lustModeEnabled'] -eq $true) {
  $script:lustOnNow = $true
}

function Format-FillTime($hours) {
  if ($null -eq $hours) { return '—' }
  if ($hours -ge 1) { return ('{0:N1} 小时' -f [double]$hours) }
  return ('{0:N0} 分钟' -f ([double]$hours * 60))
}

$g = New-Group '情绪速率（多久攒满）' '每颗滑条是速率倍率 0.1x ~ 10x。1.0x = 6 小时从 0% 攒到 100%；倍数越大涨得越快。右边那列是按当前倍率算好的满值时间，拖滑条会实时变。涩涩那颗默认锁着、时间参数在下面「涩涩」那组里。' $y
$inner = $g.Inner

$lblBase = New-Object System.Windows.Forms.Label
$lblBase.Text = '基准：1.0x 时多久攒满'
$lblBase.Location = New-Object System.Drawing.Point 14, ($inner + 3)
$lblBase.Size = New-Object System.Drawing.Size 150, 24
$g.Box.Controls.Add($lblBase)

$numFill = New-Object System.Windows.Forms.NumericUpDown
$numFill.Location = New-Object System.Drawing.Point 170, $inner
$numFill.Size = New-Object System.Drawing.Size 80, 24
$numFill.Minimum = 1
$numFill.Maximum = 72
$numFill.Increment = 0.5
$numFill.DecimalPlaces = 1
$numFill.BackColor = [System.Drawing.Color]::FromArgb(45, 45, 45)
$numFill.ForeColor = [System.Drawing.Color]::FromArgb(230, 230, 230)
$fillHours = 6.0
if ($cfg.ContainsKey('moodFillHours') -and $null -ne $cfg['moodFillHours']) {
  try { $fillHours = [double]$cfg['moodFillHours'] } catch { }
}
try { $numFill.Value = [decimal]$fillHours } catch { }
$script:numFill = $numFill

$lblBaseUnit = New-Object System.Windows.Forms.Label
$lblBaseUnit.Text = '小时（所有滑条都拿它当 1.0x 的基准）'
$lblBaseUnit.Location = New-Object System.Drawing.Point 258, ($inner + 3)
$lblBaseUnit.Size = New-Object System.Drawing.Size 380, 24
$lblBaseUnit.ForeColor = [System.Drawing.Color]::FromArgb(150, 150, 150)
$g.Box.Controls.Add($numFill)
$g.Box.Controls.Add($lblBaseUnit)
$inner += 32

function Update-RateRow($row) {
  if ($null -eq $row) { return }
  $mul = [double]$row.Bar.Value / 10.0
  $row.ValueLabel.Text = ('{0:N1}x' -f $mul)
  if ($row.Key -eq 'warmthGain') {
    $row.TimeLabel.Text = ('每次哄 +{0:N0}%（事件型，无满值时间）' -f (30.0 * $mul))
    return
  }
  # 用 $script: 前缀：这段可能从 Timer 的 Tick 里被调，作用域不一定看得到脚本局部变量
  $base = 6.0
  if ($null -ne $script:numFill) { $base = [double]$script:numFill.Value }
  $hours = $base / $mul
  $tail = ''
  if ($row.Note) { $tail = "（$($row.Note)）" }
  if ($row.Key -eq 'lust') {
    # 涩涩不按"攒满"算，时间全在下面那组里；这颗滑条只表示"倍率能不能拖"。
    if (-not $script:lustEnabled) {
      $row.TimeLabel.Text = '[关] 代码里没开 · 见 README'
      return
    }
    if (-not $script:lustOnNow) {
      $row.TimeLabel.Text = '[关] 未启用 · 勾下面那组'
      return
    }
    if (-not $script:lustOnNow) {
      $row.TimeLabel.Text = '[锁] 正式开关没勾 · 时间见下面那组'
      return
    }
    $row.TimeLabel.Text = '1.0x 以上可拖 · 时间见下面那组'
    return
  }
  $row.TimeLabel.Text = ('满值约 ' + (Format-FillTime $hours) + $tail)
}

$script:rateRows = @()
$rowSpecs = @(
  @{ Key = 'missing';        Name = '想他';      Note = '深夜更快' },
  @{ Key = 'jealousy';       Name = '吃醋';      Note = '他没动静时' },
  @{ Key = 'warmthGain';     Name = '暖意·涨';   Note = '' },
  @{ Key = 'warmthDecay';    Name = '暖意·掉';   Note = '冷到底' },
  @{ Key = 'worry';          Name = '担心';      Note = '凌晨他还没消息' },
  @{ Key = 'boredom';        Name = '闲得慌';    Note = '想他越久越快' },
  @{ Key = 'annoyanceDecay'; Name = '恼火·消气'; Note = '60 点全消' },
  @{ Key = 'lust';           Name = '涩涩';      Note = '' }
)

foreach ($spec in $rowSpecs) {
  $key = $spec.Key

  $lab = New-Object System.Windows.Forms.Label
  $lab.Text = $spec.Name
  $lab.Location = New-Object System.Drawing.Point 14, ($inner + 5)
  $lab.Size = New-Object System.Drawing.Size 90, 24
  $g.Box.Controls.Add($lab)

  $track = New-Object System.Windows.Forms.TrackBar
  $track.Location = New-Object System.Drawing.Point 104, ($inner - 2)
  $track.Size = New-Object System.Drawing.Size 230, 30
  $track.AutoSize = $false
  $track.Minimum = 1
  $track.Maximum = 100
  $track.TickFrequency = 10
  $track.SmallChange = 1
  $track.LargeChange = 10
  $track.BackColor = [System.Drawing.Color]::FromArgb(40, 40, 40)

  $mul = 1.0
  if ($cfg.ContainsKey('moodRates') -and $null -ne $cfg['moodRates'] -and $null -ne $cfg['moodRates'][$key]) {
    try { $mul = [double]$cfg['moodRates'][$key] } catch { }
  }
  // 涩涩这条路：正式开关没勾就不让拖（隐藏开关只决定这一组露不露）。
  if ($key -eq 'lust' -and -not $script:lustOnNow) { $mul = 1.0; $track.Enabled = $false }
  try { $track.Value = [int][math]::Max(1, [math]::Min(100, [math]::Round($mul * 10))) } catch { }

  $valLbl = New-Object System.Windows.Forms.Label
  $valLbl.Text = ('{0:N1}x' -f $mul)
  $valLbl.Location = New-Object System.Drawing.Point 342, ($inner + 5)
  $valLbl.Size = New-Object System.Drawing.Size 52, 24
  $valLbl.ForeColor = [System.Drawing.Color]::FromArgb(160, 200, 255)

  $timeLbl = New-Object System.Windows.Forms.Label
  $timeLbl.Location = New-Object System.Drawing.Point 390, ($inner + 5)
  $timeLbl.Size = New-Object System.Drawing.Size 268, 24
  $timeLbl.ForeColor = [System.Drawing.Color]::FromArgb(190, 190, 190)

  $g.Box.Controls.Add($track)
  $g.Box.Controls.Add($valLbl)
  $g.Box.Controls.Add($timeLbl)

  $row = @{ Key = $key; Bar = $track; ValueLabel = $valLbl; TimeLabel = $timeLbl; Note = $spec.Note; Last = $null }
  $track.Tag = $row
  $script:rateRows += , $row
  # 事件里别用 $this —— PowerShell 5.1 下它不一定是 sender。用委托参数最稳。
  # 另外滑条被 UIA / 键盘改值时不一定抛 ValueChanged，所以下面还有一层定时轮询兜着。
  $track.Add_ValueChanged({ param($sender, $e) try { Update-RateRow $sender.Tag } catch { } })
  $inner += 32
}

foreach ($r in $script:rateRows) { Update-RateRow $r }
$numFill.Add_ValueChanged({ param($sender, $e) foreach ($r in $script:rateRows) { Update-RateRow $r } })

# 定时轮询：滑条值变了就重算右边那列。ValueChanged 在某些输入路径下不触发，
# 事件 + 轮询两条腿，怎么拖都能立刻看到「满值约 X 小时」跟着变。
$script:lastFillHours = [double]$numFill.Value
$uiTimer = New-Object System.Windows.Forms.Timer
$uiTimer.Interval = 150
$uiTimer.Add_Tick({
    try {
      foreach ($r in $script:rateRows) {
        $v = [int]$r.Bar.Value
        if ($null -eq $r.Last -or [int]$r.Last -ne $v) { $r.Last = $v; Update-RateRow $r }
      }
      $fv = [double]$script:numFill.Value
      if ($fv -ne $script:lastFillHours) {
        $script:lastFillHours = $fv
        foreach ($r in $script:rateRows) { Update-RateRow $r }
      }
    } catch { }
  })
$uiTimer.Start()
$form.Add_FormClosed({ try { $uiTimer.Stop(); $uiTimer.Dispose() } catch { } })

$g.Box.Height = $inner + 8
$y += $g.Box.Height + 10

# ── 涩涩（对话驱动）──────────────────────────────────────────────────────────
# 这一整组只在 lib\mood.mjs 的 LUST_ENABLED = true 时才出现 ——
# 代码里那一行是"幕布"，面板上这颗勾选才是"真开关"，两层都亮才生效。
# 和上面那颗滑条锁（LUST_SLIDER_ENABLED）完全隔离开：这边开了，滑条也照样锁着 1.0x。
if ($script:lustEnabled) {
  $g = New-Group '涩涩（对话驱动）' '不是随时间攒的：你在 QQ 里挑逗她 → 顶上去一截 → 事后慢慢回落到「余温下限」→ 再随「想他」自己爬，但爬到「自涨封顶」就停住，往上只能靠对话。建议搭配 purge-plus 插件用。' $y
  $inner = $g.Inner
  Add-Bool $g.Box ([ref]$inner) 'lustModeEnabled' '启用涩涩模式（真正打开的那颗）' 'lustModeEnabled' $false
  $chkLust = $controls['lustModeEnabled'].Control
  $chkLust.Add_CheckedChanged({ param($s, $e) try { $script:lustOnNow = ($s.Checked -eq $true) -and $script:lustEnabled; foreach ($r in $script:rateRows) { if ($r.Key -eq 'lust') { Update-RateRow $r } } } catch { } })
  Add-Number $g.Box ([ref]$inner) 'lustFloorPercent' '余温下限（%）：回落到这儿停住' 'lustFloorPercent' 0 100 5 0 20
  Add-Number $g.Box ([ref]$inner) 'lustSelfCapPercent' '自涨封顶（%）：自己爬最多到这儿' 'lustSelfCapPercent' 0 100 5 0 70
  Add-Number $g.Box ([ref]$inner) 'lustDecayHours' '回落到下限要多久（小时）' 'lustDecayHours' 0.1 240 0.5 1 4
  Add-Number $g.Box ([ref]$inner) 'lustFillHours' '自涨基准（小时）：下限爬到封顶' 'lustFillHours' 0.1 240 0.5 1 6
  Add-Number $g.Box ([ref]$inner) 'lustTeaseStepPercent' '你挑逗一次涨多少（%）' 'lustTeaseStepPercent' 0 100 5 0 25
  $g.Box.Height = $inner + 8
  $y += $g.Box.Height + 10
}

# ── 开关与目标 ───────────────────────────────────────────────────────────────

$g = New-Group '开关与目标' '' $y
$inner = $g.Inner
Add-Bool $g.Box ([ref]$inner) 'enabled' '启用活人感（她会主动开口）' 'enabled' $true
Add-Bool $g.Box ([ref]$inner) 'dryRun' '只演练不发送（只在日志里看"她本来会说什么"）' 'dryRun' $true
Add-Text $g.Box ([ref]$inner) 'targetSession' '投递到哪个会话' 'targetSession' 'auto = 跟 qq-bot 的会话映射走'
Add-Text $g.Box ([ref]$inner) 'selfUin' '你自己的 QQ 号' 'selfUin' '填了才知道该找哪个会话'
$g.Box.Height = $inner + 8
$y += $g.Box.Height + 10

# ── 节奏 ─────────────────────────────────────────────────────────────────────

$g = New-Group '节奏（多久开口一次）' '静默不够久不开口；冷却不够长不开口；分数不够高不开口。上面前三行就是额度的实时数字。' $y
$inner = $g.Inner
Add-Number $g.Box ([ref]$inner) 'minSilenceMin' '他安静多久才考虑开口（分钟）' 'minSilenceMin' 1 600 1 0 12
Add-Number $g.Box ([ref]$inner) 'cooldownMin' '两次主动之间至少隔（分钟）' 'cooldownMin' 1 720 5 0 45
Add-Number $g.Box ([ref]$inner) 'maxPerHour' '每小时最多几次' 'maxPerHour' 1 20 1 0 1
Add-Number $g.Box ([ref]$inner) 'maxPerDay' '每天最多几次' 'maxPerDay' 1 50 1 0 4
Add-Number $g.Box ([ref]$inner) 'threshold' '打分阈值（越高越少说话）' 'threshold' 0 100 5 0 55
Add-Number $g.Box ([ref]$inner) 'maxAttempts' '同一件事最多追几次' 'maxAttempts' 1 2 1 0 2
$g.Box.Height = $inner + 8
$y += $g.Box.Height + 10

# ── 自发开口（没有念头也能找你）─────────────────────────────────────────────
# 2026-10-26 晚上加。原来整条投递链只认「悬着的事」（open loop），
# 而悬着的事只有你说「我去洗澡」这类带离开意思的话才会挂上 ——
# 你一句「好」结束对话之后，所有念头被关成 answered，她一整晚可以一声不吭，
# 想他 100% 也没用。这一组把那个缺口补上：不靠事件，靠情绪攒出来的劲。
$g = New-Group '自发开口（没有悬着的事也能找你）' '三个门槛都过了才开口：你安静够久、距上次自发够久、最主导的那维情绪到线。造出来的念头一样要过静音 / 深夜 / 配额 / 冷却，一条都绕不过。' $y
$inner = $g.Inner
Add-Bool $g.Box ([ref]$inner) 'freeTalkEnabled' '启用自发开口（关掉就退回「只在你走了之后才追」）' 'freeTalkEnabled' $true
Add-Number $g.Box ([ref]$inner) 'freeTalkSilenceMin' '你在 QQ 安静多久她才自己找话（分钟）' 'freeTalkSilenceMin' 1 600 1 0 15
Add-Number $g.Box ([ref]$inner) 'freeTalkGapMin' '两次自发之间至少隔（分钟）' 'freeTalkGapMin' 1 1440 5 0 45
Add-Number $g.Box ([ref]$inner) 'freeTalkMoodPercent' '情绪到多少才自发（%）' 'freeTalkMoodPercent' 0 100 5 0 45
Add-Number $g.Box ([ref]$inner) 'goodnightSilenceMin' '说完晚安后多久不再找你（分钟，0 不禁）' 'goodnightSilenceMin' 10 1440 10 0 600
$g.Box.Height = $inner + 8
$y += $g.Box.Height + 10

# ── 情绪驱动（她为什么非要找你）─────────────────────────────────────────────

$g = New-Group '情绪驱动（她为什么非要找你）' '她的情绪不只给自己看：写进系统提示词会影响说话语气；情绪上来了还能突破额度主动开口。' $y
$inner = $g.Inner
Add-Bool $g.Box ([ref]$inner) 'moodInjection' '把当前情绪写进系统提示词（她自己知道自己什么心情）' 'moodInjection' $true
Add-Bool $g.Box ([ref]$inner) 'emotionBypassQuota' '情绪上来了可以突破每小时/每天额度（深夜和「别发了」仍然守）' 'emotionBypassQuota' $true
Add-Bool $g.Box ([ref]$inner) 'emotionBypassMaster' '连总开关关着也照发（危险：你关了她还会找你）' 'emotionBypassMaster' $false
Add-Number $g.Box ([ref]$inner) 'memeChancePercent' '主动开口时先甩一张表情的概率（%）' 'memeChancePercent' 0 100 5 0 40
$g.Box.Height = $inner + 8
$y += $g.Box.Height + 10
# ── 时段 ─────────────────────────────────────────────────────────────────────

$g = New-Group '时段' '格式 03:00-06:00，多个用逗号分隔。留空 = 不限制。' $y
$inner = $g.Inner
Add-Text $g.Box ([ref]$inner) 'quietHours' '完全禁言时段' 'quietHours' '例如 01:00-07:00' $true
Add-Text $g.Box ([ref]$inner) 'deepNightHours' '深夜只放睡觉类' 'deepNightHours' '例如 03:00-06:00' $true
$g.Box.Height = $inner + 8
$y += $g.Box.Height + 10

# ── 其他 ─────────────────────────────────────────────────────────────────────

$g = New-Group '其他' '' $y
$inner = $g.Inner
Add-Bool $g.Box ([ref]$inner) 'includeRecall' '开口时带上记忆召回（以前聊过的事）' 'includeRecall' $false
Add-Number $g.Box ([ref]$inner) 'moodSnapshotIntervalMin' '情绪快照最短多久写一次（分钟）' 'moodSnapshotIntervalMin' 1 1440 1 0 5
Add-Number $g.Box ([ref]$inner) 'tickMs' '心跳间隔（毫秒）' 'tickMs' 10000 600000 1000 0 60000
Add-Number $g.Box ([ref]$inner) 'staleMin' '念头多久没投就作废（分钟）' 'staleMin' 5 600 5 0 30
Add-Text $g.Box ([ref]$inner) 'dataDir' '数据目录' 'dataDir' '留空 = 默认'
$g.Box.Height = $inner + 8
$y += $g.Box.Height + 10

# ── 底栏 ─────────────────────────────────────────────────────────────────────

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point 14, 8
$status.Size = New-Object System.Drawing.Size 700, 20
$status.ForeColor = [System.Drawing.Color]::FromArgb(170, 170, 170)
$bar.Controls.Add($status)

$statusHint = New-Object System.Windows.Forms.Label
$statusHint.Location = New-Object System.Drawing.Point 14, 30
$statusHint.Size = New-Object System.Drawing.Size 700, 18
$statusHint.ForeColor = [System.Drawing.Color]::FromArgb(130, 130, 130)
$bar.Controls.Add($statusHint)

function New-Btn($text, $x, $w, $primary) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.Location = New-Object System.Drawing.Point $x, 52
  $b.Size = New-Object System.Drawing.Size $w, 30
  $b.FlatStyle = 'Flat'
  if ($primary) {
    $b.BackColor = [System.Drawing.Color]::FromArgb(46, 90, 138)
    $b.ForeColor = [System.Drawing.Color]::White
  }
  $bar.Controls.Add($b)
  return $b
}

$btnSave = New-Btn '保存' 14 90 $true
$btnUnmute = New-Btn '马上解除静音' 112 130 $false
$btnResetQuota = New-Btn '今日额度清零' 250 130 $false
$btnRefresh = New-Btn '刷新' 388 80 $false
$btnState = New-Btn '打开状态文件' 476 130 $false
$btnClose = New-Btn '关闭' 614 70 $false

function Set-Message($text, $kind) {
  $status.Text = $text
  switch ($kind) {
    'ok' { $status.ForeColor = [System.Drawing.Color]::FromArgb(63, 185, 80) }
    'err' { $status.ForeColor = [System.Drawing.Color]::FromArgb(248, 81, 73) }
    'warn' { $status.ForeColor = [System.Drawing.Color]::FromArgb(210, 153, 34) }
    default { $status.ForeColor = [System.Drawing.Color]::FromArgb(170, 170, 170) }
  }
}

function Update-StatusView {
  $st = Get-AliveStatus

  $muteLine = '没静音'
  if ($st.Muted) {
    $reason = if ($st.MuteReason) { $st.MuteReason } else { '—' }
    $muteLine = "静音到 $($st.MutedUntil)（$reason）"
  } elseif (-not $st.MuteEnabled) {
    $muteLine = '禁言机制关着'
  }
  $stopLine = if ($st.StopToday) { '是 —— 封顶到 24:00（说「别发了」的后果，可以点下面的按钮撤）' } else { '否' }

  $lines = @()
  $lines += "今日额度     已投 $($st.DayCount) 条 / 上限 $($st.MaxPerDay) 条，还剩 $($st.DayLeft) 条"
  $lines += "本小时       $($st.HourCount) / $($st.MaxPerHour) 条"
  $lines += "静音         $muteLine"
  $lines += "今天封顶     $stopLine"
  $lines += "挂着的念头   $($st.OpenLoops)"
  $lines += "情绪         $($st.MoodText)"
  $lines += "主情绪       $($st.MoodTop)"
  $lines += "上次主动     $($st.LastPro)"
  $lines += "你上次说话   QQ 里 $($st.LastQq)      DSH 里 $($st.LastHuman)"
  $lines += "累计         投出 $($st.Delivered) 条，他回了 $($st.Replied) 次，作废 $($st.Abandoned) 条"
  $lines += ''
  if ($st.Blocked.Count -eq 0) {
    $lines += '现在能发：闸门全过，只要有念头到点就会开口'
  } else {
    $lines += '现在为什么不会发：'
    foreach ($b in $st.Blocked) { $lines += "  · $b" }
  }
  $lblStatus.Text = ($lines -join "`r`n")

  $statusHint.Text = "配置：$configPath"
  return $st
}

$btnRefresh.Add_Click({ Update-StatusView | Out-Null; Set-Message '已刷新' 'muted' })

$btnClose.Add_Click({ $form.Close() })

$btnState.Add_Click({
    if (-not (Test-Path $statePath)) { Set-Message "还没有状态文件：$statePath" 'warn'; return }
    Start-Process notepad.exe $statePath
  })

$btnUnmute.Add_Click({
    Set-Message '正在让插件解除静音…' 'muted'
    $ok = Send-AliveCommand 'unmute'
    Update-StatusView | Out-Null
    if ($ok) { Set-Message '已解除静音，当天封顶也一起撤了' 'ok' }
    else { Set-Message '没等到插件回执：DSH 里那个插件可能没在跑（或者还是旧代码）' 'err' }
  })

$btnResetQuota.Add_Click({
    Set-Message '正在让插件把额度清零…' 'muted'
    $ok = Send-AliveCommand 'reset-quota'
    Update-StatusView | Out-Null
    if ($ok) { Set-Message '今日 / 本小时额度清零了，冷却也清了' 'ok' }
    else { Set-Message '没等到插件回执：DSH 里那个插件可能没在跑（或者还是旧代码）' 'err' }
  })

$btnSave.Add_Click({
    # 情绪速率：滑条离散值 1..100 → 0.1x..10.0x；涩涩锁着的时候按钮是灰的，写回去也是 1.0
    if ($script:rateRows.Count -gt 0) {
      $rates = @{}
      foreach ($row in $script:rateRows) { $rates[$row.Key] = [double]$row.Bar.Value / 10.0 }
      $cfg['moodRates'] = $rates
    }
    $cfg['moodFillHours'] = [double]$numFill.Value

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
      # 无 BOM：带 BOM 的 JSON 会让插件的 JSON.parse 直接挂（2026-10-25 踩过）
      [System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
      Set-Message "已保存 → $configPath" 'ok'
    } catch {
      Set-Message "保存失败：$($_.Exception.Message)" 'err'
    }
    Start-Sleep -Milliseconds 500
    Update-StatusView | Out-Null
  })

Update-StatusView | Out-Null

[void]$form.ShowDialog()
