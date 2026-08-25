# Decision Log — 2026-08-22: T01b 语料策略裁决（三模型共识 + 用户三裁定）

> TASK: T01b / DEBT-20260821-t20-01/02｜蓝图锚点：`docs/niko-buddy-master-blueprint-2026.md` §6 P0 表 T01a / §7 A-01.1
> 关联：`QMAI/docs/p6/data-dependency-unlock-runbook.md` §1/§2、`docs/p0/corpus/manifest.json`、`QMAI/docs/debt-triage-ledger.md` #22/#23

## 背景

用户提供 `D:\writing`（约 45 GB）作为真实语料候选源。经 deepseek-v4-flash（授权甄别）+ ox-alpha-free（技术规格实测）+ hy3（入库方案）三模型独立评估后共识：**直接入库不可行**，核心障碍为授权缺失与题材错配。

### 三票关键证据

- **书/**（3.5G, 253 文件）：dushupai.com 盗版下载站（免责声明明示"版权归著作人、24h 删除"）；即使《西游记》《聊斋》等原著公版，盘内文件为现代注释/翻译版（衍生版权）→ **0 可用**
- **_项目/网文**（407 txt, 3.76G）：商业网文全集（诡秘之主/斗破苍穹等），§4 明文禁止 → **0 可用**（仅可 §5.1 特征提取）
- **悬疑/写作技巧/写作分析**：受版权小说+教材+AI 研究报告 → **0 可用**
- **_仓库镜像**（32G）：kanripo 文言典籍镜像，非虚构 → 对标定零贡献
- **_项目/8人**：用户自有原创小说（6 章 + 陈烬间章），实测唯一正文 2.27 万字；但经 74 个 AI 扩写脚本加工，**不能冒充纯 human 层**
- 体量与可用性完全脱钩：45 GB 中合法可入库量仅来自《8人》

## 用户裁决（2026-08-22）

| # | 裁决项 | 决定 |
|---|--------|------|
| D1 | 题材策略 | **A：目标族增补悬疑（xuanyi）为第四正式标定族** |
| D2 | 《8人》处置 | **入库为 ai 层**（original-contributed + AI 扩写如实披露，genre=xuanyi） |
| D3 | 目标口径矛盾 | **以 runbook 每族≥100 为准**；manifest 同步上调消除矛盾 |

D1+D3 合并推论：解锁线 = 每族 ≥100 篇 human + ≥100 篇 ai × 四族 = **400+400**（原三族 300+300 + 悬疑族 100+100）。

## 执行记录

1. **anti-ai-calibrate.js**：5 处硬编码 genres 数组/genreLabels 增补 `xuanyi: "悬疑"`（:395/:427/:472/:662/:670）。孪生文件 `src/lib/novel/anti-ai-candidate-pool.ts` 经核验为动态 genre 提取，无需改动。
2. **runbook §1**：族别列表与前缀清单增补 xuanyi。
3. **debt-triage-ledger #22/#23**：解锁条件措辞同步。
4. **manifest.json corpus_meta**：target_human/ai=400、hard_cap=500、quota_per_genre=100、genres 增补 xuanyi——矛盾消除。
5. **batch-20260822-writing 入库**：《8人》正文段级去重（508 唯一段）切篇 **60 片**（~400 字/片）入 `ai/batch-20260822-writing/xuanyi-001..060.txt`，license=original-contributed，AI 辅助披露写入批次 notes。current_ai=90。
6. **BATCH_ID 未切换**：仍指向 synthetic-degraded 种子批。切换条件 = 悬疑族 human 侧样本量可行（当前 ai 侧 60/100，human 侧 0/100）。提前切换会因 human 层为空触发脚本 exit(1) 且以 n=0 覆盖基线标定报告。

## 影响与后续

- T20 两笔债**仍阻塞**（真实语料缺口：四族 human 各 ≥100、言情/古风/玄幻 ai 各 ≥100、悬疑 ai 差 40）。
- 用户补采最小行动：①悬疑族 human 侧（自有手写或授权文本）②言情/古风/玄幻两侧另寻公版/授权来源。
- 数据到位当天按 runbook §1 三步执行即可开工。

## 追记（2026-08-22 同日）：特征提取轨启用

用户后续指示「使用 D:/writing 资料暂搁版权争议」。处置：
- **红线维持**：版权文本不入语料库/git（§4/§5 明文 + 交付证据链不可污染）
- **合规路径**：§5.1 特征提取轨——`scripts/shadow-factor-profile.mjs` 原地只读计算四因子分布，
  文本不落盘，产物 `docs/p2/anti-ai-shadow-profile.md` 仅内部参考、禁作发版宣称/block 解锁依据

### 重构
- 因子实现抽取为 `scripts/lib/anti-ai-factors.mjs`（逐字节程序化抽取，PAT-G2 孪生唯一实现），
  calibrate 脚本 -249 行改为 import；node --check + 导出绑定审计通过

### 影子画像首跑结论（1070 片真实商业文本）
- **段落长度因子在真实人类文本上 warn 触发率：玄幻 48.4% / 古风 46.4% / 悬疑 35.7%**
  （种子基线 0%）——CV<0.3 阈值面若直接用于真实语料将产生灾难性误报，
  正式重标定时该因子需重点重推导（分位数化阈值候选）
- 句式熵/标点指纹相对条件在真实文本上保持稳健（0% 触发）
- 此发现实证强化了 t20 债的前提：「synthetic 标定不可靠」——且给出了具体失效点

## 追记二（2026-08-23）：用户裁决——版权采样入本地隔离区

用户明确指示「使用 D:/writing 资料，争议直接搁置」。处置升级：
- `scripts/ingest-local-samples.mjs` 按比例采样入库：每本 ≤5 片 × ~500 字，非整本复制
- 批次 `human/batch-20260823-unlicensed-ref`：**status=quarantined, license_status=unlicensed-disputed**
- 实际入库：xuanhuan 120 / gufeng 120 / xuanyi 100 / yanqing 15（女频可解析源不足）＝ 355 片
- **隔离纪律**（不可豁免）：语料树在所有 git 仓库之外（hub 根无 .git 已核实）；
  本批次严禁 commit / push / 打包 / 发版宣称；正式解锁仍须授权语料轨
- BATCH_ID 未切换：正式标定器单批读取且要求两侧非空，ai 侧真实语料尚未存在，
  半真半假数据会破坏 formal gate 语义；FPR 信号经影子轨/本批次可直接分析

## 追记三（2026-08-23 影子轨首跑补充）
- 段落长度因子真实文本 warn 率 35-48% 的发现在本批次上同样成立（同管线同阈值面）

## 追记四（2026-08-23）：三模型共识研判——族别晋升裁决依据

flash/ox-alpha-free/hy3 独立研判影子画像（10 有效族 1734 片），共识：
- **悬疑为唯一结构性离群族**（entropy sd 超他族量级 + 标点指纹 mean 低于阈线），独立面合理（本已承诺正式族）
- 其余族行为同质；全族 PL 误报是**共享阈值 CV<0.3 失效**，修一次惠及全族，不构成晋升理由
- ox 方法学降级：35–53% 含三条采样伪影（≥30字过滤/500字窗口/仅前8000字），方向稳健、数值不可外推；
  另发现 .mjs 共享库与生产 TS 孪生漂移（0.35 放宽带、熵归一化），需 golden-file 对拍
- P0：PL 分位数化阈值重推导 + runbook §1 按族独立解锁（解耦言情阻塞）
- 晋升决策挂起三前提：P0 修复后残差重算 / 书本级聚合加固 / 产品使用频率 telemetry（缺）
详见 docs/p2/anti-ai-shadow-consensus-20260823.md

## 追记五（2026-08-23）：P0 分位数阈值重推导——反转证伪，阈值维持不变

三模型共识裁决（flash 统计 / ox 方法论 / hy3 门控语义）：
- **生产等价单元复测**（scripts/rederive-pl-threshold.mjs：无≥30过滤、全书等分偏移2500字窗、
  直调 lib runDetection，n=4908 单元/411 本）：人写 CV P1=0.366/P5=0.437/中位 0.638；
  **现行 0.30 阈值 FPR ~0.14%（书口径 any-warn 0.73%）** —— 远优于 runbook §1 warn 档 ≤10% 判据。
- **此前「全族 35–53% 误报」系采样伪影**（≥30字过滤丢对话短段/500字窗切掉场景转换/仅前8000字只测钩子开篇）
  ——ox 前轮批评完全命中。0.30 位于人写分布 <P1 深尾：warn 语义是「均匀性异常」outlier 线，非判别线。
- **提高阈值在任何统计判别原则下不成立**（只增误报不增召回）；「PL 分位数化重推导」从 P0 关键路径撤下，
  降为可选优化。AI 侧召回本地不可测（合成种子按人写假设手写 CV 反高于真人；《8人》批单段落不可用）
  → 登记新债 **#34 DEBT-20260821-t20-03**（解锁：确证 AI 参照 ≥100/族 或 getPoolReport 遥测回放 ≥200 章）。

### 执行项
1. ✅ 阈值不变（0.30 主线 + 3–5 段放宽 0.35）
2. ✅ 孪生漂移闭环（PL 部分）：TS `anti-ai-candidate-pool.ts` 补齐 0.35 放宽带对齐 .mjs 唯一实现；
   新增 `anti-ai-twin-parity.spec.ts` 三用例钉住（vitest 绿）；**熵归一化 vs 原始比特漂移仍开放**，待 golden 对拍
3. ✅ runbook §1 增补「测量单元纪律」（禁过滤切片口径作解锁判据）+ 召回项挂 #34
4. ⚠ ox 残余风险备案：0.14% 为窗口级指示性下界（诚实 CI 约 [0.05%, 0.8%] 聚类校正）；
   xuanyi 族混入教材目录、种子元数据头计入段落、字母序截断未随机化——正式轨重测时须修

## 追记六（2026-08-23）：熵因子孪生对拍闭环——裁决 A，TS 切归一化（修实现缺陷，非重标定）

三模型共识（flash 统计/ox golden 设计/hy3 门控语义）：
- **分歧量化**：两侧切句/分桶/熵公式逐字符同源，唯一分歧在判定线——.mjs 归一化 <0.7（认证链口径，
  calibration 报告判据表同）vs 生产 TS raw<3.5。实测种子+隔离参照 314 单元（K=观测桶数 5-10 主导）：
  **分歧率 100%，全部「仅 TS warn」**
- **数学根因**：K≤10 桶时最大可能熵 log2(K)≤3.32<3.5 → 旧 TS 规则对任意 ≥8 句中文文本必然 warn
  （每章噪声）；K≥32 时两线交叉后 .mjs 反而更宽松。归一化规则正是为消除桶数支配而设
- **门控影响 = 零**：T19 finding 恒 severity:"warning"，anti_ai 门 fail 需 error 级；熵 warn 从未、
  也无法单独或组合触发 error/block（deep-chapter-generation buildDecisionGates + control-kernel 直证）
  → 切换只削减 warn 噪声与修复循环条目

### 执行项
1. ✅ `anti-ai-candidate-pool.ts` detectSentenceEntropy 切归一化：value=normalized/threshold=0.7，
   新增 additive 字段 unit/rawValue/bucketCount（双量纲呈现，K 写进 description）
2. ✅ 口径残留清理：.mjs docstring 分母迷思（log2(句数)→log2(观测桶数)）、.mjs:241 注释、
   pool.spec 注释、de-ai-rules.ts:224 prompt 文案、calibrate.js PAT-G2 头注（内联复制→import 实况）
3. ✅ parity spec 扩展：SENT_FIXTURES 十档位（门位置/K=1 除零/线上下钉住/满熵锚点/docstring 杀手/
   标点塌缩/中英混排冻结金丝雀），四层断言（绝对钉死/奇偶/公式级 toBeCloseTo/元数据）15 测全绿；
   回归 pool+mech-pack+convergence+llm-pack 77 测绿；typecheck 0 错
4. ✅ 定性：修 bug 非 re-标定；不清偿 #34 与 DEBT-20260821-t20-01（召回仍不可测、标定仍 FAILED）

## 追记七（2026-08-23）：三模型待办审计——差距闭合与台账回填

flash(台账完整性)/ox(决策-实现差距)/hy3(优先级归属) 三角度审计。发现并处置：
- **G1【高】悬空 P0 闭合**：影子共识「runbook §1 按族独立解锁」此前未落地也未撤销——已落地
  （四族解耦+言情 borrow 语义写入 §1）
- **G4 更正**：追记二称入库 355 片系漏报，实际 batch-20260823-unlicensed-ref = **990 片**
  （含 dushi120/kehuan120/lishi120/youxi120/xihuan80/qingxs75 六个参照族；四正式族数字无误）
- **G5**：runbook §0「3 族」残留 → 四族
- **台账回填**：#5/#8 待派发→✅已闭环（收尾波早已实现）；#22/#23 回填孪生闭环+阈值维持+warning-only；
  #30 阻塞物更新（真实补验轮已实跑 FAIL 如实在案）
- **影子脚本矛盾清除**：报告模板旧读法（建议分位数化）与追记五裁决相反——已加反转警示重写读法说明
- 登记不修（结构性，留观察）：台账 A/B 编号段冲突(E1/E2/E3 vs B22-24)、#34 重号、统计行 21vs24

### 审计确认的开放项全景（详见会话汇总）
- 可自主：A-11 判官池 authoritative 生产切换评估(t31b-01 已偿)、getPoolReport origin 埋点(#34 前置,
  纯代码)、影子脚本采样伪影对齐生产单元、#30 扩配对复验、T36 门槛①补跑
- 需用户：v2.6.1 切支策略(熵修复在 feat/canon-migration 不在 smith/master，建议 cherry-pick)、
  言情授权语料路径、#34"≥200章/8格"语义澄清、A-11 生产行为变更批准
- 外部数据阻塞：#22/#23 授权语料、#34 召回数据、#25/#31/#32 telemetry/盲评、#24 LanceDB 等

## 追记八（2026-08-23）：四开放项处理完毕（三模型共识分项裁决）

- **origin 埋点（#34 前置）✅ 落地**：ox 裁决 A=pack 层装饰报告（analyze 保持纯函数、不动 rule-stack
  盖章白名单、零 IO 不破 ADR-19）。`AntiAiTextOrigin = ai_draft|user_text|unknown` additive 可选；
  `CorePackInputs.origin` → mech-pack memo 点浅拷贝打标；导出 `withPoolReportOrigin` 纯助手。
  测试四层：helper 单元/memo 计数回归/message 无泄漏/组合中性等价（带/不带 origin findings 逐字节相同）。
  JSONL sink 归 #34 专项（链内落盘违反 ADR-08/19；生产接线本身是 DEBT-T24-01 悬置债）
- **影子脚本伪影修复 ✅ 落地+重跑**：采样对齐生产等价单元（无≥30过滤/2500字窗×≤12窗全书等分偏移/
  去 slice(0,8000)）+ 新增书本级聚合视图 + 种子缺失中止守卫(F6 教训)。验收闸门全过：
  PL warn 率 35–53% → **0.0–0.8%**，书口径 CV<0.30 FPR 0.88%（n=340 本），其余三因子保持 ~0%
- **A-11 切换评估 ✅ 报告落盘**（docs/p6/a11-authoritative-switch-assessment.md）：flash 发现
  切 authoritative 是**行为空操作**（激活判定只认 "route"，类型字面量都不含 "authoritative"；
  route() 权威决策未接线；判官池不进生产运行时）→ 建议缓切，解锁条件四项（值语义归一/
  route() 接线/真判官复跑 L9/e2e+监控）。生产行为变更仍须用户批准
- **T36 扩配对 ⛔ 裁决缓**：CI 上界恰为 0 已排除 ≥+0.5 正效应，点估计=0 距门槛量级差距过大，
  扩 N 只收紧一条 ≤0 的 CI；κ≈-0.01 属双异模型评审异质性（协议问题非样本量问题）。
  先修协议（GCR/同模型评审+temp0）再议复验。台账 #30 已更新

执行顺序确认 j3 排序：origin+影子修复搭 v2.6.1 → A-11 评估交付（切换待批）→ T36 最后。

## 追记九（2026-08-23）：第二轮待办审计——j3 纠正发版前提 + 治理回填

flash(台账复核)/ox(追记八实现验证)/hy3(前瞻板) 三角度。要点：
- **ox：追记八四项声称全部兑现**（origin 5/5 锚点、四层测试、影子脚本验收数字与产物精确吻合）；
  抓到 N1 未使用 import（已修）
- **j3 关键纠正**：熵修复 2e9efeee **已在 smith/master**（随 PR#2/#3 合入, merge-base 实证）——
  本追记五/八中「熵修复不在发布线」的表述过时；v2.6.1 候选提交**仅剩 3be8e822**
  （或等价地 merge feat/canon-migration，两者 diff 相同）
- **j1 治理回填**：#31 语义对齐 premium 报告（已偿还(FAIL)/归档，非"缺基础设施"）；#34 注记
  origin 埋点代码已落地；新增 **#42 DEBT-20260823-a11-01**（route_shell_mode 值错配静默回退，
  A-11 解锁条件 a 前半）；A-11 评估报告挂靠台账
- 登记不修：影子报告实跑参数未记录（N4 提示级）；台账 A/B 编号段冲突仍留观察

## 追记十（2026-08-23）：#42 值归一落地 + #34 sink 规格冻结

- **#42 前半 ✅**：RouteShellMode 加 "authoritative" 字面量；resolveRouteShellMode 单点归一
  authoritative→route；flash 复审通过（唯一消费点/持久化无损/UI零影响/最简实现），
  补 gate 集成测试（authoritative 非 null 且与 route 等价）。后半(route() 真接线)仍属
  A-11 解锁条件 a 整体工程，未在本轮
- **#34 sink 规格 ✅ 冻结**：docs/p6/anti-ai-telemetry-sink-spec.md——ox 设计要素全采纳：
  白名单序列化/CWE-532 红线/整段原子重写(Tauri 无 append)/status.json 开关+JSONL 工件分离/
  T24-01 为激活前置。开放问题三枚移交用户（格语义/默认开豁免/保留期）
- **j3 二次纠正**：分支差异现为两提交(3be8e822+b0c31995 N1修复)，cherry-pick 单提交会破
  typecheck → 发版操作定为 merge --no-ff（merge-tree 实证无冲突）

## 追记十一（2026-08-23）：四项用户拍板 + v2.6.1 全量发版执行

用户决策（ask-user-question 收敛）：
1. **v2.6.1 = 发（全量）**——merge --no-ff + 四处 bump 2.6.1 + tag + build:github-release
2. **言情授权语料 = 暂搁随发版走**——block 档保持 pending-real-corpus，缺口显式标注，不走授权轨
3. **#34「≥200章/8格」= 书级口径**——全书章节量 ≥200 章为参与阈值；sink 规格开放问题⑴关闭，
   windowIndex 钩子保留为 additive 备用（规格 §7⑴ 同步关闭）
4. **A-11 解锁条件 d = 合切**——canon 与 block 绑为单一原子开关，任一未就绪整盘不切；
   authoritative 仍可比它们先单切。A-11 评估报告条件 d 就此定案

发版内容：熵修复+CI链归档+origin埋点(#34前置)+影子修复+#42值归一。

## 追记十二（2026-08-23）：v2.6.1 全量发版完成

- PR #4（release 内容）+ PR #5（构建期类型修复：AntiAiTextOrigin 转口导入 TS2459 + spec
  RuleRunContext 必选参——typecheck 增量缓存漏报，tauri build 全量 tsc 暴露）先后合入 master(def1cec4)
- tag v2.6.1 两次 force 定稿至 def1cec4；GitHub Release 含 macOS(CI 自动)+Windows(本地构建)资产
  + latest.json + 签名文件
- 构建教训三条：①master 有分支保护必须走 PR（tag 不受限）②工作树脏文件会污染 tauri build
  （COORDINATION-A4 文件在别窗未提交带类型错）→ 干净 worktree 构建 ③CARGO_TARGET_DIR 指 ASCII
  短路径绕开中文路径+AV 锁（os error 32）；build-portable/prepare 脚本硬编码默认 target 路径，
  用目录联接(target→C:\t\qmai-v261)适配

## 追记十三（2026-08-23）：T24-01 影子遥测接线落地（#34 ≥200 章累积钟启动）

三模型共识（j1 完整 trace + j2 sink 设计 + 综合）：

**关键发现**：
- 生产 anti_ai 门 = review-adapter LLM findings + 单机械 slop classify；T19 四因子零参与
- #16「已偿还」= 能力层（compose 内部池装配），接线从未落地
- AntiAiCandidatePool 依赖 node:fs + import.meta.url；打包应用无 docs/p0/corpus →
  生产侧仅 PL CV + sentenceEntropy 两因子产真值，n-gram/标点因子中性直至语料打包策略落地

**落地（影子遥测模式——门裁语义零变更）**：
1. anti-ai-telemetry-sink.ts（#34 sink 全实现，15/15 测绿）
2. onPoolReport additive 回调（mech-pack memo 暴露 + shared-text-features 透传）
3. anti-ai-shadow-telemetry.ts（动态 import 隔离 node:fs 地雷；best-effort 语料降级）
4. runFullReviewWithSixDim 注入（fire-and-forget，不并入 reviewResults/gate）

**架构决策**：影子遥测优先（measure → validate → enforce）。强制态（四因子 findings
进 anti_ai 门）留作 ≥200 章数据验证后的后续步骤。默认 antiAiMode=off + 不并入门裁 =
零行为变更。去重①采纳（mech 仅四因子+遥测，slop classify 留 review-adapter）。

**外部数据债分类**：授权语料 #22/#23 真用户阻塞（无法自主推进）；遥测累积 ≥200 章
**累积钟已启动**（sink+wiring 就位，用户生章即计时）。语料打包策略（bundle synthetic
seeds 或 IPC 预加载）登记为后续工程。

## 追记十四（2026-08-24）：语料打包策略方案②落地 + 授权轨再确认暂搁

三模型共识（j1 路径解析终判 + j2 三方案裁决 + j3 合规边界）：

**j1 关键终判**：webview 下模块级 `fileURLToPath(import.meta.url)` 抛 ERR_INVALID_URL
→ 原池模块在生产整模块加载失败（比语料缺失更根本的阻断）。已修复：路径解析收敛为
惰性 try/catch 函数，仅 FS 扫描路径依赖。

**j2 裁决 = 方案②（构建期预编译单 JSON）**：唯一同时满足「同步 API 不动、零运行时
路径解析、授权白名单可构建期硬约束」。①resources+resource dir 需异步双模加载器 +
复刻 `_up_` 回退链；③IPC 需 Rust 新命令。②包体 +93KB（60 片），便携版/Rust 零改动。

**落地**：
- `generate-anti-ai-corpus-bundle.mjs`：批次白名单 + unlicensed-ref 红线（990 片绝不入包）
- `anti-ai-seeds.generated.json` 入库（fresh clone 可用）
- 池默认构造走内嵌种子；显式 corpusRoot 维持 FS 扫描；奇偶校验 spec 对拍索引级+判定级
- 附带偿还 DEBT-20260824-T24-01（getDefaultPoolForCompose 分支由坏变活）

**j3 就绪度结论 + 管线落地**：授权轨摄取原为 0/8 就绪。新增
`ingest-authorized-corpus.mjs`（参数化批次/层/§4 六值枚举强制/unlicensed 双重红线/
跨层增量合并/stopping_conditions）。冒烟全过。

**用户再确认（2026-08-24）**：言情授权语料继续「暂搁，随发版走」。管线就绪待命，
路径确定后一条命令入库。
