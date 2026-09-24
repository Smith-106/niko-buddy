# #89 滚动规划完结清单 + 上下文压缩策略（Round1 补强）

| 字段 | 值 |
|------|-----|
| date | 2026-09-24 |
| task_id | #89 |
| decision_type | U-89 定稿 |
| value | (1) 新建 `story-compass.ts`：指南针 store（`.novel/story-compass.json`，additive，status.json 仍唯一真源）+ 完结六项清单纯函数（`evaluateCompletionChecklist`/`checkCompleteBookAllowed`，豁免必须落盘）+ 双陷阱常量 + `collectCompletionChecklistInput`（IO 层，动态 import 避循环；机械项快照/伏笔/支线派生，语义项调用方传入，失败降级零值不抛错）；(2) `volume.ts` 追加 `checkFinaleAutoComplete`（收官卷终点卷末自动完结，无需 complete_book；ainovel architect-long §创建下一卷第 4 步）；(3) 新建 `context-compact.ts`：四级压缩（microcompact→lightTrim→storeSummary→fullSummary，保护段永不删，gaps 显式记录 IC-02）+ 恢复包（6000 字符预算）+ 熔断器（阈值 3，半开每 2 轮探测，开路显式 skipped 不静默）+ CJK token 口径 ceil(ascii/4 + cjk/1.5)；`token-estimator.ts` 委托之（仅 spec 消费，零生产回归）；(4) `trimContextPack` 字段表按 CONTEXT_DROP_ORDER 重排（检索/引用先丢，任务/大纲/canon/禁区保护，legacy 截断语义不变）；(5) `outline-quality-check.ts` 新增 `checkFinaleVolumeDiscipline`（仅收官宣告卷生效，埋新钩子 error、无回收分配 warn，普通卷恒 pass 零误伤）；(6) barrel：`index.ts` 导出 story-compass 全量 + `checkFinaleAutoComplete` + context-compact 全量 + `checkFinaleVolumeDiscipline`，`mod.ts` volume 块追加 `checkFinaleAutoComplete`；(7) 附带修复 `j06-j09-real-transport.spec.ts` FAKE_LLM 缺 `ollamaUrl` + 两 real-llm spec 的 `LlmConfig` 改从 `@/stores/wiki-store` 导入（typecheck 0 错误 baseline 含此修复）。门控优先级与 Draft-first 不变。 |
| evidence_ref | `QMAI/src/lib/novel/story-compass.ts:372`（collect）、`context-compact.ts:282`（compactContextSections）、`volume.ts:272`（checkFinaleAutoComplete）、`context-engine.ts:2847`（dropOrder）、`outline-quality-check.ts:566`（收官纪律）；`npx vitest run` 13 文件 293 通过；`npm run typecheck` 0 错误 |

## 债条目

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20260924-89a | `contextPackageToPrompt` 内联 CJK 公式（`[一-鿿]`）与 `estimateCompactTokens`（`[㐀-鿿]`）正则范围尚未统一，数值口径一致仅正则差 | 任一改动 context token 口径时 | #90 收口前评审 |
| DEBT-20260924-89b | `applyChapterContractCheck` transitional 恒 false（过渡章判定 deferred） | 滚动规划消费 compass 时 | 后续 Round |
