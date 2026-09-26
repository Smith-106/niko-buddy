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
export { detectLastGeneratedChapterNumber, extractChapterNumber, findChapterFileByNumber, flattenMdFiles, getNextChapterNumber, invalidateChapterCache, readSelectedChapterNumberForFile, resolveTargetChapterNumberForChat } from "./chapter-utils"
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
export { DATA_DOMAINS, domainRequiresTypedConfirm } from "./data-domain-registry"
export type { DataDomain } from "./data-domain-registry"
export { listTrash, moveAllToTrash, moveDomainToTrash, purgeTrashStamp, restoreDomainFromTrash, statAllDomains } from "./data-manager"
export type { DomainStat, TrashEntry } from "./data-manager"
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
// §GAP-90-08 授权边界最小返工集（dimension-review-adapter additive 导出）
export { minimalReworkSet, minimalReworkSetFromDimensionIssues } from "./dimension-review-adapter"
export type { MinimalReworkIssue } from "./dimension-review-adapter"
export { retryDirector, tryAdvanceDirector, tryAdvanceDirectorFromProject, collectProjectSnapshot } from "./director-orchestrator"
export type { DirectorSnapshot } from "./director-orchestrator"
export { DIRECTOR_PHASES, advanceDirectorPhase, createDirectorPipeline } from "./director-pipeline"
export type { DirectorPhase, DirectorPipelineState, PhaseGateInput } from "./director-pipeline"
export { hasPersistedDirectorState, loadDirectorPersisted, saveDirectorIdeaInput, saveDirectorPersisted } from "./director-pipeline-store"
export type { DirectorIdeaInput, DirectorPersistedFile } from "./director-pipeline-store"
export { deriveWorldBlueprint, deriveAndSaveWorldBlueprint, loadWorldBlueprint, saveWorldBlueprint, validateWorldBlueprint, worldBlueprintToPromptFragment, createEmptyWorldBlueprint } from "./world-blueprint"
export type { WorldBlueprint, WorldLayer, WorldValidation, WorldFinding } from "./world-blueprint"
export { PROJECTIONS_REGISTRY, mainChainProjections, orphanProjections } from "./projections-registry"
export type { ProjectionEntry, ProjectionConsumer } from "./projections-registry"
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
export { NOVEL_NODE_TYPE_LABELS, NOVEL_RELATION_LABELS, narrativeEventsToGraphNodes, narrativeEventsToGraphEdges } from "./graph-adapter"
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
// §GAP-90-04 全书级 style_stats rollup（mechanical-slop-detector additive 导出）
export { bookStyleStatsToText, rollupStyleStats, STYLE_STATS_DEGRADED_AVG, STYLE_STATS_MIN_CHAPTERS } from "./mechanical-slop-detector"
export type { BookStyleStats } from "./mechanical-slop-detector"
export { loadMemoryCenterData } from "./memory-center"
export type { MemoryCenterData, MemoryCenterFilePreview, MemoryCenterSnapshotCard } from "./memory-center"
export { resolveDefaultModel, resolveModelConfig, resolveNovelModel } from "./model-resolver"
export type { ModelResolverStoreSnapshot, NovelTaskType } from "./model-resolver"
export { configureMonaco } from "./monaco-loader"
export { testNovelModel } from "./novel-model-test"
export type { TestableNovelModelTask } from "./novel-model-test"
export { acceptFindingRewriteDraft, blockDeepChapterSession, completeDeepChapterSession, computeChaseDebtState, createNovelSessionId, loadNovelSessionStatus, markSessionInterrupted, novelSessionStatusPath, pauseDeepChapterSession, persistDeepChapterCheckpoint, rejectDeepChapterDraft, rejectFindingRewriteDraft, resolveInterruptedSessionResumeCheckpoint, resolveStatusResumeCheckpoint, saveNovelSessionStatus, startDeepChapterSession, subscribeStatusJson, updateChaseDebtStatus, writeFindingRewriteDraft } from "./novel-session-status"
export type { ChaseDebt, ChaseDebtEvent, NovelSessionStatus } from "./novel-session-status"
export { OUTLINE_FIND_CHAPTER_INTENTS, buildOutlineFindProtocol, shouldIncludeOutlineFindProtocol, stripOutlineFindProtocol } from "./outline-find-protocol"
export { OUTLINE_SECTION_GENERATION_CONFIGS, addOutlineTaskToSourceList, buildOutlineGenerationPrompt, createOutlineIngestTask, hasOutlineForRefinement, openGeneratedOutline, runBulkOutlineIngest, runOutlineGenerationTask, runOutlineIngestTask, runOutlineRefinementTask, startOutlineIngestTask } from "./outline-generation"
export type { OutlineRefinementWriteMode, OutlineSectionGenerationKey } from "./outline-generation"
export { OUTLINE_IMPORT_EXTENSIONS, collectOutlineImportCandidatesFromFolder, importOutlineCandidates, importOutlineFiles } from "./outline-import"
export type { OutlineImportCandidate } from "./outline-import"
export { checkFinaleVolumeDiscipline, isLikelyChapterOutline, summarizeChapterOutlineQuality } from "./outline-quality-check"
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
// §GAP-90-07 配角 recent_cast（related-chapters additive 导出）
export { recentCast, renderCastIntros } from "./related-chapters"
export type { CharacterAppearance, RecentCastEntry } from "./related-chapters"
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
// §GAP-89-01 滚动规划指南针 + 完结六项清单（ainovel architect-long 模式吸收）
export {
  checkCompleteBookAllowed,
  collectCompletionChecklistInput,
  createEmptyStoryCompass,
  evaluateCompletionChecklist,
  loadStoryCompass,
  saveStoryCompass,
  updateCompass,
  COMPLETION_CHECKLIST_IDS,
  FINALE_NO_NEW_HOOKS,
  PADDING_TRAP,
  PREMATURE_ENDING_TRAP,
} from "./story-compass"
export type {
  CompassUpdate,
  CompleteBookVerdict,
  CompletionChecklistInput,
  CompletionChecklistItem,
  CompletionChecklistItemId,
  CompletionChecklistResult,
  CompletionInputCollectDeps,
  CompletionInputCollectOptions,
  StoryCompass,
} from "./story-compass"
// §GAP-89-01 收官卷自动完结判定（volume.ts 配套 story-compass）
export { checkFinaleAutoComplete } from "./volume"
export type { FinaleAutoCompleteInput } from "./volume"
// §GAP-89-02 四级上下文压缩 + 恢复包 + 熔断器（ainovel ctxpack 模式吸收）
export {
  allowHalfOpenProbe,
  buildRestorePack,
  compactContextSections,
  createCompactBreaker,
  createCompactWatchdog,
  estimateCompactTokens,
  feedCompactHeartbeat,
  pollCompactWatchdog,
  recordCompactFailure,
  recordCompactSuccess,
  CONTEXT_DROP_ORDER,
  DEFAULT_COMPACT_FAILURE_THRESHOLD,
  DEFAULT_COMPACT_HALF_OPEN_ROUNDS,
  PROTECTED_COMPACT_FIELDS,
  RESTORE_PACK_BUDGET_CHARS,
} from "./context-compact"
export type {
  CompactBreakerState,
  CompactGap,
  CompactLevel,
  CompactOptions,
  CompactResult,
  CompactWatchdog,
  RestorePackInput,
} from "./context-compact"
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

// ── 波1 共识计划（GLM/DeepSeek/Qwen）：EB 底座公共导出（novel-public） ──
export {
  RUN_EVENT_LEDGER_SCHEMA_VERSION,
  RUN_EVENT_KINDS,
  RUN_EVENT_ACTORS,
  BUDGET_COST_SCHEMA,
  RUN_EVENT_SCHEMA,
  RunEventLedgerError,
  RunEventIntegrityError,
  appendRunEvent,
  appendRunEvents,
  createRunEventLedger,
  recordGateRunEvents,
  checkGateEventCoverage,
  readGateRunPayload,
  gateDisplayStatus,
  gateDisplayLabel,
  sliceRunEvents,
  eventsByReplayId,
  listReplayIds,
  aggregateBudgetCost,
  latestEventOf,
} from "./run-event-ledger"
export type {
  RunEvent,
  RunEventInput,
  RunEventKind,
  RunEventActor,
  BudgetCost,
  RunEventLedger,
  GateEventCoverage,
  GateDisplayStatus,
  RunEventFilter,
  BudgetCostSummary,
} from "./run-event-ledger"
export {
  ROUTE_POLICY_SCHEMA,
  SchedulingGateInvariantError,
  assertNoGateFieldsInSchedulingResult,
  buildRoutingSelfCheckReport,
  evaluateRetryScheduling,
  evaluateSchedulingGate,
  normalizeRoutePolicy,
  resolveRouteModel,
  schedulingTierRole,
} from "./scheduling-gate"
export type {
  RoutePolicy,
  RouteResolution,
  RetrySchedulingDecision,
  RetrySchedulingDecisionKind,
  RoutingSelfCheckEntry,
  RoutingSelfCheckReport,
  SchedulingDecision,
  SchedulingGateConfig,
  SchedulingGateResult,
  SchedulingQuotaSnapshot,
} from "./scheduling-gate"
export {
  PROMPT_ARTIFACT_REGISTRY_SCHEMA_VERSION,
  PROMPT_ARTIFACT_SCHEMA,
  PromptArtifactRegistryError,
  artifactToEventRefs,
  bindGateRunLineage,
  checkPromptLineageCoverage,
  comparePromptVersions,
  computePromptTemplateHash,
  createPromptArtifactRegistry,
  lineageOfGateRunEvent,
  missingTestRefs,
  registerPromptArtifact,
  resolvePromptArtifact,
} from "./prompt-artifacts"
export type {
  GatePromptLineage,
  PromptArtifact,
  PromptArtifactInput,
  PromptArtifactRegistry,
  PromptLineageCoverage,
} from "./prompt-artifacts"
export {
  DEFAULT_DRAFT_AUTO_ARM_POLICY,
  ADVANCE_MODE_SCHEMA,
  ADVANCE_PHASE_SCHEMA,
  DirectorModeError,
  assertAutoArmNeverAccepts,
  evaluateDraftAutoArm,
  evaluatePhaseExit,
  normalizeAdvanceMode,
  validateAdvanceTransition,
} from "./director-modes"
export type {
  AdvanceMode,
  AdvancePhase,
  AdvancePhaseRunStatus,
  AdvanceTransitionVerdict,
  DraftAutoArmDecision,
  DraftAutoArmPolicy,
  DraftAutoArmTarget,
} from "./director-modes"
export {
  ASSET_LIBRARY_SCHEMA_VERSION,
  LIBRARY_IDS,
  GENRE_BASE_ENTRY_SCHEMA,
  PACING_PATTERN_ENTRY_SCHEMA,
  TITLE_SEED_ENTRY_SCHEMA,
  WORLD_SAMPLE_ENTRY_SCHEMA,
  CHARACTER_ARCHETYPE_ENTRY_SCHEMA,
  AssetLibraryError,
  assertArtifactImmutable,
  buildLibraryArtifact,
  computeLibraryHash,
  probeLibraryHealth,
  stableStringify,
  verifyLibraryConservation,
} from "./asset-library"
export type {
  CharacterArchetypeEntry,
  ConservationReport,
  GenreBaseEntry,
  LibraryArtifact,
  LibraryEntry,
  LibraryHealthReport,
  LibraryId,
  PacingPatternEntry,
  TitleSeedEntry,
  WorldSampleEntry,
} from "./asset-library"
export {
  buildSlotManifest,
  computeQueryHash,
  counterfactualReplay,
  markHitRejection,
} from "./retrieval-trace"
export type {
  CounterfactualReplayCandidate,
  CounterfactualReplayInput,
  CounterfactualReplayResult,
  RetrievalCorpusFilter,
  RetrievalRejection,
  RetrievalRejectionReason,
  RetrievalSlotManifestEntry,
} from "./retrieval-trace"
export {
  buildEvidenceSnapshot,
} from "./evidence-snapshot"
export type {
  EvidenceGateCard,
  EvidenceSnapshot,
} from "./evidence-snapshot"
// ── 波2-A：P0 接线批（世界约束门联动 / autoarm 落盘 / 账本持久化） ──────────
export {
  WORLD_CONSTRAINT_PACK_ID,
  WorldConstraintGateError,
  buildWorldConstraintPack,
  parseWorldConstraint,
} from "./world-constraint-gate"
export type {
  ParsedWorldConstraint,
  WorldConstraintKind,
} from "./world-constraint-gate"
export {
  DRAFT_AUTO_ARM_SCHEMA,
  AutoArmStatusError,
  applyDraftAutoArmPatch,
  assertAutoArmPatchNeverAccepts,
  buildDraftAutoArmPatch,
  buildDraftAutoArmRecord,
} from "./auto-arm-status"
export type {
  DraftAutoArmPatch,
  DraftAutoArmStatus,
} from "./auto-arm-status"
export {
  RUN_EVENTS_FILENAME,
  RunEventLedgerStoreError,
  appendRunEventToStore,
  appendRunEventsToStore,
  createFsRunEventLedgerStoreDeps,
  loadRunEventLedgerStore,
  runEventsPath,
} from "./run-event-ledger-store"
export type {
  RunEventAppendInput,
  RunEventLedgerStoreDeps,
} from "./run-event-ledger-store"
// ── 波2-B：P1 数据层批一（标题工坊 / 拆书→aura 单向闭环 / 导演跟进） ──────
export {
  TitleForgeError,
  forgeTitles,
} from "./title-forge"
export type {
  TitleConstraintCheck,
  TitleForgeCandidate,
  TitleForgeReport,
  TitleForgeRow,
  TitleSeedMatchRow,
} from "./title-forge"
export {
  BookAnalysisEvolutionError,
  IMAGE_EVOLUTION_ANCHOR_SCHEMA,
  IMAGE_EVOLUTION_TIMELINE_SCHEMA,
  applyAuraSeedsToArchetype,
  evolutionAuraEvents,
  evolutionToAuraSeeds,
} from "./book-analysis-evolution"
export type {
  AuraSeedSynthesis,
  ImageEvolutionAnchor,
  ImageEvolutionTimeline,
} from "./book-analysis-evolution"
export {
  buildBlockingQueue,
  buildDirectorFollowupSnapshot,
  estimateRerunCost,
  propagateStaleness,
} from "./director-followup"
export type {
  BlockingQueueItem,
  DirectorFollowupSnapshot,
  RerunCostEstimate,
  StalenessEdge,
} from "./director-followup"
// ── 波2-C：P1 数据层批二（闭环指标 / 重试差分 / 同质化告警） ──────────────
export {
  buildCorrectionLoopStats,
} from "./repair-loop"
export type {
  CorrectionLoopGateStat,
  CorrectionLoopStats,
} from "./repair-loop"
export {
  GateRetryDiffError,
  diffGateRunPair,
  diffLatestGateRetries,
} from "./gate-retry-diff"
export type {
  GateRetryDiff,
  GateRunSide,
} from "./gate-retry-diff"
export {
  AuraHomogenizationError,
  computeVoiceDrift,
  detectAuraHomogenization,
  homogenizationAlertEvents,
  jaccardSimilarity,
  voiceDriftAlertEvents,
} from "./aura-homogenization"
export type {
  ChapterVoiceDrift,
  ChapterVoiceSample,
  HomogenizationAlert,
} from "./aura-homogenization"
// ── 波3-A：多形态数据层批（题材雷达 / 跨形态一致性 / 反事实通用化 / 视觉血缘） ──
export {
  TREND_RADAR_ARTIFACT_SCHEMA_VERSION,
  RADAR_SIGNAL_SCHEMA,
  TrendRadarError,
  buildTrendRadarArtifact,
  probeTrendRadarHealth,
  verifyTrendRadarConservation,
} from "./trend-radar"
export type {
  RadarSignal,
  TrendRadarArtifact,
  TrendRadarHealth,
} from "./trend-radar"
export {
  CROSS_FORM_DERIVATION_SCHEMA,
  CROSS_FORM_KINDS,
  CrossFormConsistencyError,
  crossFormSubGateEvents,
  evaluateCrossFormSubGate,
  evaluateVisCont,
  formL9Status,
  visContEvents,
} from "./cross-form-consistency"
export type {
  ComicFrameAura,
  CrossFormCheck,
  CrossFormDerivation,
  CrossFormKind,
  CrossFormSubGateVerdict,
  FormL9Status,
  VisContFinding,
  VisContVerdict,
} from "./cross-form-consistency"
export {
  CounterfactualLabError,
  counterfactualGateEvents,
  replayCounterfactual,
} from "./counterfactual-lab"
export type {
  CounterfactualGateReplayInput,
  CounterfactualGateReplayResult,
} from "./counterfactual-lab"
export {
  VISUAL_APPLIES_TO,
  VISUAL_ASSET_LINEAGE_SCHEMA,
  VisualLineageError,
  assertVisualAppliesTo,
  buildVisualLineage,
  visualLineageEvents,
  visualLineageEvidenceRefs,
} from "./visual-lineage"
export type { VisualAssetLineage } from "./visual-lineage"
// ── 波2-D：首页/列表只读派生数据源（证据卡接线） ────────────────────────
export {
  buildDashboardEvidenceSnapshot,
  deriveBookHealthSummaries,
  deriveEvidenceGateStatuses,
  deriveSubGateAlerts,
} from "./dashboard-evidence"
export type { BookHealthSummary, SubGateAlertItem } from "./dashboard-evidence"
// ── R-1：共识六条反目标纯函数判定核 ────────────────────────
export {
  AG1_MAX_CORPUS_ENTRIES,
  CORPUS_BASELINE_COUNT,
  EXPECTED_RETRIEVAL_FLAGS,
  checkAntigoals,
  scanConvergenceClaimText,
} from "./consensus-antigoals"
export type { AntigoalId, AntigoalSnapshot, AntigoalViolation } from "./consensus-antigoals"
// ── R0-a1：同尺迁移评测比较核（Wilson CI） ────────────────────────
export {
  SAME_SCALE_VERDICT_SCHEMA,
  compareSameScale,
  wilsonScoreInterval,
} from "./same-scale-harness"
export type { SameScaleResult, SameScaleVerdict, WeknoraSnapshot } from "./same-scale-harness"
// ── B3-a：检索分片路由与跨片确定性归并（批准计划 r3 §T5） ────────
export {
  SHARD_KEY_SCHEMA,
  SHARD_MERGE_POLICY_SCHEMA,
  SHARD_RECALL_SPEC_SCHEMA,
  ShardRoutingError,
  applyShardRecall,
  mergeShards,
  resolveShards,
  selectShardItems,
} from "./shard-routing"
export type { Shard, ShardRecallReport, ShardRecallSpec, ShardableItem } from "./shard-routing"
// ── B2：λ 标定纯函数面（证据面；不翻位） ────────────────────────
export {
  LAMBDA_MIN_POINTS,
  LAMBDA_MIN_SIGNAL_RATIO,
  LAMBDA_MEASUREMENT_SCHEMA,
  LAMBDA_R2_MIN,
  LambdaCalibrationError,
  fitLambda,
  formatLambdaFit,
} from "./lambda-calibration"
export type { LambdaFit, LambdaFitReason, LambdaMeasurement } from "./lambda-calibration"
// ── B3-b：ANN 接口契约 + 精确暴力参考（近似未实现） ────────────────
export {
  ANN_DESCRIPTOR_SCHEMA,
  ANN_HIT_SCHEMA,
  ANN_INDEX_TYPE_SCHEMA,
  ANN_METRIC_SCHEMA,
  ANN_QUERY_SCHEMA,
  ANN_VECTOR_SCHEMA,
  AnnIndexError,
  recallAtK,
  withInjectedClock,
} from "./ann/ann-index"
export type {
  AnnDescriptor,
  AnnHit,
  AnnIndex,
  AnnIndexType,
  AnnMetric,
  AnnQuery,
  AnnVector,
} from "./ann/ann-index"
export { createExactAnnIndex } from "./ann/brute-force-index"
export type { ExactAnnIndexOptions } from "./ann/brute-force-index"
// ── R0-b：rerank 触发证据采集器（R2-a 硬依赖） ────────────────────────
export {
  RERANK_TRIGGER_CHANNEL,
  RERANK_TRIGGER_EVIDENCE_SCHEMA,
  RERANK_TRIGGER_RULE,
  RerankTriggerEvidenceError,
  buildRerankTriggerTraceEntry,
  collectRerankTriggerEvidence,
} from "./rerank-trigger-evidence"
export type {
  RerankTriggerBaseline,
  RerankTriggerEvidence,
  RerankTriggerRank,
  RerankTriggerStatus,
} from "./rerank-trigger-evidence"
// ── R0-c：运行时 span 面（全链观测，零语义改动） ────────────────────────
export {
  RETRIEVAL_SPAN_CHANNEL,
  RETRIEVAL_SPAN_STAGES,
  RetrievalSpanError,
  assertRetrievalSpanSequence,
  buildRetrievalSpanTraceEntry,
  createRetrievalSpanCollector,
  makeRetrievalSpan,
} from "./retrieval-span"
export type {
  RetrievalSpan,
  RetrievalSpanCollector,
  RetrievalSpanDetail,
  RetrievalSpanSink,
  RetrievalSpanStage,
} from "./retrieval-span"
// ── R0-d：延迟-成本预算账本（单一封顶口径 + 可回退注册表 + λ 初值） ──────────
export {
  DEFAULT_RETRIEVAL_BUDGET,
  LAMBDA_MS_PER_PP_INITIAL,
  LLM_RERANK_TIMEOUT_MS,
  RETRIEVAL_BUDGET_PATHS,
  RETRIEVAL_BUDGET_SCHEMA,
  RETRIEVAL_LAMBDA_INITIAL,
  RETRIEVAL_SOURCE_TIMEOUT_MS,
  RetrievalBudgetError,
  ZERO_LLM_DEFAULT_BUDGET_MS,
  checkRetrievalBudget,
  createRetrievalBudgetLedger,
  getRetrievalBudgetLedger,
  resetRetrievalBudgetLedger,
} from "./retrieval-budget"
export type {
  RetrievalBudget,
  RetrievalBudgetLedger,
  RetrievalBudgetPath,
  RetrievalBudgetVerdict,
  RetrievalLambda,
} from "./retrieval-budget"
export {
  CURATION_BATCH_SCHEMA,
  CURATION_DEBT_CAP,
  CURATION_DEBT_WEIGHTS,
  CURATION_ENTRY_SCHEMA,
  CURATION_MIN_SUMMARY_CHARS,
  CURATION_REQUIRED_FIELDS,
  CurationGateError,
  assertCurationDebtWithinCap,
  scoreCurationBatch,
} from "./curation-gate"
export type {
  CurationBatch,
  CurationBatchScore,
  CurationDebtReason,
  CurationEntry,
  CurationFinding,
} from "./curation-gate"
export {
  FANOUT_PROBE_SCHEMA,
  PROMOTION_DOC_FACE_SCHEMA,
  R0_EVIDENCE_FACE_SCHEMA,
  SAME_CLUSTER_FACE_SCHEMA,
  SCALE_UNLOCK_CTX_SCHEMA,
  SCALE_UNLOCK_DECISION_SCHEMA,
  SCALE_UNLOCK_REASON_CODES,
  SCALE_UNLOCK_REPORT_SCHEMA,
  SCALE_UNLOCK_TARGETS,
  SCALE_UNLOCK_THRESHOLDS,
  SCALE_UNLOCK_VERDICT_SCHEMA,
  SPAN_FACE_SCHEMA,
  ScaleUnlockGateError,
  evaluateUnlockGates,
  formatUnlockGateReport,
} from "./scale-unlock-gates"
export type {
  ScaleUnlockCtx,
  ScaleUnlockDecision,
  ScaleUnlockReasonCode,
  ScaleUnlockReport,
  ScaleUnlockTarget,
  ScaleUnlockVerdict,
} from "./scale-unlock-gates"
export {
  ANN_INDEX_KIND_SCHEMA,
  ANN_PLAN_PLACEHOLDER,
  ANN_PLAN_SCHEMA,
  ORE_PIPELINE_CONTRACT_PLACEHOLDER,
  ORE_PIPELINE_CONTRACT_SCHEMA,
  ORE_PIPELINE_STAGES,
  ORE_PRICING_STATUS_SCHEMA,
  SHARD_PLAN_PLACEHOLDER,
  SHARD_PLAN_SCHEMA,
  isOrePipelineUsable,
} from "./retrieval-scale-placeholders"
export type {
  AnnIndexKind,
  AnnPlan,
  OrePipelineContract,
  OrePipelineStage,
  OrePricingStatus,
  ShardPlan,
} from "./retrieval-scale-placeholders"
// ── B4：矿脉计价模型骨架（候选三型；pricing 仍 pending） ────────────
export {
  ORE_COST_ESTIMATE_SCHEMA,
  ORE_PRICING_MODEL_CANDIDATES,
  ORE_PRICING_MODEL_IDS,
  ORE_PRICING_MODEL_SCHEMA,
  ORE_QUOTA_SCHEMA,
  ORE_QUOTA_VERDICT_SCHEMA,
  ORE_USAGE_SCHEMA,
  OrePricingError,
  checkOreQuota,
  estimateOreCost,
  formatOrePricingSkeleton,
} from "./ore-pricing"
export type {
  OreCostEstimate,
  OrePricingModel,
  OrePricingModelId,
  OreQuotaVerdict,
  OreUsage,
} from "./ore-pricing"
