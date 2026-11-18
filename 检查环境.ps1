param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$root = (Get-Item -LiteralPath $PSScriptRoot).FullName.TrimEnd('\')
$problems = New-Object System.Collections.ArrayList
$notes = New-Object System.Collections.ArrayList

function Add-Problem([string]$text) { [void]$problems.Add($text) }

Write-Output '== 算力沙盘 · 环境检查 =='
Write-Output ('目录：' + $root)

# 1. 操作系统与架构
if (-not [Environment]::Is64BitOperatingSystem) { Add-Problem '当前系统不是 64 位 Windows，本运行包仅支持 Windows x64。' }
$osVersion = [Environment]::OSVersion.VersionString
Write-Output ('系统：' + $osVersion)

# 2. 运行环境定位：随包 runtime 优先，其次源码 .venv
$pythonPath = $null
$runtimePython = Join-Path $root 'runtime\python\python.exe'
$venvPython = Join-Path $root '.venv\Scripts\python.exe'
if (Test-Path -LiteralPath $runtimePython) {
    $pythonPath = $runtimePython
    Write-Output '运行环境：随包 runtime/python（无需系统 Python）'
} elseif (Test-Path -LiteralPath $venvPython) {
    $pythonPath = $venvPython
    Write-Output '运行环境：源码 .venv（开发模式）'
} else {
    Add-Problem '未找到运行环境。请完整解压 Windows 运行包，或在源码目录执行 安装依赖.ps1。'
}

# 3. 关键文件：与当前引擎结构保持一致（模型目录已并入模型基线库，不再有 catalogs/models.json）
$required = @(
    'backend\app\main.py',
    'backend\app\model_registry.py',
    'backend\app\engine\calculator.py',
    'backend\app\engine\business.py',
    'backend\app\engine\inference.py',
    'backend\app\catalogs\__init__.py',
    'backend\app\catalogs\inference_models.json',
    'backend\app\catalogs\inference_chips.json',
    'backend\app\catalogs\inference_scenes.json',
    'frontend\dist\index.html'
)
$missing = @()
foreach ($relative in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $relative))) { $missing += $relative }
}
if ($missing.Count -gt 0) {
    Add-Problem ('缺少文件：' + ($missing -join '、') + '。请重新完整解压运行包，不要只复制启动脚本。')
}

# 4. 网页产物：dist 下必须有 assets 目录与构建后的 JS/CSS
$assets = Join-Path $root 'frontend\dist\assets'
if (Test-Path -LiteralPath $assets) {
    $bundleCount = @(Get-ChildItem -LiteralPath $assets -File -ErrorAction SilentlyContinue).Count
    if ($bundleCount -eq 0) { Add-Problem 'frontend\dist\assets 为空，网页未正确构建，请重新解压或重新构建前端。' }
    else { Write-Output ('网页产物：frontend/dist（' + $bundleCount + ' 个资源文件）') }
} elseif ($missing -notcontains 'frontend\dist\index.html') {
    Add-Problem '缺少 frontend\dist\assets，网页未正确构建。'
}

# 5. Python 版本与依赖
# 探针写成临时文件再执行：PowerShell 5.1 向原生程序传参时会吃掉字符串里的双引号，
# 直接把多行 Python 代码塞进 -c 会变成语法错误。探针只打印 ASCII，避免控制台编码干扰。
if ($pythonPath) {
    $probePath = Join-Path ([System.IO.Path]::GetTempPath()) ('planner-probe-' + [guid]::NewGuid().ToString('N') + '.py')
    $probe = @'
import importlib
import struct
import sys
print("PYTHON=" + sys.version.split()[0] + ";BITS=" + str(struct.calcsize("P") * 8))
mods = ["fastapi", "starlette", "pydantic", "sqlalchemy", "httpx", "uvicorn", "openpyxl", "multipart", "alembic"]
missing = []
for name in mods:
    try:
        importlib.import_module(name)
    except Exception:
        missing.append(name)
print("DEPS=OK" if not missing else "DEPS=MISSING:" + ",".join(missing))
'@
    try {
        Set-Content -LiteralPath $probePath -Value $probe -Encoding ASCII
        $probeOut = @(& $pythonPath $probePath 2>&1 | ForEach-Object { [string]$_ })
    } finally {
        if (Test-Path -LiteralPath $probePath) { Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue }
    }
    $versionLine = $probeOut | Where-Object { $_ -like 'PYTHON=*' } | Select-Object -Last 1
    $depLine = $probeOut | Where-Object { $_ -like 'DEPS=*' } | Select-Object -Last 1
    if ($versionLine) {
        $version = ($versionLine -replace '^PYTHON=', '') -replace ';BITS=', ' / '
        Write-Output ('Python：' + $version + ' 位')
    } else {
        Add-Problem ('随包 Python 无法执行：' + (($probeOut | Select-Object -Last 3) -join ' '))
    }
    if ($depLine -eq 'DEPS=OK') {
        Write-Output '依赖：fastapi / starlette / pydantic / sqlalchemy / httpx / uvicorn / openpyxl / multipart / alembic 均可导入'
    } elseif ($depLine) {
        Add-Problem ('依赖不完整：' + ($depLine -replace '^DEPS=MISSING:', '') + '。请重新完整解压运行包。')
    }

    # 6. 引擎版本：直接读后端常量，避免检查脚本里写死版本号再次过期。
    # 随包 runtime 是 Python 嵌入式分发（._pth 模式），不会把当前目录加入 sys.path，
    # 因此必须显式 insert 后端路径，否则 import app.engine 会失败。
    $backendPath = Join-Path $root 'backend'
    $engineProbe = "import sys; sys.path.insert(0, r'$backendPath'); from app.engine.calculator import ENGINE_VERSION; print(ENGINE_VERSION)"
    try {
        $engine = (@(& $pythonPath -c $engineProbe 2>&1) | Select-Object -Last 1 | ForEach-Object { [string]$_ })
        if ($engine -like 'engine-v*') { Write-Output ('计算引擎：' + $engine) }
        else { Add-Problem ('后端代码无法导入计算引擎：' + $engine) }
    } catch {
        Add-Problem ('后端代码无法导入计算引擎：' + $_.Exception.Message)
    }
}

# 7. 数据目录可写
$dataDir = Join-Path $root 'data'
try {
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    $probeFile = Join-Path $dataDir ('.check-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    Set-Content -LiteralPath $probeFile -Value 'ok' -Encoding ASCII
    Remove-Item -LiteralPath $probeFile -Force
    Write-Output ('数据目录：' + $dataDir + '（可写）')
} catch {
    Add-Problem ('数据目录不可写：' + $dataDir + '。请将运行包放在当前用户可读写的目录。')
}
if (Test-Path -LiteralPath (Join-Path $dataDir 'planner.db')) {
    $sizeMb = [math]::Round((Get-Item -LiteralPath (Join-Path $dataDir 'planner.db')).Length / 1MB, 2)
    Write-Output ('业务数据：data/planner.db（' + $sizeMb + ' MB）')
} else {
    [void]$notes.Add('尚无 data/planner.db，首次启动会自动初始化空工作空间。')
}

# 8. 当前运行状态（读状态文件 + 探活，不启动服务）
$statePath = Join-Path $dataDir 'server.json'
if (Test-Path -LiteralPath $statePath) {
    $state = $null
    try { $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    if ($state -and $null -ne $state.PSObject.Properties['port']) {
        $port = [int]$state.port
        $health = $null
        try { $health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/api/v1/health') -TimeoutSec 2 } catch { }
        if ($health -and $health.status -eq 'ok') {
            Write-Output ('运行状态：正在运行，地址 http://127.0.0.1:' + $port + '，引擎 ' + $health.engine_version)
        } else {
            [void]$notes.Add('状态文件记录的端口 ' + $port + ' 未响应，可能是残留记录；重新启动会自动接管或清理。')
        }
    }
} else {
    [void]$notes.Add('当前未运行（无 data/server.json）。双击 启动.bat 即可启动。')
}

foreach ($note in $notes) { Write-Output ('提示：' + $note) }

if ($problems.Count -gt 0) {
    Write-Output ''
    Write-Output '环境检查未通过：'
    foreach ($item in $problems) { Write-Output ('  - ' + $item) }
    exit 1
}

Write-Output ''
Write-Output '环境检查通过。双击 启动.bat 启动，默认地址 http://127.0.0.1:8000；退出用 停止.bat。'
