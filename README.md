# 算力规划工作台

单用户、本机运行的算力规划网页应用。支持业务场景、创新服务、开发测试三个独立资源池，采用固定公式和可追溯参数进行早期估算。

## 启动

迁移到另一台Windows机器，请优先阅读根目录的《项目说明与Windows部署指南.html》或同名Markdown文档。Windows运行包内置Python运行环境和已构建网页，完整解压后双击启动.bat即可，无需安装Python、Node.js或Git。检查环境.bat与停止.bat分别用于诊断和退出。

当前工作区的依赖与网页构建已准备完成。双击根目录的 **启动.bat**，浏览器将打开：

[http://127.0.0.1:8000](http://127.0.0.1:8000)

也可以在本目录的PowerShell中运行：

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\启动.ps1
~~~

若8000端口已被占用：

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\启动.ps1 -Port 8008
~~~

停止由启动脚本启动的后台服务：

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\停止.ps1
~~~

仅使用源码安装（目录内没有runtime）时，建议使用Python 3.13、Node.js 22.12或更新的兼容版本，执行：

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\安装依赖.ps1 -SkipBrowser
~~~

安装脚本使用锁定依赖并构建网页。浏览器自动化仅供开发测试，日常使用不需要安装Playwright浏览器。

## 快速使用

1. 打开项目概览，选择“载入示例项目”体验完整流程，或新建空项目。
2. 在业务场景页上传.xlsx或粘贴清单，检查类型、模型、在线人数或视频路数。
3. 根据需要设置创新服务人数、每人月Token及模型份额；开启开发测试并选择强度。
4. 保存方案并开始测算。在结果页查看三池规模、场景汇总、显存、计算依据和敏感性。
5. 复制方案或修改参数重新计算，比较历史结果。每次计算保留不可变输入和模型快照。
6. 如需粗略费用，先在基线与设置中录入来源明确的人民币单卡报价，再生成费用附录。

## 核心能力

- Excel与文字导入，工作表/表头选择、列映射、单位转换、原始行追踪、重复导入保护。
- 多场景与多计算组件；文本、图文、CV检测及自定义单位任务。
- 分阶段prefill/decode公式，MoE激活参数与驻留参数分离。
- 同池兼容模型共享权重，三池各自保留资源；开发测试按槽位聚合。
- 月度Token配额换算，模型份额守恒；开发测试轻度/标准/高强度档位。
- Decimal计算、来源记录、缺失值保留、完整性与依据等级分离。
- SQLite保存项目、历史输入、计算快照、任务状态、基线及报价。
- 参数默认值与说明、版本冲突保护、可撤销操作。
- 规划依据与规划方案组织设计说明，帮助理解计算方法和数据归属。
- 网页结果、敏感性、版本比较、参考卡与价格区间。
- 四张结果卡片支持展开具体数值推导，按当前所选测算快照解释输入、峰值、效率、结构修正、余量与槽位聚合。

## AI设置

当前业务场景页面已移除规划助手，日常规划无需配置AI接口。下述设置仅为保留的后端扩展提供连接信息。

在“基线与设置 → AI连接设置”填写完整对话接口地址、模型名称和可选API Key。接口需支持messages输入和JSON结构化回答，返回choices[0].message.content。

API Key只保留于服务端进程内存；重启后可重新填写，或在启动前设置环境变量PLANNER_AI_KEY。不会将密钥写入数据库、日志或方案快照。

所有业务参数可在页面手动配置并采用默认值；固定计算公式独立于AI接口。实际第三方AI接口需用自己的服务验证。

## 数据与备份

默认数据库位于data/planner.db，支持使用PLANNER_DATA_DIR指定独立数据目录。首次启动自动初始化结构与发布种子模型；结构迁移文件位于backend/migrations。

备份时先停止服务，再复制整个data目录；恢复时将备份放回相同目录后启动。SQLite的WAL日志也属于数据状态，运行中不要只复制单个.db文件。

data/server.log与server-error.log记录服务运行信息。服务默认只监听127.0.0.1。

## 开发与验证

~~~powershell
# 后端与计算引擎
cd backend
..\.venv\Scripts\python.exe -m pytest -q

# 前端
cd ..\frontend
npm ci
npm test
npm run build
npm run test:e2e
~~~

端到端测试在8010端口启动独立服务，并在data/e2e-*目录隔离测试数据，不修改日常项目。优先使用已安装的Edge；没有Edge时执行npx playwright install chromium。

开发模式：后端使用uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000；前端在frontend目录运行npm run dev，接口通过Vite代理转发。

数据库迁移：

~~~powershell
cd backend
..\.venv\Scripts\python.exe -m alembic upgrade head
~~~

## 口径与当前边界

P16/T16指本产品定义的参考BF16稠密等效规划算力；不同原生精度不会按位宽自动换算。效率、请求频次、档位与部分显存预算属于C级经验假设。所有结果用于早期规划，响应时间和设备互联条件需要后续实测校准。

缺少可靠基线的任务保留并标记未计入，不以0补齐。图文模型使用明确标记的视觉与混合缓存代理；特殊压缩缓存可只给权重下界。QLoRA没有量化元数据预算时会显示待补基线。

参考卡价格初始为空。费用仅含加速卡购置，未核验大陆实际供给、互联拓扑或整机配置。当前实现不包含账号审批、设备部署、真实Token发放和文档导出。

设计依据及开发任务见docs目录；验证结果见[测试报告](docs/测试报告.md)，核验来源见[模型基线核验](docs/模型基线核验.md)。
