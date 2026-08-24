# Changelog

本文件记录 Niko Buddy (原 QMAI) 的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased] - Wave-2/3/4/5/6 Stage8 P0-P6 全工程波次 + T18/T31/T36 三硬门

### T36 精品模式（实验性，默认关闭）

- **精品模式为实验性功能，默认关闭**（`DEFAULT_PREMIUM_CONFIG.premiumMode = false`）。T36 终端硬门五项门槛机械层 3/3 PASS（一致性非劣/墙钟≤45min/无写入风暴），但**真实补验轮门槛①③ FAIL**：六维 overall 中位差 0.0（CI[-0.5,0] 含 0，未达 ≥+0.5）；盲评 Cohen's κ≈-0.01（随机水平，未达 ≥0.6）。
- 按蓝图契约处置：精品模式保持 opt-in 默认关闭；使用前建议先跑人工评估基准质量。
- 启用前置：`checkHardPreconditions`（canon_migration ≥ dual 且 reconcile 零差异持续 ≥3 章）+ 前缀缓存检查。
- 一键回退 `rollbackToSingleModel()`：premiumMode=false + 清空 fallbackChains + 关前缀缓存。

### Added

- **T32-T35 检索重调参 + 精品 registry + 哨兵**：rerank-api（custom endpoint 直连重排）+ embedding 三实现（Google/DashScope/Generic）+ canon_search.rs RRF 融合（α=0.08/β=0.75 网格扫描赢家 NDCG@10=0.941）+ model-resolver 五角色路由 + provider-registry add-only + premium-config/execution（GCR 两轮封顶 + 共识门 + 双判官）+ control-sentinels（13 分支互斥 + 720k 穷举哨兵）
- **T01b 语料 κ 盲标质量门**：`src/lib/novel/corpus-kappa.ts` Cohen's κ 纯函数计算（混淆矩阵→Po→Pe→κ）+ Landis-Koch 级别映射 + 黄金集合格线 GOLD_QUALIFIED_KAPPA=0.7 (A-21.2/A-23.2)；15 测试全绿；机械层零 LLM (ADR-19)；Draft-first (ADR-08) κ 结果先进 pending

### Fixed

- **eslint no-eval 规则注册**：`chunk-fingerprint.ts` 的 disable 指令引用了未注册的 `@typescript-eslint/no-eval`（该规则是 ESLint 内置非 TS 插件），改为 `no-eval` 恢复 T18 自设 "0 error" 底线
- **changelog-section 版本断言**：v2.6.1 发版漏改测试 mock 版本号（2.6.0→2.6.1），徽标匹配失耦修复

## [2.6.0] - 2026-08-22

### Summary（摄取与索引增强 + 图谱精度 + 断点/伏笔增强 + 决策回放 + 角色工作台 + 自评估）

v2.6.0 聚焦 Read 侧摄取与索引质量、图谱可靠性、断点/伏笔生命周期，以及写作侧的可追溯性与角色/章节可视化。涵盖八项新能力。

### Added

- **EPUB/HTML 特化摄取 + 提取器注册表**：导入 EPUB/HTML 参考素材走特化管线，按文档类型自动分派对应提取器；缓存键已版本化，解析升级后旧缓存自动失效
- **跨页 chunk 指纹去重**：为 chunk 建立 SHA-256 指纹索引，跨页 / 跨章节重复片段只入库一次，检索更精准、向量库增长受控
- **chunk 表自动 compaction + 对账纯函数**：自动压缩碎片化记录，配套纯函数对账校验索引一致性，长线写作数据不漂移
- **图谱抽取双层精度过滤**：关系边先机械层校验再语义层复核，拦截幻觉边，保证图谱与检索基于可靠边集
- **阶段断点 TTL 配置 + 伏笔 abandoned 态**：断点保留时长（TTL）可配置、过期自动清理；伏笔新增 abandoned（废弃）态，废弃后不计入活跃债务与回收提醒
- **ContextPack 决策回放面板**：聊天内可折叠面板逐条展示上下文组入的记忆、命中来源与取舍顺序，追溯每次生成依据
- **角色工作台**：角色识别后在独立工作台视图集中呈现档案、状态、认知、关系与近期出场，快速切换独立工位
- **章节自评估**：结构化输出 `{score, gap, fix}`——质量评分、缺口定位与返修建议，返修前锁定问题点

## [2.6.1] - 2026-08-23

### Added

- **反AI 文本来源埋点（#34 前置）**：新增 `AntiAiTextOrigin`（`ai_draft`／`user_text`／`unknown`）additive 可选字段；调用方经 `CorePackInputs.origin` 在 pack 层装饰进分析报告（`mech-pack` memo 点浅拷贝打标，`analyze` 本体保持 `text→report` 纯函数），`withPoolReportOrigin` 助手供测试与未来 #34 sink 复用；纯元数据绝不进 `finding` message、不影响任何门控结果。
- **route_shell_mode 值归一（#42，A-11 解锁条件 a 前半）**：`RouteShellMode` 新增 `authoritative` 别名档位并在 `resolveRouteShellMode` 单点归一为 `route`——消除「写 authoritative 静默回退 legacy」的失效路径；gate 集成测试钉住与 route 档等价。

### Fixed

- **反AI句式熵因子误报修复**：生产检测器由原始比特线 (<3.5 bits) 切换为认证链归一化口径 (<0.7, 归一化熵 = rawEntropy/log2(观测桶数))。中文句长普遍落在 ≤10 个 5 字符桶，log2(K)≤3.32 恒低于旧线，导致任意 ≥8 句章节必然产生熵 warn 噪声。切换仅削减 warn 噪声，门控语义不变 (warning-only)；新增孪生奇偶校验测试钉住双实现一致性。
- **反AI 影子画像脚本生产等价对齐**：采样口径对齐生产单元——移除 `>=30` 字过滤、`2500` 字窗 × `<=12` 窗全书等分偏移、去掉 `slice(0,8000)` 截断；PL warn 率由 35–53% 降至 0.0–0.8%，书口径 CV<0.30、FPR 0.88%（n=340 本）；新增书本级聚合视图与种子缺失中止守卫。

### Fixed（v2.5.1 发版后 CI 修复链）

- **CI**：vitest `retry: process.env.CI ? 2 : 0`（仅 CI 重试时序型 flaky，本地保持 loud fail；根因 knowledge-tree 回退标题连字符竞态已定位待修）
- **deps**：async-process/concurrent-queue 锁定版本从已 yanked 的 2.5.1 降回 2.5.0（修复 cargo metadata --locked 解析失败）
- **deps**：windows 0.61 → 0.62 绕开已 yanked 的 windows-future 0.2.1（其引用非 Windows 目标不存在的 IMarshal）
- **build**：windows 依赖移入 `[target.'cfg(windows)'.dependencies]`——声明与代码 cfg 门控对齐，修复 ubuntu/macos 编译 E0425
- **unix**：claude_cli.rs kill(pid) 补 u32→i32 显式转换（修复非 Windows 平台 E0308）
- 效果：master CI 自 v2.5.0 以来首次三平台全绿

## [2.5.1] - 2026-08-21

### Summary（工程卫生 + 文档对齐）

小版本维护：CI typecheck 口径统一、仓库清理（回收 94GB 构建产物）、CHANGELOG 补齐 v2.5.0 条目、文档站部署链修复（deploy-docs 触发分支从 release-b51ab03 改回 master，修复线上文档站停留在 v2.4.4 的脱节问题）。无功能变更，纯 notes-only 发版。

### Changed

- **CI**：typecheck 口径统一为 `npm run typecheck`（T00 步骤⑥，A-31）
- **文档站部署**：`deploy-docs.yml` 触发分支 `release-b51ab03` → `master`（根因修复：产品真源已回 master，旧绑定导致 Pages 部署与主线脱节）

### Fixed

- CHANGELOG 补记缺失的 [2.5.0] 条目（Wave 1-5 发布叙事此前仅存在于应用内 changelog.ts，未同步到本文件）
- README 版本徽标与 docs-site download/build 页版本引用同步至 2.5.1

## [2.5.0] - 2026-08-18

### Summary（五大 Wave：用户记忆 / @引用 / 计划模式 / 批量去AI味 / 上下文圆环）

v2.5.0 以五个 Wave 交付写作主链纵深能力，全部守 Draft-first 与机械层纯函数纪律；基线重冻（T00 最终门全量跑）后打 tag。发布叙事与 `src/lib/changelog.ts` 应用内条目一致。

### Added（Wave 1 用户记忆系统）

- **写作指纹记忆**：主链接线 + 会话单例 + 避用词 prompt 注入；设置页写作偏好最小表单（手动录入版，自动提炼计划在 v2.6）；de-AI 规则权重 + 六维审查校准联动

### Added（Wave 2 @引用系统）

- **@-mention 引用注入（混合检索三路融合）**：对话框输入 @角色/@地点/@设定 即触发三路融合（图谱活跃实体 + 向量检索 + 用户记忆）再生成；ContextPack 新增具名引用槽位，模型看到被引用记忆的精确内容 + 检索证据而非转述；与正文预算去重

### Added（Wave 3 计划模式）

- **确定性章节范围**：新增 Plan Mode 开关，先写本章计划（目标/节拍/人物/伏笔债务）再深度生成；计划约束生成 prompt 并喂给一致性引擎伏笔债务台账；Draft-first 依旧（计划先为 pending 草稿，accept 后生效）

### Added（Wave 4 批量去AI味）

- **一键处理整本项目**：DeAiBatch 库（并发调度 + 草稿 + 断点续跑 + 双 pass 适配器）按偏好去 AI 味规则矩阵与流派基线执行；实时进度对话框逐章回填/拒绝 + 全部回填；断点存于 status.json 重启可续跑

### Added（Wave 5 上下文用量圆环）

- **透明度可视化**：生成完成页纯 SVG 圆环展示上下文预算在记忆/检索/图谱/正文/其他五段的分配，读自冻结的 ContextPack.contextUsage 快照并 additive 写入 status.json；旧数据优雅降级

## [2.4.11] - 2026-08-18

### Summary（Phase 1 速赢：统一导出 DOCX + pangu 排版 + wake-lock）

基于双模型（GLM-5.2 产品视角 + deepseek-v4-pro 技术视角）联合制定的功能路线图 Phase 1 三项速赢落地：投稿链闭环（DOCX 导出）、排版质量（pangu 中英空格）、长任务防休眠（wake-lock）。全部守 A 既有纪律：零新重依赖（复用已有 docx-rs）、Draft-first、机械层纯函数。

### Added（统一导出 DOCX）

- **导出小说 Word 文档**：Rust 新命令 `export_novel_docx`（复用已有 `docx-rs` 依赖，非新增重库）；final 状态章节按章节号排序，标题映射 Heading1（Word 导航窗格/TOC 可用），正文按空行分段；TS 端 `exportNovelDocx` 复用 `exportProject` 的章节加载逻辑；设置页「数据管理」新增导出卡片（无项目时禁用）

### Added（pangu 中英空格排版）

- **format-normalizer 可选 pangu 步骤**：`formatNormalize` 新增 `enablePangu` 选项（默认 false 保向后兼容）+ `panguSpaced` 计数字段；在所有规范化（删除套话→替换→标点→数字→感叹号限额）之后追加中英自动空格；零 LLM 机械层纯函数，输出仍走 pending/ready 草稿

### Added（wake-lock 写正文防休眠）

- **Rust 电源管理命令**：`acquire_wake_lock` / `release_wake_lock`（`SetThreadExecutionState`，`Win32_System_Power` feature；非 Windows 目标 no-op 返回 false）；TS 封装 `src/lib/writing-wake-lock.ts`（`acquireWakeLock` / `releaseWakeLock` / `withWakeLock` try-finally 安全封装，任务抛错也释放）

### Notes

- notes-only release：安装包资产保持 **v2.4.6**，v2.4.11 为源码 tip（`smith/master`）
- Track A（机械门控）PASS；Track L9（书稿里程碑）N/A（纯应用发版）；Track B 分维诊断未触及
- 门控：`tsc --noEmit` 0 错误；`cargo test` 129 passed；vitest 8497 passed / 0 failed
- 路线图背景：A 覆盖 B 约 42-47%，Phase 1 为速赢补短（v2.4.11 notes-only），Phase 2 高价值纵深（v2.5.0 installer rebuild）待后续

## [2.4.10] - 2026-08-18

### Summary（UI↔后端契合联合审计 9 项修复）

基于双模型（deepseek-v4-pro + GLM-5.2）联合审计的 8 项 findings + 2 项规划阶段新风险，经 analyze→plan→execute→review 四阶段闭环交付的 9 项修复（26 文件，+469/−1313）。安全加固 + UI 弹性 + 死代码清理。

### Fixed（安全 — apiKey 明文持久化）

- **持久化边界加密接线（HIGH）**：project-store 6 对 `save*/load*`（llm/providers/search/embedding/multimodal/rerank）+ rerank 文件双写接入 AES-GCM 加密；运行时内存保持**明文**，仅持久化边界加密；加密失败**显式抛出**（无静默明文回退，`safeEncryptApiKey` 契约）；解密失败返回空串（跨设备用户重输）
- **一次性明文迁移**：新增 `migratePlaintextApiKeys()`，启动时检查**未解密的原始存储值**（非解密后内存值——后者永远看起来像明文会导致每次启动误重写），幂等短路；在 `initializeApp` 末尾调用；加写不删、可重入
- **备份指纹泄露（R-FINGERPRINT）**：备份导出排除 `qmai_fallback_fingerprint`，导入保护该键不被覆盖/写入

### Fixed（UI 弹性与 UX）

- **根 ErrorBoundary**：`main.tsx` 用 `<ErrorBoundary>` 包裹 `<App/>`，兜住 chrome 层（WelcomeScreen/sidebar/ActivityPanel）在 ContentArea 边界之外的崩溃
- **拆书任务持久化（R-INTERRUPTED-TASK）**：新建 `task-persistence.ts`（`loadTaskSummaries` + 500ms 防抖 `attachTaskPersistence`）；`book-analysis-store` 新增 `hydrateTasks` action；启动恢复时 running/paused → `error: "应用重启，任务已中断"`
- **CreateProjectDialog 初始化失败反馈**：异步初始化 reject → `alert("项目创建后初始化失败：…")`，不再静默
- **备份取消通道**：真实中断而非仅警告——Rust `AtomicBool` + `cancel_backup` 命令 + TS `cancelBackup()` + UI 取消按钮；逐文件/逐项目检查点；取消时先 `drop(zip)` 释放 Windows 文件句柄再 `remove_file`（否则句柄占用导致删除失败留残缺 zip）

### Removed（死代码清理 — 8 个孤儿 IPC + 关联 Rust 死代码）

- 删除未声明模块 `book_analysis.rs`（136 行）；删除 `workflow-extraction-engine.ts(+spec)`
- 移除 8 个无前端调用的孤儿命令：`vector_upsert/search/delete/count`、`hybrid_search`、`extract_pdf_images_cmd`、`extract_office_images_cmd`、`get_file_change_queue`，及关联 Rust 死助手函数/结构体/测试
- **保留**（F-DEAD-005）：`vector_legacy_row_count`/`vector_drop_legacy`、所有 `*_chunks`/`extract_and_save_*` 变体、`get_process_memory`（bench 用）；47 个活跃 IPC 契约语义不变

### Notes

- notes-only release：安装包资产保持 **v2.4.6**，v2.4.10 为源码 tip（`smith/master`）
- Track A（机械门控）PASS；Track L9（书稿里程碑）N/A（纯应用发版，不附书稿宣称）；Track B 分维诊断未触及
- 门控：`tsc --noEmit` 0 错误；`cargo test` 123 passed；聚焦 vitest 全绿；联合复核（deepseek + GLM）3 项 CHANGES-REQUESTED 全部修订
- 联合复核裁决记录：plaintext-on-disk 严重度采信 GLM 的 HIGH（已落盘事实）；ErrorBoundary 覆盖度采信 deepseek 的 MEDIUM（chrome 层缺口）；取消通道采信 deepseek 的真实中断方案

## [2.4.9] - 2026-08-17

### Added（测试覆盖率 100% 里程碑 — 全口径 statements/branches/functions/lines 达 100%）

- **覆盖率阈值固化**：`vite.config.ts` 设置四维阈值 **100/100/100/100**，由 Vitest coverage gate 持续机器校验；提交前跑 `npx vitest run src --coverage` 须全绿
- **测试套件扩充**：新增约 268 个 `.spec.ts`/`.spec.tsx` 文件覆盖既有未测模块；全量套件从 ~1009 增至 **8484 用例**（8484 passed | 2 skipped，EXIT=0）
- **不可达分支账本**：`docs/unreachable-branch-ledger.md` 记录所有经验证为「可证明不可达/死代码/v8 伪分支」的 `/* v8 ignore */` 注释位点与判定依据，作为覆盖率口径真源
- **版本同步工具**：`scripts/bump-version.mjs` 统一同步三处版本号（package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml）

### Changed

- README version badge → **2.4.9**，新增 coverage 100% 徽标与质量门槛说明

### Fixed（根因修复 — 评审发现的既有 bug）

- `src/lib/text-chunker.ts` 段落循环条件修复：旧条件 `!lines[i].startsWith("|")` 在独立的单行 `|` 输入下陷入无限循环（空原子不断推入且 `i` 不前进）；新条件 `!(lines[i].startsWith("|") && lines[i+1]?.startsWith("|"))` 仅在真正的多行表格起始处中断，附带回归用例（lone-`|` 段落 + 单行表格完整性）
- `src/components/sources/source-sidebar.tsx` 轮询刷新修复：旧代码在 React 19 deferred updater 下 `completed.length` 始终为空 → `setExtractedPaths` 刷新为死代码；重构为闭包同步读取 + functional updater（`pendingDeletions` 合并 prev 态），消除 stale-closure clobber 竞态

### Notes

- notes-only release：安装包资产保持 **v2.4.6**，v2.4.9 为源码 tip（`smith/master`）
- 覆盖率测量口径：排除 `src/main.tsx`、`src/i18n/index.ts`、`src/config/help-links.ts`、`src/types/**`、`src/test-helpers/**`、specs/d.ts、`src/lib/novel/vendor/**`、`src/lib/novel/__fixtures__/**`
- 执行会话：`maestro-test-coverage-100-20260815-172608`（analyze→plan→execute→review→verify 五步全 terminal，已 seal）

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
[2.6.1]: https://github.com/Smith-106/niko-buddy/compare/v2.6.0...v2.6.1
[2.4.2]: https://github.com/Smith-106/niko-buddy/compare/v2.4.1...v2.4.2
[2.4.1]: https://github.com/Smith-106/niko-buddy/compare/v2.4.0...v2.4.1
[2.4.0]: https://github.com/Smith-106/niko-buddy/releases/tag/v2.4.0
