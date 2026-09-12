// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * novel 域公开入口（T18 窄接口门禁 · exec-plan P1-6）
 *
 * 契约：src/ 下除本目录外的所有代码（app 元素：UI / IPC / 编排层 / stores / 测试）
 * 只能经本文件导入 novel 能力，不得直接 import 内部模块；novel 域内模块之间可自由
 * 直接引用。门禁由 eslint-plugin-boundaries 的 boundaries/dependencies 规则执行
 * （eslint.config.js，level=error）。
 *
 * 形式约束：显式导出清单，禁止 `export *`（避免公开面隐式漂移）。
 * 新增对外能力时，在此追加显式 re-export；不得绕过本文件从 app 侧深层导入。
 */

export { buildAgentSystemSuffix, detectEditIntent, parseAgentResponse } from "./agent-parser"
export type { FileEditAction } from "./agent-parser"
export { applyFileEdits, readScopeFileContents } from "./agent-tools"
export type { FileEditResult } from "./agent-tools"
export { shutdownAntiAiTelemetrySink } from "./anti-ai-telemetry-sink"
export { applyAntiAiTelemetryConsentOnProjectOpen, loadAntiAiTelemetryConsent, saveAntiAiTelemetryConsent } from "./anti-ai-telemetry-wiring"
export type { BookRules } from "./book-rules"
export { advanceBudgetBatch, createBudgetRun } from "./budget-resume"
export { defaultCanonDualWriteDeps, getCanonRevision, loadDivergenceTrace } from "./canon-dual-write"
export { buildCanonEdgeFilter, getFactsKnownByPaged, queryCanonEdges } from "./canon-graph-client"
export type { CanonFact, CanonQueryBatchResponseRaw, RawCanonEdge } from "./canon-graph-client"
export { asOfSnapshot, diffCanonRevisions, distinctRecordedRevisions } from "./canon-revision-diff"
export type { CanonRevisionDiff } from "./canon-revision-diff"
export { backupChapterFile } from "./chapter-backup"
export { cleanGeneratedChapterContentForSave, cleanGeneratedChapterContentWithTitle } from "./chapter-content-cleanup"
export type { CleanedChapterContent } from "./chapter-content-cleanup"
export { normalizeChapterEditFile } from "./chapter-edit-file"
export { CHAPTER_BODY_EXCERPT_MAX_CHARS } from "./chapter-excerpts"
export { CHAPTER_IMPORT_EXTENSIONS, collectChapterImportCandidatesFromFolder, importChapterFiles, runImportedChapterMemoryExtraction } from "./chapter-import"
export type { ChapterImportCandidate, ImportedChapter, ImportedChapterMemoryProgress, ImportedChapterMemoryResult } from "./chapter-import"
export { deleteChapterSnapshots, emitTruthFoldDriftAlarm, ingestChapter, listSnapshotHistory, listSnapshots, loadSnapshot, restoreSnapshotHistory, sampleTruthFoldDrift, syncSnapshotToMemory } from "./chapter-ingest"
export type { ChapterSnapshot, IngestChapterOptions, IngestResult, SnapshotHistoryEntry } from "./chapter-ingest"
export { isChapterPage, isFinalChapter, normalizeChapterStatus, parseChapterMeta, updateChapterStatus } from "./chapter-meta"
export type { ChapterStatus, OutlineType } from "./chapter-meta"
export { decideChapterSaveStrategy, detectGeneratedTargetChapterNumber } from "./chapter-save-strategy"
export type { ChapterSaveStrategy } from "./chapter-save-strategy"
export { detectLastGeneratedChapterNumber, findChapterFileByNumber, flattenMdFiles, getNextChapterNumber, invalidateChapterCache, readSelectedChapterNumberForFile, resolveTargetChapterNumberForChat } from "./chapter-utils"
export type { ResolveTargetChapterNumberForChatInput } from "./chapter-utils"
export { appendChapterWorkspaceSnapshot } from "./chapter-workspace"
export { BUILT_IN_CHARACTER_AURAS, CHARACTER_AURA_RESEARCH_FILES, bindCharacterAura, buildCharacterAuraContext, createCustomCharacterAuraSkill, deleteCustomCharacterAura, getCharacterAuraBindings, listBindableNovelCharacters, listCharacterAuras, loadCharacterAuraResearchDocument, loadCharacterAuraSkillDocument, unbindCharacterAura, updateCustomCharacterAura } from "./character-aura"
export type { CharacterAuraGenerationProgress, CharacterAuraResearchFileName } from "./character-aura"
export type { CharacterAura, CharacterAuraBinding, CharacterAuraInput, CharacterAuraStore } from "./character-aura-types"
export { normalizeCharacterText, toPinyin, toSimplified } from "./character-aura-utils"
export { appendExemplarABSample, exemplarABStats, loadCognitionState } from "./character-cognition"
export type { CognitionState, ExemplarABSample } from "./character-cognition"
export { loadCharacterStates } from "./character-state"
export type { CharacterState, CharacterStateStore } from "./character-state"
export { isChatEditRequest, resolveChatEditTarget, validateStructuredChapterEditResult } from "./chat-edit-mode"
export type { ChatEditTarget, ParsedChapterEditFile } from "./chat-edit-mode"
export type { DataSourceCategory, RouteSource } from "./classification"
export { buildContextPack, clearTemporalFactsCache, contextPackToPrompt, trimContextPack } from "./context-engine"
export type { BuildContextOptions, ContextPack, ContextPackToPromptOptions, TrimResult } from "./context-engine"
export { dismissFinding } from "./continuity-overrides-store"
export { buildCoverBrief, coverBriefToPrompt, validateCoverBrief } from "./cover-brief"
export type { BookCoverMeta } from "./cover-brief"
export { buildCoverImageTask, runCoverImageGeneration } from "./cover-image-provider"
export type { CoverAspect, CoverImagePort } from "./cover-image-provider"
export { buildDeAiRewriteMessages, buildQmQuaiSystemPrompt, injectDeAiDirective, loadSmartDeAiSkill } from "./de-ai-adapter"
export { acceptAllDeAiBatchDrafts, acceptDeAiBatchDraft, loadDeAiBatchState, rejectDeAiBatchDraft, runDeAiBatch } from "./de-ai-batch"
export type { DeAiBatchOptions, DeAiBatchProgress, DeAiBatchSummary } from "./de-ai-batch"
export { DE_AI_STRUCTURED_RULES, filterRulesBySeverity } from "./de-ai-rules"
export type { DeAiSeverity } from "./de-ai-rules"
export { BUILT_IN_DE_AI_SKILLS, createBlankProjectDeAiSkill, deAiSkillToUserSkill, deleteProjectDeAiSkill, getAllDeAiSkills, isDeAiSkillConfigCorruptError, loadDeAiSkillConfig, normalizeDeAiSkillConfig, recreateDeAiSkillConfig, resetBuiltInDeAiSkill, resolveAvailableDeAiSkills, resolveEffectiveDeAiSkill, restoreDeAiSkillConfigFromBackup, saveDeAiSkillConfig, setDeAiSkillEnabled, setDefaultDeAiSkill, updateDeAiSkill } from "./de-ai-skill-library"
export type { DeAiSkill, DeAiSkillConfig } from "./de-ai-skill-library"
export { TIERED_DEAI_TABLE, computeTieredDeAiStats } from "./de-ai-tiered-table"
export type { TieredDeAiEntry, TieredDeAiTier } from "./de-ai-tiered-table"
export { runDeepChapterGeneration } from "./deep-chapter-generation"
export type { DeepChapterDecisionGates, DeepChapterGenerationCallbacks, DeepChapterGenerationDeps, DeepChapterGenerationInput, DeepChapterGenerationResult, DeepChapterGenerationResumeCheckpoint } from "./deep-chapter-generation"
export { resolveChapterLengthSpec } from "./deep-chapter-prompts"
export type { ChapterLengthSpec } from "./deep-chapter-prompts"
export { runDeepOutlineGeneration } from "./deep-outline-generation"
export { deleteNovelSourceMemory } from "./delete-source-memory"
export type { ContinuityOverrideReasonCode } from "./deterministic-continuity-engine"
export { SIX_REVIEW_DIMENSIONS, SIX_REVIEW_DIMENSION_ORDER } from "./dimension-review-adapter"
export type { DimensionReviewResult, SixReviewDimensionKey } from "./dimension-review-adapter"
export { retryDirector, tryAdvanceDirector } from "./director-orchestrator"
export type { DirectorSnapshot } from "./director-orchestrator"
export { DIRECTOR_PHASES, advanceDirectorPhase, createDirectorPipeline } from "./director-pipeline"
export type { DirectorPhase, DirectorPipelineState, PhaseGateInput } from "./director-pipeline"
export { hasPersistedDirectorState, loadDirectorPersisted, saveDirectorIdeaInput, saveDirectorPersisted } from "./director-pipeline-store"
export type { DirectorIdeaInput, DirectorPersistedFile } from "./director-pipeline-store"
export { buildDismantlingAnalysisPrompt, buildDismantlingWebResearchPrompt, extractStructureMemoryFromAnalysis, loadDismantlingLibrary, saveDismantlingLibrary, selectNextDismantlingBatch } from "./dismantling"
export type { DismantlingAnalysis, DismantlingChapter, DismantlingLibrary, DismantlingProject } from "./dismantling"
export { formatDoctorReport, runProjectDoctor } from "./doctor"
export type { DoctorReport } from "./doctor"
export { writeDraft } from "./draft-manager"
export { calculateEmotionNetValue, evaluatePlayableEmotionPath, getCircuitBreakerStatus, getTopEmotionalDebt, loadEmotionLedger } from "./emotion-ledger"
export type { EmotionLedgerEntry } from "./emotion-ledger"
export { loadEmotionalArcs } from "./emotional-arcs"
export { exportEvidenceChainForReview } from "./evidence-chain-export"
export { countFinalChapters, exportInteractiveStory, exportNovelDocx, exportNovelEpub } from "./export"
export type { DocxExportResult, EbookExportResult } from "./export"
export { runFactCheck } from "./fact-snapshot"
export type { FactCheckReport, FactCheckResult } from "./fact-snapshot"
export { loadFanficMergeProposal, proposeCanonMerge, saveFanficMergeProposal } from "./fanfic-canon-import"
export type { CanonMergeProposal } from "./fanfic-canon-import"
export { analyzeForeshadowingDebt } from "./foreshadowing-debt"
export type { ForeshadowingDebtReport } from "./foreshadowing-debt"
export { loadForeshadowingTracker } from "./foreshadowing-tracker"
export type { Foreshadowing, ForeshadowingStore } from "./foreshadowing-tracker"
export { commitAcceptedDeepChapterDraft } from "./formal-writeback"
export type { CommitAcceptedDeepChapterDraftInput } from "./formal-writeback"
export { deleteGenerationHistoryEntry, listGenerationHistory, saveGenerationHistoryEntry } from "./generation-history"
export type { GenerationHistoryEntry } from "./generation-history"
export { OUTLINE_GENRE_CODES } from "./genre-codes"
export { buildGoldenThreeChapterDirective, detectGoldenThreeChapterRequest } from "./golden-three-chapters"
export type { GoldenThreeChapterRequest } from "./golden-three-chapters"
export { NOVEL_NODE_TYPE_LABELS, NOVEL_RELATION_LABELS } from "./graph-adapter"
export { queryInspectorState } from "./inspector-query"
export type { InspectorSnapshot } from "./inspector-query"
export type { InteractiveStoryGraph } from "./interactive-film-graph"
export { loadInteractiveGraph, loadPlaySession, savePlaySession } from "./interactive-io"
export { assertInvariantsNotDisabled, pickInvariantOverrides } from "./kb-governance"
export { collectKbMetrics } from "./kb-observability"
export type { KbMetrics, MetricSample } from "./kb-observability"
export { goldenCoverageOf, goldenKbShadowCases, runKbShadowArmsIfConsented } from "./kb-shadow-wiring"
export { detectLocalEntityMiss } from "./local-entity-names"
export { repairMarkdownFormatWithAi } from "./markdown-quality-ai-repair"
export { finalizeStructuredMarkdownMessage } from "./markdown-quality-finalizer"
export { formatMeasurementFingerprintSummary } from "./measurement-fingerprint"
export type { MeasurementFingerprint } from "./measurement-fingerprint"
export { loadMemoryCenterData } from "./memory-center"
export type { MemoryCenterData, MemoryCenterFilePreview, MemoryCenterSnapshotCard } from "./memory-center"
export { resolveDefaultModel, resolveModelConfig, resolveNovelModel } from "./model-resolver"
export type { ModelResolverStoreSnapshot, NovelTaskType } from "./model-resolver"
export { configureMonaco } from "./monaco-loader"
export { testNovelModel } from "./novel-model-test"
export type { TestableNovelModelTask } from "./novel-model-test"
export { acceptFindingRewriteDraft, blockDeepChapterSession, completeDeepChapterSession, computeChaseDebtState, createNovelSessionId, loadNovelSessionStatus, novelSessionStatusPath, pauseDeepChapterSession, persistDeepChapterCheckpoint, rejectDeepChapterDraft, rejectFindingRewriteDraft, resolveInterruptedSessionResumeCheckpoint, resolveStatusResumeCheckpoint, saveNovelSessionStatus, startDeepChapterSession, subscribeStatusJson, updateChaseDebtStatus, writeFindingRewriteDraft } from "./novel-session-status"
export type { ChaseDebt, ChaseDebtEvent, NovelSessionStatus } from "./novel-session-status"
export { OUTLINE_FIND_CHAPTER_INTENTS, buildOutlineFindProtocol, shouldIncludeOutlineFindProtocol, stripOutlineFindProtocol } from "./outline-find-protocol"
export { OUTLINE_SECTION_GENERATION_CONFIGS, addOutlineTaskToSourceList, buildOutlineGenerationPrompt, createOutlineIngestTask, hasOutlineForRefinement, openGeneratedOutline, runBulkOutlineIngest, runOutlineGenerationTask, runOutlineIngestTask, runOutlineRefinementTask, startOutlineIngestTask } from "./outline-generation"
export type { OutlineRefinementWriteMode, OutlineSectionGenerationKey } from "./outline-generation"
export { OUTLINE_IMPORT_EXTENSIONS, collectOutlineImportCandidatesFromFolder, importOutlineCandidates, importOutlineFiles } from "./outline-import"
export type { OutlineImportCandidate } from "./outline-import"
export { isLikelyChapterOutline, summarizeChapterOutlineQuality } from "./outline-quality-check"
export { THRILL_CHECKPOINT_LABELS, THRILL_CHECKPOINT_ORDER, getOutlineThrillSoftGateRuntimeStatus, isThrillSoftGateAcknowledged, thrilAckChapterKey } from "./outline-thrill-checkpoints"
export type { ThrillCheckStatus } from "./outline-thrill-checkpoints"
export { DEFAULT_OUTLINE_FOLDERS } from "./outline-workbench"
export { DEFAULT_PERSONA_IDS, PERSONA_CATALOG, runPersonaCritique } from "./persona-sidecar-runner"
export type { PersonaCritiqueResult, PersonaId } from "./persona-sidecar-runner"
export { buildChapterPlan } from "./planning"
export type { ChapterPlanView, ParticlePlanItem, PlanDimensionSlice, StateDeltaPlanItem } from "./planning"
export { createPlayState, renderPlayFrame, replayPlay, stepPlay } from "./play-runtime"
export type { PlayState } from "./play-runtime"
export { loadNovelProjectMeta, saveNovelProjectMeta } from "./project-meta"
export { PROMPTS } from "./prompt-templates"
export { resolveResidualCampaignFields } from "./residual-campaign"
export type { ResidualCampaignNovelConfigSlice, ResidualCampaignResolvedFields } from "./residual-campaign"
export { reviewChapter } from "./review-adapter"
export type { NovelReviewResult } from "./review-adapter"
export { formatReviewJobStatusLine, getReviewJobUiModel } from "./review-job-ui"
export type { ReviewJobUiModel } from "./review-job-ui"
export { resolveReviewModel } from "./review-model"
export { CALIBRATED_DIMENSION_WEIGHTS, CALIBRATED_SEVERITY_DEDUCTION, scoreReviewResults } from "./review-scoring"
export type { ReviewScoringOptions } from "./review-scoring"
export { persistRevisionFeedbackForChapter, pickRevisionFeedbackFromLintResults } from "./revision-feedback"
export { novelMixedSearch, searchPlot } from "./search-adapter"
export { buildDeAiSnapshot, buildWritingSnapshot, loadFavorites, saveFavorites } from "./skill-favorite"
export type { FavoriteSkillConfig, FavoriteSkillEntry, FavoriteSkillLibrary, FavoriteSkillSnapshot, FavoriteSkillSource } from "./skill-favorite"
export { DEFAULT_SKILL_PRIORITY, SKILL_KIND_LABELS, SKILL_MODE_LABELS, SKILL_STAGE_LABELS, normalizeUserSkill } from "./skill-library"
export type { SkillCategory, SkillKind, SkillMode, SkillStage, UserSkill } from "./skill-library"
export { SKILL_ROUTE_CATEGORY_IDS, filterSkillsForSkillRoute, filterSkillsForSkillRoutes, inferSkillRoute } from "./skill-route"
export type { SkillRoute } from "./skill-route"
export { collectExplicitSkills, getOutlineSkillNames, getWritingSkillNames, resolveAvailableSkillsByNames, resolveSkillReference, uniqueSkillsById } from "./skill-route-registry"
export { readSoulDoc, writeSoulDoc } from "./soul-doc"
export { startNovelReviewRun } from "./start-review-run"
export { startSixDimensionReviewRun } from "./start-six-dimension-review-run"
export { buildTaskDirective, routeTask } from "./task-router"
export type { NovelTaskIntent, TaskRouteResult } from "./task-router"
export { getTimelineEvents } from "./timeline"
export type { TimelineEntry } from "./timeline"
export { createEmptyTranslationGlossary, createEmptyTranslationProgress, loadTranslationGlossary, runTranslationProject, saveTranslationDraft, saveTranslationGlossary, translationProgressSummary, upsertGlossaryEntry } from "./translation-workbench"
export type { TranslationLlmPort, TranslationProgress } from "./translation-workbench"
export { WRITING_SKILL_KIND_OPTIONS, WRITING_SKILL_MODE_OPTIONS, WRITING_SKILL_STAGE_OPTIONS, createBlankWritingSkill, createSkillCategory, deleteSkillCategory, deleteWritingSkill, exportSkillToJson, importSkillFromJson, importWritingSkill, loadAllLinkedSkillsContent, loadLinkedSkillContent, loadUserSkillConfig, moveSkillToCategory, normalizeUserSkillConfig, renameSkillCategory, reorderSkillCategories, resolveEnabledWritingSkills, saveUserSkillConfig, setWritingSkillEnabled, touchSkillUsage, updateWritingSkill } from "./user-skill-store"
export type { UserSkillConfig } from "./user-skill-store"
export { buildSignedWebhookRequest, dispatchNotify, verifyWebhookSignature } from "./webhook-notifier"
export type { NotifyEvent, NotifyEventType } from "./webhook-notifier"
export { getEnabledWritingStyle, setEnabledWritingStyle, upsertWritingStylePreset } from "./writing-style-store"
export type { WritingStylePreset } from "./writing-style-store"
export { splitNovelIntoChapters } from "./book-analysis/analysis-engine"
export type { SplitChaptersResult } from "./book-analysis/analysis-engine"
export { importBookAnalysisSkillsAsAuras } from "./book-analysis/aura-adapter"
export type { ImportedBookAnalysisAura } from "./book-analysis/aura-adapter"
export { deleteOrphanAurasForBook } from "./book-analysis/aura-cleanup"
export { persistCharacterToDisk } from "./book-analysis/character-disk-store"
export { extractCharactersFromChapters, extractSingleCharacter } from "./book-analysis/character-extraction-engine"
export type { CharacterExtractionInput } from "./book-analysis/character-extraction-engine"
export { llmRecognizeCharacters } from "./book-analysis/character-llm-recognizer"
export { loadBookAnalysisLibraryState, toBookAnalysisResult } from "./book-analysis/library-state"
export type { BookAnalysisAuraBindingSummary, BookAnalysisLibraryBook, BookAnalysisLibraryState } from "./book-analysis/library-state"
export { saveRecognizedCharacters } from "./book-analysis/recognized-character-store"
export { loadBookAnalysisResult } from "./book-analysis/result-loader"
export { extractSingleProfile } from "./book-analysis/simple-extraction-engine"
export type { SingleProfileInput } from "./book-analysis/simple-extraction-engine"
export { generateSkillsForCharacters } from "./book-analysis/skill-generator"
export { analyzeWritingStyle } from "./book-analysis/style-extraction-engine"
export type { AnalyzeWritingStyleOptions } from "./book-analysis/style-extraction-engine"
export { STYLE_DIMENSIONS } from "./book-analysis/style-prompts"
export { attachTaskPersistence, loadTaskSummaries } from "./book-analysis/task-persistence"
export type { AnalysisDepth, BookAnalysisConfig, BookAnalysisMetadata, BookAnalysisProgress, BookAnalysisResult, BookAnalysisTask, BookStyleProfile, CharacterSkill, ExtractedCharacter, PersonalityProfile, RecognizedCharacter, SixDimensionProgressItem, SixDimensionStatus } from "./book-analysis/types"
export { loadClassificationConfig, resolveRouteRule } from "./classification/classification-loader"
export { applyRouteRules } from "./classification/route-applier"
export { detectArcProgression } from "./craft/arc-tracker"
export type { ArcProgressionInput, ArcProgressionResult } from "./craft/arc-tracker"
export { ARC_STAGE_VALUES, isArcStage } from "./craft/canon-craft-fields"
export type { ArcStage } from "./craft/canon-craft-fields"
export type { CompiledTechniqueRegistry, HookTypeEntry, TechniqueRulePack } from "./craft/technique-compiler"
export type { QuantifiedHit, TensionSample, ThrillQuantifierResult } from "./craft/thrill-quantifier"
export { actionTypeIcon, actionTypePhrase, actionTypePhraseOnly, actionTypeShortLabel } from "./story-simulation/action-type-utils"
export { interviewAgent } from "./story-simulation/agent-interview"
export { buildAgents } from "./story-simulation/agent-profile-builder"
export { exportDraft } from "./story-simulation/draft-export"
export { importDraftToChapters } from "./story-simulation/draft-importer"
export { generateDynamicEventPool } from "./story-simulation/event-pool-generator"
export { clearBinding, loadBinding, saveBinding } from "./story-simulation/framework-binding"
export { deleteFramework, deleteSimulationResult, loadFrameworks, loadSimulationResults, saveFramework, saveSimulationResult } from "./story-simulation/framework-store"
export { exportInterview } from "./story-simulation/interview-export"
export { deleteInterview, loadInterviews, saveInterview } from "./story-simulation/interview-store"
export type { SavedInterview } from "./story-simulation/interview-store"
export { exportReport } from "./story-simulation/report-export"
export { runSimulation } from "./story-simulation/simulation-engine"
export type { SimulationCallbacks } from "./story-simulation/simulation-engine"
export { generateSimulationReport } from "./story-simulation/simulation-report-agent"
export { deserializeSimulationSnapshot, serializeSimulationState } from "./story-simulation/simulation-serializer"
export type { SerializedSimulationSnapshot } from "./story-simulation/simulation-serializer"
export { generateStoryDraft } from "./story-simulation/story-draft-generator"
export { extractStoryContent } from "./story-simulation/story-extractor"
export { generateStoryFramework } from "./story-simulation/story-framework-generator"
export { MODE_VISUAL_INFO, WORD_BUDGET_PRESETS } from "./story-simulation/types"
export type { AgentChatMessage, AgentRelation, DirectorEvaluation, DirectorScore, ExtractionResult, FrameworkBinding, NovelAgent, RumorEvent, SimulationBranch, SimulationDebugTrace, SimulationHistoryEntry, SimulationMode, SimulationReport, SimulationResultStatus, SimulationResumePoint, SimulationState, StagedEventPool, StoryBranch, StoryDraft, StoryFramework, StoryNode, TimelineEvent } from "./story-simulation/types"

// F-002 技能包离线协议客户端（TASK-005/006）：app 层只能经 barrel 进入 novel 领域，
// 故两个 UI 客户端在此公开。
export {
  SKILL_BUNDLE_ALLOWED_EXTENSIONS,
  SKILL_BUNDLE_EXECUTABLE_EXTENSIONS,
  SKILL_BUNDLE_MAX_BYTES,
  SKILL_BUNDLE_MAX_ENTRIES,
  SKILL_BUNDLE_SCHEMA,
  SKILL_BUNDLE_SCHEMA_VERSION,
  SKILL_BUNDLE_TRUST_UNTRUSTED,
  exportSkillBundle,
  hasExecutableExtension,
  importSkillBundle,
  isAllowedBundleEntry,
  summarizeImportGate,
  validateBundleEntryName,
  validateManifestShape,
  verifySkillBundle,
} from "./skill-bundle-client"
export type {
  BundleEntryVerdict,
  BundleFileRef,
  SkillBundleAllowlist,
  SkillBundleExportResult,
  SkillBundleImportResult,
  SkillBundleManifest,
  SkillBundleVerifyResult,
} from "./skill-bundle-client"

// F-004 云端备份客户端（TASK-007/008）：同上，供 CloudBackupPanel 使用。
export {
  CONFLICT_DEFAULT_RESOLUTION,
  CONFLICT_PREFIX,
  CREDENTIAL_REF_PREFIX,
  FORBIDDEN_REMOTE_SEGMENTS,
  SYNC_CONFIG_FILE,
  SYNC_CONFIG_KEYS,
  SYNC_JOURNAL_FILE,
  cloudBackupStatus,
  configureCloudBackup,
  conflictFileName,
  decidePull,
  isRemoteKeyAllowed,
  listCloudConflicts,
  pullCloudBackup,
  pushCloudBackup,
  summarizeConflict,
  testCloudBackup,
  validateSyncConfig,
} from "./sync-client"
export type {
  PullDecision,
  RevisionState,
  SyncConfig,
  SyncConflict,
  SyncPullResult,
  SyncPushResult,
  SyncStatus,
  SyncTestResult,
} from "./sync-client"

// ── 写入确认门（src-tauri/src/agent_gate.rs 的 TS 镜像）────────────────────
export {
  GATE_TIMEOUT_MS,
  LOOP_WINDOW_MS,
  LOOP_THRESHOLD,
  PROTECTED_PREFIXES,
  DESTRUCTIVE_OPS,
  DERIVED_ROOTS,
  GATE_CONFIRM_PREFIX,
  GATE_DENIED_PREFIX,
  DEFAULT_GATE_RESOLUTION,
  classifyRebuildClass,
  effectiveDecision,
  hitCriteria,
  isDestructiveOp,
  isProtectedTarget,
  normalizeGateTarget,
  parseGateError,
} from "./confirm-gate/gate-classify"
export type {
  GateActor,
  GateDecision,
  GateOutcome,
  LoopState,
  ParsedGateError,
  PendingGate,
  RebuildClass,
} from "./confirm-gate/gate-classify"
export {
  classifyGate,
  confirmGate,
  fetchLoopState,
  isExpired,
  listPendingGates,
  rejectGate,
  remainingWindowMs,
  resolveGate,
  resumeAfterHalt,
  timeoutSeconds,
} from "./confirm-gate/gate-client"

// ── 快照时间机器（src-tauri/src/snapshot_timemachine.rs 的 TS 镜像）─────────
export {
  PROJECTION_STATUS_FILE,
  SNAPSHOT_DIR,
  STATUS_FILE,
  TIMELINE_PAGE_SIZE,
  hasNextPage,
  listSnapshotChain,
  nextOffset,
  previewSnapshotPoint,
  restoreSnapshotAtomic,
  restoreSucceeded,
} from "./time-machine/timeline-client"
export type {
  CanonVerifyOutcome,
  FieldDiff,
  RestoreOutcome,
  SnapshotChain,
  SnapshotDiff,
  SnapshotMeta,
  StateDiff,
} from "./time-machine/timeline-client"
export {
  TRUTH_SURFACE_FILES,
  changedWorldStates,
  diffTotals,
  formatBytes,
  formatFieldDiff,
  isEmptyDiff,
  touchesTruthSurface,
  truncateValue,
} from "./time-machine/snapshot-diff"
export type { DiffTotals } from "./time-machine/snapshot-diff"

// ── 续写简报（F-003：确定性聚合 + 溯源 + canon 优先）────────────────────────
export {
  BRIEFING_PATHS,
  BRIEFING_SOURCE_KINDS,
  assertSourced,
  buildBriefingDigest,
  currentChapterOf,
  formatEmotionEntry,
  openDebtsOf,
} from "./briefing/digest-aggregator"
export type {
  BriefingAssertion,
  BriefingBlockKind,
  BriefingDigest,
  BriefingSource,
  BriefingSourceBundle,
  BriefingSourceKind,
  OpenDebt,
} from "./briefing/digest-aggregator"
export {
  BRIEFING_RENDERER_VERSION,
  buildMemoryPatch,
  memoryPatchPath,
  renderBriefing,
  resolveAgainstCanon,
  sortDebtsForDisplay,
} from "./briefing/briefing-renderer"
export type {
  CanonClaim,
  DivergenceEntry,
  MemoryPatchDraft,
  RenderedBlock,
  RenderedBriefing,
  RenderedLine,
} from "./briefing/briefing-renderer"

// ── 技能包交换（F-006：本地单文件 .nbskill.json，无市场/无账号/无网络）──────────
export {
  NBSKILL_PACK_EXTENSION,
  NBSKILL_PACK_KIND,
  NBSKILL_PACK_SCHEMA_VERSION,
  PACK_NAME_PATTERN,
  PACK_TOOL_CATEGORIES,
  PACK_TOOL_NAME_PATTERN,
  PACK_TRUST_LEVELS,
  formatIssuePath,
  isAllowedToolCategory,
  packFileName,
  nbskillPackSchema,
  packPromptSpecSchema,
  packToolSpecSchema,
  parseNbskillPack,
} from "./skill-pack/pack-format"
export type {
  NbskillPack,
  PackPromptSpec,
  PackToolCategory,
  PackToolSpec,
  PackTrustLevel,
  PackValidationCode,
  PackValidationIssue,
  PackValidationResult,
} from "./skill-pack/pack-format"
export {
  CREDENTIAL_KEY_PARTS,
  buildPack,
  isCredentialLikeKey,
  serializePack,
  stripCredentialKeys,
  stripCredentialLines,
} from "./skill-pack/pack-export"
export type { ExportOptions, ExportResult, PackExportWarning } from "./skill-pack/pack-export"
export {
  importNbskillPack,
  importedSkillsOf,
  importedSkillsTargetFile,
} from "./skill-pack/pack-import"
export type {
  ImportContext,
  ImportFailure,
  ImportResult,
  ImportSuccess,
} from "./skill-pack/pack-import"
export {
  TRUST_LEVELS,
  TRUST_ORIGINS,
  classifyTrustLevel,
  importEvidence,
  isTrustLevel,
  mayEnterCanonTruth,
} from "./trust-authority"
export type { TrustEvidence, TrustLevel, TrustOrigin } from "./trust-authority"

// ── 事务式批量替换（F-007：确定性字面量替换 + 写前门预检 + 事务回滚）──────────
export {
  MAX_FILES_PER_BATCH,
  assessSafety,
  changedFilesOnly,
  diffLines,
  summarize,
} from "./batch-replace/diff-model"
export type {
  DiffSummary,
  FileDiffModel,
  LineDiffEntry,
  SafetyIssue,
  SafetyIssueCode,
  SafetyVerdict,
} from "./batch-replace/diff-model"
export {
  BATCH_REPLACE_OP,
  applyBatchReplace,
  buildEdgesFromPlan,
  isGateDenied,
  isGateRequireConfirm,
  isPlanBlockedByCanonGate,
  isTransactionRolledBack,
  preflightCanonEdgeGate,
  previewBatchReplace,
} from "./batch-replace/plan-client"
export type {
  ApplyReport as BatchReplaceApplyReport,
  BatchReplaceRequest,
  ReplaceRule,
} from "./batch-replace/plan-client"
export type { PreWriteGateCode, PreWriteGateState } from "./canon-pre-write-gate"
