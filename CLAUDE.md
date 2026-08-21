# QMAI — 长篇写作主基底

> 本文件是 QMAI 会话级执行纪律。详细规范见交付文档包 `@../docs/qmai-codex-delivery/`。

## 身份与边界

- **QMAI 是 niko-hub 唯一主基底**。外部项目（novel-harness / ainovel-cli / NovelForge / novel-tool / maestro-flow）只贡献**模式、契约、规则**，不做整仓迁移，不接管主程序。
- **禁止 clean-room 重写**。已有锚点能承载职责就不新开平行实现。
- 桌面架构固定 `Tauri 2 + React + Rust`；IPC 走直 invoke，不引入 Node gateway；向量存储沿用 LanceDB。

## 三条不可退让的硬约束

1. **`status.json` 是运行时唯一真源** — `.novel/status.json`，编排层与生成层共同读取、分层写入。禁止新建第二份会话状态文件替代它，禁止用临时 Markdown 清单替代状态契约。
2. **Draft-first 是写作安全边界** — 所有 AI 输出先进 pending/ready 草稿，accept 后才回填正式正文与正式记忆。accept 前禁止污染正式层。
3. **门控优先级固定** — `Consistency(P0) > Anti-AI(P1) > Quality(P2)`。Quality 不得覆盖 Consistency 的失败；机械层检测先于语义层。

## 主链文件锚点（现行）

修改前先确认目标落在哪个锚点。**只改下列已存在的文件**：

| 能力 | 锚点 |
|------|------|
| 意图路由 | `src/lib/novel/task-router.ts` |
| 上下文装配 | `src/lib/novel/context-engine.ts` + `context-data-sources.ts` |
| 章节生成 | `src/lib/novel/deep-chapter-generation.ts` + `deep-chapter-prompts.ts` |
| 草稿/会话状态 | `src/lib/novel/novel-session-status.ts` + `chapter-save-strategy.ts` |
| 审查/门控写回 | `src/lib/novel/review-adapter.ts` + `start-review-run.ts` + `start-six-dimension-review-run.ts` |
| Anti-AI | `src/lib/novel/de-ai-rules.ts` + `de-ai-adapter.ts` + `mechanical-slop-detector.ts` |
| 角色认知 | `src/lib/novel/character-cognition.ts` + `character-state.ts` + `character-aura.ts`（+ ARCH-1 拆分 `bindable-characters.ts`） |
| 确定性连续性引擎 | `src/lib/novel/deterministic-continuity-engine.ts` + `emotion-ledger.ts`（双层挂载：生成预检 + 审查兜底，机械层零 LLM） |
| Scene Breakdown | `src/lib/novel/scene-breakdown.ts`（阶段 1.5，`novelConfig.sceneBreakdownEnabled` 控制） |
| 章节摄取/快照 | `src/lib/novel/chapter-ingest-output.ts` + `chapter-snapshot-normalize.ts`（ARCH-1 拆分） |
| 深章 task-brief | `src/lib/novel/deep-chapter-task-brief.ts`（ARCH-1 从 `deep-chapter-generation` 拆出） |
| UI 闭环 | `src/components/chat/chat-panel.tsx` + `chat-message.tsx` + `chat-resume.ts` |

完整映射见 `@../docs/qmai-codex-delivery/10-file-mapping.md`。

## Wave-0 新增锚点（T00-T05 已落地，2026-08-20 同步）

| 能力 | 锚点 |
|------|------|
| 离线回放 harness | `src/lib/novel/offline-replay-harness.spec.ts` + `offline-replay-config.ts`（评分因子权重/阈值候选值，type-only 契约） |
| 离线回放 runner | `scripts/offline-replay.js`（hub 根 `scripts/`，T02 创建） |
| LanceDB FTS spike | `src-tauri/src/spike_fts.rs`（T04，**不进 mod.rs**） |
| 基线/语料/审计文档 | `docs/p0/t00-baseline.md`、`docs/p0/chinese-benchmark-corpus.md`、`docs/p0/license-audit.md`、`docs/p0/lancedb-fts-spike.md`、`docs/p0/stage3-gap-audit.md`、`docs/p0/corpus/`（hub 根 `docs/p0/`，T00-T05 交付） |

> **decision-log 工作流（蓝图 §9.7 / A-34）**：路径=`docs/decision-log/YYYYMMDD-<slug>.md`（QMAI 内）；模板与债条目模板见 `docs/decision-log/_TEMPLATE.md`；每任务完成定义强制含『decision-log 条目已落』。

## Wave-1 新增锚点（P1 控制面 T06-T18a 已落地，2026-08-21 同步）

| 能力 | 锚点 |
|------|------|
| checkpoint 摘要（SHA-256 幂等键） | `src/lib/novel/checkpoint-digest.ts`（T07，crypto.subtle 异步 API，输入规范化键序稳定 JSON） |
| 控制内核 route()（720k 纯函数） | `src/lib/novel/control-kernel.ts` + `control-sentinels.ts`（T08，13 分支互斥优先级链，零 IO/LLM，720k ≤5s 批断言） |
| deep-chapter 薄编排化 | `src/lib/novel/deep-chapter-generation.ts`（T10，主循环接入 route() 薄编排 seam + T09 字段 + T33 解析点预留） + `deep-chapter-generation-route-shell.spec.ts` |
| 会话状态 additive 4 字段 | `src/lib/novel/novel-session-status.ts`（T09，additive `step_digest?`/`route_shell_mode?`/`canon_migration?`/`anti_ai_mode?` + zod passthrough 护栏） |
| Canon 三表存储（Rust） | `src-tauri/src/types/canon_types.rs` + `src/commands/canon_store.rs`（T11，三表 DDL + upsert/invalidate/supersede/query + schema_version 迁移链 + ingest_digest 去重 + proptest） |
| Canon 搜索（FTS+RRF+图遍历） | `src-tauri/src/canon_search.rs`（T12，FTS 召回 + rrf_fuse rank_const=1 + 窗口衰减 decay + 查询缓存 revision 失效 + petgraph BFS/连通分量/拓扑序，petgraph 0.8 dep） |
| Canon IPC 命令 | `src-tauri/src/canon_commands.rs`（T13，5+2 #[tauri::command]：canon_query/query_batch/facts_known_by/ingest/supersede + max_revision + projectId 签名，核心逻辑与 command 分离可测） |
| Canon 投影薄客户端 | `src/lib/novel/canon-graph-client.ts`（T14，封装 T13 IPC，getFactsKnownBy 等，禁句柄外泄断言 POV 防泄密） |
| Canon 编辑器只读前端 | `src/components/canon-editor/`（T18a，canon_query_batch 渲染事实表 + known_by/valid_at_chapter 过滤 + max_revision 展示） |
| Canon 影子双写 + 持久队列 | `src/lib/novel/canon-dual-write.ts`（T15，影子双写旧/新并行 + reconcile + T+5 退役检查 + 写失败→.novel/canon-pending.jsonl 持久队列 digest 幂等+退避封顶+重放） |
| chapter-ingest 双写钩子 | `src/lib/novel/chapter-ingest.ts`（T16，validateCanonConflicts 后单点追加影子双写钩子，DI 注入 CanonDualWriteDeps，仅 final/accepted 路径，reject 先于双写；isCanonDualWriteEligible/runCanonDualWriteHook 导出） |
| Canon 对账两阶段重放 | `src/lib/novel/canon-reconcile.ts`（T17，两阶段重放先 digest 补齐差异→仍不一致告警+留痕 + fast-diff 差异度量 + fast-check 幂等，fast-diff devDep） |
| **T18 硬门：stage-output-journal** | `src/lib/novel/stage-output-journal.ts`（T18，编排面 LLM 工件缓存，复用 T07 digest，.novel/journal/{digest}.jsonl TTL 过期，崩溃后命中跳过重调 LLM） |
| **T18 硬门：故障注入矩阵** | `src/lib/novel/fault-injection.spec.ts`（T18，6 类种子化 SIGKILL/部分写/磁盘满/文件锁/OOM/时钟偏移，LCG seed 确定性续跑一致） |
| **T18 硬门：端到端切片** | `src/lib/novel/e2e-chapter-hardgate.spec.ts`（T18，6 阶段垂直切片 canon→审计→门控→accept→双写→reconcile 零差异，含×5 崩溃/×2 重放） |
| ESLint boundaries 门禁 | `eslint.config.js`（T18 前置，eslint-plugin-boundaries 依赖方向门禁，novel/ 窄接口白名单，0 errors） |
| decision-log 工作区 | `docs/decision-log/`（T06，`_TEMPLATE.md` + 按日条目，A-34 强制） |

## v2.6 Tier1 新增锚点（F-001/F-002/F-006/F-009 已落地，2026-08-21 同步）

| 能力 | 锚点 |
|------|------|
| 六维审查证据校验 | `src/lib/novel/dimension-review-adapter.ts` + `evidence-chain.ts`（F-001，verifyEvidenceCitations 归一化 verbatim 匹配 + findNearestEvidenceFragment 滑窗回填，失败降级 warning） |
| 时间线漂移检测 | `src/lib/novel/deterministic-continuity-engine.ts`（F-002，detectTimelineDrift 第6检测项，severity critical>5/high>3/warning>0，零 LLM） |
| 资产回流保护 | `src/lib/novel/graph-adapter.ts`（F-006，mergeExistingPage edited_by:user 字段保护不覆盖） |
| 去 AI 分级替换表 | `src/lib/novel/de-ai-tiered-table.ts` + `de-ai-rules.ts` + `src/components/novel/de-ai-skill-editor.tsx`（F-009，112 词 3 档 1A高62/1B低38/3弱12 + runDeAiDualPass 两遍检测 dualPassRecheck/residual） |

## 条件性目标锚点（当前不存在，勿当现行）

`src-tauri/src/novel/status_schema.rs`、`decision_gate.rs`、`consistency_gate.rs`、`src-tauri/src/commands/status_commands.rs`、`gate_commands.rs` — 这些是 **Stage 3 目标层**，仅当 Stage 2 gap audit 证明现有 TS 主链锚点不足时才进入。当前仓库不存在它们，修改时不得冒充现行锚点，只能在文档中标记为目标。

## 修改优先顺序

1. `task-router` / `context-engine` / `deep-chapter-generation`
2. `novel-session-status` / `chapter-save-strategy` / `review-adapter`（未来补 `status_schema`/`decision_gate` 仍归此层）
3. `chat-panel` / `chat-resume`
4. 最后才补 `sidecar-client` 一类增强文件（Stage 4-5）

## 禁止做法

1. 在 `src/lib/novel/` 之外平行复制一套 novel 主链。
2. 新建第二份会话状态文件替代 `.novel/status.json`。
3. 用临时 Markdown 清单替代状态契约作为运行真源。
4. **向 `origin`（Mochocyang/QMAI）推送产品发布** — 产品远程真源是 **`smith` → `Smith-106/niko-buddy`**。日常：`git push smith HEAD:<branch>`；合并 master 走 PR 或 `smith/master`，禁止 force-push master。本地 `master...origin/main` diverge 是预期现象，不要用 `git pull origin` 同步产品线。

## Git 远程（防踩坑）

| remote | URL | 用途 |
|--------|-----|------|
| `smith` | `https://github.com/Smith-106/niko-buddy.git` | **唯一产品推送/发布** |
| `origin` | `https://github.com/Mochocyang/QMAI` | 上游/历史对照，**默认只读** |

助手脚本（在 QMAI 目录）：`../scripts/git-push-smith.ps1`（若存在）或手动 `git push smith`。

## 当前执行视图

按 Stage 推进（旧 Phase 仅作历史来源）：`1 Authority Realignment → 2 Release Readiness → 3 Core Stabilization → 4 High-ROI Enhancements → 5 Optional Sidecar`。Stage 2 已 strict PASS（b51ab03，v2.2.24）；Stage 3/4/5 + 加固层 v2.3.2 + Post-v2.3.2 演进（连续性引擎 + ARCH-1 拆分 + ISS-001/002/011）已落地，v2.4.1 已发布 GitHub 2026-07-21，v2.4.2 patch 已发布 2026-07-25（updater endpoint 修复 + 文档站上线 + LICENSE + 09 文档同步，tsc 0 + vitest 985/985）。详见 `@../.workflow/project.md` 与 `@../docs/qmai-codex-delivery/09-implementation-plan.md`。

## 验收与证据

- 交付验收标准见 `@../docs/qmai-codex-delivery/11-test-plan.md`，绑定写作质量目标而非仅编译通过。
- 发布证据链见 `12-acceptance-evidence-*.md`（最新 `2026-07-12-stage4-merged`，v2.3.0 era；v2.4.0/v2.4.1 release 证据见 `@../.workflow/state.json` stage_view.note + `.workflow/milestones/` 归档，未单独建 evidence 文件）。
- 缺陷台账见 `15-release-defect-ledger.md`。
