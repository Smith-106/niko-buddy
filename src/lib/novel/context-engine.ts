import { readFile, } from "@/commands/fs"
import { listEntityFiles } from "./entity-subdir-resolver"
import { } from "@/lib/search"
import { normalizePath } from "@/lib/path-utils"
import { logger } from "@/lib/utils"
import { useWikiStore } from "@/stores/wiki-store"
import { parseFrontmatter } from "@/lib/frontmatter"
import { sampleTruthFoldDrift, type ChapterSnapshot } from "./chapter-ingest"
import { buildRevisionDirectives, type NovelRevisionFeedback } from "./revision-feedback"
// ISS-20260712-ARCH-1 (Wave 1): 派生 store 文本读取群拆到 context-derived-stores.ts
// (load* + *ToContextText import 随移)。context-engine 调用点 (buildLoadContext)
// 改从本 import。
import {
  readEmotionalArcsText,
  readSubplotBoardText,
  readResourceLedgerText,
  readEmotionLedgerText,
  readAuraEvolutionText,
} from "./context-derived-stores"
import {
  rerankActiveEntitiesByTemporalFacts,
  renderTemporalCanonBlock,
  type TemporalFact,
} from "./temporal-memory"
import { auditTemporalFactsStatus, temporalEmptySoftGapRef } from "./temporal-facts-audit"
import { } from "./projection-status-ledger"
import { buildCharacterAuraContext } from "./character-aura"
import { buildReferenceContext, type ReferenceContextResult } from "@/lib/reference/search"
import { buildTrustGradeMap } from "./trust-grader"
import { retrieveDualTrack, kbRoutingView, type DualTrackResult } from "./search-adapter"
// P1-IMP-14: 向量检索共享核心（与 search-adapter.runVectorSearch 同形孪生归一）。
import type { FileNode } from "@/types/wiki"
import { DataSourceRegistry, ContextLoadContext, type ContextRawData, } from "./context-data-source"
import { getAllDataSources } from "./context-data-sources"
import { computeContextBudget, } from "@/lib/context-budget"
// Wave 5 (v2.5.0): 上下文用量快照装配 — 预算线 + 记忆实测（user-memory 模块是
// cached leaf，无环依赖；失败降级 null → memoryChars 0，不阻断 build）。
import { buildContextUsage } from "@/lib/context-usage"
import { loadUserMemoryForProject } from "@/lib/user-memory/session"
import { loadWorldBlueprint, worldBlueprintToPromptFragment } from "./world-blueprint"
import { loadNarrativeState } from "./narrative-state"
// EPIC-001 / TASK-004 / ADR-29: Style Exemplars loader（正向锚点注入，
// de-ai-adapter 单次 pass 不变 — exemplar 经 contextPack 消费）。
import { loadStyleExemplars, pickTopKExemplars, type StyleExemplar } from "./style-exemplars-loader"
// EPIC-003 / TASK-008: ROI 遥测经 context-telemetry 分层投递（ISS-20260713-005：
// engine 只产出样本数据，落盘归 telemetry sink；默认 sink 写 cognition-state.json
// 既有 key，HARD-1 守恒）。POV 解析仍直引 character-cognition（纯读快照，无环）。
import { resolveChapterPovCharacter } from "./character-cognition"
import { reportRoutingROI } from "./context-telemetry"
// ISS-20260709-048: 动态 import 显式依赖声明 —— community-summary 为本模块
// 懒加载依赖（运行时 dynamic import 见 loadCommunitySummaryText），此处
// type-only import 向打包器/类型系统显式声明依赖边（编译期擦除，零运行时环）。
import type { loadPersistedCommunitySummaries as loadPersistedCommunitySummariesType } from "./community-summary"
// P2-IMP-13 (P2-M4): KbMetrics 三项真实采集 — buildContextPackUnlocked 尾部装配
// （truth_fold_drift ← IMP-06 采样 / hard_injection_budget_usage ← pack.hardInjectUsage /
// gap_report_rate ← pack.gaps 计数；两评测 gate 项显式 N/A 保留，不伪造）。
import { collectKbMetrics } from "./kb-observability"
// S2a (roadmap): 四维反查组合导入 — related-chapters 是独立纯函数模块,
// context-engine 负责组合进 ContextPack (不平行实现, 与 searchRelevantContentUnified 互补)。
import {
  buildRelatedChapters,
  buildAppearancesFromSnapshots,
  findOverdueForeshadowing,
  relatedChaptersToContextText,
} from "./related-chapters"
import { loadForeshadowingTracker } from "./foreshadowing-tracker"
import { } from "./chapter-utils"
// P1-IMP-13 (A1a): reference-binding 素材用途绑定进 ContextPack（additive
// pack.referenceBindings，零绑定字节级不变）。
import { loadReferenceBindings, bindingsToContextText } from "./reference-binding"
// T25 (A-04.4/F-13): canon 三源并行 — 源2 走 T14 投影读出口（canon_migration ≥ dual
// 时启用；默认仍走折叠路径），源3 走 T27b 技法离线编译（runtime 唯一合法入口）。
import { } from "./canon-graph-client"
// T25: canon 迁移门读取（status.json canon_migration 字段，T09 契约）。
// loadNovelSessionStatus 自吞错误（缺失/损坏 → null），不向外抛。
// 无运行时循环依赖：novel-session-status 对 deep-chapter-generation/review-adapter
// 均为 type-only import（编译期擦除）。
// T27b/F-19 (W12 注入范围含技法块): 离线编译产物渲染为技法提示块文本。
import { } from "./craft/technique-compiler"
// B1 偏好重排（零风险 additive）：读 PreferenceStore + scorePreference 按分重排块顺序，仅改变行顺序不增删块；
// 读失败/空偏好总分为 0 降级原序（默认行为不变）。novel 域内直引用合法。
import type { } from "./craft/technique-compiler"

// M7-3: pack/section 纯类型簇下沉至 ./context-engine-types（逐字搬迁，零签名变更）。
// 本模块 import type 回供内部使用，并 export type 重出保既有 import 面
// （spec / data-sources / retrieval / prompt / telemetry 等消费方不动）。
import type {
  BuildContextOptions,
  ChapterGoalSection,
  ContextEntity,
  ContextPack,
  DerivedStoreSections,
  ProjectionTexts,
  RawSnapshotView,
  RelatedChaptersContextInput,
  RelatedChaptersContextResult,
  SourceTimingsMs,
  SummaryBasics,
  TrimResult,
} from "./context-engine-types"
export type {
  BuildContextOptions,
  ChapterGoalSection,
  ContextEntity,
  ContextPack,
  DerivedStoreSections,
  ProjectionTexts,
  RawSnapshotView,
  RelatedChaptersContextInput,
  RelatedChaptersContextResult,
  SourceTimingsMs,
  SummaryBasics,
  TrimResult,
} from "./context-engine-types"



// F4 (Round-1 评估)：activeEntities tier 预算截断纯函数已拆至 ./context-entity-budget
//（巨石拆分第 1 步）。本地 import 供内部调用点使用，并 re-export 保持既有
// import 面（7 个 spec 不动）。
import { truncateActiveEntitiesByBudget } from "./context-entity-budget"
export { truncateActiveEntitiesByBudget, type ContextEntity as ContextEntityBudget } from "./context-entity-budget"

// F4-4（Round-4 评估）：pack 格式化纯函数簇已拆至 ./context-pack-format-helpers
//（巨石拆分第 4 步）。本地 import 供内部调用点使用，并 re-export 保持既有
// import 面（trim/droporder/budget 等 spec 不动）。
import {
  charsPerTokenOfPack,
  extractSceneCharacters,
  narrativeVisibilitySummary,
} from "./context-pack-format-helpers"
export {
  charsPerTokenOfPack,
  extractSceneCharacters,
  narrativeVisibilitySummary,
} from "./context-pack-format-helpers"



/**
 * ISS-20260709-029 (F-003) mutex wrapper: 串行化所有 buildContextPack 调用。
 * 每次 build 排队等前一次完成后才执行，消除跨调用 interleave race（gaps 串包
 * + budget 错配）。buildContextPackUnlocked 是原实现；本 wrapper 把它接到模块
 * 级 Promise 链尾串行执行。链续接吞掉 build 错误（避免 reject 卡死后续排队
 * 调用），错误经 releasePromise 原样透传给调用方。保留 try/finally 单次内清理。
 */
export async function buildContextPack(
  projectPath: string,
  task: string,
  chapterNumber?: number,
  options: BuildContextOptions = {},
): Promise<ContextPack> {
  const releasePromise = new Promise<ContextPack>((resolve, reject) => {
    void buildMutex
      .then(() => buildContextPackUnlocked(projectPath, task, chapterNumber, options))
      .then(resolve, reject)
  })
  // 续接链: 前次 settle 后本次才执行。catch 掉 releasePromise 的 reject 以
  // 避免链本身 reject 传播卡死后续排队 build(错误已透传给原调用方)。
  setBuildMutex(buildMutex.then(() => releasePromise).catch(() => {}))
  return releasePromise
}

/**
 * EPIC-003 / ADR-32 / TASK-003 (RPC-4 Track B): compressible-with-floor 预算截断
 * （TASK-004 仅出数字，本函数落地）。rank0 entity（relevance:high 或
 * location:chapter-N 当前章节）floor 保护全保；rank1/rank2 按 tier cap
 * （rank1CompressibleCap / rank2CompressibleCap）压缩。原序保持（仅按 tier 配额
 * 丢弃超额 entity，不重排），故 flag=false 时 activeEntities 原序不变（D4）。
 *
 * IC-02：rank1/rank2 被 tier cap 截断时返回显式 ContextGap（type 'truncated'，
 * reason 'tier_compressible'）——绝不静默。调用方 push 到 pack.gaps。
 * budget 为 undefined（无 build 预算场景，如单测直调）时原样返回不截断不记 gap。
 */

async function buildContextPackUnlocked(
  projectPath: string,
  task: string,
  chapterNumber?: number,
  options: BuildContextOptions = {},
): Promise<ContextPack> {
  const pp = normalizePath(projectPath)
  // ISS-20260709-023 (DC-7) 渐进式 DI: 注入优先, 缺省回退 store（向后兼容）
  const novelMode = options.novelMode ?? useWikiStore.getState().novelMode
  if (!novelMode) {
    return emptyPack(task)
  }

  // 构建加载上下文
  const context = buildLoadContext(pp, task, chapterNumber, options)

  // 重置 gap recorder — 生命周期为本次 buildContextPack 调用
  resetContextGaps()

  // PERF-011 (TASK-007): compute the adaptive budget BEFORE loading data
  // sources so the tieredSlice call sites in readChapterOutlineContent /
  // pickChapterOutlineByNumber (invoked via chapterOutlineDataSource during
  // registry.loadAll) can drive the protected-tier cap from
  // computeContextBudget's chapterAdaptiveScale instead of the static
  // CHAPTER_OUTLINE_PROTECTED_CAP. Cleared after the build so direct
  // callers (tests / non-build invocations) fall back to the legacy cap.
  setCurrentBuildBudget(computeContextBudget(context.maxContextSize, context.chapterNumber))

  // PAT-M2 (odyssey sibling): currentBuildBudget is a module-level flag. If
  // loadAll / buildContextPackFromRawData throw, the flag would leak into the
  // next build (stale budget). Wrap the build body in try/finally so the
  // flag is always cleared — same shape as the partialReason clear-on-recover
  // fix (CORR-107).
  try {
    // 创建数据源注册器并加载所有数据
    const registry = createDataSourceRegistry()
    //
    // ── T25 / A-04.4: 三源真并行（wiki / canon / 技法 单次 Promise.all）───────
    // 源1 wiki   = registry.loadAll（原有全部上下文数据源，最长链）；
    // 源2 canon  = 时序事实（loadCanonSourceFacts：默认折叠路径；canon_migration
    //              ≥ dual 时改走 T14 读出口 queryCanonEdges + fromCanonGraph）；
    // 源3 技法 = T27b 离线编译技法块（compileFromCommittedSnapshot，纯同步计算
    //              包一层 async 以统一三源计时口径）。
    // 三源无数据依赖，原先 wiki 串行 await 完才走后续装配；现在单次 Promise.all
    // 并发发出，canon/technique 与 wiki 装载重叠。各源 performance.now 差值记入
    // pack.sourceTimingsMs（telemetry 计时点）并输出一次 logger.info 遥测事件。
    // 失败降级均在各源函数内处理（不 reject），不阻断主装配。
    const timings: SourceTimingsMs = { wiki: 0, canon: 0, technique: 0 }
    const timedSource = async <T>(slot: keyof SourceTimingsMs, run: () => Promise<T>): Promise<T> => {
      const startedAt = performance.now()
      try {
        return await run()
      } finally {
        timings[slot] = performance.now() - startedAt
      }
    }
    const [rawData, canonSource, techniqueText] = await Promise.all([
      timedSource("wiki", () => registry.loadAll(context)),
      timedSource("canon", () => loadCanonSourceFacts(pp, context.chapterNumber ?? 0)),
      timedSource("technique", () => loadTechniqueBlocks(pp)),
    ])
    const temporalFactsPreloaded = canonSource.current
    // telemetry 计时点：每次 build 输出一次三源耗时（毫秒，非整数保留亚毫秒分辨率）。
    logger.info("ContextEngine", "context-pack 三源并行装配计时", { ...timings })

    // EPIC-001 + EPIC-003 / TASK-004 + TASK-006: 并行加载 exemplar + activeEntities，
    // 与 buildContextPackFromRawData 无数据依赖（两者在 pack 返回后 merge 注入）。
    // 两个新字段都是 additive — 失败/空数据优雅降级为 []，不影响现有 pack 字段。
    // ISS-20260709-023 (DC-7) 渐进式 DI: 注入优先, 缺省回退 store。
    const novelConfig = options.novelConfig ?? useWikiStore.getState().novelConfig
    // S2a (TASK-101/TASK-102 / roadmap R06): 四维反查 + 伏笔逾期 finding 文本。
    // relatedChaptersEnabled 默认 true；关闭时跳过注入返回 ""（=现状行为）。additive：
    // 失败 catch 降级空文本，不阻断 pack（与 exemplars/activeEntities 同款）。
    // 数据来源均为本 build 已持有（pp/context/rawData）：伏笔台账 loadForeshadowingTracker
    // （其内部失败降级空 store，不 throw）；出场维度由快照构造（loadAllSnapshots 失败
    // 降级 []，仅跳过该维度）。buildRelatedChaptersContext 同步组合四维反查 + 伏笔逾期
    // finding，.text 即注入文本（related-chapters.ts 模块调用，不平行实现）。
    const relatedChaptersPromise =
      novelConfig.relatedChaptersEnabled
        ? (async (): Promise<string> => {
            try {
              const foreshadowing = await loadForeshadowingTracker(pp)
              const snapshots = await loadAllSnapshots(pp).catch(() => [] as ChapterSnapshot[])
              return buildRelatedChaptersContext({
                currentChapter: context.chapterNumber ?? 0,
                chapterOutline: typeof rawData.chapterOutline === "string" ? rawData.chapterOutline : "",
                foreshadowing,
                snapshots,
              }).text
            } catch (error) {
              // P1-IMP-13: 分级记录（RECOVERABLE — 采源失败重试/隔离）
              logDegradation("related-chapters context build failed, skipping injection", error, { sourceFailed: true })
              return ""
            }
          })()
        : Promise.resolve("")
    // Wave 2 (v2.5.0): @引用注入。referenceEnabled 默认 true；关闭时跳过注入
    // 返回 ""（=现状行为）。additive：失败 catch 降级空文本，不阻断 pack
    // （与 relatedChapters 同款）。数据来源：task 文本解析 @ 引用 → 候选装载
    // → novelMixedSearch 三路融合检索 → 引用段（含用户记忆偏好原文，PR6 通道）。
    const referencesPromise =
      novelConfig.referenceEnabled
        ? (async (): Promise<ReferenceContextResult | null> => {
            try {
              return await buildReferenceContext(pp, task, {
                chapterNumber: context.chapterNumber,
              })
            } catch (error) {
              // P1-IMP-13: 分级记录（RECOVERABLE — 采源失败重试/隔离）
              logDegradation("reference context build failed, skipping injection", error, { sourceFailed: true })
              return null
            }
          })()
        : Promise.resolve(null)
    // E-02 (C-5/C-9, run-execute-1 双库架构蓝图 capability-kb-retrieval): 硬注入第四源。
    // 单次 retrieveDualTrack 调用（通道 A 硬注入 + 通道 B 语义检索）；POV 真源：
    // P2-IMP-12 起由 resolveChapterPovCharacter 读快照 povCharacter 人工声明解析，
    // 无声明 → null → 通道 A 空（不臆造 POV），通道 B 仍可用。
    // 失败降级 null（不阻断 pack 装配，与 relatedChapters/references 同款模式）。
    // 注：D5「复用 loadCanonSourceFacts 结果」未采纳——retrieveDualTrack 通道 A 走
    // getFactsKnownBy（known_by 认知轴 POV 过滤，C-5 要求），与 loadCanonSourceFacts
    // （世界层时序事实）语义不同；二次 load 仅发生在 hardInjectEnabled=true 时（flag 门控）。
    const hardInjectPromise =
      novelConfig.hardInjectEnabled
        ? (async (): Promise<DualTrackResult | null> => {
            try {
              const povCharacter =
                options.povCharacter ??
                (await resolveChapterPovCharacter(pp, context.chapterNumber ?? 0).catch(() => null)) ??
                undefined
              return await retrieveDualTrack({
                projectPath: pp,
                query: task,
                chapterNumber: context.chapterNumber,
                povCharacter,
                intent: "draft",
                topK: novelConfig.searchTopK > 0 ? novelConfig.searchTopK : 5,
                hardInjectCapChars: currentBuildBudget?.hardInjectionBudget.capChars,
                trustFilterEnabled: novelConfig.trustFilterEnabled,
                // P1-IMP-06: 由 buildTrustGradeMap 从 KB-VIEW 非 tech 条目构建 path→trust 映射。
                // flag 默认 false → 字节级回退；开启时 blocked 条目被归一查找剔除。
                trustGrades: novelConfig.trustFilterEnabled ? buildTrustGradeMap(kbRoutingView as Parameters<typeof buildTrustGradeMap>[0]) : undefined,
              })
            } catch (error) {
              // P1-IMP-13: 分级记录（DEGRADED — 检索路径失败，降级不注入，不终止写作）
              logDegradation("hard-inject build failed, skipping injection", error, { retrievalFailed: true })
              return null
            }
          })()
        : Promise.resolve(null)
    const [pack, exemplars, activeEntities, relatedChaptersText, referencesResult, hardInjectResult] = await Promise.all([
      // ISS-20260709-035: loadAll 产出 Record<string, unknown>，经显式 cast
      // 收敛到 ContextRawData 契约（键集合一致，收窄语义由 normalize 入口保证）。
      buildContextPackFromRawData(rawData as ContextRawData, context, temporalFactsPreloaded),
      // TASK-004: exemplarEnabled 默认 true；关闭时跳过注入返回 []。
      novelConfig.exemplarEnabled
        ? loadStyleExemplars(pp).then((all) => pickTopKExemplars(all)) /* token budget: prefer keeping thril/pull exemplar slots when present */.catch((error) => {
            // P1-IMP-13: 分级记录（RECOVERABLE — 采源失败重试/隔离）
            logDegradation("style exemplars load failed, skipping injection", error, { sourceFailed: true })
            return [] as StyleExemplar[]
          })
        : Promise.resolve([] as StyleExemplar[]),
      // TASK-006: conditionalRoutingEnabled 默认 true；关闭时跳过路由返回 []。
      // 零 entity 优雅降级在 selectActiveEntities 内部处理（回退全量 + warning）。
      novelConfig.conditionalRoutingEnabled
        ? selectActiveEntities(pp, {
            chapterNumber: context.chapterNumber,
            outline: joinNonEmpty([typeof rawData.outline === "string" ? rawData.outline : "", typeof rawData.chapterOutline === "string" ? rawData.chapterOutline : ""], "\n\n"),
            sceneCharacters: extractSceneCharacters(rawData),
          }).catch((error) => {
            // P1-IMP-13: 分级记录（RECOVERABLE — 采源失败重试/隔离）
            logDegradation("conditional entity routing failed, skipping injection", error, { sourceFailed: true })
            return [] as ContextEntity[]
          })
        : Promise.resolve([] as ContextEntity[]),
      relatedChaptersPromise,
      referencesPromise,
      hardInjectPromise,
    ])

    pack.gaps = collectContextGaps()
    // EPIC-001 / ADR-29: exemplar 注入（top-K=3 按 markType 多样性排名，text 截断）。
    // 零 exemplar 时 [] — de-ai-adapter 单次 pass 不变（contextPack.styleExemplars 消费）。
    pack.styleExemplars = exemplars
    // S2a (TASK-101/TASK-102 / roadmap R06): 四维反查 + 伏笔逾期 finding 注入
    // （related-chapters 模块组合，additive 独立字段）。relatedChaptersEnabled=false
    // 或空结果时为 ""（优雅降级，不影响既有 pack 字段）。消费方按需读取
    // pack.relatedChapters（与 styleExemplars 同款 pack 字段消费模式）。
    pack.relatedChapters = relatedChaptersText
    // Wave 2 (v2.5.0): @引用段注入（additive 独立字段）。referenceEnabled=false
    // 或零引用时为 ""（优雅降级，不影响既有 pack 字段）。消费方按需读取
    // pack.references（与 relatedChapters 同款 pack 字段消费模式）。
    // P1-IMP-03: 结构化返回（截断/失败显式记账，IC-02 绝不静默）。
    const referencesText = referencesResult?.text ?? ""
    pack.references = referencesText
    if (referencesResult && referencesResult.truncated) {
      pack.gaps.push({
        type: "truncated",
        ref: "references",
        reason: "budget_exceeded",
        originalLength: referencesText.length + 1,
        retainedLength: referencesText.length,
      })
    }
    if (referencesResult && referencesResult.cause === "load_failed") {
      pack.gaps.push({
        type: "load_failed",
        ref: "references",
        reason: "datasource_error",
        originalLength: 0,
        retainedLength: 0,
      })
    }
    // E-02 (C-9): 硬注入装配 — additive 独立字段。零条目 → undefined（不渲染该段）；
    // 超 cap 裁剪与路由缺口同步镜像进 pack.gaps（IC-02 主账，绝不静默）。
    if (hardInjectResult) {
      pack.hardInject = hardInjectResult.hardInject.length > 0 ? hardInjectResult.hardInject : undefined
      pack.hardInjectUsage = hardInjectResult.usage
      if (hardInjectResult.gaps.length > 0) {
        pack.kbRoutingGaps = hardInjectResult.gaps
        for (const gap of hardInjectResult.gaps) {
          const isBudget = gap.message.includes("budget_exceeded") || gap.collection === "hardInject"
          pack.gaps.push({
            type: isBudget ? "truncated" : "load_failed",
            ref: gap.collection,
            reason: isBudget ? "budget_exceeded" : "datasource_error",
            originalLength: 0,
            retainedLength: 0,
          })
        }
      }
      // P1-IMP-17: KB-VIEW 条目关键词/域匹配零 LLM 检索结果——additive 独立段。
      // 零命中 → undefined（字节级不变）；独立 referenceBudget 不复用 hardInject。
      if (hardInjectResult.kbReferences && hardInjectResult.kbReferences.length > 0) {
        pack.kbReferences = hardInjectResult.kbReferences
      }
    }
    // P1-IMP-13 (A1a): reference-binding 素材用途绑定注入 — additive 独立字段。
    // loadReferenceBindings 读 reference-bindings.json（原子存储，缺失/损坏降级空 store）；
    // bindingsToContextText 渲染本章绑定（零绑定 → ""）。空文本 → undefined（renderIf
    // 非空才渲染，零绑定字节级不变）。失败降级 undefined，不阻断 pack 装配。
    let referenceBindingsText = ""
    try {
      const bindingStore = await loadReferenceBindings(pp).catch(() => null)
      if (bindingStore) {
        referenceBindingsText = bindingsToContextText(bindingStore, context.chapterNumber ?? 0)
      }
    } catch {
      referenceBindingsText = ""
    }
    pack.referenceBindings = referenceBindingsText || undefined
    // C（方案 X 全做 M+）：已失效（曾成立）事实独立分块注入。former 为空时设 undefined
    // → 不渲染该段（flag=false 字节级不变）。绝不并入 canonRules/有效 temporal 块。
    pack.formerFacts = canonSource.former.length > 0 ? canonSource.former : undefined
    // T25 (F-19/A-04.4): 技法块注入（additive 独立字段）— 空文本不注入（undefined），
    // 消费方按需读取 pack.techniqueBlocks；三源计时探针遥测字段同步注入。
    pack.techniqueBlocks = techniqueText || undefined
    pack.sourceTimingsMs = timings
    // EPIC-003 / ADR-32: activeEntities 注入（entity-tags 路由双源匹配）。
    // 零 entity 优雅降级 [] — 加性原则，不减少现有上下文。
    // EPIC-003 / ADR-32 / TASK-003 (RPC-4 Track B): Track B rerank 接线（接上方
    // activeEntities 注入）。temporalFactsEnabled=true 时按章节时间线 temporal facts
    // （载体 pack.temporalFacts，已由 canon 路径 load，D7 避免 PAT-G2 孪生重复 load）
    // rerank activeEntities；只升不降（D6 rank0 封顶），关闭时回退原序（D4 canon
    // baseline + Track A 原序保持）。rerank 后按 compressible-with-floor 预算
    // （TASK-004）截断 rank1/rank2（rank0 floor 保护全保），截断显式推 IC-02
    // ContextGap，绝不静默。
    const reranked = novelConfig.temporalFactsEnabled
      ? rerankActiveEntitiesByTemporalFacts(activeEntities, pack.temporalFacts ?? null, context.chapterNumber ?? 0)
      : activeEntities
    const wired = truncateActiveEntitiesByBudget(reranked, currentBuildBudget?.activeEntitiesBudget, context.chapterNumber ?? 0)
    pack.activeEntities = wired.entities
    if (wired.gap) pack.gaps.push(wired.gap)
    // Quality Foundation v1 + mid-loop: soft audit when temporal is on but mid-chapter pack has no facts.
    // Surfaces IC-02 gap (not Track A FAIL). See temporal-facts-audit.ts.
    const chNum = context.chapterNumber ?? 0
    const temporalAudit = auditTemporalFactsStatus({
      enabled: novelConfig.temporalFactsEnabled === true,
      chapterNumber: chNum,
      facts: pack.temporalFacts ?? null,
    })
    if (temporalAudit.level === "empty_soft") {
      logger.warn("ContextEngine", temporalAudit.message, {
        chapterNumber: chNum,
        factCount: temporalAudit.factCount,
      })
    }
    if (temporalAudit.shouldRecordGap) {
      pack.gaps.push({
        type: "load_failed",
        ref: temporalEmptySoftGapRef(chNum),
        reason: "datasource_error",
        originalLength: 0,
        retainedLength: 0,
      })
    }
    // ISS-20260713-005: 条件路由 ROI 遥测经 context-telemetry 分层投递。
    // engine 只产出样本（variant/占比/章节/时间），落盘归 sink；缺省 sink
    // 写 cognition-state.json routingROIBuckets（现有 key，HARD-1 守恒）。
    // A/B 分组：conditionalRoutingEnabled true → 'enabled'，false → 'disabled'。
    // G-002/G-003 跨章节累积统计。失败非致命 — ROI 采集不影响主链装配。
    reportRoutingROI(pp, {
      pack,
      activeEntities,
      chapterNumber: context.chapterNumber,
      conditionalRoutingEnabled: novelConfig.conditionalRoutingEnabled,
    }, options.telemetrySink)
    // Wave 5 (v2.5.0): 上下文用量快照 — 预算线直读 currentBuildBudget（本 build
    // 已算，不重算），记忆段实测 user-memory preference 字符数。additive：加载
    // 失败/无 store 时 memoryChars=0，仍冻结预算线（ring 照常渲染其余四段）。
    const userMemoryStore = await loadUserMemoryForProject(pp).catch(() => null)
    if (currentBuildBudget) {
      pack.contextUsage = buildContextUsage(currentBuildBudget, userMemoryStore)
    }
    // P2-IMP-13 (P2-M4): KbMetrics 三项真实采集 — buildContextPackUnlocked 尾部装配。
    //   truth_fold_drift ← IMP-06 sampleTruthFoldDrift 采样聚合值（内部失败吞掉 →
    //     null → N/A，不阻断主链）；
    //   hard_injection_budget_usage ← pack.hardInjectUsage.ratio（:728 已装配；
    //     hardInjectEnabled=false / 装配降级时缺失 → N/A 诚实降级）；
    //   gap_report_rate ← pack.gaps 计数（IC-02 缺口透明化）。
    //   canon_violation_rate / obligation_coverage 显式 N/A 保留（评测 gate P1 轨道，
    //   不伪造 —— agentmemory 诚实降级模式）。
    // 注：部分测试环境以子集 mock chapter-ingest 模块（仅 listSnapshots/loadSnapshot），
    //   静态导入的 sampleTruthFoldDrift 绑定在 mock 缺席时经模块 namespace 抛错 ——
    //   此处 try/catch 守卫：mock 缺席/采样异常一律诚实降级 N/A（null），不阻断主链。
    //   （生产路径 sampleTruthFoldDrift 内部已自吞失败返回 null。）
    let driftSample: { driftCount: number; driftedFiles: string[] } | null = null
    try {
      driftSample = await sampleTruthFoldDrift(pp)
    } catch {
      driftSample = null
    }
    pack.kbMetrics = collectKbMetrics({
      truthFoldDrift: driftSample ? driftSample.driftCount : null,
      hardInjectionBudgetUsage: pack.hardInjectUsage ? pack.hardInjectUsage.ratio : null,
      gapReportRate: pack.gaps?.length ?? null,
    })
    return pack
  } finally {
    // PERF-011 / DC-6 (odyssey-improve): clear BOTH module-level build flags.
    // `collectContextGaps()` (normal path above) sets contextGapsActive=false,
    // but if `buildContextPackFromRawData` throws, collectContextGaps never
    // runs and contextGapsActive stays true — leaving tieredSlice (line ~153)
    // recording gaps into a stale buffer that the next build's reset would
    // clear only at its start. Clear both flags here so the post-build window
    // (between an aborted build and the next reset) is not vulnerable to
    // stray gap recording, and contextGaps array doesn't accumulate across a
    // failed build. Idempotent on the normal path (collect already set false).
    setCurrentBuildBudget(null)
    setContextGapsActive(false)
    contextGaps.length = 0
  }
}

/**
 * 构建加载上下文配置
 */
function buildLoadContext(
  projectPath: string,
  task: string,
  chapterNumber?: number,
  options: BuildContextOptions = {},
): ContextLoadContext {
  // ISS-20260709-023 (DC-7) 渐进式 DI: 注入优先, 缺省回退 store（向后兼容）
  const novelConfig = options.novelConfig ?? useWikiStore.getState().novelConfig
  const revisionFeedbackWindowConfig = options.revisionFeedbackWindowConfig ?? useWikiStore.getState().revisionFeedbackWindowConfig
  // PERF-011 (TASK-007): wire llmConfig.maxContextSize through so
  // computeContextBudget's chapterAdaptiveScale is live on the read path
  // (was dead code — no read-path caller). Optional field: absent →
  // computeContextBudget falls back to DEFAULT_MAX_CTX (backward compatible).
  const llmConfig = options.llmConfig ?? useWikiStore.getState().llmConfig

  return {
    projectPath,
    task,
    chapterNumber: chapterNumber ?? extractChapterNumberFromTask(task),
    maxContextSize: llmConfig.maxContextSize,
    config: {
      recentSummaryWindow: novelConfig.recentSummaryWindow > 0 ? novelConfig.recentSummaryWindow : 8,
      searchTopK: novelConfig.searchTopK > 0 ? novelConfig.searchTopK : 5,
      snapshotLookback: 3,
      revisionFeedbackWindowConfig,
    },
    // DC-8 (odyssey-improve): inject the gap recorder so data sources can
    // surface load failures into pack.gaps (IC-02) without importing
    // context-engine (avoids circular dependency). No-op outside a build
    // (guarded by contextGapsActive inside recordDatasourceLoadFailure).
    recordGap: recordDatasourceLoadFailure,
  }
}

/**
 * 创建并配置数据源注册器
 */
function createDataSourceRegistry(): DataSourceRegistry {
  const registry = new DataSourceRegistry()
  registry.registerAll(getAllDataSources())
  
  return registry
}

/**
 * 从原始数据构建上下文包
 *
 * T25 (A-04.4): temporal 事实改为预载消费 —— `temporalFactsPreloaded` 由
 * buildContextPackUnlocked 的三源并行段（loadCanonSourceFacts：默认折叠路径 /
 * canon_migration ≥ dual 时 T14 读出口 + fromCanonGraph）产出后直传进来，
 * 本函数不再重复加载（D7 避免 PAT-G2 孪生重复 load）。null = 未启用或加载失败 →
 * canonRules 回退 raw（向后兼容；原 catch 降级语义已上移至 loadCanonSourceFacts）。
 */
// ============================================================================
// ISS-20260709-034: buildContextPackFromRawData（原单函数 156 行 7 职责）
// 拆分为以下小函数（本文件内，导出供结构/等价单测）：
//  1. normalizeRawSnapshots —— 快照入口收窄
//  2. resolveSummaryBasics —— 摘要/上章结尾/delta 基础段
//  3. loadProjectionTexts —— 五投影 store 并行预取
//  4. resolveCharacterStates —— 人物状态拼装
//  5. resolveTimelineSection / resolveForeshadowingSection —— 时间线/伏笔
//  6. resolveChapterGoalSection —— 章节目标/大纲/修订指令
//  7. resolveAuraMatchingText / loadCommunitySummaryText /
//     applyTemporalFactsToCanonRules / resolveDerivedStoreSections ——
//     aura 匹配文本 / 社区摘要 / 时序 canon / 派生 stores
// 编排函数 buildContextPackFromRawData 只负责调用顺序与 Promise.all 并发
// 结构（字节级行为等价：各 helper 均为原内联代码逐字搬迁）。
// ISS-20260709-035: 入参改类型化契约 ContextRawData（见 context-data-source.ts）。
// ============================================================================


function rawStrField(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function rawStrArrField(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : []
}

/**
 * 职责 1 入口：快照收窄（原内联 snapshots 表达式逐字搬迁）。
 * 非对象/缺失 → 空对象（后继 rawStr/rawStrArr 降级 ""/[]，字节级一致）。
 */
export function normalizeRawSnapshots(rawData: ContextRawData): RawSnapshotView {
  return (typeof rawData.snapshots === "object" && rawData.snapshots !== null
    ? rawData.snapshots
    : {}) as RawSnapshotView
}


/**
 * 职责 1 主体：摘要/正文/delta/上章结尾（原内联合并快照与降级数据逐字搬迁）。
 */
export function resolveSummaryBasics(rawData: ContextRawData, snapshots: RawSnapshotView): SummaryBasics {
  // 合并快照数据和降级数据
  const snapshotRecentSummaries = rawStrArrField(snapshots.recentSummaries)
  const recentSummaries = snapshotRecentSummaries.length > 0
    ? snapshotRecentSummaries
    : rawStrArrField(rawData.fallbackRecentSummaries)
  const recentChapterContents = rawStrArrField(rawData.recentChapterContents)
  // P2-IMP-10 (M2): stateDelta additive 透传 — snapshotDataSource 经
  // chapterSummariesToContextText 渲染的键控子表文本。空 store / 无快照时
  // rawData.snapshots.recentStateDeltas 缺失 → undefined（renderIf 非空才渲染，
  // recentSummaries 现路径字节级不动）。
  const recentStateDeltas =
    typeof snapshots.recentStateDeltas === "string" &&
    snapshots.recentStateDeltas.length > 0
      ? snapshots.recentStateDeltas
      : undefined

  const previousChapterEnding = rawStrField(snapshots.previousChapterEnding)
    || rawStrField(rawData.fallbackPreviousEnding)
  return { recentSummaries, recentChapterContents, recentStateDeltas, previousChapterEnding }
}


/**
 * 职责 2 前半：五投影 store 文本并行预取
 * （原 PERF-NEW-04 Promise.all 逐字搬迁；各 store 独立）。
 */
export async function loadProjectionTexts(projectPath: string): Promise<ProjectionTexts> {
  // PERF-NEW-04: pre-fetch the four projection-store texts in parallel
  // before joinNonEmpty (was 3 serial readFile IPC round-trips inside the
  // array literal). The stores are independent.
  const [emotionalText, subplotText, resourceText, emotionLedgerText, auraEvolutionText] = await Promise.all([
    readEmotionalArcsText(projectPath),
    readSubplotBoardText(projectPath),
    readResourceLedgerText(projectPath),
    readEmotionLedgerText(projectPath),
    readAuraEvolutionText(projectPath),
  ])
  return { emotionalText, subplotText, resourceText, emotionLedgerText, auraEvolutionText }
}

/**
 * 职责 2 后半：人物状态拼装（原 characterStates joinNonEmpty 逐字搬迁）。
 */
export function resolveCharacterStates(
  rawData: ContextRawData,
  snapshots: RawSnapshotView,
  projections: ProjectionTexts,
): string {
  return joinNonEmpty([
    rawStrField(snapshots.characterStates),
    rawStrField(rawData.fallbackCharacterStates),
    // R4 (S4 / ANL-013): emotional-arcs projection injected as protected-tier
    // canon — character emotion is part of character state. Loaded directly
    // from the .novel/emotional-arcs.json store (same pattern as
    // readCognitionStates). Empty when no arcs recorded (backward compatible).
    projections.emotionalText,
    // A19 emotion-ledger pilot (NovelForge-v5 移植): 情绪债务账本注入为
    // protected-tier canon — 机械层零 LLM 算术产出的 netValue/history 文本化
    // 结果，LLM 只读不推断。与 emotional-arcs 互补（弧线 beat vs 债务净值），
    // 不重叠。空 store 渲染 ''（向后兼容 — 未接入时不注入）。
    projections.emotionLedgerText,
    // A19 借鉴点 #3: P14 画像漂移历史注入 (机械字段 diff 文本化, LLM 只读)。
    // 与 emotional-arcs/emotion-ledger 互补不重叠。空 store 渲染 '' (写入端未接入
    // 时不注入, backward compatible)。
    projections.auraEvolutionText,
    // MAINT-002 (TASK-008): subplot-board + resource-ledger projections
    // injected as protected-tier canon alongside emotional-arcs — active
    // subplots and current item holders are load-bearing for the current
    // chapter (renderer docstrings: subplot-board.ts:70, resource-ledger.ts:78
    // say 'protected-tier context'). Empty stores render '' (backward
    // compatible — no injection when unwired).
    projections.subplotText,
    projections.resourceText,
  ], "\n\n")
}

/** 职责 3a：时间线（原内联 joinNonEmpty 逐字搬迁）。 */
export function resolveTimelineSection(rawData: ContextRawData, snapshots: RawSnapshotView): string {
  return joinNonEmpty([
    rawStrField(snapshots.timeline),
    rawStrField(rawData.fallbackTimeline)
  ], "\n\n")
}

/** 职责 3b：伏笔状态（原内联 mergeForeshadowingSignals 调用逐字搬迁）。 */
export function resolveForeshadowingSection(rawData: ContextRawData, snapshots: RawSnapshotView): string {
  const snapshotForeshadowingSignals = rawStrArrField(snapshots.foreshadowingSignals)
  return mergeForeshadowingSignals(
    snapshotForeshadowingSignals.length > 0
      ? snapshotForeshadowingSignals
      : [rawStrField(rawData.fallbackForeshadowingStates)].filter(Boolean),
    rawStrField(rawData.searchResults),
  )
}


/**
 * 职责 4：章节目标/合并大纲/修订指令（原内联三段逐字搬迁）。
 */
export function resolveChapterGoalSection(
  rawData: ContextRawData,
  chapterNumber: number | undefined,
): ChapterGoalSection {
  // 构建章节目标
  const chapterGoal = buildChapterGoal(
    rawStrField(rawData.outline),
    joinNonEmpty([rawStrField(rawData.storySimulationBinding), rawStrField(rawData.chapterOutline)], "\n\n"),
    chapterNumber
  )

  // 合并大纲信息
  const mergedOutline = joinNonEmpty([
    rawStrField(rawData.outline),
    rawStrField(rawData.volumeContext),
    rawStrField(rawData.storySimulationBinding),
    rawStrField(rawData.chapterOutline)
  ], "\n\n")

  // 构建修订指令
  const revisionDirectives = buildRevisionDirectives(rawData.revisionFeedback as NovelRevisionFeedback)
  return { chapterGoal, mergedOutline, revisionDirectives }
}

/**
 * 职责 5a：角色氛围匹配文本（原 characterAuraPromise matchingText 逐字搬迁）。
 */
export function resolveAuraMatchingText(
  rawData: ContextRawData,
  snapshots: RawSnapshotView,
  chapterGoal: string,
): string {
  return joinNonEmpty([
    chapterGoal,
    rawStrField(rawData.chapterOutline),
    rawStrField(rawData.fallbackCharacterStates),
    rawStrField(snapshots.characterStates),
    rawStrField(rawData.cognitionText),
  ], "\n\n")
}

/**
 * 职责 5b：社区摘要加载（原 communityPromise IIFE 逐字搬迁）。
 * ISS-20260709-048: community-summary 为显式懒加载依赖 —— 运行时仍走
 * dynamic import（首屏不进主 chunk），类型经顶部 type-only import 声明
 * （CommunitySummaryLoader），打包器/类型系统均可见依赖边。
 */
export async function loadCommunitySummaryText(projectPath: string): Promise<string> {
  try {
    const novelConfig = useWikiStore.getState().novelConfig
    // Default true in wiki-store; only skip when explicitly disabled.
    if (novelConfig?.communitySummaryEnabled === false) return ""
    const { loadPersistedCommunitySummaries } = await import("./community-summary")
    const loader: typeof loadPersistedCommunitySummariesType = loadPersistedCommunitySummaries
    const loaded = await loader(projectPath, {
      maxRecords: 6,
      maxChars: 2000,
    })
    return loaded.text
  } catch {
    logger.warn("ContextEngine", "silent-degrade: 降级返回空值（吞错已标记）", { line: 1179 })
    return ""
  }
}

/**
 * 职责 5c：时序 canon 合并（原 temporalBlock 内联合并逐字搬迁）。
 * facts 为 null → 回退 raw canon（向后兼容）。
 */
export function applyTemporalFactsToCanonRules(
  baseRules: string,
  temporalFacts: TemporalFact[] | null,
  targetChapter: number,
): string {
  if (temporalFacts) {
    const temporalBlock = renderTemporalCanonBlock(targetChapter, temporalFacts)
    if (temporalBlock) {
      return joinNonEmpty([baseRules, temporalBlock], "\n\n")
    }
  }
  return baseRules
}


/**
 * 职责 7：派生 stores（世界骨架/叙事可见性，原 return 内联 await 逐字搬迁）。
 */
export async function resolveDerivedStoreSections(projectPath: string): Promise<DerivedStoreSections> {
  // MIG-002: 世界骨架接入 context pack — loadWorldBlueprint 非空且有完备层时
  // 渲染为 prompt 片段注入；null/空骨架 → undefined → 不渲染（字节级不变）。
  const worldBlueprint = await loadWorldBlueprint(projectPath).then(
    (bp) => (bp ? worldBlueprintToPromptFragment(bp) || undefined : undefined),
  ).catch(() => undefined)
  // MIG-003: 叙事信息差可见性——loadNarrativeState 非空且有效声明时
  // 渲染视角可见性摘要；空 store → undefined → 不渲染。
  const narrativeVisibility = await loadNarrativeState(projectPath).then(
    (store) => narrativeVisibilitySummary(store) || undefined,
  ).catch(() => undefined)
  return { worldBlueprint, narrativeVisibility }
}

async function buildContextPackFromRawData(
  rawData: ContextRawData,
  context: ContextLoadContext,
  temporalFactsPreloaded: TemporalFact[] | null,
): Promise<ContextPack> {
  // ISS-20260709-035: rawData 已是类型化契约 —— 动态载荷经 normalize 入口
  // 收窄（行为与 any 时代字节级一致：缺失/非 string → ""/[]）。下沉 helper
  // 内 rawStrField/rawStrArrField 与原内联三 helper 语义同一。
  const snapshots = normalizeRawSnapshots(rawData)
  // PERF-011 (TASK-007): the adaptive budget for this build was already
  // computed in `buildContextPack` (stored as `currentBuildBudget`) before
  // the data-source load, so the tieredSlice call sites in
  // readChapterOutlineContent / pickChapterOutlineByNumber drive their caps
  // from `currentBuildBudget.maxPageSize` (which supersedes the static
  // CHAPTER_OUTLINE_PROTECTED_CAP) instead of the legacy hardcoded constant.
  // No recompute here — single source of truth via the module-level budget.

  // 职责 1：摘要/正文/delta/上章结尾
  const { recentSummaries, recentChapterContents, recentStateDeltas, previousChapterEnding } =
    resolveSummaryBasics(rawData, snapshots)

  // 职责 2：投影预取 + 人物状态拼装
  const projections = await loadProjectionTexts(context.projectPath)
  const characterStates = resolveCharacterStates(rawData, snapshots, projections)
  
  // 职责 3：时间线 + 伏笔
  const timeline = resolveTimelineSection(rawData, snapshots)
  const foreshadowingStates = resolveForeshadowingSection(rawData, snapshots)

  // 职责 4：章节目标 + 合并大纲 + 修订指令
  const { chapterGoal, mergedOutline, revisionDirectives } =
    resolveChapterGoalSection(rawData, context.chapterNumber)

  // 构建角色氛围上下文（依赖其他数据）
  const characterAuraPromise = buildCharacterAuraContext(context.projectPath, context.task, {
    matchingText: resolveAuraMatchingText(rawData, snapshots, chapterGoal),
  })

  // 职责 5：时序 canon 基线 + 社区摘要并发（temporal 预载直传消费）。
  const targetChapter = context.chapterNumber ?? 0
  const baseCanonRules = rawStrField(rawData.canonRules)
  const temporalFactsPromise = Promise.resolve(temporalFactsPreloaded)
  const communityPromise = loadCommunitySummaryText(context.projectPath)

  const [characterAuras, temporalFacts, communitySummaries] = await Promise.all([
    characterAuraPromise,
    temporalFactsPromise,
    communityPromise,
  ])
  const canonRules = applyTemporalFactsToCanonRules(baseCanonRules, temporalFacts, targetChapter)

  // 职责 7：派生 stores（世界骨架/叙事可见性）
  const derivedStores = await resolveDerivedStoreSections(context.projectPath)

  // 职责 6：最终装配
  return {
    task: context.task,
    chapterGoal,
    outline: mergedOutline,
    recentChapterContents,
    recentSummaries,
    previousChapterEnding,
    characterStates,
    soulDoc: rawStrField(rawData.soulDoc),
    characterAuras,
    cognitionStates: rawStrField(rawData.cognitionText),
    foreshadowingStates,
    timeline,
    relatedSettings: rawStrField(rawData.relatedSettings),
    canonRules,
    writingStyle: rawStrField(rawData.writingStyle),
    voiceStyleGuide: rawStrField(rawData.voiceStyleGuide) || undefined,
    searchResults: rawStrField(rawData.searchResults),
    graphSearchResults: rawStrField(rawData.graphSearchResults),
    communitySummaries: communitySummaries || undefined,
    worldBlueprint: derivedStores.worldBlueprint,
    narrativeVisibility: derivedStores.narrativeVisibility,
    mustDo: buildMustDo(chapterGoal, previousChapterEnding, foreshadowingStates),
    mustAvoid: buildMustAvoid(canonRules, timeline, characterStates),
    nextChapterAdvice: buildNextChapterAdvice({
      chapterGoal,
      recentSummaries,
      previousChapterEnding,
      foreshadowingStates,
      timeline,
      searchResults: rawStrField(rawData.searchResults),
    }),
    revisionDirectives,
    gaps: [],
    temporalFacts,
    recentStateDeltas,
  }
}

/**
 * T25 (A-04.4/F-13) 源2 canon：加载时序事实视图（三源并行段专用）。
 *
 * 双路分派（canon_migration 门，T09 会话状态契约）：
 *   - 缺省 / "legacy" → 默认折叠路径 loadTemporalFactsCached（TASK-004 原行为
 *     逐字保留：缓存 + 失败降级 null + 同款 warn 日志 —— 向后兼容，A-04.4
 *     「默认仍 fold」）；
 *   - "dual" / "shadow" → T14 读出口 queryCanonEdges（世界时态过滤当前章有效边 +
 *     仅未归档）→ temporal-memory.fromCanonGraph 视图转换；失败降级 null（不阻断）。
 *
 * 与原 buildContextPackFromRawData 内联加载语义对齐：无章节号（≤0）不加载时序
 * 事实返回 { current: null, former: [] }。loadNovelSessionStatus 自吞错误（缺失/损坏
 * status.json → null），故无需额外 catch 层。
 *
 * ## C（方案 X 全做 M+）：双查询结构
 *   - 第一查询：当前章有效边（旧行为 `is_valid_at` 严格半开区间）→ `current`
 *     （注入 pack.temporalFacts，保护一致性，禁改）。
 *   - 第二查询：`include_invalidated: true` 召回已失效窗口边（"曾以为"），经
 *     `fromCanonGraph(edges, { chapter, includeInvalidated: true })` 打 `former`
 *     标记 → `former`（`former === true` 过滤）。POV 精确归因（见 resolveChapterPovCharacter）：
 *     若解析到本章 POV 角色则叠加 `known_by` 过滤，否则世界层投影（include_invalidated
 *     仍为 true）。former 仅供独立分块（Part 3），绝不并入当前有效时序事实。
 */


// F4-2（Round-2 评估）：任务简报组装纯函数簇已拆至 ./context-task-brief-builders
//（巨石拆分第 2 步）。本地 import 供内部调用点使用，并 re-export 保持既有
// import 面（spec 与 context-data-sources 不动）。
import {
  buildChapterGoal,
  buildMustAvoid,
  buildMustDo,
  buildNextChapterAdvice,
  extractChapterNumberFromTask,
  joinNonEmpty,
  mergeForeshadowingSignals,
} from "./context-task-brief-builders"
export {
  buildChapterGoal,
  buildMustAvoid,
  buildMustDo,
  buildNextChapterAdvice,
  extractChapterGoal,
  extractChapterNumberFromTask,
  joinNonEmpty,
  mergeForeshadowingSignals,
  selectLookbackChapterNumbers,
  type NextChapterAdviceInput,
} from "./context-task-brief-builders"


/**
 * EPIC-003 / ADR-32 / TASK-006: 从 rawData 提取场景角色文本（双源之一）。
 *
 * 场景角色来源 = snapshots.characterStates（characterStateChanges 渲染文本，
 * 含角色名 + 第N章变更）+ fallbackCharacterStates。与 chapter outline mentions
 * 互补构成 entity 匹配双源（grep 验证 'chapter outline mentions' + 'scene characters'
 * 两 term）。
 */


/**
 * EPIC-003 / ADR-32 / TASK-006: 条件性 entity-tags 路由。
 *
 * 从 `${pp}/wiki/entities` 读取 entity pages（graph-adapter.ts:577 entitiesDir
 * 现存路径，read-only 复用），解析 frontmatter（type/title/tags），按双源匹配：
 *   - chapter outline mentions：outline 文本中出现 entity name
 *   - scene characters：characterStates 文本中出现 entity name
 *
 * 当 conditionalRoutingEnabled && tags 存在时，进一步按 frontmatter tags
 * （`location:chapter-N` / `relevance:high|medium|low`）过滤 + 排序。token 预算
 * 内 entity 优先级（主线 relevance:high > 配角 relevance:medium > 背景 relevance:low）。
 *
 * 零 entity 优雅降级：匹配为空时回退全量 entity 并标 warning（加性原则，MUST NOT
 * 减少现有上下文）。HARD-1：路由仅读 entity-page frontmatter，MUST NOT 写 status.json
 * （本函数无 writeStatus/saveStatus/persistCheckpoint 调用）。
 *
 * 不改 entity pages 数据模型（additive frontmatter only，ADR-32 明确禁止新数据层）。
 *
 * 导出用于 conditional-routing.spec.ts 直接测试（entity 匹配双源 + 零 entity 降级）。
 */
export async function selectActiveEntities(
  pp: string,
  hints: { chapterNumber?: number; outline: string; sceneCharacters: string },
): Promise<ContextEntity[]> {
  let files: FileNode[]
  try {
    // listEntityFiles 聚合 entities/ 子目录+顶层散装（物理分层双态兼容），
    // 返回 {name:slug, path}；包回 FileNode 形状供下游读取。
    files = (await listEntityFiles(pp)).map((f) => ({ name: `${f.name}.md`, path: f.path, is_dir: false }))
  } catch {
    // entities 目录不存在（项目未摄取过任何章节）— 优雅降级返回空。
    return []
  }

  const mdFiles = files.filter((f) => !f.is_dir && f.name.toLowerCase().endsWith(".md"))
  if (mdFiles.length === 0) return []

  // 读取所有 entity page 内容（并行）。
  const contents = await Promise.all(
    mdFiles.map(async (f) => {
      try {
        return { path: f.path, content: await readFile(f.path) }
      } catch {
        logger.warn("ContextEngine", "silent-degrade: 降级返回空值（吞错已标记）", { line: 1945 })
        return null
      }
    }),
  )

  const chapterN = hints.chapterNumber
  // 双源匹配文本：chapter outline mentions + scene characters。
  const outlineText = hints.outline ?? ""
  const sceneCharactersText = hints.sceneCharacters ?? ""
  const matchSource = (entityName: string): boolean => {
    /* v8 ignore next */
    if (!entityName || entityName.length < 1) return false
    // chapter outline mentions（源 A）：entity name 出现在 outline 文本中。
    if (outlineText.includes(entityName)) return true
    // scene characters（源 B）：entity name 出现在 characterStates 文本中。
    if (sceneCharactersText.includes(entityName)) return true
    return false
  }

  const matched: ContextEntity[] = []
  for (const entry of contents) {
    if (!entry) continue
    const fm = parseFrontmatter(entry.content).frontmatter
    const name = typeof fm?.title === "string" ? fm.title : ""
    const type = typeof fm?.type === "string" ? fm.type : "entity"
    const rawTags = fm?.tags
    const tags: string[] = Array.isArray(rawTags)
      ? rawTags.filter((t): t is string => typeof t === "string")
      : typeof rawTags === "string"
        ? rawTags.split(",").map((t) => t.trim()).filter(Boolean)
        : []
    if (!name) continue
    if (!matchSource(name)) continue
    matched.push({ entityId: entry.path, name, type, tags })
  }

  // 零 entity 优雅降级：双源匹配为空时回退全量（加性原则，不减少上下文）+ warning。
  if (matched.length === 0) {
    // P1-IMP-13: 分级记录（RECOVERABLE — 路由采源零命中，回退全量）
    logDegradation("conditional routing matched zero entities, falling back to all entities (additive — no context reduced)", undefined, { sourceFailed: true })
    return contents.filter(Boolean).map((entry) => {
      const fm = parseFrontmatter(entry!.content).frontmatter
      const name = typeof fm?.title === "string" ? fm.title : ""
      const type = typeof fm?.type === "string" ? fm.type : "entity"
      const rawTags = fm?.tags
      const tags: string[] = Array.isArray(rawTags)
        ? rawTags.filter((t): t is string => typeof t === "string")
        : typeof rawTags === "string"
          ? rawTags.split(",").map((t) => t.trim()).filter(Boolean)
          : []
      return { entityId: entry!.path, name, type, tags }
    }).filter((e) => e.name.length > 0)
  }

  // token 预算内 entity 优先级：主线 > 配角 > 背景层级（relevance tags）。
  // 同时用 location:chapter-N tag 提升当前章节关联的 entity。
  const relevanceRank = (e: ContextEntity): number => {
    let rank = 1 // 默认配角层级
    const tagStr = (e.tags ?? []).join(" ") /* v8 ignore start */ /* v8 ignore stop */
    if (tagStr.includes("relevance:high")) rank = 0 // 主线
    else if (tagStr.includes("relevance:low")) rank = 2 // 背景
    // location:chapter-N 匹配当前章节 → 提升至主线层级。
    if (chapterN && tagStr.includes(`location:chapter-${chapterN}`)) rank = 0
    return rank
  }
  matched.sort((a, b) => relevanceRank(a) - relevanceRank(b))

  return matched
}
// F8（Round-8 评估）：检索簇已拆至 ./context-retrieval（巨石拆分第 3 步）。
// 本模块是检索簇的唯一定义点；以下 re-export 保持既有 import 面
//（外部 spec 消费不动）。ISS-20260709-031 后 context-data-sources 已直连
// 定义源模块（./context-retrieval / ./context-engine-outline /
// ./context-task-brief-builders），不再经由本模块中转——单向依赖，消环。
// 端夏校准：检索模块内的向量门控截断记账经 __setGapRecorderForTests 注入
// 的 gapSink 进入 engine 的 build 作用域缓冲（IC-02）。同名 wrapper 只在
// build 期（contextGapsActive）转发 recorder；直接调用（单测/脚本）走无记账
// 原函数——与改前 contextGapsActive=false 默认一致，行为零变化。
import {
  searchRelevantContentUnified as searchRelevantContentUnifiedImpl,
  runVectorSearchForContext as runVectorSearchForContextImpl,
  __setGapRecorderForTests,
} from "./context-retrieval"
// ── 分层裁剪/来源装载/时序 memo/大纲读取子模块（P1 巨文件拆分）──────────────
// SECTION_PRIORITY 与 gap 契约抽离到 context-engine-gaps.ts；
// canon 事实/技法块/快照装载抽离到 context-engine-technique-sources.ts；
// 时序事实 memo 抽离到 context-engine-temporal.ts；大纲读取族抽离到
// context-engine-outline.ts。对外导出面不变（下方 import + 逐项 re-export）。
import {
  buildMutex,
  contextGaps,
  getContextGapsActive,
  setBuildMutex,
  setContextGapsActive,
  setCurrentBuildBudget,
  collectContextGaps,
  currentBuildBudget,
  logDegradation,
  recordDatasourceLoadFailure,
  resetContextGaps,
} from "./context-engine-gaps"
export type { ContextGap, SourceTier } from "./context-engine-gaps"
export { collectContextGaps, resetContextGaps } from "./context-engine-gaps"
import {
  loadCanonSourceFacts,
  loadTechniqueBlocks,
} from "./context-engine-technique-sources"
export { orderTechniqueBlocksByPreference } from "./context-engine-technique-sources"
import {
  __resetTemporalFactsCacheForTests,
} from "./context-engine-temporal"
import { loadAllSnapshots } from "./context-engine-temporal"
export type { LayeredRecallMode, ContextPackToPromptOptions } from "./context-engine-prompt"
export { contextPackToPrompt } from "./context-engine-prompt"
export {
  loadTemporalFactsCached,
  clearTemporalFactsCache,
  __resetTemporalFactsCacheForTests,
} from "./context-engine-temporal"
import {
  emptyPack,
} from "./context-engine-outline"
export {
  readOutlineContent,
  pickChapterOutlineByNumber,
  readChapterOutlineContent,
} from "./context-engine-outline"


export {
  computeIrrelevantRatio,
  searchGraphRelevantContent,
} from "./context-retrieval"
/**
 * ISS-20260709-038 去孪生：非 Unified 实现已删（见 context-retrieval 别名；生产零调用）。
 * 本 wrapper 保留作包容转发——gap 注入语义与 Unified wrapper 一字不差，直转 Unified。
 * @deprecated 直接使用 `searchRelevantContentUnified`。
 */
export async function searchRelevantContent(
  pp: string,
  task: string,
  chapterNumber: number | undefined,
  limit: number,
  options: BuildContextOptions = {},
): Promise<string> {
  return searchRelevantContentUnified(pp, task, chapterNumber, limit, options)
}
export async function searchRelevantContentUnified(
  pp: string,
  task: string,
  chapterNumber: number | undefined,
  limit: number,
  options: BuildContextOptions = {},
): Promise<string> {
  if (!getContextGapsActive()) return searchRelevantContentUnifiedImpl(pp, task, chapterNumber, limit, options)
  __setGapRecorderForTests(contextGaps, true)
  try {
    return await searchRelevantContentUnifiedImpl(pp, task, chapterNumber, limit, options)
  } finally {
    __setGapRecorderForTests(null, false)
  }
}
export async function runVectorSearchForContext(
  pp: string,
  query: string,
  limit: number,
  options: BuildContextOptions = {},
): Promise<{ title: string; snippet: string; path: string }[]> {
  if (!getContextGapsActive()) return runVectorSearchForContextImpl(pp, query, limit, options)
  __setGapRecorderForTests(contextGaps, true)
  try {
    return await runVectorSearchForContextImpl(pp, query, limit, options)
  } finally {
    __setGapRecorderForTests(null, false)
  }
}

// ============================================================================
// S2a (roadmap R06): 四维反查融合进 context-engine
//
// buildRelatedChaptersContext: 组合 related-chapters 四维反查 + 伏笔逾期
// finding, 生成可注入 ContextPack 的文本 (与 searchRelevantContentUnified 互补:
// 后者做内容检索, 本函数做跨章结构反查)。
// ============================================================================



/**
 * 构建四维反查上下文 (伏笔/出场/状态/关系 + 逾期 finding)。
 * appearances 未提供时可用 snapshots 构造; 两者皆无则跳过对应维度。
 */
export function buildRelatedChaptersContext(
  input: RelatedChaptersContextInput,
): RelatedChaptersContextResult {
  const related = buildRelatedChapters(
    {
      currentChapter: input.currentChapter,
      chapterOutline: input.chapterOutline,
      foreshadowing: input.foreshadowing,
      appearances: input.appearances ?? (input.snapshots ? buildAppearancesFromSnapshots(input.snapshots) : []),
      stateChanges: input.stateChanges ?? [],
      relationships: input.relationships ?? [],
    },
    input.options,
  )
  const overdueFindings = findOverdueForeshadowing(
    input.foreshadowing,
    input.currentChapter,
    input.options,
  )
  const relatedText = relatedChaptersToContextText(related)
  const findingText = overdueFindings.length > 0
    ? `伏笔逾期提醒:\n${overdueFindings.map((f) => `- ${f.finding}`).join("\n")}`
    : ""
  const text = [relatedText, findingText].filter(Boolean).join("\n\n")
  return { related, overdueFindings, text }
}


/**
 * RV-009 量纲换算（与 contextPackToPrompt 同源 CJK 加权口径）：
 * 纯 ASCII 4 字符/token，纯中文 1.5 字符/token，按实际 CJK 占比混合换算。
 * 返回 pack 内容对应的平均 chars/token，供 token 量级预算换算为字符。
 */


export function trimContextPack(
  pack: ContextPack,
  budgetChars: number,
  options?: { excludeOutline?: string | boolean; budgetUnit?: "chars" | "tokens" },
): TrimResult {
  // §GAP-103(f): honor excludeOutline（与 contextPackToPrompt 同语义）。
  // 默认 falsy/缺省时 prompt 组装与旧实现逐位一致（字节级等价）。
  const excludeOutline = Boolean(options?.excludeOutline)
  // RV-009 量纲归一化（additive）：budgetUnit 缺省 "chars" 时为恒等变换（字节级等价）；
  // 调用方若传入 token 量级预算，应显式传 budgetUnit: "tokens"，此处按 CJK 加权口径
  // （与 contextPackToPrompt 同源：纯 ASCII 4 字符/token，纯中文 1.5 字符/token）换算为字符。
  const budget =
    options?.budgetUnit === "tokens" ? Math.floor(budgetChars * charsPerTokenOfPack(pack)) : budgetChars
  const dump = JSON.stringify(pack)
  const prompt = [pack.task, ...(excludeOutline ? [] : [pack.outline]), pack.soulDoc].filter(Boolean).join("\n\n")
  if (dump.length <= budget) {
    return {
      pack,
      removed: [],
      remainingChars: dump.length,
      prompt,
      originalChars: dump.length,
      finalChars: dump.length,
      trimmedChars: 0,
      trimmedFields: [],
    }
  }
  const removed: Array<{ kind: string; label: string; chars: number }> = []
  const result: ContextPack = { ...pack }
  let total = dump.length
  // §GAP-89-02 dropOrder 有序丢弃（ainovel chapterWriterPrompt dropOrder +
  // context-compact.ts CONTEXT_DROP_ORDER 同源顺序：键集合完全一致 27 键，
  // techniqueBlocks 位置对齐 compact 顺序（recentChapterContents=80 →
  // recentSummaries=90 → characterAuras=100 → cognitionStates=110 →
  // relatedSettings=120 → techniqueBlocks=130）。超预算时先丢低优先级
  // 检索/引用段，高优先级（任务/大纲/canon/硬注入/禁区）不在表内永不丢弃。
  // 力学与旧表一致：数组段保留首元素，字符串段截断至 2000 字符。
  const fields: Array<[keyof ContextPack, string]> = [
    ["graphSearchResults", "图谱检索"],
    ["searchResults", "检索结果"],
    ["references", "引用检索"],
    ["referenceBindings", "素材引用绑定"],
    ["relatedChapters", "关联章节"],
    ["communitySummaries", "社区摘要"],
    ["kbReferences", "知识库引用"],
    ["recentChapterContents", "章节正文"],
    ["recentSummaries", "摘要"],
    ["characterAuras", "角色气质"],
    ["cognitionStates", "认知状态"],
    ["relatedSettings", "相关设定"],
    ["techniqueBlocks", "技法块"],
    ["previousChapterEnding", "上一章结尾"],
    ["timeline", "时间线"],
    ["characterStates", "人物状态"],
    ["foreshadowingStates", "伏笔状态"],
    ["soulDoc", "灵魂文档"],
    ["writingStyle", "写作风格"],
    ["voiceStyleGuide", "语音风格"],
    ["revisionDirectives", "修订指令"],
    ["nextChapterAdvice", "下章建议"],
    ["mustDo", "必须做"],
    ["chapterGoal", "章节目标"],
    ["recentStateDeltas", "状态变更"],
    ["narrativeVisibility", "叙事可见性"],
    ["worldBlueprint", "世界骨架"],
  ]
  for (const [key, label] of fields) {
    if (total <= budget) break
    const value = result[key]
    const anyResult = result as unknown as Record<string, unknown>
    if (Array.isArray(value) && value.length > 0) {
      // R4 共识（deepseek+qwen）: 原实现 re-insert 了同一数组（`[value[0], ...dropped]`），
      // “截断”是空操作，但 total 已被扣减 ⇒ 预算账目与实际内容分离，pack 依旧超限。
      const dropped = [...(value as unknown[])].slice(1)
      total -= JSON.stringify(dropped).length
      removed.push({ kind: "array-truncate", label, chars: dropped.length })
      anyResult[key as string] = [value[0]]
    } else if (typeof value === "string" && value.length > 0) {
      const cut = Math.max(0, value.length - 2_000)
      anyResult[key as string] = value.slice(0, 2_000)
      total -= cut
      removed.push({ kind: "string-truncate", label, chars: cut })
    }
  }
  const finalDump = JSON.stringify(result)
  return {
    pack: result,
    removed,
    remainingChars: Math.max(0, total),
    prompt: [result.task, ...(excludeOutline ? [] : [result.outline]), result.soulDoc].filter(Boolean).join("\n\n"),
    originalChars: dump.length,
    finalChars: finalDump.length,
    trimmedChars: Math.max(0, dump.length - finalDump.length),
    trimmedFields: removed.map((r) => r.label),
  }
}
