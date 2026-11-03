# 一次性：延迟重启 DSH。
# 停守护只认 pid 文件 —— 按命令行匹配会误杀自己（2026-11-03 踩过）。
# 起守护走 WMI（start-hostguard.ps1），不走 Start-Process —— 否则它会
# 留在本调用的进程树里，调用一结束就被一起清掉。
param([int]$Delay = 120)

Start-Sleep -Seconds $Delay

$dir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
$log = Join-Path $dir 'restart-dsh.log'
function Say([string]$m) {
  $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
  try { Add-Content -Path $log -Value $line -Encoding UTF8 } catch { }
}

$pidFile = Join-Path $dir 'hostguard.pid'
if (Test-Path $pidFile) {
  $gpid = 0
  $raw = ''
  try { $raw = (Get-Content -Path $pidFile -Raw -Encoding UTF8) } catch { }
  if ($raw -and [int]::TryParse($raw.Trim(), [ref]$gpid) -and $gpid -gt 0) {
    Say ('停 hostguard（pid=' + $gpid + '）')
    Stop-Process -Id $gpid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
} else {
  Say '没有 hostguard.pid，跳过停守护'
}

Say '调用 dsh-restart.ps1 重启 DSH'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path (Split-Path -Parent (Split-Path -Parent $dir)) 'dsh-home' }
$restartScript = Join-Path $dshHome 'bin\dsh-restart.ps1'
if (Test-Path $restartScript) { & $restartScript } else { Say ('找不到 ' + $restartScript) }
Say 'dsh-restart 返回'

Start-Sleep -Seconds 10
Say '把 hostguard 拉回来（WMI）'
$startScript = Join-Path $dir 'start-hostguard.ps1'
if (Test-Path $startScript) { & $startScript } else { Say '找不到 start-hostguard.ps1' }
Say '完成'