import { readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { useWikiStore, type LlmConfig, type NovelConfig, type EmbeddingConfig } from "@/stores/wiki-store"
import { streamChat, combineAbortSignals, DEFAULT_LLM_REQUEST_TIMEOUT_MS, isRequestCancelledError, type StreamCallbacks } from "@/lib/llm-client"
import { logger, toErrorMessage } from "@/lib/utils"
import type { ChatMessage } from "@/lib/llm-providers"
import { getOutputLanguage, buildLanguageReminder } from "@/lib/output-language"
import { canonicalizeSnapshotCharacters, writeSnapshotToWiki, writePatchFieldsToWiki } from "./graph-adapter"
// F4-3（Round-3 评估）：快照路径与渲染纯函数已拆至 ./snapshot-paths
//（chapter-ingest 拆分第 1 步）。本地 import 供内部调用点使用，并 re-export
// 保持既有 import 面不变。
export {
  snapshotFilePrefix,
  snapshotHistoryDir,
  snapshotHistoryFileName,
  snapshotJsonPath,
  snapshotMarkdownPath,
  snapshotSourceFileNameCandidates,
  snapshotToMarkdown,
  hasSnapshotSourceReference,
  isOnlyCurrentChapterSource,
} from "./snapshot-paths"
// W1（chapter-ingest 拆分第 5 步）：快照持久化原语已拆至 ./chapter-ingest-snapshot-io。
// 本地 import 供内部调用点使用，并 re-export 保持既有 import 面不变（70 个消费方零改动）。
import {
  backupSnapshotBeforeOverwrite,
  saveSnapshot,
} from "./chapter-ingest-snapshot-io"
export {
  backupSnapshotBeforeOverwrite,
  cleanupDeletedChapterResidualEntities,
  isNotFoundError,
  listSnapshots,
  loadSnapshot,
  saveChapterIngestOutput,
} from "./chapter-ingest-snapshot-io"
// W2（chapter-ingest 拆分第 6 步）：快照历史与当前快照物化已拆至 ./chapter-ingest-history。
// 本地 import 供内部调用点使用，并 re-export 保持既有 import 面不变。
import {
  loadValidMemorySnapshots,
  materializeNextCurrentSnapshot,
  readCurrentSnapshot,
} from "./chapter-ingest-history"
export {
  listSnapshotHistory,
  saveEditedSnapshot,
  type SnapshotHistoryEntry,
} from "./chapter-ingest-history"
// W3（chapter-ingest 拆分第 7 步）：fold 注册表与派生重建已拆至
// ./chapter-ingest-fold-registry。本地 import 供内部调用点使用（registerProjections
// 顶层注册调用仍在母文件，用本模块导出的 storeEntry/registryAliasMaps 构造条目），
// 并 re-export 保持既有 import 面不变。
import {
  cleanupSupersededEntityFiles,
  registryAliasMaps,
  selfHealFailedProjections,
  storeEntry,
  syncFoldProjectionIds,
  unfoldedDriftClasses,
  writeStructuredMemoryDocuments,
  type ProjectionSelfHealResult,
} from "./chapter-ingest-fold-registry"
export {
  cleanupSupersededEntityFiles,
  rebuildDerivedMemoryFromSnapshots,
  rebuildRegistryProjections,
  replayFailedProjectionsFromLedger,
  selfHealFailedProjections,
  type ProjectionSelfHealResult,
} from "./chapter-ingest-fold-registry"
// W4（chapter-ingest 拆分第 8 步）：真相折叠漂移比对/告警/自动修复已拆至
// ./chapter-ingest-drift。本地 import 供内部调用点使用，并 re-export 保面。
import {
  autoRepairTruthFoldDrift,
  sampleUnfoldedMemoryDriftSuspected,
} from "./chapter-ingest-drift"
export {
  autoRepairTruthFoldDrift,
  computeTruthFoldDrift,
  emitTruthFoldDriftAlarm,
  sampleTruthFoldDrift,
  type DriftAutoRepairResult,
  type TruthFoldDrift,
} from "./chapter-ingest-drift"
// W5（chapter-ingest 拆分第 9 步，收官）：LLM 抽取/JSON 解析与快照历史恢复/删除
// 已拆至 ./chapter-ingest-extraction。本地 import 供内部调用点使用，
// 并 re-export 保持既有 import 面不变（70 个消费方零改动）。
import {
  extractJsonObjectFromModelText,
  extractSnapshotWithLLM,
  normalizeOutlineIngestError,
} from "./chapter-ingest-extraction"
export {
  deleteChapterSnapshots,
  extractFirstBalancedJsonObject,
  extractJsonObjectFromModelText,
  extractSnapshotWithLLM,
  normalizeOutlineIngestError,
  restoreSnapshotHistory,
} from "./chapter-ingest-extraction"
// (A)-2（chapter-ingest 二次拆分第 1 步）：ingestChapter 的前置解析与守卫已拆至
// ./chapter-ingest-ingest-guards（判定顺序与 failReason 字面值零变化）。
import { resolveIngestTarget } from "./chapter-ingest-ingest-guards"
import { commitIngestSnapshot } from "./chapter-ingest-commit"
import { resolveNovelModel } from "./model-resolver"
// S5 首拆切片 #2（chapter-ingest 拆分第 2 步）：快照预览纯函数簇已拆至 ./snapshot-preview。
// 本地 import 供内部调用点使用，并 re-export 保持既有 import 面不变。
export { buildSnapshotMemorySyncPreview } from "./snapshot-preview"
// S5 切片 #3：community-summaries last-good 对已拆至 ./community-summary-recovery。
import {
  backupCommunitySummariesLastGood,
  restoreCommunitySummariesLastGood,
} from "./community-summary-recovery"
export {
  backupCommunitySummariesLastGood,
  restoreCommunitySummariesLastGood,
} from "./community-summary-recovery"
import { emptyCognitionState, mergeCognitionFromSnapshot, loadCognitionState, saveCognitionState } from "./character-cognition"
import { createEmptyCharacterStateStore, loadCharacterStates, saveCharacterStates } from "./character-state"
import { createEmptyForeshadowingStore, loadForeshadowingTracker, saveForeshadowingTracker } from "./foreshadowing-tracker"
import { createEmptyEmotionalArcStore, loadEmotionalArcs, saveEmotionalArcs } from "./emotional-arcs"
import { createEmptySubplotBoardStore, loadSubplotBoard, saveSubplotBoard } from "./subplot-board"
import { createEmptyResourceLedgerStore, loadResourceLedger, saveResourceLedger } from "./resource-ledger"
// E-03 (run-execute-1, 双库架构蓝图): 孤儿投影接线 — encounter-matrix /
// chapter-summaries / particle-ledger 三类真相文件的 fold 函数此前无生产调用者。
import { loadEncounterMatrix, saveEncounterMatrix, appendMeetingEdge, foldMeetingEdges, createEmptyEncounterMatrixStore } from "./encounter-matrix"
import { loadChapterSummaries, saveChapterSummaries, upsertChapterSummary, foldChapterSummary, createEmptyChapterSummariesStore } from "./chapter-summaries"
import { loadParticleLedger, saveParticleLedger, appendParticleEntry, foldParticleEntries, createEmptyParticleLedgerStore } from "./particle-ledger"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { shouldRebuildCommunitySummaries, generateCommunitySummaries } from "./community-summary"
import { createChapterPipeline } from "./chapter-pipeline"
// M13-3 切片 #4（arch-risk W4 god-object 拆分）：实体链接/校验家族已拆至
// ./chapter-ingest-entity-validation。本地 import 供 ingestChapter 调用点使用。
// ValidationWarning 类型留母文件（chapter-snapshot-normalize.ts 注释约束），
// 对外 export 符号名与签名零变化。
import { clearGraphCache } from "@/lib/graph-relevance"
import { clearTemporalFactsCache } from "./context-engine"
import { sliceChapterForReview } from "./chapter-window"
import {
  appendProjectionAuditEntry,
  loadProjectionStatusLedger,
  recordProjectionAudit,
  recordProjectionStatus,
  saveProjectionStatusLedger,
  registerProjections,
  shouldRetryLedgerSave,
  PROJECTION_REGISTRY,
  emptyLedger,
  type ProjectionAuditEntry,
  type ProjectionAuditStatus,
  type ProjectionFoldContext,
  type ProjectionStatusLedger,
} from "./projection-status-ledger"
// B2（守门四件套接线 · projection-self-heal 派生）：跳过集合与门槛的唯一事实源。
// mayEnterFoldReplay(projection, isRebuildable)：isSelfHealSkipClass 命中 →
// false（禁入自愈重算）；其余交由 isAutoRebuildableProjection 既有门槛。
import { computeCheckpointDigestOf } from "./checkpoint-digest"
import type { CanonDualWriteDeps, CanonDualWriteOp } from "./canon-dual-write"
import { shadowWriteCanon, replayPendingQueue } from "./canon-dual-write"

export interface ValidationWarning {
  type: "entity_new" | "canon_conflict" | "truth_authority_conflict"
  message: string
}

export interface CharacterDetail {
  identity: string
  faction: string
  goals: string
  arcChange: string
}

export interface LocationDetail {
  region: string
  type: string
  controller: string
  hiddenInfo: string
}

export interface OrganizationDetail {
  leader: string
  members: string
  goals: string
  resources: string
}

export interface ItemDetail {
  holder: string
  previousHolders: string
  abilities: string
  limitations: string
  origin: string
}

export interface EventDetail {
  cause: string
  process: string
  relatedForeshadowing: string
  relatedConflicts: string
  followUpItems: string
}

export interface ModalityFact {
  /** 认知主体（角色名；读端折叠 canonical name）。 */
  subject: string
  /** 认知谓词（认为/怀疑/假设…）。 */
  predicate: string
  /** 认知对象（事实内容；读端作为 object 渲染）。 */
  object: string
}

export interface ChapterSnapshot {
  chapterId: string
  chapterNumber: number
  chapterTitle?: string
  summary: string
  characters: string[]
  characterAliases?: Record<string, string[]>
  locations: string[]
  organizations: string[]
  items: string[]
  events: string[]
  characterStateChanges: string[]
  relationshipChanges: string[]
  knowledgeChanges: string[]
  foreshadowingChanges: string[]
  newCanonFacts: string[]
  /** T3 写端（路线 B）：角色认知事实（「X 认为…」）。可选，旧数据无此字段 → Assertive 保底。 */
  beliefFacts?: ModalityFact[]
  /** T3 写端（路线 B）：假设事实（「…假设…」）。可选，旧数据无此字段 → Assertive 保底。 */
  hypothesisFacts?: ModalityFact[]
  timelineEvents: string[]
  conflicts: string[]
  endingHook: string
  graphNodes: string[]
  graphEdges: string[]
  sourceType?: "chapter" | "outline"
  sourceSequence?: number
  revision?: number
  snapshotId?: string
  supersedes?: string
  isHistorical?: boolean
  entityIsNew?: Record<string, boolean>
  validationWarnings?: ValidationWarning[]
  memorySyncedAt?: string
  characterDetails?: Record<string, CharacterDetail>
  locationDetails?: Record<string, LocationDetail>
  organizationDetails?: Record<string, OrganizationDetail>
  itemDetails?: Record<string, ItemDetail>
  eventDetails?: Record<string, EventDetail>
  /**
   * P2-IMP-12 (M3a): 本章 POV 角色声明（快照人工真源）。由快照编辑面板人工填写，
   * 零新增 LLM 提取语义；旧数据无此字段（optional 向后兼容，normalize 缺省 undefined）。
   * 消费方 resolveChapterPovCharacter 读此字段解析 POV 角色 id；无值 → null
   * （保持世界层投影降级契约，绝不臆造 POV）。hardInjectEnabled 默认 false 不动（翻转归 M3b）。
   */
  povCharacter?: string
}


import {
  normalizeChapterSnapshot,
  buildAliasMapsFromSnapshot,
} from "./chapter-snapshot-normalize"


export type IngestFailReason = "no_llm" | "not_chapter" | "not_final" | "invalid_chapter_number" | "extract_failed" | "cancelled"

/**
 * P1-IMP-12：rebuild 重嵌契约常量（LightRAG chunk_schema 单真源模式）。
 * 向量重建的唯一源文本来自 snapshot.summary——非原始正文。
 * summary 缺失即跳过 + 告警（不伪造嵌入源）；全量重嵌另立显式函数（与 IMP-10 共用 expected-set）。
 */
export const REBUILD_REEMBED_SOURCE = "snapshot.summary" as const

export interface IngestResult {
  snapshot: ChapterSnapshot | null
  failReason?: IngestFailReason
  /**
   * R4（真相库失败投影账本可见与入口自愈收敛加固，方案 a）：入口自愈可观测 ——
   * 本次 ingest 入口自愈尝试的结果（attempted/healed/error）。仅成功路径携带；
   * 早退失败路径（failReason）为保持既有行为契约精确形状而省略本字段
   * （自愈尝试本身的 warn 日志仍保留）。向后兼容：可选字段，调用方可忽略。
   */
  selfHeal?: ProjectionSelfHealResult
  /**
   * R4（方案 a）：finally 账本落盘（含恰好 1 次重试）是否最终失败。
   * true = 两次写盘均失败但主链未阻断（snapshot 照常返回），调用方可凭此标记
   * 触发下次入口自愈收敛；false = 落盘成功；省略 = 未进入投影落盘段。
   */
  ledgerSaveFailed?: boolean
}

/**
 * ISS-20260709-023 (DC-7) 渐进式 DI: 可选 store 字段注入。传入时直接使用,
 * 缺省回退 useWikiStore.getState() 保持向后兼容。逐步消除 lib 层对
 * useWikiStore 的直接耦合, 使函数可脱离 UI store 独立测试。
 */
export interface IngestChapterOptions {
  llmConfig?: LlmConfig
  novelConfig?: NovelConfig
  novelMode?: boolean
  embeddingConfig?: EmbeddingConfig
  /**
   * ISS-20260709-023 (DC-7) 渐进式 DI: 社区摘要生成失败通知 callback。
   * 缺省回退 useWikiStore.getState().setCommunitySummaryError（向后兼容）。
   */
  onCommunitySummaryError?: (message: string) => void
  /**
   * T16 / F-14 (F-14) canon 影子双写 DI 注入。
   * 缺省 undefined → 不触发双写，向后兼容。
   */
  canonDualWriteDeps?: CanonDualWriteDeps
  /**
   * E-03 (run-execute-1, 双库架构蓝图): 显式 fold 时间戳。
   * 缺省 → 入口取一次墙钟全链下传; 传入固定值 → ingest 全链确定性 (可测)。
   */
  now?: string
}

// ──────────────────────────────────────────────────────────────────────────
// T16 / F-14: canon 影子双写钩子
// ──────────────────────────────────────────────────────────────────────────

/**
 * T16 / F-14: 双写守卫 — 仅 final/accepted 章放行。
 * reject 先于双写断言：pending/draft/outline/revised/archived 均拦截，
 * 非字符串 / 缺失 / 大小写不匹配（如 "FINAL"）也拦截。
 */
/**
 * facts-store 主语解析（54 号设计 ③，导出供 spec 直测）。
 * 冒号（：|:）优先；无冒号时取「是/属于/为」前作为切分点；
 * 「为」前一字为 名/称/作/因（名为/称为/作为/因为）时不切分（lookbehind），
 * 回退 rawFact 前 20 字。
 */
// ── 纯工具子模块（arch-risk W4 god-object 拆分）─────────────────────────
// parseFactsSubject/isCanonDualWriteEligible 已抽离到 chapter-ingest-utils.ts；
// extractFrontmatter* 同抽（并收敛 canonical parseFrontmatter）。import 供本模块
// 使用 + re-export 保持外部 import 路径不变。
import {
  isCanonDualWriteEligible,
} from "./chapter-ingest-utils"
export {
  extractFrontmatterNumber,
  extractFrontmatterString,
  isCanonDualWriteEligible,
  parseFactsSubject,
} from "./chapter-ingest-utils"

/**
 * T16 / F-14: 从 snapshot.newCanonFacts 派生 episode 双写操作集。
 * 每条事实的 digest = SHA-256({ chapter, fact })——幂等键。
 *
 * T3 写端（路线 B）：snapshot.beliefFacts / hypothesisFacts 派生 supersede
 * new_edges 边 ops（modality=belief/hypothesis）。幂等键保持旧键兼容：
 * digest=SHA-256({ chapter, modality, fact:subject+predicate+object })，
 * 与 assertive episode 键空间（{ chapter, fact }）天然不同，双写队列重放
 * 不会错配。缺省（无模态事实）返回 []——保底行为 = 现状，零倒退。
 */
export async function buildCanonDualWriteOps(snapshot: ChapterSnapshot): Promise<CanonDualWriteOp[]> {
  const facts = snapshot.newCanonFacts ?? []
  const beliefFacts = snapshot.beliefFacts ?? []
  const hypothesisFacts = snapshot.hypothesisFacts ?? []
  if (facts.length === 0 && beliefFacts.length === 0 && hypothesisFacts.length === 0) return []

  const episodeOps = facts.length > 0
    ? await Promise.all(
        facts.map(async (fact, i) => {
          const content = { chapter: snapshot.chapterNumber, fact }
          const digest = await computeCheckpointDigestOf(content)
          return {
            digest,
            content,
            legacyPayload: { kind: "snapshot_fact", chapterNumber: snapshot.chapterNumber, fact },
            canonPayload: {
              kind: "episode" as const,
              episode: {
                id: `ch${snapshot.chapterNumber}-fact${i}`,
                chapter_number: snapshot.chapterNumber,
                entity_id: snapshot.chapterId, // DEBT-20260820-16: ChapterSnapshot 无 entityId 字段，以 chapterId 作 entity_id（章节级实体）。fact 作为章节快照的事实片段，其归属实体为章节本身——此映射在 canon DDL v3 冻结下是唯一可靠来源。若未来 snapshot schema 新增 entityId 字段，应改为该字段。
                summary: fact,
                digest,
              },
            },
          }
        }),
      )
    : []

  // T3 路线 B：模态事实 → supersede new_edges 边 ops（纯插入，old_edge_ids 空）。
  const modalityOps = await Promise.all(
    [...beliefFacts.map((f) => ({ ...f, modality: "belief" as const })),
     ...hypothesisFacts.map((f) => ({ ...f, modality: "hypothesis" as const }))].map(
      async (mf, i) => {
        const content = {
          chapter: snapshot.chapterNumber,
          modality: mf.modality,
          fact: `${mf.subject}${mf.predicate}${mf.object}`,
        }
        const digest = await computeCheckpointDigestOf(content)
        return {
          digest,
          content,
          legacyPayload: {
            kind: "snapshot_modality_fact",
            chapterNumber: snapshot.chapterNumber,
            modality: mf.modality,
            subject: mf.subject,
            predicate: mf.predicate,
            object: mf.object,
          },
          canonPayload: {
            kind: "supersede" as const,
            request: {
              old_edge_ids: [],
              cap_chapter: snapshot.chapterNumber,
              caused_by: "snapshot-modality-facts",
              new_edges: [
                {
                  id: `ch${snapshot.chapterNumber}-modality${i}`,
                  source_id: mf.subject,
                  target_id: mf.object,
                  predicate: mf.predicate,
                  edge_kind: "world_fact",
                  valid_at: snapshot.chapterNumber,
                  modality: mf.modality,
                  digest,
                },
              ],
            },
          },
        }
      },
    ),
  )

  return [...episodeOps, ...modalityOps]
}

/**
 * T16 / F-14: 单点双写钩子——在 validateCanonConflicts 调用点后调用。
 * - deps 未注入 → 空操作（向后兼容）
 * - 章未 accept/final → reject，不写 canon
 * - 无新正史事实 → 无操作
 * - final + 事实 → 调 shadowWriteCanon
 * - 双写异常 → 非致命告警，不阻断
 */
export async function runCanonDualWriteHook(
  deps: CanonDualWriteDeps | undefined,
  projectPath: string,
  fm: Record<string, unknown>,
  snapshot: ChapterSnapshot,
  now: number,
): Promise<void> {
  if (!deps) return
  if (!isCanonDualWriteEligible(fm)) return

  // R4 共识（deepseek+glm）: 原先在 try 外构建 ops，且调用方（ingestChapter）未包 try
  // ⇒ 构建抛错会冲出「非致命钩子」契约，成为未处理 rejection。
  try {
    const ops = await buildCanonDualWriteOps(snapshot)
    if (ops.length === 0) return
    // E-05 (C-4/C-6): T16 钩子传 promoteChannel="canon-dual-write" ——
    // reconcile 一致时对 episode 类 ops 批量晋升（凭证层落盘 + 事件日志）。
    const report = await shadowWriteCanon(deps, projectPath, ops, now, "canon-dual-write")
    if (report.queued > 0) {
      logger.warn("Chapter Ingest", `Canon dual-write: ${report.queued}/${ops.length} ops queued (non-fatal)`)
    }
    // 55 号设计 W1-3 (54⑤ 收尾): 消费对账报告——重放后仍不一致时告警带 divergences digest。
    // 只增日志, 不参与任何门控 (对账差异不得阻断生成)。
    if (report.reconcile && report.reconcile.consistent === false) {
      logger.warn("Chapter Ingest", "Canon dual-write: reconcile divergences remain after replay", {
        divergences: report.reconcile.divergences,
      })
    }
  } catch (err) {
    logger.warn("Chapter Ingest", "Canon dual-write hook failed (non-fatal)", {
      error: toErrorMessage(err),
    })
  }
}

/**
 * R4（真相库失败投影账本可见与入口自愈收敛加固，方案 a）：finally 账本落盘
 * （含恰好 1 次重试）。是否重试由 projection-status-ledger 的纯函数
 * shouldRetryLedgerSave(0) 判定（attempt 语义：首次失败 attempt=0，可再试 1 次）。
 *
 * 永不抛错：首次成功返回 true；首次失败则 warn 后重试一次，重试成功返回 true，
 * 两次均失败记 warn 并返回 false（调用方记 IngestResult.ledgerSaveFailed=true，
 * 主链不阻断，下次 ingest 入口自愈收敛）。幂等：落盘内容为同一 ledger 文档的
 * 全量覆写，重试不收窄提交边界、不引入跨文件事务。
 */
export async function saveProjectionLedgerWithSingleRetry(
  projectPath: string,
  ledger: ProjectionStatusLedger,
): Promise<boolean> {
  try {
    await saveProjectionStatusLedger(projectPath, ledger)
    return true
  } catch (firstErr) {
    logger.warn("Chapter Ingest", "ProjectionStatusLedger save failed, retrying once (non-fatal)", {
      error: toErrorMessage(firstErr),
    })
  }
  if (!shouldRetryLedgerSave(0)) return false
  try {
    await saveProjectionStatusLedger(projectPath, ledger)
    return true
  } catch (retryErr) {
    logger.warn("Chapter Ingest", "ProjectionStatusLedger save failed", { error: toErrorMessage(retryErr) })
    return false
  }
}

export async function ingestChapter(
  projectPath: string,
  chapterPath: string,
  _reviewModel?: string,
  signal?: AbortSignal,
  options: IngestChapterOptions = {},
): Promise<IngestResult> {
  // (A)-2：前置解析与 5 个早退判定已抽至 ./chapter-ingest-ingest-guards。
  // 判定顺序与 failReason 字面值、以及「novelMode 关闭时不带 failReason」的
  // 形状差异均为既有对外契约，搬迁零改动。
  const target = await resolveIngestTarget(projectPath, chapterPath, options)
  if (!target.ok) return target.result
  const { pp, runtimeLlmConfig, llmConfig, novelConfig, chapterNumber, body, content } = target
  const fm = target.fm

  // 55 号设计 W2-3 (54⑤ 收尾): replayPendingQueue 独立触发 — 每次 ingest 开头
  // 先重放积压双写队列 (LLM 提取前), 避免积压写无限延迟; 失败仅 warn 不阻断。
  try {
    const deps = options.canonDualWriteDeps
    if (deps) {
      const report = await replayPendingQueue(deps, pp, Date.now())
      if (report.remaining > 0) {
        logger.warn("Chapter Ingest", `Canon dual-write: ${report.remaining} pending ops remain after replay (non-fatal)`)
      }
    }
  } catch (err) {
    logger.warn("Chapter Ingest", "Canon dual-write replay failed (non-fatal)", {
      error: toErrorMessage(err),
    })
  }

  // P2-IMP-14: failed 自愈（落地 F-002 注释承诺，闭合 P2-N3）——账本中存在
  // failed && fold_rebuildable && 注册表 rebuildable 的投影时，本次 ingest 入口
  // 先经注册表从 committed 快照序列确定性重建这些类（只重建失败类，不碰
  // 非确定性 graph/vector），再继续本章增量。自愈失败仅告警不阻断（原 failed
  // 状态在账本保留可见）。
  // R4（方案 a）：自愈结果进 IngestResult.selfHeal 可观测（成功/异常两路均赋值）。
  let entrySelfHeal: ProjectionSelfHealResult = { attempted: false, healed: [] }
  try {
    entrySelfHeal = await selfHealFailedProjections(pp, { now: options.now })
    if (entrySelfHeal.healed.length > 0) {
      logger.info(
        "Chapter Ingest",
        `failed 投影自愈：${entrySelfHeal.healed.length} 类已按注册表重建（${entrySelfHeal.healed.join(", ")}）`,
      )
    }
  } catch (err) {
    entrySelfHeal = { attempted: false, healed: [], error: toErrorMessage(err) }
    logger.warn("Chapter Ingest", "failed 投影自愈异常（非致命，继续本章摄取）", {
      error: toErrorMessage(err),
    })
  }

  if (signal?.aborted) return { snapshot: null, failReason: "cancelled" }
  let extractedSnapshot
  try {
    extractedSnapshot = await extractSnapshotWithLLM(chapterNumber, body, runtimeLlmConfig, signal)
  } catch (err) {
    // R4 共识（qwen+glm）: 流中途取消/超时会抛出（而不是走上面的 signal.aborted 分支），
    // 使取消变成 reject。取消是已建模的 failReason，应如实返回；其它错误继续抛出。
    if (signal?.aborted || (err instanceof Error && isRequestCancelledError(err))) {
      return { snapshot: null, failReason: "cancelled" as IngestFailReason }
    }
    throw err
  }
  let snapshot = extractedSnapshot ? canonicalizeSnapshotCharacters(extractedSnapshot) : null

  if (!snapshot) {
    return { snapshot: null, failReason: "extract_failed" as IngestFailReason }
  }

  /* v8 ignore next */
  if (snapshot) {
    // (A)-3：提交点（实体链接/校验 → 快照落盘 → 摄取产物 → memory-op 预演
    // → facts-store → canon 双写钩子）已抽至 ./chapter-ingest-commit。
    // 三个非致命 try/catch 的吞错边界与日志文案零变化。
    // runCanonDualWriteHook 以依赖注入传入，避免母模块 ↔ 本模块运行时循环。
    await commitIngestSnapshot({
      pp,
      snapshot,
      fm: fm as Record<string, unknown>,
      canonDualWriteDeps: options.canonDualWriteDeps,
      runCanonDualWriteHook,
    })
  }

  const embCfg = options.embeddingConfig ?? useWikiStore.getState().embeddingConfig

  // F-002 (ANL-010 / C-002): commit-then-project. The commit point above
  // (saveSnapshot + saveChapterIngestOutput, per-file-atomic via
  // writeFileAtomic) is the immutable fact layer. Everything below is a
  // DERIVED projection — each runs independently and is tracked by the
  // ProjectionStatusLedger so a mid-ingest failure is VISIBLE and
  // recoverable instead of silently swallowed (the prior 8-segment
  // error-handlers only console.warn'd, leaving corrupted projections
  // undetectable). On failure: idempotent/fold_rebuildable projections are
  // rebuilt on the next ingest via rebuildFromCommittedSnapshot;
  // mutates_existing_non_rebuildable (graph) triggers delete+re-fold.
  //
  // Single error-handler wraps the whole projection loop (was 7 independent
  // handlers) — a projection's failure is recorded to the ledger and
  // the loop CONTINUES to the next projection, so one bad projection does
  // not skip the rest. The ledger is persisted after the loop.
  let projectionLedger: ProjectionStatusLedger
  try {
    projectionLedger = await loadProjectionStatusLedger(pp)
  } /* v8 ignore start */ catch {
    // #4（账本 v2）：load 抛错（损坏/缺失）→ 空账本必须带 schemaVersion，否则违反接口契约。
    // 用 emptyLedger() 保持与其余路径同构（schemaVersion/projections/chapters/auditTrail）。
    projectionLedger = emptyLedger()
  } /* v8 ignore stop */
  // CORR-111 fix: derive chapterNo from the frontmatter-validated chapter
  // number (line ~392, available regardless of snapshot extraction outcome),
  // NOT from `snapshot?.chapterNumber ?? 0`. The vector projection below runs
  // OUTSIDE the `if (snapshot)` guard (it uses content/fm, not snapshot), so
  // when extraction fails (snapshot === null) the prior `?? 0` recorded the
  // embedding under chapter 0 — orphaning the ledger entry and risking a
  // duplicate embedding on re-ingest under the real number. Frontmatter
  // validation already guarantees chapterNumber > 0 here (invalid numbers
  // early-return at the parseChapterNumber guard above).
  const chapterNo = chapterNumber
  // CORR-007: captured from inside runProjection('sync_snapshot_to_memory')
  // so the return value can carry memorySyncedAt (runProjection returns void).
  let memorySyncedAt: string | undefined
  // R4（方案 a）：finally 落盘（含 1 次重试）最终失败标记（成功路径经 return 携带）。
  let ledgerSaveFailed = false

  // F-005 (v2.6 Tier2): single audit choke-point for projection events.
  // Keeps the in-memory ledger's auditTrail in sync (so the end-of-loop
  // saveProjectionStatusLedger cannot clobber per-event durable flushes back
  // off disk) AND durably appends each event to projection-status.json so a
  // hard crash mid-ingest still leaves the emitted events on disk. Strictly
  // additive — never throws into the projection loop.
  const recordProjectionAuditEvent = async (
    projection: string,
    status: ProjectionAuditStatus,
    durationMs: number,
    error?: string,
  ): Promise<void> => {
    const entry: ProjectionAuditEntry = {
      projection,
      chapter: chapterNo,
      status,
      durationMs,
      ...(error !== undefined ? { error } : {}),
      timestamp: new Date().toISOString(),
    }
    projectionLedger = recordProjectionAudit(projectionLedger, entry)
    try {
      await appendProjectionAuditEntry(pp, entry)
    } catch (err) {
      logger.warn("Chapter Ingest", "Projection audit append failed (non-fatal)", {
        error: toErrorMessage(err),
      })
    }
  }

  const runProjection = async (
    projection: string,
    fn: () => Promise<void>,
  ): Promise<void> => {
    // F-005: time the full projection body for the audit entry.
    const startedAt = Date.now()
    try {
      await fn()
      projectionLedger = recordProjectionStatus(projectionLedger, chapterNo, projection, "committed")
      await recordProjectionAuditEvent(projection, "committed", Date.now() - startedAt)
    } catch (err) {
      const message = toErrorMessage(err)
      logger.warn("Chapter Ingest", `Projection "${projection}" failed`, { error: message })
      projectionLedger = recordProjectionStatus(projectionLedger, chapterNo, projection, "failed", message)
      await recordProjectionAuditEvent(projection, "failed", Date.now() - startedAt, message)
    }
  }

  try {
    // single_snapshot_idempotent: vector embedding.
    if (embCfg.enabled && embCfg.model) {
      await runProjection("vector", async () => {
        const { embedPage } = await import("@/lib/embedding")
        /* v8 ignore next */
        const pageId = chapterPath.split(/[/\\]/).pop()?.replace(/\.md$/, "") ?? ""
        if (pageId) {
          const title = typeof fm?.title === "string" ? fm.title : pageId
          await embedPage(pp, pageId, title, content, embCfg)
        }
      })
    }

    /* v8 ignore next */
    if (snapshot) {
      // PERF-NEW-05: compute alias maps once for this snapshot and reuse across
      // all projection closures (was recomputed 4x — character/cognition/
      // emotional-arc/resource-ledger — for the same snapshot).
      const aliasMaps = buildAliasMapsFromSnapshot(snapshot)
      // E-03 (run-execute-1): fold 纯性 — 入口取一次显式时间戳, 全链下传
      // (fold 函数体内禁止隐式时钟; 传入固定 now 时 ingest 全链确定性可测)。
      // P2-IMP-14: aliasMaps 随注册表 fold 上下文下传（PERF-NEW-05 复用保留）。
      const foldCtx: ProjectionFoldContext = {
        now: options.now ?? new Date().toISOString(),
        aliasMaps,
      }
      // mutates_existing_non_rebuildable: graph entity pages (writeSnapshotToWiki).
      await runProjection("graph_entity_pages", async () => {
        const writtenPaths = await writeSnapshotToWiki(pp, snapshot)
        if (writtenPaths.length > 0) {
        }
      })

      // mutates_existing_non_rebuildable: graph wiki-patch fields.
      // CORR-009 fix: distinct ledger key from the snapshot-write above so the
      // ledger can independently track each path's commit/fail status (the
      // prior shared 'graph_entity_pages' key masked partial failures).
      await runProjection("graph_entity_patch_fields", async () => {
        const patchPath = `${pp}/.novel/chapter-ingest-output/${String(snapshot.chapterNumber).padStart(3, "0")}.wiki-patch.json`
        const patchJson = await readFile(patchPath)
        const patch = JSON.parse(patchJson)
        const patchPaths = await writePatchFieldsToWiki(pp, patch)
        if (patchPaths.length > 0) {
        }
      })

      // P2-IMP-14: 9 个 store-backed fold_rebuildable 投影经注册表同源遍历
      // （ingest 增量路径）——与 rebuild / drift 重放 / sync 路径共用同一
      // applyToStore fold（新增投影只改注册表一处，四路径自动覆盖，F5 类
      // 「某路径漏投影」缺陷结构上绝迹）。shouldApply 保留既有条件接线语义
      // （cognition/character/foreshadow 仅在有变更时记账）。
      for (const [projection, entry] of Object.entries(PROJECTION_REGISTRY)) {
        if (!entry.applyToStore || !entry.load || !entry.save || !entry.createEmpty) continue
        if (entry.shouldApply && !entry.shouldApply(snapshot)) continue
        await runProjection(projection, async () => {
          const loaded = await entry.load!(pp)
          const base = loaded ?? entry.createEmpty!(foldCtx)
          await entry.save!(pp, entry.applyToStore!(base, snapshot, foldCtx))
        })
      }

      // fold_rebuildable: summary_structured_memory.
      await runProjection("summary_structured_memory", async () => {
        const memoryPaths = await exportStructuredMemoryToWiki(pp, snapshot)
        /* v8 ignore next */
        if (memoryPaths.length > 0) {
        }
      })
    }

    // CORR-007 fix: syncSnapshotToMemory runs inside the projection ledger
    // (was outside the try/finally, exempt from the F-002 recoverable-failure
    // contract — a sync failure threw unhandled while the ledger already
    // claimed success). Tracked as fold_rebuildable.
    /* v8 ignore next */
    if (snapshot) {
      await runProjection("sync_snapshot_to_memory", async () => {
        const res = await syncSnapshotToMemory(pp, snapshot)
        memorySyncedAt = res.memorySyncedAt
      })
    }
  } finally {
    // Persist the ledger regardless of whether the loop threw — a partially-
    // updated ledger still tells the next ingest which projections need rebuild.
    // R4（方案 a）：经 saveProjectionLedgerWithSingleRetry 落盘（含恰好 1 次重试）；
    // 两次均失败仅记 ledgerSaveFailed=true（成功路径返回携带），永不阻断主链。
    ledgerSaveFailed = !(await saveProjectionLedgerWithSingleRetry(pp, projectionLedger))
  }

  // 社区摘要定期重建
  if (snapshot && shouldRebuildCommunitySummaries(snapshot.chapterNumber, novelConfig)) {
    const rebuildCommunitySummaries = async () => {
      // F-005: the scheduled community-summary rebuild is audited with the
      // dedicated "rebuild" status on success; failures are audited as
      // "failed" + error alongside the existing non-fatal warn/UI path.
      // recordProjectionAuditEvent cannot reject (internal non-fatal catch),
      // and audit calls stay OUTSIDE the summary try/catch so an audit hiccup
      // could never be misreported as a summary failure.
      const rebuildStartedAt = Date.now()
      await backupCommunitySummariesLastGood(pp)
      try {
        await generateCommunitySummaries(pp, llmConfig, novelConfig)
      } catch (err) {
        const message = toErrorMessage(err)
        logger.warn("Chapter Ingest", "社区摘要生成失败", { error: message })
        await restoreCommunitySummariesLastGood(pp)
        await recordProjectionAuditEvent("community_summary", "failed", Date.now() - rebuildStartedAt, message)
        // 弹窗提示（通过 store 触发 UI 通知）
        // ISS-20260709-023 (DC-7) 渐进式 DI: 注入 callback 优先, 缺省回退 store。
        const onErr = options.onCommunitySummaryError ?? ((msg: string) => useWikiStore.getState().setCommunitySummaryError(msg))
        onErr(message)
        return
      }
      await recordProjectionAuditEvent("community_summary", "rebuild", Date.now() - rebuildStartedAt)
    }

    if (novelConfig.communitySummaryAsync) {
      // 后台异步执行，不阻塞章节摄取
      void rebuildCommunitySummaries()
    } else {
      // 同步等待
      await rebuildCommunitySummaries()
    }
  }

  return { snapshot: { ...snapshot, memorySyncedAt }, selfHeal: entrySelfHeal, ledgerSaveFailed }
}

export const ingestChapterPipeline = createChapterPipeline({ ingestChapter })


// P2-IMP-08 登记：saveEditedSnapshot 为死导出（无调用方；仅 context-engine.ts:1307
// 注释引用）。处置随 Q8 族产品裁决（与 syncSnapshotToMemory 的彻底层重建同族，pending）。

/** 51 号报告 G4: 将快照投影为影响分析文本（实体名 + 关键内容字段拼接）。 */
// 已拆至 ./snapshot-preview（S5 首拆切片 #2），此处保留注释锚点，函数由 import 提供。

/** 51 号报告 G4: 从快照派生影响分析 stores（角色/伏笔/canon 事实；subplot 不在快照内留空）。 */
// 已拆至 ./snapshot-preview（S5 首拆切片 #2）。

// appendPreviewSection + buildSnapshotMemorySyncPreview 已拆至 ./snapshot-preview（S5 首拆切片 #2）。


export async function exportStructuredMemoryToWiki(projectPath: string, snapshot: ChapterSnapshot): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const snapshots = await loadValidMemorySnapshots(pp, snapshot)
  if (snapshots.length === 0) {
    return []
  }
  return writeStructuredMemoryDocuments(pp, snapshots)
}


// P2-IMP-08（CORR-2 修正落点，三模型共识）：syncSnapshotToMemory 直写 3 类
// （character-states / cognition-state / foreshadowing-tracker），其余 6 类
// （encounter-matrix / chapter-summaries / subplot-board / emotional-arcs /
// particle-ledger / resource-ledger）不经本条路径 fold。返回前对未 fold 的 6 类
// 做定向 drift 采样（复用 computeTruthFoldDrift 单类比较逻辑：live 盘上 store vs
// committed 快照重放 canonical 哈希比对），结果并入返回值 driftSuspected:string[]，
// 供 UI 提示「N 类记忆未同步，建议执行全量重建」。采样失败（mock/缺文件）债务记
// trace、返回 []，绝不阻断 sync。P2-IMP-14：sync 直写类清单（SYNC_FOLD_PROJECTION_IDS）
// 与未 fold 文件集合同源注册表派生；P2-IMP-15：采样到漂移后经注册表自动重建漂移类，
// 复测仍漂移才保留 driftSuspected（告警升级）。
// P2-IMP-14：sync 直写类清单（原 SYNC_FOLD_PROJECTION_IDS 硬编码 3 元已删除）
// 与未 fold 文件集合同源注册表派生（syncFoldProjectionIds/unfoldedDriftClasses）。
// P2-IMP-15：采样到漂移后经注册表自动重建漂移类，
// 复测仍漂移才保留 driftSuspected（告警升级）。

/** P2-IMP-14：sync 直写类清单由注册表 syncDirectWrite 标志派生（消除硬编码 3 元）。 */

/** P2-IMP-14：sync 路径不 fold 的 drift 文件集合由注册表派生（全部 store 文件 − sync 直写 3 类）。 */


export interface SyncSnapshotToMemoryResult {
  writtenEntityPaths: string[]
  memoryPagePaths: string[]
  memorySyncedAt: string
  /**
   * P2-IMP-08：未 fold 的 6 类定向 drift 采样（live vs 快照重放）中被判定漂移的
   * 文件名；空数组 = 健康（正常无漂移不误报）。
   */
  driftSuspected: string[]
}

// backup/restoreCommunitySummariesLastGood 已拆至 ./community-summary-recovery（S5 切片 #3）。

export async function syncSnapshotToMemory(
  projectPath: string,
  snapshot: ChapterSnapshot,
  onDataVersionBump?: () => void,
): Promise<SyncSnapshotToMemoryResult> {
  const pp = normalizePath(projectPath)
  const currentSnapshot = await readCurrentSnapshot(pp, snapshot.chapterNumber)
  const memorySyncedAt = new Date().toISOString()
  const normalizedSnapshot = normalizeChapterSnapshot(
    { ...snapshot, memorySyncedAt },
    { chapterId: snapshot.chapterId, chapterNumber: snapshot.chapterNumber },
  )
  /* v8 ignore next */
  if (!normalizedSnapshot) {
    throw new Error("Invalid snapshot data.")
  }
  const syncedSnapshot = materializeNextCurrentSnapshot(normalizedSnapshot, currentSnapshot)

  const writtenEntityPaths = await writeSnapshotToWiki(pp, syncedSnapshot)
  await cleanupSupersededEntityFiles(pp, syncedSnapshot, writtenEntityPaths)

  // PERF-NEW-08 / ARCH-005 (odyssey-improve DC-3+DC-4+maintainability-M):
  // The previous inline block here duplicated cleanupSupersededEntityFiles
  // (called on the line above) verbatim — same writtenFileNames filter,
  // same shouldDeleteSupersededProjectionContent check, same
  // snapshotSourceFiles includes + onlyCurrentSource guard. Running it a
  // second time re-read every entity file (serial IPC, N round-trips) only
  // to find them already deleted by the call above (readFile fails → catch
  // skip). Removed the duplicate; cleanupSupersededEntityFiles (now
  // parallelized via PERF-NEW-08) is the single source of truth for
  // superseded-entity cleanup. ARCH-005（#3 清偿 2026-09-07）：sync 路径已改
  // 注册表遍历 applyToStore（下方 P2-IMP-14 块），不再直调 sync*Changes 助手；
  // 残余 SoC 债（per-class 审计记账）见 projection-status-ledger 注释与 project.md 顺延登记。

  // P2-IMP-14: sync 路径同源遍历注册表（cognition/character/foreshadow 三类增量
  // fold，P2-IMP-08 边界保留：其余 6 类不经本路径，由 drift 采样 + IMP-15 自愈
  // 兜底）。ctx 传空对象——保留既有 sync 语义（无 now → 保留输入时间戳；
  // aliasMaps 按快照自建）；shouldApply 保留三类条件接线语义。
  for (const id of syncFoldProjectionIds()) {
    const entry = PROJECTION_REGISTRY[id]
    if (!entry?.applyToStore || !entry.load || !entry.save || !entry.createEmpty) continue
    if (entry.shouldApply && !entry.shouldApply(syncedSnapshot)) continue
    // #6①（三模型共识 2026-09-07）：per-class 审计记账——成功写 committed、
    // 失败写 failed+error（失败不阻断循环，审计 append 自身 non-fatal）。
    // 统一 sync_snapshot_to_memory 总事件由 runProjection 路径保留。
    const startedAt = Date.now()
    try {
      const loaded = await entry.load(pp)
      const base = loaded ?? entry.createEmpty({})
      await entry.save(pp, entry.applyToStore(base, syncedSnapshot, {}))
      await appendProjectionAuditEntry(pp, {
        projection: id,
        chapter: syncedSnapshot.chapterNumber,
        status: "committed",
        durationMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      })
    } catch (err) {
      try {
        await appendProjectionAuditEntry(pp, {
          projection: id,
          chapter: syncedSnapshot.chapterNumber,
          status: "failed",
          durationMs: Date.now() - startedAt,
          error: toErrorMessage(err),
          timestamp: new Date().toISOString(),
        })
      } catch (auditErr) {
        // 审计 append 失败绝不断 sync 主流程
        // ISS-20260709-025 PAT-IM2: 记诊断，控制流不变。
        logger.warn("Chapter Ingest", "projection audit append failed (non-fatal)", { projection: id, error: toErrorMessage(auditErr) })
      }
    }
  }

  await backupSnapshotBeforeOverwrite(pp, syncedSnapshot.chapterNumber)
  await saveSnapshot(pp, syncedSnapshot)
  const memoryPagePaths = await exportStructuredMemoryToWiki(pp, syncedSnapshot)
  // ARCH-005/EG-006 (REG-001 sibling): syncSnapshotToMemory rewrites the
  // current snapshot + entity pages + cognition/character/foreshadow stores,
  // so the mtime-keyed temporalFactsCache may hold pre-sync facts. clearGraphCache
  // alone is insufficient (temporalFactsCache is a separate module-level cache).
  // ARCH-005 SoC（#3 清偿 2026-09-07 刷新）：本路径已走注册表遍历 applyToStore
  //（P2-IMP-14 块），不再直调 sync*Changes 助手；残余账本记账债见 project.md 顺延登记。
  // 具体缓存失效缺口（REG-001 sibling）已在此修复。
  clearTemporalFactsCache(pp)
  clearGraphCache()
  // ISS-20260709-023 (DC-7) 渐进式 DI: 注入 callback 优先, 缺省回退 store。
  const bump = onDataVersionBump ?? (() => useWikiStore.getState().bumpDataVersion())
  bump()

  // P2-IMP-08：返回前对未 fold 的 6 类做定向 drift 采样（复用 computeTruthFoldDrift
  // 单类比较逻辑）；结果并入返回值 driftSuspected，UI 据此提示全量重建。
  let driftSuspected = await sampleUnfoldedMemoryDriftSuspected(pp)
  // P2-IMP-15：sync 后 drift>0 → 自动经注册表 rebuild 漂移类（确定性 fold 安全，
  // 非确定性投影不自动）→ 复测仍>0 才保留 driftSuspected（告警升级由
  // autoRepairTruthFoldDrift 内部完成）。
  if (driftSuspected.length > 0) {
    const repair = await autoRepairTruthFoldDrift(pp, { trigger: "sync" })
    const unfolded = unfoldedDriftClasses()
    driftSuspected = repair.stillDriftedFiles.filter((f) => unfolded.has(f))
  }

  return { writtenEntityPaths, memoryPagePaths, memorySyncedAt, driftSuspected }
}


// ── apply 函数族并入 store-apply 子模块（arch-risk W4 补）─────────────────
// parseCharacterStateChange/parseForeshadowingChange/isDeathStatus/normalizeForeshadowName/
// foreshadowNamesMatch/applyCharacterStateChangesToStore/applyForeshadowingChangesToStore
// 已并入 chapter-ingest-store-apply.ts（同 fold 家族）——projection 块可完整抽离。
import {
  applyCharacterStateChangesToStore,
  applyForeshadowingChangesToStore,
} from "./chapter-ingest-store-apply"
export {
  applyCharacterStateChangesToStore,
  applyForeshadowingChangesToStore,
} from "./chapter-ingest-store-apply"
// ── store-apply 子模块（arch-risk W4 god-object 拆分）─────────────────────
// applyEmotionalArcsToStore/applyResourceLedgerToStore/applySubplotChangesToStore
// 已抽离到 chapter-ingest-store-apply.ts；import 供本模块使用 + re-export。
import {
  applyEmotionalArcsToStore,
  applyResourceLedgerToStore,
  applySubplotChangesToStore,
} from "./chapter-ingest-store-apply"
export {
  applyEmotionalArcsToStore,
  applyResourceLedgerToStore,
  applySubplotChangesToStore,
} from "./chapter-ingest-store-apply"

// ============================================================================
// P2-IMP-14: PROJECTION_REGISTRY 填充（容器/类型/注册校验在
// projection-status-ledger.ts；实现在本文件 — fold helper 与 store 模块都
// 聚合于此，避免 ledger ↔ chapter-ingest 运行时循环导入）。
//
// 关键结构约束：storeEntry() 把 foldFromSnapshot（全量重放）定义为
// createEmpty + 逐快照 applyToStore（增量 fold）的 reduce — 即 ingest 增量 /
// rebuild 重放 / drift 比对重放三条路径用的是同一个 applyToStore 函数引用，
// F5 类「某路径 fold 实现分叉」缺陷结构上不可能发生。graph/vector/community
// 等非确定性投影以 rebuildable:false 入表（三方键集等值成员，不参与自动
// 自愈）；snapshot / chapter_ingest_output 是提交点本体，同样标 false。
// ============================================================================

/** 别名表解析：ingest 传入预计算表（PERF-NEW-05）；rebuild/drift 按快照自建。 */

/**
 * store-backed fold_rebuildable 投影的注册条目工厂：load/save/createEmpty/
 * applyToStore 由调用方提供，foldFromSnapshot 自动派生（同源保证）。
 */

registerProjections({
  // —— 9 个 store-backed fold_rebuildable 投影（drift 9 类同源）——
  cognition: storeEntry("cognition-state.json", {
    load: loadCognitionState,
    createEmpty: () => emptyCognitionState(),
    applyToStore: (store, snapshot, ctx) =>
      mergeCognitionFromSnapshot(store, snapshot, registryAliasMaps(ctx, snapshot)),
    save: saveCognitionState,
    shouldApply: (snapshot) => snapshot.knowledgeChanges.length > 0,
    syncDirectWrite: true,
  }),
  character: storeEntry("character-states.json", {
    load: loadCharacterStates,
    createEmpty: () => createEmptyCharacterStateStore(),
    applyToStore: (store, snapshot, ctx) =>
      applyCharacterStateChangesToStore(store, snapshot, registryAliasMaps(ctx, snapshot), ctx),
    save: saveCharacterStates,
    shouldApply: (snapshot) => snapshot.characterStateChanges.length > 0,
    syncDirectWrite: true,
  }),
  foreshadow: storeEntry("foreshadowing-tracker.json", {
    load: loadForeshadowingTracker,
    createEmpty: () => createEmptyForeshadowingStore(),
    applyToStore: (store, snapshot, ctx) => applyForeshadowingChangesToStore(store, snapshot, ctx),
    save: saveForeshadowingTracker,
    shouldApply: (snapshot) => snapshot.foreshadowingChanges.length > 0,
    syncDirectWrite: true,
  }),
  emotional_arc: storeEntry("emotional-arcs.json", {
    load: loadEmotionalArcs,
    createEmpty: (ctx) => createEmptyEmotionalArcStore(ctx.now),
    applyToStore: (store, snapshot, ctx) =>
      applyEmotionalArcsToStore(store, snapshot, registryAliasMaps(ctx, snapshot), ctx),
    save: saveEmotionalArcs,
  }),
  resource_ledger: storeEntry("resource-ledger.json", {
    load: loadResourceLedger,
    createEmpty: () => createEmptyResourceLedgerStore(),
    applyToStore: (store, snapshot, ctx) =>
      applyResourceLedgerToStore(store, snapshot, registryAliasMaps(ctx, snapshot), ctx),
    save: saveResourceLedger,
  }),
  subplot_board: storeEntry("subplot-board.json", {
    load: loadSubplotBoard,
    createEmpty: (ctx) => createEmptySubplotBoardStore(ctx.now),
    applyToStore: (store, snapshot, ctx) => applySubplotChangesToStore(store, snapshot, ctx),
    save: saveSubplotBoard,
  }),
  encounter_matrix: storeEntry("encounter-matrix.json", {
    load: loadEncounterMatrix,
    createEmpty: () => createEmptyEncounterMatrixStore(),
    applyToStore: (store, snapshot, ctx) => {
      let next = store
      for (const edge of foldMeetingEdges(snapshot, registryAliasMaps(ctx, snapshot))) {
        next = appendMeetingEdge(next, edge, ctx)
      }
      return next
    },
    save: saveEncounterMatrix,
  }),
  chapter_summaries: storeEntry("chapter-summaries.json", {
    load: loadChapterSummaries,
    createEmpty: () => createEmptyChapterSummariesStore(),
    applyToStore: (store, snapshot, ctx) =>
      upsertChapterSummary(store, foldChapterSummary(snapshot), ctx),
    save: saveChapterSummaries,
  }),
  particle_ledger: storeEntry("particle-ledger.json", {
    load: loadParticleLedger,
    createEmpty: () => createEmptyParticleLedgerStore(),
    applyToStore: (store, snapshot, ctx) => {
      let next = store
      for (const entry of foldParticleEntries(snapshot, registryAliasMaps(ctx, snapshot))) {
        next = appendParticleEntry(next, entry, ctx)
      }
      return next
    },
    save: saveParticleLedger,
  }),
  // —— 非 store 型投影入表（三方键集等值成员；rebuildable 标记驱动自愈门槛）——
  // 结构化记忆文档：rebuild 经 writeStructuredMemoryDocuments 确定性重建。
  summary_structured_memory: {
    category: "fold_rebuildable",
    rebuildable: true,
    file: null,
    rebuildFromSnapshots: async (projectPath, snapshots) => {
      await writeStructuredMemoryDocuments(projectPath, snapshots)
    },
  },
  // sync 是复合用户路径（实体页 + 快照物化 + 3 类 store），rebuild 不等价于
  // 重放该路径 → 不自动自愈（failed 保留可见）。
  sync_snapshot_to_memory: { category: "fold_rebuildable", rebuildable: false, file: null },
  // 非确定性 / 提交点投影：标 non-rebuildable（不入自动重建遍历）。
  vector: { category: "single_snapshot_idempotent", rebuildable: false, file: null },
  snapshot: { category: "single_snapshot_idempotent", rebuildable: false, file: null },
  chapter_ingest_output: { category: "single_snapshot_idempotent", rebuildable: false, file: null },
  graph_entity_pages: { category: "mutates_existing_non_rebuildable", rebuildable: false, file: null },
  graph_entity_patch_fields: { category: "mutates_existing_non_rebuildable", rebuildable: false, file: null },
  community_summary: { category: "mutates_existing_non_rebuildable", rebuildable: false, file: null },
})

/**
 * P2-IMP-14：经注册表重建可确定性重建的投影（rebuild / failed 自愈 / drift
 * 自动修复三条遍历共用同一函数）。onlyIds 缺省 = 全部 rebuildable 条目；
 * 传入子集 = 只重建该子集（failed 自愈只重建 failed 类，drift 修复只重建
 * 漂移类）。返回实际重建的投影 id。
 */

/**
 * F-002 (ANL-010 R4 / C-002): rebuild ALL derived projections from the
 * committed snapshot sequence. Previously `rebuildDerivedMemoryFromSnapshots`
 * only re-derived cognition / character / foreshadow / structured-memory
 * (the `fold_rebuildable` ledger category) — vector and graph projections
 * were NOT rebuilt, so a corrupted vector index or stale graph entity page
 * could not be recovered without re-running ingest.
 *
 * This extended rebuild now covers:
 *   - fold_rebuildable: cognition / character / foreshadow / structured-memory
 *     (re-derived by folding the snapshot sequence from empty — unchanged)
 *   - mutates_existing_non_rebuildable: graph entity pages — delete+re-fold
 *     via cleanupSupersededEntityFiles + writeSnapshotToWiki (the delete-first
 *     rebuild path; the supersession model in graph-adapter preserves version
 *     history during normal ingest, but a full rebuild clears stale pages)
 *   - single_snapshot_idempotent (vector): re-embed each chapter from its
 *     snapshot content (idempotent — re-embedding the same content yields the
 *     same vector state; safe to retry)
 *
 * LanceDB has NO transaction API (ANL-010 C4), so this is a per-projection
 * rebuild, not a single atomic transaction — the ProjectionStatusLedger
 * tracks each projection's rebuild status so a mid-rebuild crash leaves a
 * partially-rebuilt but detectable state.
 */

/**
 * F-002: backward-compatible alias. Existing callers (restoreSnapshotHistory,
 * deleteChapterSnapshots) reference rebuildDerivedMemoryFromSnapshots; route
 * them to the extended rebuildFromCommittedSnapshot covering vector+graph.
 */

// ============================================================================
// P2-IMP-14: failed 自愈（ingest 入口）——账本 failed && fold_rebuildable &&
// 注册表 rebuildable → 经注册表从 committed 快照序列确定性重建。
// ============================================================================


/**
 * 扫描投影账本：存在 failed && fold_rebuildable && 注册表 rebuildable 的投影时，
 * 只重建这些失败类（非确定性 graph/vector/community 不参与，注册表
 * rebuildable:false 的 fold_rebuildable 条目如 sync_snapshot_to_memory 也不参与）。
 * 成功 → 对应 cell 改记 committed 并追加 "rebuild" 审计事件；失败 → 保留 failed
 * 可见，仅告警。由 ingestChapter 入口自动调用，也可单测直调。
 */

/**
 * R4（真相库失败投影账本可见与入口自愈收敛加固，方案 a）：账本失败投影重放
 * 薄包装 —— 唯一对外重放入口。零新增语义：原样委托 selfHealFailedProjections
 *（同参同返），不复制遍历/门槛/记账逻辑，门槛仍以 PROJECTION_REGISTRY +
 * mayEnterFoldReplay 为唯一事实源。ingestChapter 入口内部仍直调
 * selfHealFailedProjections（热路径零间接），本包装供外部调用方/单测显式重放。
 */

// ============================================================================
// E-03 (run-execute-1, 双库架构蓝图): truth_fold_drift 可执行定义
// ============================================================================

/**
 * E-03 (C-8): 单类真相文件的 drift 比对结果。
 * liveHash = 盘上 store 的稳定哈希; replayHash = 从 committed snapshot 序列
 * 重放 (fold from empty) 的稳定哈希。哈希经 canonicalizeForHash 剔除易变元数据
 * (lastUpdated / fileVersion / At$ 墙钟字段), 认识论字段 validAt/invalidAt/
 * revealedAt 是数据不剔除 (GLM D-GLM2 裁决)。
 */

/**
 * E-03 (C-8): 逐类比对 live 盘上 store vs 从 committed snapshot 序列重放的
 * store。归属 chapter-ingest.ts 锚点 (rebuild 的只读副产品, 与
 * rebuildFromCommittedSnapshot 同域内聚; 不新建文件)。
 *
 * 判定: drifted = liveHash !== replayHash; 任一类 drifted → truth_fold_drift > 0
 * → 按 PRO-STO-04 告警并阻断 (不静默降级)。
 *
 * @param now 重放时注入的显式时间戳 (缺省 "" — 重放不产生新时间戳, 纯性优先)。
 */

/**
 * P2-IMP-06：sampleTruthFoldDrift — computeTruthFoldDrift 的安全采样包装。
 * 失败债务记 trace 不阻断（restore/delete 尾部调用，不应因 drift 采样失败而回滚重建）。
 * 返回 drifted 文件数（0=健康）；不可采集/异常 → null（N/A，不告警）。
 */

/**
 * P2-IMP-06：drift 告警真实触发——drift>0 时 logger.warn + 写 .novel/telemetry/
 * drift-<ts>.jsonl（GOV-OBS-01 不静默降级）。drift=0/N-A 零告警。阻断逻辑不写
 * （留 arch 产品裁决）。返回是否告警。
 */

// ============================================================================
// P2-IMP-15: drift 自动修复（启动/restore/delete/sync 后自愈闭环）。
// 漂移类 → 经注册表确定性重建（只重建注册表 rebuildable 条目；非确定性投影
// 不自动）→ 复测仍>0 才告警升级（IMP-06 通道）；自愈事件写 telemetry。
// ============================================================================


/** 自愈事件 telemetry（.novel/telemetry/selfheal-<ts>.jsonl；GOV-OBS-01 可审计）。 */

/**
 * drift 自动修复主入口（P2-IMP-15）：
 *   1. 采样（IMP-06 sampleTruthFoldDrift）；N/A → 零动作不告警（诚实降级）；
 *   2. drift=0 → 零动作（误报护栏：健康态绝不碰盘、绝不写 telemetry）；
 *   3. drift>0 → 漂移文件经注册表映射到确定性 fold 类，只重建这些类
 *      （rebuildRegistryProjections 子集模式；非确定性投影不入映射集 → 不自动）；
 *   4. 复测：仍>0 → emitTruthFoldDriftAlarm 告警升级；=0 → 记自愈成功日志；
 *   5. 自愈事件（含升级/失败）一律写 selfheal telemetry。
 */


/**
 * 列出章节快照对应章号（大纲为负数）。
 *
 * `failLoud`（默认 false）仅放行「目录不存在」→ []，其它 IO 异常继续抛出：
 * 章节目录等需要诚实错误态的调用方应传 true，否则权限/IO 失败会被显示成「暂无章节」。
 */


export async function ingestOutline(
  projectPath: string,
  outlinePath: string,
  signal?: AbortSignal,
  options: IngestChapterOptions = {},
): Promise<ChapterSnapshot | null> {
  const pp = normalizePath(projectPath)
  // ISS-20260709-023 (DC-7) 渐进式 DI: 注入优先, 缺省回退 store（向后兼容）
  const llmConfig = options.llmConfig ?? useWikiStore.getState().llmConfig
  const novelConfig = options.novelConfig ?? useWikiStore.getState().novelConfig
  // 使用 resolveNovelModel 正确解析提取模型（含供应商配置切换），与 ingestChapter 保持一致
  const runtimeLlmConfig = resolveNovelModel(llmConfig, novelConfig, "extract")
  if (!hasUsableLlm(runtimeLlmConfig)) return null

  const content = await readFile(outlinePath)
  const body = sliceChapterForReview(content)

  // 从文件路径提取大纲名称作为标题
  const normalizedOutlinePath = normalizePath(outlinePath)
  /* v8 ignore next */
  const fileName = normalizedOutlinePath.split("/").pop() ?? "outline"
  const outlineName = fileName.replace(/\.\w+$/, "") // 去掉扩展名，如 "总大纲"、"人物小传"

  // 根据文件名生成唯一的负数 chapterNumber（不同大纲不会互相覆盖）
  // 使用文件名的简单哈希生成 1-999 范围的数字
  let hash = 0
  for (let i = 0; i < outlineName.length; i++) {
    hash = ((hash << 5) - hash + outlineName.charCodeAt(i)) | 0
  }
  const outlineNumber = -(Math.abs(hash % 999) + 1) // -1 到 -999
  const chapterId = `outline-${outlineName}`

  const outputLang = getOutputLanguage()
  const langReminder = buildLanguageReminder(outputLang)

  const systemPrompt = `你是一个专业的小说编辑助手。请从大纲中提取初始设定信息，输出 JSON。${langReminder}`

  const userPrompt = `请从以下大纲中提取初始设定：

${body}

输出 JSON：
{
  "chapterId": "outline-init",
  "chapterNumber": 0,
  "summary": "大纲摘要",
  "characters": ["初始人物"],
  "locations": ["初始地点"],
  "organizations": ["初始组织/势力"],
  "items": ["关键物品"],
  "events": ["背景事件"],
  "characterStateChanges": ["人物初始状态"],
  "relationshipChanges": ["人物初始关系"],
  "knowledgeChanges": [],
  "foreshadowingChanges": ["初始伏笔"],
  "newCanonFacts": ["世界观正史设定"],
  "timelineEvents": ["时间线背景"],
  "conflicts": ["核心冲突"],
  "endingHook": "",
  "graphNodes": ["图谱节点列表"],
  "graphEdges": ["图谱关系边，格式：A->关系->B。关系必须是以下之一：出场于|发生于|属于|持有|敌对|合作|怀疑|隐瞒|知道|不知道|推进伏笔|回收伏笔|新增伏笔|导致|揭示|影响|位于"]
}`

  try {
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]

    let result = ""
    let streamError: Error | null = null
    const callbacks: StreamCallbacks = {
      onToken: (token: string) => { result += token },
      onDone: () => {},
      onError: (error: Error) => { streamError = error },
    }

    await streamChat(runtimeLlmConfig, messages, callbacks, combineAbortSignals(signal, AbortSignal.timeout(DEFAULT_LLM_REQUEST_TIMEOUT_MS)))
    if (streamError) throw streamError

    const jsonText = extractJsonObjectFromModelText(result)
    if (!jsonText) {
      // ISS-20260712-002 (PAT-G2 twin recurrence #10, sibling of ISS-026
      // PAT-ID1 @2012): LLM returned no parseable JSON object at all.
      // Previously threw, contradicting the ISS-026 comment @2002-2009 which
      // explicitly states "Return null here honors the Promise<ChapterSnapshot
      // | null> contract and lets the caller route to the friendly
      // ingestFailedNotification" — the throw blocked exactly that route,
      // sending the caller (outline-generation.ts:703 → :707-719) into the
      // catch branch with the raw error.message instead of the i18n
      // ingestFailedNotification. Return null here aligns the no-JSON path
      // with the JSON.parse SyntaxError path @2016 and honors the contract
      // the ISS-026 comment already claimed. Spec S-20260711-6ed4.
      // ISS-20260712-REL-1: 失败汇总收敛 — 附 outline 名 + 脱敏原因（控制流不变，仍返回 null 走友好降级）。
      logger.error("Outline Ingest", "ingestOutline: model returned no parseable JSON object", { outline: outlineName })
      return null
    }

    // ISS-026 (PAT-ID1, sibling of extractSnapshotWithLLM@821): wrap the parse
    // so a malformed/truncated/code-fence-leaking outline JSON throws a bare
    // SyntaxError that escapes via the catch@2017 -> normalizeOutlineIngestError
    // throw path, bypassing the caller's (outline-generation.ts:708) friendly
    // `snapshot ? 'done' : 'error'` UX branch (only reachable via the no-LLM
    // early-exit return null @1930). Return null here honors the
    // Promise<ChapterSnapshot | null> contract and lets the caller route to
    // the friendly ingestFailedNotification. A non-SyntaxError re-throws.
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch (error) {
      /* v8 ignore next */
      if (error instanceof SyntaxError) {
        // ISS-20260712-REL-1: 附 outline 名汇总（脱敏 message，不含原文）。
        logger.error("Outline Ingest", "Malformed outline JSON", { outline: outlineName, error: error.message })
        return null
      }
      throw error
    }
    const record = (parsed ?? {}) as Record<string, unknown>
    const snapshot = normalizeChapterSnapshot({
      ...record,
      chapterId,
      chapterNumber: outlineNumber,
      chapterTitle: outlineName,
      entityIsNew: {},
      validationWarnings: [],
    }, { chapterId, chapterNumber: outlineNumber })
    /* v8 ignore next */
    if (!snapshot) {
      // ISS-20260712-003 (PAT-G2 twin recurrence #10, third adjacent sibling of
      // ISS-026 PAT-ID1 @2012 + ISS-20260712-002 @2008): normalizeChapterSnapshot
      // returns null when the LLM emitted valid JSON but the top-level value is
      // not an object (e.g. a JSON array / string / number — see
      // normalizeChapterSnapshot @241). Previously threw, which — exactly like
      // the !jsonText path @2008 — contradicted the ISS-026 comment @2030-2031
      // claiming "lets the caller route to the friendly ingestFailedNotification"
      // and sent outline-generation.ts:703 → :707-713 into the catch branch with
      // the raw "Outline snapshot payload is invalid." instead of the i18n
      // ingestFailedNotification. Return null here aligns the third null path
      // (normalize null) with the two already-fixed ones (no-JSON @2008 +
      // SyntaxError @2038) and mirrors extractSnapshotWithLLM @859 which
      // correctly propagates normalizeChapterSnapshot's null to its caller.
      // Spec S-20260711-6ed4: parse/structure-validation failure must route to
      // the caller's friendly degrade, not bare-throw past it.
      // ISS-20260712-REL-1: 附 outline 名汇总。
      logger.error("Outline Ingest", "normalizeChapterSnapshot returned null: parsed payload is not a valid snapshot object", { outline: outlineName })
      return null
    }

    const syncResult = await syncSnapshotToMemory(pp, snapshot)
    return { ...snapshot, memorySyncedAt: syncResult.memorySyncedAt }
  } catch (err) {
    // ISS-20260712-REL-1: 附 outline 名汇总（脱敏 message；控制流不变，仍 throw 归一化错误）。
    logger.error("Outline Ingest", "Failed", { outline: outlineName, error: toErrorMessage(err) })
    throw normalizeOutlineIngestError(err)
  }
}
