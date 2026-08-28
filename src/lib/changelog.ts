export interface ChangelogEntry {
  version: string
  date: string
  highlights: {
    en: string[]
    zh: string[]
  }
}

const TWO_POINT_TWO_TEN_CHANGELOG: ChangelogEntry = {
  version: "2.2.10",
  date: "2026-06-09",
  highlights: {
    en: [
      "Restored the LLM provider model fetch control so fetched models can be selected from a dropdown and the model test uses the selected model.",
    ],
    zh: [
      "恢复大语言/LLM 模型中的拉取模型入口：拉取后可从下拉框选择模型，点击测试模型时会测试当前选中的模型。",
    ],
  },
}

const TWO_POINT_TWO_TWELVE_CHANGELOG: ChangelogEntry = {
  version: "2.2.12",
  date: "2026-06-11",
  highlights: {
    en: [
      "Fixed continue-next-chapter regenerating chapter 1: incidental 开篇/第一章 wording inside prompts no longer hijacks the target chapter.",
      "Continue-next-chapter now remembers the chapter just generated in this conversation, so an empty chapter library no longer resets the target back to chapter 1.",
      "Fixed AI chapter editing failing with \"missing frontmatter, write-back stopped\": the original chapter frontmatter is reattached automatically, and fenced output or missing headings are tolerated.",
      "Added a per-chapter target character setting: chapter drafting, expansion thresholds, and the continue-next-chapter prompt all follow the configured target.",
      "Fixed the review stage being unstoppable when the stop signal fired before the review started.",
      "Fixed contradictory outline refinement checks by uniformly testing whether the target directory already contains .md files.",
      "Fixed stage-4 AI review interruptions: timeout extended from 2 to 5 minutes with automatic retries.",
      "Fixed stale thinking content showing up when creating or switching conversations.",
      "Redesigned the AI chat footer: deep thinking and normal mode are mutually exclusive, and normal mode supports plain conversation plus chapter editing.",
    ],
    zh: [
      "修复“继续生成下一章”会重复生成第一章的问题：提示词中顺带出现的“开篇/第一章”字样不再把目标章节劫持为第1章。",
      "继续生成下一章会记住本会话刚生成、尚未保存的章节号，章节库为空时也能正确推进到下一章。",
      "修复 AI 修改章节时“返回内容缺少 frontmatter，已停止写回”的问题：自动沿用原章节 frontmatter，并容错代码围栏与缺失标题。",
      "新增“单章目标字数”设置：章节生成、扩写阈值和“继续生成下一章”提示词都按设置目标执行。",
      "修复点击停止后审稿阶段可能无法停止的问题：停止信号在审稿开始前已生效时也会立即中止。",
      "修复大纲细化生成逻辑矛盾，统一按目录是否已有 .md 文件判断。",
      "修复 AI 审稿阶段4易中断问题：超时从 2 分钟延长到 5 分钟，并增加失败自动重试。",
      "修复新建/切换会话时显示旧思考内容的问题。",
      "AI 会话界面重做：深度思考与普通模式互斥切换，普通模式支持正常对话与编辑章节。",
    ],
  },
}

const TWO_POINT_TWO_ELEVEN_CHANGELOG: ChangelogEntry = {
  version: "2.2.11",
  date: "2026-06-10",
  highlights: {
    en: [
      "Fixed the AI Chat save-to-chapter-library flow so the first blank chapter keeps the full right-side chapter toolbar after saving.",
      "Restored frontmatter-dependent chapter actions after AI Chat saving, including Save as Final Chapter and View Memory.",
      "Synced preview-body updates when AI Chat appends to or overwrites the currently open chapter, preventing the same toolbar-state regression from reappearing.",
      "Removed the hard 2,200-3,200 character limit from later deep chapter stages, so review, revision, and final de-AI passes no longer stop or rewrite solely because of that range.",
      "Removed the old full-text hard cutoff warning from AI Chat streaming, so long chapters no longer stop at a fixed limit while duplicate-output detection stays in place.",
      "Refined the novel de-AI rules to preserve plot movement, character voice, rough dialogue edges, narrative rhythm, and subtext.",
      "Fixed local Claude Code CLI and Codex CLI mode so subprocesses explicitly inherit local PATH, HOME, USERPROFILE, APPDATA, and HTTP/HTTPS/ALL/NO_PROXY proxy variables.",
      "Fixed local CLI mode being overridden by preset default models; when no model is entered manually, QMAI now reads the current default model from ~/.claude/settings.json and ~/.codex/config.toml and runs with the local CLI configuration first.",
      "Added regression coverage for local CLI config reading, empty-model fallback, and CLI spawn arguments so local environment and proxy mode do not regress again.",
    ],
    zh: [
      "修复 AI 会话“保存到章节库”后，首章空白章节的右侧章节工具栏变成不完整工具栏的问题。",
      "修复保存后缺少“保存为正式章节”“查看记忆”等依赖章节 frontmatter 的按钮问题。",
      "补齐 AI 会话将内容追加/覆盖到当前已打开章节时的预览正文同步，避免出现同类工具栏状态错乱回归。",
      "删除 AI 会话深度章节生成后续阶段的 2200-3200 字硬性限制，审稿、返修和最终去 AI 味阶段不再因为字数区间强制重写或中止。",
      "移除 AI 会话流式输出的旧全文硬截断提示，避免长正文因固定上限直接停止；重复输出检测仍然保留。",
      "优化小说去AI味规则，强调保留剧情、角色声线、对白毛边、叙事节奏和潜台词。",
      "修复本地 Claude Code CLI / Codex CLI 无法正确继承本机环境的问题，启动时会显式带上本机 PATH、HOME、USERPROFILE、APPDATA 以及 HTTP/HTTPS/ALL/NO_PROXY 代理变量。",
      "修复本地 CLI 模式会被软件预设默认模型覆盖的问题；当未手动填写模型时，软件会读取本机 ~/.claude/settings.json 与 ~/.codex/config.toml 中的当前默认模型，并优先按本地 CLI 配置运行。",
      "补充本地 CLI 配置读取、空模型回退、以及 CLI 启动参数的回归测试，避免后续再次出现“本地环境读不到”或“走不到本地代理模式”的回退。",
    ],
  },
}

const TWO_POINT_FOUR_TEN_CHANGELOG: ChangelogEntry = {
  version: "2.4.10",
  date: "2026-08-18",
  highlights: {
    en: [
      "Security: apiKey plaintext persistence closed — 6 project-store save/load pairs (llm/providers/search/embedding/multimodal/rerank) + rerank double-write now AES-GCM encrypted at the persistence boundary; one-time plaintext migration; backup export excludes the fallback fingerprint.",
      "UI resilience: root ErrorBoundary wraps the chrome layer; interrupted book-analysis tasks persist and recover as error state after restart; CreateProjectDialog surfaces init failures; backup cancel channel truly interrupts (Rust AtomicBool + cancel_backup).",
      "Dead-code cleanup: 8 orphan IPC commands and associated Rust helpers removed; 47 active IPC contracts unchanged.",
      "Notes-only release: installer assets stay v2.4.6; source tip semantics apply until the next asset rebuild.",
    ],
    zh: [
      "安全：apiKey 明文持久化收口——project-store 6 对 save/load（llm/providers/search/embedding/multimodal/rerank）+ rerank 双写接入 AES-GCM 加密；一次性明文迁移；备份导出排除回退指纹。",
      "UI 弹性：根 ErrorBoundary 兜住 chrome 层；拆书任务持久化，重启后恢复为中断错误态；CreateProjectDialog 初始化失败显式反馈；备份取消通道真实中断（Rust AtomicBool + cancel_backup）。",
      "死代码清理：移除 8 个孤儿 IPC 命令及关联 Rust 死代码；47 个活跃 IPC 契约语义不变。",
      "Notes-only 发布：安装包资产保持 v2.4.6；下次资产重建前适用源码 tip 语义。",
    ],
  },
}

const TWO_POINT_SIX_SEVEN_CHANGELOG: ChangelogEntry = {
  version: "2.6.7",
  date: "2026-08-28",
  highlights: {
    en: [
      "Golden baseline (D1): commit-pin + artifact hashes + drift probe (mismatch fails), structural constraints only (gate priority Consistency>Anti-AI>Quality — never style).",
      "Minimal telemetry (D2): 3 pinned events (app_launch/gen_done/crash), independent jsonl channel with 10MB roll, privacy gate before invoke, never enters Track A gates.",
      "Status contract (D3): field whitelist + unknown-field rejection + chapter state machine hard validation (no silent coercion).",
      "Commit discipline (D4): single-chapter Draft-first closed loop, canonical content+memory paired (no partial states).",
    ],
    zh: [
      "黄金基线（D1）：commit-pin + 产物 hash + 漂移探针（mismatch 即 fail），只锁结构性约束（门控顺序 Consistency>Anti-AI>Quality——不锁文风）。",
      "最小埋点（D2）：3 事件钉死（app_launch/gen_done/crash），独立 jsonl 通道 10MB 滚动，invoke 前隐私门，永不进入 Track A 硬门。",
      "状态契约（D3）：字段白名单 + 未知字段拒绝 + 章节状态机硬校验（不静默 coerce）。",
      "提交纪律（D4）：单章 Draft-first 闭环，正式正文+记忆成对（无中间态）。",
    ],
  },
}

const TWO_POINT_SIX_SIX_CHANGELOG: ChangelogEntry = {
  version: "2.6.6",
  date: "2026-08-27",
  highlights: {
    en: [
      "Housekeeping release (notes-only): performance baseline timestamps refreshed (test auto-artifacts, no functional change).",
      "Repository cleanup: redundant remote branches archived and removed, build artifacts cleaned, knowledge base re-synced.",
    ],
    zh: [
      "维护发版（notes-only）：性能基线 timestamp 刷新（测试自动产物，无功能变更）。",
      "仓库清理：冗余远程分支归档删除、构建产物清理、知识库重新同步。",
    ],
  },
}

const TWO_POINT_SIX_FIVE_CHANGELOG: ChangelogEntry = {
  version: "2.6.5",
  date: "2026-08-26",
  highlights: {
    en: [
      "Severity gate (D1): hard_block/suggestion verdicts with degraded-cap semantics (degraded never triggers a hard veto) plus a four-dimension manifest state machine (fingerprint/judge/L9/anti-AI).",
      "Score migration (D2): legacy scores preserved with explicit legacy markers (never recomputed, never retroactive), schemaVersion bump, idempotent pure-function migration.",
      "Plain-language trio (D3): 19-term jargon→plain mapping (dual-read annotations), [STUB] legend (placeholder ≠ defect, zero positive conclusions), and buildRecalibrationSheet with before/after/drift/judge/sign fields.",
      "Appeal receipts (D4): three-block receipts (factor chain / baseline version / reference anchors — missing block rejected), state machine with reject→draft loop-back, and stability gate N≥3 with spread ≤0.5.",
    ],
    zh: [
      "评分核心（D1）：severity 硬否决/建议两档 + 降级封顶（降级永不触发硬否决）+ 四维清单状态机（指纹/判官/L9/anti-ai）。",
      "旧分迁移（D2）：旧分保留 + legacy 显式标记（不重算不追溯）+ schemaVersion 递增 + 幂等纯函数迁移。",
      "文档三件套（D3）：19 项术语→白话映射（加注双读）+ [STUB] 图例（占位非缺陷·零阳性）+ 重标定对照表（前后分/漂移/判官/签字位）。",
      "运行保障（D4）：申诉回执三块（因子链/基线版本/对照锚点——缺任一块拒收）+ 状态机 reject→draft 环回 + 稳定性门 N≥3 差≤0.5。",
    ],
  },
}

const TWO_POINT_SIX_FOUR_CHANGELOG: ChangelogEntry = {
  version: "2.6.4",
  date: "2026-08-26",
  highlights: {
    en: [
      "Adversarial regression-set framework (src/lib/novel/adversarial/): attack-sample schema (paraphrase/homoglyph/llm_rewrite × L1-L3), stratified recall computation, and honest reports (data_status=stub never fabricates scores).",
      "Bidirectional-likelihood diagnostic factor (Binoculars-style): LLR math with hand-crafted logits fixtures, symmetric aggregation, and explicit degradation semantics (model_available/llr=null/degraded/fallback_reason) — registered alongside sentenceEntropy, ADR-19 zero-LLM in the mechanical layer.",
      "Author fingerprint baseline: sentence-length/punctuation/dialogue/paragraph extraction plus drift detection (0.3 threshold) for judge-pool recalibration.",
      "Judge-pool recalibration plan (citation anchors, rolling near-term baseline, L9 explicit trigger/rollback) and L9 revalidation plan (N≥5, drift threshold, dual sign-off, escalation path) documented.",
    ],
    zh: [
      "对抗回归集框架（src/lib/novel/adversarial/）：改写攻击样本 schema（paraphrase/homoglyph/llm_rewrite × L1-L3）+ 分层召回计算 + 诚实报告（data_status=stub 不产模拟分）。",
      "双向似然诊断因子（Binoculars 系）：LLR 数学计算（手工 logits fixture 可测）+ 对称聚合 + 显式降级语义（model_available/llr=null/degraded/fallback_reason）——与 sentenceEntropy 同级注册，ADR-19 机械层零 LLM。",
      "原笔指纹基线：句长/标点/对话/段落抽取 + 漂移检测（阈值 0.3）——判官池重标定参照。",
      "判官池重标定计划（引用锚点/滚动近端基线/L9 显式触发+回退）与 L9 复验计划（N≥5/漂移阈值/双签/升级路径）文档落盘。",
    ],
  },
}

const TWO_POINT_SIX_THREE_CHANGELOG: ChangelogEntry = {
  version: "2.6.3",
  date: "2026-08-26",
  highlights: {
    en: [
      "S5' multi-source search adapter: novelMixedSearch six-source hybrid retrieval (keyword/vector/graph/recent_chapter/canon) with RRF fusion + rerank.",
      "G1 evaluation suite landed under src/lib/novel/eval/ (schema/adapters/metrics/harness/report/gates + real-LLM gates) with real baseline gates (npm run eval:baseline) and a snapshot-repair script.",
      "de-ai F-009 migration: dual-pass converged to de-ai-rules.ts 112-word tiered detector (detect→rewrite→re-detect); de-ai-dual-pass.ts is now a compatibility re-export.",
      "canon_search module migration to src/ + 9 typecheck error fixes (ISS-006/legacy track). Notes-only: installer assets stay v2.6.2.",
    ],
    zh: [
      "S5' 多源检索适配：novelMixedSearch 六源混合检索（keyword/vector/graph/recent_chapter/canon）+ RRF 融合 + rerank。",
      "G1 评测集落地 src/lib/novel/eval/（schema/adapters/metrics/harness/report/gates + real-LLM 门），真实基线门 npm run eval:baseline + 快照修复脚本。",
      "de-ai F-009 迁移：dual-pass 收敛到 de-ai-rules.ts 112 词分级检测（detect→rewrite→re-detect）；de-ai-dual-pass.ts 转为兼容重导出。",
      "canon_search 模块迁至 src/ + 9 处 typecheck 错误修复（ISS-006/legacy 轨）。Notes-only：安装包资产沿用 v2.6.2。",
    ],
  },
}

const TWO_POINT_SIX_TWO_CHANGELOG: ChangelogEntry = {
  version: "2.6.2",
  date: "2026-08-24",
  highlights: {
    en: [
      "Anti-AI shadow telemetry wiring (#34): four-factor pool reports stream to JSONL sink per chapter — the ≥200-chapter calibration clock is running; zero gate-behavior change.",
      "Corpus bundle strategy (option B): synthetic seeds embedded at build time — production four factors now emit real values without node:fs; ERR_INVALID_URL module-load fix for webview.",
      "Authorized-corpus ingestion pipeline: parameterized batch/layer/license-status with §4 enum enforcement and unlicensed red-lines.",
      "Corpus consumer guards: fail-closed indexed-only assertion shared by calibrate/rederive/profile scripts, packer genre-enum validation, and 16 isolation-invariant tests.",
    ],
    zh: [
      "反AI影子遥测接线（#34）：四因子池报告逐章流入 JSONL sink——≥200 章标定累积钟启动；门裁语义零变更。",
      "语料打包方案②：合成种子构建期内嵌——生产四因子零 node:fs 产出真值；修复 webview 下模块级 fileURLToPath 导致的整池加载失败。",
      "授权语料参数化摄取管线：批次/层/§4 六值枚举强制 + unlicensed 双重红线；同批跨层增量合并。",
      "语料消费端守卫：calibrate/rederive/profile 三脚本共享 indexed-only fail-closed 断言 + 打包器 genre 枚举校验 + 16 项隔离不变量测试与 corpus-check 校验器。",
    ],
  },
}

const TWO_POINT_SIX_ONE_CHANGELOG: ChangelogEntry = {
  version: "2.6.1",
  date: "2026-08-23",
  highlights: {
    en: [
      "Anti-AI sentence-entropy false-positive fix: normalized entropy (<0.7) replaces raw-bit line, eliminating guaranteed warn noise on Chinese chapters.",
      "Anti-AI text-origin instrumentation (#34 prerequisite): optional AntiAiTextOrigin field decorated at pack layer; analyze stays a pure function; zero gate impact.",
      "route_shell_mode value normalization (#42): authoritative alias resolves to route — no more silent legacy fallback.",
      "Shadow-profile script production-equivalent sampling: PL warn rate 35–53% → 0.0–0.8%; book-level aggregation view added.",
    ],
    zh: [
      "反AI句式熵因子误报修复：归一化熵 (<0.7) 替代原始比特线，消除中文长章必触发的 warn 噪声（warning-only，门控语义不变）。",
      "反AI 文本来源埋点（#34 前置）：AntiAiTextOrigin additive 字段 pack 层装饰；analyze 保持纯函数；不影响任何门控结果。",
      "route_shell_mode 值归一（#42）：authoritative 别名档位归一为 route——消除静默回退 legacy 的失效路径。",
      "反AI 影子画像脚本生产等价对齐：PL warn 率 35–53% → 0.0–0.8%；新增书本级聚合视图与种子缺失中止守卫。",
    ],
  },
}

const TWO_POINT_SIX_ZERO_CHANGELOG: ChangelogEntry = {
  version: "2.6.0",
  date: "2026-08-22",
  highlights: {
    en: [
      "Specialized EPUB/HTML ingestion pipeline + extractor registry: imported material auto-dispatched by document type.",
      "Cross-page chunk fingerprint deduplication via SHA-256 index — duplicate passages are ingested only once.",
      "Graph extraction dual-layer precision filtering: mechanical validation + semantic re-check, blocking hallucinated edges.",
      "Chunk table compaction + pure-function reconciliation, automatically compressing fragmented records.",
      "Breakpoint TTL config + foreshadowing abandoned state: expired breakpoints auto-cleaned; abandoned no longer counts as active debt.",
      "ContextPack decision-replay panel: shows each packed memory and its selection rationale.",
      "Character workbench: unified view of character profile / status / cognition / relations.",
      "Chapter self-assessment: emits {score, gap, fix} triple to lock problem points before rework.",
    ],
    zh: [
      "EPUB/HTML 特化摄取管线 + 提取器注册表：导入素材按文档类型自动分派。",
      "跨页 chunk 指纹去重——SHA-256 指纹索引，重复片段只入库一次。",
      "图谱抽取双层精度过滤：机械层校验 + 语义层复核，拦截幻觉边。",
      "Compaction——chunk 表自动压缩碎片化记录 + 纯函数对账。",
      "断点 TTL 配置 + 伏笔废弃态：断点过期自动清理；abandoned 不再计入活跃债务。",
      "决策回放面板——上下文包逐条展示组入记忆与取舍依据。",
      "角色工作台——角色档案/状态/认知/关系集中视图。",
      "章节自评估——输出 {score, gap, fix} 三要素，返修前锁定问题点。",
    ],
  },
}

const TWO_POINT_FIVE_ONE_CHANGELOG: ChangelogEntry = {
  version: "2.5.1",
  date: "2026-08-21",
  highlights: {
    en: [
      "CI hygiene: typecheck口径统一为 npm run typecheck (T00 step 6, A-31); committed the test helper component-test-utils.tsx that was wrongly gitignored, restoring green typecheck on CI (291x TS2307 + chained matcher errors eliminated).",
      "Docs site deployment chain fix: deploy-docs workflow trigger branch moved from release-b51ab03 back to master — the GitHub Pages site had been stuck at v2.4.4 while the source already said v2.5.0.",
      "CHANGELOG backfill: the missing [2.5.0] entry (Wave 1-5 narrative) is now recorded in CHANGELOG.md, previously only present in the in-app changelog; version bumped to 2.5.1 across package.json/tauri.conf.json/Cargo.toml.",
      "Notes-only release: installer assets stay v2.5.0; source tip semantics apply until the next asset rebuild.",
    ],
    zh: [
      "CI 工程卫生：typecheck 口径统一为 npm run typecheck（T00 步骤⑥，A-31）；提交被 .gitignore 误拦的测试助手 component-test-utils.tsx，恢复 CI typecheck 绿灯（消除 291×TS2307 及连锁 matcher 类型错误）。",
      "文档站部署链修复：deploy-docs 触发分支从 release-b51ab03 改回 master——此前 GitHub Pages 线上停留在 v2.4.4 而源码已是 v2.5.0。",
      "CHANGELOG 补齐：缺失的 [2.5.0] 条目（Wave 1-5 发布叙事）补记入 CHANGELOG.md（此前仅存在于应用内 changelog）；版本号三处统一升至 2.5.1。",
      "Notes-only 发布：安装包资产保持 v2.5.0；下次资产重建前适用源码 tip 语义。",
    ],
  },
}

const TWO_POINT_FIVE_ZERO_CHANGELOG: ChangelogEntry = {
  version: "2.5.0",
  date: "2026-08-18",
  highlights: {
    en: [
      "Writing preferences (user memory): new Writing Preferences block in Settings > Novel — human-readable labels only (internally mapped to dim:/deai_boost:/avoid_words prefixes, zero internal notation exposed); review scoring dimension weights / severity deductions calibrated per preference; de-AI rules weighted per preference with user avoid-words injected into the generation prompt; preferences persist to .novel/user-memory.json (atomic write).",
      "Scope note: v2.5.0 is the manual-entry edition of writing preferences; automatic extraction (learning preferences from writing history) is planned for v2.6.",
      "Feedback note: visible preference-application feedback (e.g. \"N preferences applied\" on the generation completion page) will be delivered in v2.5.1.",
      "@-mention reference injection (hybrid retrieval): typing @character/@place/@lore in the chat input triggers three-way fusion (graph active entities + vector retrieval + user memory) before generation; ContextPack gains named-reference slots so the model sees exact referenced memory + retrieved evidence rather than a paraphrase; de-duplicated with the existing body budget. Flagship synergy: @-mention → three-way hybrid retrieval fusion.",
      "Plan mode (deterministic chapter scoping): new Plan Mode toggle writes a chapter plan (objective / beats / characters / foreshadowing debt) before deep generation; the plan constrains the generation prompt and feeds the consistency engine's foreshadowing ledger; Draft-first still applies (plan is a pending draft until accepted). Flagship synergy: plan mode → consistency engine foreshadowing-debt tracking.",
      "Batch de-AI (one-click 100 chapters): DeAiBatch lib (concurrency scheduler + drafts + resume + dual-pass adapter) processes all chapters of a project in one pass, applying the per-preference de-AI rule matrix and genre baseline; live progress dialog with per-chapter accept/reject and all-accept; resumable across restarts via status.json. Flagship synergy: batch → de-AI rule matrix × genre baseline.",
      "Context-usage ring (transparency): a pure-SVG ring on the generation completion page shows how the context budget was split across memory / retrieval / graph / body / other, read from the frozen ContextPack.contextUsage snapshot and persisted additively to NovelDraftArtifact.context_usage in status.json; old messages / old status degrade gracefully (no field → no ring). Flagship synergy: ring → context-budget visualization.",
    ],
    zh: [
      "写作偏好（用户记忆系统）：设置页「小说设置」新增「写作偏好」区块——人类可读标签录入（内部映射 dim:/deai_boost:/avoid_words 前缀，零内部记号暴露）；审查打分维度权重/严重度扣分按偏好校准；去 AI 味规则按偏好加权，用户避用词注入生成 prompt；偏好持久化于项目 .novel/user-memory.json（原子写）。",
      "能力边界说明：v2.5.0 为写作偏好手动录入版；自动提炼（从写作历史学习偏好）计划在 v2.6 提供。",
      "反馈说明：偏好生效的可见反馈（如生成完成页「已应用 N 条写作偏好」）将在 v2.5.1 补齐。",
      "@引用注入（混合检索三路融合）：在对话框输入 @角色/@地点/@设定 即触发三路融合（图谱活跃实体 + 向量检索 + 用户记忆）再生成；ContextPack 新增具名引用槽位，模型看到的是被引用记忆的精确内容 + 检索证据而非转述；与正文预算去重。旗舰联动：@引用 → 混合检索三路融合。",
      "计划模式（确定性章节范围）：新增 Plan Mode 开关，先写本章计划（目标 / 节拍 / 人物 / 伏笔债务）再深度生成；计划约束生成 prompt 并喂给一致性引擎的伏笔债务台账；Draft-first 依旧（计划先为 pending 草稿，accept 后生效）。旗舰联动：计划模式 → 一致性引擎伏笔债务追踪。",
      "批量去 AI 味（一键处理 100 章）：DeAiBatch 库（并发调度 + 草稿 + 断点续跑 + 双 pass 适配器）一键处理整个项目的全部章节，按偏好去 AI 味规则矩阵与流派基线执行；实时进度对话框，逐章回填/拒绝 + 全部回填；断点存于 status.json，重启可续跑。旗舰联动：批量 → 规则矩阵×流派基线。",
      "上下文用量圆环（透明度）：生成完成页纯 SVG 圆环展示上下文预算如何在 记忆 / 检索 / 图谱 / 正文 / 其他 五段间分配，读自冻结的 ContextPack.contextUsage 快照，并 additive 写入 NovelDraftArtifact.context_usage 落盘 status.json；旧消息 / 旧 status 无字段时优雅降级（无字段 → 无圆环）。旗舰联动：圆环 → context-budget 可视化。",
    ],
  },
}

const TWO_POINT_FOUR_ELEVEN_CHANGELOG: ChangelogEntry = {
  version: "2.4.11",
  date: "2026-08-18",
  highlights: {
    en: [
      "Unified DOCX export: new export_novel_docx Rust command (reuses existing docx-rs, no new heavy dependency); final-status chapters sorted by chapter number, titles mapped to Heading1 (Word navigation pane/TOC), body split by blank lines; TS exportNovelDocx reuses exportProject chapter loading; new export card in Settings > Data Management (disabled without a project).",
      "Optional pangu spacing in format-normalizer: formatNormalize gains enablePangu option (default false, backward compatible) + panguSpaced counter; automatic Chinese-English spacing appended after all normalization steps; zero-LLM pure function, output still flows through pending/ready drafts.",
      "Wake-lock for long writing sessions: Rust power commands acquire_wake_lock / release_wake_lock (SetThreadExecutionState, Win32_System_Power feature; no-op false on non-Windows); TS wrapper src/lib/writing-wake-lock.ts (acquireWakeLock / releaseWakeLock / withWakeLock try-finally safe wrapper that releases even on error).",
      "Notes-only release: installer assets stay v2.4.6; source tip semantics apply until the next asset rebuild.",
    ],
    zh: [
      "统一导出 DOCX：Rust 新命令 export_novel_docx（复用已有 docx-rs，非新增重库）；final 状态章节按章节号排序，标题映射 Heading1（Word 导航窗格/TOC 可用），正文按空行分段；TS 端 exportNovelDocx 复用 exportProject 的章节加载逻辑；设置页「数据管理」新增导出卡片（无项目时禁用）。",
      "format-normalizer 可选 pangu 步骤：formatNormalize 新增 enablePangu 选项（默认 false 保向后兼容）+ panguSpaced 计数字段；在所有规范化（删除套话→替换→标点→数字→感叹号限额）之后追加中英自动空格；零 LLM 机械层纯函数，输出仍走 pending/ready 草稿。",
      "wake-lock 写正文防休眠：Rust 电源管理命令 acquire_wake_lock / release_wake_lock（SetThreadExecutionState，Win32_System_Power feature；非 Windows 目标 no-op 返回 false）；TS 封装 src/lib/writing-wake-lock.ts（acquireWakeLock / releaseWakeLock / withWakeLock try-finally 安全封装，任务抛错也释放）。",
      "Notes-only 发布：安装包资产保持 v2.4.6；v2.4.11 为源码 tip（smith/master）。",
    ],
  },
}

const TWO_POINT_FOUR_EIGHT_CHANGELOG: ChangelogEntry = {
  version: "2.4.8",
  date: "2026-08-15",
  highlights: {
    en: [
      "Remaining-gaps closure: R06 four-dimensional reverse lookup wired into the production ContextPack assembly (additive pack.relatedChapters + relatedChaptersEnabled switch, default on) and rendered into the generation prompt; overdue foreshadowing findings (threshold=5) enter the scheduling pipeline.",
      "de-ai completion: genres 8->14 with baselines; structured rule matrix 24->28 (7 categories x 4 severities, critical/high semantics unchanged); replacement-dict expanded (+36: 35/40/40/28) with whitelist/self-conflict regression tests.",
      "Engineering/UX: composition root extraction (App.tsx orchestration -> src/lib/composition-root.ts); debt board UI (chase_debt / overdue foreshadowing / emotion ledger); chapter version diff via MonacoDiffEditor.",
      "Performance: graph-adapter WIKILINK_RE module-level precompilation; community-summary semaphore-limited parallelism (maxConcurrency=3, zero new deps); export parallelism; dimension-review confirmed parallel (PERF-NEW-07).",
      "E2E infrastructure: Playwright e2e + ci.yml frontend checks. All 18 improvement points landed (see docs/qmai-codex-delivery/20-roadmap-w3w4-shou-kou.md).",
      "Notes-only release: installer assets stay v2.4.6; source tip semantics apply until the next asset rebuild.",
    ],
    zh: [
      "收口剩余改动：R06 四维反查接入生产 ContextPack 装配（additive pack.relatedChapters + relatedChaptersEnabled 开关默认开）并渲染进生成 prompt；伏笔逾期 finding（threshold=5）进入调度管线。",
      "de-ai 补全：流派 8→14 带基线；结构化规则矩阵 24→28（7 类别 x 4 严重度，critical/high 语义不变）；替换字典扩充（+36：35/40/40/28）带白名单/self-conflict 回归。",
      "工程/UX：组合根抽取（App 编排 → src/lib/composition-root.ts）；债看板 UI（追读债务/伏笔逾期/情绪债务）；章节版本 diff（MonacoDiffEditor）。",
      "性能：图谱正则预编译缓存；社区摘要信号量限流并行（maxConcurrency=3，零新依赖）；导出并行化；六维审查并行确认（PERF-NEW-07）。",
      "E2E 基建：Playwright e2e + ci.yml 前端检查。18 项改进点全部落地（docs/qmai-codex-delivery/20-roadmap-w3w4-shou-kou.md）。",
      "Notes-only 发布：安装包资产保持 v2.4.6；下次资产重建前适用源码 tip 语义。",
    ],
  },
}

const TWO_POINT_FOUR_SEVEN_CHANGELOG: ChangelogEntry = {
  version: "2.4.7",
  date: "2026-08-15",
  highlights: {
    en: [
      "Roadmap 3-session execution pipeline: S1 mechanical layer hardening (normalizeText zero-width stripping + 48 CJK homoglyph restoration + TIER1 14 terms; replacement-dict + format-normalizer; vectorstore hybrid_search with mem0 additive fusion; facts-store graphiti time-window Fact contract; de-ai-rules dual-layer 7-category x 4-severity rules).",
      "S2 continuity deepening: related-chapters four-dimensional reverse lookup (foreshadowing/appearance/state/relations) + overdue foreshadowing findings; novel-session-status chase_debt contract; story-thread-arcs Quillica 6-state state machine merged into continuity engine; measurement-fingerprint cross-pack narrative rejection.",
      "S3 quality: gate-v2-scoring weighted (0.2/0.3/0.5) + reading_power hook, P2 reference never overrides P0; i18n parity test + 194 translation gap fixes (zh +140 / en +54); in-process fake-endpoint contract tests (zero real HTTP).",
      "EPIC-005 persona sidecar: cognition error UX + sidebar UI.",
      "Notes-only release: installer assets stay v2.4.6; source tip semantics apply until the next asset rebuild.",
    ],
    zh: [
      "Roadmap 三会话执行管线：S1 机械层硬化（normalizeText 零宽剥离 + 48 CJK 同形字还原 + TIER1 补 14 词；replacement-dict + format-normalizer；vectorstore hybrid_search mem0 加性融合；facts-store graphiti 时间窗 Fact 契约；de-ai-rules 双层 7 类 x 4 级规则）。",
      "S2 连续性深化：related-chapters 四维反查（伏笔/出场/状态/关系）+ 伏笔逾期 finding；novel-session-status chase_debt 契约；story-thread-arcs Quillica 6 态状态机并入连续性引擎；measurement-fingerprint 跨 pack 叙事拒绝。",
      "S3 质量：gate-v2-scoring 加权（0.2/0.3/0.5）+ reading_power hook，P2 参考永不覆盖 P0；i18n parity 测试 + 修复 194 翻译缺口（zh +140 / en +54）；进程内伪端点契约测试（零真实 HTTP）。",
      "EPIC-005 persona 侧车：人物认知错误 UX + 侧边栏 UI。",
      "Notes-only 发布：安装包资产保持 v2.4.6；下次资产重建前适用源码 tip 语义。",
    ],
  },
}

const TWO_POINT_FOUR_SIX_CHANGELOG: ChangelogEntry = {
  version: "2.4.6",
  date: "2026-08-10",
  highlights: {
    en: [
      "Docs cleanup release: README version badge and install note aligned to 2.4.6 (tip vs installer clarified), docs-site download/build pages updated to 2.4.6 asset names and highlights.",
      "Repo hygiene: removed accidental tracked junk (tr master, remote-changelog.ts, 验证修复.js, 去AI味Skill规则.md, PHASE_2.4_PROGRESS_REPORT.md); local-only cleanup for dist/, *.tsbuildinfo and hub one-off scripts.",
      "Installer assets remain v2.4.6; residual source tip may advance without a new tag until the next asset rebuild.",
      "Product remote remains smith-only (Smith-106/niko-buddy).",
    ],
    zh: [
      "文档清理发布：README 版本徽章与安装说明对齐 2.4.6（tip 与安装包区分），docs-site 下载/构建页更新为 2.4.6 资源名与亮点。",
      "仓库卫生：移除误提交的杂项（tr master、remote-changelog.ts、验证修复.js、去AI味Skill规则.md、PHASE_2.4_PROGRESS_REPORT.md）；本地清理 dist/、*.tsbuildinfo 与 hub 一次性脚本。",
      "安装包资产保持 v2.4.6；源码 tip 在下次资产重建前可继续前进而不打新 tag。",
      "产品远程保持仅 smith（Smith-106/niko-buddy）。",
    ],
  },
}

const TWO_POINT_FOUR_FIVE_CHANGELOG: ChangelogEntry = {
  version: "2.4.5",
  date: "2026-08-08",
  highlights: {
    en: [
      "Quality Foundation v1: temporal facts default-on, entity-name boost on context search, StateDelta light-check (warn-only), outline thril soft-gate with explicit acknowledge.",
      "StateDelta structured JSON extract with heuristic fallback; mid-chapter Track A prior pack falls back to draft.md.",
      "Track A/B split presentation remains the product hard-gate policy (not overall average ≥9).",
      "Version triple-aligned (package / tauri / cargo) at 2.4.5; GitHub release notes-only until desktop assets are attached.",
    ],
    zh: [
      "Quality Foundation v1：temporal 默认开、实体名检索加权、StateDelta 轻检（默认 warn-only）、大纲 thril 软门与显式确认。",
      "StateDelta 支持结构化 JSON 抽取并回退启发式；中后章 Track A 前情包可回退 draft.md。",
      "产品硬门仍为 Track A/B 拆轨（非六维均分≥9）。",
      "package / tauri / cargo 版本对齐 2.4.5；GitHub Release 暂为 notes-only，安装包资产后续补挂。",
    ],
  },
}

const TWO_POINT_FOUR_FOUR_CHANGELOG: ChangelogEntry = {
  version: "2.4.4",
  date: "2026-08-01",
  highlights: {
    en: [
      "Maintenance release line for Niko Buddy 2.4.x packaging and docs alignment after the 2.4.3 brand rename.",
      "Kept product remote truth on Smith-106/niko-buddy (smith) while origin remains read-only upstream contrast.",
    ],
    zh: [
      "Niko Buddy 2.4.x 维护发布线：2.4.3 品牌更名后的打包与文档对齐。",
      "产品远程真源保持 Smith-106/niko-buddy（smith）；origin 仅作上游对照只读。",
    ],
  },
}

const TWO_POINT_FOUR_THREE_CHANGELOG: ChangelogEntry = {
  version: "2.4.3",
  date: "2026-07-31",
  highlights: {
    en: [
      "Product renamed to Niko Buddy: npm package and Rust crate renamed to niko-buddy, README and workspace docs updated to the three-tier naming (niko-hub workspace / Niko Buddy product / reference projects), resolving the naming clash with the upstream Mochocyang/QMAI.",
      "Fixed all 44 TypeScript build errors: added the missing graphology-types dev dependency, switched wiki-graph to the UndirectedGraph constructor, restored the missing review-view helper functions and moved FindingCompareDialog into the parent scope, fixed the finding-compare-dialog rewritten-markdown type mismatch, and cleaned unused test variables.",
      "Rebuilt and re-signed the Windows installer and portable package from the fixed source tree.",
    ],
    zh: [
      "产品更名为 Niko Buddy：npm 包与 Rust crate 改名为 niko-buddy，README 与工作区文档同步为三层命名体系（niko-hub 工作区 / Niko Buddy 产品 / reference 参考项目），解决与上游 Mochocyang/QMAI 的重名冲突。",
      "修复全部 44 个 TypeScript 构建错误：补装缺失的 graphology-types 类型依赖、wiki-graph 改用 UndirectedGraph 构造、补齐 review-view 缺失的辅助函数并将 FindingCompareDialog 移至父组件作用域、修正 finding-compare-dialog 的 rewritten.markdown 类型不匹配、清理测试文件未使用变量。",
      "基于修复后的源码重新构建并签名 Windows 安装包与便携版。",
    ],
  },
}

const TWO_POINT_FOUR_TWO_CHANGELOG: ChangelogEntry = {
  version: "2.4.2",
  date: "2026-07-25",
  highlights: {
    en: [
      "Fixed the updater endpoint drift: the Tauri updater and release URL sources now point to Smith-106/niko-hub instead of the upstream Mochocyang/QMAI, so in-app auto-update reaches the correct release artifacts (compile-time embedded, takes effect from this version).",
      "Added MIT LICENSE file and aligned README badge/release-links from 2.2.24/Mochocyang to 2.4.1/Smith-106, plus a v2.4.0+ core-features section (continuity engine / emotion-ledger / mechanical-slop-detector) and ARCH-1 split file names.",
      "Launched the niko-hub documentation site (Astro + Starlight, Chinese-first) deployed on GitHub Pages at smith-106.github.io/niko-hub, with product front-page, download, quickstart, six feature pages, and three developer pages.",
      "Synced the delivery doc 09-implementation-plan.md (was stalled at Stage 2) to the actual v2.4.1 release state and the v2.4.2 patch scope.",
    ],
    zh: [
      "修复 updater endpoint 漂移：Tauri 更新器与 release URL 源改指向 Smith-106/niko-hub，不再指向上游 Mochocyang/QMAI，应用内自动更新能到达正确的 release 产物（编译期嵌入，自本版本生效）。",
      "新增 MIT LICENSE 文件，README badge/release 链接从 2.2.24/Mochocyang 对齐到 2.4.1/Smith-106，补 v2.4.0+ 核心功能节（连续性引擎/emotion-ledger/mechanical-slop-detector）与 ARCH-1 拆分后文件名。",
      "上线 niko-hub 文档站（Astro + Starlight，中文优先），部署于 GitHub Pages smith-106.github.io/niko-hub，含产品门面、下载、快速开始、6 功能页、3 开发者页。",
      "同步交付文档 09-implementation-plan.md（原滞后在 Stage 2）至 v2.4.1 实际发布状态与 v2.4.2 patch 范围。",
    ],
  },
}

const TWO_POINT_FOUR_ONE_CHANGELOG: ChangelogEntry = {
  version: "2.4.1",
  date: "2026-07-21",
  highlights: {
    en: [
      "Calibrated the continuity engine's absence and dormancy thresholds against a real Chinese long-form sample (Re0, 10 volumes / 138 chapters): absentThresholdChapters 5→7 (312 samples, P75) and dormantThresholdChapters 3→10 (753 samples, P75), replacing placeholder defaults with statistics measured from actual chapter text via scripts/calibrate-from-epub.mjs.",
      "Closed the ISS-002 real-LLM token observability gap with double coverage: a mock-server integration test (real fetch SSE + real streamChat + real node-fs persistence, synthetic tokens) plus a real Anthropic-wire test that produces real billable tokens (message_start input_tokens + message_delta output_tokens captured by extractAnthropicUsage), env-gated and skipped in CI when credentials are absent.",
      "Completed the ARCH-1 SRP split of four god modules (8713 lines): context-engine (f587696), character-aura bindable-characters cluster (0750fd7), deep-chapter task-brief cluster (f543693), and chapter-ingest snapshot-normalize leaf (97974fe) — each split by abstraction layer, not function count, preserving backward-compat via re-export + import.",
      "Wired the option C1 priorReviewResults short-circuit (aacb8ec) so the continuity mechanical preflight runs once serially before the 6-dimension review, injecting its results to activate the short-circuit and eliminate the duplicate load in reviewChapter.",
      "Built the ISS-002 token data channel (fe50512): LlmMetric gains inputTokens/outputTokens, ProviderConfig gains extractUsage, four extractors (Anthropic/OpenAI/Responses/Google) bind 9 provider branches, streamChat accumulates usage via recordUsage.",
      "Fixed the chat panel tab metadata so the hidden responsive @md:inline element carries real metadata (1155829), and vite build produces the @container(width>=28rem){.@md\:inline{display:inline}} rule as proof.",
    ],
    zh: [
      "用真实中文长篇样本（Re0 10 卷 138 章）校准连续性引擎的缺席与休眠阈值：absentThresholdChapters 5→7（312 样本 P75）、dormantThresholdChapters 3→10（753 样本 P75），经 scripts/calibrate-from-epub.mjs 从真实章节文本统计替换占位默认值。",
      "ISS-002 真实 LLM token 可观测性缺口双覆盖收口：mock server 集成测试（真实 fetch SSE + 真实 streamChat + 真实 node fs 落盘，合成 token）+ 真实 Anthropic wire 测试产真实计费 token（message_start input_tokens + message_delta output_tokens 经 extractAnthropicUsage 捕获），环境变量门控缺凭证时 CI 跳过。",
      "完成 ARCH-1 四巨函数（8713 行）SRP 拆分：context-engine（f587696）、character-aura 可绑定角色集群（0750fd7）、deep-chapter task-brief 集群（f543693）、chapter-ingest 规范化叶子（97974fe）——按抽象层非按函数数拆分，re-export + import 保向后兼容。",
      "option C1 priorReviewResults 短路真接线（aacb8ec）：连续性机械预检在 6 维审查前串行跑一次注入结果激活短路，消除 reviewChapter 重复 load。",
      "建 ISS-002 token 数据通道（fe50512）：LlmMetric 加 inputTokens/outputTokens、ProviderConfig 加 extractUsage、4 extractor（Anthropic/OpenAI/Responses/Google）绑定 9 provider 分支、streamChat 经 recordUsage 累加 usage。",
      "修复 chat 面板 tab 元数据：隐藏的响应式 @md:inline 元素携带真实元数据（1155829），vite build 产 @container(width>=28rem){.@md\\:inline{display:inline}} 规则铁证。",
    ],
  },
}

const TWO_POINT_FOUR_ZERO_CHANGELOG: ChangelogEntry = {
  version: "2.4.0",
  date: "2026-07-19",
  highlights: {
    en: [
      "Added a deterministic (non-LLM) continuity engine: dormancy/absence/overdue/unresolved-foreshadowing and dead-character-state checks run before any semantic review, with a 3-level severity scheme (critical/warning/info) aligned to ADR-30. Mechanical critical findings block chapter approval via the Consistency P0 gate, never waiting for the LLM.",
      "Dual-layer mounting of the continuity engine: a non-blocking bullet reminder at the generation layer (preserving Draft-first) plus a review-layer mechanical preflight that short-circuits the LLM review on critical findings.",
      "Mechanical critical findings route to manualHandoff (reusing the emotion-ledger circuit-breaker path) instead of entering the Q4 fix-loop, so a consistency break surfaces as an explicit handoff rather than an auto-rewrite.",
      "Override persistence store with a 6-value reasonCode union (intentional_death / intentional_absence / intentional_flashback / posthumous_by_design / false_positive / state_layer_fix) so dismissed findings carry auditable rationale instead of free-text.",
      "Consistency metric data flow: collectContinuityMetric records execution time, finding counts by severity, data-gap count, override hits, short-circuit hits, and engine errors across all three thin wrappers, persisted via the atomic flushMetrics pattern.",
      "Structured logger + LLM metrics infrastructure wired into the deep-chapter runtime: level/traceId/NOVEL_LOG_JSON logging, per-call LLM metrics (collectLLMMetric) with streamChat as the single ingestion point, plus an automatic flush safety valve (buffer>=500) and explicit run-end flush.",
      "Restored the consistency_mechanical review type into the Consistency P0 gate set so mechanical findings are routed through the fixed Consistency>Anti-AI>Quality priority rather than silently falling to a quality gate.",
    ],
    zh: [
      "新增确定性（无 LLM）连续性引擎：休眠/缺席/超期/未回收伏笔与死亡角色状态检测在语义审查前运行，采用对齐 ADR-30 的 3 级严重度方案（critical/warning/info）。机械 critical 发现经 Consistency P0 门控阻断章节通过，绝不等待 LLM。",
      "连续性引擎双层挂载：生成层非阻断 bullet 提醒（守 Draft-first）+ 审查层机械预检在 critical 发现时短路 LLM 审查。",
      "机械 critical 发现走 manualHandoff（复用 emotion-ledger 熔断路径）而非进入 Q4 fix-loop，使一致性破坏以显式人工交接而非自动重写呈现。",
      "Override 持久化 store 配 6 值 reasonCode 枚举（intentional_death / intentional_absence / intentional_flashback / posthumous_by_design / false_positive / state_layer_fix），被驳回的发现携带可审计理由而非自由文本。",
      "一致性 metric 数据流：collectContinuityMetric 在三处薄包装记录执行耗时、各级别发现数、data-gap 数、override 命中、短路命中、引擎错误，经原子 flushMetrics 模式持久化。",
      "结构化 logger + LLM metrics 基础设施接入 deep-chapter 运行时：level/traceId/NOVEL_LOG_JSON 日志、按调用 LLM 指标（collectLLMMetric，streamChat 单点录入）+ 自动 flush 安全阀（buffer>=500）+ 显式 run-end flush。",
      "恢复 consistency_mechanical 审查类型进 Consistency P0 门控集合，使机械发现按固定 Consistency>Anti-AI>Quality 优先级路由，而非静默落到 quality 门控。",
    ],
  },
}

const TWO_POINT_THREE_TWO_CHANGELOG: ChangelogEntry = {
  version: "2.3.2",
  date: "2026-07-13",
  highlights: {
    en: [
      "Full-project CWE-532 sanitization sweep: every LLM/provider transport error path now strips provider endpoint URLs and Bearer/api-key credentials before the message reaches any user-visible surface (Activity panel, chat stream, rewrite banner, save status, toast). Raw messages stay in the console for diagnostics only.",
      "Path-traversal guard on the ingest write path: executeIngestWrites now routes every emitted file path through the isSafeIngestPath guard (reusing parseFileBlocks), closing the single site that bypassed the line-level parser with a raw FILE_BLOCK_REGEX match.",
      "Split the runDeepChapterGeneration god function (685 lines) into an orchestrator plus six independent stage functions, with early-return handoffs carried via a manualHandoff flag so the partial-recovery state stays constructed at the orchestrator layer (no mirror drift).",
      "Consolidated 13 same-name helpers (isRequestCancelledError / isTransportInactivityError / defaultLlmCall / getUniqueOutlinePath / yamlEscape / pad / toErrorMessage / validateSeverity / uniqueNonEmpty / formatStageThinking / ensureString / flattenMdFilesBase / snapshotMarkdownPath) into their host modules, eliminating the twin-mirror recurrence where single-site fixes silently missed identically-shaped copies.",
      "Added a 2x re-ask retry loop to the review chunk parser: when the LLM returns markdown instead of the JSON review result, it now re-prompts (up to 2 retries with 2s delay) instead of throwing straight to the fix-loop death cycle.",
      "Restored the buildDecisionGates P0 consistency gate: the overall-warning verdict now includes gates.consistency.verdict==='warning' alongside anti-AI and quality, matching the fixed Consistency>Anti-AI>Quality priority.",
      "Parallelized serial await loops on independent data items (autoIngest embeddings, analyzePreviousChapters wiki reads) via Promise.all with per-item try/catch and index-mapped ordering, cutting per-chapter latency from N round-trips to one batch.",
      "Fixed contentMatchesTargetLanguage frontmatter mis-strip: the language detector no longer slices off the title and first paragraph of frontmatter-less pages by matching a body horizontal rule, and now samples a bounded 2000-char window before stripping code/math blocks.",
    ],
    zh: [
      "全项目 CWE-532 脱敏：所有 LLM/提供商传输错误路径在消息进入用户可见界面（活动面板、聊天流、重写横幅、保存状态、toast）前剥离提供商端点 URL 与 Bearer/api-key 凭据。原始消息仅留在控制台用于诊断。",
      "摄取写入路径遍历守卫：executeIngestWrites 现将每个产出文件路径经 isSafeIngestPath 守卫路由（复用 parseFileBlocks），关闭唯一一处用裸 FILE_BLOCK_REGEX 绕过行级解析器的站点。",
      "拆分 runDeepChapterGeneration 巨函数（685 行）为编排器 + 六个独立阶段函数，提前返回用 manualHandoff 标志位回传，partial 恢复状态留在编排器层构造（无镜像漂移）。",
      "合并 13 个同名 helper（isRequestCancelledError / isTransportInactivityError / defaultLlmCall / getUniqueOutlinePath / yamlEscape / pad / toErrorMessage / validateSeverity / uniqueNonEmpty / formatStageThinking / ensureString / flattenMdFilesBase / snapshotMarkdownPath）到各自宿主模块，消除单点修复静默漏掉同形副本的孪生镜像复发。",
      "审查块解析器加 2 次 re-ask 重试：LLM 返回 markdown 而非 JSON 审查结果时，现会重新提示（最多 2 次重试 + 2s 延迟），而非直接抛进 fix-loop 死循环。",
      "恢复 buildDecisionGates 的 P0 一致性门控：overall-warning 判定现包含 gates.consistency.verdict==='warning'（与 anti-AI/quality 并列），对齐 Consistency>Anti-AI>Quality 固定优先级。",
      "独立数据项的串行 await 循环并行化（autoIngest embeddings、analyzePreviousChapters wiki 读取）改 Promise.all + 逐项 try/catch + index 保序，每章延迟从 N 轮往返降为 1 批。",
      "修复 contentMatchesTargetLanguage 的 frontmatter 误剥离：语言检测不再因匹配正文分隔线而切掉无 frontmatter 页面的标题与首段，并改为先取 2000 字有界样本再剥离代码/数学块。",
    ],
  },
}

const TWO_POINT_THREE_ONE_CHANGELOG: ChangelogEntry = {
  version: "2.3.1",
  date: "2026-07-08",
  highlights: {
    en: [
      "Fixed critical regression: the 6-dimension review (thrill/pacing/character/continuity/pull) now fires at all three review points in deep chapter generation — stage-4 initial, stage-5.5 resume, and stage-5 post-repair — not just stage-4. Repaired chapters no longer re-review with dimension findings silently dropped.",
      "Restored the fold_rebuildable contract: fullwidth-colon changes (新增：/角色名：) now parse identically on the live ingest and rebuild paths; validUntil supersession/negation is monotonic and order-independent; temporal consistency check matches alias-mapped subjects against active facts.",
      "Fixed subplot_board projection category: reclassified from fold_rebuildable to single_snapshot_idempotent to reflect the empty-store commit (no snapshot field wired yet).",
      "Context engine hardening: deduplicated the ~500-snapshot reload on repeated context builds via an mtime-keyed cache; fixed a Set mutation during graph candidate iteration; deleted 11 dead @ts-expect-error read helpers.",
      "Wired computeContextBudget adaptive scaling onto the read path — chapter 500 context builds now compress index/page budgets per the chapter-adaptive curve (was dead code); added a MIN_INDEX_FLOOR so tiny context windows still list page titles.",
      "Sidecar crash-safety: inspiration entries now use atomic write (writeFileAtomic) and degrade to empty on parse failure, matching sibling projections; extracted a shared createAtomicJsonStore helper deduping the save/load boilerplate.",
      "Wired the subplot-board and resource-ledger renderers into the context engine protected tier (were exported+tested but never imported).",
    ],
    zh: [
      "修复关键回归：深度章节生成的 6 维审查（爽感/节奏/角色/连贯/拉力）现已在三个复审点全部触发——stage-4 初审、stage-5.5 恢复复审、stage-5 返修后复审，不再只在 stage-4 触发。返修章节不再静默丢失维度发现。",
      "恢复 fold_rebuildable 契约：全角冒号变更（新增：/角色名：）在实时摄取与重建路径解析一致；validUntil 的 supersession/negation 单调收敛、与调用顺序无关；时间一致性检查用别名映射匹配活跃事实的主体。",
      "修复 subplot_board 投影分类：从 fold_rebuildable 改为 single_snapshot_idempotent，反映空存储提交的真实语义（快照子情节字段尚未接线）。",
      "上下文引擎加固：通过 mtime 键缓存去重重复上下文构建时的约 500 次快照重载；修复图候选节点迭代时的 Set 突变；删除 11 个死代码 @ts-expect-error read 辅助函数。",
      "将 computeContextBudget 自适应缩放接入读取路径——第 500 章的上下文构建现按章节自适应曲线压缩索引/页面预算（原为死代码）；新增 MIN_INDEX_FLOOR 让极小上下文窗口仍能列出页面标题。",
      "Sidecar 崩溃安全：灵感条目改用原子写（writeFileAtomic）并在解析失败时降级为空，与兄弟投影一致；抽取共享 createAtomicJsonStore 辅助函数去重 save/load 样板。",
      "将 subplot-board 与 resource-ledger 渲染器接入上下文引擎 protected 层（原先已导出+测试但从未被引用）。",
    ],
  },
}

const TWO_POINT_THREE_ZERO_CHANGELOG: ChangelogEntry = {
  version: "2.3.0",
  date: "2026-07-06",
  highlights: {
    en: [
      "Added identity resolution: characters referenced by alias now resolve to their canonical name across the writing mainchain via matchesAnyAlias, keeping character state and cognition consistent regardless of which name the LLM uses.",
      "Added a protected/compressible SourceTier layering to the context engine: canon-current state (character/emotional/subplot/resource) is protected from compression, while summaries and history compress adaptively under the token budget.",
      "Added chapter-number-adaptive context budget: the context pack scales with novel length so early chapters get full context and later chapters compress per a decay curve.",
      "Added a pure temporal-memory view: supersession chains and negation pairs are derived from the committed episode log via factsFromCommittedSnapshots/getFactsAt — no second truth source, no persistence layer.",
      "Added three structured projection fields: EmotionalArcs, SubplotBoard, and ResourceLedger, each with a fold-from-snapshot contract and a context renderer.",
      "Added a TransportError discriminated union so CLI-subprocess transport failures (timeout/crash/encoding) surface as typed errors instead of generic strings.",
      "Added three sidecar enhancements: a P14-style writing-style profile, multi-endpoint inspiration capture, and a deferred-trigger workflow for background inspiration ingestion.",
    ],
    zh: [
      "新增身份解析：通过 matchesAnyAlias 将别名引用的角色解析为规范名，贯穿写作主链，无论 LLM 用哪个名字都保持角色状态与认知一致。",
      "上下文引擎新增 protected/compressible SourceTier 分层：当前正典状态（角色/情感/子情节/资源）受保护不被压缩，摘要与历史在 token 预算下自适应压缩。",
      "新增章节号自适应上下文预算：上下文包随小说篇幅缩放，早期章节获完整上下文，后期章节按衰减曲线压缩。",
      "新增纯 temporal-memory 视图：supersession 链与 negation 对由已提交剧集日志经 factsFromCommittedSnapshots/getFactsAt 派生——无第二真源、无持久层。",
      "新增三个结构化投影字段：EmotionalArcs、SubplotBoard、ResourceLedger，各有 fold-from-snapshot 契约与上下文渲染器。",
      "新增 TransportError 判别联合类型：CLI 子进程传输失败（超时/崩溃/编码）以类型化错误呈现，而非泛型字符串。",
      "新增三项 sidecar 增强：P14 风格仿写画像、多端灵感捕获、后台灵感摄取的延迟触发工作流。",
    ],
  },
}

const TWO_POINT_TWO_TWENTY_FOUR_CHANGELOG: ChangelogEntry = {
  version: "2.2.24",
  date: "2026-06-26",
  highlights: {
    en: [
      "Outline generator UI overhaul: button-based category selection with male/female channel toggle, multi-select tags, and word-count buttons.",
      "Added complete genre classification system: 15 categories each for male and female channels, ~435 sub-tags total.",
      "Added custom tag management: create, persist, and delete custom outline tags.",
      "Added model selector dropdowns to outline generation dialog, refine dialog, and AI outline chat panel — no longer falls back to global llmConfig; prompts user to select a model if none chosen.",
      "Model selection auto-saves and restores on next launch, shared across all three outline scenarios.",
      "Fixed error messages displaying full API response body: now extracts JSON error fields and truncates to 500 chars.",
      "Fixed outline generator not showing errors due to stale task state synchronization.",
      "Added V2 prompt template incorporating channel, category, and style tags into generation prompts.",
      "Added one-click copy for error details including context (channel, category, tags, model, timestamp).",
      "AI outline chat panel footer layout: dock controls on the left, model selector on the right.",
    ],
    zh: [
      "大纲生成器界面重构：下拉框选择改为按钮式分类选择，新增男频/女频频道切换、多选标签、字数规模按钮组。",
      "新增完整分类标签体系：男频 15 个分类、女频 15 个分类，共计约 435 个子标签。",
      "新增自定义标签管理：支持创建、持久化存储和删除自定义大纲标签。",
      "大纲生成对话框、细化生成对话框、AI大纲会话面板新增模型选择下拉框，不再回退到全局 llmConfig，未选择模型时提示用户选择。",
      "模型选择自动保存，下次启动自动恢复，三个场景共享同一选择。",
      "修复错误消息显示完整 API 响应体的问题：现在自动提取 JSON 错误字段并截断到 500 字符。",
      "修复大纲生成器因任务状态同步问题导致错误信息不显示的问题。",
      "新增 V2 提示词模板，将频道、分类、风格标签纳入生成提示语。",
      "新增错误详情一键复制功能，包含频道、分类、标签、模型、时间等上下文信息。",
      "AI 大纲会话面板底部布局调整：停靠图标在最左侧，模型选择下拉框在最右侧。",
    ],
  },
}

const TWO_POINT_TWO_TWENTY_THREE_CHANGELOG: ChangelogEntry = {
  version: "2.2.23",
  date: "2026-06-25",
  highlights: {
    en: [
      "Fixed 'Follow AI Chat Model' checkbox missing and not following: restored checkbox UI and corrected model fallback priority to aiChatModel > defaultLlmModel.",
      "Fixed DeepSeek model stalling during writing: auto reasoning mode no longer forced to high; novel generation uses config.reasoning directly.",
      "Fixed scrollbar jumping when deleting text in chapter editor: preserves scroll position during textarea resize.",
      "Fixed backup import losing chapters and outlines after QMBOOK folder deleted: unified wiki directory name in exports, auto-migrates wiki→QM on import, restores project names from backup.",
      "Added 'Restore Data' button on welcome/login page for one-click backup import.",
      "Fixed inability to delete ghost entries (missing files): moveFileToTrash handles missing files gracefully instead of aborting.",
      "Fixed nested path virtualization bug causing delete failures on files in nested QM directories (wiki/outlines/1/wiki/chapters/...): now replaces all legacy path segments, not just the last one.",
    ],
    zh: [
      "修复「跟随 AI 会话模型」复选框丢失且无法跟随的问题：恢复复选框 UI，修正模型回退优先级为 aiChatModel > defaultLlmModel。",
      "修复 DeepSeek 模型写作卡顿问题：auto 推理模式不再强制转为 high，小说写作直接使用 config.reasoning。",
      "修复章节编辑器删除文字时滚动条跳动：在 textarea resize 前后保存并恢复滚动容器位置。",
      "修复重装系统后备份导入丢失章节和大纲的问题：导出统一以 wiki 目录名打包，导入后自动迁移 wiki→QM、.llm-wiki→.qmai，恢复项目原始名称。",
      "登录/欢迎页新增「恢复数据」按钮，支持一键导入备份。",
      "修复文件已丢失的幽灵条目无法删除的问题：moveFileToTrash 容错处理不存在的文件，不中断删除流程。",
      "修复嵌套路径虚拟化导致部分条目无法删除的问题：路径中包含多个 wiki/QM 段时全量替换，而非仅替换最后一个。",
    ],
  },
}

const TWO_POINT_TWO_TWENTY_TWO_CHANGELOG: ChangelogEntry = {
  version: "2.2.22",
  date: "2026-06-23",
  highlights: {
    en: [
      "In Settings > LLM Models, fetching models and selecting multiple models now tests all selected models sequentially when clicking Test Model.",
      "Model testing shows live progress: Testing model (1/N): model-name.",
      "When all selected models pass, a success summary is shown.",
      "When some models fail, failed models are listed with errors and highlighted in red.",
      "If no models are selected, Test Model falls back to testing the current model input.",
      "Custom model card model input is now tag-based: each selected model appears as a removable chip.",
      "Fetched model tags sync into the custom model card input automatically.",
      "The model input supports typing and pressing Enter or clicking Add; multiple models can be added at once with comma separation.",
      "Selected models in the custom model card are persisted and no longer cleared when fetching models again.",
      "Failed model tags are shown in red with a red border for easy removal.",
      "Added a Retry Failed Models button to re-test only the failed models.",
    ],
    zh: [
      "在「设置 - LLM 模型」页面中，拉取模型列表并勾选多个模型后，点击「测试模型」按钮将依次测试所有已选模型。",
      "测试过程中显示实时进度：正在测试模型 (1/N): model-name。",
      "全部模型测试成功后提示「N 个模型全部测试成功」。",
      "部分模型失败时提示「success/total 个模型测试成功，失败：model: error」，失败模型以红色标签展示。",
      "未选择任何模型时保持原有行为，仅测试输入框中的当前模型。",
      "自定义模型卡片「模型」输入框改为标签式输入：每个已选模型是一个带「×」的小标签，点击即可移除。",
      "拉取模型后选中模型标签，模型名称会自动同步到「模型」输入框中并显示为标签。",
      "输入框内可直接输入模型名称，按回车或点击「添加」进入已选列表；多个模型可用逗号分隔批量添加。",
      "已选模型不再以文本形式回填输入框，输入框保持空白供用户输入新模型。",
      "已选模型列表不再因重新拉取模型而被清空，仅用户手动清空时才会清除。",
      "自定义模型卡片的「测试模型」按钮改为测试已选模型列表；无已选模型时仍测试输入框内容。",
      "批量测试部分失败时，失败模型以红色标签展示，并新增「重试失败模型」按钮，仅对失败模型重新测试。",
      "自定义模型卡片输入框内的失败模型标签会高亮变红并带红框，用户可直接点击「×」移除；移除后该模型会从失败列表中清除。",
    ],
  },
}

const TWO_POINT_TWO_TWENTY_CHANGELOG: ChangelogEntry = {
  version: "2.2.20",
  date: "2026-06-23",
  highlights: {
    en: [
      "Added book-style extraction in the Dismantling Library: one-click analysis of novel writing style with 9-dimension metrics, style constitution, and original text samples.",
      "Added default model setting in LLM configuration for background AI tasks (memory extraction, character recognition, etc.).",
      "Added batch select/clear buttons for custom model list management.",
      "Added quick help links to core features (chapters, outlines, graph, memory, soul, settings).",
      "Optimized character recognition to use LLM-only extraction, eliminating invalid regex-generated candidate names.",
      "Unified AI operation model invocation: user-triggered AI actions now follow default/chat model settings.",
      "Refactored outline toolbar into a shared component, fixing disappearing toolbar entries after tab switches.",
      "Optimized token consumption across AI chat and review center workflows.",
      "Improved Chinese diagnostics for reasoning-only responses and input-length limit errors.",
      "Fixed custom model input field being read-only; now editable with add button and working test connectivity.",
      "Fixed recent chapter body reading: now reads N chapters of body text instead of only summaries.",
      "Fixed long chapter generation exceeding model input limits with automatic context trimming and retry.",
      "Fixed review stage character recognition: re-matches character auras from draft text before review.",
      "Fixed wiki relative-path image preview not displaying on first load.",
      "Enhanced character consistency checking in deep chapter generation with memory library validation.",
      "Improved Windows updater: waits for old executable release before copying new version.",
    ],
    zh: [
      "新增拆书库作品文风提取功能，支持一键提取小说写作风格，输出9维文风指标和风格宪法。",
      "新增默认模型设置项，用于AI会话提取记忆、提取角色等后台自动任务。",
      "自定义模型拉取区域新增「全选」「清空」按钮，支持批量管理。",
      "为核心功能新增使用说明快捷入口，可快速查看操作指引。",
      "角色识别改为仅通过LLM提取真实人名，大幅提升识别准确率。",
      "用户主动触发的AI操作统一跟随默认模型/AI会话当前模型调用。",
      "大纲工具栏重构为共享组件，修复切页后入口消失的问题。",
      "全链路Token消耗优化，降低模型调用成本。",
      "优化reasoning-only回复和输入长度超限错误的中文提示文案。",
      "修复自定义模型输入框只读问题，改为可编辑并新增添加按钮。",
      "修复最近章节正文读取不完整，改为读取正文片段并结合摘要。",
      "修复长章节生成上下文超限问题，发送前按模型预算自动裁剪。",
      "修复审查阶段无法识别初稿中新出现角色的问题。",
      "修复项目Wiki内相对路径图片首次预览可能不显示的问题。",
      "增强深度章节生成的角色一致性校验能力，严控人设崩塌。",
      "优化Windows更新安装流程，减少文件占用导致的更新失败。",
    ],
  },
}

const TWO_POINT_TWO_NINETEEN_CHANGELOG: ChangelogEntry = {
  version: "2.2.19",
  date: "2026-06-20",
  highlights: {
    en: [
      "Fixed the Dismantling Library character picker not appearing after chapter analysis when some models return Chinese field names.",
      "Character recognition now accepts Chinese keys such as 角色名, 重要度, 类别, 章节索引, and 别名 while keeping the existing English JSON format.",
      "Added regression coverage for Chinese-key character recognition responses.",
    ],
    zh: [
      "修复拆书库选择分析章节后，部分模型返回中文字段名导致角色列表为空、角色人物选择弹窗不弹出的问题。",
      "角色识别结果现在兼容“角色名、重要度、类别、章节索引、别名”等中文字段，并保留原有英文 JSON 字段兼容。",
      "新增角色识别回归测试，覆盖中文字段返回格式，防止同类问题再次出现。",
    ],
  },
}

const TWO_POINT_TWO_EIGHTEEN_CHANGELOG: ChangelogEntry = {
  version: "2.2.18",
  date: "2026-06-19",
  highlights: {
    en: [
      "Added global font-size control (Settings > Interface, 85%-130% slider).",
      "Added seamless auto-refresh after AI generation or file save.",
      "Added data management: export/import to fully restore all content including AI conversations, outlines, models, and memory before OS reinstall.",
      "Optimized and fixed various minor issues.",
    ],
    zh: [
      "新增全局界面字号调节（设置 → 界面，支持 85%-130%）",
      "新增 AI 生成/保存文件后的无感自动刷新",
      "新增数据管理功能，如果要装系统可以使用导出数据功能，之后再使用导入数据功能，可完美恢复所有内容，包括AI会话，AI大纲，模型,记忆等",
      "优化修复一些其他小问题",
    ],
  },
}

const TWO_POINT_TWO_SEVENTEEN_CHANGELOG: ChangelogEntry = {
  version: "2.2.17",
  date: "2026-06-18",
  highlights: {
    en: [
      "Added full data export and import: back up model configs, AI conversations, novel content, outlines, memory libraries, and knowledge graphs before reinstalling the OS.",
      "Added global font-size control in Settings > Interface, with a slider from 85% to 130% and quick preset buttons.",
      "Added automatic UI refresh after generation so new chapters and outlines appear immediately without manual reopening.",
      "Improved multi-model selection so AI Chat and novel task models can use any saved custom model independently.",
      "Fixed various issues reported in the Dismantling Library beta and model configuration flows.",
    ],
    zh: [
      "新增数据导出导入功能：可在重装系统前备份模型配置、AI 会话、小说内容、大纲、记忆库和知识图谱，并在导入后恢复完整状态。",
      "新增全局字号调节：在设置-界面中可通过滑块将界面缩放至 85%-130%，并提供快捷档位按钮。",
      "新增生成结束自动刷新：章节或大纲生成完成后自动刷新项目状态，无需手动重新打开。",
      "优化多模型选择：AI 会话与小说写作任务可独立选择任意已保存的自定义模型。",
      "修复拆书测试版与模型配置流程中反馈的若干问题。",
    ],
  },
}

const TWO_POINT_TWO_SIXTEEN_CHANGELOG: ChangelogEntry = {
  version: "2.2.16",
  date: "2026-06-18",
  highlights: {
    en: [
      "Added support for multiple custom LLM models and fixed related model configuration issues.",
      "Added the Dismantling Library beta feature: import TXT novels to extract characters and add them to custom souls.",
      "Fixed AI Chat sometimes deviating from the outline; it now always reads the full outline content before generating.",
      "Fixed various other issues.",
    ],
    zh: [
      "LLM 模型增加多个自定义模型添加，修复模型等其他内容。",
      "增加拆书测试版功能，导入 txt 小说文档可以提取小说角色加入到自定义灵魂当中。",
      "AI 会话有时会脱离大纲，已修复当前问题，每次都会强制读取大纲内容。",
      "修复一些其他问题。",
    ],
  },
}

const TWO_POINT_TWO_FOURTEEN_CHANGELOG: ChangelogEntry = {
  version: "2.2.14",
  date: "2026-06-13",
  highlights: {
    en: [
      "Fixed Issue #10: AI-modified chapters no longer fail with 'missing frontmatter, write-back stopped' error; now automatically inherits original frontmatter and tolerates code fences and missing titles.",
      "Fixed Issue #9: 'Continue Next Chapter' no longer regenerates Chapter 1; prompt mentions of 'opening/first chapter' no longer hijack target chapter to 1; session remembers just-generated unsaved chapter numbers.",
      "Fixed Issue #6: Outline refinement logic unified to check directory for .md files; updated hasOutlineForRefinement from search-based to direct filesystem check.",
      "Fixed Issue #8: Added per-chapter word-count target control in settings; chapter generation, expansion threshold, and 'Continue Next Chapter' prompts now follow configured target.",
      "Enhanced de-AI rules with Chinese novel adaptation notes: preserve character voice, dialogue edges, narrative rhythm, and necessary pauses; don't apply non-fiction article rules to delete adverbs or compress to fixed word count.",
    ],
    zh: [
      "修复 Issue #10：AI 修改章节时不再报错\"返回内容缺少 frontmatter，已停止写回\"，现在自动沿用原章节 frontmatter，并容错代码围栏与缺失标题。",
      "修复 Issue #9：\"继续生成下一章\"不再重复生成第一章；提示词中顺带出现的\"开篇/第一章\"字样不再把目标章节劫持为第1章；本会话记住刚生成、尚未保存的章节号。",
      "修复 Issue #6：大纲细化生成逻辑统一按目录是否已有 .md 文件判断；hasOutlineForRefinement 从基于搜索改为直接文件系统检查。",
      "修复 Issue #8：新增\"单章目标字数\"设置，章节生成、扩写阈值和\"继续生成下一章\"提示词都按设置目标执行。",
      "增强去AI味规则的中文小说适配说明：保留角色声线、对白毛边、叙事节奏和必要停顿；不要按非虚构文章规则硬删副词或压缩到固定字数。",
    ],
  },
}

const TWO_POINT_TWO_THIRTEEN_CHANGELOG: ChangelogEntry = {
  version: "2.2.13",
  date: "2026-06-11",
  highlights: {
    en: [
      "Added De-AI Skill customization system in Soul to Project Soul with editable rules, reset button, and global application.",
      "Upgraded de-AI rules by integrating Stop Slop, AI Flavor Remover, and Writing Humanizer best practices with 50+ banned words, 5 core methods, and 10-item checklist.",
      "Added Stage 0: Previous Context Analysis that reads full text of previous 3 chapters and performs deep AI analysis before deep-thinking generation.",
      "Added Alibaba Cloud DashScope vector model support (tongyi-embedding-vision-plus/flash-2026-03-06).",
      "Fixed outline refinement showing no available outline despite outline files being listed.",
      "Fixed chapter list sorting (now correctly displays Chapter 1, 2, ..., 10, 20).",
      "Fixed Stage 4: AI Review timeout issues by extending timeout from 2 to 5 minutes, adding auto-retry (max 2 times), and enabling streaming output.",
      "Fixed Cannot read properties of undefined error in review stage with exception protection.",
      "Fixed new/switched AI chat displaying previous chat thinking content by clearing streaming state on each switch.",
      "Optimized context memory: previous chapter ending now extracts body content correctly (removes frontmatter) and increases from 10 to 30 lines (max 1200 chars); recent chapter summaries increased from 500 to 800 chars.",
      "Renamed Deep Chapter Generation to Deep Thinking and Edit Mode to Normal Mode and Edit Chapter for clearer functionality.",
      "Deep Thinking and Normal Mode now mutually exclusive; Normal Mode allows regular chat without deep-thinking flow.",
    ],
    zh: [
      "新增去AI味Skill自定义系统，在灵魂到项目灵魂中编辑规则、重置为默认、全局应用到所有去AI味功能。",
      "升级去AI味规则，整合Stop Slop、AI Flavor Remover、Writing Humanizer最佳实践，新增50+个禁用词汇、5大核心方法、10项检查清单。",
      "新增阶段0前情分析，深度思考生成章节前强制读取前3章完整正文并进行AI深度分析。",
      "新增阿里百炼DashScope向量模型支持（tongyi-embedding-vision-plus/flash-2026-03-06）。",
      "修复大纲细化生成提示当前项目还没有可用大纲，但界面却显示大纲文件列表的矛盾问题。",
      "修复大纲列表章节排序问题，现在按数字顺序正确排列（第1章到第2章到第10章到第20章）。",
      "修复AI会话深度思考阶段4AI审稿容易中断或长时间卡住的问题，超时从2分钟延长到5分钟，新增自动重试（最多2次），实时流式输出。",
      "修复审稿失败时可能出现的Cannot read properties of undefined报错，增加异常保护。",
      "修复新建或切换AI会话时，新会话会显示上一个会话思考内容的问题，现在每次切换都会清空流式输出状态。",
      "优化上下文记忆：上一章结尾正确提取正文内容（去除frontmatter）并从10行增加到30行（最多1200字符）；近期章节摘要从500字符增加到800字符。",
      "功能命名优化：深度章节生成改名为深度思考，修改模式改名为普通模式和编辑章节，功能更清晰。",
      "深度思考和普通模式互斥切换，普通模式下可以正常对话不走深度思考流程。",
    ],
  },
}

const TWO_POINT_TWO_NINE_CHANGELOG: ChangelogEntry = {
  version: "2.2.9",
  date: "2026-06-09",
  highlights: {
    en: [
      "Fixed AI Outline deep-thinking generation so missing outline context or conversation fields no longer crash the panel with undefined length/trim errors.",
    ],
    zh: [
      "修复 AI 大纲深度思考生成报错：当大纲上下文或对话字段缺失时，不会再因为 undefined 的 length / trim 报错而直接生成失败。",
    ],
  },
}

const TWO_POINT_TWO_EIGHT_CHANGELOG: ChangelogEntry = {
  version: "2.2.8",
  date: "2026-06-08",
  highlights: {
    en: [
      "Added local-environment LLM defaults so an unset model can be filled from VITE_QMAI_LLM_API_KEY, VITE_QMAI_LLM_ENDPOINT, and VITE_QMAI_LLM_MODEL.",
      "Fixed review history chapter attribution so selected chapter file names take priority over stale frontmatter chapter numbers.",
      "Improved review streaming updates to reduce UI refresh pressure without reducing the amount of memory material used for review.",
      "Improved graph cache isolation so different projects no longer share retrieval graphs when they have the same data version.",
      "Added a 3,500-character cap to the deep chapter stage 3 draft prompt so models are asked to keep the first draft under control before later review stages.",
      "Raised the deep chapter length-rewrite failure ceiling to 6,000 characters; after four failed compression attempts, usable long chapters continue to review instead of stopping solely because they are above 3,200 characters.",
    ],
    zh: [
      "修复未单独设置模型时的默认模型读取问题，现在会优先回退到本地环境变量中的模型配置。",
      "修复审查历史的章节归属问题，优先使用当前选中的章节文件名而不是旧 frontmatter 章节号。",
      "优化审查流式更新，减少界面频繁刷新带来的压力，同时保留完整审查上下文。",
      "优化图谱缓存隔离，不同项目即使 dataVersion 相同也不会共用检索图谱。",
      "深度章节第 3 阶段新增 3500 字草稿提示上限，先在初稿阶段抑制模型失控扩写。",
      "深度章节长度重写失败上限提升到 6000 字，连续压缩失败时可保留可用长稿继续审查。",
    ],
  },
}

const TWO_POINT_TWO_SEVEN_CHANGELOG: ChangelogEntry = {
  version: "2.2.7",
  date: "2026-06-06",
  highlights: {
    en: [
      "Hidden the Dismantling Library UI for 2.2.7 and disabled dismantling-structure injection in AI Chat so the feature is fully out of the visible writing flow for now.",
      "Removed the 2.2.6 to 2.2.1 release notes from the in-app changelog list, leaving 2.2.7 as the latest visible 2.2.x entry before 2.2.0.",
      "Fixed AI Chat Continue Unfinished so deep chapter recovery now resumes from a saved stage checkpoint instead of asking the model to guess where to continue.",
      "Deep chapter failures now persist the first interrupted chain, the latest recoverable checkpoint, and the original request, so repeated Continue Unfinished clicks stay anchored to the same task even after later retries fail.",
      "Switching models during Continue Unfinished now still reloads the original interrupted request and resume snapshot before continuing the remaining deep chapter stages.",
      "Fixed immersive chapter editing so typing into a newly inserted paragraph no longer collapses back onto the first line while auto-format saving runs in the background.",
    ],
    zh: [
      "修复沉浸式章节编辑时新段落输入会回跳到首行的问题。",
      "暂时隐藏拆书库界面入口，并停用 AI 会话中的拆书结构注入。",
      "移除软件内 2.2.6 到 2.2.1 的更新日志显示，2.2.x 只保留 2.2.7 与 2.2.0。",
      "修复 AI 会话“继续未完成”偏离原始深度章节任务的问题，恢复时优先读取保存的阶段快照。",
      "深度章节失败时会同时保存原始任务链、最近可恢复快照和原始请求，重复继续时不会越跑越偏。",
      "继续未完成时即使切换模型，也会重新加载原始请求和恢复快照后再继续后续阶段。",
    ],
  },
}

const TWO_POINT_TWO_ZERO_CHANGELOG: ChangelogEntry = {
  version: "2.2.0",
  date: "2026-06-05",
  highlights: {
    en: [
      "Consolidated the recent AI Chat, deep chapter generation, memory import, deletion cleanup, and network resilience fixes into the 2.2.0 release.",
      "Fixed Continue Next Chapter so AI Chat resolves a concrete target chapter number for prompts, context retrieval, chapter goals, timeline positioning, and review calls.",
      "Improved Character Soul matching by using chapter goals, outlines, character states, memory, and cognition context in addition to the latest user request.",
      "Reworked deep chapter length control with a 6,000-character stage-3 safety cap, strict stage-4 optimization to 2,200-3,200 characters, and up to four retries when output remains over 4,000 characters.",
      "Improved Continue Unfinished so failed deep chapter runs preserve and reuse the original request, recoverable stage context, and rebuilt novel context pack.",
      "Extended shared LLM request retry windows and replaced raw request-send/network errors with clearer Chinese explanations.",
      "Kept chapter and outline import memory extraction progress visible in the extraction panel, added cancel-import behavior, and improved source-related memory/entity cleanup after deletion.",
      "Fixed AI Chat stop handling so stopping during thinking or streaming finalizes immediately and ignores late callbacks.",
    ],
    zh: [
      "将近期 AI 会话、深度章节、导入记忆、删除清理和网络稳定性修复整合到 2.2.0。",
      "修复“继续生成下一章”时目标章节号解析错误，确保提示词、上下文、章节目标和时间线都使用正确章节号。",
      "优化 Character Soul 绑定，除最后一句请求外，也会综合章节目标、大纲、角色状态、记忆和认知上下文。",
      "重做深度章节长度控制，第 3 阶段安全上限为 6000 字，第 4 阶段严格优化到 2,200-3,200 字，并允许最多四次重试。",
      "优化“继续未完成”恢复逻辑，失败后会保留原始请求、可恢复阶段上下文和重建后的小说上下文包。",
      "延长共享 LLM 请求重试窗口，并将原始 request-send/network errors 替换为更清晰的中文提示。",
      "保留章节和大纲导入后的记忆提取进度显示，新增取消导入，并完善删除后的来源记忆与实体清理。",
      "修复 AI 会话停止生成不及时的问题，思考阶段和流式阶段都能立即收口。",
    ],
  },
}

const TWO_POINT_ONE_ZERO_CHANGELOG: ChangelogEntry = {
  version: "2.1.0",
  date: "2026-06-05",
  highlights: {
    en: [
      "Added independent Golden Three Chapters constraints for opening, first chapter, and first-three-chapter requests.",
      "Applied Golden Three Chapters rules to both deep chapter generation and ordinary chapter generation.",
      "Optimized Golden Three Chapters output: opening requests generate the first chapter plus directions for chapters two and three, while explicit chapter two or three requests generate only that chapter.",
      "Improved AI Chat dock controls so only one target switch is shown at a time.",
      "Added vertical resizing for AI Chat and AI Outline input boxes.",
      "Fixed AI Chat input resizing limits so the input can expand up to half of the real panel height.",
      "Added chapter file and folder import with automatic chapter-number sorting.",
      "Improved chapter folder import with a pre-scan and memory extraction confirmation.",
      "Added optional chapter memory extraction progress with cancellation during import.",
      "Improved chapter filename wildcard matching for volume and chapter formats.",
      "Lazy-loaded deep chapter generation only when deep mode is enabled.",
      "Cleaned up stale mock assertions so the mocked test suite passes again.",
      "Removed Source Watch and Scheduled Import entries from Settings.",
      "Fixed proxy startup behavior so disabled proxy settings clear inherited proxy environment variables.",
      "Fixed update checks in environments with stale lowercase proxy variables or ALL_PROXY values, and replaced the raw updater error with a clearer Chinese message.",
      "Clarified the deep chapter length limit message for the 4500-character chapter limit.",
      "Fixed deep writing so internal request cancellation after a chapter length cutoff no longer appears as a generation failure.",
      "Fixed AI Review rewrite application so original fragments can still be located when line breaks or spacing differ.",
    ],
    zh: [
      "新增独立的黄金三章开篇约束，覆盖开篇、第一章和前三章请求。",
      "黄金三章规则同时接入深度章节生成和普通章节生成流程。",
      "优化黄金三章输出策略：开篇请求生成第一章正文并附带第二、第三章方向。",
      "明确请求第二章或第三章时，只生成目标章节内容。",
      "优化 AI 会话停靠切换按钮，同一时刻只显示一个停靠目标。",
      "AI 会话与 AI 大纲输入框支持竖向拖拽调整高度。",
      "修复输入框高度上限，最高可扩展到面板实际高度的一半。",
      "新增章节文件与文件夹导入，并自动按章节号排序。",
      "优化章节文件夹导入，导入前先预扫描可章节数量。",
      "新增导入时的记忆提取确认流程，可选择是否提取记忆。",
      "新增导入记忆进度显示，并支持在导入过程中取消。",
      "增强章节文件名匹配，兼容卷、章等更复杂命名格式。",
      "深度章节模块改为按需加载，仅在开启深度模式后初始化。",
      "清理过期 mock 断言，恢复 mock 测试套件可通过状态。",
      "设置页移除 Source Watch 与 Scheduled Import 入口。",
      "修复代理启动行为，禁用代理时会清理继承的代理环境变量。",
      "修复更新检查在异常代理环境下的报错，并改成更清晰的中文提示。",
      "补强 AI 审查改写落地逻辑，换行或空格变化后仍能定位原文片段。",
    ],
  },
}

const TWO_POINT_ZERO_CHANGELOG: ChangelogEntry = {
  version: "2.0.0",
  date: "2026-06-04",
  highlights: {
    en: [
      "Major release: upgraded QMAI from a basic AI writing assistant into a staged novel-writing workflow with planning, generation, review, rewrite, and traceable revision loops.",
      "AI Chat now supports deep chapter generation with context analysis, task brief, draft writing, AI review, revision, final lightweight review, and de-AI polish.",
      "AI Outline now uses staged thinking generation with live progress, outline task briefs, draft generation, self-checking, cleaner saving, and quick generation tools for chapter outlines, characters, factions, abilities, foreshadowing, and locations.",
      "Review Center was rebuilt around staged deep review and six independent professional review workflows.",
      "AI Rewrite now provides multi-change previews, editable generated content, regenerate support, confirm-to-replace behavior, View Change highlighting, Ignore, and Restore Original.",
      "Thinking and model compatibility were improved across OpenAI-compatible endpoints, Responses API, Qwen3 thinking models, custom model diagnostics, Chinese endpoint hints, and model list handling.",
      "Memory and chapter workflows were strengthened with re-extract memory actions, persistent progress after page switching, Memory Center edit/delete controls, and clearer memory-risk warnings.",
      "Interface improvements include AI Chat / AI Outline bottom-right docking, fixed double-scrollbar issues, responsive chapter toolbar actions, clearer thinking panels, and localized review/model-setting text.",
      "Feedback submission now includes a fallback path for networks where the desktop HTTP client fails.",
    ],
    zh: [
      "2.0.0 是一次大的能力升级，QMAI 从基础 AI 写作助手升级为分阶段小说创作工作流。",
      "AI 会话新增深度章节生成流程，覆盖上下文分析、任务书、正文草稿、AI 审查、修订与去 AI 润色。",
      "AI 大纲升级为分阶段思考生成，并支持实时进度、任务书、草稿、自检与更干净的保存。",
      "审查中心围绕多阶段深度审查重建，并加入多种独立的专业审查工作流。",
      "AI Rewrite 提供多处改动预览、可编辑生成内容、重新生成、确认替换、查看变化与恢复原文。",
      "加强 thinking 与模型兼容能力，覆盖 OpenAI 兼容接口、Responses API、Qwen3 thinking 等模型。",
      "强化记忆与章节流程，支持重新提取记忆、跨页面保留进度、记忆中心编辑删除与更清晰的风险提示。",
      "界面体验同步优化，包括 AI 会话和 AI 大纲停靠、滚动条问题、章节工具栏与中文化提示。",
      "反馈提交流程增加兜底通道，桌面端 HTTP 客户端异常时仍可尝试提交。",
    ],
  },
}

const TWO_POINT_TWO_TWENTY_ONE_CHANGELOG: ChangelogEntry = {
  version: "2.2.21",
  date: "2026-06-23",
  highlights: {
    en: [
      "Security hardening: Zip Slip path traversal protection and CORS policy tightening.",
      "Fixed ChatPanel resource leak: abort streaming requests on unmount and conversation deletion.",
      "Fixed race conditions in chat regeneration and deAiMode closure.",
      "Clip server safety: Mutex poison handling, restart count fix, and projectPath validation.",
    ],
    zh: [
      "安全加固：Zip Slip 路径遍历防护和 CORS 策略收紧。",
      "修复 ChatPanel 资源泄漏：卸载和删除会话时 abort 流式请求。",
      "修复聊天重新生成和去AI味模式的竞态条件。",
      "Clip 服务器安全：Mutex poison 处理、重启计数修复、projectPath 校验。",
    ],
  },
}

function isMergedOnePointRelease(version: string): boolean {
  const match = /^1\.0\.(\d+)$/.exec(version)
  if (!match) return false
  const patch = Number(match[1])
  return patch >= 8 && patch <= 32
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "1.0.7",
    date: "2026-06-02",
    highlights: {
      en: [
        "Improved local LLM model handling and startup stability for daily writing sessions.",
        "Refined chapter, memory, and review interactions for a more consistent writing workflow.",
      ],
      zh: [
        "优化本地 LLM 模型处理与启动稳定性，提升日常写作可用性。",
        "继续打磨章节、记忆和审查之间的协同流程。",
      ],
    },
  },
  {
    version: "1.0.0",
    date: "2026-06-01",
    highlights: {
      en: [
        "Fixed stale-memory usage after outline, graph, or snapshot updates.",
        "Snapshot sync now records revision metadata and separates current memory from history.",
      ],
      zh: [
        "修复大纲、图谱或快照更新后仍可能误用旧记忆的问题。",
        "快照同步开始记录修订元数据，并更清楚地区分当前记忆与历史。",
      ],
    },
  },
  {
    version: "0.4.20",
    date: "2026-06-01",
    highlights: {
      en: [
        "AI Chat removed the old final-save/discard draft buttons and kept saving to the chapter library as the draft path.",
        "AI Outline generation added copy and regenerate actions with clearer source references.",
      ],
      zh: [
        "AI 会话移除旧的最终保存与丢弃草稿按钮，保留保存到章节库作为草稿路径。",
        "AI 大纲生成新增复制与重新生成动作，并更清楚地显示引用来源。",
      ],
    },
  },
  {
    version: "0.4.10",
    date: "2026-05-20",
    highlights: {
      en: [
        "Refocused the app as a novel-writing assistant around chapters, outlines, character state, foreshadowing, timelines, and graph views.",
        "Strengthened long-form writing support such as context continuity, chapter memory, and review checks to reduce forgotten details and setting conflicts.",
      ],
      zh: [
        "将产品重新聚焦为小说写作助手，围绕章节、大纲、角色状态、伏笔、时间线和图谱展开。",
        "加强长篇写作支持，提升上下文连续性、章节记忆和审查能力，减少遗忘与设定冲突。",
      ],
    },
  },
]

export function currentVersionChangelog(version: string): ChangelogEntry[] {
  if (version === TWO_POINT_SIX_SEVEN_CHANGELOG.version) return [TWO_POINT_SIX_SEVEN_CHANGELOG]
  if (version === TWO_POINT_SIX_SIX_CHANGELOG.version) return [TWO_POINT_SIX_SIX_CHANGELOG]
  if (version === TWO_POINT_SIX_FIVE_CHANGELOG.version) return [TWO_POINT_SIX_FIVE_CHANGELOG]
  if (version === TWO_POINT_SIX_FOUR_CHANGELOG.version) return [TWO_POINT_SIX_FOUR_CHANGELOG]
  if (version === TWO_POINT_SIX_THREE_CHANGELOG.version) return [TWO_POINT_SIX_THREE_CHANGELOG]
  if (version === TWO_POINT_SIX_TWO_CHANGELOG.version) return [TWO_POINT_SIX_TWO_CHANGELOG]
  if (version === TWO_POINT_SIX_ONE_CHANGELOG.version) return [TWO_POINT_SIX_ONE_CHANGELOG]
  if (version === TWO_POINT_SIX_ZERO_CHANGELOG.version) return [TWO_POINT_SIX_ZERO_CHANGELOG]
  if (version === TWO_POINT_FIVE_ONE_CHANGELOG.version) return [TWO_POINT_FIVE_ONE_CHANGELOG]
  if (version === TWO_POINT_FIVE_ZERO_CHANGELOG.version) return [TWO_POINT_FIVE_ZERO_CHANGELOG]
  if (version === TWO_POINT_FOUR_ELEVEN_CHANGELOG.version) return [TWO_POINT_FOUR_ELEVEN_CHANGELOG]
  if (version === TWO_POINT_FOUR_TEN_CHANGELOG.version) {
    return [TWO_POINT_FOUR_TEN_CHANGELOG]
  }
  if (version === TWO_POINT_FOUR_EIGHT_CHANGELOG.version) {
    return [TWO_POINT_FOUR_EIGHT_CHANGELOG]
  }
  if (version === TWO_POINT_FOUR_SEVEN_CHANGELOG.version) {
    return [TWO_POINT_FOUR_SEVEN_CHANGELOG]
  }
  if (version === TWO_POINT_FOUR_SIX_CHANGELOG.version) return [TWO_POINT_FOUR_SIX_CHANGELOG]
  if (version === TWO_POINT_FOUR_FIVE_CHANGELOG.version) return [TWO_POINT_FOUR_FIVE_CHANGELOG]
  if (version === TWO_POINT_FOUR_FOUR_CHANGELOG.version) return [TWO_POINT_FOUR_FOUR_CHANGELOG]
  if (version === TWO_POINT_FOUR_THREE_CHANGELOG.version) return [TWO_POINT_FOUR_THREE_CHANGELOG]
  if (version === TWO_POINT_FOUR_TWO_CHANGELOG.version) return [TWO_POINT_FOUR_TWO_CHANGELOG]
  if (version === TWO_POINT_FOUR_ONE_CHANGELOG.version) return [TWO_POINT_FOUR_ONE_CHANGELOG]
  if (version === TWO_POINT_FOUR_ZERO_CHANGELOG.version) return [TWO_POINT_FOUR_ZERO_CHANGELOG]
  if (version === TWO_POINT_THREE_TWO_CHANGELOG.version) return [TWO_POINT_THREE_TWO_CHANGELOG]
  if (version === TWO_POINT_THREE_ONE_CHANGELOG.version) return [TWO_POINT_THREE_ONE_CHANGELOG]
  if (version === TWO_POINT_THREE_ZERO_CHANGELOG.version) return [TWO_POINT_THREE_ZERO_CHANGELOG]
  if (version === TWO_POINT_TWO_TWENTY_FOUR_CHANGELOG.version) return [TWO_POINT_TWO_TWENTY_FOUR_CHANGELOG]
  if (version === TWO_POINT_TWO_TWENTY_THREE_CHANGELOG.version) return [TWO_POINT_TWO_TWENTY_THREE_CHANGELOG]
  if (version === TWO_POINT_TWO_TWENTY_TWO_CHANGELOG.version) return [TWO_POINT_TWO_TWENTY_TWO_CHANGELOG]
  if (version === TWO_POINT_TWO_TWENTY_ONE_CHANGELOG.version) return [TWO_POINT_TWO_TWENTY_ONE_CHANGELOG]
  if (version === TWO_POINT_TWO_TWENTY_CHANGELOG.version) return [TWO_POINT_TWO_TWENTY_CHANGELOG]
  if (version === TWO_POINT_TWO_NINETEEN_CHANGELOG.version) return [TWO_POINT_TWO_NINETEEN_CHANGELOG]
  if (version === TWO_POINT_TWO_EIGHTEEN_CHANGELOG.version) return [TWO_POINT_TWO_EIGHTEEN_CHANGELOG]
  if (version === TWO_POINT_TWO_SEVENTEEN_CHANGELOG.version) return [TWO_POINT_TWO_SEVENTEEN_CHANGELOG]
  if (version === TWO_POINT_TWO_SIXTEEN_CHANGELOG.version) return [TWO_POINT_TWO_SIXTEEN_CHANGELOG]
  if (version === TWO_POINT_TWO_FOURTEEN_CHANGELOG.version) return [TWO_POINT_TWO_FOURTEEN_CHANGELOG]
  if (version === TWO_POINT_TWO_THIRTEEN_CHANGELOG.version) return [TWO_POINT_TWO_THIRTEEN_CHANGELOG]
  if (version === TWO_POINT_TWO_TWELVE_CHANGELOG.version) return [TWO_POINT_TWO_TWELVE_CHANGELOG]
  if (version === TWO_POINT_TWO_ELEVEN_CHANGELOG.version) return [TWO_POINT_TWO_ELEVEN_CHANGELOG]
  if (version === TWO_POINT_TWO_TEN_CHANGELOG.version) return [TWO_POINT_TWO_TEN_CHANGELOG]
  if (version === TWO_POINT_TWO_NINE_CHANGELOG.version) return [TWO_POINT_TWO_NINE_CHANGELOG]
  if (version === TWO_POINT_TWO_EIGHT_CHANGELOG.version) return [TWO_POINT_TWO_EIGHT_CHANGELOG]
  if (version === TWO_POINT_TWO_SEVEN_CHANGELOG.version) return [TWO_POINT_TWO_SEVEN_CHANGELOG]
  if (version === TWO_POINT_TWO_ZERO_CHANGELOG.version) return [TWO_POINT_TWO_ZERO_CHANGELOG]
  if (version === TWO_POINT_ONE_ZERO_CHANGELOG.version) return [TWO_POINT_ONE_ZERO_CHANGELOG]
  if (version === TWO_POINT_ZERO_CHANGELOG.version) return [TWO_POINT_ZERO_CHANGELOG]
  if (/^2\.2\.[1-6]$/.test(version)) return []
  if (/^2\.1\.(?:[1-9]|10)$/.test(version)) return []
  if (/^2\.0\.(?:[1-9]|1[0-2])$/.test(version)) return []
  if (isMergedOnePointRelease(version)) return []
  return CHANGELOG.filter((entry) => entry.version === version)
}

export function allChangelog(): ChangelogEntry[] {
  return [
    TWO_POINT_SIX_THREE_CHANGELOG,
    TWO_POINT_SIX_TWO_CHANGELOG,
    TWO_POINT_SIX_ONE_CHANGELOG,
    TWO_POINT_SIX_ZERO_CHANGELOG,
    TWO_POINT_FIVE_ONE_CHANGELOG,
    TWO_POINT_FIVE_ZERO_CHANGELOG,
    TWO_POINT_FOUR_ELEVEN_CHANGELOG,
    TWO_POINT_FOUR_TEN_CHANGELOG,
    TWO_POINT_FOUR_SIX_CHANGELOG,
    TWO_POINT_FOUR_FIVE_CHANGELOG,
    TWO_POINT_FOUR_FOUR_CHANGELOG,
    TWO_POINT_FOUR_THREE_CHANGELOG,
    TWO_POINT_FOUR_TWO_CHANGELOG,
    TWO_POINT_FOUR_ONE_CHANGELOG,
    TWO_POINT_FOUR_ZERO_CHANGELOG,
    TWO_POINT_THREE_TWO_CHANGELOG,
    TWO_POINT_THREE_ONE_CHANGELOG,
    TWO_POINT_THREE_ZERO_CHANGELOG,
    TWO_POINT_TWO_TWENTY_FOUR_CHANGELOG,
    TWO_POINT_TWO_TWENTY_THREE_CHANGELOG,
    TWO_POINT_TWO_TWENTY_TWO_CHANGELOG,
    TWO_POINT_TWO_TWENTY_ONE_CHANGELOG,
    TWO_POINT_TWO_TWENTY_CHANGELOG,
    TWO_POINT_TWO_NINETEEN_CHANGELOG,
    TWO_POINT_TWO_EIGHTEEN_CHANGELOG,
    TWO_POINT_TWO_SEVENTEEN_CHANGELOG,
    TWO_POINT_TWO_SIXTEEN_CHANGELOG,
    TWO_POINT_TWO_FOURTEEN_CHANGELOG,
    TWO_POINT_TWO_THIRTEEN_CHANGELOG,
    TWO_POINT_TWO_TWELVE_CHANGELOG,
    TWO_POINT_TWO_ELEVEN_CHANGELOG,
    TWO_POINT_TWO_TEN_CHANGELOG,
    TWO_POINT_TWO_NINE_CHANGELOG,
    TWO_POINT_TWO_EIGHT_CHANGELOG,
    TWO_POINT_TWO_SEVEN_CHANGELOG,
    TWO_POINT_TWO_ZERO_CHANGELOG,
    TWO_POINT_ONE_ZERO_CHANGELOG,
    TWO_POINT_ZERO_CHANGELOG,
    ...CHANGELOG.filter((entry) => !isMergedOnePointRelease(entry.version)),
  ]
}
