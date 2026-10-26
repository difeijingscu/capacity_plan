$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$statePath = Join-Path $PSScriptRoot 'data\server.json'
if (-not (Test-Path -LiteralPath $statePath)) { Write-Output '没有由启动脚本记录的服务。'; return }
$appState = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
$appProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$appState.process_id)
if ($appProcess -and $appProcess.CommandLine -match 'uvicorn' -and $appProcess.CommandLine -match 'app.main:app' -and $appProcess.CommandLine.Contains($PSScriptRoot)) {
    Stop-Process -Id ([int]$appState.process_id)
    Remove-Item -LiteralPath $statePath -Force
    Write-Output '本项目服务已停止。'
} else { Write-Output '原服务已退出，未停止其他进程。' }
