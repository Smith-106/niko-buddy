# 20260824 — T24 packs×4 + GATE_MAPPING 接线 + 六维并行化决策

> 任务：TASK-P3-24 / 蓝图 §6 T24（F-04 / F-15 / A-04.3）
> 交付物：`QMAI/src/lib/novel/packs/{shared-text-features,continuity-pack,anti-ai-mech-pack,anti-ai-llm-pack,quality-six-dim-pack}.ts`（+5 spec）+ `deterministic-continuity-engine.ts` 增 `taxonomyDimId` + `review-adapter.ts` 增 `resolveReviewGateKey`
> 验证证据：`npx vitest run packs review-adapter deterministic-continuity rule-stack` **295/295 绿**；全量 `vitest run`（test:mocks 口径）**9647/9647 绿（2 skipped 为既有）**；`npx tsc --build` **0 错**；eslint（boundaries 门禁）对全部触碰文件 **0 error 0 warning**

## 一、decision-log 条目

| 字段 | 值 |
|------|------|
| date | 2026-08-24 |
| task_id | T24 |
| decision_type | U-xx 定稿（实现层口径定稿） |
| value | 见下方 D1–D7 |
| evidence_ref | `QMAI/src/lib/novel/packs/*` / `rule-stack.ts`（T23 组合语义）/ `audit-taxonomy.ts`（T22 GATE_MAPPING）/ 上方验证命令输出 |

### D1 pack 形态 = 工厂函数（非静态常量包），冻结职责归 combinePacks

- **value**：四包均以 `createXxxPack(input)` 工厂产出未冻结 `RulePackDefinition`；输入经闭包注入，`runRuleStack(stack, ctx)` 的 `RuleRunContext` 契约不变（不改 rule-stack.ts）。组合入口 `composeCoreRulePacks()` 只产未冻数组，调用方必须经 T23 `combinePacks()` 完成规范化排序+深度冻结后再运行。
- **rationale**：机械规则需要章节数据输入，而 T23 的 run ctx 只有 `isFinale`；工厂闭包是零侵入方案（rule-stack.ts 不在 T24 文件清单）。「run 前冻结、run 内禁动态注册」语义由 combinePacks 单点承担，pack 层不重复实现。

### D2 共享特征预计算 = 一处扫描 + memo 快照

- **value**：`precomputeTextFeatures(rawText)` 一次扫描产出句式/段落 CV、token/3-gram、标点指纹统计；`composeCoreRulePacks` 对同一 `chapterContent` 只调一次并同实例注入 anti-ai-mech 与 quality-six-dim 两包。域内 memo：anti-ai-mech 对 `pool.analyze()` 至多调一次（四因子共享报告）；continuity-pack 对 `checkContinuity()` 求值一次（七条规则过滤同一 findings 快照）；anti-ai-llm 投影结果快照一次。
- **rationale**：任务要求「n-gram/句式统计算一次供多 pack 复用」。mech 包 slop 扫描消费 `features.normalizedText` 跳过一次全文 normalizeText 扫描（normalizeText 幂等，tier/penalty 结果与传原文一致——spec 断言两路径等价）。

### D3 引擎 taxonomyDimId 映射表（37 维归属真源 = 检测器）

- **value**：`ContinuityFindingBase` 增 optional `taxonomyDimId?: AuditDimensionId`（additive）。映射：dormant/结构化逾期 subplot→`subplot_resolution`；absent/dead→`character_consistency`；foreshadowing overdue/unresolved→`foreshadowing_integrity`；Quillica 弧违反/弧断裂→`arc_structural`；timeline_drift→`timeline_consistency`；data_gap 缺省（无 37 维槽位，跨维通用，守 IC-02 不进 consistency 统计）。
- **rationale**：维度归属由引擎逐 finding 标注（单一真源），continuity-pack 规则层不收敛到单维（overdue 桶横跨两维）；type-only import 保持引擎 ADR-29 零 IO 纪律。弧检测复用 dormant_thread 类型槽但语义归 arc_structural（弧位问题非支线闭环问题）。

### D4 T19 四因子接线 = DI 注入池 + warn 态，不做 runtime import

- **value**：anti-ai-mech-pack 经 `AntiAiPoolLike` 结构化接口注入候选池；**不从 anti-ai-candidate-pool.ts 做 runtime import**（该模块含模块级 `__dirname` 语料路径解析，renderer bundle 不安全且语料不随应用打包）。四因子各一条规则全 warn 态（标定前只 warn 不 block，守 T19 口径）；维度映射 nGramOverlap/punctuationFingerprint/paragraphLengthDist→`statistical_ai_signature`，sentenceEntropy→`slop_mechanical`。未注入 pool → 四因子规则恒空产出（惰性降级不抛错）。
- **rationale**：ADR-19 机械层零模型调用不受影响；避免把 node-only 模块拉进渲染进程。生产接线点归后续持有语料访问权的任务。**残留风险**：默认路径（未接线）下四因子静默为空——已在模块头注记，待接线任务补生产装配。

### D5 mechanical-slop TIER3 接线口径

- **value**：单规则 `anti-ai-mech.slop-tier3`（dim `slop_mechanical`）：`classifySlop()==="block"` → error（保持 review-adapter 现行阻断语义，P1 fail 可短路后续门）；有 TIER3 命中未达阻断 → warning；无命中空产出。
- **rationale**：任务明示接线「mechanical-slop TIER3」；block 升格沿用现行 classifySlop 权威，不在 pack 层另立阈值（防双真源）。

### D6 六维并行化 = 门优先级分组 + 有界并发 3 + hardShortCircuit 复用

- **value**：`runSixDimBounded(keys, evaluate, {concurrency?})`：按 GATE_PRIORITY_ORDER 分门分组，组内有界并发（默认 3，任务口径 2-3；worker pool 保序）；每门聚合裁定（任一维 status=error 或含 error issue → fail）后调 T23 `hardShortCircuit(gate, verdict)`——P0/P1 fail 短路后续组（skippedKeys 记录），Quality(P2) fail 永不短路。六维→门归属与 DIM_TO_GATE_TYPE 同口径（character/consistency/continuity→consistency；thrill/pacing/pull→quality），维度升级为 T22 精确槽位（如 pull→reading_power）。
- **rationale**：「quality 维内有界并发 2-3；P0/P1 硬门仍先短路」；evaluate 由调用方注入（本文件零模型调用守 ADR-19）。dimension-review-adapter.ts 不在 T24 文件清单，故运行器落 quality-six-dim-pack 导出，现行 `runSixDimensionReview` 行为不动（接线由后续任务承接）。投影侧补 CORR-010 同款守卫：无 issue 但维度状态 error/warning 时仍产出对应级别 finding（维度状态权威，防空维误 pass）。

### D7 review-adapter 改读 GATE_MAPPING + CORR-108 常量保留

- **value**：新增导出 `resolveReviewGateKey(type): GateKey`：①type ∈ 37 维注册表 → `getGateForDimension`（GATE_MAPPING/AUDIT_TAXONOMY 唯一真源路径）；②∈ CORR-108 legacy consistency 集 → consistency；③∈ legacy anti-AI 集 → anti_ai；④其余保守缺省 quality。legacy 集以 `CORR108_LEGACY_CONSISTENCY_REVIEW_TYPES` / `CORR108_LEGACY_ANTI_AI_REVIEW_TYPES` 导出常量保留（历史对照防丢失，spec 断言归类保真 + 与 37 维无碰撞）。normalize 口径（trim+lowercase）与 deep-chapter-generation.resolveDecisionGateKey 一致；后者运行时迁移归其后续任务（deep-chapter-generation.ts 不在 T24 文件清单，改动最小化约束）。
- **rationale**：审查层从此具备 GATE_MAPPING-backed 归类真源；reviewChapter 评审主体零改动（只 additive 导出，不动逻辑主体）。

## 二、债条目

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20260824-T24-01 | anti-ai-mech-pack 生产池装配缺位：默认路径未注入 AntiAiPoolLike 时 T19 四因子静默空产出（DI 边界见 D4） | 生产接线任务在持有语料访问权的层构造池实例并传入 composeCoreRulePacks；或 anti-ai-candidate-pool.ts 去 __dirname 化后允许 renderer 直连 | P4 垂直切片（T31 前） |
| DEBT-20260824-T24-02 | resolveReviewGateKey 尚未被 deep-chapter-generation.resolveDecisionGateKey 运行时消费（后者仍用本地硬编码集） | deep-chapter-generation.ts 迁移调用点改读 resolveReviewGateKey（删除重复集定义） | P4 Route 完整内核波 |

## 三、并行隔离记录（w3-t28）

- 本任务只新建 `packs/{shared-text-features,continuity-pack,anti-ai-mech-pack,anti-ai-llm-pack,quality-six-dim-pack}`(+spec) 并 additive 触碰 `deterministic-continuity-engine.ts` / `review-adapter.ts`(+spec)；**未创建/修改** `packs/literary-craft-pack.*` 与 `craft/craft-rule-registry.*`（归 T28）。验证窗口内 T28 的 `literary-craft-pack.spec.ts` 已并行出现于 packs/ 且与本任务产物共存全绿（82 packs 测试含其 46 条），零冲突。
