/**
 * 「估算方法说明」与「估算依据与口径」静态内容。
 * 逐字移植自推理评估集成页（frontend/public/inference-eval.html）的对应区块，
 * 保持公式、文献与数据来源表述一致；以 HTML 字符串渲染（内容为静态常量，无用户输入）。
 * 页面文案同步修改时，两边要一起改。
 */

export const METHOD_HTML = `
<p class="method-lead">推理服务不是「总算力 ÷ 有效算力」的单维估算：显存装不装得下、首 Token 时延达不达标、逐 Token 生成够不够快，是三条互相独立的约束。本页对每条约束分别求出<b>满足条件的最小卡数</b>，取三者最大值作为单场景结果；主导因素会随并发与时延目标在三者之间转移，因此三步都要算，不能只看其中一步。</p>
<div class="mflow">
  <span class="n">场景参数（输入/输出 · 并发 · SLA）</span><span class="a">＋</span>
  <span class="n">全局配置（卡型 · 精度 · 工程档位）</span><span class="a">→</span>
  <span class="n hl">A 显存 / B Prefill / C Decode</span><span class="a">→</span>
  <span class="n">max + 偶数 / 跨机对齐</span><span class="a">→</span>
  <span class="n">单场景卡数</span><span class="a">→</span>
  <span class="n hl">多场景求和</span>
</div>

<div class="msteps">
  <div class="mstep"><div class="no">1</div><div>
    <h4>输入与全局配置：把业务描述折算成计算参数</h4>
    <p>选场景类型会带出该场景的<b>输入长度、输出长度、并发数、TTFT/TPOT 目标</b>（也可点「调整参数」手动改）。全局三项配置决定硬件与效率口径：算力卡给出峰值算力、单卡显存与 HBM 带宽；<b>W/A/C 三轴量化分离</b>——权重精度定显存装载量、激活精度定峰值算力档位、KV 精度（自动跟随）定并发容量；工程开销档位只缩放「效率类」系数（Prefill MFU、Decode 带宽利用率全额，单卡显存利用率半幅；保守 ×0.8 / 均衡 ×1 / 激进 ×1.2），结构性开销与口径常数不受档位影响，可展开看各项生效值。若预设型号不适用，可登记「自定义算力卡」按厂商规格填写峰值算力、显存、带宽、互联与功耗，计算链路完全一致。</p>
    <p class="ref"><b>理论依据</b>：MFU（算力利用率）的度量口径见 PaLM（<a href="https://arxiv.org/abs/2204.02311" target="_blank" rel="noopener">arXiv:2204.02311</a>）；显存利用率与 KV 预留沿用 vLLM / PagedAttention 的可用显存划分方式（<a href="https://arxiv.org/abs/2309.06180" target="_blank" rel="noopener">arXiv:2309.06180</a>）；W / A / C 三轴量化档位为工程实践归纳，非单一文献结论。详见下方「估算依据与口径」。</p>
    <div class="fx-block"><div class="fx-t">有效单卡资源</div>
      <div class="fx-line"><div class="k"><b>有效算力</b></div><div><div class="f">峰值算力 × Prefill MFU × 档位系数</div><div class="s">MFU 定义见下方「估算依据与口径」PaLM 条目</div></div></div>
      <div class="fx-line"><div class="k"><b>可用显存</b></div><div><div class="f">单卡显存 × 显存利用率（默认 90%）</div><div class="s">预留系统/框架开销，不按标称容量写满</div></div></div>
      <div class="fx-line"><div class="k"><b>权重字节/参数</b></div><div><div class="f">BF16 = 2B　W8A8 = 1B　W4A8 = 0.5B</div><div class="s">W4A8 仅在芯片具备 INT4 峰值时可选（950 系列或填写了 INT4 峰值的自定义卡）</div></div></div>
    </div>
  </div></div>

  <div class="mstep"><div class="no">2</div><div>
    <h4>A · 显存约束：模型装得下，KV 放得开</h4>
    <p><b>显存看总参、算力看激活参</b>：MoE 模型推理要把全部专家装进显存（按 1.08 偏斜系数放大），计算时只激活少量专家。权重装载宽度按 2 的幂取 TP（机内上限 8 卡），权重超单机则按 8 的倍数跨机对齐（EP/PP）。KV Cache 按<b>连续批均值</b>预留，不是每路写满上下文窗口：每 token KV 由注意力结构决定（GQA 按 KV 头数折算、MLA 按低秩 latent，可压缩约一个量级）。若权重恰好装满导致 KV 房间为 0，自动提升装载宽度。</p>
    <p class="ref"><b>理论依据</b>：显存构成（权重 + KV + 激活峰值）与 KV 分块管理见 vLLM / PagedAttention（<a href="https://arxiv.org/abs/2309.06180" target="_blank" rel="noopener">arXiv:2309.06180</a>）；KV 每 token 的 GQA 折算见 <a href="https://arxiv.org/abs/2305.13245" target="_blank" rel="noopener">arXiv:2305.13245</a>，MLA 低秩折算见 DeepSeek-V3 技术报告（<a href="https://arxiv.org/abs/2412.19437" target="_blank" rel="noopener">arXiv:2412.19437</a>）；1.08 专家偏斜系数与 90% 显存利用率为工程经验值。</p>
    <div class="fx-block"><div class="fx-t">A · 显存约束</div>
      <div class="fx-line"><div class="k"><b>权重装载</b></div><div><div class="f">总参 × 权重字节 × 1.08　→　向上取 TP 宽度</div></div></div>
      <div class="fx-line"><div class="k"><b>每token KV</b></div><div><div class="f">GQA/MHA：2(K+V) × 层数 × KV头数 × 头维 × KV字节　/　MLA：层数 × (低秩维 + RoPE维) × KV字节</div><div class="f">层数、KV 头数/头维、低秩维取自模型公开配置；KV 字节随量化档自动跟随（BF16 2B / W8A8、W4A8 1B）。展开「计算过程」可见逐项代入</div></div></div>
      <div class="fx-line"><div class="k"><b>KV 需求</b></div><div><div class="f">KV/token × (输入 + 输出/2) × 并发 × 1.1 预留</div></div></div>
      <div class="fx-line"><div class="k"><b>副本数与 A</b></div><div><div class="f">房间 = 装载卡数 × 可用显存 − 权重</div><div class="f">副本数 = ceil(KV 需求 ÷ 房间)；A = 装载卡数 × 副本数</div></div></div>
    </div>
  </div></div>

  <div class="mstep"><div class="no">3</div><div>
    <h4>B · Prefill 约束：首 Token 时延（TTFT）达标</h4>
    <p>按稳态到达率 <b>λ = 并发 ÷ 单请求时长</b>（请求时长 = TTFT + 输出 × TPOT）估吞吐，每请求 Prefill FLOPs = GEMM（2 × 激活参 × 输入 <b>÷ FFN 有效利用率</b>）＋ 注意力项（4 × 层数 × 注意力宽 × 输入 × 有效跨度，<b>MLA 按 QK/V 完整头维计，低秩压缩只省 KV 缓存不省计算</b>）。FFN 有效利用率随 token 规模爬升：MoE 看「每专家平均分到的 token 数」，Dense 看 prompt 长度——短 prompt 的矩阵乘填不满，只跑出四到五成效率。<b>吞吐与排队双约束</b>：吞吐给出持续处理能力下限 N1；再逐卡数枚举服务时间＋M/G/1 排队等待，找到 TTFT ≤ 目标的最小卡数 N2（利用率 ρ ≥ 1 判为饱和、需加卡）。<b>排队不能忽略</b>，高并发下 TTFT 主要由等待时间主导。</p>
    <p class="ref"><b>理论依据</b>：连续批处理下的到达率与服务时间模型见 Orca（<a href="https://www.usenix.org/conference/osdi22/presentation/yu" target="_blank" rel="noopener">OSDI 2022</a>）与 Sarathi-Serve（<a href="https://arxiv.org/abs/2403.02310" target="_blank" rel="noopener">arXiv:2403.02310</a>）；排队等待按 M/G/1 近似（Kleinrock《Queueing Systems, Vol.1》）；每 token FLOPs ≈ 2 × 参数量 的算法见 kipp.ly（<a href="https://kipp.ly/transformer-inference-arithmetic/" target="_blank" rel="noopener">Transformer Inference Arithmetic</a>）。</p>
    <div class="fx-block"><div class="fx-t">B · Prefill 约束</div>
      <div class="fx-line"><div class="k"><b>单请求 FLOPs</b></div><div><div class="f">2 × 激活参 × 输入 ÷ FFN 有效利用率　＋　4 × 层数 × 注意力宽 × 输入 × 有效跨度</div><div class="s">FFN 有效利用率：MoE 0.07 + 0.43 × (1 − e^(−每专家token/800))（封顶 0.7）；Dense 0.42 + 0.58 × (1 − e^(−输入/5500))。MLA 的注意力宽 = 头数 × (QK头维 + V头维) ÷ 2</div></div></div>
      <div class="fx-line"><div class="k"><b>吞吐下限 N1</b></div><div><div class="f">ceil( λ × FLOPs/请求 ÷ (单卡有效算力 × 0.85) )</div><div class="s">0.85 为持续负载余量</div></div></div>
      <div class="fx-line"><div class="k"><b>时延下限 N2</b></div><div><div class="f">TTFT(N) = 服务时间(N) + 排队等待(ρ)</div><div class="f">枚举 N，取 TTFT(N) ≤ 目标 的最小值</div></div></div>
      <div class="fx-line"><div class="k"><b>结果</b></div><div><div class="f">B = max(N1, N2)</div></div></div>
    </div>
  </div></div>

  <div class="mstep"><div class="no">4</div><div>
    <h4>C · Decode 约束：逐 Token 时延（TPOT）达标</h4>
    <p><b>Decode 是带宽游戏</b>：每生成一个 token 都要把激活权重从显存读一遍，单步耗时取「计算时间」与「权重读取时间」的较大者；MoE 只读取命中的专家权重。枚举「TP 分片宽度 × 副本数」组合，取满足 TPOT 目标的最小总卡数。若目标严于<b>理论下限</b>（权重读取 ÷ HBM 带宽 + 固定开销），页面会给出「加卡无效」告警——此时应换更高带宽的卡或放宽时延目标，而不是继续加卡。</p>
    <p class="ref"><b>理论依据</b>：Decode 每步需读取激活权重、TPOT 受显存带宽约束的推导见 kipp.ly（<a href="https://kipp.ly/transformer-inference-arithmetic/" target="_blank" rel="noopener">Transformer Inference Arithmetic</a>）；混合批中 Prefill 抢占导致的 Decode 时延抖动见 Sarathi-Serve（<a href="https://arxiv.org/abs/2403.02310" target="_blank" rel="noopener">arXiv:2403.02310</a>）对 chunked-prefill 的动机分析；0.4 重叠惩罚与 1.35ms 调度开销为工程经验系数。</p>
    <div class="fx-block"><div class="fx-t">C · Decode 约束</div>
      <div class="fx-line"><div class="k"><b>单步耗时</b></div><div><div class="f">max( FLOPs/步 ÷ 分片有效算力, 权重字节 ÷ (分片 × HBM 带宽 × 利用率) ) + 固定开销</div></div></div>
      <div class="fx-line"><div class="k"><b>理论下限</b></div><div><div class="f">权重字节 ÷ (带宽 × 利用率) + 固定开销；目标更严 → 告警</div></div></div>
      <div class="fx-line"><div class="k"><b>结果</b></div><div><div class="f">C = 满足 TPOT 目标的最小「分片宽度 × 副本数」</div></div></div>
    </div>
  </div></div>

  <div class="mstep"><div class="no">5</div><div>
    <h4>合成与汇总：取最大、对齐、求和</h4>
    <p><b>当前按「混部」方式估算</b>：Prefill 与 Decode 共用同一批卡，因此单场景卡数取 <b>max(A, B, C)</b>——同一批卡同时要装下权重与并发 KV、要满足 TTFT、要满足 TPOT，三者取最紧的一条。若实际采用 <b>PD 分离</b>（Prefill 池与 Decode 池各自独立、卡数相加，两池各装一份完整权重），总卡数会高于这里的混部口径；本工具暂不区分这两种部署方式，混部口径也未单独计入 Prefill 尖峰对 TPOT 的干扰（该影响已折入 B 的计算预算占比与 C 的重叠惩罚两项系数）。单场景卡数还要奇数补偶，跨机按 8 的倍数对齐；页面行内标注最大者对应的<b>主导因素</b>（显存 / Prefill / Decode）。多场景按芯片型号分组求和（不同芯片不混算），算力汇总区给出总卡数与服务器台数（功耗不在页面汇总，单卡功耗仅在算力卡信息中展示）。<b>场景层只输出算力需求量</b>：故障冗余、业务突发等采购侧预留<b>不在场景层计算</b>，由池层「算力余量」统一加成（顶栏可调，余量只在池层乘一次）。每个场景行点「▸ 计算过程」可看到 A/B/C 三块公式代入当前具体数字的结果，逐步可复算。</p>
    <p class="ref"><b>理论依据</b>：三条约束取最大值是混部部署（同一批卡同时承担 Prefill 与 Decode）的容量口径，无公开标准，属工程口径；服务器台数按 8 卡/台折算（不同芯片不混机）；算力需求量为「恰好满足 SLA 的最小卡数」，不含故障冗余与业务突发——容量规划惯例中的 N+1 / 百分比冗余属采购口径，在需求量之外另行叠加，本工作台在池层以「算力余量」统一表达。</p>
    <div class="fx-block"><div class="fx-t">单场景 → 算力汇总</div>
      <div class="fx-line"><div class="k"><b>部署方式</b></div><div><div class="f">混部（P/D 同批卡，取 max）；PD 分离 = P 池 + D 池，本工具暂未建模</div></div></div>
      <div class="fx-line"><div class="k"><b>单场景</b></div><div><div class="f">cards = align( max(A, B, C) )　主导因素 = argmax(A, B, C)</div></div></div>
      <div class="fx-line"><div class="k"><b>算力汇总</b></div><div><div class="f">总卡数 = Σ 各场景卡数；含余量卡数 = 池层按余量比例放大并对齐 8 卡/台</div></div></div>
    </div>
  </div></div>
</div>
`;

export const BASIS_HTML = `
<h3 id="basis">估算依据：公开文献与理论出处</h3>
<ul>
  <li><b>显存装载与 KV Cache 容量</b>：vLLM / PagedAttention（SOSP 2023，<a href="https://arxiv.org/abs/2309.06180" target="_blank" rel="noopener">arXiv:2309.06180</a>）。</li>
  <li><b>Decode 带宽下限</b>：kipp.ly《Transformer Inference Arithmetic》（<a href="https://kipp.ly/transformer-inference-arithmetic/" target="_blank" rel="noopener">kipp.ly/transformer-inference-arithmetic</a>）。</li>
  <li><b>并发 / 到达率 / 时延目标的服务模型</b>：Orca（OSDI 2022，<a href="https://www.usenix.org/conference/osdi22/presentation/yu" target="_blank" rel="noopener">连续批处理开创工作</a>）与 Sarathi-Serve（OSDI 2024，<a href="https://arxiv.org/abs/2403.02310" target="_blank" rel="noopener">arXiv:2403.02310</a>）。</li>
  <li><b>注意力架构的 KV 折算</b>：GQA（EMNLP 2023，<a href="https://arxiv.org/abs/2305.13245" target="_blank" rel="noopener">arXiv:2305.13245</a>）与 DeepSeek-V3 技术报告（<a href="https://arxiv.org/abs/2412.19437" target="_blank" rel="noopener">arXiv:2412.19437</a>，MLA 架构）。</li>
  <li><b>MFU（算力利用率）度量口径</b>：PaLM 论文（<a href="https://arxiv.org/abs/2204.02311" target="_blank" rel="noopener">arXiv:2204.02311</a>）。</li>
  <li><b>排队时延近似</b>：M/G/1 排队模型（Kleinrock《Queueing Systems, Vol.1》）。</li>
</ul>

<h3>预设数据来源</h3>
<ul class="quota">
  <li>① <b>场景库 · 29 个预设</b>：按计算形态归类。参数与形态雷同的行业实例已合并到通用项（如政策 / 医学知识问答并入「知识库 / 领域问答」，政务公文 / 教案 / 病历文书并入「公文 / 结构化文书」）；跨行业通用场景统一放在「通用 · …」分组，仅保留带行业特有口径的场景在「行业专属」。每项含输入长度、输出长度、TTFT / TPOT 目标与默认并发；「长任务 Agent 对话」按累积上下文峰值与同时在跑的会话数估算。</li>
  <li>② <b>模型库 · 32 个预设</b>：总参 / 激活参、层数、注意力结构（MHA / GQA / MLA、KV 头数与头维）等字段，按各厂商公开资料整理。</li>
  <li>③ <b>芯片规格 · 8 张预设卡</b>：昇腾 910B 64GB / 32GB 两档、910C（推理整机 560T 版：560T / 128GB / 3.2TB/s），以及 950PR 2 档（32 / 28 Cube）+ 950DT 3 档（36 / 32 / 28 Cube），逐档数值、算力 / 带宽 / 功耗口径与官方链接见下一节<b>「预设芯片：官方数据来源（逐档）」</b>。</li>
  <li>④ <b>工程系数</b>：Prefill / Decode 的 MFU、带宽利用率、KV 预留系数为工程经验值，按芯片分档给定，其中<b>效率类</b>三项随「工程开销档位」缩放——Prefill MFU 与 Decode HBM 带宽利用率全额跟随，单卡显存容量利用率半幅跟随（√系数，因为其中一半是框架固定占用），保守 ×0.8 / 均衡 ×1 / 激进 ×1.2，缩放后夹在合理区间内；<b>结构性开销与口径常数不随档位变化</b>。910C 的 Prefill MFU 取 <b>26%</b>（长序列大 GEMM 的实际达峰约为峰值的四分之一，1120T × 0.26 ≈ 291T/卡），Decode 有效 MFU 约 20.8%，两者分开标定、不互相牵连。<b>全部系数均可在「当前生效的工程系数」里按自身经验改写</b>（基准值，档位缩放仍在其上生效），每项都附取值原因与影响范围；改动写入参数覆盖层并长期生效（与「基线与设置 → 推理参数」同一存储），恢复默认随时可回。</li>
  <li>⑤ <b>场景参数性质</b>：TTFT / TPOT 目标、并发数、输入输出长度均为工程经验默认值，<b>不是公开标准</b>，应按现场业务在「调整参数」中改写。</li>
  <li>⑥ <b>自定义算力卡</b>：规格由使用者按厂商资料填写，<b>不属于预设数据</b>；工程系数沿用通用经验值（Prefill MFU 0.38、Decode 带宽利用率 0.66、KV 预留 1.10）。自定义规格未经现场压测校准，误差可能放大。</li>
</ul>

<h3>预设芯片：官方数据来源（逐档）</h3>
<p class="src"><b>昇腾 910 家族：2 款芯片（910B / 910C）。910B 芯片层有 4 个型号，Cube 核数分 24（B1/B2）与 20（B3/B4）两档</b>，
但官方只按整机 / 标卡公布标称算力、未逐型号公开，因此本工具按<b>可交付配置</b>拆卡（与 950 的档位拆法一致）：</p>
<div class="tbl-wrap"><table class="dt chip-tbl">
  <thead><tr><th>芯片型号</th><th>Cube 核 / Vector 核</th><th>FP16/BF16</th><th>INT8</th><th>片上内存</th><th>对应已公开配置</th><th>本工具预设</th></tr></thead>
  <tbody>
    <tr><td>910B1</td><td>24 / 48</td><td rowspan="2">未逐型号公开</td><td rowspan="2">未逐型号公开</td><td>64GB</td><td>Atlas 900T A2 液冷集群</td><td class="dim">走自定义卡</td></tr>
    <tr><td>910B2</td><td>24 / 48</td><td>64GB</td><td>Atlas 800T A2（高算力档）</td><td class="dim">走自定义卡</td></tr>
    <tr><td>910B3</td><td>20 / 40</td><td>280T</td><td>560T</td><td>64GB @ 1.6TB/s</td><td>Atlas 800T A2 / 800I A2（64GB 款）</td><td><b>✔ 910B · 64GB</b></td></tr>
    <tr><td>910B4</td><td>20 / 40</td><td>280T</td><td>560T</td><td>32GB @ 0.8TB/s</td><td>Atlas 300T A2 标卡 / 800I A2（32GB 款）</td><td><b>✔ 910B · 32GB</b></td></tr>
    <tr><td>910C</td><td>官网未公开</td><td>560T（整机 ÷8）</td><td>1120T（2× 折算）</td><td>128GB @ 3.2TB/s</td><td>Atlas 800I A3 推理服务器（8×昇腾910，整机 4.48 PFLOPS）</td><td><b>✔ 910C · 128GB</b></td></tr>
  </tbody>
</table></div>
<p class="src">来源：<a href="https://e.huawei.com/cn/products/computing/ascend/atlas-800t-a2" target="_blank" rel="noopener">Atlas 800T A2 训练服务器 ↗</a> · <a href="https://e.huawei.com/cn/products/computing/ascend/atlas-800i-a2" target="_blank" rel="noopener">Atlas 800I A2 推理服务器（整机互联 392GB/s）↗</a> · <a href="https://e.huawei.com/cn/products/computing/ascend/atlas-800i-a3" target="_blank" rel="noopener">Atlas 800I A3 推理服务器（8×昇腾910，整机 4.48 PFLOPS FP16 / 8×128GB / 3.2TB/s / D2D 784GB/s 双向）↗</a> · <a href="https://www.hiascend.com/hardware/cluster?tag=800a3" target="_blank" rel="noopener">Atlas 800 A3 风冷超节点（同类整机 6.0 PFLOPS，对应 750T/卡口径）↗</a> · <a href="https://www.huawei.com/cn/news/2025/9/hc-xu-keynote-speech" target="_blank" rel="noopener">全联接大会 2025 · 910C 芯片标称 800T FP16 ↗</a>。
<b>910C 自本版起取推理整机口径 560T</b>：官网 800I A3 页只写「昇腾910」，未出现「910C」「560T 版本」字样，560T 由整机 4.48 PFLOPS ÷ 8 颗 NPU 反推，属<b>对应 / 反推</b>而非官网型号标注；该页亦未列单卡 FP32、INT8、die 数与封装形式，故 INT8 按 910 同代 1:2 折算 1120T（非官网标称）。
910B4 的 32GB 档数据取自 Atlas 300T A2 训练卡产品彩页（280T FP16 / 32GB HBM / 800GB/s / 350W），该标卡页已随产品线调整下线，故仅以文字标注、不挂失效链接。</p>
<p class="src" style="margin-top:10px"><b>昇腾 950 系列：2 款芯片（950PR / 950DT）、5 个 Cube Core 计算能力档</b>。下表数值取自官方处理器规格页（「Cube + Vector」总算力口径），五档在本工具中均为可选预设卡。<b>档位前的数字（32 / 28 / 36）指 Cube Core（AI 矩阵核）数量</b>，不是 CPU 核数或线程数，也不是 Vector 核：</p>
<div class="tbl-wrap"><table class="dt chip-tbl">
  <thead><tr><th>预设档位</th><th>Cube 核 / Vector 核</th><th>FP16/BF16</th><th>FP8 · INT8</th><th>MXFP4</th><th>片上内存</th><th>对应已公开配置</th></tr></thead>
  <tbody>
    <tr><td>950PR · 32 Cube</td><td>32 / 64</td><td>486T</td><td>919T</td><td>1784T</td><td>128GB @ 1.6TB/s</td><td>芯片满配档</td></tr>
    <tr><td>950PR · 28 Cube</td><td>28 / 56</td><td>425T</td><td>804T</td><td>1561T</td><td>112GB @ 1.4TB/s</td><td>Atlas 350 加速卡</td></tr>
    <tr><td>950DT · 36 Cube</td><td>36 / 72</td><td>547T</td><td>1034T</td><td>2007T</td><td>144GB @ 4.0TB/s</td><td>950 超节点满配</td></tr>
    <tr><td>950DT · 32 Cube</td><td>32 / 64</td><td>486T</td><td>919T</td><td>1784T</td><td>96GB @ 4.0TB/s</td><td>Atlas 850E 整机</td></tr>
    <tr><td>950DT · 28 Cube</td><td>28 / 56</td><td>425T</td><td>804T</td><td>1560T</td><td>96GB @ 4.0TB/s</td><td>Atlas 650E 整机</td></tr>
  </tbody>
</table></div>
<p class="src">来源：<a href="https://www.hiascend.com/hardware/processor?tag=950pr" target="_blank" rel="noopener">Ascend 950PR 处理器规格 ↗</a> · <a href="https://www.hiascend.com/hardware/processor?tag=950dt" target="_blank" rel="noopener">Ascend 950DT 处理器规格 ↗</a> · <a href="https://www.hiascend.com/hardware/accelerator-card?tag=300T" target="_blank" rel="noopener">Atlas 350 加速卡（112GB / 804T / ≤600W）↗</a> · <a href="https://www.hiascend.com/hardware/ai-server?tag=650e" target="_blank" rel="noopener">Atlas 650E 服务器（12.48 PFLOPS MXFP4 ÷ 8）↗</a> · <a href="https://www.hiascend.com/en/hardware/cluster?tag=850e" target="_blank" rel="noopener">Atlas 850E SuperPoD（14.27 PFLOPS ÷ 8）↗</a>。注：Atlas 650E 彩页 12.48 PFLOPS MXFP4 ÷ 8 卡 = 1560T，与芯片档 1561T 的 1T 差为四舍五入，预设卡取整机口径 1560T。</p>
<p class="src"><b>口径说明</b></p>
<ul class="quota">
  <li>① <b>算力口径</b>：表中 FP16 / FP8·INT8 / MXFP4 均为官方「Cube + Vector 总算力」。官方同表另给「仅 Cube」矩阵算力（950PR 32/28 Cube：FP16 432/378T、FP8·INT8 865/756T；950DT 36/32/28 Cube：FP16 486/432/378T、FP8·INT8 973/865/756T）。本工具按总算力估 MFU，若做纯矩阵算力对拍，需按仅 Cube 口径折减。全联接大会 2025 公布的 950 系列 FP8 1P / FP4 2P 为<b>芯片峰值天花板</b>（<a href="https://www.huawei.com/cn/news/2025/9/hc-xu-keynote-speech" target="_blank" rel="noopener">徐直军主题演讲 ↗</a>），低于表中满配档的 919T / 1784T，属不同统计口径，勿混用。</li>
  <li>② <b>五档与实物的对应</b>：官网处理器页按 Cube Core 数量给出 32/28（PR）与 36/32/28（DT）五档，已公开整机/标卡各自对应其中一档——Atlas 350 = PR-28、Atlas 650E = DT-28、Atlas 850E = DT-32；<b>不存在「整机标称只有一个值」的说法</b>，此前仅取 425T/804T 是把最低档当成了全系代表。</li>
  <li>③ <b>互联带宽</b>统一取<b>芯片级单向等效值</b>（官方双向标称 ÷2）：910B 196（64GB/32GB 两档相同，800I A2 整机 8 卡全互联 392 双向）、910C 392（800I A3 页 D2D 双向 784GB/s ÷2）、950 系列 1000GB/s（灵衢 2.0 最大 2TB/s 双向）。Atlas 350 标卡的卡间灵衢连接器为 424GB/s（双向），按标卡组网时可在自定义卡中填 212。</li>
  <li>④ <b>功耗</b>：910B 64GB 档 300W、32GB 档（Atlas 300T A2 标卡）350W，910C 600W，均取板卡级公开值；950PR 取标卡 ≤600W；950DT 官方只公布整机功耗（650E 14.5kW、850E 15.6kW，含 2×鲲鹏 950 与风扇），扣公共部件后单卡按 0.90 / 0.95 / 1.00kW 工程估算，36 Cube 满配取 1.00kW。</li>
  <li>⑤ <b>显存配对（未决项）</b>：《昇腾950 NPU架构白皮书》表 3-1 给出 DT 支持 144GB / 96GB，但未把 36/32/28 Cube 与容量逐档绑定。本工具按已公开整机配置配对（满配 144GB ↔ 36 Cube，96GB ↔ 32/28 Cube），<b>订货请以官方配置表为准</b>；官网处理器页另列 PR 84GB 容量档，未作为独立 SKU，需要时走「自定义算力卡」。</li>
  <li>⑥ <b>「核」的口径</b>：档位数字是芯片内 <b>Cube Core（3D 矩阵运算核）</b>的个数，Vector Core 数为 2 倍（32/64、28/56、36/72）——它不表示 CPU 核数，也不表示整机的服务器 CPU 配置。做纯矩阵算力对拍时看「仅 Cube」一列；本工具的算力/显存/带宽取值与核数无关，只按档位整体标称，改动档位不会影响计算链路。</li>
  <li>⑦ <b>选卡建议</b>：950PR 偏 Prefill（1.6TB/s、128GB，算力密度最高），950DT 是<b>「以带宽换容量」</b>（4.0TB/s、96/144GB），Decode 带宽下限与 TPOT 敏感场景更占优；长上下文、大权重这类显存主导场景仍可能更吃卡，选档时优先看显存而不是标称算力。</li>
  <li>⑧ <b>910 家族与 950 的差异</b>：950 官方逐档给规格，故 5 档全列；910B 官方只给整机 / 标卡标称（Atlas 800T A2 整机 2.24 PFLOPS ÷ 8 = 280T/卡），4 个型号中只有 20 Cube 档有公开标称，<b>24 Cube 的 B1/B2 未逐型号公开算力</b>（第三方测算 376 / 414T，主要用于液冷 Atlas 900T A2），故未写进预设、需要时走自定义卡，避免把未核验数字当成官方规格。910C 为单款单档：本工具取<b>推理整机口径 560T</b>（Atlas 800I A3 整机 4.48 PFLOPS ÷ 8 颗 NPU），显存 128GB、带宽 3.2TB/s、D2D 784GB/s 双向均取自该页技术规格表；官网另有超节点整机 6.0 PFLOPS ÷ 8 = 750T 与芯片标称 800T，属不同交付形态 / 统计口径，按那一口径估算时在自定义卡填 750 / 800 重算即可，勿与预设值混用。</li>
</ul>

<h3>免责声明</h3>
<p class="src">本工具基于理论模型与工程经验估算，<b>非实测数据</b>；长输入（&gt;64K）与长输出（&gt;16K）档估算误差放大，结论仅作量级参考；验收与投资决策以现场压测为准。数据更新时间：2026-11。</p>
`;
