# QMAI — 长篇写作主基底

> 本文件是 QMAI 会话级执行纪律。详细规范见交付文档包 `@../docs/niko-buddy-codex-delivery/`。

## 身份与边界

- **QMAI 是 niko-hub 唯一主基底**。外部项目（novel-harness / ainovel-cli / NovelForge / novel-tool / maestro-flow）只贡献**模式、契约、规则**，不做整仓迁移，不接管主程序。
- **禁止 clean-room 重写**。已有锚点能承载职责就不新开平行实现。
- 桌面架构固定 `Tauri 2 + React + Rust`；IPC 走直 invoke，不引入 Node gateway；向量存储沿用 LanceDB。

## 四条不可退让的硬约束

1. **`status.json` 是运行时唯一真源** — `.novel/status.json`，编排层与生成层共同读取、分层写入。禁止新建第二份会话状态文件替代它，禁止用临时 Markdown 清单替代状态契约。
2. **Draft-first 是写作安全边界** — 所有 AI 输出先进 pending/ready 草稿，accept 后才回填正式正文与正式记忆。accept 前禁止污染正式层。
3. **门控优先级固定** — `Consistency(P0) > Anti-AI(P1) > Quality(P2)`。Quality 不得覆盖 Consistency 的失败；机械层检测先于语义层。
4. **收敛入口锁死** — 新增时间戳一律 `utils.todayStamp`，新增错误文案一律 `utils.toErrorMessage`；严禁在新文件中硬编码散落同类逻辑。

> **版本/CHANGELOG/generated 单写者红线（P0-2f）与 commit 纪律（P0-2g）**：以 `.workflow/PARALLEL-PACT.md` 会话地盘表「单写者红线」与 P16 为准。

## 主链文件锚点（现行）

修改前先确认目标落在哪个锚点。**只改下列已存在的文件**：

| 能力 | 锚点 |
|------|------|
| 意图路由 | `src/lib/novel/task-router.ts` |
| 上下文装配 | `src/lib/novel/context-engine.ts` + `context-data-sources.ts` |
| 章节生成 | `src/lib/novel/deep-chapter-generation.ts` + `deep-chapter-prompts.ts` |
| 草稿/会话状态 | `src/lib/novel/novel-session-status.ts` + `chapter-save-strategy.ts` |
| 审查/门控写回 | `src/lib/novel/review-adapter.ts` + `start-review-run.ts` + `start-six-dimension-review-run.ts` + `review-prompt-assembly.ts`（M10 提取，登记：`resolveReviewGateKey` / `CORR108_LEGACY_{CONSISTENCY,ANTI_AI}_REVIEW_TYPES` / `buildReviewPrompt` / `buildCanonModalityContext` / `splitChapterForReview`；review-adapter 经同目录 import + re-export 保对外 import 面） |
| Anti-AI | `src/lib/novel/de-ai-rules.ts` + `de-ai-adapter.ts` + `mechanical-slop-detector.ts` |
| 角色认知 | `src/lib/novel/character-cognition.ts` + `character-state.ts` + `character-aura.ts`（+ ARCH-1 拆分 `bindable-characters.ts`） |
| 过程库门面 | `src/lib/novel/process-library.ts`（E-02/E-04 登记：loadForPlanning / visibleInfoFor / auditChapter / computeVisibility / extractAuditInputsFromText） |
| 晋升桥凭证层 | `src/lib/novel/promotion-bridge.ts`（E-05 登记：PromotionRecord / replayKey / transitionPromotionState / PROMOTION_GATE_ALGEBRA / evaluateGate / promote / promotionAudit；三桥共享，接线点：formal-writeback.ts / canon-dual-write.ts / canon-backfill.ts） |
| 治理·trust 分级 | `src/lib/novel/trust-grader.ts`（E-06 登记：normalizeADR / licensePolicy / synthesizeTrust / gradeTrust / isRetrievable / filterByTrust；纯函数零 IO，消费点即时计算不写回凭证） |
| 治理·生命周期 | `src/lib/novel/kb-lifecycle.ts`（E-06 登记：decayFactorOf / recomputeDecay / markSuperseded / isSuperseded / filterAssemblable / supersedeByRevision / LIFECYCLE_POLICY；能力库衰减 + 过程库 supersession 双轨，策略不交叉） |
| 治理·评测 gate | `src/lib/novel/eval-gate.ts`（E-06 登记：G-1 种子 zod schema / loadGovSeedSet 三态 / computeTripleCriteria / evaluateRetrievalGate PASS\|FAIL\|BLOCKED / renderEvalGateReport；gate 常量在 offline-replay-config.ts EVAL_GATE） |
| 治理·可观测 | `src/lib/novel/kb-observability.ts`（E-06 登记：collectKbMetrics 6 指标 / checkTruthFoldDrift 告警 / 3 健康检查 / classifyKbError + recoveryPlanFor 四类错误分级） |
| 治理·不变量与坐标 | `src/lib/novel/kb-governance.ts`（E-06 登记：SAFETY_INVARIANTS 三安全不变量 / assertInvariantsNotDisabled / DimensionCoord 27 格 zod schema + coordIndex 双射 + E06_FEATURE_IDS 注册表 / assertBridgeTimeOnlyMove） |
| 确定性连续性引擎 | `src/lib/novel/deterministic-continuity-engine.ts` + `emotion-ledger.ts`（双层挂载：生成预检 + 审查兜底，机械层零 LLM） |
| Scene Breakdown | `src/lib/novel/scene-breakdown.ts`（阶段 1.5，`novelConfig.sceneBreakdownEnabled` 控制） |
| 章节摄取/快照 | `src/lib/novel/chapter-ingest-output.ts` + `chapter-snapshot-normalize.ts`（ARCH-1 拆分） |
| 深章 task-brief | `src/lib/novel/deep-chapter-task-brief.ts`（ARCH-1 从 `deep-chapter-generation` 拆出） |
| 大纲多智能体编排 | `src/lib/novel/outline-multi-agent-orchestrator.ts` + `outline-dynamic-agent-planner.ts` + `outline-result-protocol.ts` + `outline-agent-context.ts` + `outline-workflow-state.ts`（纯逻辑，自 v3 提取模式）+ `outline-multi-agent-adapter.ts`（v2 接线：streamChat + deep-outline 降级） |
| 大纲结构化真源（P0） | `src/lib/novel/outline-model.ts` + `outline-model-parse.ts` + `outline-model-render.ts`（P0 登记：类型/校验/digest；md→model 三级识别解析；model→md 确定性幂等渲染。sidecar JSON 为真源，md 为投影；命名避让 `src-tauri/src/canon/*` 三表） |
| UI 闭环 | `src/components/chat/chat-panel.tsx` + `chat-message.tsx` + `chat-resume.ts` |
| 公开 Barrel 与依赖边界 | `src/lib/novel/index.ts`（唯一公开顶层 barrel，原 `mod.ts` 已退役；外部层仅经 `@/lib/novel` 或 `eslint.config.js` 受控 `novel-deferred` 21 模块白名单导入）+ `eslint.config.js`（Tier 1 `error` + Tier 2 `warn` + `boundaries/dependencies`） |
| 测试脚手架目录 | `src/test-helpers/`（`chat-panel/chat-panel-test-setup.tsx` + `chat-panel-test-fixtures.ts` + `stage-output-journal-test-helpers.ts` + `component-test-utils.tsx`；与生产源码隔离，由 `gen-module-atlas.mjs` 与 `check-consistency.mjs` 自动排除） |
| 书稿导出中心（P1-04） | `src/lib/novel/export.ts`（TXT/DOCX/EPUB/PDF 全格式导出 + 章节范围/含草稿选项）+ `src/lib/export/pdf-export-gate.ts`（`.novel/export-history.json` 持久导出历史）+ `src/components/novel/export-center-view.tsx` |
| 批量提取与整本导入（P1-03） | `src/lib/novel/snapshot-scanner.ts`（60 章批量上限 + 起止章区间筛选 + 同号冲突路径定位）+ `src/lib/novel/chapter-import.ts`（整本 TXT 拆章导入，严禁自动触发 `ingestChapter`） |
| 主控·配置视图（G1） | `src/lib/novel/main-control-settings.ts`（登记：`MainControlSettingsView` / `projectMainControlSettings` / `clampChapterTargetChars` / `MAIN_CONTROL_CHAPTER_TARGET_{MIN,MAX,FALLBACK}`；`writingModel` 不在此视图内 —— D2=C 死字段） |
| 主控·配置落盘（G1） | `src/lib/novel/novel-config-persist.ts`（登记：`persistNovelConfigPatch` 唯一写入口；设置页与主控设置块共用，内存态 `setNovelConfig` 不算真源） |
| 主控·采纳+记忆回填（G2） | `src/lib/novel/accept-draft-with-ingest.ts`（登记：`acceptDraftAndIngest` 顺序=先 accept 后 ingest，失败分类 `AcceptDraftIngestStatus` 四值；`buildIngestActivity` 把结果转 `AgentActivityEvent`）+ `main-control-draft-actions.ts`（登记：`createMainControlAcceptSeam` / `resolveMainControlDraftTarget` / `adoptMainControlDraft`，accept seam 复用 `draft-manager.acceptChapterDraft`） |
| 主控·门控重跑（G2） | `src/lib/novel/chapter-gate-evaluation.ts`（登记：`evaluateChapterGates` 薄编排 + `UNASSESSED_DIMENSION_{CHAPTER_CONTRACT,AI_REVIEW}`；判定仍归 `deep-chapter-decision-gates.ts` `buildDecisionGates`）+ `main-control-gate-rerun.ts`（登记：`rerunMainControlGates` / `buildMainControlGateRows`，未评估落 skipped 不落 pass） |
| 主控·观测通道（G3） | `src/lib/novel/main-control.ts` `MainControlResult.activities` + `main-control-trace.ts` `buildTraceSnapshot`（fileVersion 2 投影）+ `src/lib/agent/tools/run-chapter-workflow.ts`（`stage_output` / 共识轨迹发射点）+ `chapter-title-generator.ts` `ensureChapterTitle`（`autoGenerateChapterTitle` 真开关，失败降级「第N章」） |

完整映射见 `@../docs/niko-buddy-codex-delivery/10-file-mapping.md`。

## 历史阶段锚点索引

Wave-0（T00-T05）、Wave-1（T06-T18a）、v2.6 Tier1（F-001/F-002/F-006/F-009）、W1 启动波、G1 评测集与检索适配、G4/G6 编辑影响与 Plateau、检索强化（r2 R-1→R3 / r3 B1–B5）的完整锚点表与 `decision-log` 说明已归档至 `docs/anchors/historical-anchors.md`。

## 条件性目标锚点（当前不存在，勿当现行）

`src-tauri/src/novel/status_schema.rs`、`decision_gate.rs`、`consistency_gate.rs`、`src-tauri/src/commands/status_commands.rs`、`gate_commands.rs` — 这些是 **Stage 3 目标层**，仅当 Stage 2 gap audit 证明现有 TS 主链锚点不足时才进入。当前仓库不存在它们，修改时不得冒充现行锚点，只能在文档中标记为目标。

## v2.34.0 主控自主化闭环新增锚点（Wave 0–4 已落地，2026-11-27 同步）

| 能力 | 锚点 |
|------|------|
| 零 LLM 规划/治理 MCP 写工具 | `src/lib/mcp/planning-write-tools.ts`（6 项 `SessionScope::Project` 处理器：`runDirectorUpsertWorld` / `runDirectorCommitPhase` / `runRulesUpsertBookRules` / `runCompassUpdate` / `runForeshadowingUpsert` / `runSubplotUpsert`，经 `state-bridge.ts` 接入，零写前缀导出、零 `draft.accept`） |
| 主控 Agent 零 LLM 本地 MCP 门面 | `src/lib/novel/main-control-mcp-tools.ts`（`MAIN_CONTROL_MCP_TOOL_NAMES` / `createMainControlMcpTools` 6 项只读诊断/门控门面，顶层仅 `import type`、执行体惰性动态导入 `@/lib/mcp/*` 防 barrel 循环，输出上限 12,000 字符） |
| ACP 快照 JSON 提取辅助 | `src/components/novel/antigravity-acp-snapshot-helpers.ts`（F1–F15 纯辅助模块：`extractSnapshotJsonCandidate`，供 ACP 消息级一键只读预览） |
| ACP 内联草稿审阅抽屉 | `src/components/novel/antigravity-acp-draft-drawer.tsx`（`AntigravityAcpDraftDrawer`，内联封装 `ChapterDraftDock`，仅在两步人工确认回调内传 `confirmed: true` 调用 `acceptDraftAndIngest`） |
| 主控顶层自主化启动条 | `src/components/novel/main-control-autonomy-bar.tsx`（`MainControlAutonomyBar`，在 `MainControlView` 承载长程战役与冷启动孵化弹窗并与 `Ctrl+K` `pendingLaunchDialog` 通道联动） |
| 创作总览一键修复映射 | `src/components/novel/creative-hub-actions.ts`（`CREATIVE_FINDING_ACTION_MAP` / `CREATIVE_GATE_ACTION_MAP` / `resolve*ActionTarget`，驱动创作总览诊断卡片一键跳转修复视图） |
| 拆书内联书架切换器 | `src/components/novel/book-analysis-bookshelf-switcher.tsx`（`BookAnalysisBookshelfSwitcher`，与 `BookAnalysisLibraryLayout` / `BookshelfView` 联动提供内联书架总览切换） |

## v2.35.0 主控自主化闭环 Wave 2 深化新增锚点（2026-11-28 同步）

| 能力 | 锚点 |
|------|------|
| 零 LLM 技能只读 MCP 桥 | `src/lib/mcp/skills-read-tools.ts`（`runSkillsList` / `runSkillsGet` / `loadWritingSkillConfigReadOnly` / `loadDeAiSkillConfigReadOnly`，严守 `@/lib/novel` 单一 barrel 窄接口、零 LLM 调用与零磁盘写入，供 `state-bridge.ts` 与 `main-control-mcp-tools.ts` 复用） |
| ACP 只读审校交接纯辅助 | `src/components/novel/antigravity-acp-handoff-helpers.ts`（F1–F15 纯辅助模块：`buildReviewerHandoffContextFromDrafts` / `buildReviewerHandoffPrompt` / `extractLatestPrepareId` / `summarizeDraftGateStatus` / `resolveSessionSlotArg` / `resolveEffectiveSlotProfileArg` / `pruneSavedDraftMapForTranscript`，严格仅预填零 IPC 自动发送） |
| ACP 多角色槽位切换条 | `src/components/novel/antigravity-acp-slot-bar.tsx`（F1–F15 无障碍纯展示子组件 `AntigravityAcpSlotBar`，承载 `writer` / `reviewer [RO]` / `architect` 键盘导航 `tablist` 与非破坏性审校交接触发按钮） |

## v2.36.0 Wave 1 缓存优化 / 工具收敛 / 新手引导新增锚点（2026-11-28 同步）

| 能力 | 锚点 |
|------|------|
| Prompt Cache 诊断卡片与追踪快照 | `src/components/settings/llm-cache-stats-card.tsx`（`LlmCacheStatsCard`，挂载于 `llm-provider-section.tsx` 并读取 `llm-client.ts#getLlmRequestTraceSnapshot()`；`llm-providers.ts` 含 `clampAnthropicCacheBreakpoints` <= 4 与 `prompt_cache_key` 出站白名单；`llm-stream-parsers.ts` 含 DeepSeek `prompt_cache_hit_tokens` 回退） |
| 主控三档固定工具掩码 | `src/lib/novel/main-control.ts`（`MAIN_CONTROL_TOOL_MASKS` 与 `RunMainControlOptions.intentToolMask`，`main-control-view.tsx` 仅经 `@/lib/novel` barrel 调用；`tools-schema.ts`/`runner.ts` 过滤 `virtual`、`apply-skill.ts` Schema 静态化） |
| 零 Key ACP 直达与新手引导闭环 | `src/components/project/create-project-dialog.tsx`（草稿保留 + 零 Key `landingView: "antigravityAcp"` 跳转）与 `src/App.tsx` / `welcome-screen.tsx` / `director-view.tsx` / `autonomous-incubator-dialog.tsx` |

## 修改优先顺序

1. `task-router` / `context-engine` / `deep-chapter-generation`
2. `novel-session-status` / `chapter-save-strategy` / `review-adapter`（未来补 `status_schema`/`decision_gate` 仍归此层）
3. `chat-panel` / `chat-resume`
4. 最后才补 `sidecar-client` 一类增强文件（Stage 4-5）

## 禁止做法

1. 在 `src/lib/novel/` 之外平行复制一套 novel 主链。
2. 新建第二份会话状态文件替代 `.novel/status.json`。
3. 用临时 Markdown 清单替代状态契约作为运行真源。
4. 向已拆分的 15 个主视图/Store 文件直接堆砌新的纯辅助函数、静态配置或独立子面板（F1–F15 边界，见 `docs/REFACTOR_AUDIT.md` §二）：新增纯逻辑/解析函数必须放入对应的 `*-helpers.ts` / `*-content.ts` / `*-items.ts`；新增独立子组件必须放入对应的 `*-widgets.tsx` / `*-panels.tsx` / `*-cards.tsx`；新增静态配置必须放入 `*-config.ts` / `*-style.ts`。主文件只保留编排、Hook 时序与对外 export（re-export 保底）。
5. **向 `origin`（Mochocyang/QMAI）推送产品发布** — 产品远程真源是 **`smith` → `Smith-106/niko-buddy`**。日常：`git push smith HEAD:<branch>`；合并 master 走 PR 或 `smith/master`，禁止 force-push master。本地 `master...origin/main` diverge 是预期现象，不要用 `git pull origin` 同步产品线。

## Git 远程（防踩坑）

| remote | URL | 用途 |
|--------|-----|------|
| `smith` | `https://github.com/Smith-106/niko-buddy.git` | **唯一产品推送/发布** |
| `origin` | `https://github.com/Mochocyang/QMAI` | 上游/历史对照，**默认只读** |

助手脚本（在 QMAI 目录）：`../scripts/git-push-smith.ps1`（若存在）或手动 `git push smith`。

## 验证命令与内环纪律

- `npm run verify:fast`（`npm run typecheck && npm run lint && npm run consistency`）：**仅用于编码内环快速检查（`<45s`）**。
- 阶段结束、交付验收与 PR/CI **必须**运行完整门禁：`npm run typecheck:force` 与 `npm run test:mocks`（及 `npm run lint` / `npm run consistency` / `npm run gen:check`）。

## 当前执行视图

- **当前主干版本**：`v2.36.0`（`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 与 `src/lib/changelog.ts`、`CHANGELOG.md` 保持单源一致，由 `npm run consistency` 机械校验）。
- 近期版本演进（`v2.29.0`–`v2.36.0`）与早期 Stage 1–5 历史脉络已归档至 `docs/history/execution-view-log.md`；路线与交付归档见 `@../.workflow/project.md` 与 `@../docs/niko-buddy-codex-delivery/09-implementation-plan.md`。

## 验收与证据

- 交付验收标准见 `@../docs/niko-buddy-codex-delivery/11-test-plan.md`，绑定写作质量目标而非仅编译通过。
- 发布证据链见 `12-acceptance-evidence-*.md`（最新 `2026-07-12-stage4-merged`，v2.3.0 era；v2.4.0/v2.4.1 release 证据见 `@../.workflow/state.json` stage_view.note + `.workflow/milestones/` 归档，未单独建 evidence 文件）。
- 缺陷台账见 `15-release-defect-ledger.md`。
