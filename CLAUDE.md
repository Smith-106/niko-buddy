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
| 大纲多智能体编排 | `src/lib/novel/outline-multi-agent-orchestrator.ts` + `outline-dynamic-agent-planner.ts` + `outline-result-protocol.ts` + `outline-agent-context.ts` + `outline-workflow-state.ts`（纯逻辑，自 v3 提取模式）+ `outline-multi-agent-adapter.ts`（v2 接线：streamChat + deep-outline 降级） |
| UI 闭环 | `src/components/chat/chat-panel.tsx` + `chat-message.tsx` + `chat-resume.ts` |

完整映射见 `@../docs/qmai-codex-delivery/10-file-mapping.md`。

## Wave-0 新增锚点（T00-T05 已落地，2026-08-20 同步）

| 能力 | 锚点 |
|------|------|
| 离线回放 harness | `src/lib/novel/offline-replay-harness.spec.ts` + `offline-replay-config.ts`（评分因子权重/阈值候选值，type-only 契约） |
| **语料 κ 盲标骨架** | `src/lib/novel/corpus-kappa.ts` + `corpus-kappa.spec.ts`（Cohen κ 纯函数，T01b，黄金集合格线 κ≥0.7，机械层零 LLM） |
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

## W1 启动波新增锚点（roadmap W1 19 任务已落地，2026-08-23 同步）

| 能力 | 锚点 |
|------|------|
| 37 维审计注册表 | `src/lib/novel/audit-taxonomy.ts`（T22，AUDIT_TAXONOMY + GATE_MAPPING 三门控 + LITERARY_DIMS 文学提升维，与 inkos 37 维无重叠对照见 decision-log） |
| RuleStack 门控栈 | `src/lib/novel/rule-stack.ts`（T23/F-16/A-04.2，hardShortCircuit P0>P1>P2 硬短路 + gateProjection + craft.finale 终局升格 + combinePacks 规范化冻结组合语义（run 前冻结/run 内禁动态注册），fast-check 属性面见 spec） |
| craft 类型模型 | `src/lib/novel/craft/canon-craft-fields.ts` + `craft/beat-model.ts`（T26，ArcStage/ConflictCaliber/NarrativeMode/ClosureState 注册表 + Snyder 15-beat + 三段式） |
| Route 语言裁决 | `docs/p4/route-language-verdict.md`（T29，不触发 Rust 移植：720k 穷举 491ms/5000ms 余量 90.18%，TS 续用 + v2 契约修订注记） |
| canon 历史回填 | `src/lib/novel/canon-backfill.ts`（T30b，1..N-1 章离线摄取回填，复用 T15 影子双写 + T07 digest 幂等） |
| LanceDB compaction | `src-tauri/src/commands/canon_store.rs`（T32b additive，ingest 计数阈值 100 触发 + 保留 5 个 manifest 版本 + DiskUsage/CompactionReport 指标） |
| 备份/恢复/导出 | `src-tauri/src/canon_export.rs` + `src/components/novel/backup-export-view.tsx`（T34c，zip+sha2 校验和原子替换，零新依赖） |
| 反 AI 语料库 | `docs/p0/corpus/{human,ai,gold}/batch-*/` + `MANIFEST.md`（T01b 受控降级轨，synthetic-degraded 种子 30+30+6，解锁 P2-19；真实采集后台继续） |
| Radix Dialog 模式 | `@radix-ui/react-dialog@1.1.19`；新模态一律 DialogRoot+DialogOverlay(asChild)+DialogContent(asChild)，禁止手写 overlay/overflow 管理（LE-5；scroll lock=body[data-scroll-locked]） |
| 上下文三态策略 | `src/lib/context-budget.ts`（F-008，selectContextStrategy full≤50/sliding 50-200/summary>200，adaptiveScale 曲线上层选择器） |
| Voice Preservation | `src/lib/novel/book-analysis.ts` voiceStyleGuide + settings spelling convention 三字段（F-011，dialoguePunctuationStyle/paragraphIndent/quoteConvention 已入 NovelConfig+normalizeNovelConfig） |
| 可视化子面板 | `src/components/novel/corkboard-view.tsx` + `plotgrid-view.tsx`（F-010，复用 getTimelineEvents 单一真源） |
| 封面 Prompt 工作台 | `src/components/novel/cover-prompt-workbench.tsx` + `config/cover-platform-templates.json`（F-012，独立视图不走 Draft-first 不调 streamChat） |
| Gate v2 对照文档 | `docs/gate-v2-benchmark.md`（F-004，QMAI Track A/L9 vs StoryForge 四级 grader 对照） |
| 投影审计 | `src/lib/novel/projection-status-ledger.ts` auditTrail append-only 历史段（F-005，投影 commit/rebuild 取证） |
| 反 AI 候选池+四统计因子 | `src/lib/novel/anti-ai-candidate-pool.ts` + mechanical-slop-detector TIER3_EXTENDED 48 条 + de-ai-rules 42 条（T19，n-gram/句式熵/标点指纹/段落分布四因子 warn 态，source=synthetic-degraded 入元数据；pack 层归 T24） |
| 爽点量化+弧光追踪 | `src/lib/novel/craft/thrill-quantifier.ts` + `craft/arc-tracker.ts`（T27，三因子参数表版本化 config + EMA raw/smoothed 双列 + 增量重算 fast-check 增量≡全量，纯算术零 LLM） |
| 技法编译器 | `src/lib/novel/craft/technique-compiler.ts` + `craft/nmem-snapshot.ts`（T27b，nmem space→规则包版本化，8 memory+1 skill 快照入仓含 memory_id+version，离线降级功能不退化） |
| 角色生死结构化 | chapter-ingest.ts applyCharacterStateChangesToStore 写 isAlive/deathChapter（LE-2，结构化优先+正则 fallback 向后兼容，消除成语假阳性 AC-002.6） |
| 支线逾期结构化 | chapter-ingest.ts applySubplotChangesToStore 写 targetResolutionChapter/abandoned + detectOverdueThread 接入（LE-3，undefined→data_gap info 降级 IC-02，幂等 fold_rebuildable） |
| 规则包×4+共享特征 | `src/lib/novel/packs/{continuity,anti-ai-mech,anti-ai-llm,quality-six-dim}-pack.ts` + `shared-text-features.ts`（T24，composeCoreRulePacks 组合入口；六维有界并发 runSixDimBounded 复用 hardShortCircuit；review-adapter resolveReviewGateKey 读 GATE_MAPPING 唯一真源，CORR-108 保留常量） |
| 文学提升规则包 | `src/lib/novel/packs/literary-craft-pack.ts`（T28，14 条规则 quality 门 warning 态）+ `craft/craft-rule-registry.ts`（skill↔rule 桥接表，W12 注入范围含技法块 F-19） |
| 反AI标定流水线 | `scripts/anti-ai-calibrate.js` + `docs/p2/anti-ai-calibration.md`（T20，warn 档已标定 synthetic-degraded；block 档 pending-real-corpus 待真实语料重跑，A-12.3 可回溯） |
| anti_ai_mode 三档门控 | `src/lib/novel/control-kernel.ts`（T21 additive，WarnAnnotation/warnAnnotation/blockThresholdApplied/antiAiReason；warn 随 T19 先行，block 随 T20 阈值接线不卡 warn）+ `anti-ai-rewrite-convergence.spec.ts`（检测→改写→检测收敛 + Myers diff） |
| 三源真并行 ContextPack | `src/lib/novel/context-engine.ts` buildContextPackUnlocked Promise.all(wiki/canon/技法)+pack.sourceTimingsMs 计时探针 + temporal-memory.ts / character-cognition.ts fromCanonGraph()（T25，默认仍 fold 向后兼容，VIEW 契约不动） |
| UI 三面板 | `src/components/novel/craft/{arc-workbench,thrill-dashboard,technique-panel}.tsx`（T29a F-06/F-07/F-08，ECharts raw/smoothed 双列 lazy load，@tanstack/react-table，spec=craft-panels） |
| canon 写路径编辑 | `src/components/novel/canon-editor.tsx`（F-01 known_by/revealed_at 校正 POV 防泄密白名单）+ `wish-drive.tsx`（F-27 卡文引导 A-22.6 自洽校验）（T29b） |
| ContextPack 冻结不变量 | `src/lib/novel/context-pack-freeze.spec.ts` + deep-chapter-task-brief.ts canonHash 参数（T25b：同章共享 pack digest 断言/canon 事实集哈希入 task_brief/前缀字节稳定三不变量） |
| ★T31 P4 硬门 driver | `scripts/offline-replay.js`（可重跑，EXIT=0 纪律）+ offline-replay-t31-vertical-slice.spec.ts + `docs/p4/t31-vertical-slice-report.md`（T31 PASS：authoritative/回放评分 1.0≥0.9/崩溃注入×5/重放×2 一致/迁移前事实可查询；warn 态放行不计 FAIL） |
| L9 回放+爽点有效性 | `scripts/thrill-retention-correlate.js` + `docs/p4/{l9-replay,thrill-validity}-report.md`（T31b，真实多模型不可达子项标 PENDING 不粉饰） |
| canon_search 重调参 | `src-tauri/src/commands/canon_search.rs`（T32，α/β 参数扫 + 邻接物化 + 窗口衰减纯函数 spec） |
| 模型角色化层 | `src/lib/llm/{provider-registry,model-resolver,model-port}.ts`（T33，五角色 writer/critic/reviser/arbiter/judge 默认单模型向后兼容，fallback 链+TaskTier 路由） |
| 哨兵硬化 | `src/lib/novel/{budget-counters,watchdog,status-write-merge}.ts` + `scripts/50ch-telemetry.js`（T34，wallclock 全角色计入 + 分角色 token 软警告/硬封顶 + 无 token 卡死回落 + per-stage 预算表恰 45min） |
| 精品模式 | `src/lib/novel/premium-config.ts`（T33b 默认 off+一键回退+前缀缓存开关+硬前置检查）+ `premium-execution.ts`（T33c GCR 两轮封顶+交叉共识门分歧落 manual_review 仅 P2 additive 永不覆盖 P0/P1） |
| S10-S12/P6 文档件 | `docs/s10-evaluation-replay-foundation.md` / `s11-premium-mode-protocol.md` / `s12-literary-improvement-dimensions.md` + `docs/p6/{production-default-switch-decision,auto-update-contract}.md`（T34b） |
| ★T36 A/B 终端硬门 | offline-replay.js --ab 双臂配对 + offline-replay-t36-ab-pair.spec.ts（13 测试）+ `docs/p6/premium-mode-ab-report.md`（T36：机械三门槛②④⑤真跑 PASS；①六维差/③盲评 κ PENDING 需真实多模型+人工；建议=精品保持 opt-in 默认关闭+release notes 标注，T36 依契约可结案） |
| P4 垂直切片全验收（T31 硬门） | `scripts/offline-replay.js`（QMAI 内，A-10 全项 driver：驱动证据 spec + T02 同源纯函数评分复算 + 非零码退出纪律）+ `src/lib/novel/offline-replay-t31-vertical-slice.spec.ts`（机械证据 spec，纳入 `vitest run offline-replay` 过滤器）+ `docs/p4/t31-vertical-slice-report.md`（验收报告，2026-08-22 PASS） |

## G1 评测集 + 检索适配新增锚点（S5' + F1 已落地，2026-08-25 同步）

| 能力 | 锚点 |
|------|------|
| 检索适配（多源 RRF 融合检索） | `src/lib/novel/search-adapter.ts`（S5'，novelMixedSearch 六源混合检索 keyword/vector/graph/recent_chapter/canon + RRF 融合 rrfK + rerank；authoritativeOnly 先滤后截断 + filterAuthoritative 历史投影剔除） |
| 评测集 G1 骨架（离线评测建集 F1） | `src/lib/novel/eval/`（13 文件 + fixtures/：eval-schema/eval-adapters/eval-metrics/eval-harness/eval-report/eval-gates/eval-corpus-synth/eval-l3-replay/index + A 门 spec×2 + C 门占位 `eval-harness.real-llm.test.ts`；硬共识阈值 L2≥0.99 > L1≥0.95 > L3<0.01 + digest 锁复用 computeCheckpointDigestOf；合成语料先行，真实基线门待 snapshot 语料到位） |
| 评测脚本（真实基线门 + 快照修复） | `scripts/eval-baseline.mjs`（`npm run eval:baseline`，真实基线门入口）、`scripts/eval-extract-real.mjs`（真实评测抽取）、`scripts/repair-snapshot-object-string.mjs`（快照 object-string 修复）+ 入口 `npm run eval:l3`（REAL_LLM=1 vitest 跑 `eval-harness.real-llm.test.ts`） |

## G4/G6 编辑影响 + Plateau 停止新增锈点（51 号报告 P1 补齐，2026-09-03 同步）

| 能力 | 锈点 |
|------|------|
| G1 确定性检测器扩展 | `src/lib/novel/deterministic-continuity-engine.ts`（新增 4 类检测器 barrier_state critical / presence_path / container_state / set_count_drift warning，additive 可选切片 barrierEvents/presenceEvents/containerEvents/setCountSnapshots 缺失返回 []，注册入 detectors 数组；SUGGESTION_BY_TYPE 补 4 键） + `deterministic-continuity-engine-g1.spec.ts`（7 绿） |
| G2 声纹对齐闭环 | `src/lib/novel/voiceprint-alignment.ts`（G2，纯函数 checkVoiceprintConvergence 双向测量 driftVsBaseline + driftVsBefore，阈值 0.3，recommendation accept/revise/manual） + `voiceprint-alignment.spec.ts`（7 绿） |
| G3 bi-temporal 事务时间轴 | `src-tauri/src/types/canon_types.rs`（CanonEdge + created_at/expired_at serde(default) + effective_created_at/effective_expired_at/is_effective_at 回退 + MIGRATION_V4_BITEMPORAL + CURRENT_SCHEMA_VERSION→4）+ `src-tauri/src/commands/canon_store.rs`（edges_schema/edges_batch + Int64 列）+ TS 镜像 `src/components/canon-editor/canon-types.ts`（created_at/expired_at + effectiveCanonCreatedAt/effectiveCanonExpiredAt/isCanonEdgeEffectiveAt）；双命令验收：cargo 5 测试 + vitest 6 契约 |
| 编辑影响分析（事前冲击面预测） | `src/lib/novel/edit-impact-analyzer.ts`（G4，纯函数 analyzeEditImpact：before/after 文本 diff 预测受影响实体集 + riskLevel high/medium/low；接线 `chapter-ingest.ts` saveEditedSnapshot 内，非阻断 trace logger.info，异常吞掉绝不阻断保存） + `edit-impact-analyzer.spec.ts`（7 绿） |
| Plateau 停止准则 | `src/lib/novel/plateau-stop.ts`（G6，纯函数 detectPlateau：window=2/epsilon=0.5，滑动窗近 N 轮评分增益 ≤ epsilon 判 plateau） + `plateau-stop.spec.ts`（7 绿）；接线 `deep-chapter-generation.ts`（import + tracker + plateau break，早退 break 不置 manualReviewRequired） |

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
