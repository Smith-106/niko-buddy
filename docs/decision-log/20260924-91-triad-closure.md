# #91 Round2 三权分立显式编排容器（DEBT-90a 偿还）

| 字段 | 值 |
|------|-----|
| date | 2026-09-24 |
| task_id | #91 |
| decision_type | U-91 定稿 |
| value | (1) 新建单章三权编排容器：`repair-loop.ts` 追加 `createChapterTriadState`/`triadPlanGate`/`triadDraftGate`/`triadReviewGate`/`advanceChapterTriad` + `TRIAD_MAX_REWORK=2` + 三类型（ainovel Architect→Writer→Editor 执行协议收缩态：plan 契约就绪判定不阻断 / draft 禁区 error 阻断返工其余告警 / review fold-error 或最小返工集非空返工 / 返工超 2 轮 handoff 人工；三阶段判定全部委托 #88/#89/#90 已有纯函数，零新机制、零 LLM、零 IO）；(2) 落点教训：初版误放 `chapter-pipeline.ts` 触发循环导入（pipeline→dim-adapter→context-engine→…→chapter-ingest→pipeline，`createChapterPipeline is not a function` 实证），已回滚；repair-loop 零生产反向依赖（仅 index.ts barrel 引用）为安全容器；(3) barrel：`mod.ts` 从 repair-loop 导出三权全量（与 createChapterPipeline 同位置；index.ts 无 chapter-pipeline 既有导出，域内直接引用，无需同步）；(4) spec：`repair-loop.spec.ts` 追加 `§GAP-91` 6 用例（三门 + 全绿路径 + review 超限 handoff + draft 超限 handoff/终态恒等）；(5) DEBT-90a 偿还：流水线维度 ★★★★☆→★★★★★，四维度本轮 ①⑤②⑤③⑤④⑤+，七方判定写作质量第一梯队 niko-buddy 独占（机制执行层三项领先：契约/举证代码级执行、style_stats rollup、显式三权编排；记忆工程并列；导演整本链 AI-NWA 体量更大但耦合略散，本轮不计分）。门控优先级与 Draft-first 不变。 |
| evidence_ref | `repair-loop.ts` triad 块（import:8-17，实现尾部）；`mod.ts` repair-loop 导出；`repair-loop.spec.ts §GAP-91`；`npm run typecheck` 0 错误；12 文件 373 通过；循环导入故障 `createChapterPipeline is not a function`（chapter-ingest.ts:862）实证 + 回滚记录 |

## 债条目

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20260924-90a | 已偿还（本轮三权容器落 repair-loop，DEBT-90a 关闭） | — | #91 收口 |
| DEBT-20260924-89b | `applyChapterContractCheck` transitional 恒 false（过渡章判定 deferred，结转） | 滚动规划消费 compass 时 | 后续 Round |
