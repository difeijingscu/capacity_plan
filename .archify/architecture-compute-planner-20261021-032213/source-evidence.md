# 当前项目架构图：本地源码核对记录

本图依据当前工作目录中的实际源码。该目录未初始化Git，因此没有提交ID或远程仓库，也不声称完成Archify的Git提交级证据校验。以下SHA256仅标识本次核对的文件字节。

| 事实 | 源码与行号 |
|---|---|
| 网页交互、方案保存、异步测算与导入 | [frontend/src/App.tsx:103–157](D:/Coding/算力规划智能体/frontend/src/App.tsx:103) |
| 结果卡片入口 | [frontend/src/App.tsx:159–159](D:/Coding/算力规划智能体/frontend/src/App.tsx:159) |
| 同源HTTP访问与任务轮询 | [frontend/src/api.ts:1–20](D:/Coding/算力规划智能体/frontend/src/api.ts:1) |
| 按测算ID与scope读取推导 | [frontend/src/CalculationDerivation.tsx:28–54](D:/Coding/算力规划智能体/frontend/src/CalculationDerivation.tsx:28) |
| 进程内线程池与运行入口 | [backend/app/main.py:32–40](D:/Coding/算力规划智能体/backend/app/main.py:32) |
| 修订校验与任务状态落库 | [backend/app/main.py:89–110](D:/Coding/算力规划智能体/backend/app/main.py:89) |
| 测算调度、输入与目录快照落库 | [backend/app/main.py:218–245](D:/Coding/算力规划智能体/backend/app/main.py:218) |
| 推导读取入口 | [backend/app/main.py:251–265](D:/Coding/算力规划智能体/backend/app/main.py:251) |
| 导入预览与提交 | [backend/app/main.py:292–322](D:/Coding/算力规划智能体/backend/app/main.py:292) |
| 费用附录与助手配置 | [backend/app/main.py:404–440](D:/Coding/算力规划智能体/backend/app/main.py:404) |
| 可选提案API与规则回退 | [backend/app/main.py:443–489](D:/Coding/算力规划智能体/backend/app/main.py:443) |
| 托管生产前端构建 | [backend/app/main.py:495–504](D:/Coding/算力规划智能体/backend/app/main.py:495) |
| SQLite WAL、统一records表及真实读写 | [backend/app/store.py:19–83](D:/Coding/算力规划智能体/backend/app/store.py:19) |
| 推理与单位工作量计算 | [backend/app/engine/calculator.py:119–209](D:/Coding/算力规划智能体/backend/app/engine/calculator.py:119) |
| 三池独立测算与一次余量 | [backend/app/engine/calculator.py:244–372](D:/Coding/算力规划智能体/backend/app/engine/calculator.py:244) |
| 敏感性分析 | [backend/app/engine/calculator.py:373–393](D:/Coding/算力规划智能体/backend/app/engine/calculator.py:373) |
| 以已保存输入、目录及结果生成推导 | [backend/app/derivations.py:149–172](D:/Coding/算力规划智能体/backend/app/derivations.py:149) |
| 提案白名单、Schema校验及本地规则 | [backend/app/assistant.py:34–71](D:/Coding/算力规划智能体/backend/app/assistant.py:34) |
| 可选模型接口与数值输出约束 | [backend/app/assistant.py:74–94](D:/Coding/算力规划智能体/backend/app/assistant.py:74) |
| 本地回环地址与Uvicorn启动 | [启动.ps1:36–36](D:/Coding/算力规划智能体/启动.ps1:36) |

## 文件标识

| 文件 | SHA256 |
|---|---|
| frontend/src/App.tsx | b8df4cf9980da056b469d9b2746d57f5364afb959d144bbc610e6cc1435bcff1 |
| frontend/src/api.ts | 07e9100666e0d84eef7fe8571e23ddc325d54b611932b351b27c3c459353232e |
| frontend/src/CalculationDerivation.tsx | ca1433c3512d300551f52adf832a1f0127421787070da3ad014f04e2f0539c23 |
| backend/app/main.py | 446e4e30b7d15e11ada36004f1dd3094b5f0baaaa8c4713d01235c655f2c864a |
| backend/app/store.py | 6d14181846c1973976ec03bb10eac21332d5ec1652d5b2cc6fc54df61c0158e8 |
| backend/app/engine/calculator.py | 7c97ebd87696a203b32874b7f62e457dfba2bbb53b382e2c5e31ac0b9de6af86 |
| backend/app/derivations.py | 5e27d79be5efd225709bd1eca8f96450b8f63cf500e8edb7624ab8b36995d584 |
| backend/app/assistant.py | fd36b28c15f0838f154f45cf296400c3e956aace47d3c0c7ab1dfe91c858522a |
| 启动.ps1 | f312e897dfb5deea6b3ba5b1f27fb09002bb602e5886a91bca899cd228f6cd6e |
