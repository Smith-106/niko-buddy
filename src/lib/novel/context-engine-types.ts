// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT
//
// context-engine-types.ts — M7-3 切片：pack/section 纯类型簇（逐字搬迁，零签名变更）。
//
// 抽出范围（均为纯类型，零运行时）：ContextPack / SourceTimingsMs / ContextEntity /
// BuildContextOptions / RawSnapshotView / SummaryBasics / ProjectionTexts /
// ChapterGoalSection / DerivedStoreSections / RelatedChaptersContextInput /
// RelatedChaptersContextResult / TrimResult。
// context-engine 经 `import type` 回供内部使用，并 `export type` 重出保既有 import 面
// （spec 与 context-data-sources / retrieval / prompt 等消费方不动）。
// 本文件仅 `import type`（编译期擦除，零运行时依赖、无环）；禁加运行时 import（M5 纪律）。

import type { LlmConfig, NovelConfig, EmbeddingConfig, RevisionFeedbackWindowConfig } from "@/stores/wiki-store"
import type { ChapterSnapshot } from "./chapter-ingest"
import type { TemporalFact } from "./temporal-memory"
import type { HardInjectItem, KbGap, DualTrackResult } from "./search-adapter"
import type { ContextUsage } from "@/lib/context-usage"
import type { StyleExemplar } from "./style-exemplars-loader"
import type { RoutingTelemetrySink } from "./context-telemetry"
import type { KbMetrics } from "./kb-observability"
import type { ContextGap } from "./context-engine-gaps"
import type { ContextRawData } from "./context-data-source"
import type { ForeshadowingStore } from "./foreshadowing-tracker"
import type {
  RelatedChaptersInput,
  RelatedChaptersOptions,
  buildRelatedChapters,
  findOverdueForeshadowing,
} from "./related-chapters"

export interface ContextPack {
  task: string
  chapterGoal: string
  outline: string
  recentChapterContents?: string[]
  recentSummaries: string[]
  previousChapterEnding: string
  characterStates: string
  soulDoc: string
  characterAuras: string
  cognitionStates: string
  foreshadowingStates: string
  timeline: string
  relatedSettings: string
  canonRules: string
  writingStyle: string
  searchResults: string
  graphSearchResults: string
  mustDo: string
  mustAvoid: string
  nextChapterAdvice: string
  revisionDirectives: string
  /**
   * IC-02 contract: explicit record of every compressed / truncated
   * source during assembly. Never silently degrade — callers inspect
   * this to know which sources were budget-capped.
   *
   * Optional for backward compatibility: legacy ContextPack constructors
   * (safeBuildChapterContextPack fallback, outline-generation, test
   * fixtures) that don't run through buildContextPack leave this
   * undefined; buildContextPack always populates it.
   */
  gaps?: ContextGap[]
  /**
   * EPIC-001 / ADR-29 / TASK-004: Style Exemplars 正向锚点（用户标记的好
   * 段落）。经 contextPack 注入，de-ai-adapter 单次 pass 消费作正向风格锚点
   * （与 slop 词表反向排除互补）。top-K=3 按 markType 多样性排名，文本截断至
   * 2000 chars。exemplarEnabled=false 或零 exemplar 时为 `[]`（优雅降级）。
   *
   * Optional：legacy constructors / emptyPack 不注入时 undefined（向后兼容）。
   */
  styleExemplars?: StyleExemplar[]
  /**
   * EPIC-003 / ADR-32 / TASK-006: 条件性路由筛选出的当前章节活跃 entity 列表。
   * 按 chapter outline mentions + scene characters 双源匹配 entity-page
   * frontmatter tags（`location:chapter-N` / `relevance:high`）后注入。
   * 零 entity 优雅降级（回退全桶，标 warning），conditionalRoutingEnabled=false
   * 时跳过路由回退全量。
   *
   * Optional：legacy constructors / emptyPack 不注入时 undefined（向后兼容）。
   */
  activeEntities?: ContextEntity[]
  /**
   * EPIC-003 / ADR-32 / TASK-003 (RPC-4 Track B): temporal facts 透传字段。
   * 承载 canon 路径已 load 的章节时间线 temporal facts，供 :393 Track B 接线
   * rerank activeEntities（D7 避免 PAT-G2 孪生重复 load）。可选 + 兼容 null：
   * legacy 构造器不填（IC-02 向后兼容，TASK-002 渲染器本就先查 flag）。
   */
  temporalFacts?: TemporalFact[] | null
  /**
   * C（方案 X 全做 M+）：已失效（曾成立）事实独立分块字段（IC-02 范式，可选 + 兼容 null）。
   * 承载 canon 路径第二查询（include_invalidated=true）召回、打 `former` 标记的时序事实，
   * 由 FIELD_CONFIGS 独立渲染为「曾成立的事实」段。
   *
   * ## P0 硬护栏（成败关键，不得破坏）
   *   - 本字段 **独立分块**渲染，绝不并入 canonRules / 有效 temporal 块；
   *   - `buildMustAvoid` 当前仅接收 (canonRules, timeline, characterStates) 签名，
   *     **不含** formerFacts（禁把失效事实当当前真值"避免违背"——否则语义倒置）；
   *   - 渲染条数上限 FORMER_FACTS_CAP，压缩误导空间；
   *   - former 为空 → undefined → 不渲染该段（字节级不变）。注意：本字段无独立 flag 门控，
   *     字节级等价由“数据空则不渲染”保证（与 temporalFacts 的 flag 门控不同）。
   */
  formerFacts?: TemporalFact[] | null
  /**
   * Wave B: GraphRAG-style community narrative summaries (persisted disk load).
   * Compressible tier — empty when none / disabled. Optional for legacy packs.
   */
  communitySummaries?: string
  /**
   * MIG-002: 世界骨架 prompt 片段（worldBlueprintToPromptFragment 渲染结果）。
   * 迁移模块产物接入主链 — 之前 world-blueprint.json 写了但不进 context pack
   * （孤岛投影）。独立 additive 分块，与 communitySummaries 同款 optional 契约：
   * 空/无 blueprint → undefined → 不渲染（字节级不变）。
   */
  worldBlueprint?: string
  /**
   * MIG-003: 叙事信息差可见性摘要——谁在 storyTime 知道哪些声明
   * （characterView 双时态计算）。防剧透/视角穿帮：生成时知道该角色
   * 视角可见哪些信息。optional：空 store/无声明 → undefined → 不渲染。
   */
  narrativeVisibility?: string
  /**
   * S2a (roadmap R06 / TASK-101 + TASK-102): 四维反查（伏笔/出场/状态/关系）
   * + 伏笔逾期 finding 组合文本，由主装配注入。relatedChaptersEnabled=false 或
   * 空结果为 ""（优雅降级，= 现状行为）。additive 独立字段 — 不并入既有字段，
   * 消费方按需读取（与 styleExemplars 同款 pack 字段消费模式）。
   */
  relatedChapters?: string
  /**
   * Wave 2 (v2.5.0): @引用系统注入段（角色/章节/设定引用 + 用户记忆偏好原文
   * + 定向检索 snippet）。referenceEnabled=false 或零引用时为 ""（优雅降级）。
   * additive 独立字段 — 消费方按需读取（与 relatedChapters 同款模式）。
   */
  references?: string
  /**
   * E-02 (C-9, run-execute-1 双库架构蓝图 capability-kb-retrieval): 硬注入条目
   * （canon 认知轴 getFactsKnownBy + 过程库 visibleInfoFor POV 投影，RRF 前物理隔离）。
   * additive 独立字段 — 不并入 searchResults / canonRules（D6 独立分块）；消费方按需读取。
   * hardInjectEnabled=false / POV 真源未就绪 / 零条目时为 undefined（不渲染该段，字节级不变）。
   */
  hardInject?: HardInjectItem[]
  /**
   * E-02 (C-9): 硬注入预算占用快照（chars/capChars/ratio/truncatedCount）。
   * 超 cap 条目级裁剪 → pack.gaps 推 {type:"truncated", ref:"hardInject", reason:"budget_exceeded"}
   * （IC-02 绝不静默）。
   */
  hardInjectUsage?: DualTrackResult["usage"]
  /**
   * E-02 (C-9): 意图路由缺口（空收藏显式报缺，DA-06 不静默、不用 tech 冒充）。
   * 同步镜像进 pack.gaps（IC-02 主账）。
   */
  kbRoutingGaps?: KbGap[]
  /**
   * Wave 5 (v2.5.0): 上下文用量快照 — 记忆/检索/图谱/正文/其他 字符分配。
   * 预算线直读 computeContextBudget 输出（不重算），记忆段实测 user-memory
   * store preference 字符数。additive：仅 buildContextPack 主装配注入，
   * legacy constructors / emptyPack / build 失败降级时 undefined（不渲染 ring）。
   */
  contextUsage?: ContextUsage
  /**
   * F-011: Voice Preservation 第二层 — voiceStyleGuide 段落。
   * 从 book-analysis BookStyleProfile.voiceStyleGuide 读取，
   * 复用文风蒸馏结果（对话标点风格/段落缩进/引号规范），
   * 渲染为写作指导注入 prompt。
   */
  voiceStyleGuide?: string
  /**
   * T25 (F-19/A-04.4): 技法提示块文本 — T27b 离线编译产物
   * （compileFromCommittedSnapshot）中 injectionPoint="chapter_task_brief"
   * 的块渲染为行文本。additive 独立字段：消费方按需读取（与 relatedChapters
   * 同款 pack 字段消费模式）；编译失败或空产物时不注入（undefined），
   * 不改变任何既有段渲染（VIEW 契约不动）。
   */
  techniqueBlocks?: string
  /**
   * T25 (A-04.4): 三源并行装配计时探针（telemetry 计时点，ms，performance.now 差值）。
   * wiki = 数据源注册器 loadAll；canon = 时序事实源（折叠路径或 T14 canon 图查询）；
   * technique = 技法块编译渲染。仅 buildContextPack 主装配注入；legacy 构造器 /
   * emptyPack / build 失败降级时 undefined。同时经 logger.info 输出一次遥测事件。
   */
  sourceTimingsMs?: SourceTimingsMs
  /**
   * P2-IMP-13 (P2-M4): KB 可观测性 6 指标快照（GOV-OBS-01，缺源显式 N/A 不伪造）。
   * buildContextPackUnlocked 尾部装配：truth_fold_drift ← IMP-06 sampleTruthFoldDrift
   * 采样聚合值；hard_injection_budget_usage ← pack.hardInjectUsage.ratio；
   * gap_report_rate ← pack.gaps 计数；canon_violation_rate / obligation_coverage
   * 显式 N/A（评测 gate P1 轨道）。消费方按需读取 pack.kbMetrics（KB 健康面板）。
   * additive 独立字段 — 不渲染进 prompt（无 FIELD_CONFIGS 条目）；legacy 构造器 /
   * emptyPack 不注入时 undefined。
   */
  kbMetrics?: KbMetrics
  /**
   * P2-IMP-10 (M2): stateDelta additive 字段 — chapter_summaries 投影键控子表文本
   * （近 N 章摘要 + 状态变更行）。由 snapshotDataSource 经 chapterSummariesToContextText
   * 渲染；空 store / 无快照时缺失（undefined）。FIELD_CONFIGS 条目 renderIf 非空才渲染
   * （空数据不渲染，recentSummaries 现路径字节级不动）。
   */
  recentStateDeltas?: string
  /**
   * P1-IMP-13 (A1a): reference-binding 素材用途绑定文本（additive 独立字段）。
   * 由 buildContextPackUnlocked 装配：loadReferenceBindings → bindingsToContextText
   * 渲染本章绑定；零绑定 / 加载失败 → undefined（FIELD_CONFIGS renderIf 非空才渲染，
   * 零绑定字节级不变）。消费方按需读取 pack.referenceBindings。
   */
  referenceBindings?: string
  /**
   * P1-IMP-17: KB-VIEW 外部链条目（通道 B 双源之关键词/域匹配零 LLM 源）。
   * additive 独立段；零命中 → undefined（字节级不变）。消费方按需读取 pack.kbReferences。
   */
  kbReferences?: import("./search-adapter").KbReferenceEntry[]
}

/** T25: 三源计时探针槽位（毫秒）。 */
export interface SourceTimingsMs {
  wiki: number
  canon: number
  technique: number
}

/**
 * EPIC-003 / ADR-32 / TASK-006: 条件性路由筛选出的最小 entity 表示。
 *
 * 复用 graph-adapter entity-page frontmatter 读取（`type` / `title` / `tags`），
 * 不改 entity pages 数据模型（additive frontmatter only，ADR-32 明确禁止新数据层）。
 * Entity 本地最小集定义 — graph-adapter.ts 未导出 Entity 类型（其节点类型是
 * internal SnapshotNode），路由仅需 entity 的 frontmatter 字段子集。
 */
export interface ContextEntity {
  entityId: string
  name: string
  type: string
  tags?: string[]
}

/**
 * ISS-20260709-023 (DC-7) 渐进式 DI: 可选 store 字段注入。传入时直接使用,
 * 缺省回退 useWikiStore.getState() 保持向后兼容。
 */
export interface BuildContextOptions {
  llmConfig?: LlmConfig
  novelConfig?: NovelConfig
  novelMode?: boolean
  revisionFeedbackWindowConfig?: RevisionFeedbackWindowConfig
  embeddingConfig?: EmbeddingConfig
  /** Optional entity names for Quality Foundation entity-boost retrieval. */
  entityNames?: string[]
  /**
   * E-02 (C-5): 主 POV 角色 id（硬注入通道 A 的 POV 过滤输入）。
   * 缺省回退 resolveChapterPovCharacter：P2-IMP-12 起读 ChapterSnapshot.povCharacter
   * （快照编辑面板人工声明）解析；无声明 → null → 通道 A 空，不臆造 POV。
   * 调用方显式传入时优先，激活 POV 过滤注入。
   */
  povCharacter?: string
  /**
   * ISS-20260713-005: ROI 遥测投递 sink。缺省 → 默认 sink（写
   * cognition-state.json 既有 key，与原内联行为一致）；测试可注入
   * 探针 sink 断言样本内容而不触文件。
   */
  telemetrySink?: RoutingTelemetrySink
}

/** 快照视图（ContextRawData.snapshots 非空收窄结果）。 */
export type RawSnapshotView = NonNullable<ContextRawData["snapshots"]>

export interface SummaryBasics {
  recentSummaries: string[]
  recentChapterContents: string[]
  recentStateDeltas: string | undefined
  previousChapterEnding: string
}

export interface ProjectionTexts {
  emotionalText: string
  subplotText: string
  resourceText: string
  emotionLedgerText: string
  auraEvolutionText: string
}

export interface ChapterGoalSection {
  chapterGoal: string
  mergedOutline: string
  revisionDirectives: string
}

export interface DerivedStoreSections {
  worldBlueprint: string | undefined
  narrativeVisibility: string | undefined
}

export interface RelatedChaptersContextInput {
  currentChapter: number
  chapterOutline: string
  foreshadowing: ForeshadowingStore
  /** 角色出场记录 (可由 snapshots 构造) */
  appearances?: RelatedChaptersInput["appearances"]
  stateChanges?: RelatedChaptersInput["stateChanges"]
  relationships?: RelatedChaptersInput["relationships"]
  snapshots?: readonly ChapterSnapshot[]
  options?: RelatedChaptersOptions
}

export interface RelatedChaptersContextResult {
  /** 四维反查结果 */
  related: ReturnType<typeof buildRelatedChapters>
  /** 伏笔逾期 findings */
  overdueFindings: ReturnType<typeof findOverdueForeshadowing>
  /** 注入 ContextPack 的文本 (空串 = 无相关内容) */
  text: string
}

/**
 * v3 agent 兼容：上下文裁剪结果（port of v3 context-engine TrimResult）。
 */
export interface TrimResult {
  pack: ContextPack
  removed: Array<{ kind: string; label: string; chars: number }>
  remainingChars: number
  prompt?: string
  originalChars?: number
  finalChars?: number
  trimmedChars?: number
  trimmedFields?: string[]
}
