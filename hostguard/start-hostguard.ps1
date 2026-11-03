# 从 DSH 里拉起 hostguard 的唯一正确方式。
#
# 为什么不能用 Start-Process：DSH 的工具调用是带进程树的，调用结束（或
# 被取消 / job_kill）时整棵树一起清 —— 从里面起的守护活不过那一下。
# 2026-11-03 就栽在这上面：pid 11608 跑了 1 小时 20 分无缘无故没了，
# pid 9844 更惨，我 kill 了一下自己的后台 job 它就一起死了。
#
# WMI 创建出来的进程，父进程是 WmiPrvSE.exe，压根不在调用方那棵树里。

$dir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
$script = Join-Path $dir 'hostguard.ps1'
$pidFile = Join-Path $dir 'hostguard.pid'

function Get-GuardPid {
  if (-not (Test-Path $pidFile)) { return 0 }
  $raw = ''
  try { $raw = (Get-Content -Path $pidFile -Raw -Encoding UTF8) } catch { return 0 }
  $n = 0
  if ($raw -and [int]::TryParse($raw.Trim(), [ref]$n) -and $n -gt 0) { return $n }
  return 0
}

$cur = Get-GuardPid
if ($cur -gt 0 -and @(Get-Process -Id $cur -ErrorAction SilentlyContinue).Count -gt 0) {
  Write-Output ("已经在跑：pid=" + $cur)
  return
}

$cmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script + '"'
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
if ($r.ReturnValue -ne 0) {
  Write-Output ("启动失败，WMI 返回 " + $r.ReturnValue)
  return
}
Start-Sleep -Seconds 6
$p = Get-Process -Id ([int]$r.ProcessId) -ErrorAction SilentlyContinue
if ($p) {
  Write-Output ("已启动：pid=" + $r.ProcessId + "，父进程 WmiPrvSE（不在调用方进程树里）")
} else {
  Write-Output ("WMI 说建了 pid=" + $r.ProcessId + "，但它已经退出 —— 看 hostguard.log")
}