import { InputNumber, Popover } from 'antd';
import { ExclamationCircleOutlined } from '@ant-design/icons';
import type { Obj } from './api';

const templateNames: Record<string, string> = {
  qa: '知识问答', extract: '抽取/分类', document: '文档分析',
  report: '长报告/推理', vision: '图文问答',
};

const explanations: Record<string, { meaning: string; reason: string; adjust: string; unit?: string; placeholder?: string }> = {
  online_users: {
    meaning: '规划期末，同一时刻在线并可能使用该场景的用户人数。',
    reason: '人数来自业务规模，不设置通用默认值；在线人数会结合使用频率换算为模型请求负载。',
    adjust: '填写预计的高峰同时在线人数，不必填写正在生成回答的真实请求并发。',
    unit: '人', placeholder: '请输入在线人数',
  },
  requests_per_user_min: {
    meaning: '每位在线用户平均每分钟发起的业务请求次数。例如0.5表示平均每2分钟发起1次请求。',
    reason: '按场景模板设置早期估算的使用频次：阅读或生成长文档的场景通常需要更长的操作间隔。',
    adjust: '高频交互可调高；需要较长阅读或思考时间可调低。有真实使用记录时优先据此调整。',
    unit: '次/人/分钟',
  },
  request_rate: {
    meaning: '每秒进入模型服务的请求数，用于直接指定模型请求负载。',
    reason: '默认自动按“在线人数 × 每人每分钟请求 × 每业务请求模型调用次数 ÷ 60”推算，没有独立的固定数值。',
    adjust: '只有已知实际模型请求速率时才填写；填写后将覆盖在线人数换算。留空继续自动推算。',
    unit: '请求/秒', placeholder: '按在线人数自动推算',
  },
  input_tokens: {
    meaning: '单次模型调用的输入长度，包含系统提示、历史对话和检索材料；图文场景还会另外计入视觉Token。',
    reason: '根据场景模板预留常见输入预算，文档分析与长报告采用更长的上下文，便于早期估算。',
    adjust: '长文档、较多历史消息或检索材料较多时调高；短指令和结构化输入可调低。',
    unit: 'Token/请求',
  },
  answer_tokens: {
    meaning: '单次请求最终展示给用户的回答长度，不包含下面单列的额外推理Token。',
    reason: '按场景输出形态设置预算：抽取结果通常较短，问答居中，报告类输出较长。',
    adjust: '按实际答案、摘要或报告的预计长度修改；应与额外推理Token分别填写。',
    unit: 'Token/请求',
  },
  reasoning_tokens: {
    meaning: '模型生成答案前使用的额外思考或推理Token，与可见输出共同计入总生成长度。',
    reason: '普通问答默认不额外预留推理量；长报告/复杂推理模板单独预留思考预算。这是规划假设。',
    adjust: '启用思考模式或复杂推理时增加；已有总生成长度包含推理Token时避免重复计入。',
    unit: 'Token/请求',
  },
  calls_per_request: {
    meaning: '完成一次业务请求，需要调用该模型组件的次数。',
    reason: '默认按一次业务请求调用一次模型估算，避免无依据地放大需求。',
    adjust: '存在多轮Agent调用、反复重写或多次模型分析时，按真实调用链调整。',
    unit: '次/业务请求',
  },
  streams: {
    meaning: '需要同时进行视频分析的视频流或摄像头路数。',
    reason: '路数由实际业务确定，没有通用默认值；不能用在线用户人数直接替代。',
    adjust: '填写需要同时分析的路数，再结合每路分析帧率计算总帧数。',
    unit: '路', placeholder: '请输入视频路数',
  },
  analysis_fps: {
    meaning: '每路视频每秒实际送入CV模型分析的帧数，不一定等于视频的原始帧率。',
    reason: '默认使用抽帧分析的早期估算假设，避免自动把每一帧都计入。',
    adjust: '连续动作、快速目标等任务可提高；变化较慢、允许抽帧的场景可降低。',
    unit: '帧/秒/路',
  },
  images_per_request: {
    meaning: '一次业务请求需要处理的图片数或文档图像页数。',
    reason: '默认以单图请求作为基础估算单位，多页文档可通过图片数增加工作量。',
    adjust: '按照每次上传图片、扫描件页数或图文材料的实际数量调整。',
    unit: '张/请求',
  },
  visual_tokens_per_image: {
    meaning: '一张图片经视觉处理器转换后，送入语言模型的估算视觉Token数量。',
    reason: '这是用于图文理解早期规划的经验代理，不是所有模型、分辨率都固定使用的真实数量。',
    adjust: '高分辨率、图像切片较多时可能增大；有模型处理器的实测数量时优先替换。',
    unit: 'Token/图',
  },
  images_per_second: {
    meaning: '每秒需要进行CV分析的图片或视频帧总数。',
    reason: '默认不设置独立速率，优先用“视频路数 × 分析帧率”，或按在线请求量和每请求图片数推算。',
    adjust: '已知总处理速率时可直接填写；留空则继续采用路数或在线负载换算。',
    unit: '张/秒', placeholder: '按路数或在线负载推算',
  },
  units_per_second: {
    meaning: '每秒需要处理的任务单位数量，单位应与工作量基线一致，例如音频秒、样本或生成任务。',
    reason: '不同任务的计量单位不同，不设置通用默认值。',
    adjust: '有持续处理速率时直接填写；离线任务可留空，改填任务总量与完成窗口。',
    unit: '单位/秒', placeholder: '填写速率或下方离线任务量',
  },
  total_units: {
    meaning: '一批离线任务需要处理的总单位数。',
    reason: '取决于实际任务批次，不设置通用默认值；会结合完成时间转换为处理速率。',
    adjust: '例如音频总秒数、图片总张数或生成任务总数，注意与每单位FLOP保持同一种单位。',
    unit: '单位', placeholder: '请输入离线任务总量',
  },
  deadline_hours: {
    meaning: '完成整批离线任务所允许的时间窗口。',
    reason: '业务时限不同，没有统一默认值。相同任务量要求越快完成，所需容量越大。',
    adjust: '按业务可接受的完成时间填写；必须大于0。',
    unit: '小时', placeholder: '请输入完成时间',
  },
  flop_per_unit: {
    meaning: '模型处理一张图片、一帧或一个任务单位所需的计算工作量；这是FLOP，不是每秒算力FLOPS。',
    reason: 'CV场景优先采用所选模型、任务和输入尺寸匹配的官方基线；其他任务缺基线时不编造默认数值。',
    adjust: '更换模型或分辨率时重新核对。手动填写时需补充下方的基线来源或代理说明。',
    unit: 'FLOP/单位', placeholder: '需模型基线或自行填写来源',
  },
  eta_prefill: {
    meaning: '输入处理阶段，将算法工作量换算为参考规划容量时使用的有效效率系数。',
    reason: '采用早期估算的经验折减，考虑计算不能始终达到理论峰值；该数值不来自本项目的硬件实测。',
    adjust: '有匹配模型、框架和负载的测试数据时再校准；效率越低，规划容量越大。应大于0且不超过1。',
  },
  eta_decode: {
    meaning: '逐Token生成阶段的有效效率系数，用于从生成工作量估算参考容量。',
    reason: '生成阶段可能受带宽和批量限制，因此采用比输入阶段更保守的经验效率。',
    adjust: '使用匹配负载的测试结果校准；应大于0且不超过1，避免再重复乘同一种利用率折减。',
  },
  eta_unit: {
    meaning: 'CV或单位任务将算法工作量换算为规划容量时使用的有效效率。',
    reason: '在没有匹配实测时采用经验效率，以反映实际运行与理论峰值之间的差异。',
    adjust: '按模型、输入形状、批量和运行框架的实测情况校准；应大于0且不超过1。',
  },
  native_capacity: {
    meaning: '已知的某种原生精度下的容量，须同时填写原生精度。',
    reason: '不同精度的容量不能直接比较，因此没有统一默认值。',
    adjust: '根据已有测试或可信规格填写，并保留原始计量口径。',
    placeholder: '请输入已知原生容量',
  },
  reference_mapping: {
    meaning: '将已知原生精度容量映射到本产品P16参考口径的经核验系数。',
    reason: '不能仅根据位宽推算，不提供自动默认换算比例。',
    adjust: '只有存在可靠映射依据时才填写，并补充来源；否则原生精度容量单独展示。',
    placeholder: '仅在有核验依据时填写',
  },
};

export function parameterDefault(field: string, task: Obj, defaults: Obj, model?: Obj) {
  const templateValue = defaults.templates?.[task.template]?.[field];
  if (templateValue != null) return { value: Number(templateValue), source: 'template' };
  if (field === 'flop_per_unit' && task.task_type === 'cv' && model?.flop_per_unit != null) {
    return { value: Number(model.flop_per_unit), source: 'model' };
  }
  const value = defaults.task_defaults?.[field];
  return { value: value == null ? null : Number(value), source: 'system' };
}

export default function TechnicalParameterField({ task, field, label, defaults, model, onChange }: {
  task: Obj; field: string; label: string; defaults: Obj; model?: Obj;
  onChange: (value: number | null, origin: 'user_input' | 'template_default') => void;
}) {
  const fallback = parameterDefault(field, task, defaults, model);
  const value = task[field] == null ? fallback.value : Number(task[field]);
  const help = explanations[field];
  const source = fallback.source === 'model' ? '所选模型基线' : fallback.source === 'template' ? (templateNames[task.template] || task.template) + '场景模板' : '系统规划默认值';
  const defaultLabel = fallback.value == null ? '无固定默认值' : String(fallback.value) + (help?.unit ? ' ' + help.unit : '');
  const usingDefault = fallback.value != null && value === fallback.value && task.provenance?.[field]?.origin !== 'user_input';
  return <div className="field technical-parameter">
    <label>{label}{usingDefault && <span className="parameter-default-badge">默认</span>}</label>
    <InputNumber
      aria-label={label}
      min={0}
      value={value}
      onChange={next => onChange(next == null ? (defaults.task_defaults?.[field] == null ? null : Number(defaults.task_defaults[field])) : Number(next), next == null ? 'template_default' : 'user_input')}
      placeholder={help?.placeholder || '默认值加载中'}
      style={{ width: '100%' }}
      addonAfter={<Popover trigger="click" placement="topRight" title={label + '说明'} content={
        <div className="parameter-explanation">
          <p><strong>参数含义</strong>{help?.meaning || '该参数参与当前场景的容量估算。'}</p>
          <p><strong>{fallback.value == null ? '默认处理方式' : '默认值：' + defaultLabel}</strong>{help?.reason}</p>
          {fallback.value != null && <p className="parameter-source">来源：{source}{fallback.source === 'model' && model?.input_size ? ' · 输入尺寸 ' + model.input_size : ''}</p>}
          <p><strong>何时调整</strong>{help?.adjust}</p>
          <div className="parameter-reset-note">清空输入可恢复默认处理；手动填写后保留你的数值。</div>
        </div>
      }><button type="button" className="parameter-help" aria-label={label + '说明'} aria-haspopup="dialog"><ExclamationCircleOutlined aria-hidden="true" /></button></Popover>}
    />
  </div>;
}
