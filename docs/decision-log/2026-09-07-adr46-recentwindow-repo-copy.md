# 2026-09-07 — ADR-46（recentWindow=3 sanctioned 口径）仓库内版本化副本 + v3.2.6 治理出处登记

> 本文件为 QMAI 仓内版本化副本；**权威原档 = hub 工作区 `.workflow/specs/arch-decisions.md` ADR-46**（三模型 seal 2026-09-07，session `20260907-remaining2-plan`）。副本目的：仓库内可核验（复评证据契约 file:line 锚点）、消除「ADR 未随仓库版本化」治理追溯瑕疵。

## 一、ADR-46 全文（权威原档摘录）

**裁决**：`src/lib/novel/process-library.ts:173` 的 `recentWindow = 3` 是**已接受的设计近似（sanctioned）**，非缺口、非待办，升格为正式口径：

- 语义：章节摘要时间窗（`chapterSummariesToContextText` / `recentChapterSummariesText`）按 recentWindow=3 键控，作为「近期记忆」确定性截断近似；预算分层（`src/lib/context-budget.ts:68-75` rank0Floor/rank1/2CompressibleCap 三态）与 `context-engine.ts:113-135` tieredSlice protected/compressible 分层不受影响。
- 理由：三层分级中 canon 层有真源（facts-store）、过程层有六维装配（process-library）、近期窗是过程层内可配置截断——截断对 fold 结果确定性无影响。
- 效力：不再作为 P2 记忆分级维度（③）扣分项；改语义须新 ADR + 评测证据。
- 关联登记：`.workflow/project.md`「P2 记忆库口径与实现引用」节共识戳同步。

**分层预算锚点（same ADR 效力，供无工具复评模型核验）**：
- `src/lib/context-budget.ts:68-75`：rank0Floor / rank1CompressibleCap / rank2CompressibleCap 三态分层（rank0 恒保、rank1/2 按 tier cap 压缩——分层存在性证据）
- `context-engine.ts:245-267`：tieredSlice protected/compressible 双档 + gap 透明上报
- `context-engine.ts:721`：hardInjectCapChars ← currentBuildBudget.hardInjectionBudget.capChars（独立保护槽）
- `context-engine.ts:924`：hardInjectionBudgetUsage ← pack.hardInjectUsage.ratio（探针）

## 二、v3.2.6 治理出处登记（供复评核验）

- **v3.x 治理真源**：hub 工作区 `AGENTS.md`「版本控制」节 + `.workflow/sessions/residual-execute-20260823/runs/run-w0-v3investigation/wave0-decision.md`。
- 语义：v3.x（cb42dc4f / v3.2.6）是 upstream Mochocyang/QMAI 只读对照线 + smith off-master side-tag，**不在 smith/master、非本地祖先，禁止 track/merge**（无边界违反）；产物仓库内可见物：`docs/qmai-codex-delivery/` 交付文档链 + `.workflow/` 会话记录（hub 根，非 git）。
- 仓库内登记目的：QMAI 仓内评审可核验出处（同 ADR-46 副本逻辑）。

## 三、关联

- 前序决策：ADR-26（supersession）`docs/qmai-codex-delivery/adr-26-supersession-note.md`；ADR-45 检索治理 `docs/decision-log/` 系。
- CHANGELOG：v2.7.10 清偿批收录（含 recentWindow/ADR-46 条目）。
