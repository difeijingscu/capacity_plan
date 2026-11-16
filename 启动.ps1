param([int]$Port = 8000, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
# Windows PowerShell 5.1 在进程环境里同时存在 http_proxy / HTTP_PROXY 时，
# Start-Process 会抛 "Item has already been added" 导致服务起不来。
# 本服务只监听本地端口，清掉进程级代理变量不影响功能。
foreach ($proxyKey in 'HTTP_PROXY','HTTPS_PROXY','NO_PROXY','ALL_PROXY') {
    try { [Environment]::SetEnvironmentVariable($proxyKey, $null, 'Process') } catch { }
}
if ($Port -lt 1024 -or $Port -gt 65535) { throw '端口必须介于1024和65535。' }

# 判断进程是否就是本项目启动的服务，避免误杀同机其他程序。
function Test-OurServer([int]$targetId) {
    if ($targetId -le 0) { return $false }
    $candidate = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $targetId) -ErrorAction SilentlyContinue
    if (-not $candidate) { return $false }
    if (-not $candidate.CommandLine) { return $false }
    if (-not $candidate.CommandLine.Contains($PSScriptRoot)) { return $false }
    return [bool]($candidate.CommandLine -match 'app\.main:app')
}

# 真正监听端口的进程。venv 的 python.exe 是转发壳，会再派生真实解释器；
# 只记 Start-Process 返回的 pid 会停在壳上，停止时杀掉壳、子进程仍占着端口。
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

$portablePython = Join-Path $PSScriptRoot 'runtime\python\python.exe'
$sourcePython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (Test-Path -LiteralPath $portablePython) {
    $pythonPath = $portablePython
} else {
    if (-not (Test-Path -LiteralPath $sourcePython) -or -not (Test-Path -LiteralPath 'frontend\dist\index.html')) {
        & (Join-Path $PSScriptRoot '安装依赖.ps1') -SkipBrowser
    }
    $pythonPath = $sourcePython
}
if (-not (Test-Path -LiteralPath 'frontend\dist\index.html')) { throw '缺少网页文件，请重新完整解压项目包。' }
New-Item -ItemType Directory -Path 'data' -Force | Out-Null
$statePath = Join-Path $PSScriptRoot 'data\server.json'
$appState = $null
if (Test-Path -LiteralPath $statePath) {
    try { $appState = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
}
$storedId = 0
$storedLauncher = 0
if ($appState) {
    try { $storedId = [int]$appState.process_id } catch { $storedId = 0 }
    if ($null -ne $appState.PSObject.Properties['launcher_id']) {
        try { $storedLauncher = [int]$appState.launcher_id } catch { $storedLauncher = 0 }
    }
    if ($storedId -gt 0 -and (Test-OurServer $storedId) -and [int]$appState.port -ne $Port) {
        throw ('本目录已在端口' + $appState.port + '运行，请先停止服务，再使用其他端口。')
    }
}
$appUrl = 'http://127.0.0.1:' + $Port
$listenerId = Get-ListenerProcessId $Port
$alreadyRunning = $false
if ($listenerId -gt 0) {
    if (Test-OurServer $listenerId) {
        $health = $null
        try { $health = Invoke-RestMethod -Uri ($appUrl + '/api/v1/health') -TimeoutSec 2 } catch {}
        if ($health -and $health.status -eq 'ok') {
            $alreadyRunning = $true
        } else {
            Write-Output '检测到本项目残留的服务进程未响应，正在重新启动。'
            try { Stop-Process -Id $listenerId -Force -ErrorAction Stop } catch {}
            Start-Sleep -Milliseconds 600
            $listenerId = 0
        }
    } else {
        throw ('端口' + $Port + '已被其他程序占用，请使用启动.ps1 -Port 8008。')
    }
}
$launcherId = $storedLauncher
if (-not $alreadyRunning) {
    $backendPath = Join-Path $PSScriptRoot 'backend'
    $errorLog = Join-Path $PSScriptRoot 'data\server-error.log'
    if (Test-Path -LiteralPath $errorLog) { try { Remove-Item -LiteralPath $errorLog -Force } catch {} }
    $appProcess = Start-Process -FilePath $pythonPath -ArgumentList @('-m','uvicorn','app.main:app','--app-dir',('"' + $backendPath + '"'),'--host','127.0.0.1','--port',"$Port") -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $PSScriptRoot 'data\server.log') -RedirectStandardError $errorLog
    $launcherId = $appProcess.Id
    # 就绪判定只看健康状态，不比对引擎版本号：版本号一旦写死，每次引擎升级都会让启动脚本误判失败。
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        Start-Sleep -Milliseconds 300
        if ($appProcess.HasExited) { break }
        try { $health = Invoke-RestMethod -Uri ($appUrl + '/api/v1/health') -TimeoutSec 1; if ($health.status -eq 'ok') { $ready = $true; break } } catch {}
    }
    if (-not $ready) { throw '启动未成功，请查看data\server-error.log；也可换一个端口。' }
    $listenerId = Get-ListenerProcessId $Port
    if ($listenerId -le 0) { $listenerId = $appProcess.Id }
}
[ordered]@{process_id=$listenerId;launcher_id=$launcherId;port=$Port;python_path=$pythonPath;workspace=$PSScriptRoot;engine_version=$health.engine_version} | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
Write-Output ('算力沙盘已启动：' + $appUrl)
if (-not $NoBrowser) { Start-Process $appUrl -WindowStyle Hidden }
