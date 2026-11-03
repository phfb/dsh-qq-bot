<#
  一次性：开 Windows 自动登录
  密码从 SecretFile 读，读完整份覆写清掉，不留在任何地方。
  2026-11-03 为「整机定时重启」配的 —— 没人守着的时候重启后必须自己进桌面。
#>
param([Parameter(Mandatory=$true)][string]$SecretFile)

$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
$log = Join-Path $here 'autologon.log'
function Say([string]$m) {
  $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
  Add-Content -Path $log -Value $line -Encoding UTF8
  Write-Host $line
}

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($id)
Say ('以 ' + $id.Name + ' 运行；管理员=' + $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))

if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Say 'ERROR 没拿到管理员令牌，写不了 HKLM'
  exit 3
}

if (-not (Test-Path $SecretFile)) { Say ('ERROR 找不到密码文件 ' + $SecretFile); exit 2 }

$pw = $null
try {
  $pw = [System.IO.File]::ReadAllText($SecretFile).Trim()
} finally {
  try { [System.IO.File]::WriteAllText($SecretFile, 'x') } catch { }
  try { Remove-Item -Path $SecretFile -Force -ErrorAction SilentlyContinue } catch { }
}

if ([string]::IsNullOrWhiteSpace($pw)) { Say 'ERROR 密码是空的'; exit 2 }

$user   = $env:USERNAME
$domain = $env:COMPUTERNAME
$wl = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'

# 先验一遍密码，验不过就别写 —— 写错了这台机器重启后谁都进不去
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class LogonVerify {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool LogonUser(string u, string d, string p, int t, int pr, out IntPtr tok);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr h);
}
"@
$tok = [IntPtr]::Zero
$ok = [LogonVerify]::LogonUser($user, $domain, $pw, 2, 0, [ref]$tok)
if (-not $ok) { Say 'ERROR 密码校验不过，拒绝写入'; $pw = $null; exit 4 }
[LogonVerify]::CloseHandle($tok) | Out-Null
Say '密码校验通过'

try {
  Set-ItemProperty -Path $wl -Name 'AutoAdminLogon'    -Value '1'           -Type String -ErrorAction Stop
  Set-ItemProperty -Path $wl -Name 'DefaultUserName'   -Value $user         -Type String -ErrorAction Stop
  Set-ItemProperty -Path $wl -Name 'DefaultDomainName' -Value $domain       -Type String -ErrorAction Stop
  Set-ItemProperty -Path $wl -Name 'DefaultPassword'   -Value $pw           -Type String -ErrorAction Stop
  Say '注册表已写入'
} catch {
  Say ('ERROR 写注册表失败：' + $_.Exception.Message)
  $pw = $null
  exit 5
}

$pw = $null
[System.GC]::Collect()

# 读回验证
$v = Get-ItemProperty -Path $wl
Say ('读回：AutoAdminLogon=' + $v.AutoAdminLogon + ' / User=' + $v.DefaultUserName + ' / Domain=' + $v.DefaultDomainName + ' / 密码长度=' + ([string]$v.DefaultPassword).Length)
if ($v.AutoAdminLogon -eq '1' -and $v.DefaultUserName -eq $user) { Say 'OK 自动登录已开启' } else { Say 'ERROR 读回不一致' ; exit 6 }
exit 0