param([int]$Port = 8000, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$root = (Get-Item -LiteralPath $PSScriptRoot).FullName.TrimEnd('\')
# Windows PowerShell 5.1 在进程环境里同时存在 http_proxy / HTTP_PROXY 时，
# Start-Process 会抛 "Item has already been added" 导致服务起不来。
# 本服务只监听本地端口，清掉进程级代理变量不影响功能。
foreach ($proxyKey in 'HTTP_PROXY','HTTPS_PROXY','NO_PROXY','ALL_PROXY') {
    try { [Environment]::SetEnvironmentVariable($proxyKey, $null, 'Process') } catch { }
}
if ($Port -lt 1024 -or $Port -gt 65535) { throw '端口必须介于1024和65535。' }

# 路径比较统一归一化：斜杠统一、去尾部分隔符、不区分大小写。
# 直接 Contains 区分大小写，盘符或目录大小写不一致时会漏判。
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

function Get-ProcessName([int]$processId) {
    if ($processId -le 0) { return '未知' }
    try { return (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch { return '未知' }
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

# 真正监听端口的进程。Start-Process 返回的 pid 停在壳上，停止时杀壳会留下仍占端口的子进程。
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

$portablePython = Join-Path $root 'runtime\python\python.exe'
$sourcePython = Join-Path $root '.venv\Scripts\python.exe'
if (Test-Path -LiteralPath $portablePython) {
    $pythonPath = $portablePython
} else {
    if (-not (Test-Path -LiteralPath $sourcePython) -or -not (Test-Path -LiteralPath 'frontend\dist\index.html')) {
        & (Join-Path $root '安装依赖.ps1') -SkipBrowser
    }
    $pythonPath = $sourcePython
}
if (-not (Test-Path -LiteralPath 'frontend\dist\index.html')) { throw '缺少网页文件，请重新完整解压项目包。' }
New-Item -ItemType Directory -Path 'data' -Force | Out-Null
$statePath = Join-Path $root 'data\server.json'
$appState = $null
if (Test-Path -LiteralPath $statePath) {
    try { $appState = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
}
$storedId = 0
$storedPort = 0
if ($appState) {
    # 兼容旧版状态文件：早期只写 pid，没有 process_id / launcher_id。
    foreach ($field in 'process_id','launcher_id','pid') {
        if ($storedId -gt 0) { break }
        if ($null -eq $appState.PSObject.Properties[$field]) { continue }
        try { $storedId = [int]$appState.$field } catch { $storedId = 0 }
    }
    if ($null -ne $appState.PSObject.Properties['port']) {
        try { $storedPort = [int]$appState.port } catch { $storedPort = 0 }
    }
    if ($storedId -gt 0 -and $storedPort -gt 0 -and $storedPort -ne $Port -and (Get-ServerKind $storedId) -eq 'ours') {
        throw ('本目录已在端口' + $storedPort + '运行，请先执行 .\停止.ps1，再使用其他端口。')
    }
}
$appUrl = 'http://127.0.0.1:' + $Port
$listenerId = Get-ListenerProcessId $Port
$alreadyRunning = $false
if ($listenerId -gt 0) {
    $kind = Get-ServerKind $listenerId
    if ($kind -eq 'ours') {
        $health = $null
        try { $health = Invoke-RestMethod -Uri ($appUrl + '/api/v1/health') -TimeoutSec 2 } catch {}
        if ($health -and $health.status -eq 'ok') {
            # 状态文件丢失或 pid 失效时，按端口接管现有服务，避免误报端口被占用。
            $alreadyRunning = $true
            if ($storedId -ne $listenerId) { Write-Output ('检测到本目录服务已在运行，接管现有进程（pid ' + $listenerId + '）。') }
        } else {
            Write-Output '检测到本项目残留的服务进程未响应，正在重新启动。'
            foreach ($treeId in (Get-ProcessTree $listenerId)) {
                try { Stop-Process -Id $treeId -Force -ErrorAction Stop } catch {}
            }
            for ($attempt = 0; $attempt -lt 15; $attempt++) {
                Start-Sleep -Milliseconds 200
                if ((Get-ListenerProcessId $Port) -le 0) { break }
            }
            $listenerId = Get-ListenerProcessId $Port
        }
    } elseif ($kind -eq 'other-sandbox') {
        $otherCmd = Get-CmdLine $listenerId
        throw ('端口' + $Port + '被另一个算力沙盘实例占用（pid ' + $listenerId + '，命令行：' + $otherCmd + '）。请先在该目录执行 .\停止.ps1，或使用 .\启动.ps1 -Port 8008。')
    } else {
        throw ('端口' + $Port + '已被其他程序占用（pid ' + $listenerId + '，进程 ' + (Get-ProcessName $listenerId) + '）。请关闭该程序，或使用 .\启动.ps1 -Port 8008。')
    }
}
$launcherId = 0
if ($appState -and $null -ne $appState.PSObject.Properties['launcher_id']) {
    try { $launcherId = [int]$appState.launcher_id } catch { $launcherId = 0 }
}
if (-not $alreadyRunning) {
    $backendPath = Join-Path $root 'backend'
    $errorLog = Join-Path $root 'data\server-error.log'
    if (Test-Path -LiteralPath $errorLog) { try { Remove-Item -LiteralPath $errorLog -Force } catch {} }
    $appProcess = Start-Process -FilePath $pythonPath -ArgumentList @('-m','uvicorn','app.main:app','--app-dir',('"' + $backendPath + '"'),'--host','127.0.0.1','--port',"$Port") -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $root 'data\server.log') -RedirectStandardError $errorLog
    $launcherId = $appProcess.Id
    # 就绪判定只看健康状态，不比对引擎版本号：版本号一旦写死，每次引擎升级都会让启动脚本误判失败。
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        Start-Sleep -Milliseconds 300
        if ($appProcess.HasExited) { break }
        try { $health = Invoke-RestMethod -Uri ($appUrl + '/api/v1/health') -TimeoutSec 1; if ($health.status -eq 'ok') { $ready = $true; break } } catch {}
    }
    if (-not $ready) { throw '启动未成功，请查看 data\server-error.log；也可换一个端口。' }
    $listenerId = Get-ListenerProcessId $Port
    if ($listenerId -le 0) { $listenerId = $appProcess.Id }
}
[ordered]@{process_id=$listenerId;launcher_id=$launcherId;port=$Port;python_path=$pythonPath;workspace=$root;engine_version=$health.engine_version} | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
Write-Output ('算力沙盘已启动：' + $appUrl)
if (-not $NoBrowser) { Start-Process $appUrl -WindowStyle Hidden }
