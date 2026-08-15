# Changelog

本文件记录 Niko Buddy (原 QMAI) 的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [2.4.8] - 2026-08-15

### Added（remaining-gaps 四波收口 — 18 项改进点全部落地）

- **W1 P0 能力收口**：R06 四维反查生产接线——`buildRelatedChaptersContext` 接入 context-engine 主装配（additive `pack.relatedChapters` 字段 + `relatedChaptersEnabled` 灰度开关默认开），并经 FIELD_CONFIGS 渲染进入生成 prompt；伏笔台账逾期 finding（threshold=5）接入调度管线
- **W2 P1 机械层补全**：de-ai 流派 8→14（女频现言/无限流/种田/职场商战/异能末世/轻小说二次元 + 同构基线）+ 结构化规则矩阵 24→28 满格（7 类别 × 4 严重度，critical/high 硬规则语义不变）；replacement-dict 扩充（DELETE_ON_SIGHT 35 / PHRASE 40 / WORD 40 / COLLOQUIAL 28，+36 条同表扩展）+ 白名单豁免/self-conflict 回归 9 用例
- **W3 P2 工程/UX 收口**：R12 组合根抽取（App.tsx 启动编排 → `src/lib/composition-root.ts`）；R16 债看板 UI（chase_debt/伏笔逾期/情绪债务三分类聚合 + i18n zh/en）；R17 章节版本 diff（snapshot-viewer 接 MonacoDiffEditor 只读对比）
- **W4 性能残留**：graph-adapter WIKILINK_RE 模块级预编译（消除每次调用重复编译）；community-summary 自写信号量限流并行（maxConcurrency=3，不引新依赖）；export 章节/快照 Promise.all 并行（写盘保序）；dimension-review 评估确认 6 维并行已落地
- **E2E 基建**：Playwright e2e（app.spec.ts）+ ci.yml 前端检查（typecheck/unit/e2e 可选）+ vite/playwright 配置

### Changed

- 21 个 TS 未使用/类型错误修复（facts-store/format-normalizer/related-chapters 等 7 文件，零运行时行为变更）
- 运行时测量基线刷新（ipc/lancedb/llm/memory/search/startup）

### Notes

- notes-only release：安装包资产保持 **v2.4.6**，v2.4.8 为源码 tip（`smith/master`）
- 收口文档：`docs/qmai-codex-delivery/20-roadmap-w3w4-shou-kou.md`（18 项改进点落地对照 + 数据负债台账）

## [2.4.7] - 2026-08-15

### Added (roadmap 3-session 执行管线 — 质量门控 + 连续性约束 + 检索智能)
- **S1 P1 机械层硬化**：normalizeText 零宽剥离 + 48 CJK 同形字还原 + TIER1 补 14 词（humanizer-zh 吸收）；replacement-dict + format-normalizer（成对引号/省略号/年份月日/感叹号≤5）；vectorstore hybrid_search（mem0 加性融合：语义+BM25+entity，rrf_fuse 降级）；facts-store（graphiti 时间窗 Fact 契约 + 文件真源 + 取代链）；de-ai-rules 双层结构化（7类×4级 + 8 流派基线）
- **S2 P0 连续性深化**：related-chapters 四维反查（伏笔/出场/状态/关系，recentWindow=10，maxResults=5）+ 伏笔逾期 finding 接线；novel-session-status chase_debt 契约（防重复计息，additive-optional 回读兼容）；story-thread-arcs Quillica 6 态状态机合并进 continuity 引擎（非双轨）；measurement-fingerprint 契约确认（跨 pack 叙事拒绝）
- **S3 P2 质量**：gate-v2-scoring（0.2/0.3/0.5 加权 + reading_power hook*0.4+coolpoint*0.3+micropayoff*0.3，P2 参考永不覆盖 P0）；i18n parity 测试 + 修复 194 个翻译缺口（zh +140 / en +54）；进程内伪端点契约测试（REV-CE-003 critical 短路，零真实 HTTP）
- EPIC-005 persona 侧车（人物认知错误 UX + 侧边栏 UI）

### Changed
- README version badge → **2.4.7**
- docs-site download / build pages → 2.4.7 (notes-only: installer 资产仍指向 2.4.6)

### Removed (repo hygiene)
- 本地构建产物 / 缓存（dist/、*.tsbuildinfo、临时脚本）
- 过期 harvest-staging 报告归档到 archives/

### Notes
- notes-only release：安装包资产保持 v2.4.6，v2.4.7 为源码 tip（与 v2.4.6 先例一致）
- 产品远程保持 smith only

## [2.4.6+docs-cleanup] - 2026-08-10

### Changed
- README version badge + install note → **2.4.6** (tip vs installer clarified)
- docs-site download / build pages → 2.4.6 asset names and highlights

### Removed (repo hygiene)
- Accidental tracked junk: `tr master`, `remote-changelog.ts`, `验证修复.js`, `去AI味Skill规则.md`, `PHASE_2.4_PROGRESS_REPORT.md`

### Notes
- Local-only cleanup: `dist/`, `*.tsbuildinfo`, hub one-off `_fix*` scripts (not product git)
- Installer assets remain **v2.4.6**; residual source tip may advance without new tag until next asset rebuild
- Product remote remains `smith` only

## [2.4.6+remaining] - 2026-08-10

### Added (remaining checklist K/U/D/M/P)
- Knowledge promote Wave B/C/rewrite candidates (specs)
- `review-job-lifecycle` advances status.review_job on six-dim runs
- Review UI: `ReviewJobStatusStrip` + Evidence export button
- Main-path `layeredRecall: default` + sectionCharBudget on chat/deep-chapter
- `deep-chapter-wallclock-bridge` from stage_metrics; StageMetricEntry stage widened
- M1 ADR: memory-op stays VIEW rehearsal (no dual store)

### Notes
- Memory floor D1 entity pages for book 8人 live under manuscript tree (not product git)
- embedding p95 smoke remains honest local proxy

## [2.4.6+s1-s8] - 2026-08-10

### Added (S1–S8 post-wave stack)
- L0–L3 memory map docs + creation/dev dual-track discipline (harvest-staging)
- Layered recall modes + per-section char budget on `contextPackToPrompt`
- L1 `MemoryAtomKind` classification on `memory-op` / planAddOpsFromCanonFacts
- Live Wave C hooks: dual-pass + statistical signature at pre_six_dim_review
- `review-job-ui` presentation model; `evidence-chain-export` review export entry
- `deep-chapter-wallclock` stage aggregation + `scripts/smoke-embedding-p95.mjs`
- Claude CLI settings copy: model channel (not Claude Code IDE writing)

### Notes
- All new diagnostics remain `productHardGate: false`
- thril/origin/main-rewrite remain rejected

## [2.4.6+wave-c] - 2026-08-10

### Added (Wave C KPI stack — Track B soft)
- `de-ai-percentile` soft FPR-oriented percentile bands + Chinese FPR proxy self-test
- `de-ai-dual-pass` score + remediation notes (no manuscript auto-rewrite)
- `evidence-chain` ConStory-style export from continuity/CED findings (not accept blocker)
- `statistical-ai-signature` Binoculars-inspired classProb+lexical proxy (experimental)
- Skill hooks: `createDeAiDualPassHook`, `createStatisticalAiSignatureHook`

### Notes
- thril/origin/main-rewrite remain rejected product boundaries
- All Wave C scorers declare `productHardGate: false`

## [2.4.6+wave-b] - 2026-08-10

### Added (Wave B KPI stack)
- `memory-op` ADD/UPDATE/DELETE/NOOP over TemporalFact VIEW + ingest plan rehearsal
- Persisted community summaries loaded into `ContextPack.communitySummaries` (token-capped)
- Minimal write/review split (`write-review-split`) + `status.review_job` (review never blocks write)

### Notes
- Memory ops do not create a second fact store (ANL-013 C4)
- Community pack field is compressible / optional; embedding search path unchanged

## [2.4.6+kpi] - 2026-08-10

### Added (Wave A module KPI stack)
- `ced-report` soft Consistency Error Density report + skill hook (not product hard gate)
- Temporal `invalidateFact` / `queryFactsAt` + audit one-liner
- `scripts/smoke-retrieval-p95.mjs` local FS pack-assembly p95 harness

### Notes
- CED logs in continuity preflight; never thril hard gate
- p95 smoke is disk proxy latency, not LanceDB embedding SLA

## [2.4.6] - 2026-08-10

### Added
- Full vendored avoid-ai-writing detector (`patterns.cjs`) + `analyzeAvoidAiPatterns` (Track B soft)
- Headless multi-chapter formal LLM extract script (`scripts/formal-llm-chapter-extract.mjs`)
- Tip-aligned installer rebuild (NSIS + portable) for mid-loop source

### Notes
- thril still not a product hard gate
- Formal extract does not rewrite draft.md; seed snapshots backed up under `.novel/snapshots/_backup-seed-*`

## [2.4.5+midloop] - 2026-08-10

### Added
- Literary gold scale (thril/pull, humanGoldFloor 9) + six-dim review inject (Track B only)
- Novel skill hooks (`pre_six_dim_review`, `pre_write_prompt`)
- Temporal facts soft-gap audit + measurement fingerprint + literary-experiment protocol helpers
- Headless scripts: production context-pack export (character-states + snapshot facts), gold seed/verify, thril smoke
- Track B avoid-ai mechanical slop skill hook (`createAvoidAiMechanicalSlopHook` → six-dim pre-review soft inject)
- `assertThrilProgressClaimAllowed` narrative guard for cross-pack thril curves

### Changed
- Review center: measurement fingerprint presentation; Track A/B copy remains non-hard-gate for thril
- Fallback character states prefer `.novel/character-states.json` before wiki entity pages

### Notes
- **Not** a thril/overall≥9 product hard gate
- Installer assets for tag v2.4.5 are already on GitHub; this tip is **source mid-loop** without a new NSIS rebuild unless tagged later
- Formal LLM chapter ingest remains optional: heuristic seed snapshots kept until app final+ingest or headless DI harness
- Gold-pack thril N=5 median 6.7 (Track B observe; not product blocker)

## [2.4.4] - 2026-08-02

### Added
- 角色光环 (Character Aura) 完整模块系统
  - `character-aura-builtin.ts` - 内置角色光环数据
  - `character-aura-context.ts` - 上下文管理
  - `character-aura-document.ts` - 文档处理
  - `character-aura-markdown.ts` - Markdown 渲染
  - `character-aura-research.ts` - 研究功能
  - `character-aura-store.ts` - 状态存储
  - `character-aura-types.ts` - 类型定义
- 聊天面板新增 hooks
  - `use-chat-llm-resolver.ts` - LLM 解析器
  - `use-chat-scroll.ts` - 滚动控制
  - `use-exemplar-state.ts` - 示例状态管理
- 图谱组件新增 hooks
  - `use-graph-data.ts` - 图谱数据管理
  - `use-graph-layout.ts` - 布局算法
  - `use-graph-node-editing.ts` - 节点编辑
- 新增情感密度检查脚本 `scripts/check-emotion-density.mjs`
- 新增临时文件清理脚本 `scripts/cleanup-temp.ps1`

### Changed
- 优化聊天面板组件性能
- 更新知识树组件
- 改进 Claude CLI 传输层
- 优化 LLM 客户端和提供者配置
- 更新构建配置 (vite.config.ts, tsconfig.app.json)

### Removed
- 删除临时 TypeScript 文件 (temp-*.ts)
- 删除参考文件 (*-reference.ts)
- 清理日志文件 (*.log, tsc-errors.txt)
- 删除测试报告 (test-mocks-*.json)
- 删除备份目录 (src/lib/__backups__/)

### Fixed
- 修复级联取消模式以正确传播 LLM 调用信号
- 移除 LGPL opencc-js 依赖，实现原生 MIT 解决方案
- 修复 wiki-store.spec.ts 类型错误

## [2.4.3] - 2026-07-31

### Added
- 性能基准测试套件 (6 个文件，21 项指标)
- IPC 延迟基准测试
- LanceDB 基准测试
- LLM 延迟基准测试
- 内存使用基准测试
- 搜索性能基准测试
- 启动时间基准测试

### Changed
- GitHub 仓库重命名：niko-hub → niko-buddy
- 完成 Niko Buddy 品牌重命名 (32 个文件)
- 设置和存储模块品牌更新 (10 个文件)
- 反馈部分许可证头部和文档注释更新

### Fixed
- ISS-20260731-001: agent-tools applyFileEdit 添加 isSafeIngestPath 守卫
- 解决所有 44 个 TypeScript 错误并重建便携安装程序
- 修复命名冲突问题 (QMAI → Niko Buddy)

### Security
- PAT-G2 twin mirror 安全补丁

## [2.4.2] - 2026-07-28

### Added
- RPC2-TASK-006/007/008: Finding 对比入口 + Draft-first 状态机 + 门控回检
- RPC2-TASK-005: de-ai-preview-dialog 替换为 Monaco diff 面板入口
- RPC2-TASK-004: 封装 MonacoDiffEditor 组件与单测
- RPC2-TASK-003: 抽出 generateReviewRewriteEdits 可复用 helper
- RPC2-TASK-002: 新增 diff.ts LCS 纯函数与单测
- RPC2-TASK-001: 添加 Monaco 依赖与 worker 配置

### Changed
- 重构审查流程以支持 Draft-first 模式
- 优化门控回检机制

## [2.4.1] - 2026-07-25

### Fixed
- 修复章节摄入流程中的多个 bug
- 优化上下文数据源性能
- 改进深度章节生成提示词

## [2.4.0] - 2026-07-20

### Added
- 深度章节生成功能
- 角色光环研究模块
- 社区摘要功能
- 事实快照系统

### Changed
- 重构小说主链代码结构
- 优化上下文装配流程
- 改进审查门控机制

---

## 版本历史说明

- **v2.4.x**: Niko Buddy 品牌升级系列
- **v2.3.x**: QMAI 核心功能完善系列
- **v2.2.x**: 性能优化和稳定性改进系列
- **v2.1.x**: 小说写作主链功能系列
- **v2.0.x**: Tauri 2 架构升级系列

[2.4.4]: https://github.com/Smith-106/niko-buddy/compare/v2.4.3...v2.4.4
[2.4.3]: https://github.com/Smith-106/niko-buddy/compare/v2.4.2...v2.4.3
[2.4.2]: https://github.com/Smith-106/niko-buddy/compare/v2.4.1...v2.4.2
[2.4.1]: https://github.com/Smith-106/niko-buddy/compare/v2.4.0...v2.4.1
[2.4.0]: https://github.com/Smith-106/niko-buddy/releases/tag/v2.4.0
