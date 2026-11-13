import { Alert, Card, Collapse, Descriptions, Steps, Table, Tabs, Tag } from 'antd';
import type { ReactNode } from 'react';
import { num } from './api';
import type { Obj } from './api';

const references = [
  { id: 'scaling', name: 'Scaling Laws for Neural Language Models · §2.1 / 表1', url: 'https://arxiv.org/html/2001.08361v1#S2.SS1', kind: '研究论文', purpose: 'Transformer前向工作量的参数主导近似；创新池与研发池的分阶段工作量近似沿用该口径。' },
  { id: 'metrics', name: 'NVIDIA GenAI-Perf · Metrics', url: 'https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/perf_benchmark/genai-perf-README.html#metrics', kind: '官方文档', purpose: '输入/输出长度、吞吐与响应延迟的计量定义，用于后续性能校准。' },
  { id: 'lora', name: 'LoRA: Low-Rank Adaptation of Large Language Models', url: 'https://arxiv.org/abs/2106.09685', kind: '研究论文', purpose: '冻结基础权重并训练低秩适配器的方法依据；不证明微调工作量恒为4ND。' },
  { id: 'peft', name: 'Hugging Face PEFT · LoRA', url: 'https://huggingface.co/docs/peft/main/en/conceptual_guides/lora', kind: '官方文档', purpose: 'LoRA机制和适配器参数的解释；训练显存仍需结合实际配置校准。' },
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
  const planning = defaults.planning_defaults || {};
  const percent = (value: unknown) => value == null ? '以当前配置为准' : num(Number(value) * 100) + '%';
  const text = (value: unknown) => value == null ? '以当前配置为准' : num(value, 4);
  const referenceModels = models.filter(m => !m.is_demo);
  const presetRows = Object.entries(defaults.templates || {}).map(([key, value]) => {
    const names: Obj = { qa: '知识问答', extract: '抽取/分类', document: '文档分析', report: '长报告/复杂推理', vision: '图文问答' };
    return { id: key, name: names[key] || key, ...(value as Obj) };
  });

  const overview = <div className="basis-content">
    <Card title="先理解：我们规划的是什么？">
      <p>本工具估算组织当前业务规模需要配置的计算能力。用户先描述业务规模与模型，再把请求、Token 与实验任务转换为计算工作量，最后结合效率和余量形成容量建议。</p>
      <p>所有输入按<strong>当前峰值规模</strong>理解，不引入规划年限、年增长率等时间外推参数：早期规划只需要回答“现在这个规模大概需要多少算力”，周期与增长留给后续实测校准。</p>
      <div className="basis-pool-grid">{[
        ['01', '业务场景', '支撑已规划的具体应用', '在线人数、模型、请求内容与响应目标'],
        ['02', '创新服务', '提供灵活可用的模型服务池', '支持人数、人均月Token与模型份额'],
        ['03', '开发测试', '按需支撑模型微调', '候选模型、微调强度与并行槽位'],
      ].map(([index, name, purpose, inputs]) => <div key={name}><span>{index}</span><h3>{name}</h3><p>{purpose}</p><small>{inputs}</small></div>)}</div>
      <Steps className="basis-steps" responsive items={[{ title: '定义业务规模', description: '场景清单与期末需求' }, { title: '匹配模型与基线', description: '任务、参数与计量单位' }, { title: '换算工作量', description: '每秒请求或单位任务' }, { title: '形成容量', description: '效率、余量与显存' }]} />
    </Card>
    <Card title="怎样阅读 T / P、显存与余量">
      <Descriptions column={1} items={[
        { key: 'units', label: 'T / P', children: '1 TFLOPS = 每秒10¹²次浮点运算；1 PFLOPS = 每秒10¹⁵次；1 P = 1000 T。FLOP是工作量，FLOPS是速度。' },
        { key: 'precision', label: '精度基准', children: '本产品的算力以 BF16 稠密算力为基准折算（业务池按卡数×芯片BF16峰值折算为等效参考）。推理精度档为 BF16（全精度）/ W8A8 / W4A8，KV 缓存字节数随精度档自动确定；量化峰值与 BF16 容量不能按位宽直接换算或混加。' },
        { key: 'effective', label: '有效需求', children: '模型执行算法所需的计算工作量速率，尚未考虑实际运行效率。' },
        { key: 'base', label: '基础规划算力', children: '将有效需求按阶段效率折算为参考容量，效率越低，相同业务需要的参考容量越大。' },
        { key: 'planned', label: '建议规划算力', children: <>在基础容量上增加一次余量，初始默认 {percent(planning.headroom)}。余量是容量预留，不等于高可用副本。</> },
        { key: 'memory', label: '显存', children: '辅助判断权重、缓存和运行状态能否容纳；同样的算力值不代表相同的模型承载能力。' },
      ]} />
      <Formula title="三类资源池独立汇总" note="三池分别配置；相同模型不会跨资源池去重。">C总建议 = C业务建议 + C创新建议 + C研发建议<br />C每池建议 = C每池基础 × (1 + h)</Formula>
      <p>业务池按「逐场景独立出卡」汇总：每个场景给出自己的三维约束卡数，池合计等于各场景卡数与算力直接相加，同一模型的不同场景不共享权重驻留；创新池与研发池沿用分阶段工作量近似。余量只在资源池层乘一次，场景层不重复加。</p>
    </Card>
    <Card title="默认值怎样使用，结果怎样验证">
      <p>填写业务人数和模型即可开始；展开“技术参数与默认值”可查看当前值，点击感叹号了解参数含义和选择原因。先接受合理默认值，再优先调整最影响结果的输入长度、总生成长度、使用频次和完成时间。</p>
      <div className="basis-evidence-grid"><div><Tag color="green">官方事实</Tag><p>模型结构、参数、配置上限与指定任务FLOP等，保存来源和固定模型版本。</p></div><div><Tag color="blue">分析推导</Tag><p>请求换算、按时段分摊月配额、按完成窗口配置任务容量等，按明确公式计算。</p></div><div><Tag color="gold">经验默认值</Tag><p>使用频率、效率、余量、实验档位及部分显存代理，是可修改的规划假设。</p></div></div>
      <p>依据等级A表示匹配条件下的实测，B表示资料与分析公式支持，C表示含经验假设或相似代理。关键依赖中较弱的一项决定整体等级，因此当前使用经验效率的容量结果保持C级。</p>
      <p>完整性与依据等级分别展示：缺基线的任务会保留并列出，“部分已计入”不能当作完整总需求。后续用匹配模型、精度、框架与负载的吞吐、延迟和显存测试，逐步校准经验参数。<Source id="metrics" /></p>
    </Card>
  </div>;

  const business = <div className="basis-content">
    <Card title="业务场景：三维约束出卡数">
      <p>业务池按大模型推理服务出卡：每个场景按「显存 A / Prefill B / Decode C」三条约束分别算出所需卡数，取最大值再奇数补偶。同一批卡同时承担 Prefill 与 Decode，所以三条约束取最大而不是相加；卡数按 8 张 = 1 台对齐，余量只在资源池层乘一次。</p>
      <Variables rows={[
        ['并发', '同时在跑的会话数；按业务同时在线会话估，不用注册人数直接代替', '路'],
        ['Li / Lo', '单请求输入长度 / 输出长度', 'Token'],
        ['TTFT / TPOT', '首 Token 目标时延 / 逐 Token 目标时延', '毫秒'],
        ['精度', 'BF16（全精度）/ W8A8 / W4A8；权重字节数与 KV 字节数随精度档确定', '—'],
        ['档位', '保守 / 均衡 / 激进：对芯片算力、带宽等效率系数做档位缩放', '—'],
        ['A / B / C', '显存约束 / Prefill 时延约束 / Decode 时延约束各需的卡数', '张'],
      ]} />
      <Formula title="第一步 · 三维取最大，再奇数补偶">卡数 = 补偶( max(A, B, C) )<br />台数 = 卡数 ÷ 8（8 张卡为一台）</Formula>
      <Formula title="第二步 · 需求算力（BF16 等效参考）">C基础 = 卡数 × 芯片BF16峰值 ÷ 1000（P）<br />C建议 = C基础 × (1 + h)</Formula>
      <Provenance><p>三条约束与推理评估引擎（engine-v2.0.0）共用同一套页面口径：A 按权重字节 + KV 缓存 + 激活与运行空间，KV 按 MLA / GQA 结构逐层计数；B 按 Prefill 算力与 M/G/1 排队校验 TTFT；C 按 Decode 带宽与算力枚举「分片 × 副本」校验 TPOT，并给出带宽受限、逐 Token 未达标等告警类型。需求算力是卡数折算的等效参考口径，与卡数不是同一量纲，不能混加比较。公式与参数的代码对照见开发笔记第 2 章。</p></Provenance>
    </Card>
    <Card title="旧版清单模板与阶段效率默认值">
      <Table<Obj> rowKey="id" dataSource={presetRows} pagination={false} size="small" scroll={{ x: 700 }} columns={[
        { title: '场景模板', dataIndex: 'name' }, { title: '每人每分钟请求', dataIndex: 'requests_per_user_min' },
        { title: '输入Token', dataIndex: 'input_tokens' }, { title: '可见输出Token', dataIndex: 'answer_tokens' }, { title: '额外推理Token', dataIndex: 'reasoning_tokens' },
      ]} />
      <p className="basis-caption">业务池 v2 不再用「在线人数 × 请求频次 → 工作量」的换算出卡；这张模板表只用于导入旧版清单时把任务折算成等价的推理配置（并发与输入输出长度），阶段效率默认值（输入 {text(task.eta_prefill)}、生成 {text(task.eta_decode)}）继续供创新池公式使用。</p>
      <div className="basis-example"><strong>换算示例</strong>100人在线、每人每分钟0.5次的旧清单条目，导入后按「同时在跑的会话数」与输入输出长度进入三维约束计算，而不是100个请求同时生成。完整数值可在“测算结果 → 查看计算依据”中复核。</div>
    </Card>
    <Card title="显存与运行空间的处理">
      <Collapse defaultActiveKey={['memory']} items={[
        { key: 'memory', label: '显存：权重、KV 缓存与运行空间分开考虑', children: <><Formula title="每 Token KV 缓存字节（MLA / GQA）">MLA：每Token = 层数 × (低秩维度 + RoPE维度) × KV字节数<br />GQA：每Token = 2 × 层数 × KV头数 × KV头维 × KV字节数</Formula><Formula title="显存约束 A">A = (权重字节 + KV缓存字节 + 激活与运行空间) ÷ 单卡显存 → 取整出卡</Formula><p>KV 字节数随精度档确定：全精度 2 字节、量化 1 字节。混合注意力按全注意力层占比折算；混合结构的 KV 头维与 QK/V 维分开记录。显存只是三维约束之一，最终卡数取三条约束的最大值。</p></> },
      ]} />
    </Card>
  </div>;

  const innovation = <div className="basis-content">
    <Card title="创新服务：月度额度守恒，再换算服务峰值">
      <p>每个人拥有一份每月总Token额度，包含输入及总生成Token。多个模型按份额共享这份总额度；选择三个模型不等于给每个人发三份完整额度。推理Token已包含在生成额度时不再重复叠加。</p>
      <Variables rows={[
        ['U / q / u', '支持人数 / 人均每月总Token / 额度使用率', '人 / Token·人⁻¹·月⁻¹ / 比例'],
        ['wm / βm', '模型m分配的Token份额 / 其中输入Token比例', '各模型份额合计100%'],
        ['d / t / k', '每月服务日数 / 每日小时 / 峰值倍数', '日 / 小时 / 倍'],
        ['Im / Om', '模型m的峰值输入 / 总生成Token速率', 'Token/秒'],
        ['Breq', '用于估计请求速率及缓存的平均单请求总Token', 'Token/请求'],
      ]} />
      <Formula title="第一步 · 计算并分配月度总额">Q月 = U × q × u<br />Q模型m = Q月 × wm，Σwm = 1</Formula>
      <Formula title="第二步 · 从月度总额换算峰值速率">T服务 = d × t × 3600<br />Im = Q模型m × βm ÷ T服务 × k<br />Om = Q模型m × (1 − βm) ÷ T服务 × k</Formula>
      <Formula title="第三步 · 沿用模型的分阶段工作量">Cm基础 = [2Np,m × κp,m × Im ÷ ηp + 2Nd,m × κd,m × Om ÷ ηd] ÷ 10¹⁵<br />C创新建议 = ΣCm基础 × (1 + h)</Formula>
      <Provenance><p>“月总量 ÷ 服务秒数”是单位与额度守恒换算；峰值倍数是本产品对集中使用程度的规划假设。该配额换算不是厂商发布的通用Token与P一比一兑换表。分阶段工作量使用与业务场景相同的分析近似。<Source id="scaling" /></p><p>实际可达吞吐及延迟应由匹配负载测试验证。<Source id="metrics" /></p></Provenance>
    </Card>
    <Card title="初始假设与使用说明">
      <Descriptions column={2} items={[
        { key: 'days', label: '每月服务日', children: '22日' }, { key: 'hours', label: '每日服务时长', children: '8小时' },
        { key: 'usage', label: '额度使用率', children: '100%' }, { key: 'peak', label: '峰值倍数', children: '3倍' },
        { key: 'input', label: '输入 / 生成份额', children: '80% / 20%' }, { key: 'request', label: '单请求总Token', children: '2560' },
      ]} />
      <p className="basis-caption">以上是新方案的产品默认假设，用户可在创新服务参数中调整。22个服务日定义消化整月额度的集中服务窗口，不是把月额度减少成22/30。</p>
      <div className="basis-example"><strong>额度分配示例</strong>1000人 × 每人每月100万Token = 每月10亿Token。两个模型份额70% / 30%，分别分配7亿 / 3亿，而不是每个模型各10亿。</div>
      <Formula title="缓存所需的请求尺度">Li = β × Breq，Lg = (1 − β) × Breq<br />λ = (I + O) ÷ Breq</Formula>
      <p>初始按各模型峰值同时发生，创新池权重独立于业务池。非Token计量的生成服务需要独立的单位任务基线，没有可靠基线时保留为未计入。</p>
    </Card>
  </div>;

  const devRows = Object.entries(defaults.intensities || {}).map(([id, values]) => ({ id, name: ({ light: '轻度', standard: '标准（默认）', high: '高强度' } as Obj)[id], ...(values as Obj) }));
  const development = <div className="basis-content">
    <Card title="开发测试：按任务能力和并行槽位配置">
      <p>开发测试池按需启用。选定需要支持的模型，再选择实验强度；先计算单个微调任务的容量，资源池按允许同时运行的槽位组合。多个候选模型可以轮流使用同一槽位，因此不按模型数量机械累加。开发测试只规划微调，不包含效果评测的算力。</p>
      <Variables rows={[
        ['Ntrain / D / E', '训练阶段激活参数 / 未乘轮数的数据Token / 训练轮数', '参数 / Token / 轮'],
        ['ktrain / ηtrain', '微调工作量系数 / 训练有效效率', '经验系数 / 比例'],
        ['H', '单次微调希望在多少小时内完成', '小时'],
        ['st', '可同时运行的微调槽位', '任务个数'],
      ]} />
      <Formula title="轻量微调 · 每任务计算量与容量">F训练 = ktrain × Ntrain × D × E<br />C微调单任务 = F训练 ÷ (H × 3600 × ηtrain × 10¹⁵)</Formula>
      <p>ktrain 初始 {text(training.train_k)}，ηtrain 初始 {text(training.train_eta)}。训练激活参数缺专用资料时采用有标记的架构代理；这不是“总参数 × 可训练参数比例”的简单缩减。</p>
      <Provenance><p>LoRA通过冻结基础权重、训练低秩适配器降低需要更新的参数量。<Source id="lora" /> <Source id="peft" /></p><p>上述资料支持LoRA机制，不支持“LoRA固定为4ND”的结论。ktrain是本产品的经验工作量系数，数据、轮数与完成窗口换算是规划推导；特殊架构、QLoRA及检查点策略需单独校准。</p></Provenance>
    </Card>
    <Card title="档位定义与资源池聚合">
      <Table<Obj> rowKey="id" pagination={false} dataSource={devRows} size="small" scroll={{ x: 900 }} columns={[
        { title: '强度', dataIndex: 'name' }, { title: '数据Token', dataIndex: 'train_data_tokens', render: v => num(v) },
        { title: '轮数', dataIndex: 'epochs' }, { title: '微调时限', dataIndex: 'train_deadline_hours', render: v => v + '小时' },
        { title: '微调槽位', dataIndex: 'train_slots' },
      ]} />
      <Formula title="先取支持全部候选模型的能力包络">Ct = st × max(各候选模型的单任务微调容量)<br />C研发建议 = Ct × (1 + h)</Formula>
      <p>取最大值意味着一个槽位能承接任意选中模型，默认还允许不同槽位运行同一模型的不同实验。各档位的数据量、窗口与槽位都是本产品定义，允许高级参数覆盖，不是行业统一标准。</p>
      <Collapse items={[{ key: 'dev-memory', label: '微调显存的辅助估算方法', children: <><Formula title="训练状态与激活预算">M微调 = (基础权重 + 适配器状态 + 激活预算 + 工作空间) ÷ (1 − 显存预留比例)</Formula><p>当前适配器参数缺专用统计时，用完整参数的 {percent(training.adapter_fraction)} 作代理，状态按每适配器参数16字节预算；激活预算为 max(8GB, 基础权重×20%) × 序列长度/2048 × micro batch，工作空间取 max(2GB, 基础权重×10%)。均是可校准的经验预算，不是框架级显存实测。</p><p>微调进程按槽位各自驻留；显存按槽位数 × 最大单任务显存聚合。QLoRA需额外的量化元数据基线，未知时不能声称完整可落地。</p></> }]} />
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
        { title: '模型', dataIndex: 'display_name' }, { title: '固定版本', dataIndex: 'revision', render: v => <code title={v}>{v?.slice(0, 12)}</code> },
        { title: '资料核对日期', dataIndex: 'checked_at', width: 135 }, { title: '原始资料', render: (_, m) => <a href={m.source_url} target="_blank" rel="noreferrer">模型卡 / 配置 / 规格 ↗</a> },
      ]} expandable={{ expandedRowRender: m => <p>{m.notes}</p> }} />
      <p className="basis-caption">参数来源用于解释结构，不能替代真实吞吐测试。MoE计算使用阶段激活参数，权重显存使用完整驻留口径；上下文配置上限也不等于实际响应保证。</p>
    </Card>
    <Card title="可以自行调整的规划假设">
      <p>请求频次、输入输出预算、效率、架构工作量修正、余量、创新服务窗口、峰值倍数及研发档位，来自本产品的早期规划设计。它们的意义是让资料不完整时仍能给出透明、可修改的初步结果。</p>
      <p>建议优先用业务实际量替换业务假设；用匹配条件下的测试替换性能假设。若只有整体吞吐数据，不能据此声称同时准确获得输入和生成两个阶段的效率。</p>
      <Alert type="info" showIcon message="查看某次测算的真实依据" description="进入测算结果，点击任务的“查看计算依据”，可查看该次保存的输入、公式、中间值、默认值来源和模型版本。本页解释通用方法，具体方案以当次快照为准。" />
    </Card>
  </div>;

  return <div className="planning-basis">
    <div className="basis-intro"><div><span className="eyebrow">METHOD & EVIDENCE</span><h2>从业务需求，到可解释的算力规模。</h2><p>先了解规划方法，再查看三类资源池的公式、默认假设与原始资料。</p></div><Tag color="green">参数口径 · {defaults.defaults_version || '加载中'}</Tag></div>
    <Tabs className="basis-tabs" destroyOnHidden items={[
      { key: 'overview', label: '整体规划思路', children: overview },
      { key: 'business', label: '业务场景计算依据', children: business },
      { key: 'innovation', label: '创新服务计算依据', children: innovation },
      { key: 'development', label: '开发测试计算依据', children: development },
      { key: 'sources', label: '依据与来源', children: sources },
    ]} />
  </div>;
}
