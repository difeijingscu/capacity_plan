import { Alert, Card, Collapse, Descriptions, Steps, Table, Tabs, Tag } from 'antd';
import type { ReactNode } from 'react';
import { num } from './api';
import type { Obj } from './api';

const references = [
  { id: 'scaling', name: 'Scaling Laws for Neural Language Models · §2.1 / 表1', url: 'https://arxiv.org/html/2001.08361v1#S2.SS1', kind: '研究论文', purpose: 'Transformer前向工作量的参数主导近似；不提供本工具的效率、余量或LoRA系数。' },
  { id: 'metrics', name: 'NVIDIA GenAI-Perf · Metrics', url: 'https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/perf_benchmark/genai-perf-README.html#metrics', kind: '官方文档', purpose: '输入/输出长度、吞吐与响应延迟的计量定义，用于后续性能校准。' },
  { id: 'yolo', name: 'Ultralytics YOLO26 · Performance Metrics', url: 'https://docs.ultralytics.com/models/yolo26/#performance-metrics', kind: '官方模型资料', purpose: '匹配检测任务和输入尺寸的每帧FLOP及模型参数；不是所有CV场景的通用性能。' },
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
      <p>本工具估算组织当前业务规模需要配置的计算能力。用户先描述业务规模与模型，再把请求、Token、图像帧或实验任务转换为计算工作量，最后结合效率和余量形成容量建议。</p>
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
        { key: 'precision', label: '精度基准', children: '本产品的算力以 BF16 稠密算力为基准折算（按所选推理精度），数值旁标注为「BF16 基准」。FP8、INT8、稀疏峰值与 BF16 容量不能按位宽直接换算或混加。' },
        { key: 'effective', label: '有效需求', children: '模型执行算法所需的计算工作量速率，尚未考虑实际运行效率。' },
        { key: 'base', label: '基础规划算力', children: '将有效需求按阶段效率折算为参考容量，效率越低，相同业务需要的参考容量越大。' },
        { key: 'planned', label: '建议规划算力', children: <>在基础容量上增加一次余量，初始默认 {percent(planning.headroom)}。余量是容量预留，不等于高可用副本。</> },
        { key: 'memory', label: '显存', children: '辅助判断权重、缓存和运行状态能否容纳；同样的算力值不代表相同的模型承载能力。' },
      ]} />
      <Formula title="三类资源池独立汇总" note="三池分别配置；相同模型不会跨资源池去重。">C总建议 = C业务建议 + C创新建议 + C研发建议<br />C每池建议 = C每池基础 × (1 + h)</Formula>
      <p>同一业务池内，多个场景可共享兼容的模型服务：计算负载仍分别相加，基础模型权重只驻留一份。场景高峰默认同时发生；独立部署、不同精度或不兼容配置分别计算。</p>
    </Card>
    <Card title="默认值怎样使用，结果怎样验证">
      <p>填写业务人数和模型即可开始；展开“技术参数与默认值”可查看当前值，点击感叹号了解参数含义和选择原因。先接受合理默认值，再优先调整最影响结果的输入长度、总生成长度、使用频次和完成时间。</p>
      <div className="basis-evidence-grid"><div><Tag color="green">官方事实</Tag><p>模型结构、参数、配置上限与指定任务FLOP等，保存来源和固定模型版本。</p></div><div><Tag color="blue">分析推导</Tag><p>请求换算、按时段分摊月配额、按完成窗口配置任务容量等，按明确公式计算。</p></div><div><Tag color="gold">经验默认值</Tag><p>使用频率、效率、余量、实验档位及部分显存代理，是可修改的规划假设。</p></div></div>
      <p>依据等级A表示匹配条件下的实测，B表示资料与分析公式支持，C表示含经验假设或相似代理。关键依赖中较弱的一项决定整体等级，因此当前使用经验效率的容量结果保持C级。</p>
      <p>完整性与依据等级分别展示：缺基线的任务会保留并列出，“部分已计入”不能当作完整总需求。后续用匹配模型、精度、框架与负载的吞吐、延迟和显存测试，逐步校准经验参数。<Source id="metrics" /></p>
    </Card>
  </div>;

  const business = <div className="basis-content">
    <Card title="业务场景：从在线人数到每秒工作量">
      <p>在线人数表示可能发起请求的人数，不等于同时生成回答的请求数。先按每位在线用户的使用频次换算模型负载，再分别计算输入处理（prefill）与逐Token生成（decode）。</p>
      <Variables rows={[
        ['U / r / a', '同时在线人数 / 每人每分钟业务请求次数 / 每业务请求的模型调用次数', '人 / 次·人⁻¹·分钟⁻¹ / 次'],
        ['λ', '模型请求速率；直接填写请求/秒时覆盖在线人数换算', '请求/秒'],
        ['Li / Lg', '输入Token / 总生成Token；Lg = 可见输出 + 额外推理', 'Token/请求'],
        ['Np / Nd', '输入/生成阶段参与计算的参数量；MoE按阶段激活量', '参数个数，B需乘10⁹'],
        ['κp / κd', '结构工作量修正，补偿参数主导近似的部分遗漏', '经验系数'],
        ['ηp / ηd', '输入/生成阶段的有效效率', '0到1之间且不含0'],
        ['h', '规划容量余量，只在基础容量上增加一次', '比例'],
      ]} />
      <Formula title="第一步 · 换算请求速率">λ = U × r × a ÷ 60</Formula>
      <Formula title="第二步 · 每请求工作量" note="若有匹配的更精确基线，则由对应适配器替代这一近似。">Fp = 2 × Np × Li × κp<br />Fd = 2 × Nd × Lg × κd</Formula>
      <Formula title="第三步 · 转换为基础与建议容量">C基础 = λ × (Fp ÷ ηp + Fd ÷ ηd) ÷ 10¹⁵<br />C建议 = C基础 × (1 + h)</Formula>
      <Provenance><p>参数主导的前向近似参考论文§2.1的Transformer操作计数；论文还包含上下文项，且N为非嵌入参数。本工具按目录参数或MoE激活量做规划扩展，并分输入/生成阶段计算，不能据此宣称完整覆盖所有架构或长上下文。</p><Source id="scaling" /><p>κ、效率与余量是本产品的经验假设；模型参数来源见“依据与来源”中的固定版本目录。</p></Provenance>
    </Card>
    <Card title="业务场景默认模板">
      <Table<Obj> rowKey="id" dataSource={presetRows} pagination={false} size="small" scroll={{ x: 700 }} columns={[
        { title: '场景模板', dataIndex: 'name' }, { title: '每人每分钟请求', dataIndex: 'requests_per_user_min' },
        { title: '输入Token', dataIndex: 'input_tokens' }, { title: '可见输出Token', dataIndex: 'answer_tokens' }, { title: '额外推理Token', dataIndex: 'reasoning_tokens' },
      ]} />
      <p className="basis-caption">输入阶段效率初始 {text(task.eta_prefill)}，生成阶段 {text(task.eta_decode)}；Dense结构修正初始1.10、MoE 1.20。这些是C级规划假设，不是论文或厂商公布的统一实测常数。</p>
      <div className="basis-example"><strong>换算示例</strong>100人在线、每人每分钟0.5次、每业务请求调用一次模型：λ = 100 × 0.5 ÷ 60 ≈ 0.833 请求/秒，而不是100个请求同时生成。完整数值可在“测算结果 → 查看计算依据”中复核。</div>
    </Card>
    <Card title="多模态、CV 与显存的处理">
      <Collapse defaultActiveKey={['multimodal', 'cv']} items={[
        { key: 'multimodal', label: '图文理解：视觉输入与编码要另计', children: <><Formula title="图文请求">Li总 = Li文本 + (图片数 + 抽取帧数) × 每图视觉Token<br />C图文 = λ × [(Fp + F视觉) ÷ ηp + Fd ÷ ηd] ÷ 10¹⁵</Formula><p>当前每图视觉Token初始 {text(task.visual_tokens_per_image)}；缺视觉编码实测时用 F视觉 ≈ {text(task.vision_flop_ratio)} × Fp 作为明确标记的经验代理。不同图像处理器、分辨率和切片方式需另外校准。</p></> },
        { key: 'cv', label: 'CV检测与其他任务：使用任务自身的单位', children: <><Formula title="视频检测与单位工作量">R帧 = 视频路数 × 每路分析帧率<br />C基础 = 每秒任务单位数 × 每单位FLOP ÷ η单位 ÷ 10¹⁵</Formula><p>CV也可直接填写图片/秒；离线任务可用“任务总量 ÷ 完成窗口秒数”换算速率。YOLO26的工作量只用于对应检测模型与输入尺寸；其他任务需匹配基线。<Source id="yolo" /></p><p>语音按音频单位、图像或视频生成按任务与规格计量。没有可靠基线时保留为未计入，不统一套用文本Token公式。</p></> },
        { key: 'memory', label: '显存：权重、缓存与运行空间分开考虑', children: <><Formula title="标准GQA / MHA缓存与模型服务组">在途请求数估计 = λ × (首响应目标秒数 + Lg ÷ 目标生成速度)<br />每Token缓存字节 = 2 × 层数 × KV头数 × 头维 × KV字节数<br />M服务组 = (权重 × 副本 + 各负载缓存之和 + 运行空间) ÷ (1 − 显存预留比例)</Formula><p>标准缓存公式来自逐层K/V张量的大小计数。混合注意力、MLA及压缩缓存采用专用描述或可见代理，不冒充标准GQA；未适配时只显示下界。当前显存预留初始 {percent(planning.memory_reserve)}，在途请求估计不代表已经验证响应承诺。</p></> },
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
      <p>初始按各模型峰值同时发生，创新池权重独立于业务池。图文调用的视觉输入应计入额度，并另外考虑视觉编码；非Token计量的生成服务需要独立的单位任务基线。</p>
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
