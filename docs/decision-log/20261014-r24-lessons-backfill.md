# 2026-10-14：R24 实战经验回灌写作系统（RCP-20261014 系列）

> 来源：Goal 129c21d6 收官复盘（ch086 R21→R24 冲 9.0 + v13 重建）。
> 纪律：只改现行锚点、additive 纯函数、零行为变更（201 插入 0 删除）。

| 字段 | 值 |
|------|-----|
| date | 2026-10-14 |
| task_id | R24-经验回灌（Todo #160–#163） |
| decision_type | U-定稿 |
| value | 三处落地：① `plateau-stop.ts` 加 `recommendPostPlateauAction()`（plateau+结构信号→diagnose-structure，否则 keep-current 旧行为）；② `mechanical-slop-detector.ts` 加结构层三件套 `detectChorusSing`/`countEchoFamily`/`detectSilentStretch`（warn 态建议，不入 slopPenalty）；③ `batch-replace/diff-model.ts` 加 `assertSingleMatchReplace`/`assertBatchReplace`/`joinCrlfSections` |
| evidence_ref | `vitest run` 三 spec 77/77 绿；`npm run typecheck` 0 错误；maestro 知识库 RCP-20261014-goal-acceptance-verifier / teammate-n-5-plumbing / crlf / count / 1311 五条 |

## 债条目

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20261014-01 | 结构层三件套阈值（SHOUT_MAX_CHARS=24、minShouts=3、minParas=8）为 R24 单章手设初值，未经全书语料校准；`detectSilentStretch` 出场判定为纯字面包含 | 真实多章语料跑出误报/漏报率后重标定（类比 T20 anti-ai 标定流水线） | P2 标定收口前 |
| DEBT-20261014-02 | kh1（Goal acceptance 命令）/kh2（teammate 串行评审 plumbing）为 agent 工作流知识，仅入库 maestro 知识库，未进产品代码 | 下次 Goal 终审 / N≥5 评审复用时验证 | 下次同类任务 |
