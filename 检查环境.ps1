$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not [Environment]::Is64BitOperatingSystem) { throw '此运行包适用于64位Windows。' }
$pythonPath = Join-Path $PSScriptRoot 'runtime\python\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) { $pythonPath = Join-Path $PSScriptRoot '.venv\Scripts\python.exe' }
if (-not (Test-Path -LiteralPath $pythonPath)) { throw '未找到运行环境，请完整解压Windows运行包或执行安装依赖.ps1。' }
foreach ($file in @('backend\app\main.py','frontend\dist\index.html','backend\app\catalogs\models.json')) {
    if (-not (Test-Path -LiteralPath $file)) { throw ('缺少文件：' + $file) }
}
& $pythonPath -c "import sys,struct,sqlite3,fastapi,uvicorn,sqlalchemy,pydantic,openpyxl,alembic; print('Python:',sys.version.split()[0]); print('Architecture:',struct.calcsize('P')*8); print('Application dependencies: OK')"
if ($LASTEXITCODE -ne 0) { throw '运行环境检查未通过，请查看上方错误。' }
Write-Output '环境检查通过。请双击启动.bat；网页地址为http://127.0.0.1:8000。'
