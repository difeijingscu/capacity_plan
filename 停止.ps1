$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$root = (Get-Item -LiteralPath $PSScriptRoot).FullName.TrimEnd('\')
$statePath = Join-Path $root 'data\server.json'

# 路径比较统一归一化：斜杠统一、去尾部分隔符、不区分大小写。
# 直接 Contains 是区分大小写的，盘符或目录大小写不一致时会漏判。
function Get-NormalizedText([string]$text) {
    if (-not $text) { return '' }
    return $text.Replace('/', '\').TrimEnd('\').ToLowerInvariant()
}

function Get-CmdLine([int]$processId) {
    if ($processId -le 0) { return '' }
    try {
        $candidate = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $processId) -ErrorAction SilentlyContinue
        if ($candidate -and $candidate.CommandLine) { return [string]$candidate.CommandLine }
    } catch { }
    return ''
}

# 返回 ours / other-sandbox / foreign / gone
function Get-ServerKind([int]$processId) {
    if ($processId -le 0) { return 'gone' }
    $cmd = Get-CmdLine $processId
    if (-not $cmd) { return 'gone' }
    if ($cmd -notmatch 'app\.main:app') { return 'foreign' }
    if ((Get-NormalizedText $cmd).Contains((Get-NormalizedText $root))) { return 'ours' }
    return 'other-sandbox'
}

# venv 的 python.exe 是转发壳，会派生真实解释器；只杀壳会留下占端口的子进程。
function Get-ProcessTree([int]$rootId) {
    $ids = New-Object System.Collections.ArrayList
    if ($rootId -le 0) { return @() }
    try { $all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue } catch { return @($rootId) }
    $seen = @{}
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue([int]$rootId)
    while ($queue.Count -gt 0) {
        $current = [int]$queue.Dequeue()
        if ($seen.ContainsKey($current)) { continue }
        $seen[$current] = $true
        [void]$ids.Add($current)
        foreach ($proc in $all) {
            if ([int]$proc.ParentProcessId -eq $current) { $queue.Enqueue([int]$proc.ProcessId) }
        }
    }
    return $ids
}

function Get-ListenerProcessId([int]$targetPort) {
    if ($targetPort -le 0) { return 0 }
    try {
        $conn = Get-NetTCPConnection -LocalPort $targetPort -State Listen -ErrorAction Stop | Select-Object -First 1
        if ($conn) { return [int]$conn.OwningProcess }
    } catch { }
    try {
        foreach ($line in (netstat -ano)) {
            if ($line -match ('^\s*TCP\s+\S+:' + $targetPort + '\s+\S+\s+LISTENING\s+(\d+)')) { return [int]$Matches[1] }
        }
    } catch { }
    return 0
}

$appState = $null
if (Test-Path -LiteralPath $statePath) {
    try { $appState = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $appState = $null }
}
$recordedPort = 8000
$recordedIds = @()
if ($appState) {
    foreach ($field in 'port','process_id','launcher_id','pid') {
        if ($null -eq $appState.PSObject.Properties[$field]) { continue }
        $value = 0
        try { $value = [int]$appState.$field } catch { $value = 0 }
        if ($value -le 0) { continue }
        if ($field -eq 'port') { $recordedPort = $value } else { $recordedIds += $value }
    }
}

# 端口监听者是最终依据：状态文件里的 pid 可能已失效、被系统复用或格式过旧。
$candidates = New-Object System.Collections.ArrayList
foreach ($id in $recordedIds) { [void]$candidates.Add($id) }
foreach ($port in @($recordedPort, 8000) | Select-Object -Unique) {
    $listenerId = Get-ListenerProcessId $port
    if ($listenerId -gt 0) { [void]$candidates.Add($listenerId) }
}

$killIds = New-Object System.Collections.ArrayList
$notes = New-Object System.Collections.ArrayList
foreach ($candidateId in ($candidates | Select-Object -Unique)) {
    $kind = Get-ServerKind $candidateId
    if ($kind -eq 'ours') {
        foreach ($treeId in (Get-ProcessTree $candidateId)) {
            if (-not $killIds.Contains($treeId)) { [void]$killIds.Add($treeId) }
        }
        continue
    }
    if ($kind -eq 'other-sandbox') {
        [void]$notes.Add('端口被另一个算力沙盘实例占用（pid ' + $candidateId + '，目录与当前不一致），未自动结束。')
    }
}

$killed = @()
foreach ($killId in ($killIds | Sort-Object -Descending)) {
    try { Stop-Process -Id $killId -Force -ErrorAction Stop; $killed += $killId } catch { [void]$notes.Add('结束进程 ' + $killId + ' 失败：' + $_.Exception.Message) }
}

# 端口彻底释放才算停好；进程退出到端口释放之间会有短暂延迟。
$portsToCheck = @($recordedPort, 8000) | Select-Object -Unique
for ($attempt = 0; $attempt -lt 15; $attempt++) {
    $busy = @()
    foreach ($port in $portsToCheck) { if ((Get-ListenerProcessId $port) -gt 0) { $busy += $port } }
    if ($busy.Count -eq 0) { break }
    Start-Sleep -Milliseconds 200
}

$remaining = @()
$remainingIds = @()
foreach ($port in $portsToCheck) {
    $listenerId = Get-ListenerProcessId $port
    if ($listenerId -gt 0) {
        $remaining += ('端口' + $port + '仍被 pid ' + $listenerId + ' 占用')
        $remainingIds += $listenerId
    }
}

foreach ($note in $notes) { Write-Output $note }

if ($remaining.Count -gt 0) {
    # 残留时不删状态文件，保留线索供下次启动或人工排查。
    Write-Output '未能完全停止本项目服务：'
    foreach ($item in $remaining) { Write-Output ('  ' + $item) }
    Write-Output ('可手动结束：Stop-Process -Id ' + ($remainingIds -join ',') + ' -Force')
    Write-Output ('状态文件保留在：' + $statePath)
    exit 1
}

if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath -Force }
if ($killed.Count -gt 0) { Write-Output ('本项目服务已停止（pid ' + ($killed -join '、') + '）。') }
else { Write-Output '没有正在运行的本项目服务。' }
