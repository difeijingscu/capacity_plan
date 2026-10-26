param([int]$Port = 8000, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if ($Port -lt 1024 -or $Port -gt 65535) { throw '端口必须介于1024和65535。' }
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
$ownedProcess = $null
if ($appState) {
    $candidate = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$appState.process_id)
    if ($candidate -and $candidate.CommandLine -match 'app.main:app' -and $candidate.CommandLine.Contains($PSScriptRoot)) { $ownedProcess = $candidate }
}
if ($ownedProcess -and [int]$appState.port -ne $Port) { throw ('本目录已在端口' + $appState.port + '运行，请先停止服务，再使用其他端口。') }
$appUrl = 'http://127.0.0.1:' + $Port
$alreadyRunning = $false
try { $health = Invoke-RestMethod -Uri ($appUrl + '/api/v1/health') -TimeoutSec 2; $alreadyRunning = $ownedProcess -and $health.status -eq 'ok' -and $health.engine_version -eq 'engine-v1.0.0' } catch {}
if (-not $alreadyRunning) {
    New-Item -ItemType Directory -Path 'data' -Force | Out-Null
    $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    try { $probe.Start() } catch { throw ('端口' + $Port + '已被其他服务占用，请使用启动.ps1 -Port 8008。') } finally { $probe.Stop() }
    $backendPath = Join-Path $PSScriptRoot 'backend'
    $appProcess = Start-Process -FilePath $pythonPath -ArgumentList @('-m','uvicorn','app.main:app','--app-dir',('"' + $backendPath + '"'),'--host','127.0.0.1','--port',"$Port") -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $PSScriptRoot 'data\server.log') -RedirectStandardError (Join-Path $PSScriptRoot 'data\server-error.log')
    [ordered]@{process_id=$appProcess.Id;port=$Port;python_path=$pythonPath;workspace=$PSScriptRoot} | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        Start-Sleep -Milliseconds 300
        if ($appProcess.HasExited) { break }
        try { $health = Invoke-RestMethod -Uri ($appUrl + '/api/v1/health') -TimeoutSec 1; if ($health.status -eq 'ok' -and $health.engine_version -eq 'engine-v1.0.0') { $ready=$true; break } } catch {}
    }
    if (-not $ready) { throw '启动未成功，请查看data\server-error.log；也可换一个端口。' }
}
Write-Output ('算力规划工作台已启动：' + $appUrl)
if (-not $NoBrowser) { Start-Process $appUrl -WindowStyle Hidden }
