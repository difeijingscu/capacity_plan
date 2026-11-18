import { Alert, Card, Collapse, Descriptions, Steps, Table, Tabs, Tag } from 'antd';
import type { ReactNode } from 'react';
import { num } from './api';
import type { Obj } from './api';

/**
 * 规划依据页：三池计算口径的说明页。
 *
 * 这一页不是营销文案，它与后端实现是「同一套口径的两种表达」，改动引擎时必须同步这里：
 * - `app/engine/inference.py` 的 A/B/C 三维约束（业务池逐场景出卡）；
 * - `app/engine/business.py` 的 `planned_cards`（奇数补偶、8 卡最小部署单元）；
 * - `app/engine/calculator.py` 的 `pool_summary`（三池 planned_p = base_p）与
 *   `cards_for_pool`（创新/研发池卡数 = max(算力卡数, 显存卡数)，不按整机对齐）；
 * - 创新池额度守恒与研发池槽位聚合。
 * 因此本页不写「方案余量」「+1 张故障冗余」「台数 = 卡数 ÷ 8（整池）」这类已失效口径。
 */
const references = [
  { id: 'scaling', name: 'Scaling Laws for Neural Language Models · §2.1 / 表1', url: 'https://arxiv.org/html/2001.08361v1#S2.SS1', kind: '研究论文', purpose: 'Transformer 前向工作量按「2 × 参数量 × Token」近似的依据；创新池与研发池的分阶段工作量沿用该口径。' },
  { id: 'metrics', name: 'NVIDIA GenAI-Perf · Metrics', url: 'https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/perf_benchmark/genai-perf-README.html#metrics', kind: '官方文档', purpose: '输入/输出长度、吞吐与响应延迟的计量定义，用于后续性能校准。' },
  { id: 'paged', name: 'Efficient Memory Management for LLMs with PagedAttention', url: 'https://arxiv.org/abs/2309.06180', kind: '研究论文', purpose: '显存按「权重 + KV cache + 运行开销」划分与 KV 分块管理的依据；A 约束的可用显存与 KV 房间口径参考该文。' },
  { id: 'gqa', name: 'GQA: Training Generalized Multi-Query Transformer Models', url: 'https://arxiv.org/abs/2305.13245', kind: '研究论文', purpose: '每 Token KV 按 KV 头数折算（GQA/MQA 压缩 KV cache）的依据。' },
  { id: 'dsv3', name: 'DeepSeek-V3 Technical Report', url: 'https://arxiv.org/abs/2412.19437', kind: '技术报告', purpose: 'MLA 用低秩 latent 压缩 KV cache 的架构依据；本工具按「层数 × (低秩维 + RoPE 维)」计每 Token KV。' },
  { id: 'arith', name: 'Transformer Inference Arithmetic', url: 'https://kipp.ly/transformer-inference-arithmetic/', kind: '工程分析', purpose: 'Decode 每步需重读权重、TPOT 受 HBM 带宽约束的推导；C 约束的带宽下限口径参考。' },
  { id: 'sarathi', name: 'Sarathi-Serve: Efficient LLM Inference via Chunked Prefills', url: 'https://arxiv.org/abs/2403.02310', kind: '研究论文', purpose: 'Prefill 与 Decode 混部时的相互干扰；C 约束里 0.4 的重叠惩罚项参考该分析，属工程经验系数。' },
  { id: 'lora', name: 'LoRA: Low-Rank Adaptation of Large Language Models', url: 'https://arxiv.org/abs/2106.09685', kind: '研究论文', purpose: '冻结基础权重并训练低秩适配器的方法依据；不证明微调工作量恒为 4ND。' },
  { id: 'peft', name: 'Hugging Face PEFT · LoRA', url: 'https://huggingface.co/docs/peft/main/en/conceptual_guides/lora', kind: '官方文档', purpose: 'LoRA 机制和适配器参数的解释；训练显存仍需结合实际配置校准。' },
];

function Source({ id }: { id: string }) {
  const source = references.find(r => r.id === id)!;
  return <a className="basis-source-link" href={source.url} target="_blank" rel="noreferrer">{source.name} ↗</a>;
}
function Formula({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return <div className="basis-formula"><span>{title}</span><div>{children}</div>{note && <small>{note}</small>}</div>;
}
function Variables({ rows }: { rows: [string, string, string][] }) {
  return <Table<{ symbol: string; meaning: string; unit: string }> size="small" pagination={false} rowKey="symbol" dataSource={rows.map(([symbol, meaning, unit]) => ({ symbol, meaning, unit }))} columns={[{ title: '符号', dataIndex: 'symbol', width: 110 }, { title: '含义', dataIndex: 'meaning' }, { title: '单位 / 口径', dataIndex: 'unit', width: 190 }]} scroll={{ x: 600 }} />;
}
function Provenance({ children }: { children: ReactNode }) {
  return <div className="basis-provenance"><strong>依据与适用范围</strong>{children}</div>;
}

export default function PlanningBasis({ defaults, models }: { defaults: Obj; models: Obj[] }) {
  const task = defaults.task_defaults || {};
  const training = defaults.development_defaults || {};
  const businessDefault = defaults.business_defaults || {};
  // 新建方案的精度默认值（BusinessDefaults.weight_precision）：页面不再写死 W8A8。
  const precisionDefault = String(businessDefault.weight_precision || 'w8a8').toUpperCase();
  const innovation = defaults.innovation_defaults || {};
  const allocation = (innovation.allocations || [])[0] || {};

  const percent = (value: unknown) => value == null ? '以当前配置为准' : num(Number(value) * 100) + '%';
  const value = (raw: unknown, fallback: string) => raw == null ? fallback : num(Number(raw), 4);
  const referenceModels = models.filter(m => !m.is_demo);
  const presetRows = Object.entries(defaults.templates || {}).map(([key, item]) => {
    const names: Obj = { qa: '知识问答', extract: '抽取/分类', document: '文档分析', report: '长报告/复杂推理', vision: '图文问答' };
    return { id: key, name: names[key] || key, ...(item as Obj) };
  });

  const overview = <div className="basis-content">
    <Card title="先理解：我们规划的是什么？">
      <p>本工具把业务规模换算成计算能力：先描述业务与模型，再把请求、Token 与微调任务换算成工作量，最后按显存、时延与效率约束落到卡数与容量。</p>
      <p>所有输入按<strong>当前峰值规模</strong>理解，不引入规划年限、年增长率等时间外推参数。三个资源池<strong>独立配置、各自出卡、分别换算容量</strong>，三池都不叠加方案余量、也不额外补故障冗余；采购侧的冗余（N+1、备件与突发）由使用方在结果之外按 SLA 另行决定。</p>
      <div className="basis-pool-grid">{[
        ['01', '业务场景', '支撑已规划的具体应用', '在线会话、模型、精度、输入输出与响应目标'],
        ['02', '创新服务', '提供灵活可用的模型服务池', '支持人数、人均月Token、使用率与服务窗口'],
        ['03', '开发测试', '按需支撑模型微调', '候选模型、微调强度与并行槽位'],
      ].map(([index, name, purpose, inputs]) => <div key={name}><span>{index}</span><h3>{name}</h3><p>{purpose}</p><small>{inputs}</small></div>)}</div>
      <Steps className="basis-steps" responsive items={[{ title: '定义业务规模', description: '场景、额度与微调任务' }, { title: '匹配模型与基线', description: '模型结构、芯片与精度档' }, { title: '换算工作量', description: 'Prefill / Decode / 训练' }, { title: '形成容量', description: '显存、时延与卡数' }]} />
    </Card>
    <Card title="怎样阅读 T / P、显存与卡数">
      <Descriptions column={1} items={[
        { key: 'units', label: 'T / P', children: '1 TFLOPS = 每秒 10¹² 次浮点运算；1 PFLOPS = 每秒 10¹⁵ 次；1 P = 1000 T。FLOP 是工作量，FLOPS 是速度。' },
        { key: 'precision', label: '精度基准', children: `业务池按方案精度档确定权重字节（BF16 2B / W8A8 1B / W4A8 0.5B）与 KV 字节（BF16 2B、量化 1B），新建方案默认 ${precisionDefault}；创新池与研发池沿用 BF16（16 位权重、2 字节 KV）。三池算力统一折算为 BF16 稠密等效，不同精度档的峰值不能按位宽直接换算或混加。` },
        { key: 'base', label: '基础规划算力', children: '业务池 = Σ 各场景（补偶后的三维最小卡数 × 单卡 BF16 峰值 ÷ 1000）；创新池 = Σ 各模型（Prefill 工作量 ÷ ηp + Decode 工作量 ÷ ηd）；研发池 = 单任务工作量 ÷（时限 × 训练效率）× 槽位数。单位 P。' },
        { key: 'planned', label: '建议规划算力', children: '等于基础规划算力：三池都不乘方案余量、不加故障冗余，因此「建议容量 = 基础容量」，汇总层也不再统一放大。' },
        { key: 'cards', label: '规划卡数', children: '业务池 = Σ 各场景（三维最小卡数奇数补偶、不足 8 卡补到一个部署单元）；创新池与研发池 = max(算力卡数, 显存卡数)，不按整机倍数对齐。' },
        { key: 'servers', label: '服务器台数', children: '业务池逐场景按 ⌈卡数 ÷ 8⌉ 折算后相加（场景之间不共享余卡）；创新池与研发池按 ⌈池规划卡数 ÷ 8⌉。8 卡/台只是折算口径，不代表已完成网络与供电拓扑验证。' },
        { key: 'memory', label: '显存', children: '辅助判断权重、缓存与运行空间能否容纳；同样的算力值不代表相同的模型承载能力。显存是出卡的独立约束，不是算力的换算系数。' },
      ]} />
      <Formula title="三类资源池独立汇总" note="三池分别配置；同一模型放在不同池里也各自出卡，不跨池共享权重。">C总建议 = C业务 + C创新 + C研发<br />C各池建议 = C各池基础（三池都不乘方案余量）</Formula>
      <p>业务池按「逐场景独立出卡」汇总：每个场景给出自己的三维约束卡数，池合计等于各场景卡数与算力直接相加，同一模型的不同场景不共享权重驻留。创新池按月度额度折算出峰值请求，再按单模型的分阶段工作量出卡；研发池按「最大单任务 × 并行槽位」聚合。三池卡数<strong>不能相加</strong>（机型与部署粒度不同），只有算力（P）可以相加。</p>
    </Card>
    <Card title="默认值怎样使用，结果怎样验证">
      <p>填写业务人数和模型即可开始；展开“技术参数与默认值”可查看当前值，点击感叹号了解参数含义和选择原因。先接受合理默认值，再优先调整最影响结果的输入长度、总生成长度、使用频次和完成时间。</p>
      <div className="basis-evidence-grid"><div><Tag color="green">官方事实</Tag><p>模型结构、参数、配置上限与指定任务 FLOP 等，保存来源和固定模型版本。</p></div><div><Tag color="blue">分析推导</Tag><p>请求换算、按时段分摊月配额、按完成窗口配置任务容量等，按明确公式计算。</p></div><div><Tag color="gold">经验默认值</Tag><p>使用频率、效率、显存利用率、实验档位及部分显存代理，是可修改的规划假设。</p></div></div>
      <p>依据等级 A 表示匹配条件下的实测，B 表示资料与分析公式支持，C 表示含经验假设或相似代理。关键依赖中较弱的一项决定整体等级，因此当前使用经验效率的容量结果保持 C 级。</p>
      <p>完整性与依据等级分别展示：缺基线的任务会保留并列出，“部分已计入”不能当作完整总需求。后续用匹配模型、精度、框架与负载的吞吐、延迟和显存测试，逐步校准经验参数。<Source id="metrics" /></p>
    </Card>
  </div>;

  const business = <div className="basis-content">
    <Card title="业务场景：三维约束出卡数">
      <p>每个场景独立按「显存 A / Prefill B / Decode C」三条约束算出<strong>恰好满足 SLA 的最小卡数</strong>，取最大值后奇数补偶；不足 8 卡补到一个部署单元（一台 8 卡服务器）。台数逐场景按 ⌈卡数 ÷ 8⌉ 折算后相加，池层只做求和：不按整机倍数向上取整、不乘方案余量，也不额外补故障冗余。</p>
      <Variables rows={[
        ['并发', '同时在生成中的会话数；按业务同时在线会话估，不用注册人数直接代替', '路'],
        ['Li / Lo', '单请求输入长度 / 输出长度（Token）', 'Token'],
        ['TTFT / TPOT', '首 Token 目标时延 / 逐 Token 目标时延', '毫秒'],
        ['精度', `权重与 KV 的字节数随精度档确定；新建方案默认 ${precisionDefault}`, '—'],
        ['档位', '保守 / 均衡 / 激进：按指数规则缩放效率类系数，结构性开销不缩放', '—'],
        ['A / B / C', '显存约束 / Prefill 时延约束 / Decode 时延约束各自需要的卡数', '张'],
      ]} />
      <Formula title="第一步 · 三维取最大，再补偶，最后兜到部署单元">卡数场景 = max(8, 补偶( max(A, B, C) ))<br />台数池 = Σ 各场景 ⌈卡数场景 ÷ 8⌉</Formula>
      <Formula title="第二步 · 折算需求算力（BF16 等效参考）">C基础 = Σ 各场景 (补偶(max(A, B, C)) × 单卡 BF16 峰值 ÷ 1000)（P）<br />C建议 = C基础</Formula>
      <Provenance><p>三条约束与「推理评估」页共用同一个引擎：A 按权重装载宽度 × 副本数，B 按 Prefill 算力与 M/G/1 排队校验 TTFT，C 按 Decode 带宽与算力枚举「分片 × 副本」校验 TPOT，并给出带宽受限、逐 Token 未达标等告警类型。主导因素会随并发与时延目标在三者之间转移，三步都要算。</p><p>补到 8 卡只影响采购与部署口径的<strong>规划卡数</strong>，不改写需求算力：需求算力用的始终是三维最小卡数（补偶后）。需求算力是卡数的等效折算（卡数 × 单卡 BF16 峰值），与卡数不是同一量纲，不能相加比较。公式与参数的代码对照见开发笔记第 2 章。</p></Provenance>
    </Card>
    <Card title="A / B / C 三条约束各自怎么算">
      <p>三条约束互相独立：显存装不装得下、首 Token 达不达标、逐 Token 生成够不够快，是三个不同的问题。同一批卡同时承担 Prefill 与 Decode，所以取最大值而不是相加；若实际采用 PD 分离（两池各装一份完整权重），总卡数会高于这里的混部口径。</p>
      <Collapse defaultActiveKey={['A']} items={[
        {
          key: 'A', label: 'A · 显存约束：权重装载宽度 × 副本数', children: <>
            <Formula title="A · 显存">权重 = 总参数 × 权重字节 × MoE 偏斜(1.08)<br />可用显存 = 单卡标称显存 × 显存利用率<br />装载宽度 = ⌈权重 ÷ 可用显存⌉ → 不超过 8 卡取 2 的幂、超过 8 卡取 8 的倍数（权重占满时自动抬宽）<br />KV 需求 = 并发 × (Li + Lo ÷ 2) × 每 Token KV × KV 预留系数<br />副本数 = ⌈KV 需求 ÷ (装载宽度 × 可用显存 − 权重)⌉<br />A = 装载宽度 × 副本数</Formula>
            <Formula title="每 Token KV 字节（随模型架构与精度档）">MLA：层数 × (低秩维 + RoPE 维) × KV 字节<br />GQA / MHA：2 × 层数 × KV 头数 × KV 头维 × KV 字节<br />混合注意力：再乘全注意力层占比（按代理口径标注）</Formula>
            <p>显存看<strong>总参数</strong>（MoE 推理也要把全部专家装进显存），算力看激活参数。KV 按连续批均值（输入 + 输出 ÷ 2）预留，不按每路写满上下文窗口。权重恰好装满、KV 房间为 0 时自动提升装载宽度，保证每个副本留得出 KV 空间。</p>
          </>
        },
        {
          key: 'B', label: 'B · Prefill 约束（TTFT）：max(吞吐下限 N1, 时延下限 N2)', children: <>
            <Formula title="B · Prefill">Fp = 2 × 激活参数 × Li ÷ FFN 有效利用率 + 4 × 层数 × 注意力宽 × Li × 有效跨度<br />λ = 并发 ÷ ((TTFT目标 + Lo × TPOT目标) ÷ 1000)<br />N1 = ⌈λ × Fp ÷ (单卡峰值 × Prefill MFU × 预算)⌉<br />TTFT(N) = (Fp ÷ (N × 单卡有效算力) × 1000 + 固定开销) × (1 + 0.5 × ρ ÷ (1 − ρ))<br />N2 = 使 TTFT(N) ≤ TTFT目标 × 预算 的最小 N<br />B = max(N1, N2)</Formula>
            <p>FFN 有效利用率随批量爬升：MoE 按每专家平均 Token 数从 7% 升到 50%，稠密模型从 42% 升到 100%——小批量专家填不满就是被这一步放大。排队项按 M/G/1 近似，ρ 达到 1 即饱和不可行；预算默认 85%，等于先留 15% 给排队与调度抖动。</p>
          </>
        },
        {
          key: 'C', label: 'C · Decode 约束（TPOT）：枚举「分片 × 副本」', children: <>
            <Formula title="C · Decode">每步每卡读取 = 权重 ÷ 分片（MoE 只算命中专家）+ 批 × 均长 × 每 Token KV ÷ 分片<br />单步步长 = max(带宽时间, 计算时间) + 0.4 × min(两者) + TP 通信 + 调度 1.35ms<br />枚举分片 1 / 2 / 4 / 8 / 16 / 32 × 副本 1…clamp(⌈并发 ÷ 8⌉, 16, 256)<br />取「步长 ≤ TPOT目标」的最小总卡数；无解时取枚举上限并告警<br />带宽理论下限 = 最宽分片权重读取 ÷ HBM 带宽 + 调度</Formula>
            <p>Decode 是带宽游戏：每生成一个 Token 都要把激活权重从显存重读一遍，MoE 只读命中的专家。目标严于带宽理论下限时加卡无效，应换更高带宽的卡或放宽 TPOT 目标。分片上限随并发放开（≥64 路到 16、≥256 路到 32），跨机分片按 8 的倍数对齐。</p>
          </>
        },
      ]} />
      <p className="basis-caption">上述系数按芯片给基准值：910C 的 Prefill MFU 26%、Decode MFU 约为它的 80%、HBM 带宽利用率 62%、显存利用率 90%、KV 预留系数 1.10，MoE 专家偏斜 1.08。全部可在「基线与设置 → 推理参数」按经验改写；档位只缩放效率类系数（保守 ×0.8 / 均衡 ×1 / 激进 ×1.2，显存利用率半幅跟随），结构性开销与口径常数不随档位变化。</p>
    </Card>
    <Card title="旧版清单模板与阶段效率默认值">
      <Table<Obj> rowKey="id" dataSource={presetRows} pagination={false} size="small" scroll={{ x: 700 }} columns={[
        { title: '场景模板', dataIndex: 'name' }, { title: '每人每分钟请求', dataIndex: 'requests_per_user_min' },
        { title: '输入Token', dataIndex: 'input_tokens' }, { title: '可见输出Token', dataIndex: 'answer_tokens' }, { title: '额外推理Token', dataIndex: 'reasoning_tokens' },
      ]} />
      <p className="basis-caption">业务池 v2 不再用「在线人数 × 请求频次 → 工作量」的换算出卡；这张模板表只用于导入旧版清单时把任务折算成等价的推理配置（并发与输入输出长度）。阶段效率默认值（输入 {percent(task.eta_prefill)}、生成 {percent(task.eta_decode)}）只供创新池公式使用——业务池用的是芯片 MFU 口径，两者不是同一个系数。</p>
      <div className="basis-example"><strong>换算示例</strong>100 人在线、每人每分钟 0.5 次的旧清单条目，导入后按「同时在跑的会话数」与输入输出长度进入三维约束计算，而不是 100 个请求同时生成。完整数值可在“测算结果 → 查看计算依据”中复核。</div>
    </Card>
  </div>;

  const innovationTab = <div className="basis-content">
    <Card title="创新服务：月度额度守恒，再换算服务峰值">
      <p>每个人拥有一份每月总 Token 额度，包含输入及总生成 Token。本池按<strong>一个模型</strong>规划：整份额度都归选定的这一个模型，不按模型数量拆分额度。推理 Token 已包含在生成额度时不再重复叠加。</p>
      <p className="basis-caption">早期保存的多模型方案不自动改写，其汇总仍是全部分配条目的合计（页面会标明「N 个模型合计」）；需要按单模型口径重新规划时，用页面上的「收敛为单模型」按钮显式转换。</p>
      <Variables rows={[
        ['U / q / u', '支持人数 / 人均每月总 Token / 额度使用率', '人 / Token·人⁻¹·月⁻¹ / 比例'],
        ['β', '其中输入 Token 占总量的比例（生成部分为 1 − β）', '比例'],
        ['d / t / k', '每月服务日数 / 每日小时 / 峰值倍数', '日 / 小时 / 倍'],
        ['I / O', '峰值输入 / 总生成 Token 速率', 'Token/秒'],
        ['Breq', '用于估计请求速率与缓存的平均单请求总 Token', 'Token/请求'],
        ['h', '前缀缓存命中率：只折算 Prefill 输入，Decode 与 KV 按全量上下文', '比例'],
        ['κp / κd', '结构修正：MoE 取 1.2、稠密取 1.1', '—'],
      ]} />
      <Formula title="第一步 · 计算月度总额">Q月 = U × q × u</Formula>
      <Formula title="第二步 · 从月度总额换算峰值速率">T服务 = d × t × 3600<br />I = Q月 × β ÷ T服务 × k<br />O = Q月 × (1 − β) ÷ T服务 × k<br />λ = (I + O) ÷ Breq</Formula>
      <Formula title="第三步 · 分阶段工作量与容量">Fp = 2 × Np × Li × κp × (1 − h)<br />Fd = 2 × Nd × Lg × κd<br />C基础 = λ × (Fp ÷ ηp + Fd ÷ ηd) ÷ 10¹⁵<br />C创新建议 = C基础</Formula>
      <Formula title="第四步 · 折算卡数（与业务池同一套芯片规格）">算力卡数 = ⌈C建议 × 1000 ÷ 单卡 BF16 峰值⌉<br />显存卡数 = ⌈池显存 ÷ 单卡显存⌉<br />规划卡数 = max(算力卡数, 显存卡数)；台数 = ⌈规划卡数 ÷ 8⌉</Formula>
      <Provenance><p>“月总量 ÷ 服务秒数”是单位与额度守恒换算；峰值倍数是对集中使用程度的规划假设。该配额换算不是厂商发布的通用 Token 与 P 一比一兑换表。分阶段工作量与业务场景同源，但业务池按 MFU 出卡、本池按阶段效率折算，两条路径的 P 都归一到 BF16 稠密等效。<Source id="scaling" /></p><p>命中前缀的输入 Token 复用已有 KV cache，不再重复 Prefill；Decode 仍逐 Token 关注全量上下文，KV 显存也按全量输入占算。实际可达吞吐及延迟应由匹配负载测试验证。<Source id="metrics" /></p></Provenance>
    </Card>
    <Card title="初始假设与使用说明">
      <Descriptions column={2} items={[
        { key: 'days', label: '每月服务日', children: value(innovation.service_days, '22') + ' 日' },
        { key: 'hours', label: '每日服务时长', children: value(innovation.service_hours_per_day, '8') + ' 小时' },
        { key: 'usage', label: '额度使用率', children: percent(innovation.usage_ratio) },
        { key: 'peak', label: '峰值倍数', children: value(innovation.peak_factor, '3') + ' 倍' },
        { key: 'input', label: '输入 / 生成份额', children: percent(allocation.input_fraction) + ' / ' + percent(1 - Number(allocation.input_fraction ?? 0.8)) },
        { key: 'request', label: '单请求总 Token', children: value(allocation.request_total_tokens, '2560') },
        { key: 'hit', label: '前缀缓存命中率', children: percent(innovation.cache_hit_rate) },
        { key: 'eta', label: '阶段效率 ηp / ηd', children: percent(innovation.eta_prefill) + ' / ' + percent(innovation.eta_decode) },
      ]} />
      <p className="basis-caption">以上是新方案的产品默认假设，用户可在创新服务参数中调整。22 个服务日定义消化整月额度的集中服务窗口，不是把月额度减少成 22/30。</p>
      <div className="basis-example"><strong>额度换算示例</strong>1000 人 × 每人每月 100 万 Token = 每月 10 亿 Token；按使用率折算后再除以服务窗口秒数得到峰值速率。整份额度归本池选定的那一个模型，不再拆成多份份额；需要同时服务第二个模型时，按它的峰值需求另做评估。</div>
      <Formula title="缓存所需的请求尺度">Li = β × Breq，Lg = (1 − β) × Breq<br />序列数 = ⌈λ × (TTFT目标 + Lg ÷ 输出速度)⌉（至少 1）</Formula>
      <p>显存按「权重 + KV cache + runtime」直接汇总：权重 = 驻留参数 × 2B（BF16）× 副本，runtime = max(2GB, 单副本权重 × 10%) × 副本，KV = 序列数 × (Li + Lg) × 每 Token KV。创新池权重独立于业务池，跨池不共享；同池内兼容任务才共享权重驻留。</p>
    </Card>
  </div>;

  const devRows = Object.entries(defaults.intensities || {}).map(([id, values]) => ({ id, name: ({ light: '轻度', standard: '标准（默认）', high: '高强度' } as Obj)[id], ...(values as Obj) }));
  const development = <div className="basis-content">
    <Card title="开发测试：按任务能力和并行槽位配置">
      <p>开发测试池按需启用。选定需要微调的模型（单模型），再选择实验强度；先计算单个微调任务的容量，资源池按允许同时运行的槽位组合。本池只规划一个模型的微调，不按模型数量累加，也不包含效果评测的算力。</p>
      <Variables rows={[
        ['Ntrain / D / E', '训练阶段激活参数 / 未乘轮数的数据 Token / 训练轮数', '参数 / Token / 轮'],
        ['ktrain / ηtrain', '微调工作量系数 / 训练有效效率', '经验系数 / 比例'],
        ['H', '单次微调希望在多少小时内完成', '小时'],
        ['st', '可同时运行的微调槽位', '任务个数'],
      ]} />
      <Formula title="轻量微调 · 每任务计算量与容量">F训练 = ktrain × Ntrain × D × E<br />C微调单任务 = F训练 ÷ (H × 3600 × ηtrain × 10¹⁵)</Formula>
      <p>ktrain 初始 {value(training.train_k, '4')}，ηtrain 初始 {percent(training.train_eta)}。训练激活参数缺专用资料时采用有标记的架构代理（MoE 取激活参数）；这不是“总参数 × 可训练参数比例”的简单缩减。</p>
      <Provenance><p>LoRA 通过冻结基础权重、训练低秩适配器降低需要更新的参数量。<Source id="lora" /> <Source id="peft" /></p><p>上述资料支持 LoRA 机制，不支持“LoRA 固定为 4ND”的结论。ktrain 是本产品的经验工作量系数，数据、轮数与完成窗口换算是规划推导；特殊架构、QLoRA 及检查点策略需单独校准。</p></Provenance>
    </Card>
    <Card title="档位定义与资源池聚合">
      <Table<Obj> rowKey="id" pagination={false} dataSource={devRows} size="small" scroll={{ x: 900 }} columns={[
        { title: '强度', dataIndex: 'name' }, { title: '数据Token', dataIndex: 'train_data_tokens', render: (v: unknown) => num(v) },
        { title: '轮数', dataIndex: 'epochs' }, { title: '微调时限', dataIndex: 'train_deadline_hours', render: (v: unknown) => v + '小时' },
        { title: '微调槽位', dataIndex: 'train_slots' },
      ]} />
      <Formula title="先取支持全部候选模型的能力包络，再按槽位组合">C单任务 = max(各候选模型的单任务微调容量)<br />Ct = st × C单任务<br />C研发建议 = Ct<br />规划卡数 = max(⌈C建议 × 1000 ÷ 单卡 BF16 峰值⌉, ⌈池显存 ÷ 单卡显存⌉)；台数 = ⌈规划卡数 ÷ 8⌉</Formula>
      <p>取最大值意味着一个槽位能承接任意选中模型，默认还允许不同槽位运行同一模型的不同实验；不把候选模型容量机械累加。各档位的数据量、窗口与槽位都是本产品定义，允许高级参数覆盖，不是行业统一标准。</p>
      <Collapse items={[{ key: 'dev-memory', label: '微调显存的辅助估算方法', children: <><Formula title="训练状态与激活预算">M微调 = 基础权重 + 适配器状态 + 激活预算 + 工作空间<br />基础权重 = 驻留参数 × 2B（LoRA）或 × 0.5B（QLoRA，另加 5% 量化元数据）<br />适配器状态 = 驻留参数 × adapter 比例 × 16B<br />激活预算 = max(8GB, 基础权重 × 20%) × 序列长度 ÷ 2048 × micro batch<br />工作空间 = max(2GB, 基础权重 × 10%)<br />池显存 = max(各候选单任务显存) × 微调槽位</Formula><p>当前适配器参数缺专用统计时，用完整参数的 {percent(training.adapter_fraction)} 作代理，状态按每适配器参数 16 字节预算。均是可校准的经验预算，不是框架级显存实测；显存按需求直接汇总，不再除以（1 − 显存预留），方案级显存预留已取消。</p><p>微调进程按槽位各自驻留；研发池沿用 BF16 口径（16 位权重、2 字节 KV）。QLoRA 需额外的量化元数据基线，未知时不能声称完整可落地。</p></> }]} />
    </Card>
  </div>;

  const sources = <div className="basis-content">
    <Card title="哪些结论来自哪里">
      <p>公式的参考依据、模型结构事实和本产品的默认假设分开记录。点击原始资料可核对其适用范围；每次测算保存当时的模型目录与参数快照，新基线不会改写旧结果。</p>
      <Table<Obj> rowKey="id" dataSource={references} pagination={false} scroll={{ x: 700 }} columns={[
        { title: '原始资料', width: 320, render: (_, r) => <a href={r.url} target="_blank" rel="noreferrer">{r.name} ↗</a> },
        { title: '类型', dataIndex: 'kind', width: 120 }, { title: '支持的内容与边界', dataIndex: 'purpose' },
      ]} />
    </Card>
    <Card title="当前模型目录的结构来源">
      <Table<Obj> rowKey="id" dataSource={referenceModels} pagination={{ pageSize: 6 }} scroll={{ x: 780 }} columns={[
        { title: '模型', dataIndex: 'display_name' }, { title: '固定版本', dataIndex: 'revision', render: (v: string) => <code title={v}>{v?.slice(0, 12)}</code> },
        { title: '资料核对日期', dataIndex: 'checked_at', width: 135 }, { title: '原始资料', render: (_, m) => <a href={m.source_url} target="_blank" rel="noreferrer">模型卡 / 配置 / 规格 ↗</a> },
      ]} expandable={{ expandedRowRender: m => <p>{m.notes}</p> }} />
      <p className="basis-caption">参数来源用于解释结构，不能替代真实吞吐测试。MoE 计算使用阶段激活参数，权重显存使用完整驻留口径；上下文配置上限也不等于实际响应保证。</p>
    </Card>
    <Card title="可以自行调整的规划假设">
      <p>请求频次、输入输出预算、阶段效率、显存与带宽利用率、创新服务窗口、峰值倍数及研发档位，来自本产品的早期规划设计。它们的意义是让资料不完整时仍能给出透明、可修改的初步结果。</p>
      <p>建议优先用业务实际量替换业务假设；用匹配条件下的测试替换性能假设。若只有整体吞吐数据，不能据此声称同时准确获得输入和生成两个阶段的效率。业务池的芯片工程系数（MFU、带宽利用率、显存利用率、KV 预留、MoE 偏斜）与口径常数集中在「基线与设置 → 推理参数」，改动会进入下一次测算的参数快照。</p>
      <Alert type="info" showIcon message="查看某次测算的真实依据" description="进入测算结果，点击任务的“查看计算依据”，可查看该次保存的输入、公式、中间值、默认值来源和模型版本。本页解释通用方法，具体方案以当次快照为准。" />
    </Card>
  </div>;

  return <div className="planning-basis">
    <div className="basis-intro"><div><span className="eyebrow">METHOD & EVIDENCE</span><h2>从业务需求，到可解释的算力规模。</h2><p>先了解规划方法，再查看三类资源池的公式、默认假设与原始资料。</p></div><Tag color="green">参数口径 · {defaults.defaults_version || '加载中'}</Tag></div>
    <Tabs className="basis-tabs" destroyOnHidden items={[
      { key: 'overview', label: '整体规划思路', children: overview },
      { key: 'business', label: '业务场景计算依据', children: business },
      { key: 'innovation', label: '创新服务计算依据', children: innovationTab },
      { key: 'development', label: '开发测试计算依据', children: development },
      { key: 'sources', label: '依据与来源', children: sources },
    ]} />
  </div>;
}
