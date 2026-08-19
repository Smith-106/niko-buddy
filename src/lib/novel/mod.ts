export { useNovelLabel, useNovelMode } from "./ui-labels"
export { parseChapterMeta, isChapterPage, isOutlinePage, type ChapterMeta, type ChapterStatus, type OutlineType } from "./chapter-meta"
export { parseVolumeMeta, isVolumePage, getChapterVolumes, type VolumeMeta } from "./volume"
export { createChapterPipeline, type ChapterPipeline, type ChapterPipelineDeps } from "./chapter-pipeline"
export {
  buildContextPack,
  contextPackToPrompt,
  type ContextPack,
  type ContextPackToPromptOptions,
  type LayeredRecallMode,
} from "./context-engine"
export {
  applyMemoryOp,
  applyMemoryOps,
  planAddOpsFromCanonFacts,
  classifyMemoryAtomKind,
  MEMORY_ATOM_KINDS,
  type MemoryOp,
  type MemoryAtomKind,
  type MemoryOpKind,
  type MemoryOpResult,
} from "./memory-op"
export {
  createIdleReviewJob,
  markWriteReady,
  markReviewQueued,
  markReviewRunning,
  markReviewDone,
  markReviewFailed,
  formatReviewJobLine,
  isWriteUnblockedByReview,
  type ReviewJobState,
  type ReviewJobPhase,
} from "./write-review-split"
export {
  buildEvidenceChainFromContinuity,
  buildEvidenceChainFromCed,
  buildEvidenceChainMixed,
  exportEvidenceChainJson,
  type EvidenceChain,
} from "./evidence-chain"
export {
  exportEvidenceChainForReview,
  type ExportEvidenceChainInput,
  type ExportEvidenceChainResult,
} from "./evidence-chain-export"
export {
  measureDeepChapterWallclock,
  type DeepChapterStageTiming,
  type DeepChapterWallclockReport,
} from "./deep-chapter-wallclock"
export {
  formatReviewJobStatusLine,
  getReviewJobUiModel,
  type ReviewJobUiModel,
} from "./review-job-ui"
export {
  advanceReviewJobRunning,
  advanceReviewJobDone,
  advanceReviewJobFailed,
} from "./review-job-lifecycle"
export {
  recordDeepChapterWallclockFromStageMetrics,
} from "./deep-chapter-wallclock-bridge"
export { ingestChapter, ingestChapterPipeline, ingestOutline, loadSnapshot, listSnapshots, deleteChapterSnapshots, type ChapterSnapshot, type CharacterDetail, type LocationDetail, type OrganizationDetail, type ItemDetail, type EventDetail, type IngestResult, type IngestFailReason } from "./chapter-ingest"
export { reviewChapter, type NovelReviewResult } from "./review-adapter"
export { runNovelLint, buildNovelLintPrompt, type NovelLintResult } from "./lint"
export { resolveNovelModel, type NovelTaskType } from "./model-resolver"
export { resolveReviewModel } from "./review-model"
export { novelMixedSearch, searchPlot, type NovelSearchParams, type NovelSearchResult } from "./search-adapter"
export { PROMPTS } from "./prompt-templates"
export { snapshotToGraphNodes, snapshotToGraphEdges, writeSnapshotToWiki, writePatchFieldsToWiki, detectNodeType, NOVEL_NODE_TYPE_LABELS, NOVEL_RELATION_LABELS, type NovelGraphNode, type NovelGraphEdge, type NovelNodeType } from "./graph-adapter"
export { emptyCognitionState, mergeCognitionFromSnapshot, loadCognitionState, saveCognitionState, cognitionToContextText, type CharacterCognition, type CognitionState } from "./character-cognition"
export { getNextChapterNumber, resolveTargetChapterNumberForChat, extractChapterNumber, flattenMdFiles, type ResolveTargetChapterNumberForChatInput } from "./chapter-utils"
export {
  createEmptyCharacterStateStore,
  saveCharacterStates,
  loadCharacterStates,
  characterStatesToContextText,
  type CharacterState,
  type CharacterStateStore,
} from "./character-state"
export {
  createEmptyForeshadowingStore,
  saveForeshadowingTracker,
  loadForeshadowingTracker,
  foreshadowingToContextText,
  type Foreshadowing,
  type ForeshadowingStore,
} from "./foreshadowing-tracker"
export { exportProject, type ExportOptions, type ExportResult } from "./export"
export { routeTask, buildTaskDirective, type NovelTaskIntent, type TaskRouteResult } from "./task-router"
export { createDefaultNovelProjectMeta, saveNovelProjectMeta, loadNovelProjectMeta, updateNovelProjectStats, type NovelProjectMeta } from "./project-meta"
export { buildDeAiSystemPrompt, buildDeAiRewriteMessages, injectDeAiDirective, loadCustomDeAiSkill } from "./de-ai-adapter"
// Wave 4 (v2.5.0): 批量去AI味 canonical 出口
export * from "./de-ai-batch"
export { analyzePreviousChapters, type PreviousChapterAnalysis } from "./previous-chapters-analysis"
export { rebuildAllSnapshots, rebuildVectorIndex, type RebuildProgress, type RebuildProgressCallback } from "./rebuild"
export { runFactCheck, verifyFactCheckLlm, type FactCheckResult, type FactCheckReport, type FactCheckOptions } from "./fact-snapshot"
export { scoreReviewResults, CALIBRATED_DIMENSION_WEIGHTS, CALIBRATED_SEVERITY_DEDUCTION, type DimensionScore, type ReviewScoreReport, type ReviewScoringOptions } from "./review-scoring"
// S3a (roadmap R10): Gate v2 加权 P2 参考分 + reading_power 特征分 (P2 参考, 不覆盖 P0)
export { gateV2WeightedScore, extractReadingPowerFeatures, buildP2ReferenceScore, formatP2ReferenceScore, GATE_V2_WEIGHTS, GATE_V2_PASS_THRESHOLD, type GateV2Score, type ReadingPowerFeatures, type P2ReferenceScore } from "./gate-v2-scoring"
export { readSoulDoc, writeSoulDoc, SOUL_DOC_FILENAME } from "./soul-doc"
export { analyzeForeshadowingDebt, type ForeshadowingDebtItem, type ForeshadowingDebtReport, type ForeshadowingDebtOptions } from "./foreshadowing-debt"
// Wave 1 (v2.5.0): 用户记忆系统 canonical 出口（耦合治理：主链只依赖本导出面）
export {
  buildReviewScoringOptions,
  buildUserAwareDeAiPrompt,
  hasUserDeAiWeights,
  getAvoidWords,
  getUserMemoryStore,
  loadUserMemoryForProject,
  saveUserMemoryForProject,
  listPreferences,
  addPreferenceForProject,
  updatePreferenceForProject,
  deletePreferenceForProject,
  type UserMemoryStore,
  type UserPreference,
} from "../user-memory"
// Wave 2 (v2.5.0): @引用系统 canonical 出口（耦合治理：主链/UI 只依赖本导出面）
export {
  parseReferences,
  resolveReferences,
  scoreCandidate,
  chineseNumberToInt,
  searchReferences,
  buildReferenceContext,
  formatReferenceSection,
  clearReferenceCache,
  REFERENCE_SECTION_CAP,
  REFERENCE_SNIPPET_CAP,
  REFERENCE_TOP_K,
  REFERENCE_CONCURRENCY_LIMIT,
  type ReferenceKind,
  type ReferenceToken,
  type ReferenceCandidate,
  type ResolvedReference,
  type ReferenceSearchHit,
} from "../reference"
// Wave 3 (v2.5.0): 计划模式 canonical 出口（耦合治理：主链/UI 只依赖本导出面）
export {
  buildChapterPlanView,
  buildChapterPlan,
  buildPlanningPrefillBlock,
  appendPlanningBlockToTaskBrief,
  taskBriefHasPlanningBlock,
  PLANNING_BLOCK_MARKER,
  PLANNING_BLOCK_CAP,
  type ChapterPlanView,
  type ChapterPlanOptions,
  type CharacterPlanItem,
  type PlanDimensionStatus,
} from "../novel/planning"
