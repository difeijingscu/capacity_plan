import { Alert, Button, Card, Steps, Table, Tag } from 'antd';
import { ArrowLeftOutlined, ArrowRightOutlined, BookOutlined } from '@ant-design/icons';

const ownershipRows = [
  { level: '项目', purpose: '管理一次独立的规划工作', contents: '项目名称、归档状态、所属方案', relationship: '一个项目可以包含多个方案；不同项目分别管理。' },
  { level: '规划方案', purpose: '保存一套可以完整测算的规划选择', contents: '容量余量、显存预留，以及三类规划', relationship: '一个方案归属一个项目；复制后各方案独立维护。' },
  { level: '测算记录', purpose: '保留某次输入对应的结果和依据', contents: '方案修订、输入与模型快照、计算结果', relationship: '同一个方案可有多次测算记录，历史结果保持当时口径。' },
];
const poolRows = [
  { name: '业务场景规划', question: '已经明确要建设的AI应用，需要多少算力？', inputs: '场景清单、在线人数、模型、请求与输入输出参数', structure: '多个场景；每个场景可以有多个计算组件。' },
  { name: '创新服务规划', question: '为内部人员提供灵活的模型调用，需要多大的服务池？', inputs: '支持人数、人均月Token额度、模型份额、服务窗口', structure: '一个Token服务池；多个模型按份额分享总额度。' },
  { name: '开发测试规划', question: '为模型微调，需要多少实验资源？', inputs: '候选模型、微调强度、单次完成窗口、并行槽位', structure: '一个开发测试池；按单任务微调能力及允许的并行数量配置。' },
];
const exampleRows = [
  { name: '基准方案', business: '1.2 P', innovation: '0.3 P', development: '0.5 P', total: '2.0 P' },
  { name: '扩展方案', business: '1.8 P', innovation: '0.5 P', development: '0.7 P', total: '3.0 P' },
];
const navigationRows = [
  { name: '业务场景', content: '当前方案中的业务场景清单及参数', scope: '随当前方案切换' },
  { name: '创新服务', content: '当前方案中的Token服务池配置', scope: '随当前方案切换' },
  { name: '开发测试', content: '当前方案中的开发测试池配置', scope: '随当前方案切换' },
  { name: '测算结果', content: '查看计算结果；历史列表包含同一项目下各方案的计算记录', scope: '查看记录与编辑方案分别选择' },
  { name: '规划依据 / 规划方案组织设计', content: '所有项目通用的方法与使用说明', scope: '无需创建项目即可阅读' },
  { name: '基线与设置', content: '工作空间共用的模型、任务基线及参考设置', scope: '共用目录；旧测算保留当时快照' },
];

export default function PlanningOrganization({ onBack, onBasis }: { onBack: () => void; onBasis: () => void }) {
  return <div className="planning-organization">
    <div className="basis-intro">
      <div><span className="eyebrow">PROJECT · PLAN · RESOURCE POOLS</span><h2>一次规划工作，多套方案，三类资源池。</h2><p>了解数据归属、需求汇总与方案比较的关系，再开始填写自己的规划。</p></div>
      <Button icon={<ArrowLeftOutlined aria-hidden="true" />} onClick={onBack}>返回项目概览</Button>
    </div>
    <div className="basis-content">
      <Card title="整体组合关系">
        <p><strong>一个项目可以包含多个规划方案；每个方案包含业务场景、创新服务、开发测试三部分，三部分共同形成这个方案的算力需求。</strong></p>
        <div className="organization-diagram" role="group" aria-label="项目、规划方案和三类资源池的组合关系图">
          <div className="organization-project"><span>规划项目</span><strong>示例：某组织算力规划</strong><small>管理一次独立的规划工作</small></div>
          <p className="organization-connector">↓ 包含多个方案，各自保存完整的规划 ↓</p>
          <div className="organization-branches">{[
            { name: '基准方案', note: '创建项目时自动生成', kind: 'default' },
            { name: '对比方案', note: '复制已有方案后独立调整', kind: 'alternative' },
          ].map(plan => <div className={'organization-branch ' + plan.kind} key={plan.name}>
            <div className="organization-plan"><strong>{plan.name}</strong><small>{plan.note}</small></div>
            <div className="organization-pools"><span>业务场景规划</span><span>创新服务规划</span><span>开发测试规划</span></div>
            <div className="organization-result">↓ 三类资源池汇总<strong>{plan.name}的测算结果</strong></div>
          </div>)}</div>
          <div className="organization-diagram-note">同一方案内汇总需求 · 不同方案之间比较选择</div>
        </div>
        <p className="basis-caption">关系图用于解释当前应用的组织方式，不代表自动生成了项目、对比方案或实际容量。</p>
      </Card>

      <Card title="01 · 项目与方案：信息分别保存在哪里">
        <p><strong>项目</strong>是最外层的管理容器。例如“某集团2029年AI算力规划”和“某研究院算力建设规划”可以分别建立项目。概览中显示两个项目，表示保存了两份独立规划工作；当前不会自动把所有项目汇总为组织总算力。</p>
        <p><strong>规划方案</strong>保存具体内容。创建项目后自动生成“基准方案”，它是默认方案的名称，可以继续编辑。项目卡片中的“基准方案”按钮，实际用于打开该项目的默认规划内容。</p>
        <Table rowKey="level" size="small" pagination={false} dataSource={ownershipRows} scroll={{ x: 800 }} columns={[
          { title: '层级', dataIndex: 'level', width: 110 }, { title: '用途', dataIndex: 'purpose' },
          { title: '保存的内容', dataIndex: 'contents' }, { title: '归属关系', dataIndex: 'relationship' },
        ]} />
        <div className="basis-example"><strong>什么时候复制方案？</strong>需要考察另一种人数规模、模型选择、Token额度或实验能力时，点击“复制方案”。新方案会复制当前三类规划及共同参数，此后独立维护，修改其中一套不会同步修改另一套。复制方案不会复制出一份新的历史测算结果，需要基于新方案计算。</div>
        <p className="basis-caption">容量余量与显存预留保存在方案中，三类规划各自独立配置。方案按当前峰值规模测算，不包含规划年限与增长率这类时间外推参数。</p>
      </Card>

      <Card title="02 · 三类规划：并列配置，各自解决不同的问题">
        <Table rowKey="name" size="small" pagination={false} dataSource={poolRows} scroll={{ x: 850 }} columns={[
          { title: '规划部分', dataIndex: 'name', width: 130 }, { title: '回答的问题', dataIndex: 'question' },
          { title: '主要输入', dataIndex: 'inputs' }, { title: '内部组织方式', dataIndex: 'structure' },
        ]} />
        <div className="basis-example"><strong>业务场景：组件 → 场景 → 业务池</strong>一个“视频智能告警”场景可以拆成“目标检测”和“告警文字生成”两个计算组件。先汇总组件得到场景需求，再汇总所有场景得到业务场景池需求。场景高峰默认同时发生；兼容的同模型服务可以共享基础权重，计算负载仍分别相加。</div>
        <div className="basis-example"><strong>创新服务：一份总额度 → 多个模型份额 → 服务池</strong>支持1000人，每人每月100万Token，总额度为每月10亿Token。两个模型按70%和30%分配时，分别按7亿和3亿Token估算。无需事先逐一列出所有未来创新应用。</div>
        <div className="basis-example"><strong>开发测试：候选模型 → 单任务微调能力 → 并行槽位</strong>选中三个模型表示资源池需要能承接这三个模型的微调，不等于三个模型始终同时训练。系统按候选模型所需的最大单任务微调能力，再结合微调槽位数配置资源；评测算力不在本池规划范围内。</div>
        <p className="below">三部分可分别填写。业务场景中选择的模型，不会自动加入创新服务或开发测试，各池需独立确认支持哪些模型。</p>
        <Alert type="info" showIcon message="普通新建项目与示例项目的区别" description="普通新建项目的业务清单为空，创新服务和开发测试默认关闭；关闭的池不计入需求。载入示例项目时会预填三类规划，便于体验完整流程。" />
      </Card>

      <Card title="03 · 汇总与比较：资源池如何组合，方案如何使用">
        <div className="basis-formula"><span>同一个方案内部</span><div>方案建议总算力 = 业务场景建议算力 + 创新服务建议算力 + 开发测试建议算力</div><small>各池已经包含余量时，总计不再重复增加余量；有缺失任务时，结果只代表已计入部分。</small></div>
        <p>当前三类资源池按独立配置处理。即使业务池与创新池使用相同模型，也分别计入容量与显存，不自动跨池共享。</p>
        <div className="organization-example-label"><Tag color="gold">纯示意数值</Tag><span>下面各池均假设已包含余量，采用相同的 BF16 基准口径。</span></div>
        <Table rowKey="name" size="small" pagination={false} dataSource={exampleRows} scroll={{ x: 620 }} columns={[
          { title: '同一项目下的方案', dataIndex: 'name' }, { title: '业务场景', dataIndex: 'business' },
          { title: '创新服务', dataIndex: 'innovation' }, { title: '开发测试', dataIndex: 'development' },
          { title: '方案总需求', dataIndex: 'total', render: value => <strong>{value}</strong> },
        ]} />
        <p className="below">这里提供的是“基准方案需要2.0 P”和“扩展方案需要3.0 P”两种选择，可比较参数差异与需求变化。两个方案是备选规划，项目不会把它们相加为5.0 P。</p>
      </Card>

      <Card title="04 · 页面切换：左侧栏目跟随当前方案">
        <p>在项目概览点击“项目A → 基准方案”后，即确定当前正在编辑的项目与方案。业务场景、创新服务和开发测试三个页面，展示的都是这套方案中的内容。</p>
        <Table rowKey="name" size="small" pagination={false} dataSource={navigationRows} scroll={{ x: 760 }} columns={[
          { title: '页面', dataIndex: 'name', width: 220 }, { title: '展示内容', dataIndex: 'content' }, { title: '作用范围', dataIndex: 'scope' },
        ]} />
        <div className="basis-example"><strong>怎样确认自己正在编辑哪一套内容？</strong>查看规划页面标题下方的项目名称，以及上方“当前方案”选择框。切换项目A的对比方案后，三个规划页面一起切换到对比方案的数据；打开项目B的方案后，则切换到项目B。</div>
        <p className="basis-caption">返回项目概览或阅读通用说明后，当前选择仍保留。阅读本页不会重新载入方案或清空未保存输入。</p>
      </Card>

      <Card title="05 · 方案修订与测算记录：输入和结果分别管理">
        <p><strong>方案</strong>保存当前规划输入，<strong>测算记录</strong>保存某次计算时的输入和结果。同一个方案可以修改多次并保留不同版本的测算记录。</p>
        <div className="organization-history">
          <div><span>第一次填写</span><strong>业务人数100人</strong><small>保存并测算 → 形成对应结果</small></div>
          <span className="organization-history-arrow" aria-hidden="true">→</span>
          <div><span>修改同一方案</span><strong>业务人数200人</strong><small>再次保存并测算 → 形成新结果</small></div>
        </div>
        <p>上述过程中仍然只有一个基准方案，只是产生了不同输入版本对应的测算记录。历史结果保留当时的参数和模型依据；修改输入后需再次测算，旧结果不会自动更新。相同输入版本的重复计算可以复用已有记录。</p>
        <Alert type="info" showIcon message="“当前方案”与“历史计算版本”分别选择" description="测算结果页的历史列表可以查看同一项目下不同方案的计算记录。切换历史计算版本只是在查看结果，不会切换正在编辑的方案；与当前方案输入不一致时，页面会提示这是历史快照。" />
      </Card>

      <Card title="06 · 建议的使用顺序">
        <Steps direction="vertical" current={-1} items={[
          { title: '选择项目与方案', description: '新建项目会生成基准方案；已有项目点击对应方案进入。' },
          { title: '填写三类规划', description: '导入或填写业务场景，按需要启用创新服务和开发测试，确认共同规划口径。' },
          { title: '保存并测算', description: '三类资源池在当前方案内统一计算，查看总需求、分项结果与计算依据。' },
          { title: '比较不同选择', description: '复制方案、修改假设后再测算；也可以比较同一方案修改前后的历史结果。' },
        ]} />
        <div className="organization-basis-action"><span>需要了解具体公式、默认参数及资料来源？</span><Button type="link" icon={<BookOutlined aria-hidden="true" />} onClick={onBasis}>查看规划思路和依据 <ArrowRightOutlined aria-hidden="true" /></Button></div>
      </Card>
    </div>
  </div>;
}
