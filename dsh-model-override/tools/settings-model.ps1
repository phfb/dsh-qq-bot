# dsh-model-override 设置窗口
#
# 为什么要一个独立窗口、而不是直接画在 DSH 设置页里：
# 宿主里没有 webServer（独立进程拿不到 HTTP 口），所以只能走文件信箱 ——
# 跟 dsh-alive 的设置窗口是同一个模式：
#     窗口写 control.json  { cmd, id, payload }
#     插件扫到没见过的 id 就执行，执行完把 cmd 清空、写回执
#     窗口轮询到 cmd 空了 = 办完了
#
# 数据来源是插件写的 snapshot.json（provider 目录 + 当前选择 + 各会话模型）。

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$dataDir = 'D:\DSHBot\data'
$snapshotPath = Join-Path $dataDir 'snapshot.json'
$controlPath = Join-Path $dataDir 'control.json'

function Read-Snapshot {
    if (-not (Test-Path $snapshotPath)) { return $null }
    try { return (Get-Content $snapshotPath -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

function Send-Command($cmd, $payload) {
    $id = [guid]::NewGuid().ToString()
    $obj = [ordered]@{
        cmd         = $cmd
        id          = $id
        payload     = $payload
        requestedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    $json = $obj | ConvertTo-Json -Depth 8 -Compress
    if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
    [System.IO.File]::WriteAllText($controlPath, $json, (New-Object System.Text.UTF8Encoding($false)))

    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 400
        try {
            $cur = Get-Content $controlPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($cur.id -eq $id -and -not $cur.cmd) { return $cur.result }
        } catch { }
    }
    return $null
}

# ── 窗口 ────────────────────────────────────────────────────────────────────

$form = New-Object System.Windows.Forms.Form
$form.Text = 'DSH 全局模型覆盖'
$form.Size = New-Object System.Drawing.Size 780, 620
$form.StartPosition = 'CenterScreen'
$form.BackColor = [System.Drawing.Color]::FromArgb(30, 30, 30)
$form.ForeColor = [System.Drawing.Color]::FromArgb(225, 225, 225)
$form.Font = New-Object System.Drawing.Font 'Microsoft YaHei UI', 9

function New-Label($text, $x, $y, $w, $h, $size) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $text
    $l.Location = New-Object System.Drawing.Point $x, $y
    $l.Size = New-Object System.Drawing.Size $w, $h
    if ($size) { $l.Font = New-Object System.Drawing.Font 'Consolas', $size }
    return $l
}

# 状态区
$lblStatus = New-Label '' 16 12 730 150 9
$lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(210, 210, 210)
$form.Controls.Add($lblStatus)

# 分隔线
$line = New-Object System.Windows.Forms.Label
$line.BorderStyle = 'Fixed3D'
$line.Location = New-Object System.Drawing.Point 16, 170
$line.Size = New-Object System.Drawing.Size 730, 2
$form.Controls.Add($line)

# provider
$form.Controls.Add((New-Label '服务商 (provider)' 16 188 150 24))
$cbProvider = New-Object System.Windows.Forms.ComboBox
$cbProvider.Location = New-Object System.Drawing.Point 180, 185
$cbProvider.Size = New-Object System.Drawing.Size 560, 26
$cbProvider.DropDownStyle = 'DropDownList'
$cbProvider.BackColor = [System.Drawing.Color]::FromArgb(45, 45, 45)
$cbProvider.ForeColor = [System.Drawing.Color]::FromArgb(230, 230, 230)
$form.Controls.Add($cbProvider)

# model
$form.Controls.Add((New-Label '模型 (model)' 16 226 150 24))
$cbModel = New-Object System.Windows.Forms.ComboBox
$cbModel.Location = New-Object System.Drawing.Point 180, 223
$cbModel.Size = New-Object System.Drawing.Size 560, 26
$cbModel.DropDownStyle = 'DropDownList'
$cbModel.BackColor = [System.Drawing.Color]::FromArgb(45, 45, 45)
$cbModel.ForeColor = [System.Drawing.Color]::FromArgb(230, 230, 230)
$form.Controls.Add($cbModel)

# reasoning effort
$form.Controls.Add((New-Label '推理等级' 16 264 150 24))
$cbEffort = New-Object System.Windows.Forms.ComboBox
$cbEffort.Location = New-Object System.Drawing.Point 180, 261
$cbEffort.Size = New-Object System.Drawing.Size 220, 26
$cbEffort.DropDownStyle = 'DropDownList'
$cbEffort.BackColor = [System.Drawing.Color]::FromArgb(45, 45, 45)
$cbEffort.ForeColor = [System.Drawing.Color]::FromArgb(230, 230, 230)
$form.Controls.Add($cbEffort)

$lblHint = New-Label '（该模型支持哪些等级由 provider 决定；留空 = 用模型默认）' 410 264 340 24
$lblHint.ForeColor = [System.Drawing.Color]::FromArgb(140, 140, 140)
$form.Controls.Add($lblHint)

# 按钮
function New-Btn($text, $x, $w, $primary) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text
    $b.Location = New-Object System.Drawing.Point $x, 306
    $b.Size = New-Object System.Drawing.Size $w, 34
    $b.FlatStyle = 'Flat'
    if ($primary) {
        $b.BackColor = [System.Drawing.Color]::FromArgb(46, 90, 138)
        $b.ForeColor = [System.Drawing.Color]::White
    }
    $form.Controls.Add($b)
    return $b
}

$btnApply = New-Btn '应用到全部会话' 16 170 $true
$btnRefresh = New-Btn '刷新' 194 90 $false
$btnFolder = New-Btn '打开数据目录' 292 130 $false
$btnClose = New-Btn '关闭' 430 90 $false

# 底部提示
$lblMsg = New-Label '' 16 356 730 60 9
$lblMsg.ForeColor = [System.Drawing.Color]::FromArgb(170, 170, 170)
$form.Controls.Add($lblMsg)

$lblExplain = New-Label @"
说明：
· 这个窗口改的是「全局」—— 旧会话立刻切换，之后新建的会话（含 QQ bot 换新局）也用它。
· 官方那个模型选择框是「按会话」的，所以 bot 那局从建出来那天就定死了，点它没用，得用这里。
· 应用之后下一轮请求就生效，不用重启 DSH。
"@ 16 400 730 110 9
$lblExplain.ForeColor = [System.Drawing.Color]::FromArgb(130, 130, 130)
$form.Controls.Add($lblExplain)

# ── 数据绑定 ────────────────────────────────────────────────────────────────

$script:snapshot = $null
$script:catalog = @()

function Format-Sessions($sessions) {
    if ($null -eq $sessions -or @($sessions).Count -eq 0) { return '  （当前没有活着的会话）' }
    $lines = @()
    foreach ($s in @($sessions)) {
        $sid = [string]$s.id
        if ($sid.Length -gt 20) { $sid = $sid.Substring(0, 20) + '…' }
        $lines += "  $sid    $($s.provider) / $($s.model)"
    }
    return ($lines -join "`r`n")
}

function Update-StatusView {
    $snap = Read-Snapshot
    $script:snapshot = $snap
    if ($null -eq $snap) {
        $lblStatus.Text = "读不到 snapshot.json：`r`n$snapshotPath`r`n`r`n插件可能没在跑（或者还没启动过）。"
        return
    }

    $cur = $snap.current
    $curText = if ($cur -and $cur.provider) { "$($cur.provider) / $($cur.model)" + $(if ($cur.reasoningEffort) { " ($($cur.reasoningEffort))" } else { '' }) } else { '（读不到）' }

    $lines = @()
    $lines += "当前全局默认   $curText"
    $lines += "快照时间       $(([datetime]$snap.savedAt).ToLocalTime().ToString('HH:mm:ss'))"
    $lines += ""
    $lines += "各会话实际在用："
    $lines += (Format-Sessions $snap.sessions)
    $lblStatus.Text = ($lines -join "`r`n")
}

function Update-ModelList {
    $providerId = [string]$cbProvider.SelectedItem
    $found = $script:catalog | Where-Object { $_.id -eq $providerId } | Select-Object -First 1
    $cbModel.Items.Clear()
    $cbEffort.Items.Clear()
    if ($null -eq $found) { return }
    foreach ($m in @($found.models)) {
        $label = if ($m.name -and $m.name -ne $m.id) { "$($m.id)  —— $($m.name)" } else { $m.id }
        [void]$cbModel.Items.Add($label)
    }
    if ($cbModel.Items.Count -gt 0) { $cbModel.SelectedIndex = 0 }
    Update-EffortList
}

function Update-EffortList {
    $cbEffort.Items.Clear()
    [void]$cbEffort.Items.Add('')
    $providerId = [string]$cbProvider.SelectedItem
    $found = $script:catalog | Where-Object { $_.id -eq $providerId } | Select-Object -First 1
    if ($null -eq $found) { $cbEffort.SelectedIndex = 0; return }
    $idx = $cbModel.SelectedIndex
    if ($idx -lt 0 -or $idx -ge @($found.models).Count) { $cbEffort.SelectedIndex = 0; return }
    $m = @($found.models)[$idx]
    foreach ($e in @($m.efforts)) { if ($e) { [void]$cbEffort.Items.Add([string]$e) } }
    $cbEffort.SelectedIndex = 0
}

function Load-Catalog {
    $snap = Read-Snapshot
    if ($null -eq $snap) { return }
    $script:snapshot = $snap
    $script:catalog = @($snap.catalog)
    $cbProvider.Items.Clear()
    foreach ($p in $script:catalog) {
        $label = if ($p.name -and $p.name -ne $p.id) { "$($p.id)  —— $($p.name)" } else { $p.id }
        [void]$cbProvider.Items.Add($label)
    }
    # 默认选中当前全局那个
    $want = [string]$snap.current.provider
    $hit = -1
    for ($i = 0; $i -lt $cbProvider.Items.Count; $i++) {
        if (([string]$cbProvider.Items[$i]) -like "$want*") { $hit = $i; break }
    }
    if ($hit -ge 0) { $cbProvider.SelectedIndex = $hit } elseif ($cbProvider.Items.Count -gt 0) { $cbProvider.SelectedIndex = 0 }
}

$cbProvider.Add_SelectedIndexChanged({
    $script:lastProvider = [string]$cbProvider.SelectedItem
    Update-ModelList
})
$cbModel.Add_SelectedIndexChanged({ Update-EffortList })

$btnRefresh.Add_Click({
    Update-StatusView
    Load-Catalog
    $lblMsg.Text = '已刷新'
    $lblMsg.ForeColor = [System.Drawing.Color]::FromArgb(170, 170, 170)
})

$btnFolder.Add_Click({
    if (Test-Path $dataDir) { Start-Process explorer.exe $dataDir }
    else { $lblMsg.Text = "数据目录还不存在：$dataDir"; $lblMsg.ForeColor = [System.Drawing.Color]::FromArgb(210, 153, 34) }
})

$btnClose.Add_Click({ $form.Close() })

$btnApply.Add_Click({
    $providerRaw = [string]$cbProvider.SelectedItem
    $provider = ($providerRaw -split '  —— ')[0].Trim()
    $modelRaw = [string]$cbModel.SelectedItem
    $model = ($modelRaw -split '  —— ')[0].Trim()
    $effort = [string]$cbEffort.SelectedItem

    if (-not $provider -or -not $model) {
        $lblMsg.Text = '先选一个服务商和模型。'
        $lblMsg.ForeColor = [System.Drawing.Color]::FromArgb(248, 81, 73)
        return
    }

    $lblMsg.Text = "正在应用 $provider / $model …"
    $lblMsg.ForeColor = [System.Drawing.Color]::FromArgb(170, 170, 170)
    $form.Refresh()

    $payload = @{ provider = $provider; model = $model }
    if ($effort) { $payload.reasoningEffort = $effort }
    $result = Send-Command 'apply' $payload

    if ($null -eq $result) {
        $lblMsg.Text = '没等到插件回执：DSH 里这个插件可能没在跑。'
        $lblMsg.ForeColor = [System.Drawing.Color]::FromArgb(248, 81, 73)
        return
    }

    $text = if ($result.details) { (@($result.details) -join "`r`n") } else { '' }
    if ($result.ok) {
        $lblMsg.Text = "✅ 生效了`r`n$text"
        $lblMsg.ForeColor = [System.Drawing.Color]::FromArgb(63, 185, 80)
    } else {
        $lblMsg.Text = "⚠ 有问题`r`n$text`r`n$($result.note)"
        $lblMsg.ForeColor = [System.Drawing.Color]::FromArgb(210, 153, 34)
    }
    Start-Sleep -Milliseconds 200
    Update-StatusView
})

# 第一次进来：先让插件写一份新鲜的快照
$null = Send-Command 'refresh' @{}
Update-StatusView
Load-Catalog
$lblMsg.Text = '就绪。选好之后点「应用到全部会话」。'

[void]$form.ShowDialog()
