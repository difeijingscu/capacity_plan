param([switch]$SkipBrowser)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if ((Test-Path -LiteralPath 'runtime\python\python.exe') -and (Test-Path -LiteralPath 'frontend\dist\index.html')) {
    & '.\runtime\python\python.exe' -c "import fastapi, uvicorn, sqlalchemy, pydantic, openpyxl, alembic"
    if ($LASTEXITCODE -ne 0) { throw '随包运行环境不完整，请重新完整解压Windows运行包。' }
    Write-Output '随包运行环境与网页已准备完成，无需安装依赖。请双击启动.bat。'
    return
}
if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) {
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python环境创建失败，请安装Python 3.11或更新版本。' }
}
& '.\.venv\Scripts\python.exe' -m pip install -r 'backend\requirements.lock.txt'
if ($LASTEXITCODE -ne 0) { throw 'Python依赖安装失败。' }
Push-Location -LiteralPath 'frontend'
try {
    npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw '前端依赖安装失败。' }
    npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw '前端构建失败。' }
    if (-not $SkipBrowser) {
        npm.cmd exec playwright install chromium
        if ($LASTEXITCODE -ne 0) { Write-Warning '浏览器测试运行时未安装；可使用已安装的Edge运行端到端测试。' }
    }
} finally { Pop-Location }
New-Item -ItemType Directory -Path 'data' -Force | Out-Null
Push-Location -LiteralPath 'backend'
try { & '..\.venv\Scripts\python.exe' -m alembic upgrade head } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw '数据库迁移失败。' }
Write-Output '依赖与网页准备完成。运行 启动.ps1 或双击 启动.bat。'
