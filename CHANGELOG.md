# Changelog

本文件记录 Niko Buddy (原 QMAI) 的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
