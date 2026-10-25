<#
  check-bot.ps1 —— dsh-qq-bot 链路自检 / 配置解析（通用版）

  这个脚本不假设任何一台机器上的路径、QQ 号、PID：

    · 配置来源，按优先级：
        1. 插件数据目录里的 config.json（有就读，它是最准的运行时配置）
        2. 本目录的 bot-config.json（模板见 bot-config.example.json）
        3. 都没有就自动探测常见安装位置；探不到会打印清楚要你填什么
    · PID / 端口一律现查（Get-NetTCPConnection / Get-Process / get_login_info），
      绝不写死 —— 进程重启一次 PID 就变了，写死必然错。
    · 托盘进程用"命令行结尾"正则锚定，不会把跑检查的这条命令也匹配上（那会自杀）。

  用法：
    . .\check-bot.ps1              # 点源，然后用 Get-BotStatus / Format-BotStatus / $BotConfig
    .\check-bot.ps1                # 直接跑，打印一份中文报告
    .\check-bot.ps1 -Json          # 输出 JSON（给外部程序 / 托盘读）

  链路一共五段，全过了才算"能收能发"：
    1. QQ 客户端登录了 BOT 号（SnowLuma 的 get_login_info 能报出 UIN）
    2. SnowLuma 在跑，OneBot WS 端口在听
    3. DSH 在跑，Web 端口在听
    4. dsh-qq-bot 插件已加载，且 WS 连上了 SnowLuma
    5. SnowLuma 实际挂的号和配置里的 selfId 一致（多开 QQ 时最容易挂错）
#>

param(
  [switch]$Json
)

$ErrorActionPreference = 'SilentlyContinue'

# 点源时 $PSCommandPath 会指向被点源的那个文件；这行决定了 tools 目录在哪。
$script:ToolsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($script:ToolsDir)) { $script:ToolsDir = (Get-Location).Path }

$script:BotConfigCache = $null

# ── 通用小工具 ────────────────────────────────────────────────────────────

function Read-JsonFile {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    return ($raw | ConvertFrom-Json)
  } catch {
    return $null
  }
}

# ConvertFrom-Json 出来的对象可能缺字段，直接 $obj.a.b 会静默返回 $null 也可能抛，
# 统一走这个取值器。
function Get-Prop {
  param($Object, [string]$Name, $Default = $null)
  if ($null -eq $Object) { return $Default }
  $p = $Object.PSObject.Properties[$Name]
  if ($null -eq $p) { return $Default }
  if ($null -eq $p.Value) { return $Default }
  if ($p.Value -is [string] -and [string]::IsNullOrWhiteSpace($p.Value)) { return $Default }
  return $p.Value
}

function Get-FixedDriveRoots {
  $roots = @()
  try {
    foreach ($d in [System.IO.DriveInfo]::GetDrives()) {
      if ($d.IsReady -and $d.DriveType -eq 'Fixed') { $roots += $d.RootDirectory.FullName }
    }
  } catch { }
  if ($roots.Count -eq 0) { $roots = @('C:\') }
  return $roots
}

function Test-SnowLumaDir {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
  # SnowLuma 的特征文件：OneBot 协议端本体 + 启动器 + 配置目录
  if (Test-Path -LiteralPath (Join-Path $Path 'index.mjs')) { return $true }
  if (Test-Path -LiteralPath (Join-Path $Path 'launcher.bat')) { return $true }
  if (Test-Path -LiteralPath (Join-Path $Path 'config')) { return $true }
  return $false
}

# ── 配置解析：插件 config.json → tools\bot-config.json → 自动探测 ──────────

function Find-SnowLumaDir {
  param([string]$Hint, $Notes)
  $cands = New-Object System.Collections.Generic.List[string]
  if (-not [string]::IsNullOrWhiteSpace($Hint)) { $cands.Add($Hint) }

  $bases = @(
    $env:USERPROFILE,
    (Join-Path $env:USERPROFILE 'Desktop'),
    (Join-Path $env:USERPROFILE 'Downloads'),
    (Join-Path $env:USERPROFILE 'Documents'),
    $env:LOCALAPPDATA,
    $env:ProgramFiles
  )
  foreach ($b in $bases) {
    if (-not [string]::IsNullOrWhiteSpace($b)) { $cands.Add((Join-Path $b 'SnowLuma')) }
  }
  # 每个固定盘根目录下一层：<盘>:\<任意目录>\SnowLuma
  # （很多人的 SnowLuma 是解压在某个工具箱 / 机器人框架目录里的，不叫这个名字才怪）
  foreach ($root in Get-FixedDriveRoots) {
    $cands.Add((Join-Path $root 'SnowLuma'))
    foreach ($d in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
      $cands.Add((Join-Path $d.FullName 'SnowLuma'))
    }
  }

  $seen = @{}
  foreach ($c in $cands) {
    if ([string]::IsNullOrWhiteSpace($c)) { continue }
    $key = $c.ToLowerInvariant()
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    if (Test-SnowLumaDir -Path $c) {
      try { $full = (Resolve-Path -LiteralPath $c).Path } catch { $full = $c }
      if ($Notes) { $Notes.Add("自动探测到 SnowLuma：$full") }
      return $full
    }
  }
  return $null
}

function Find-DshExe {
  param([string]$Hint, $Notes)

  $cands = New-Object System.Collections.Generic.List[string]
  if (-not [string]::IsNullOrWhiteSpace($Hint)) { $cands.Add($Hint) }

  $bases = @(
    (Join-Path $env:LOCALAPPDATA 'Programs'),
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)},
    $env:LOCALAPPDATA
  )
  foreach ($b in $bases) {
    if ([string]::IsNullOrWhiteSpace($b)) { continue }
    $cands.Add((Join-Path $b 'DSH NEXT\DSH NEXT.exe'))
    # 装的时候名字可能被改过（DSH、DSH-NEXT、DeepSeek Harness …），按 DSH 开头捞一遍
    foreach ($d in (Get-ChildItem -LiteralPath $b -Directory -ErrorAction SilentlyContinue)) {
      if ($d.Name -match '(?i)^dsh') {
        $cands.Add((Join-Path $d.FullName 'DSH NEXT.exe'))
        foreach ($d2 in (Get-ChildItem -LiteralPath $d.FullName -Directory -ErrorAction SilentlyContinue)) {
          $cands.Add((Join-Path $d2.FullName 'DSH NEXT.exe'))
        }
      }
    }
  }
  # 盘根下一到两层也扫一眼：<盘>:\DSH NEXT\... 或 <盘>:\<DSH*\>\DSH NEXT\...
  foreach ($root in Get-FixedDriveRoots) {
    $cands.Add((Join-Path $root 'DSH NEXT\DSH NEXT.exe'))
    foreach ($d in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
      if ($d.Name -match '(?i)dsh') {
        $cands.Add((Join-Path $d.FullName 'DSH NEXT.exe'))
        foreach ($d2 in (Get-ChildItem -LiteralPath $d.FullName -Directory -ErrorAction SilentlyContinue)) {
          $cands.Add((Join-Path $d2.FullName 'DSH NEXT.exe'))
        }
      }
    }
  }

  $seen = @{}
  foreach ($c in $cands) {
    if ([string]::IsNullOrWhiteSpace($c)) { continue }
    $key = $c.ToLowerInvariant()
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    if (Test-Path -LiteralPath $c -PathType Leaf) {
      if ($Notes) { $Notes.Add("自动探测到 DSH：$c") }
      return $c
    }
  }
  return $null
}

# 挑一个 onebot_<UIN>.json：优先文件名里的 UIN 等于 selfId，其次"它的 HTTP 端口在听"，
# 再次最新修改的那个。
function Select-OneBotConfigFile {
  param([string]$SnowLumaDir, [string]$Explicit, [string]$SelfId, $Notes)

  if (-not [string]::IsNullOrWhiteSpace($Explicit)) {
    if (Test-Path -LiteralPath $Explicit -PathType Leaf) { return $Explicit }
  }
  if ([string]::IsNullOrWhiteSpace($SnowLumaDir)) { return $null }
  $cfgDir = Join-Path $SnowLumaDir 'config'
  if (-not (Test-Path -LiteralPath $cfgDir -PathType Container)) { return $null }

  $files = @(Get-ChildItem -LiteralPath $cfgDir -Filter 'onebot_*.json' -File -ErrorAction SilentlyContinue)
  if ($files.Count -eq 0) { return $null }

  if (-not [string]::IsNullOrWhiteSpace($SelfId)) {
    foreach ($f in $files) {
      if ($f.Name -match 'onebot_(\d+)\.json' -and $matches[1] -eq $SelfId) {
        if ($Notes) { $Notes.Add("OneBot 配置按 selfId 命中：$($f.FullName)") }
        return $f.FullName
      }
    }
  }
  if ($files.Count -eq 1) { return $files[0].FullName }

  # 多个账号：谁的 HTTP 端口在听就认谁
  foreach ($f in $files) {
    $j = Read-JsonFile -Path $f.FullName
    $nets = Get-Prop $j 'networks'
    $httpServers = @()
    if ($nets) { $httpServers = @(Get-Prop $nets 'httpServers' @()) }
    if ($httpServers.Count -gt 0) {
      $port = [int](Get-Prop $httpServers[0] 'port' 0)
      if ($port -gt 0 -and (Test-PortListening -Port $port)) {
        if ($Notes) { $Notes.Add("OneBot 配置按监听端口命中：$($f.FullName)") }
        return $f.FullName
      }
    }
  }
  $newest = $files | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($Notes) { $Notes.Add("OneBot 配置有 $($files.Count) 份，取最新的：$($newest.FullName)") }
  return $newest.FullName
}

<#
  解析出这一台机器上的全部路径 / 端口 / 账号。
  结果缓存在 $script:BotConfigCache，-Force 可重解析（托盘点"立即自检"会用到）。
#>
function Resolve-BotConfig {
  param([switch]$Force)
  if ($script:BotConfigCache -and -not $Force) { return $script:BotConfigCache }

  $notes = New-Object System.Collections.Generic.List[string]
  $missing = New-Object System.Collections.Generic.List[string]

  # ---- 1. tools\bot-config.json ----
  $toolsFile = Join-Path $script:ToolsDir 'bot-config.json'
  $toolsCfg = Read-JsonFile -Path $toolsFile

  # ---- 2. 插件数据目录里的 config.json ----
  # dataDir 默认 <用户主目录>\.dsh-qq-bot；bot-config.json 里可以指到别处。
  $dataDirHint = [string](Get-Prop $toolsCfg 'dataDir' '')
  $dataCandidates = @()
  if (-not [string]::IsNullOrWhiteSpace($dataDirHint)) { $dataCandidates += $dataDirHint }
  $dataCandidates += (Join-Path $env:USERPROFILE '.dsh-qq-bot')
  $dataCandidates += (Join-Path (Split-Path -Parent $script:ToolsDir) 'data')
  $dataCandidates += (Join-Path $script:ToolsDir 'data')

  $dataDir = $null
  $pluginCfg = $null
  $pluginCfgFile = $null
  foreach ($d in $dataCandidates) {
    if ([string]::IsNullOrWhiteSpace($d)) { continue }
    if ($null -eq $dataDir) { $dataDir = $d }          # 第一个候选就是"默认答案"
    $cj = Join-Path $d 'config.json'
    if (Test-Path -LiteralPath $cj -PathType Leaf) {
      $dataDir = $d
      $pluginCfgFile = $cj
      $pluginCfg = Read-JsonFile -Path $cj
      $notes.Add("读到插件配置：$cj")
      break
    }
  }
  if (-not $pluginCfgFile) {
    $notes.Add('插件数据目录里没有 config.json（插件还没跑过，或 dataDir 被改到别处了）')
  }
  if (-not (Test-Path -LiteralPath $dataDir -PathType Container)) {
    $notes.Add("数据目录还不存在：$dataDir")
  }

  # ---- 3. 账号 / token ----
  # 插件 config.json 里的值最准；没有就退到 bot-config.json。
  $selfId = [string](Get-Prop $pluginCfg 'selfId' '')
  if ([string]::IsNullOrWhiteSpace($selfId)) { $selfId = [string](Get-Prop $toolsCfg 'selfId' '') }
  $accessToken = [string](Get-Prop $pluginCfg 'accessToken' '')
  if ([string]::IsNullOrWhiteSpace($accessToken)) { $accessToken = [string](Get-Prop $toolsCfg 'accessToken' '') }
  $baseUrl = [string](Get-Prop $pluginCfg 'baseUrl' '')
  if ([string]::IsNullOrWhiteSpace($baseUrl)) { $baseUrl = [string](Get-Prop $toolsCfg 'baseUrl' '') }
  $allowUsers = @()
  $au = Get-Prop $pluginCfg 'allowUsers' @()
  if ($au) { $allowUsers = @($au | ForEach-Object { [string]$_ }) }
  if ($allowUsers.Count -eq 0) {
    $au2 = Get-Prop $toolsCfg 'allowUsers' @()
    if ($au2) { $allowUsers = @($au2 | ForEach-Object { [string]$_ }) }
  }

  # ---- 4. SnowLuma ----
  $snowDir = Find-SnowLumaDir -Hint ([string](Get-Prop $toolsCfg 'snowlumaDir' '')) -Notes $notes
  if (-not $snowDir) {
    $snowDir = [string](Get-Prop $toolsCfg 'snowlumaDir' '')
    if ($snowDir) { $missing.Add("SnowLuma 目录不存在：$snowDir") }
    else { $missing.Add('没探测到 SnowLuma。请在 tools\bot-config.json 里填 snowlumaDir（解压后的 SnowLuma 目录）') }
  }

  $snowExe = [string](Get-Prop $toolsCfg 'snowlumaExe' '')
  if ([string]::IsNullOrWhiteSpace($snowExe)) {
    if ($snowDir) {
      $cand = Join-Path $snowDir 'node.exe'
      if (Test-Path -LiteralPath $cand -PathType Leaf) { $snowExe = $cand }
    }
    if ([string]::IsNullOrWhiteSpace($snowExe)) { $snowExe = 'node.exe' }
  }
  $snowScript = [string](Get-Prop $toolsCfg 'snowlumaScript' '')
  if ([string]::IsNullOrWhiteSpace($snowScript)) {
    if ($snowDir) {
      $cand = Join-Path $snowDir 'index.mjs'
      if (Test-Path -LiteralPath $cand -PathType Leaf) { $snowScript = $cand }
    }
  }
  $snowLauncher = ''
  if ($snowDir) {
    $cand = Join-Path $snowDir 'launcher.bat'
    if (Test-Path -LiteralPath $cand -PathType Leaf) { $snowLauncher = $cand }
  }
  $webUiPort = [int](Get-Prop $toolsCfg 'snowlumaWebUiPort' 5099)

  # ---- 5. OneBot 端口 / token ----
  $onebotFile = Select-OneBotConfigFile -SnowLumaDir $snowDir -Explicit ([string](Get-Prop $toolsCfg 'onebotConfigFile' '')) -SelfId $selfId -Notes $notes
  if (-not $onebotFile) {
    $missing.Add('没找到 SnowLuma 的 OneBot 配置（config\onebot_<UIN>.json）。请在 tools\bot-config.json 里填 onebotConfigFile')
  }
  $httpPort = [int](Get-Prop $toolsCfg 'httpPort' 0)
  $httpToken = [string](Get-Prop $toolsCfg 'httpToken' '')
  $wsPort = [int](Get-Prop $toolsCfg 'wsPort' 0)
  $wsToken = [string](Get-Prop $toolsCfg 'wsToken' '')
  $onebotUin = ''
  if ($onebotFile) {
    if ($onebotFile -match 'onebot_(\d+)\.json') { $onebotUin = $matches[1] }
    $ob = Read-JsonFile -Path $onebotFile
    $nets = Get-Prop $ob 'networks'
    $httpServers = @()
    $wsServers = @()
    if ($nets) {
      $httpServers = @(Get-Prop $nets 'httpServers' @())
      $wsServers = @(Get-Prop $nets 'wsServers' @())
    }
    if ($httpServers.Count -gt 0) {
      $p = [int](Get-Prop $httpServers[0] 'port' 0)
      if ($p -gt 0) { $httpPort = $p }
      $t = [string](Get-Prop $httpServers[0] 'accessToken' '')
      if ($t) { $httpToken = $t }
    }
    if ($wsServers.Count -gt 0) {
      $p = [int](Get-Prop $wsServers[0] 'port' 0)
      if ($p -gt 0) { $wsPort = $p }
      $t = [string](Get-Prop $wsServers[0] 'accessToken' '')
      if ($t) { $wsToken = $t }
    }
  }
  # 都读不到就用 OneBot v11 的惯例端口
  if ($httpPort -le 0) { $httpPort = 3000 }
  if ($wsPort -le 0) { $wsPort = 3001 }
  # 插件连 WS 用的 token 优先看 baseUrl 里拼的那个，其次 wsServers 的
  if ([string]::IsNullOrWhiteSpace($accessToken)) { $accessToken = $wsToken }

  # ---- 6. DSH ----
  $dshExe = Find-DshExe -Hint ([string](Get-Prop $toolsCfg 'dshExe' '')) -Notes $notes
  if (-not $dshExe) {
    $dshExe = [string](Get-Prop $toolsCfg 'dshExe' '')
    if ($dshExe) { $missing.Add("DSH 可执行文件不存在：$dshExe") }
    else { $missing.Add('没探测到 DSH 的可执行文件。请在 tools\bot-config.json 里填 dshExe（DSH NEXT.exe 的完整路径）') }
  }

  $logDir = Join-Path $dataDir 'logs'

  $cfg = [pscustomobject]@{
    ToolsDir         = $script:ToolsDir
    ToolsConfigFile  = $toolsFile
    ToolsConfigUsed  = (Test-Path -LiteralPath $toolsFile -PathType Leaf)
    PluginConfigFile = $pluginCfgFile
    DataDir          = $dataDir
    LogDir           = $logDir
    QqBotLog         = (Join-Path $logDir 'qq-bot.log')
    TrayLog          = (Join-Path $logDir 'tray.log')
    SessionMap       = (Join-Path $dataDir 'qq-session-map.json')
    ControlFile      = (Join-Path $dataDir 'qq-bot-control.json')
    MemesDir         = (Join-Path $dataDir 'memes')
    SnowLumaDir      = $snowDir
    SnowLumaExe      = $snowExe
    SnowLumaScript   = $snowScript
    SnowLumaLauncher = $snowLauncher
    SnowLumaWebUiPort = $webUiPort
    OneBotConfigFile = $onebotFile
    OneBotUin        = $onebotUin
    HttpPort         = $httpPort
    HttpToken        = $httpToken
    WsPort           = $wsPort
    WsToken          = $wsToken
    DshExe           = $dshExe
    SelfId           = $selfId
    AllowUsers       = $allowUsers
    BaseUrl          = $baseUrl
    Notes            = @($notes)
    Missing          = @($missing)
  }
  $script:BotConfigCache = $cfg
  return $cfg
}

# ── 日志小工具 ────────────────────────────────────────────────────────────

function Get-LogTail {
  param([string]$Path, [int]$Lines = 400)
  if (-not $Path) { return @() }
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  # 日志是 UTF-8；不写 -Encoding 会被按 GBK 读成一堆问号
  return @(Get-Content -LiteralPath $Path -Encoding UTF8 -Tail $Lines -ErrorAction SilentlyContinue)
}

function Get-LastMatch {
  param([string[]]$Lines, [string]$Pattern)
  if (-not $Lines) { return $null }
  for ($i = $Lines.Count - 1; $i -ge 0; $i--) {
    if ($Lines[$i] -match $Pattern) { return $Lines[$i] }
  }
  return $null
}

<#
  日志行格式：2026-10-25T05:26:01.438Z [INFO] 正文
  返回 UTC 时间；转本地时间用 ToLocalTime()。
#>
function Get-LogLineTime {
  param([string]$Line)
  if (-not $Line) { return $null }
  if ($Line -match '^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)') {
    try { return [datetime]::Parse($matches[1]).ToUniversalTime() } catch { return $null }
  }
  return $null
}

# ── 端口 / 进程（一律现查，不存 PID）──────────────────────────────────────

<#
  单次 Get-NetTCPConnection 就要 300 ms 上下（cmdlet 走 CIM），而一轮自检要问端口四五次：
  两次 Test-PortListening、一次 Get-PortOwnerPid、每个 DSH 进程一次 Get-FirstListeningPort。
  实测一轮 4.7 秒里 3.8 秒全耗在这上面 —— 托盘把自检放在 UI 线程、5 秒跑一轮，
  等于消息循环几乎没有空闲时间，鼠标划过图标没反应、点右键要等半天，就是这个原因。

  改成「一次拉全表、本地过滤」，同一次自检内的查询共用 400 ms 缓存。
#>
$script:ListenCache = @{ At = [datetime]::MinValue; Rows = @() }

function Get-ListenTable {
  param([int]$MaxAgeMs = 400)
  $now = [datetime]::UtcNow
  if (($now - $script:ListenCache.At).TotalMilliseconds -lt $MaxAgeMs) { return $script:ListenCache.Rows }
  $rows = @()
  try { $rows = @(Get-NetTCPConnection -State Listen -ErrorAction Stop) } catch { $rows = @() }
  $script:ListenCache = @{ At = $now; Rows = $rows }
  return $rows
}

function Test-PortListening {
  param([int]$Port)
  if ($Port -le 0) { return $false }
  foreach ($r in (Get-ListenTable)) { if ($r.LocalPort -eq $Port) { return $true } }
  return $false
}

function Get-PortOwnerPid {
  param([int]$Port)
  if ($Port -le 0) { return 0 }
  foreach ($r in (Get-ListenTable)) { if ($r.LocalPort -eq $Port) { return [int]$r.OwningProcess } }
  return 0
}

function Get-FirstListeningPort {
  param([int]$ProcessId, [int[]]$ExcludePorts = @())
  if ($ProcessId -le 0) { return 0 }
  # 跳过特权端口和 bot 自己那几个（OneBot / WebUI），剩下的才可能是 DSH 的 Web 端口
  $skip = @(3000, 3001, 5099) + @($ExcludePorts)
  $ports = @()
  foreach ($r in (Get-ListenTable)) {
    if ([int]$r.OwningProcess -ne $ProcessId) { continue }
    if ($r.LocalAddress -notin @('127.0.0.1', '0.0.0.0', '::', '::1')) { continue }
    if ($r.LocalPort -le 1024) { continue }
    if ($r.LocalPort -in $skip) { continue }
    $ports += [int]$r.LocalPort
  }
  if ($ports.Count -eq 0) { return 0 }
  return [int](($ports | Sort-Object)[0])
}

<#
  找托盘进程：只认命令行以 "-File ...bot-tray.ps1" 结尾的 powershell/pwsh。
  必须锚定结尾 —— 否则跑 check-bot.ps1 / start-bot.ps1 的那条命令行
  也会因为含 "bot-tray" 三个字被认成"托盘"，然后被自己杀掉。
#>
function Get-TrayProcesses {
  $out = @()
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'pwsh.exe'" -ErrorAction Stop
  } catch {
    return $out
  }
  foreach ($p in $procs) {
    if ([int]$p.ProcessId -eq $PID) { continue }
    $cl = [string]$p.CommandLine
    if ([string]::IsNullOrWhiteSpace($cl)) { continue }
    if ($cl -match '(?i)-File\s+"?[^"]*bot-tray\.ps1"?\s*$') {
      $out += [pscustomobject]@{ Id = [int]$p.ProcessId; CommandLine = $cl }
    }
  }
  return $out
}

# ── 静默启动外部程序（一个窗口都不许冒出来）──────────────────────────────

<#
  Start-Process -WindowStyle Hidden 对 .bat / .cmd 是无效的 —— 它走 ShellExecute，
  窗口样式会被忽略。托盘「一键启动」时冒出来的两个黑框就是这么来的：
  一个是 start-bot.ps1 自己的 powershell 窗口，一个是 SnowLuma launcher.bat 的 cmd 窗口。

  所以这里统一走 ProcessStartInfo + CreateNoWindow；.bat 用 cmd.exe /c 包一层
  （UseShellExecute=$false 时 Process.Start 不能直接启动 .bat）。
#>
function Start-HiddenProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$ArgumentList = @(),
    [string]$WorkingDirectory = ''
  )
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $args = @($ArgumentList | Where-Object { $null -ne $_ -and $_ -ne '' })
  if ($FilePath -match '(?i)\.(bat|cmd)$') {
    $psi.FileName = 'cmd.exe'
    # 末尾的 < nul 是给 launcher.bat 这类以 pause 结尾的脚本用的：没有控制台时
    # pause 会一直等输入，进程就成了一个看不见却永远不退的 cmd。接上 nul 读到 EOF 立刻走。
    $psi.Arguments = '/c "' + $FilePath + '"'
    if ($args.Count -gt 0) { $psi.Arguments += ' ' + ($args -join ' ') }
    $psi.Arguments += ' < nul'
  } else {
    $psi.FileName = $FilePath
    if ($args.Count -gt 0) {
      $psi.Arguments = (($args | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ')
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) { $psi.WorkingDirectory = $WorkingDirectory }
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  return [System.Diagnostics.Process]::Start($psi)
}

# ── OneBot HTTP：问 SnowLuma 要真实账号信息 ────────────────────────────────

function Invoke-OneBotApi {
  param([string]$Action, [int]$Port, [string]$Token, [int]$TimeoutSec = 5)
  if ($Port -le 0) { return $null }
  $headers = @{}
  if (-not [string]::IsNullOrWhiteSpace($Token)) { $headers['Authorization'] = "Bearer $Token" }
  $body = @{ action = $Action; params = @{} } | ConvertTo-Json -Compress
  # 两种写法都试：SnowLuma 认 /<action>，别的一些实现只认根路径 + body 里的 action
  foreach ($uri in @("http://127.0.0.1:$Port/$Action", "http://127.0.0.1:$Port/")) {
    try {
      $r = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $body `
        -ContentType 'application/json' -TimeoutSec $TimeoutSec -ErrorAction Stop
      if ($r) { return $r }
    } catch { }
  }
  return $null
}

function Get-LoginInfo {
  param($Config)
  if ($null -eq $Config) { return $null }
  $login = Invoke-OneBotApi -Action 'get_login_info' -Port $Config.HttpPort -Token $Config.HttpToken -TimeoutSec 4
  if (-not $login) { return $null }
  $data = Get-Prop $login 'data'
  if (-not $data) { return $null }
  $uid = Get-Prop $data 'user_id' ''
  if ([string]::IsNullOrWhiteSpace([string]$uid)) { return $null }
  return $data
}

# ── 主检查 ────────────────────────────────────────────────────────────────

function Get-BotStatus {
  param([switch]$Force)

  $cfg = Resolve-BotConfig -Force:$Force
  $st = [ordered]@{}

  $st.DataDir = $cfg.DataDir
  $st.ConfigFile = if ($cfg.PluginConfigFile) { $cfg.PluginConfigFile } elseif ($cfg.ToolsConfigUsed) { $cfg.ToolsConfigFile } else { '(无 —— 全靠自动探测)' }
  $st.SnowLumaDir = $cfg.SnowLumaDir
  $st.SnowLumaExe = $cfg.SnowLumaExe
  $st.OneBotConfigFile = $cfg.OneBotConfigFile
  $st.DshExe = $cfg.DshExe
  $st.HttpPort = $cfg.HttpPort
  $st.WsPort = $cfg.WsPort
  $st.SelfId = $cfg.SelfId
  $st.AllowUsers = @($cfg.AllowUsers)
  $st.SetupMissing = @($cfg.Missing)
  $st.Notes = @($cfg.Notes)

  # ---- 1. SnowLuma 进程 + OneBot 端口 ----
  $st.WsPortListening = Test-PortListening -Port $cfg.WsPort
  $st.HttpPortListening = Test-PortListening -Port $cfg.HttpPort

  # 认"谁在听这个端口"最准 —— SnowLuma 底下还挂着别的 node，按进程名取第一个会取错
  $snowPid = Get-PortOwnerPid -Port $cfg.WsPort
  $snow = @()
  if ($snowPid -gt 0) { $snow = @(Get-Process -Id $snowPid -ErrorAction SilentlyContinue) }
  if ($snow.Count -eq 0 -and $cfg.SnowLumaExe -and (Test-Path -LiteralPath $cfg.SnowLumaExe -PathType Leaf)) {
    $snow = @(Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -eq $cfg.SnowLumaExe })
  }
  $st.SnowLumaRunning = ($snow.Count -gt 0)
  $st.SnowLumaPid = if ($st.SnowLumaRunning) { [int]$snow[0].Id } else { 0 }
  $st.SnowLumaStartTime = if ($st.SnowLumaRunning) { $snow[0].StartTime } else { $null }

  # ---- 2. BOT 号是否真在线（这条最硬），顺便核对挂的是不是那个号 ----
  $st.QqOnline = $false
  $st.QqUin = ''
  $st.QqNick = ''
  $st.SelfIdMatches = $null
  $st.SelfIdWarn = $null
  if ($st.HttpPortListening) {
    $data = Get-LoginInfo -Config $cfg
    if ($data) {
      $st.QqOnline = $true
      $st.QqUin = [string](Get-Prop $data 'user_id' '')
      $st.QqNick = [string](Get-Prop $data 'nickname' '')
    }
  }
  if ($st.QqOnline) {
    if ([string]::IsNullOrWhiteSpace($cfg.SelfId)) {
      $st.SelfIdWarn = "SnowLuma 实际挂的号是 $($st.QqUin)，但 selfId 没填 —— 填上才能自动发现挂错号"
    } elseif ($st.QqUin -ne $cfg.SelfId) {
      $st.SelfIdMatches = $false
      $st.SelfIdWarn = "SnowLuma 实际挂的号是 $($st.QqUin)，和设置的 BOT 号 $($cfg.SelfId) 不一致（多开 QQ 时挂错）"
    } else {
      $st.SelfIdMatches = $true
    }
  }

  # ---- 3. DSH 进程 ----
  $dsh = @()
  if ($cfg.DshExe -and (Test-Path -LiteralPath $cfg.DshExe -PathType Leaf)) {
    $dsh = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $cfg.DshExe })
  }
  if ($dsh.Count -eq 0) {
    # 装的位置没探到、或者刚装完还没重启：按进程名兜一层
    $dsh = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '(?i)^dsh' })
  }
  $st.DshRunning = ($dsh.Count -gt 0)
  $st.DshPid = 0
  $st.DshWebPort = 0
  # Electron 是多进程，只有主进程在听 Web 端口；挨个试，谁在听就认谁
  foreach ($proc in $dsh) {
    $port = Get-FirstListeningPort -ProcessId $proc.Id -ExcludePorts @($cfg.HttpPort, $cfg.WsPort, $cfg.SnowLumaWebUiPort)
    if ($port -gt 0) { $st.DshPid = [int]$proc.Id; $st.DshWebPort = $port; break }
  }
  if ($st.DshPid -eq 0 -and $dsh.Count -gt 0) { $st.DshPid = [int]$dsh[0].Id }

  # ---- 4. dsh-qq-bot 插件 ----
  $qbLog = Get-LogTail -Path $cfg.QqBotLog
  $st.QqBotLogFile = $cfg.QqBotLog
  $st.QqBotLogExists = (Test-Path -LiteralPath $cfg.QqBotLog)
  $startLine = Get-LastMatch -Lines $qbLog -Pattern '\[INFO\] 启动 name=dsh-qq-bot|\[dsh-qq-bot\] 启动 name=dsh-qq-bot'
  $st.QqBotLoaded = ($null -ne $startLine)
  $startTime = Get-LogLineTime -Line $startLine
  $st.QqBotLoadedAt = if ($startTime) { $startTime.ToLocalTime() } else { $null }

  # WS 是否连上：看"已连上"和"断开"谁更晚
  $wsUp = Get-LastMatch -Lines $qbLog -Pattern '已连上 OneBot WebSocket'
  $wsDown = Get-LastMatch -Lines $qbLog -Pattern 'OneBot 连接断开'
  $upTime = Get-LogLineTime -Line $wsUp
  $downTime = Get-LogLineTime -Line $wsDown
  $st.OneBotLinkUp = [bool]($upTime -and ((-not $downTime) -or ($upTime -ge $downTime)))

  # 旧版 bug 在日志里的样子：agent id 对不上会话 id
  $st.OldAgentIdBug = [bool](Get-LastMatch -Lines $qbLog -Pattern 'agent id ".+" does not match session id')

  # token-meter 自检结论（有就信它，没有就说不确定）
  $meterLine = Get-LastMatch -Lines $qbLog -Pattern '自检：(tokenMeter 就绪|拿不到 tokenMeter)'
  if ($meterLine -match '就绪') { $st.TokenMeter = 'ready' }
  elseif ($meterLine -match '拿不到') { $st.TokenMeter = 'missing' }
  else { $st.TokenMeter = 'unknown' }

  # 硬错误只认"本次启动之后"的 —— 启动前的老账不该算在今天头上
  $st.LastError = $null
  $st.LastErrorAt = $null
  $errLine = Get-LastMatch -Lines $qbLog -Pattern '\[(ERROR)\] (入站失败|出站失败|发送失败|建会话失败|回复投递失败)'
  $errTime = Get-LogLineTime -Line $errLine
  if ($errLine -and $errTime -and $startTime -and $errTime -ge $startTime) {
    $st.LastError = $errLine
    $st.LastErrorAt = $errTime.ToLocalTime()
  }

  # ---- 4.5 演练模式（dryRun）----
  # 开着 dryRun 时，链路每一项都是绿的，但一条消息都不会真的发到 QQ —— 只会往日志里写
  # 「[dryRun] 本应发给 …」。2026-10-25 下午就是这么被坑的：自检报「链路全通，QQ 里发消息
  # 她就能回」，实际他发了两条，一条回复都没收到。这一项必须进总判定。
  # 有效值以数据目录里的 config.json 为准（它盖过 cordis.patch.yml 的出厂默认）。
  $st.DryRun = $false
  $st.DryRunKnown = $false
  if ($cfg.PluginConfigFile -and (Test-Path -LiteralPath $cfg.PluginConfigFile -PathType Leaf)) {
    $pluginCfg = Read-JsonFile -Path $cfg.PluginConfigFile
    if ($null -ne $pluginCfg) {
      $st.DryRunKnown = $true
      $st.DryRun = ((Get-Prop $pluginCfg 'dryRun' $false) -eq $true)
    }
  }

  # ---- 5. 会话映射（她现在在跟哪一局聊）----
  $st.SessionId = $null
  $st.SessionGeneration = 0
  if (Test-Path -LiteralPath $cfg.SessionMap) {
    $map = Read-JsonFile -Path $cfg.SessionMap
    if ($map) {
      $rec = $null
      # 映射的 key 是"跟他聊天的那个人"的 QQ 号，也就是 allowUsers 里的号
      foreach ($k in @($st.AllowUsers)) {
        if ([string]::IsNullOrWhiteSpace($k)) { continue }
        $r = Get-Prop $map $k
        if ($r) { $rec = $r; break }
      }
      if (-not $rec) {
        # 兜底：取第一条
        $props = @($map.PSObject.Properties)
        if ($props.Count -gt 0) { $rec = $props[0].Value }
      }
      if ($rec) {
        $st.SessionId = [string](Get-Prop $rec 'sessionId' '')
        $st.SessionGeneration = [int](Get-Prop $rec 'generation' 0)
      }
    }
  }

  # ---- 6. 托盘在不在 ----
  # 托盘进程自己跑自检时这一项必然为真 —— 没必要为它扫一遍全部 CIM 进程表。
  # Get-CimInstance Win32_Process 一次 0.2~1.3 秒（波动很大），是自检里最贵的单项之一。
  if ($script:TraySelfRunning) {
    $trays = @([pscustomobject]@{ Id = [int]$PID })
  } else {
    $trays = @(Get-TrayProcesses)
  }
  $st.TrayRunning = ($trays.Count -gt 0)
  $st.TrayPids = @($trays | ForEach-Object { $_.Id })

  # ---- 总判定 ----
  $st.AllGreen = [bool]($st.SnowLumaRunning -and $st.WsPortListening -and $st.QqOnline -and
                        $st.DshRunning -and $st.QqBotLoaded -and $st.OneBotLinkUp -and
                        (-not $st.DryRun))

  return [pscustomobject]$st
}

# ── 报告 ──────────────────────────────────────────────────────────────────

function Format-BotStatus {
  param($Status)
  $lines = New-Object System.Collections.Generic.List[string]
  function Mark($ok) { if ($ok) { return '[ OK ]' } else { return '[FAIL]' } }
  # 可选项（托盘之类）：没开不算故障，别让它污染 [FAIL]
  function MarkOpt($ok) { if ($ok) { return '[ OK ]' } else { return '[ -- ]' } }

  $lines.Add("dsh-qq-bot 链路自检  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
  $lines.Add('------------------------------------------------------------')
  $lines.Add("配置文件  $($Status.ConfigFile)")
  $lines.Add("数据目录  $($Status.DataDir)")
  $lines.Add('------------------------------------------------------------')

  $snowDetail = if ($Status.SnowLumaRunning) {
    "pid=$($Status.SnowLumaPid)  起于 $($Status.SnowLumaStartTime.ToString('HH:mm:ss'))"
  } elseif ($Status.SnowLumaDir) {
    "进程没起来：$($Status.SnowLumaDir)"
  } else {
    '没探测到 SnowLuma 目录（见下面「还要做什么」）'
  }
  $lines.Add(("{0} SnowLuma      {1}" -f (Mark $Status.SnowLumaRunning), $snowDetail))
  $lines.Add(("{0} OneBot WS     {1}" -f (Mark $Status.WsPortListening),
      $(if ($Status.WsPortListening) { "127.0.0.1:$($Status.WsPort) 在听" } else { "127.0.0.1:$($Status.WsPort) 没在听" })))
  $lines.Add(("{0} BOT 号在线    {1}" -f (Mark $Status.QqOnline),
      $(if ($Status.QqOnline) { "$($Status.QqUin) ($($Status.QqNick))" } else { 'get_login_info 拿不到 —— QQ 没登录，或 SnowLuma 没 hook 上客户端' })))

  if ($Status.SelfIdWarn) {
    $lines.Add("[WARN] $($Status.SelfIdWarn)")
  } else {
    $selfDetail = if ($Status.SelfIdMatches -eq $true) { "实际 $($Status.QqUin) = 配置的 selfId，对上了" }
                  elseif ($Status.QqOnline) { "实际 $($Status.QqUin)" }
                  else { '拿不到登录信息，没法核对' }
    $lines.Add(("{0} 挂的哪个号  {1}" -f (Mark ($Status.SelfIdMatches -eq $true)), $selfDetail))
  }

  $dshDetail = if ($Status.DshRunning) {
    "pid=$($Status.DshPid)  Web http://127.0.0.1:$($Status.DshWebPort)"
  } elseif ($Status.DshExe) {
    "进程没起来：$($Status.DshExe)"
  } else {
    '进程没起来（也没探测到安装位置）'
  }
  $lines.Add(("{0} DSH           {1}" -f (Mark $Status.DshRunning), $dshDetail))
  $lines.Add(("{0} dsh-qq-bot    {1}" -f (Mark $Status.QqBotLoaded),
      $(if ($Status.QqBotLoaded) { "已加载  $(if ($Status.QqBotLoadedAt) { $Status.QqBotLoadedAt.ToString('HH:mm:ss') })" }
        elseif (-not $Status.QqBotLogExists) { "还没有日志：$($Status.QqBotLogFile)（插件没加载过？）" }
        else { '日志里找不到启动记录' })))
  $lines.Add(("{0} OneBot 连接   {1}" -f (Mark $Status.OneBotLinkUp),
      $(if ($Status.OneBotLinkUp) { '插件的 WS 已连上 SnowLuma' } else { '没连上（看日志里的断开原因）' })))
  $lines.Add(("{0} token-meter   {1}" -f (Mark ($Status.TokenMeter -eq 'ready')),
      $(switch ($Status.TokenMeter) {
          'ready' { '就绪，上下文到阈值能自动换新局' }
          'missing' { '没挂上 —— 「上下文到 X% 换新局」不会触发，其余照常' }
          default { '日志里还没出现自检行（插件刚启动 5 秒内正常）' }
        })))
  if ($Status.DryRunKnown) {
    $dryDetail = if ($Status.DryRun) {
      '开着！只往日志里写、不发到 QQ —— 这就是「能收能处理、但一条回复都没有」的元凶。去设置窗口把「只演练不发送」取消勾选并保存，或直接把 config.json 的 dryRun 改成 false'
    } else {
      '关着，消息会真的发到 QQ'
    }
    $lines.Add(("{0} 演练模式      {1}" -f (Mark (-not $Status.DryRun)), $dryDetail))
  } else {
    $lines.Add("[WARN] 演练模式      读不到插件配置 $($Status.ConfigFile)，没法确认是不是被 dryRun 关住了")
  }
  $lines.Add(("{0} 托盘          {1}" -f (MarkOpt $Status.TrayRunning),
      $(if ($Status.TrayRunning) { "在跑 pid=$($Status.TrayPids -join ',')" } else { '没开（可选，双击 bot-tray.cmd 就常驻了）' })))

  $lines.Add(("       当前对话：{0}（第 {1} 局）" -f
      $(if ($Status.SessionId) { $Status.SessionId } else { '(还没建)' }), $Status.SessionGeneration))
  if ($Status.OldAgentIdBug) {
    $lines.Add('       日志里有 `agent id ... does not match session id` —— 那是旧版 bug（已修），升级插件后不会再出现')
  }
  if ($Status.LastError) {
    $lines.Add("       最近错误 $($Status.LastErrorAt.ToString('HH:mm:ss'))：$($Status.LastError)")
  }

  if ($Status.SetupMissing -and $Status.SetupMissing.Count -gt 0) {
    $lines.Add('------------------------------------------------------------')
    $lines.Add('还要做什么：')
    foreach ($m in $Status.SetupMissing) { $lines.Add("  · $m") }
  }

  $lines.Add('------------------------------------------------------------')
  if ($Status.AllGreen) {
    $lines.Add('结论：链路全通，QQ 里发消息她就能回。')
  } else {
    $lines.Add('结论：有环节没通，见上面 [FAIL] / [WARN] 那几行。')
  }
  return ($lines -join [Environment]::NewLine)
}

# ── 直接运行时打印 ────────────────────────────────────────────────────────
if ($MyInvocation.InvocationName -ne '.') {
  $status = Get-BotStatus
  if ($Json.IsPresent) {
    $status | ConvertTo-Json -Depth 5
  } else {
    Write-Host (Format-BotStatus -Status $status)
  }
}
