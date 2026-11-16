$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$statePath = Join-Path $PSScriptRoot 'data\server.json'
if (-not (Test-Path -LiteralPath $statePath)) { Write-Output '没有由启动脚本记录的服务。'; return }
$appState = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json

# 判断进程是否就是本项目启动的服务，避免误杀同机其他程序。
function Test-OurServer([int]$targetId) {
    if ($targetId -le 0) { return $false }
    $candidate = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $targetId) -ErrorAction SilentlyContinue
    if (-not $candidate) { return $false }
    if (-not $candidate.CommandLine) { return $false }
    if (-not $candidate.CommandLine.Contains($PSScriptRoot)) { return $false }
    return [bool]($candidate.CommandLine -match 'app\.main:app')
}

function Get-ListenerProcessId([int]$targetPort) {
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

# process_id 记录真实监听进程，launcher_id 记录 venv 的转发壳；两个都尝试结束。
$targets = @()
foreach ($field in 'process_id','launcher_id') {
    if ($null -eq $appState.PSObject.Properties[$field]) { continue }
    $value = 0
    try { $value = [int]$appState.$field } catch { $value = 0 }
    if ($value -gt 0) { $targets += $value }
}
$stopped = $false
foreach ($targetId in $targets) {
    if (Test-OurServer $targetId) {
        try { Stop-Process -Id $targetId -Force -ErrorAction Stop; $stopped = $true } catch {}
    }
}
# 状态文件里的 pid 已失效但端口仍被本项目服务占用时，按端口兜底清理。
if (-not $stopped -and $appState.port) {
    $listenerId = Get-ListenerProcessId ([int]$appState.port)
    if (Test-OurServer $listenerId) {
        try { Stop-Process -Id $listenerId -Force -ErrorAction Stop; $stopped = $true } catch {}
    }
}
Remove-Item -LiteralPath $statePath -Force
if ($stopped) { Write-Output '本项目服务已停止。' } else { Write-Output '原服务已退出，未停止其他进程。' }
