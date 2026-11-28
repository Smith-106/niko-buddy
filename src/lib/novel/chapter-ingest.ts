import { readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { useWikiStore, type LlmConfig, type NovelConfig, type EmbeddingConfig } from "@/stores/wiki-store"
import { streamChat, combineAbortSignals, DEFAULT_LLM_REQUEST_TIMEOUT_MS, isRequestCancelledError, type StreamCallbacks } from "@/lib/llm-client"
import { logger, toErrorMessage } from "@/lib/utils"
import type { ChatMessage } from "@/lib/llm-providers"
import { getOutputLanguage, buildLanguageReminder } from "@/lib/output-language"
import { canonicalizeSnapshotCharacters, writeSnapshotToWiki } from "./graph-adapter"
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
  archiveSnapshotJson,
  backupSnapshotBeforeOverwrite,
  readSnapshotForReplacement,
  saveSnapshot,
  withSnapshotWriteLock,
} from "./chapter-ingest-snapshot-io"
import { assertUniqueFinalChapterSource } from "./snapshot-scanner"
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
  type DeleteChapterSnapshotsOptions,
} from "./chapter-ingest-extraction"
// (A)-2（chapter-ingest 二次拆分第 1 步）：ingestChapter 的前置解析与守卫已拆至
// ./chapter-ingest-ingest-guards（判定顺序与 failReason 字面值零变化）。
import { resolveIngestTarget } from "./chapter-ingest-ingest-guards"
import {
  commitIngestSnapshot,
  type CanonDualWriteOutcome,
  type CommitIngestSnapshotResult,
  type IngestCommitReceipt,
  type IngestSourceBinding,
  type IngestSourceRead,
} from "./chapter-ingest-commit"
import { recoverInterruptedCommunitySummaryAttempts, runIngestProjections, type RunIngestProjectionsResult } from "./chapter-ingest-projections"
import { resolveNovelModel } from "./model-resolver"
// S5 首拆切片 #2（chapter-ingest 拆分第 2 步）：快照预览纯函数簇已拆至 ./snapshot-preview。
// 本地 import 供内部调用点使用，并 re-export 保持既有 import 面不变。
export { buildSnapshotMemorySyncPreview } from "./snapshot-preview"
// S5 切片 #3：community-summaries last-good 对已拆至 ./community-summary-recovery。
export {
  backupCommunitySummariesLastGood,
  restoreCommunitySummariesLastGood,
} from "./community-summary-recovery"
import { emptyCognitionState, mergeCognitionFromSnapshot, loadCognitionState, saveCognitionFoldPreservingTelemetry } from "./character-cognition"
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
  type ProjectionAuditEntry,
  emptyLedger,
  mergeProjectionLedgerDelta,
  recordProjectionStatus,
  registerProjections,
  shouldRetryLedgerSave,
  PROJECTION_REGISTRY,
  type ProjectionStatusLedger,
  withProjectionStoreWriteLock,
} from "./projection-status-ledger"
// B2（守门四件套接线 · projection-self-heal 派生）：跳过集合与门槛的唯一事实源。
// mayEnterFoldReplay(projection, isRebuildable)：isSelfHealSkipClass 命中 →
// false（禁入自愈重算）；其余交由 isAutoRebuildableProjection 既有门槛。
import type { RawCanonEdge } from "./canon-graph-client"
import { computeCheckpointDigest, computeCheckpointDigestOf } from "./checkpoint-digest"
import type { CanonDualWriteDeps, CanonDualWriteOp } from "./canon-dual-write"
import {
  canonPendingQueuePath,
  defaultCanonDualWriteDeps,
  loadPendingQueue,
  replayPendingQueue,
  resolvePriorEdgesForSupersede,
  shadowWriteCanon,
} from "./canon-dual-write"
import { setCanonMigrationMode } from "./novel-session-status"
import { replayPromotionRetryQueue } from "./promotion-bridge"

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
} from "./chapter-snapshot-normalize"


export type IngestFailReason =
  | "no_llm"
  | "not_chapter"
  | "not_final"
  | "invalid_chapter_number"
  | "duplicate_chapter_number"
  | "extract_failed"
  | "cancelled"
  /** 提交前同路径完整内容与本次提取读取不一致（本次不提交）。 */
  | "source_changed"
  /** 提交前同路径源已不可读（本次不提交；入口初次 read 的既有行为不变）。 */
  | "source_unavailable"

/**
 * P1-IMP-12：rebuild 重嵌契约常量（LightRAG chunk_schema 单真源模式）。
 * 向量重建的唯一源文本来自 snapshot.summary——非原始正文。
 * summary 缺失即跳过 + 告警（不伪造嵌入源）；全量重嵌另立显式函数（与 IMP-10 共用 expected-set）。
 */
export const REBUILD_REEMBED_SOURCE = "snapshot.summary" as const

export interface IngestProjectionError {
  stage: "source_fence" | "projection_runner"
  message: string
}

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
   * 触发下次入口自愈收敛；false = 落盘成功；省略 = 本次未得到明确落盘结果。
   */
  ledgerSaveFailed?: boolean
  /** 提取已提交，但投影围栏或 runner 异常；不伪造单个投影的失败凭证。 */
  projectionError?: IngestProjectionError
  /**
   * 本次提交点实际绑定的无正文源引用（仅成功路径；早退失败/跳过不携带）。
   * 缺失 = 未绑定，不能读作 bound。legacy 无 sourceRead 直调 commit 时为 null。
   */
  sourceBinding?: IngestSourceBinding
  /** 本次 commit 调用的实际 Canon 双写 outcome（skip/failed/completed 原样）。 */
  canonOutcome?: CanonDualWriteOutcome
  /** 本次提交点瞬时 receipt（源 SHA + 实际写入 snapshot 身份/JSON SHA + Canon outcome）。 */
  receipt?: IngestCommitReceipt
  /** facts.json 读写失败标志（仅 committed 路径携带；拒绝/早退不携带）。 */
  factsStoreFailed?: boolean
  /** 本次投影落盘失败的投影 id（committed 路径；全成功 = 空数组）。 */
  failedProjections?: readonly string[]
  /** 本次实际 committed 的投影 id（ledger 记 committed 时列入）。 */
  committedProjections?: readonly string[]
  /** deferred（异步）已调度但本次未验证结果的投影 id；不并入 failed。 */
  pendingProjections?: readonly string[]
  /** sync 持久化链 receipt（extraction 归档 + 物化快照身份/JSON SHA；无持久化链不携带）。 */
  projectionReceipt?: IngestProjectionReceipt
}

/**
 * sync 阶段持久化链 receipt：extraction 归档路径 + saveSnapshot 实际写盘的
 * snapshotId/revision + 同序列化 JSON SHA。不含正文。
 */
export interface IngestProjectionReceipt {
  extractionHistoryPath: string
  snapshotId: string
  revision: number
  snapshotJsonSha256: string
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
  /**
   * 批处理回读验证用：传入 true 时 async 社区摘要也同步等待结果。
   * 缺省 → 保持普通异步 defer 语义（结果计入 pendingProjections）。
   */
  awaitCommunitySummary?: boolean
  /**
   * 显式单章再摄取：提交前在快照写锁内复核所选文件是该章号唯一正式源。
   * 仅 handleReingest 传入 true；自动/保存路径不改默认策略。
   */
  requireUniqueFinalChapter?: boolean
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
  collectSnapshotKnownBy,
  findMatchingPriorEdgeIds,
  isCanonDualWriteEligible,
  parseCanonFactTriple,
} from "./chapter-ingest-utils"
export {
  collectSnapshotKnownBy,
  extractFrontmatterNumber,
  extractFrontmatterString,
  findMatchingPriorEdgeIds,
  isCanonDualWriteEligible,
  parseCanonFactTriple,
  parseFactsSubject,
} from "./chapter-ingest-utils"

export interface BuildCanonDualWriteOpsOptions {
  /** 可选：用于按目标实体/谓词查询先序活跃 world_fact 边以填充 `old_edge_ids`（IPC 不可用时非致命回退 `[]`）。 */
  projectPath?: string
  /** 可选：直接注入现存边快照（优先于 `projectPath` IPC 查询，用于单测与离线计算）。 */
  existingEdges?: readonly RawCanonEdge[]
}

/**
 * T16 / F-14 + v2.35: 从 snapshot.newCanonFacts 同时派生：
 *   1. 既有 `episode` 双写操作（digest = SHA-256({ chapter, fact })，legacyPayload.kind = 'snapshot_fact'，逐字节向后兼容）；
 *   2. 可查询的 `world_fact` `supersede` 边操作（digest = SHA-256({ chapter, kind: 'world_fact', fact, sourceId, predicate, targetId })，
 *      携带归一化 `known_by`、`source_chapter`、`revealed_at` 与真实先序冲突 `old_edge_ids`）。
 *
 * T3 写端（路线 B）：snapshot.beliefFacts / hypothesisFacts 派生 supersede
 * new_edges 边 ops（modality=belief/hypothesis），同样携带 `known_by` / `source_chapter` / `revealed_at`
 * 并在传入 `options?.existingEdges` / `options?.projectPath` 时解析先序同模态冲突边 `old_edge_ids`。
 * 单参调用 `buildCanonDualWriteOps(snapshot)` 保持纯函数确定性（零 IPC）。
 */
export async function buildCanonDualWriteOps(
  snapshot: ChapterSnapshot,
  options?: BuildCanonDualWriteOpsOptions,
): Promise<CanonDualWriteOp[]> {
  const facts = snapshot.newCanonFacts ?? []
  const beliefFacts = snapshot.beliefFacts ?? []
  const hypothesisFacts = snapshot.hypothesisFacts ?? []
  if (facts.length === 0 && beliefFacts.length === 0 && hypothesisFacts.length === 0) return []

  const snapshotKnownBy = collectSnapshotKnownBy(snapshot)

  const episodeOps = facts.length > 0
    ? await Promise.all(
        facts.map(async (fact) => {
          const content = { chapter: snapshot.chapterNumber, fact }
          const digest = await computeCheckpointDigestOf(content)
          return {
            digest,
            content,
            legacyPayload: { kind: "snapshot_fact", chapterNumber: snapshot.chapterNumber, fact },
            canonPayload: {
              kind: "episode" as const,
              episode: {
                id: `ch${snapshot.chapterNumber}-ep-${digest.slice(0, 12)}`,
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

  const worldFactDrafts = facts.length > 0
    ? await Promise.all(
        facts.map(async (fact) => {
          const { sourceId, predicate, targetId } = parseCanonFactTriple(fact, snapshot.chapterId)
          const content = {
            chapter: snapshot.chapterNumber,
            kind: "world_fact" as const,
            fact,
            sourceId,
            predicate,
            targetId,
          }
          const digest = await computeCheckpointDigestOf(content)
          const edge = {
            id: `ch${snapshot.chapterNumber}-wf-${digest.slice(0, 12)}`,
            source_id: sourceId,
            target_id: targetId,
            predicate,
            edge_kind: "world_fact" as const,
            valid_at: snapshot.chapterNumber,
            source_chapter: snapshot.chapterNumber,
            revealed_at: snapshot.chapterNumber,
            known_by: snapshotKnownBy,
            modality: "assertive" as const,
            digest,
          }
          return {
            digest,
            content,
            legacyPayload: {
              kind: "snapshot_world_fact",
              chapterNumber: snapshot.chapterNumber,
              fact,
              subject: sourceId,
              predicate,
              object: targetId,
            },
            edge,
          }
        }),
      )
    : []

  // T3 路线 B：模态事实 → supersede new_edges 边 ops（带 holder known_by / source_chapter / revealed_at）。
  const modalityDrafts = await Promise.all(
    [...beliefFacts.map((f) => ({ ...f, modality: "belief" as const })),
     ...hypothesisFacts.map((f) => ({ ...f, modality: "hypothesis" as const }))].map(
      async (mf) => {
        const content = {
          chapter: snapshot.chapterNumber,
          modality: mf.modality,
          fact: `${mf.subject}${mf.predicate}${mf.object}`,
        }
        const digest = await computeCheckpointDigestOf(content)
        const edge = {
          id: `ch${snapshot.chapterNumber}-mod-${digest.slice(0, 12)}`,
          source_id: mf.subject,
          target_id: mf.object,
          predicate: mf.predicate,
          edge_kind: "world_fact" as const,
          valid_at: snapshot.chapterNumber,
          source_chapter: snapshot.chapterNumber,
          revealed_at: snapshot.chapterNumber,
          known_by: collectSnapshotKnownBy(snapshot, [mf.subject]),
          modality: mf.modality,
          digest,
        }
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
          edge,
        }
      },
    ),
  )

  let priorEdges: readonly RawCanonEdge[] = []
  const candidateEdges = [
    ...worldFactDrafts.map((d) => d.edge),
    ...modalityDrafts.map((d) => d.edge),
  ]
  if (candidateEdges.length > 0) {
    if (options?.existingEdges) {
      priorEdges = options.existingEdges
    } else if (options?.projectPath) {
      priorEdges = await resolvePriorEdgesForSupersede(options.projectPath, candidateEdges)
    }
  }

  const worldFactOps: CanonDualWriteOp[] = worldFactDrafts.map((d) => ({
    digest: d.digest,
    content: d.content,
    legacyPayload: d.legacyPayload,
    canonPayload: {
      kind: "supersede" as const,
      request: {
        old_edge_ids: findMatchingPriorEdgeIds(priorEdges, snapshot.chapterNumber, d.edge),
        cap_chapter: snapshot.chapterNumber,
        caused_by: "snapshot-world-facts",
        new_edges: [d.edge],
      },
    },
  }))

  const modalityOps: CanonDualWriteOp[] = modalityDrafts.map((d) => ({
    digest: d.digest,
    content: d.content,
    legacyPayload: d.legacyPayload,
    canonPayload: {
      kind: "supersede" as const,
      request: {
        old_edge_ids: findMatchingPriorEdgeIds(priorEdges, snapshot.chapterNumber, d.edge),
        cap_chapter: snapshot.chapterNumber,
        caused_by: "snapshot-modality-facts",
        new_edges: [d.edge],
      },
    },
  }))

  return [...episodeOps, ...worldFactOps, ...modalityOps]
}

/**
 * T16 / F-14: 单点双写钩子——在 validateCanonConflicts 调用点后调用。
 * - deps 未注入 → 空操作（向后兼容）
 * - 章未 accept/final → reject，不写 canon
 * - 无新正史事实 → 无操作
 * - final + 事实 → 调 shadowWriteCanon
 * - 双写异常 → 非致命告警，不阻断
 *
 * 保留既有 `Promise<void>` 契约（外部调用方只依赖副作用）。需要逐次实
 * outcome 的提交点用下方 `runCanonDualWriteHookOutcome`。
 */
export async function runCanonDualWriteHook(
  deps: CanonDualWriteDeps | undefined,
  projectPath: string,
  fm: Record<string, unknown>,
  snapshot: ChapterSnapshot,
  now: number,
): Promise<void> {
  await runCanonDualWriteHookOutcome(deps, projectPath, fm, snapshot, now)
}

/**
 * T16 / F-14 plus 提交点结果连接：与 `runCanonDualWriteHook` 同一实现与副作用，
 * 额外返回 discriminated outcome。只透传既有 ShadowWriteReport/skip/error，
 * 不新增 canon schema/payload/队列/晋升语义，也不篡改非致命行为。
 */
export async function runCanonDualWriteHookOutcome(
  deps: CanonDualWriteDeps | undefined,
  projectPath: string,
  fm: Record<string, unknown>,
  snapshot: ChapterSnapshot,
  now: number,
): Promise<CanonDualWriteOutcome> {
  if (!deps) return { status: "skipped", reason: "no_deps" }
  if (!isCanonDualWriteEligible(fm)) return { status: "skipped", reason: "not_eligible" }

  // R4 共识（deepseek+glm）: 原先在 try 外构建 ops，且调用方（ingestChapter）未包 try
  // ⇒ 构建抛错会冲出「非致命钩子」契约，成为未处理 rejection。
  try {
    const ops = await buildCanonDualWriteOps(snapshot, { projectPath })
    if (ops.length === 0) return { status: "skipped", reason: "no_facts" }
    // E-05 (C-4/C-6) + R3-M01: T16 钩子传 promoteChannel="canon-dual-write" 与真实 snapshot.revision ——
    // reconcile 一致时对 episode 类 ops 批量晋升（凭证层落盘 + 事件日志）。
    const snapshotRevision =
      typeof snapshot.revision === "number" &&
      Number.isInteger(snapshot.revision) &&
      snapshot.revision >= 1
        ? snapshot.revision
        : 1
    const report = await shadowWriteCanon(
      deps,
      projectPath,
      ops,
      now,
      "canon-dual-write",
      snapshotRevision,
    )
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
    if (report.written > 0 && report.queued === 0 && report.reconcile?.consistent === true) {
      try {
        const pending = await loadPendingQueue(deps, canonPendingQueuePath(projectPath))
        if (pending.length === 0) {
          await setCanonMigrationMode(projectPath, "dual", {
            onlyIfUnset: true,
            createIfMissing: false,
            now: new Date(now).toISOString(),
          })
        }
      } catch (promoteErr) {
        logger.warn("Chapter Ingest", "Canon dual-write: canon_migration auto-promotion failed (non-fatal)", {
          error: toErrorMessage(promoteErr),
        })
      }
    }
    return { status: "completed", report }
  } catch (err) {
    logger.warn("Chapter Ingest", "Canon dual-write hook failed (non-fatal)", {
      error: toErrorMessage(err),
    })
    return { status: "failed", reason: toErrorMessage(err) }
  }
}

/**
 * R4（真相库失败投影账本可见与入口自愈收敛加固，方案 a）：finally 账本增量合并
 * （含恰好 1 次重试）。是否重试由 projection-status-ledger 的纯函数
 * shouldRetryLedgerSave(0) 判定（attempt 语义：首次失败 attempt=0，可再试 1 次）。
 *
 * 永不抛错：首次成功返回 true；首次失败则 warn 后重试一次，重试成功返回 true，
 * 两次均失败记 warn 并返回 false（调用方记 IngestResult.ledgerSaveFailed=true，
 * 主链不阻断，下次 ingest 入口自愈收敛）。每次都在账本锁内将同一份增量合并到
 * 最新文档，保留其他写入且不重复追加已落盘的补写审计。
 */
export async function saveProjectionLedgerWithSingleRetry(
  projectPath: string,
  ledger: ProjectionStatusLedger,
  expected?: ProjectionStatusLedger["chapters"],
): Promise<boolean | "superseded"> {
  const save = async (): Promise<true | "superseded"> => {
    if (expected === undefined) {
      await mergeProjectionLedgerDelta(projectPath, ledger)
      return true
    }
    const applied = await mergeProjectionLedgerDelta(projectPath, ledger, expected)
    return applied.size > 0 ? true : "superseded"
  }
  try {
    return await save()
  } catch (firstErr) {
    logger.warn("Chapter Ingest", "ProjectionStatusLedger save failed, retrying once (non-fatal)", {
      error: toErrorMessage(firstErr),
    })
  }
  if (!shouldRetryLedgerSave(0)) return false
  try {
    return await save()
  } catch (retryErr) {
    logger.warn("Chapter Ingest", "ProjectionStatusLedger save failed", { error: toErrorMessage(retryErr) })
    return false
  }
}

async function bindIngestSource(
  chapterPath: string,
  { chapterNumber, body, content }: { chapterNumber: number; body: string; content: string },
): Promise<IngestSourceRead> {
  return {
    readPath: chapterPath,
    chapterNumber,
    originalContent: content,
    bodySha256: await computeCheckpointDigest(body),
    contentSha256: await computeCheckpointDigest(content),
  }
}

export type PreparedChapterIngest = {
  snapshot: ChapterSnapshot
  source: IngestSourceBinding
}

/** 阶段 1（桌面确认前）：解析目标 + 绑定源摘要 + LLM 提取。纯读无写。 */
export async function prepareChapterIngest(
  projectPath: string,
  chapterPath: string,
  chapterNumber: number,
  signal?: AbortSignal,
): Promise<PreparedChapterIngest> {
  const t = await resolveIngestTarget(projectPath, chapterPath)
  if (!t.ok) throw new Error(t.result.failReason ?? "novel_mode_disabled")
  if (t.fm.type !== "chapter") throw new Error("not_chapter")
  if (t.chapterNumber !== chapterNumber || !Number.isSafeInteger(chapterNumber)) throw new Error("source_chapter_mismatch")
  if (!t.body.trim()) throw new Error("empty_chapter_body")
  if (signal?.aborted) throw new Error("cancelled")
  const { readPath, chapterNumber: sourceChapter, bodySha256, contentSha256 } = await bindIngestSource(chapterPath, t)
  await assertUniqueFinalChapterSource(t.pp, readPath, sourceChapter)
  if (signal?.aborted) throw new Error("cancelled")
  const snapshot = await extractSnapshotWithLLM(chapterNumber, t.body, t.runtimeLlmConfig, signal, {
    projectPath: t.pp,
    novelConfig: t.novelConfig,
  })
  if (signal?.aborted) throw new Error("cancelled")
  if (!snapshot || snapshot.chapterNumber !== chapterNumber) throw new Error("extract_failed")
  return { snapshot, source: { readPath, chapterNumber: sourceChapter, bodySha256, contentSha256 } }
}

export function ingestChapter(
  projectPath: string,
  chapterPath: string,
  _reviewModel?: string,
  signal?: AbortSignal,
  options: IngestChapterOptions = {},
): Promise<IngestResult> {
  return ingestChapterInternal(projectPath, chapterPath, signal, options)
}

export function commitPreparedChapterIngest(
  projectPath: string,
  prepared: PreparedChapterIngest,
  beforeFormalEffects?: () => Promise<void>,
): Promise<IngestResult> {
  return ingestChapterInternal(projectPath, prepared.source.readPath, undefined, {
    canonDualWriteDeps: defaultCanonDualWriteDeps(), awaitCommunitySummary: true, requireUniqueFinalChapter: true,
  }, prepared, beforeFormalEffects)
}

async function ingestChapterInternal(
  projectPath: string,
  chapterPath: string,
  signal: AbortSignal | undefined,
  options: IngestChapterOptions = {},
  prepared?: PreparedChapterIngest,
  beforeFormalEffects?: () => Promise<void>,
): Promise<IngestResult> {
  // (A)-2：前置解析与 5 个早退判定已抽至 ./chapter-ingest-ingest-guards。
  // 判定顺序与 failReason 字面值、以及「novelMode 关闭时不带 failReason」的
  // 形状差异均为既有对外契约，搬迁零改动。
  const target = await resolveIngestTarget(projectPath, chapterPath, options, { requireExtractionModel: !prepared, expectedContentSha256: prepared?.source.contentSha256 })
  if (!target.ok) return target.result
  const { pp, runtimeLlmConfig, llmConfig, novelConfig, chapterNumber, body, content } = target
  const fm = target.fm

  // 同一 read 的完整内容/正文摘要（原始字符串直接 hash，无 trim/slice/二次提取 read）。
  // readPath 是本函数自己的 chapterPath 实参，即 resolveIngestTarget 传给 readFile 的
  // 同一个字符串；originalContent 只在本地 sourceRead 中存在，不落盘、不发布。
  // 预先提取的 ready 批次（阶段 1）以同一 exact 源字节校验——源被改动则
  // source_changed 拒绝，绝不重提取、不静默放行。校验在 Canon replay/自愈/任何正式效果之前。
  const sourceRead = await bindIngestSource(chapterPath, { chapterNumber, body, content })
  if (prepared && (prepared.source.chapterNumber !== chapterNumber
    || prepared.snapshot.chapterNumber !== chapterNumber
    || prepared.source.bodySha256 !== sourceRead.bodySha256
    || prepared.source.contentSha256 !== sourceRead.contentSha256)) {
    return { snapshot: null, failReason: "source_changed" as IngestFailReason }
  }

  const verifySourceIdentity = options.requireUniqueFinalChapter
    ? () => assertUniqueFinalChapterSource(pp, chapterPath, chapterNumber)
    : undefined
  await verifySourceIdentity?.()
  await beforeFormalEffects?.()

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
    await recoverInterruptedCommunitySummaryAttempts(pp)
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

  let extractedSnapshot = prepared?.snapshot
  if (!prepared) try {
    extractedSnapshot = await extractSnapshotWithLLM(chapterNumber, body, runtimeLlmConfig, signal, {
      projectPath: pp,
      novelConfig,
    }) ?? undefined
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

  // (A)-3：提交点（实体链接/校验 → 快照落盘 → 摄取产物 → memory-op 预演
  // → facts-store → canon 双写钩子）已抽至 ./chapter-ingest-commit。
  // 三个非致命 try/catch 的吞错边界与日志文案零变化。
  // runCanonDualWriteHook 以依赖注入传入，避免母模块 ↔ 本模块运行时循环。
  // 提交前源守卫（sourceRead + 同一 signal）在本调用内执行；changed/unavailable/
  // cancelled 是本次提交的明确拒绝，早退形状保持 { snapshot: null, failReason }。
  let reservedPendingChapters: ProjectionStatusLedger["chapters"] | undefined
  const buildIngestStatusDelta = (status: "pending" | "failed", error?: string, attemptId?: string) => {
    let delta = recordProjectionStatus(emptyLedger(), chapterNumber, "chapter_ingest_output", status, error)
    delta = recordProjectionStatus(delta, chapterNumber, "sync_snapshot_to_memory", status, error)
    if (attemptId !== undefined) {
      const cells = delta.chapters[String(chapterNumber)]
      if (cells?.chapter_ingest_output) cells.chapter_ingest_output.attemptId = attemptId
      if (cells?.sync_snapshot_to_memory) cells.sync_snapshot_to_memory.attemptId = attemptId
    }
    return delta
  }
  const persistIngestStatus = (
    status: "pending" | "failed",
    error?: string,
    expected?: ProjectionStatusLedger["chapters"],
  ) => saveProjectionLedgerWithSingleRetry(pp, buildIngestStatusDelta(status, error), expected)
  const commitResult: CommitIngestSnapshotResult = await commitIngestSnapshot({
    pp,
    snapshot,
    fm: fm as Record<string, unknown>,
    canonDualWriteDeps: options.canonDualWriteDeps,
    runCanonDualWriteHook: runCanonDualWriteHookOutcome,
    sourceRead,
    signal,
    verifySourceIdentity,
    onPersistenceStart: verifySourceIdentity ? async () => {
      const pendingDelta = buildIngestStatusDelta("pending", undefined, crypto.randomUUID())
      if (await saveProjectionLedgerWithSingleRetry(pp, pendingDelta) !== true) {
        throw new Error("Could not save the reingest reservation; the current snapshot was not replaced")
      }
      reservedPendingChapters = pendingDelta.chapters
    } : undefined,
    onPersistenceFailure: async (error) => {
      await persistIngestStatus("failed", error, reservedPendingChapters)
    },
  })
  if (commitResult.status !== "committed") {
    const failReason: IngestFailReason = commitResult.status
    return { snapshot: null, failReason }
  }

  // v2.35 (TASK-005): 提交后、所有快照/facts 锁外非致命排空晋升重试队列（promotion-retry.jsonl），
  // 避免历史瞬态失败滞留，同时绝不侵入 commitIngestSnapshot 的 readFile 契约或引入嵌套锁。
  try {
    const parsedRetryNow = options.now !== undefined ? Date.parse(options.now) : Number.NaN
    const retryNow = Number.isFinite(parsedRetryNow) ? parsedRetryNow : undefined
    const retryReport = await replayPromotionRetryQueue(
      pp,
      undefined,
      retryNow !== undefined ? { now: retryNow } : {},
    )
    if (retryReport.succeeded + retryReport.failed + retryReport.deadLettered > 0) {
      logger.info(
        "Chapter Ingest",
        `Promotion retry queue drained: succeeded=${retryReport.succeeded}, failed=${retryReport.failed}, deadLettered=${retryReport.deadLettered}, remaining=${retryReport.remaining}`,
      )
    }
  } catch (err) {
    logger.warn("Chapter Ingest", "Promotion retry queue drain failed (non-fatal)", {
      error: toErrorMessage(err),
    })
  }

  const embCfg = options.embeddingConfig ?? useWikiStore.getState().embeddingConfig

  // F-002 (ANL-010 / C-002): commit-then-project. 提交点（上方 commitIngestSnapshot）
  // 是不可变事实层；以下全是 DERIVED 投影，各自独立执行并经 ProjectionStatusLedger
  // 记账，mid-ingest 失败可见且可恢复（不再是静默 warn）。
  //
  // (A)-4：投影落盘与社区摘要重建已抽至 ./chapter-ingest-projections。
  // runProjection 仍遍历 PROJECTION_REGISTRY（四路径同源），单投影失败只记 ledger
  // 后继续循环；ledger 落盘在 finally（含 1 次重试）。三个母模块函数以依赖注入传入，
  // 避免母模块 ↔ 本模块运行时循环依赖。
  // 同章写锁围栏：orphan extraction（同一章号并发写入者）不得在 sync SHA 拒绝前
  // 抢先更新 vector/graph/store；过期 writer 在围栏内第一步即被拒。
  let projectionStage: IngestProjectionError["stage"] = "source_fence"
  const lockedProjectionRun: RunIngestProjectionsResult = await withSnapshotWriteLock(pp, chapterNumber, async () => {
    // 任一投影写之前再次核对 current 仍是 extraction commit 写盘字节。
    const extractionSha256 = commitResult.receipt?.snapshotJsonSha256AtExtractionCommit
    if (extractionSha256) {
      await readMatchingExtraction(pp, chapterNumber, extractionSha256)
    }
    projectionStage = "projection_runner"
    return runIngestProjections({
      pp,
      chapterPath,
      chapterNo: chapterNumber,
      content,
      fm,
      snapshot: commitResult.snapshot,
      embCfg,
      llmConfig,
      novelConfig,
      options: {
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(options.onCommunitySummaryError !== undefined ? { onCommunitySummaryError: options.onCommunitySummaryError } : {}),
        ...(options.awaitCommunitySummary !== undefined ? { awaitCommunitySummary: options.awaitCommunitySummary } : {}),
      },
      exportStructuredMemoryToWiki,
      syncSnapshotToMemory: (path, extract) =>
        syncSnapshotToMemoryUnlocked(path, extract, undefined, extractionSha256, { skipDirectStoreFolds: true }),
      saveProjectionLedgerWithSingleRetry,
    })
  }).catch(async (err): Promise<RunIngestProjectionsResult> => {
    // 提取写入回执仍有效；包装层无法证明投影或账本结果。
    const message = toErrorMessage(err)
    if (reservedPendingChapters !== undefined) {
      await persistIngestStatus("failed", message, reservedPendingChapters)
    }
    logger.warn("Chapter Ingest", "Committed snapshot projections could not be verified", { stage: projectionStage, error: message })
    return {
      memorySyncedAt: undefined,
      failedProjections: [],
      pendingProjections: [],
      committedProjections: [],
      projectionError: { stage: projectionStage, message },
    }
  })

  // 长耗时 awaitCommunitySummary 在释放章锁后执行，避免阻塞同章后续写入或触发锁看门狗。
  const projectionRun: RunIngestProjectionsResult = lockedProjectionRun.finalizeAwaitedCommunitySummary
    ? await lockedProjectionRun.finalizeAwaitedCommunitySummary().catch((err): RunIngestProjectionsResult => {
        const message = toErrorMessage(err)
        logger.warn("Chapter Ingest", "Committed snapshot projections could not be verified", { stage: "projection_runner", error: message })
        return {
          memorySyncedAt: undefined,
          failedProjections: [],
          pendingProjections: [],
          committedProjections: [],
          projectionError: { stage: "projection_runner", message },
        }
      })
    : lockedProjectionRun

  return {
    snapshot: { ...snapshot, memorySyncedAt: projectionRun.memorySyncedAt },
    selfHeal: entrySelfHeal,
    ...(projectionRun.ledgerSaveFailed !== undefined ? { ledgerSaveFailed: projectionRun.ledgerSaveFailed } : {}),
    ...(projectionRun.projectionError ? { projectionError: projectionRun.projectionError } : {}),
    factsStoreFailed: commitResult.factsStoreFailed,
    failedProjections: projectionRun.failedProjections,
    committedProjections: projectionRun.committedProjections,
    pendingProjections: projectionRun.pendingProjections,
    ...(projectionRun.projectionReceipt ? { projectionReceipt: projectionRun.projectionReceipt } : {}),
    ...(commitResult.sourceBinding ? { sourceBinding: commitResult.sourceBinding } : {}),
    canonOutcome: commitResult.canonOutcome,
    ...(commitResult.receipt ? { receipt: commitResult.receipt } : {}),
  }
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
  return withProjectionStoreWriteLock(pp, async () => {
    const snapshots = await loadValidMemorySnapshots(pp, snapshot)
    if (snapshots.length === 0) return []
    return writeStructuredMemoryDocuments(pp, snapshots)
  })
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
  /** sync 直写三类中失败的投影 id（全成功 = []）。 */
  failedProjections: string[]
  /** 持久化链 receipt：仅 expected SHA 校验通过且完成归档+物化落盘时携带。 */
  projectionReceipt?: IngestProjectionReceipt
}

// backup/restoreCommunitySummariesLastGood 已拆至 ./community-summary-recovery（S5 切片 #3）。

/**
 * 严格链共享核对：current 必须仍是 extraction commit 实际写盘的那份（raw SHA
 * 严格比对），缺失或不符 → 拒绝，绝不拿过期/外来 current 物化下一 revision。
 * 投影围栏与 strict sync 复用同一判定（保持 pre-save/external 读栅栏）。
 */
async function readMatchingExtraction(
  pp: string,
  chapterNumber: number,
  expectedSha256: string,
): Promise<{ raw: string; snapshot: ChapterSnapshot }> {
  const current = await readSnapshotForReplacement(pp, chapterNumber)
  if (!current || (await computeCheckpointDigest(current.raw)) !== expectedSha256) {
    throw new Error("Current snapshot no longer matches the extraction commit.")
  }
  return current
}

export async function syncSnapshotToMemory(
  projectPath: string,
  snapshot: ChapterSnapshot,
  onDataVersionBump?: () => void,
): Promise<SyncSnapshotToMemoryResult> {
  const pp = normalizePath(projectPath)
  return withSnapshotWriteLock(pp, snapshot.chapterNumber, () =>
    syncSnapshotToMemoryUnlocked(pp, snapshot, onDataVersionBump, undefined))
}

async function syncSnapshotToMemoryUnlocked(
  pp: string,
  snapshot: ChapterSnapshot,
  onDataVersionBump: (() => void) | undefined,
  expectedExtractionSha256: string | undefined,
  options?: { skipDirectStoreFolds?: boolean },
): Promise<SyncSnapshotToMemoryResult> {
  let extractionHistoryPath: string | undefined
  let currentSnapshot: ChapterSnapshot | null
  if (expectedExtractionSha256 !== undefined) {
    // 严格链：current 必须仍是 extraction commit 实际写盘的那份（raw SHA 严格
    // 比对），缺失或不符 → 拒绝 sync，绝不拿过期/外来 current 物化下一 revision。
    const current = await readMatchingExtraction(pp, snapshot.chapterNumber, expectedExtractionSha256)
    currentSnapshot = current.snapshot
    // 归档 exact extraction wire JSON（isHistorical=true），先于一切 wiki 写。
    extractionHistoryPath = await archiveSnapshotJson(
      pp, snapshot.chapterNumber, JSON.stringify({ ...JSON.parse(current.raw), isHistorical: true }, null, 2))
  } else {
    currentSnapshot = await readCurrentSnapshot(pp, snapshot.chapterNumber)
  }
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

  // 叶子 best-effort 部分失败经 reportFailure 上报——graph 写不完整时不再执行
  // 清理（避免在部分写盘基础上误删仍被引用的旧实体文件）。
  const failedProjections: string[] = []
  const reportGraphFailure = () => {
    if (!failedProjections.includes("graph_entity_pages")) failedProjections.push("graph_entity_pages")
  }

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
  const foldAudit: ProjectionAuditEntry[] = []
  let saved: ChapterSnapshot
  try {
    // 同步快照和确定性投影都在同一写锁内，先提交快照。
    saved = await withProjectionStoreWriteLock(pp, async () => {
      if (expectedExtractionSha256 === undefined) {
        await backupSnapshotBeforeOverwrite(pp, syncedSnapshot.chapterNumber)
      } else {
        await readMatchingExtraction(pp, syncedSnapshot.chapterNumber, expectedExtractionSha256)
      }
      const committedSnapshot = await saveSnapshot(pp, syncedSnapshot)
      if (!options?.skipDirectStoreFolds) {
        for (const id of syncFoldProjectionIds()) {
          const entry = PROJECTION_REGISTRY[id]
          if (!entry) continue
          const { load, createEmpty, applyToStore, save } = entry
          if (!load || !createEmpty || !applyToStore || !save) continue
          if (entry.shouldApply && !entry.shouldApply(syncedSnapshot)) continue
          const startedAt = Date.now()
          let status: ProjectionAuditEntry["status"] = "committed"
          let error: string | undefined
          try {
            const loaded = await load(pp)
            await save(pp, applyToStore(loaded ?? createEmpty({}), syncedSnapshot, {}))
          } catch (err) {
            failedProjections.push(id)
            status = "failed"
            error = toErrorMessage(err)
          }
          foldAudit.push({
            projection: id, chapter: syncedSnapshot.chapterNumber, status,
            durationMs: Date.now() - startedAt, timestamp: new Date().toISOString(),
            ...(error !== undefined ? { error } : {}),
          })
        }
      }
      return committedSnapshot
    })
  } finally {
    for (const event of foldAudit) {
      try {
        await appendProjectionAuditEntry(pp, event)
      } catch (err) {
        // ISS-20260709-025 PAT-IM2: 记诊断，控制流不变。
        logger.warn("Chapter Ingest", "projection audit append failed (non-fatal)", { projection: event.projection, error: toErrorMessage(err) })
      }
    }
  }
  const writtenEntityPaths = await writeSnapshotToWiki(pp, syncedSnapshot, reportGraphFailure)
  if (!failedProjections.includes("graph_entity_pages")) {
    await cleanupSupersededEntityFiles(pp, syncedSnapshot, writtenEntityPaths, reportGraphFailure)
  }
  const memoryPagePaths = await exportStructuredMemoryToWiki(pp, syncedSnapshot)
  // Post-commit recheck（严格链）：save 先于 graph/wiki 写，stale writer 可在
  // 写期间覆盖 current —— 若 current 已不再是刚提交的那份，账本不得宣称 committed。
  if (expectedExtractionSha256 !== undefined) {
    const postWrite = await readSnapshotForReplacement(pp, syncedSnapshot.chapterNumber)
    if (!postWrite || postWrite.snapshot.snapshotId !== saved.snapshotId || postWrite.snapshot.revision !== saved.revision) {
      failedProjections.push("sync_snapshot_to_memory")
    }
  }
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

  return {
    writtenEntityPaths,
    memoryPagePaths,
    memorySyncedAt,
    driftSuspected,
    failedProjections,
    ...(extractionHistoryPath !== undefined && saved.snapshotId && saved.revision !== undefined
      && !failedProjections.includes("sync_snapshot_to_memory")
      ? {
          projectionReceipt: {
            extractionHistoryPath,
            snapshotId: saved.snapshotId,
            revision: saved.revision,
            snapshotJsonSha256: await computeCheckpointDigest(JSON.stringify(saved, null, 2)),
          },
        }
      : {}),
  }
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
    save: saveCognitionFoldPreservingTelemetry,
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

  let systemPrompt = `你是一个专业的小说编辑助手。请从大纲中提取初始设定信息，输出 JSON。${langReminder}`
  const hasExtractExtra = Boolean(novelConfig?.taskPrompts?.extract?.extra?.trim())
  const hasExtractSkills = Boolean(novelConfig?.taskSkillNames?.extract?.length)
  if (novelConfig && (hasExtractExtra || hasExtractSkills)) {
    try {
      const { resolveTaskExtraPrompt } = await import("./task-customization")
      const { appendTaskExtraSection } = await import("./deep-chapter-prompts")
      systemPrompt = appendTaskExtraSection(systemPrompt, resolveTaskExtraPrompt(novelConfig, "extract"))
      if (hasExtractSkills) {
        const { resolveRuntimeSkillsForStage } = await import("./runtime-skill-resolver")
        const resolved = await resolveRuntimeSkillsForStage({
          projectPath: pp,
          stage: "extract",
          novelConfig,
          windowTokens: runtimeLlmConfig.maxContextSize,
        })
        if (resolved.renderedText.trim()) {
          systemPrompt = `${systemPrompt}\n\n${resolved.renderedText.trim()}`
        }
      }
    } catch (err) {
      logger.warn("Chapter Ingest", "大纲提取阶段自定义提示词/技能注入失败（已忽略，继续基础提取）", {
        error: toErrorMessage(err),
      })
    }
  }

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
