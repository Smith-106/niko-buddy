# 决策日志：F-003 rubric 定义与成本门禁（C-014）

- 日期：2026-09-12
- 范围：TASK-009（OpenWrite W4 门禁）
- 相关：`docs/p2/f003-cost-measurement.md`、`src/lib/novel/rerank-rubric.ts`、`rerank-rubric.spec.ts`
- 状态：**F-003 维持冻结**（门禁 blocked，TASK-010 未实施）

## 背景

C-014 要求 F-003 在成本实测完成前不得进入实施波次。本任务交付两件东西：rubric **定义**（权重来源、判据集合、`rubric_hash`）与成本**实测**。前者完成；后者在本环境不可执行（无 provider 凭据，真实 LLM 入口全部 opt-in 且会消耗用户配额），故门禁以 `blocked` 收口。

## D1：判据集合全部复用，rubric 只做「绑定 + 加权 + 钉版本」

**决定**：判据取 `dimension-review-adapter.ts` 的六维（`SIX_REVIEW_DIMENSION_ORDER`）+ `anti-ai-candidate-pool.ts` 的 `quickAntiAiAnalysis`；分数归一只经 `normalizeDimensionScore`。

**理由**：INV-4 禁新评分器。`rerank-rubric.ts` 不实现任何打分、不采样、不生成候选；它把三个既有函数以**函数引用**挂在 `RERANK_REUSED_SOURCES` 上，使复用成为**编译期绑定**而非注释承诺。

**后果**：上游改名 → 本模块编译失败（好：暴露而非分叉）。测试用 `toBe` 断言引用同一函数实体，并用导出面扫描断言不存在 `scoreCandidates`/`rankCandidates`/`sample*`。

## D2：权重来源 = 门控优先级类，而非 `CALIBRATED_DIMENSION_WEIGHTS`

**决定**：类间 `P0=0.5 / P1=0.3 / P2=0.2`（沿用硬边界「`Consistency(P0) > Anti-AI(P1) > Quality(P2)`」），类内均分。`consistency`+`continuity` → P0（各 0.25）；`anti_ai_fingerprint` → P1（0.30）；其余四维 → P2（各 0.05）。

**理由（实测）**：`CALIBRATED_DIMENSION_WEIGHTS` 的键 `{plot, character, world, pacing, facts, compliance}` 与 `DIM_TO_GATE_TYPE` 的像 `{plot, consistency, character_consistency, timeline}` **只共享 `plot`**，差集为 `{character_consistency, consistency, timeline}`。没有机械可算的对应关系；硬凑对照表就是发明权重（INV-4）。

**后果**：`P0 ≥ 0.5` 成为**不变量断言**（`assertRerankRubricInvariants`）——Consistency 永不被文学分覆盖。同时把「上游若补齐缺口就要改用标定权重」写成 spec 断言（漂移探测器）。

## D3：`rubric_hash` 用 FNV-1a64 对「版本 + 归一方式 + 判据集合」取指纹

**决定**：payload = `version | normalizerId | {id}:{class}:{weight.toFixed(6)}:{source}:{gateType}`（按 id 排序）；复用书稿指纹的 FNV-1a（浏览器可用）。当前值 `7e3cc1a1830ac888`。

**理由**：`rubric_hash` 的用途是**版本钉定**，不是完整性校验；无需引入 Node `crypto`（浏览器不可用）。规范排序保证判据数组顺序不影响 hash。

**后果**：权重/类/门类型/来源/版本任一变动都会换 hash → 旧的「已达标」结论自动失效。`F003_MAX_COST_MULTIPLE` 与 `F003_MIN_PREFIX_CACHE_REUSE` **有意不进 hash**：调阈值是策略决定，rubric 是判据定义，两者不该互相钉死。

## D4：门禁「缺数据即 blocked」

**决定**：`evaluateF003CostGate` 在 `chaptersSampled < 5`、无基线、超硬封顶/软警告线、超墙钟预算、倍数超上限、复用率低于下限时逐条给出理由并返回 `blocked`。**零采样 → blocked**。

**理由**：门禁存在的意义就是不允许缺数据时凭判断放行。`unmeasured` 字段单独标出「无实测」而非「测了但超标」，两者后果相同但可审计性不同。

**后果**：本次门禁输出 `BLOCKED`（由函数实际生成，非手写）。

## D5：阈值来源分层——预算取既有值，两个策略阈值标注为提案

**决定**：硬封顶 240000 / 软警告 120000 / 墙钟 2700000ms 全部读 `budget-counters.ts` 既有常量（不重新定义）；`F003_MAX_COST_MULTIPLE = 2.5` 与 `F003_MIN_PREFIX_CACHE_REUSE = 0.5` 作为**本任务提案**登记为待人工批准。

**理由**：既有预算常量有各自的既有验收链背书，抄一份副本会漂移；而「多少倍算可接受」在任何既有代码里都没有答案，只能显式提案并让人批准，不能伪装成推导出来的。

**后果**：报告 §4 明确标注两值为提案；**未决项**（见下）要求批准后再解除冻结。

## D6：解析发现——复用率上界是 `2p/3`，不是 1

**决定**：把 `ρ_max = 2p/3`（p = 共享前缀占单臂 prompt 的比例）写入报告，并据此指出 `ρ ≥ 0.5` 要求 `p ≥ 0.75`。

**理由**：三路中只有两路能命中前缀缓存（第一路未命中），且 completion 侧完全不可缓存 → 倍数地板为 `3c/(1+c)`。若不点明，`0.5` 下限可能被当成轻易可达，实测时才发现不可达。

**后果**：实测协议必须一并验证 `p ≥ 0.75` 这一前提。

## 后果汇总

1. F-003 不进入实施波次；TASK-010 未实现（正确未执行，非遗漏）；A-F-003 维持 0 行代码。
2. rubric 定义已可用：一旦实测到位，`evaluateF003CostGate` 可直接给出机械判定，无需再写代码。
3. `rerank-rubric.ts` 尚无消费方，未加入 `src/lib/novel/index.ts` 导出面（TASK-010 解冻时一并接线）。

## 未决项（需人工决定）

1. **批准或修改 `F003_MAX_COST_MULTIPLE`（当前提案 2.5）**。
2. **批准或修改 `F003_MIN_PREFIX_CACHE_REUSE`（当前提案 0.5）**——批准前须确认 `p ≥ 0.75` 在实际 ContextPack 下成立。
3. **执行真实成本实测**（需 provider 凭据；命令见报告 §5.2）。
4. **P0/P1/P2 类内均分的细则**：当前为均分；若认为 `consistency` 应重于 `continuity`，须改权重并接受新 `rubric_hash`。

## 验证（本任务实测）

| 项 | 命令 | 结果 |
|---|---|---|
| rubric 契约 | `npx vitest run src/lib/novel/rerank-rubric.spec.ts` | **20 passed / 0 failed** |
| rubric_hash | 实测输出 | `7e3cc1a1830ac888` |
| F-003 硬否决：`MAX_PARALLEL = 3` | `rg -n 'MAX_PARALLEL\s*=\s*3' src-tauri/src --glob '*multi_draft*'` | **0** |
| F-003 硬否决：`multi_draft.rs` 中 `snapshots` | `rg -n 'snapshots' src-tauri/src/commands/multi_draft.rs` | **0** |
| 门禁函数输出 | `formatF003GateVerdict(evaluateF003CostGate({chaptersSampled:0,…}))` | `BLOCKED` + 3 条理由 |
