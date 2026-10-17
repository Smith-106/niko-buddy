# decision-log：StoryMoss 对比 7 吸收项 → 方案/计划/验收（2026-10-17）

> 来源：`.workflow/sessions/20261017-team-swarm-creation-compare/runs/run-f7af883d0da4/outputs/best-solution.md`（21 模块：Moss 胜 15/持平 4/独有 1/buddy 胜 0）
> 约束：只改 QMAI/CLAUDE.md 锚点表内已存在文件；禁 clean-room 重写；Draft-first；`.novel/status.json` 唯一真源；中文路径引号+正斜杠

## 一、方案裁决（#20 讨论结论）

| ID | 吸收项 | 裁决 | 理由 | 锚点 |
|----|--------|------|------|------|
| S1 | 判官一致率数字 | **做**：纯函数 + spec | review-adapter 有评审结果+门归属，无采纳率数字；additive 零行为变更 | `review-adapter.ts` √ |
| S2 | 生死 cast 排除链 | **做**：纯函数 + spec | ingest 已有死亡落库，character-state 有字段，缺 cast 排除；additive 零行为变更 | `character-state.ts` √ |
| S3 | 伏笔四字段 | 降级→文档 | foreshadowing-tracker 不在锚点表；字段加法需跨文件消费，风险超纯函数范畴 | 债条目 |
| D1 | 续写按需检索 | 文档对标确认 | context-engine 已有 retrieveDualTrack 双轨接线，功能已存在 | 对标条目 |
| D2 | 成本聚合 | 降级→文档 | 新面，超锚点边界 → Stage 3 目标层 | 债条目 |
| D3 | 改稿影响呈现面 | 降级→文档 | UI 面，超锚点边界 → Stage 3 目标层 | 债条目 |
| D4 | 拆书 stuck 终态 | 降级→文档 | 状态机语义变更风险高（running/done/cancelled/error 四态外加终态影响调度） | 债条目 |

## 二、可执行计划

| 步骤 | 内容 | 文件 | 验证 |
|------|------|------|------|
| E1 | S1：`computeReviewAgreement(findings, revisedText)` 纯函数：归一化包含率≥0.8 且引用≥6 字判幸存；返回 {total, survived, rate}；NovelReviewResult.evidence 作引用源 | `src/lib/novel/review-adapter.ts` 追加 + `review-adapter.spec.ts`（或新建 `review-agreement.spec.ts` 就近） | vitest 该 spec 全绿 + typecheck 0 错 |
| E2 | S2：`excludeDeadFromCast(cast: string[], store)` 纯函数：读 isAlive=false 或 deathChapter!=null 排除；返回 {alive, excluded} | `src/lib/novel/character-state.ts` 追加 + `character-state.spec.ts` 追加 | vitest 该 spec 全绿 + typecheck 0 错 |
| E3 | 本文件落盘（方案/计划/验收即本文） | 本文件 | 存在性 |
| E4 | 回归：全量 vitest + typecheck | — | 全绿 + 0 错 |

顺序：E3 → E1 → E2 → E4。E1/E2 均为 additive 纯函数追加，不改现有导出语义。

## 三、验收标准

| AC | 条目 | 判定 |
|----|------|------|
| AC1 | E1 函数存在且有 spec 覆盖（幸存/被改/短引用<6字不判三分支） | `rg computeReviewAgreement` 命中 + vitest spec 名命中全绿 |
| AC2 | E2 函数存在且有 spec 覆盖（isAlive=false 排除/deathChapter 排除/全活不过滤三分支） | `rg excludeDeadFromCast` 命中 + vitest spec 名命中全绿 |
| AC3 | 机械门：改动文件 typecheck 0 错误 | `npm run typecheck` 0 错（或改动文件 tsc 抽查 0 错） |
| AC4 | 机械门：全量 vitest 全绿（无新增失败） | `npx vitest run` 全绿 |
| AC5 | 纪律：只改锚点内已存在文件；untracked 残留不碰；无 git 操作（除状态查看） | `git status` 无新增非预期修改 |
| AC6 | 文档：S3/D1/D2/D3/D4 五项文档裁决在本文件 §一 + 债条目 §四 | 本文件存在对应行 |

## 四、债条目（降级项）

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20261017-01 | S3 伏笔四字段（evidence/strength/subtlety/relatedIds）：Foreshadowing 接口加法 + 消费链（看板/注入） | foreshadowing-tracker 进入锚点表或 Stage 3 立项 | Stage 3 立项时评审 |
| DEBT-20261017-02 | D2 故事级成本聚合（summarize_story_cost + 异常检测 + 维护页 Tab） | Stage 3 目标层立项 | Stage 3 立项时评审 |
| DEBT-20261017-03 | D3 改稿影响呈现面（StalenessEdge 已有，缺呈现/决策页，不自动改写） | Stage 3 目标层立项 | Stage 3 立项时评审 |
| DEBT-20261017-04 | D4 拆书 stuck 终态 + 最小长度校验 + history 数组兼容 | ingest 调度重构立项 | 调度重构时评审 |
| DEBT-20261017-05 | D1 检索对标已确认（retrieveDualTrack 双轨）；若后续发现续写 prompt 未消费检索块则升级为执行项 | 检索块消费链核查 | 下次对比复核 |

## 五、decision 条目

| date | task_id | decision_type | value | evidence_ref |
|------|---------|---------------|-------|--------------|
| 2026-10-17 | S-goal-storymoss-absorb | 裁决人 | S1+S2 执行（纯函数+spec），S3/D1–D4 文档降级 | best-solution.md §四 + QMAI/CLAUDE.md 锚点表 |
| 2026-10-17 | S-goal-storymoss-absorb | 技术债条目 | DEBT-20261017-01~05 | 本文件 §四 |
