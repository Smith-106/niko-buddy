// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * workflow-draft-tools.ts — Phase 2 确定性工作流路由与草稿精准修订闭环（P2-B3）。
 *
 * 严格依赖与安全边界：
 * 1. 所有 novel 域符号均经 `@/lib/novel` 顶层 barrel 导入（零深导入）；
 * 2. `workflow.next` 严格零 LLM / 零磁盘写，纯调用 `routeControlState` + `firstFailedGate`；
 * 3. `draft.patch` 严守 Draft-first：仅对未采纳、非受门保护的 `status="draft"` 派生新草稿，
 *    强制 `expectedSha256` 乐观并发校验与 `HARD_FUSE_LIMIT` 硬熔断，永不直写正式章、永不绕过采纳门；
 * 4. `draft.record_review` 严守 `Consistency(P0) > Anti-AI(P1) > Quality(P2)` 与
 *    `status.json` 唯一真源：仅可将匹配草稿从 `"pending"` 升至 `"ready"`，绝不写入 `"accepted"`，
 *    绝不在 `status.json` 未初始化时另建第二份状态文件。
 */

import {
  ARBITER_CONSULT_LIMIT,
  DRAFTS_DIR,
  GATE_PRIORITY,
  HARD_FUSE_LIMIT,
  SIX_REVIEW_DIMENSION_ORDER,
  applyDraftAutoArmPatch,
  assertAutoArmPatchNeverAccepts,
  buildDraftAutoArmPatch,
  buildDraftAutoArmRecord,
  buildNextStatus,
  checkFinaleAutoComplete,
  collectProjectSnapshot,
  computeCheckpointDigest,
  createNovelSessionId,
  emptyDecisionGates,
  evaluateDraftAutoArm,
  externalDraftTargetKey,
  firstFailedGate,
  getChapterVolumes,
  getExternalDraftRevisionCount,
  hasPersistedDirectorState,
  isActiveChatDeepChapterSession,
  listChapterDrafts,
  listScopeFiles,
  loadDirectorPersisted,
  loadNovelSessionStatus,
  loadOutlineModel,
  loadSegmentSummaries,
  loadStoryCompass,
  loadWorldBlueprint,
  parseChapterOrdinal,
  readDraftChapterNumber,
  routeControlState,
  segmentIndexForChapter,
  syncExternalDraftToSessionStatus,
  updateNovelSessionStatus,
  withProjectLock,
  writeDraft,
  type ArcBoundary,
  type ChapterDraft,
  type DeepChapterDecisionGate,
  type DeepChapterDecisionGates,
  type DeepChapterGateVerdict,
  type DimensionReviewResult,
  type DirectorPersistedFile,
  type DirectorSnapshot,
  type DraftAutoArmStatus,
  type ExternalDraftStatusEntry,
  type GateRunStatus,
  type GateVerdict,
  type KernelAntiAiMode,
  type KernelRouteShellMode,
  type NovelDraftStatus,
  type NovelReviewResult,
  type NovelSessionStatus,
  type NovelSessionStatusMutator,
  type OutlineModel,
  type OutlineModelLoadResult,
  type RouteAction,
  type RouteControlState,
  type RouteGates,
  type RouteInstruction,
  type SegmentSummaries,
  type SixReviewDimensionKey,
  type StoryCompass,
  type VolumeMeta,
  type WorldBlueprint,
} from "@/lib/novel"
import { normalizePath } from "@/lib/path-utils"
import { logger, toErrorMessage } from "@/lib/utils"
import {
  runMechanicalGateForMcp,
  type MechanicalGateCompactReport,
  type MechanicalGateInput,
} from "./mechanical-gate"

const DRAFT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/

const WORKFLOW_NEXT_KEYS = new Set(["targetChapter", "draftId"])

const DRAFT_PATCH_KEYS = new Set(["draftId", "expectedSha256", "edits", "note"])
const FIND_EDIT_KEYS = new Set(["find", "replace", "occurrence"])
const LINE_EDIT_KEYS = new Set(["startLine", "endLine", "replacement"])
export const MAX_DRAFT_PATCH_EDITS = 25
export const MAX_DRAFT_PATCH_TOTAL_EDIT_CHARS = 100_000
export const MAX_DRAFT_PATCH_RESULT_CHARS = 200_000
export const MAX_DRAFT_PATCH_NOTE_CHARS = 1_000
export const MAX_DRAFT_REVIEW_BLOCKING_ISSUE_CHARS = 1_000

const DRAFT_RECORD_REVIEW_KEYS = new Set([
  "draftId",
  "expectedSha256",
  "gates",
  "overallScore",
  "dimensionScores",
  "summary",
  "blockingIssues",
  "reviewerRole",
  "autoArmEnabled",
])
const RECORD_REVIEW_GATE_KEYS = new Set(["consistency", "anti_ai", "quality"])
const BINARY_GATE_INPUTS = new Set(["pass", "fail", "not_evaluated"])
const QUALITY_GATE_INPUTS = new Set(["pass", "fail", "warning", "not_evaluated"])
const SIX_DIMENSION_SET: ReadonlySet<string> = new Set(SIX_REVIEW_DIMENSION_ORDER)

export type RecommendedMcpProfile = "architect" | "writer-sub" | "reviewer"

function projectRoot(projectPath: string): string {
  return normalizePath(projectPath).replace(/\/+$/, "")
}

function assertProjectPath(projectPath: string, toolName: string): string {
  const root = projectRoot(projectPath)
  if (!root) throw new Error(`${toolName} 需要已打开的项目`)
  return root
}

function assertObjectParams(
  params: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  toolName: string,
): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error(`${toolName} 的 params 必须是对象`)
  }
  for (const key of Object.keys(params)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${toolName} 的参数未知：${key}`)
    }
  }
  return params
}

function resolveChapterFileNumber(name: string): number | undefined {
  const stem = name.replace(/\.md$/i, "")
  const ordinal = parseChapterOrdinal(stem)
  if (ordinal !== null && Number.isSafeInteger(ordinal) && ordinal > 0) return ordinal
  const fromDraft = readDraftChapterNumber(stem)
  if (fromDraft !== undefined) return fromDraft
  const digits = /(\d+)/.exec(stem)
  if (!digits) return undefined
  const num = Number(digits[1])
  return Number.isSafeInteger(num) && num > 0 ? num : undefined
}

// ============================================================================
// 1. workflow.next（零 LLM / 零磁盘写）
// ============================================================================

export interface WorkflowNextDeps {
  loadStatus: (projectPath: string) => Promise<NovelSessionStatus | null>
  listChapters: (projectPath: string) => Promise<Array<{ name: string; path: string }>>
  listDrafts: (projectPath: string) => Promise<ChapterDraft[]>
  hasPersistedDirectorState: (projectPath: string) => Promise<boolean>
  loadDirectorPersisted: (projectPath: string) => Promise<DirectorPersistedFile>
  loadWorldBlueprint: (projectPath: string) => Promise<WorldBlueprint | null>
  collectProjectSnapshot: (
    projectPath: string,
    idea: { title: string; genre: string; coreConflict: string },
  ) => Promise<DirectorSnapshot>
  loadOutlineModel?: (projectPath: string) => Promise<OutlineModelLoadResult>
  loadSegmentSummaries?: (projectPath: string) => Promise<SegmentSummaries>
  loadStoryCompass?: (projectPath: string) => Promise<StoryCompass>
  getChapterVolumes?: (projectPath: string, chapterNumber: number) => Promise<VolumeMeta[]>
}

export interface WorkflowNextResult {
  projectPath: string
  targetChapter: number
  activeDraftId: string | null
  revisionRound: number
  hardFuseLimit: number
  arbiterConsultLimit: number
  hardFuseTripped: boolean
  instruction: RouteInstruction
  firstFailedGate: (typeof GATE_PRIORITY)[number] | null
  gatePriority: readonly (typeof GATE_PRIORITY)[number][]
  recommendedProfile: RecommendedMcpProfile
  recommendedTools: string[]
  requiresHumanAccept: boolean
  workflowHint: string
  controlState: RouteControlState
  summary: {
    formalChapterCount: number
    activeDraftCount: number
    hasSessionStatus: boolean
    sessionStatus: NovelSessionStatus["status"] | null
    draftStatus: NovelDraftStatus | null
  }
  meta: {
    readOnly: true
    llmCalls: 0
    diskWrites: 0
  }
}

function mapDecisionGateToRouteVerdict(gate?: DeepChapterDecisionGate): GateVerdict {
  if (!gate) return "pending"
  if (gate.status === "failed" || gate.verdict === "fail" || gate.verdict === "manual_review") {
    return "fail"
  }
  if (gate.status === "passed" || gate.verdict === "pass" || gate.verdict === "warning") {
    return "pass"
  }
  return "pending"
}

function normalizeKernelAntiAiMode(raw: unknown): KernelAntiAiMode {
  if (raw === "off" || raw === "warn" || raw === "block") return raw
  // MCP 外部写作评审默认按 block 路由 P1 失败，避免高风险去 AI 味问题静默跳过修订。
  return "block"
}

function normalizeKernelShellMode(raw: unknown): KernelRouteShellMode {
  if (raw === "legacy" || raw === "consult" || raw === "authoritative") return raw
  return "legacy"
}

function resolveRecommendedProfile(instruction: RouteInstruction): RecommendedMcpProfile {
  switch (instruction.action) {
    case "foundation_fill":
      return "architect"
    case "arc_transition":
      return instruction.arcStep === "expand_arc" || instruction.arcStep === "new_volume"
        ? "architect"
        : "writer-sub"
    case "review":
    case "global_review":
    case "judge":
    case "arbitrate":
      return "reviewer"
    default:
      return "writer-sub"
  }
}

function resolveRecommendedTools(action: RouteAction): string[] {
  switch (action) {
    case "foundation_fill":
      return ["director.check", "outline.read", "outline.write", "character.upsert"]
    case "context_assembly":
    case "scene_breakdown":
    case "task_brief":
      return ["context.prepare_write", "rules.get", "foreshadowing.list", "outline.read"]
    case "write_draft":
    case "rewrite":
      return ["context.prepare_write", "chapter.write", "gate.check_mechanical"]
    case "review":
    case "global_review":
      // reviewer profile 严格只读（不含 draft.record_review），由 reviewer 输出结构化结论后交由 writer-sub 落盘记录。
      return [
        "draft.read",
        "gate.check_mechanical",
        "context.prepare_write",
        "canon.query",
        "foreshadowing.list",
      ]
    case "revise":
      return ["draft.read", "draft.patch", "gate.check_mechanical"]
    case "judge":
      return ["draft.read", "project.state"]
    case "arbitrate":
      return ["draft.read", "project.state", "gate.check_mechanical"]
    case "arc_transition":
      return ["outline.read", "foreshadowing.list", "character.read"]
    case "halt":
      return ["project.state"]
  }
}

function buildWorkflowNextHint(input: {
  instruction: RouteInstruction
  activeDraftId: string | null
  targetChapter: number
  firstFailedGate: (typeof GATE_PRIORITY)[number] | null
}): string {
  const { instruction, activeDraftId, targetChapter, firstFailedGate: failed } = input
  const draftLabel = activeDraftId ?? `第${targetChapter}章草稿`
  switch (instruction.action) {
    case "review":
    case "global_review":
      return `当前推荐以只读 reviewer profile 审阅 ${draftLabel}（仅使用 draft.read / gate.check_mechanical / context.prepare_write / canon.query / foreshadowing.list）；reviewer profile 不含写工具，审阅完成后请将结构化门控结论（gates、blockingIssues、dimensionScores）传递给 writer-sub 调用 draft.record_review 落盘。`
    case "revise":
      return `草稿 ${draftLabel} 存在未通过门控（首要阻塞：${failed ?? "待核查"}，优先级 P0 > P1 > P2）。请由 writer-sub 调用 draft.read 获取 bodySha256 后使用 draft.patch 精准修订，再运行 gate.check_mechanical 复检。`
    case "judge":
      return `草稿 ${draftLabel} 门控已就绪，请通知用户在 Niko Buddy 应用内人工审阅并采纳（任何自动化路径均不会自动 accept）。`
    case "arbitrate":
      return `草稿 ${draftLabel} 需要人工仲裁（已触发硬熔断或阻塞门控），请先核查状态并交由用户人工决定。`
    case "foundation_fill":
      return `第${targetChapter}章开写前规划前置存在缺项，请由 architect profile 补齐设定、大纲或角色后再进入正文撰写。`
    case "arc_transition":
      return `第${targetChapter}章处于卷/弧过渡节点，请先核查大纲、伏笔账本与角色状态后再继续推进。`
    case "write_draft":
    case "rewrite":
      return `请由 writer-sub 结合 context.prepare_write 产出第${targetChapter}章草稿，通过 chapter.write 写入待审区后再运行 gate.check_mechanical。`
    case "context_assembly":
    case "scene_breakdown":
    case "task_brief":
      return `请由 writer-sub 调用 context.prepare_write、rules.get、foreshadowing.list 与 outline.read 组装第${targetChapter}章写作上下文。`
    case "halt":
      return "当前工作流已暂停，请通过 project.state 检查项目状态后再决定后续动作。"
  }
}

function resolveArcAndFinaleState(input: {
  lastCompletedChapter: number
  outlineModel: OutlineModel | null
  chapterVolumes: readonly VolumeMeta[]
  segmentSummaries: SegmentSummaries
  storyCompass: StoryCompass | null
  status: NovelSessionStatus | null
}): {
  arcBoundary?: ArcBoundary
  hasArcReview: boolean
  hasArcSummary: boolean
  hasVolumeSummary: boolean
  finaleAutoCompleted: boolean
} {
  const { lastCompletedChapter, outlineModel, chapterVolumes, segmentSummaries, storyCompass, status } = input
  if (lastCompletedChapter <= 0) {
    return {
      hasArcReview: false,
      hasArcSummary: false,
      hasVolumeSummary: false,
      finaleAutoCompleted: false,
    }
  }

  let isArcEnd = false
  let isVolumeEnd = false
  let hasNextVolume = false
  let needsExpansion = false
  let nextArc = 0
  let currentVolumeNumber: number | undefined
  let arcLabel = ""

  const matchedVolumeMeta =
    chapterVolumes.find((v) => v.chapterRangeEnd === lastCompletedChapter)
    ?? chapterVolumes.find(
      (v) =>
        v.chapterRangeStart !== undefined
        && v.chapterRangeEnd !== undefined
        && lastCompletedChapter >= v.chapterRangeStart
        && lastCompletedChapter <= v.chapterRangeEnd,
    )

  if (outlineModel && outlineModel.volumes.length > 0) {
    const sortedVolumes = [...outlineModel.volumes].sort((a, b) => a.number - b.number)
    for (const vol of sortedVolumes) {
      const sortedChapters = [...vol.chapters].sort((a, b) => a.chapter - b.chapter)
      const chIdx = sortedChapters.findIndex((c) => c.chapter === lastCompletedChapter)
      if (chIdx === -1) continue

      const matchedCh = sortedChapters[chIdx]!
      currentVolumeNumber = vol.number
      isVolumeEnd = chIdx === sortedChapters.length - 1
      hasNextVolume = sortedVolumes.some((v) => v.number > vol.number)

      const currentArc = matchedCh.arc.trim()
      const nextChapterInVol = sortedChapters[chIdx + 1]
      const nextArcName = nextChapterInVol?.arc.trim() ?? ""
      const isIntraVolumeArcEnd =
        !isVolumeEnd && currentArc !== "" && nextArcName !== "" && nextArcName !== currentArc

      isArcEnd = isVolumeEnd || isIntraVolumeArcEnd
      arcLabel = currentArc || vol.arc.trim()

      if (isIntraVolumeArcEnd && nextChapterInVol) {
        const seenArcs = new Set<string>()
        for (let i = 0; i <= chIdx; i += 1) {
          const name = sortedChapters[i]!.arc.trim()
          if (name) seenArcs.add(name)
        }
        nextArc = seenArcs.size + 1
        needsExpansion =
          nextChapterInVol.prose.goal.trim() === "" && nextChapterInVol.prose.scenes.length === 0
      }
      break
    }
  }

  if (!isArcEnd && matchedVolumeMeta && matchedVolumeMeta.chapterRangeEnd === lastCompletedChapter) {
    currentVolumeNumber = matchedVolumeMeta.volumeNumber
    isVolumeEnd = true
    isArcEnd = true
    hasNextVolume = false
    arcLabel = matchedVolumeMeta.title
  }

  let finaleAutoCompleted = false
  if (isVolumeEnd && currentVolumeNumber !== undefined && storyCompass) {
    const finale = checkFinaleAutoComplete({
      volumeComplete: true,
      finalVolumeDeclared: storyCompass.finalVolumeDeclared,
      currentVolumeNumber,
      finalVolumeNumber: storyCompass.finalVolumeNumber,
    })
    finaleAutoCompleted = finale.completed
  }

  if (!isArcEnd) {
    return {
      hasArcReview: false,
      hasArcSummary: false,
      hasVolumeSummary: false,
      finaleAutoCompleted,
    }
  }

  const candidateKeys = [
    `chapter:${lastCompletedChapter}`,
    ...(currentVolumeNumber !== undefined && arcLabel ? [`v${currentVolumeNumber}:${arcLabel}`] : []),
    ...(currentVolumeNumber !== undefined && isVolumeEnd ? [`v${currentVolumeNumber}`] : []),
    String(lastCompletedChapter),
  ]
  const settlementMap = status?.arc_settlement_completed ?? {}
  let settledReview = false
  let settledSummary = false
  let settledVolumeSummary = false
  for (const key of candidateKeys) {
    const rec = settlementMap[key]
    if (!rec) continue
    if (rec.arc_review === true) settledReview = true
    if (rec.arc_summary === true) settledSummary = true
    if (rec.volume_summary === true) settledVolumeSummary = true
  }

  const segKey = String(segmentIndexForChapter(lastCompletedChapter))
  const segHasArcSummary = Boolean(
    segmentSummaries[segKey]?.trim()
    || segmentSummaries[`chapter:${lastCompletedChapter}`]?.trim()
    || (arcLabel && segmentSummaries[`arc:${arcLabel}`]?.trim()),
  )
  const segHasVolumeSummary = Boolean(
    currentVolumeNumber !== undefined && segmentSummaries[`volume:${currentVolumeNumber}`]?.trim(),
  )

  const hasArcReview = settledReview
  const hasArcSummary = settledSummary || segHasArcSummary
  const hasVolumeSummary =
    settledVolumeSummary || segHasVolumeSummary || Boolean(matchedVolumeMeta?.summary?.trim())
  const needsNewVolume = isVolumeEnd && !hasNextVolume && !finaleAutoCompleted

  return {
    arcBoundary: {
      isArcEnd: true,
      isVolumeEnd,
      needsExpansion,
      needsNewVolume,
      nextArc,
    },
    hasArcReview,
    hasArcSummary,
    hasVolumeSummary,
    finaleAutoCompleted,
  }
}

export async function runWorkflowNext(
  projectPath: string,
  params: Record<string, unknown> = {},
  depsOverrides?: Partial<WorkflowNextDeps>,
): Promise<WorkflowNextResult> {
  const toolName = "workflow.next"
  assertProjectPath(projectPath, toolName)
  assertObjectParams(params, WORKFLOW_NEXT_KEYS, toolName)

  let explicitTargetChapter: number | undefined
  if (params.targetChapter !== undefined) {
    if (
      typeof params.targetChapter !== "number"
      || !Number.isInteger(params.targetChapter)
      || params.targetChapter < 1
    ) {
      throw new Error(`${toolName} 的 targetChapter 必须是 >= 1 的整数`)
    }
    explicitTargetChapter = params.targetChapter
  }

  let explicitDraftId: string | undefined
  if (params.draftId !== undefined) {
    if (typeof params.draftId !== "string" || !DRAFT_ID_PATTERN.test(params.draftId.trim())) {
      throw new Error(`${toolName} 的 draftId 非法（仅允许 1-128 位字母、数字、下划线或连字符）`)
    }
    explicitDraftId = params.draftId.trim()
  }

  const deps: Required<WorkflowNextDeps> = {
    loadStatus: depsOverrides?.loadStatus ?? loadNovelSessionStatus,
    listChapters: depsOverrides?.listChapters ?? ((pp) => listScopeFiles(pp, "chapters")),
    listDrafts: depsOverrides?.listDrafts ?? listChapterDrafts,
    hasPersistedDirectorState: depsOverrides?.hasPersistedDirectorState ?? hasPersistedDirectorState,
    loadDirectorPersisted: depsOverrides?.loadDirectorPersisted ?? loadDirectorPersisted,
    loadWorldBlueprint: depsOverrides?.loadWorldBlueprint ?? loadWorldBlueprint,
    collectProjectSnapshot: depsOverrides?.collectProjectSnapshot ?? collectProjectSnapshot,
    loadOutlineModel: depsOverrides?.loadOutlineModel ?? loadOutlineModel,
    loadSegmentSummaries: depsOverrides?.loadSegmentSummaries ?? loadSegmentSummaries,
    loadStoryCompass: depsOverrides?.loadStoryCompass ?? loadStoryCompass,
    getChapterVolumes: depsOverrides?.getChapterVolumes ?? getChapterVolumes,
  }

  const [
    status,
    chapters,
    drafts,
    hasDirector,
    persistedDirector,
    worldBlueprint,
    outlineModelLoad,
    segmentSummaries,
    storyCompass,
  ] = await Promise.all([
    deps.loadStatus(projectPath).catch(() => null),
    deps.listChapters(projectPath).catch(() => [] as Array<{ name: string; path: string }>),
    deps.listDrafts(projectPath).catch(() => [] as ChapterDraft[]),
    deps.hasPersistedDirectorState(projectPath).catch(() => false),
    deps.loadDirectorPersisted(projectPath).catch(() => null),
    deps.loadWorldBlueprint(projectPath).catch(() => null),
    deps.loadOutlineModel(projectPath).catch(() => ({ model: null, migratedFrom: null } as OutlineModelLoadResult)),
    deps.loadSegmentSummaries(projectPath).catch(() => ({} as SegmentSummaries)),
    deps.loadStoryCompass(projectPath).catch(() => null),
  ])

  let maxFormalChapter = 0
  for (const ch of chapters) {
    const n = resolveChapterFileNumber(ch.name)
    if (n !== undefined && n > maxFormalChapter) maxFormalChapter = n
  }
  const completedChapters = chapters.length
  const lastCompletedChapter = maxFormalChapter > 0 ? maxFormalChapter : completedChapters
  const defaultNextChapter = Math.max(maxFormalChapter, completedChapters) + 1

  const activeDrafts = drafts
    .filter((d) => d.status === "draft")
    .sort((a, b) => b.createdAt - a.createdAt || (b.revisionRound ?? 0) - (a.revisionRound ?? 0))

  let activeDraft: ChapterDraft | undefined
  if (explicitDraftId !== undefined) {
    activeDraft = drafts.find((d) => d.id === explicitDraftId)
    if (!activeDraft) {
      throw new Error(`找不到草稿：${explicitDraftId}`)
    }
  } else if (explicitTargetChapter !== undefined) {
    activeDraft = activeDrafts.find(
      (d) => readDraftChapterNumber(d.chapterName) === explicitTargetChapter,
    )
  } else {
    activeDraft = activeDrafts[0]
  }

  let directorSnapshot: DirectorSnapshot | null = null
  if (completedChapters === 0 && !activeDraft) {
    const ideaInput = persistedDirector?.ideaInput ?? { title: "", genre: "", coreConflict: "" }
    directorSnapshot = await deps
      .collectProjectSnapshot(projectPath, ideaInput)
      .catch(() => null)
  }

  const chapterVolumes =
    completedChapters > 0 && !activeDraft && lastCompletedChapter > 0
      ? await deps.getChapterVolumes(projectPath, lastCompletedChapter).catch(() => [] as VolumeMeta[])
      : ([] as VolumeMeta[])

  const draftChapterNum = activeDraft ? readDraftChapterNumber(activeDraft.chapterName) : undefined
  const targetChapter = explicitTargetChapter ?? draftChapterNum ?? defaultNextChapter

  // 合并草稿自身轮次、external_draft_states 轮次与章节级持久熔断计数
  const activeDraftTargetKey = activeDraft
    ? externalDraftTargetKey(projectPath, activeDraft.chapterName)
    : undefined
  const primaryMatchesActiveDraft = Boolean(
    status && activeDraft && status.draft.draft_id === activeDraft.id,
  )
  const externalDraftState: ExternalDraftStatusEntry | undefined =
    activeDraft && !primaryMatchesActiveDraft
      ? status?.external_draft_states?.[activeDraft.id]
      : undefined
  const persistedChapterRound = activeDraftTargetKey
    ? getExternalDraftRevisionCount(status, activeDraftTargetKey)
    : 0
  const revisionRound = Math.max(
    activeDraft?.revisionRound ?? 0,
    externalDraftState?.revision_round ?? 0,
    persistedChapterRound,
  )
  const hardFuseTripped = revisionRound >= HARD_FUSE_LIMIT

  // 规划期缺项探测：
  // 1. 已初始化 director-pipeline.json 时校验 6 项完整开书前置；
  // 2. 空白新项目（0 章无草稿且无 director-pipeline.json）仍按真实产物探针检测 world/protagonist/outline，
  //    避免空白项目跳过 foundation_fill 直接开写第 1 章。
  const outlineModel = outlineModelLoad?.model ?? null
  const foundationMissing: string[] = []
  if (completedChapters === 0 && !activeDraft) {
    if (hasDirector && directorSnapshot) {
      if (!directorSnapshot.idea.title.trim()) foundationMissing.push("title")
      if (!directorSnapshot.idea.genre.trim()) foundationMissing.push("genre")
      if (!directorSnapshot.idea.coreConflict.trim()) foundationMissing.push("coreConflict")
      if (!directorSnapshot.worldComplete && !worldBlueprint?.layers) foundationMissing.push("world")
      if (!directorSnapshot.protagonistNamed) foundationMissing.push("protagonist")
      if (!directorSnapshot.frameworkChosen && !(outlineModel && outlineModel.volumes.length > 0)) {
        foundationMissing.push("outline")
      }
    } else if (!hasDirector) {
      if (!directorSnapshot?.worldComplete && !worldBlueprint?.layers) foundationMissing.push("world")
      if (!directorSnapshot?.protagonistNamed) foundationMissing.push("protagonist")
      if (!directorSnapshot?.frameworkChosen && !(outlineModel && outlineModel.volumes.length > 0)) {
        foundationMissing.push("outline")
      }
    }
  }

  // 弧末边界与终局自动完结判定（仅在无在途未采纳草稿且已有成章时检测）
  const arcAndFinale =
    completedChapters > 0 && !activeDraft
      ? resolveArcAndFinaleState({
          lastCompletedChapter,
          outlineModel,
          chapterVolumes,
          segmentSummaries,
          storyCompass,
          status,
        })
      : {
          arcBoundary: undefined,
          hasArcReview: false,
          hasArcSummary: false,
          hasVolumeSummary: false,
          finaleAutoCompleted: false,
        }

  const bookCompleted = Boolean(
    status?.book_completed === true || (!activeDraft && arcAndFinale.finaleAutoCompleted),
  )

  const phase: RouteControlState["phase"] = bookCompleted
    ? "complete"
    : foundationMissing.length > 0
      ? "planning"
      : "writing"

  const resolvedDecisionGates: DeepChapterDecisionGates | undefined = primaryMatchesActiveDraft
    ? status?.decision_gates
    : externalDraftState?.decision_gates
  const resolvedDraftStatus: NovelDraftStatus | null = activeDraft
    ? (primaryMatchesActiveDraft
        ? (status?.draft.draft_status ?? null)
        : (externalDraftState?.draft_status ?? null))
    : (status?.draft.draft_status ?? null)
  const resolvedAutoArm = primaryMatchesActiveDraft
    ? status?.draft_auto_arm
    : externalDraftState?.draft_auto_arm

  const gates: RouteGates = resolvedDecisionGates
    ? {
        consistency: mapDecisionGateToRouteVerdict(resolvedDecisionGates.consistency),
        anti_ai: mapDecisionGateToRouteVerdict(resolvedDecisionGates.anti_ai),
        quality: mapDecisionGateToRouteVerdict(resolvedDecisionGates.quality),
      }
    : {
        consistency: "pending",
        anti_ai: "pending",
        quality: "pending",
      }

  const antiAiMode = normalizeKernelAntiAiMode(status?.anti_ai_mode)
  const hasBlockingGateFailure =
    gates.consistency === "fail"
    || (gates.anti_ai === "fail" && antiAiMode === "block")
    || resolvedDecisionGates?.overall === "fail"
  const activeDraftArmedReady =
    Boolean(activeDraft)
    && !hasBlockingGateFailure
    && (resolvedDraftStatus === "ready" || resolvedAutoArm?.armed === true)
  const hasPendingMandatoryGate =
    Boolean(activeDraft)
    && !hasBlockingGateFailure
    && !activeDraftArmedReady
    && (gates.consistency === "pending" || gates.anti_ai === "pending")

  const manualReviewRequired = Boolean(
    hardFuseTripped
    || (primaryMatchesActiveDraft && (status?.status === "blocked" || status?.decision_gates.overall === "manual_review"))
    || externalDraftState?.decision_gates.overall === "manual_review"
    || activeDraft?.adoptionGate?.status === "manual_review",
  )

  let stage: RouteControlState["stage"]
  if (activeDraft) {
    if (activeDraft.status === "saved" || activeDraftArmedReady) {
      stage = "done"
    } else if (
      resolvedDecisionGates?.overall === "fail"
      && gates.quality === "fail"
      && gates.consistency === "pass"
      && gates.anti_ai === "pass"
    ) {
      stage = "revision"
    } else {
      stage = "review"
    }
  } else if (
    status
    && status.current_task.chapter_number === targetChapter
    && (status.current_task.checkpoint_stage === "after_context"
      || status.current_task.checkpoint_stage === "after_task_brief")
  ) {
    stage = "draft"
  } else {
    stage = "context"
  }

  const pendingRewrites: number[] = Array.isArray(status?.pending_rewrites)
    ? status.pending_rewrites.filter(
        (n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1,
      )
    : []
  const reviewInterval =
    typeof status?.review_interval === "number"
    && Number.isInteger(status.review_interval)
    && status.review_interval >= 0
      ? status.review_interval
      : 0
  const lastGlobalReviewChapter =
    typeof status?.last_global_review_chapter === "number"
    && Number.isInteger(status.last_global_review_chapter)
    && status.last_global_review_chapter >= 0
      ? status.last_global_review_chapter
      : 0

  const controlState: RouteControlState = {
    phase,
    stage,
    chapterNumber: targetChapter,
    completedChapters,
    pendingRewrites,
    gates,
    antiAiMode,
    manualReviewRequired,
    foundationMissing,
    planningTier: foundationMissing.length > 0 ? "long" : "",
    reviewInterval,
    lastGlobalReviewChapter,
    ...(arcAndFinale.arcBoundary ? { arcBoundary: arcAndFinale.arcBoundary } : {}),
    hasArcReview: arcAndFinale.hasArcReview,
    hasArcSummary: arcAndFinale.hasArcSummary,
    hasVolumeSummary: arcAndFinale.hasVolumeSummary,
    shellMode: normalizeKernelShellMode(status?.route_shell_mode),
  }

  // P0 consistency 或 P1 anti_ai 仍 pending 时，控制核仅在三门全 pending 时路由 review；
  // 向 routeControlState 传入规范化全 pending 门控阻断早跳 judge，同时保留返回体中的真实逐门控摘要。
  const routingControlState: RouteControlState =
    stage === "review" && hasPendingMandatoryGate
      ? {
          ...controlState,
          stage: "review",
          gates: {
            consistency: "pending",
            anti_ai: "pending",
            quality: "pending",
          },
        }
      : controlState

  const instruction = routeControlState(routingControlState)
  const failedGate = firstFailedGate(controlState.gates)
  const recommendedProfile = resolveRecommendedProfile(instruction)
  const recommendedTools = resolveRecommendedTools(instruction.action)
  const requiresHumanAccept =
    instruction.action === "judge" || instruction.action === "arbitrate"
  const workflowHint = buildWorkflowNextHint({
    instruction,
    activeDraftId: activeDraft?.id ?? null,
    targetChapter,
    firstFailedGate: failedGate ?? null,
  })

  return {
    projectPath,
    targetChapter,
    activeDraftId: activeDraft?.id ?? null,
    revisionRound,
    hardFuseLimit: HARD_FUSE_LIMIT,
    arbiterConsultLimit: ARBITER_CONSULT_LIMIT,
    hardFuseTripped,
    instruction,
    firstFailedGate: failedGate ?? null,
    gatePriority: [...GATE_PRIORITY],
    recommendedProfile,
    recommendedTools,
    requiresHumanAccept,
    workflowHint,
    controlState,
    summary: {
      formalChapterCount: completedChapters,
      activeDraftCount: activeDrafts.length,
      hasSessionStatus: status !== null,
      sessionStatus: status?.status ?? null,
      draftStatus: resolvedDraftStatus,
    },
    meta: {
      readOnly: true,
      llmCalls: 0,
      diskWrites: 0,
    },
  }
}

// ============================================================================
// 2. draft.patch（乐观并发 + 硬熔断 + 派生新草稿，绝不改正式章）
// ============================================================================

export type DraftPatchEdit =
  | { find: string; replace: string; occurrence?: number }
  | { startLine: number; endLine: number; replacement: string }

export interface DraftPatchDeps {
  listDrafts: (projectPath: string) => Promise<ChapterDraft[]>
  writeDraft: typeof writeDraft
  loadStatus?: (projectPath: string) => Promise<NovelSessionStatus | null>
  syncExternalDraft?: typeof syncExternalDraftToSessionStatus
}

export interface DraftPatchResult {
  draftId: string
  parentDraftId: string
  chapterName: string
  chapterNumber: number | null
  path: string
  revisionRound: number
  hardFuseLimit: number
  remainingRounds: number
  bodySha256: string
  parentBodySha256: string
  chars: number
  deltaChars: number
  editsApplied: number
  note: string | null
  workflowHint: string
}

function normalizeDraftPatchEdits(rawEdits: unknown): DraftPatchEdit[] {
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
    throw new Error("draft.patch 的 edits 必须是非空数组（1..25 条）")
  }
  if (rawEdits.length > MAX_DRAFT_PATCH_EDITS) {
    throw new Error(`draft.patch 的 edits 数量超过上限（${rawEdits.length} > ${MAX_DRAFT_PATCH_EDITS}）`)
  }

  let totalEditChars = 0
  const normalized: DraftPatchEdit[] = []

  for (let i = 0; i < rawEdits.length; i += 1) {
    const raw = rawEdits[i]
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`draft.patch 的 edits[${i}] 必须是对象`)
    }
    const obj = raw as Record<string, unknown>
    const keys = Object.keys(obj)
    const hasFindKeys = "find" in obj || "replace" in obj || "occurrence" in obj
    const hasLineKeys = "startLine" in obj || "endLine" in obj || "replacement" in obj

    if (hasFindKeys && hasLineKeys) {
      throw new Error(`draft.patch 的 edits[${i}] 不能混用 find/replace 与 startLine/endLine 字段`)
    }
    if (!hasFindKeys && !hasLineKeys) {
      throw new Error(`draft.patch 的 edits[${i}] 必须提供 find/replace 或 startLine/endLine/replacement`)
    }

    if (hasFindKeys) {
      for (const k of keys) {
        if (!FIND_EDIT_KEYS.has(k)) {
          throw new Error(`draft.patch 的 edits[${i}] 包含未知字段：${k}`)
        }
      }
      if (typeof obj.find !== "string" || obj.find.length === 0) {
        throw new Error(`draft.patch 的 edits[${i}].find 必须是非空字符串`)
      }
      if (typeof obj.replace !== "string") {
        throw new Error(`draft.patch 的 edits[${i}].replace 必须是字符串`)
      }
      let occurrence: number | undefined
      if (obj.occurrence !== undefined) {
        if (typeof obj.occurrence !== "number" || !Number.isInteger(obj.occurrence) || obj.occurrence < 1) {
          throw new Error(`draft.patch 的 edits[${i}].occurrence 必须是 >= 1 的整数`)
        }
        occurrence = obj.occurrence
      }
      totalEditChars += obj.find.length + obj.replace.length
      normalized.push({
        find: obj.find,
        replace: obj.replace,
        ...(occurrence !== undefined ? { occurrence } : {}),
      })
    } else {
      for (const k of keys) {
        if (!LINE_EDIT_KEYS.has(k)) {
          throw new Error(`draft.patch 的 edits[${i}] 包含未知字段：${k}`)
        }
      }
      if (typeof obj.startLine !== "number" || !Number.isInteger(obj.startLine) || obj.startLine < 1) {
        throw new Error(`draft.patch 的 edits[${i}].startLine 必须是 >= 1 的整数`)
      }
      if (typeof obj.endLine !== "number" || !Number.isInteger(obj.endLine) || obj.endLine < obj.startLine) {
        throw new Error(`draft.patch 的 edits[${i}].endLine 必须是 >= startLine 的整数`)
      }
      if (typeof obj.replacement !== "string") {
        throw new Error(`draft.patch 的 edits[${i}].replacement 必须是字符串`)
      }
      totalEditChars += obj.replacement.length
      normalized.push({
        startLine: obj.startLine,
        endLine: obj.endLine,
        replacement: obj.replacement,
      })
    }
  }

  if (totalEditChars > MAX_DRAFT_PATCH_TOTAL_EDIT_CHARS) {
    throw new Error(
      `draft.patch 的 edits 总字符数超过上限（${totalEditChars} > ${MAX_DRAFT_PATCH_TOTAL_EDIT_CHARS}）`,
    )
  }

  return normalized
}

interface LineSpan {
  start: number
  contentEnd: number
  eol: "\r\n" | "\n" | ""
}

function parseLineSpans(text: string): LineSpan[] {
  const spans: LineSpan[] = []
  let lineStart = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === "\r" && text[i + 1] === "\n") {
      spans.push({ start: lineStart, contentEnd: i, eol: "\r\n" })
      i += 2
      lineStart = i
    } else if (ch === "\n") {
      spans.push({ start: lineStart, contentEnd: i, eol: "\n" })
      i += 1
      lineStart = i
    } else {
      i += 1
    }
  }
  spans.push({ start: lineStart, contentEnd: text.length, eol: "" })
  return spans
}

function applyDeterministicDraftPatch(original: string, edits: readonly DraftPatchEdit[]): string {
  const lineSpans = parseLineSpans(original)
  const dominantEol: "\r\n" | "\n" = original.includes("\r\n") ? "\r\n" : "\n"
  const resolved: Array<{ index: number; start: number; end: number; replacement: string }> = []

  for (let i = 0; i < edits.length; i += 1) {
    const edit = edits[i]!
    if ("find" in edit) {
      const positions: number[] = []
      let pos = 0
      while (pos <= original.length) {
        const idx = original.indexOf(edit.find, pos)
        if (idx === -1) break
        positions.push(idx)
        pos = idx + 1
      }
      if (positions.length === 0) {
        throw new Error(`draft.patch 拒绝：edits[${i}] 未在原草稿中找到匹配的 find 文本`)
      }
      if (edit.occurrence !== undefined) {
        if (edit.occurrence > positions.length) {
          throw new Error(
            `draft.patch 拒绝：edits[${i}] 的 occurrence=${edit.occurrence} 越界（共匹配 ${positions.length} 处）`,
          )
        }
        const start = positions[edit.occurrence - 1]!
        resolved.push({
          index: i,
          start,
          end: start + edit.find.length,
          replacement: edit.replace,
        })
      } else {
        if (positions.length > 1) {
          throw new Error(
            `draft.patch 拒绝：edits[${i}] 匹配到 ${positions.length} 处文本，存在歧义；请指定 occurrence 或扩大 find 上下文`,
          )
        }
        const start = positions[0]!
        resolved.push({
          index: i,
          start,
          end: start + edit.find.length,
          replacement: edit.replace,
        })
      }
    } else {
      if (edit.startLine > lineSpans.length || edit.endLine > lineSpans.length) {
        throw new Error(
          `draft.patch 拒绝：edits[${i}] 行号范围 ${edit.startLine}..${edit.endLine} 越界（原草稿共 ${lineSpans.length} 行）`,
        )
      }
      const start = lineSpans[edit.startLine - 1]!.start
      const end = lineSpans[edit.endLine - 1]!.contentEnd
      const normalizedReplacement =
        dominantEol === "\r\n"
          ? edit.replacement.replace(/\r?\n/g, "\r\n")
          : edit.replacement.replace(/\r\n/g, "\n")
      resolved.push({
        index: i,
        start,
        end,
        replacement: normalizedReplacement,
      })
    }
  }

  // 冲突检测：按起始偏移升序检查任意重叠区间（包含同起点重复区间）。
  const ascending = [...resolved].sort((a, b) => a.start - b.start || a.end - b.end)
  for (let i = 1; i < ascending.length; i += 1) {
    const prev = ascending[i - 1]!
    const curr = ascending[i]!
    if (curr.start < prev.end || (curr.start === prev.start && curr.end === prev.end)) {
      throw new Error(
        `DRAFT_PATCH_OVERLAPPING_EDITS: edits[${prev.index}] 与 edits[${curr.index}] 修改区间重叠，请合并或调整编辑`,
      )
    }
  }

  // 逆序应用：每个编辑偏移量都基于原始文本，逆序拼接保证零偏移漂移。
  const descending = [...ascending].reverse()
  let nextContent = original
  for (const span of descending) {
    nextContent = nextContent.slice(0, span.start) + span.replacement + nextContent.slice(span.end)
  }

  if (!nextContent.trim()) {
    throw new Error("draft.patch 拒绝：应用编辑后草稿正文不能为空")
  }
  if (nextContent.length > MAX_DRAFT_PATCH_RESULT_CHARS) {
    throw new Error(
      `draft.patch 拒绝：应用编辑后正文长度超过上限（${nextContent.length} > ${MAX_DRAFT_PATCH_RESULT_CHARS}）`,
    )
  }

  return nextContent
}

export async function runDraftPatch(
  projectPath: string,
  params: Record<string, unknown> = {},
  depsOverrides?: Partial<DraftPatchDeps>,
): Promise<DraftPatchResult> {
  const toolName = "draft.patch"
  const pp = assertProjectPath(projectPath, toolName)
  assertObjectParams(params, DRAFT_PATCH_KEYS, toolName)

  const rawDraftId = params.draftId
  if (typeof rawDraftId !== "string" || !DRAFT_ID_PATTERN.test(rawDraftId.trim())) {
    throw new Error(`${toolName} 需要合法的 draftId（1-128 位字母、数字、下划线或连字符）`)
  }
  const draftId = rawDraftId.trim()

  const rawSha = params.expectedSha256
  if (typeof rawSha !== "string" || !SHA256_HEX_PATTERN.test(rawSha.trim())) {
    throw new Error(`${toolName} 需要合法的 64 位十六进制 expectedSha256（来自 draft.read bodySha256）`)
  }
  const expectedSha256 = rawSha.trim()

  const edits = normalizeDraftPatchEdits(params.edits)

  let note: string | null = null
  if (params.note !== undefined) {
    if (typeof params.note !== "string") {
      throw new Error(`${toolName} 的 note 必须是字符串`)
    }
    if (params.note.length > MAX_DRAFT_PATCH_NOTE_CHARS) {
      throw new Error(`${toolName} 的 note 超过 ${MAX_DRAFT_PATCH_NOTE_CHARS} 字符上限`)
    }
    note = params.note.trim() || null
  }

  const deps: Required<DraftPatchDeps> = {
    listDrafts: depsOverrides?.listDrafts ?? listChapterDrafts,
    writeDraft: depsOverrides?.writeDraft ?? writeDraft,
    loadStatus: depsOverrides?.loadStatus ?? loadNovelSessionStatus,
    syncExternalDraft: depsOverrides?.syncExternalDraft ?? syncExternalDraftToSessionStatus,
  }

  // 与 draft-manager（acceptChapterDraft / discardChapterDraft / recordDraftAdoptionGate）共用同一草稿锁键，
  // 确保草稿局部修订与采纳/丢弃/门控落盘严格串行，消除并发竞态。
  return withProjectLock(`draft:${pp}/${DRAFTS_DIR}/${draftId}.md`, async () => {
    const drafts = await deps.listDrafts(projectPath)
    const parent = drafts.find((d) => d.id === draftId)
    if (!parent) {
      throw new Error(`找不到草稿：${draftId}`)
    }
    if (parent.status !== "draft") {
      throw new Error(
        `draft.patch 拒绝：草稿 ${draftId} 当前状态为 ${parent.status}，仅允许对 status="draft" 的草稿执行局部修订`,
      )
    }

    // 严禁对受采纳门保护的草稿派生无门草稿（防止绕过 adoptionGate）
    if (
      parent.adoptionGate !== undefined
      || parent.sourceConversationId === "mcp:deep-chapter"
      || parent.sourceConversationId === "mcp:external-agent"
    ) {
      throw new Error(
        `GATED_DRAFT_PATCH_FORBIDDEN: 草稿 ${draftId} 受采纳门保护，禁止通过 draft.patch 派生`,
      )
    }

    // 章节级持久硬熔断保护（HARD_FUSE_LIMIT = 5）：取草稿自身轮次与 status.json 持久计数最大值，
    // 防止回退旧 draftId 或重调 chapter.write 绕过硬熔断。
    const targetKey = externalDraftTargetKey(projectPath, parent.chapterName)
    const existingStatus = await deps.loadStatus(projectPath).catch(() => null)
    const persistedRound = getExternalDraftRevisionCount(existingStatus, targetKey)
    const prevRound = Math.max(parent.revisionRound ?? 0, persistedRound)
    if (prevRound >= HARD_FUSE_LIMIT) {
      throw new Error(
        `HARD_FUSE_LIMIT_EXCEEDED: 草稿 ${draftId}（${targetKey}）已达最大修订轮次（${prevRound}/${HARD_FUSE_LIMIT}），必须暂停自动修订并交由人工仲裁`,
      )
    }

    const parentBodySha256 = await computeCheckpointDigest(parent.content)
    if (parentBodySha256 !== expectedSha256) {
      throw new Error(
        `DRAFT_SHA256_MISMATCH: 草稿 ${draftId} 正文校验和不匹配（期望 ${expectedSha256}，实际 ${parentBodySha256}），请重新调用 draft.read`,
      )
    }

    const nextContent = applyDeterministicDraftPatch(parent.content, edits)
    const nextRound = prevRound + 1
    const nextSourceConversationId =
      typeof parent.sourceConversationId === "string" && parent.sourceConversationId.startsWith("acp:")
        ? parent.sourceConversationId
        : "mcp:draft.patch"

    // 严禁传 adoptionGate：由 draft.patch 派生的外部修订稿保持诚实无门状态（gateStatus=unassessed, needsGateReview=false）
    const created = await deps.writeDraft(projectPath, parent.chapterName, nextContent, {
      sourceConversationId: nextSourceConversationId,
      parentDraftId: parent.id,
      revisionRound: nextRound,
    })

    const draftPath = `${pp}/${DRAFTS_DIR}/${created.id}.md`
    try {
      await deps.syncExternalDraft({
        projectPath,
        draftId: created.id,
        draftPath,
        chapterName: created.chapterName,
        chapterNumber: readDraftChapterNumber(created.chapterName),
        targetKey,
        revisionRound: nextRound,
        sourceConversationId: nextSourceConversationId,
      })
    } catch (syncError) {
      logger.warn(
        "workflow-draft-tools",
        `draft.patch status.json sync failed (non-fatal, draft ${created.id}): ${toErrorMessage(syncError)}`,
      )
    }

    const bodySha256 = await computeCheckpointDigest(nextContent)
    const remainingRounds = Math.max(0, HARD_FUSE_LIMIT - nextRound)

    return {
      draftId: created.id,
      parentDraftId: parent.id,
      chapterName: created.chapterName,
      chapterNumber: readDraftChapterNumber(created.chapterName) ?? null,
      path: draftPath,
      revisionRound: nextRound,
      hardFuseLimit: HARD_FUSE_LIMIT,
      remainingRounds,
      bodySha256,
      parentBodySha256,
      chars: nextContent.length,
      deltaChars: nextContent.length - parent.content.length,
      editsApplied: edits.length,
      note,
      workflowHint: `修订稿 ${created.id}（第 ${nextRound}/${HARD_FUSE_LIMIT} 轮，派生自 ${parent.id}）已写入待审区。下一步请调用 gate.check_mechanical（draftId="${created.id}", detailLevel="compact"）复检，再调用 draft.record_review 记录门控结论。`,
    }
  })
}

// ============================================================================
// 3. draft.record_review（P0 > P1 > P2，最多升 ready，绝不 accept）
// ============================================================================

export type BinaryReviewGateInput = "pass" | "fail" | "not_evaluated"
export type QualityReviewGateInput = "pass" | "fail" | "warning" | "not_evaluated"
export type DraftRecordReviewStatusJsonReason =
  | "status_json_not_initialized"
  | "initialized_for_draft"
  | "updated_matching_draft"
  | "rebound_external_draft"
  | "updated_external_draft_state"
  | "draft_id_mismatch"

export interface DraftRecordReviewDeps {
  listDrafts: (projectPath: string) => Promise<ChapterDraft[]>
  updateSessionStatus: (
    projectPath: string,
    mutator: NovelSessionStatusMutator,
  ) => Promise<NovelSessionStatus | null>
  runMechanicalGate?: (
    input: MechanicalGateInput & { detailLevel: "compact" },
  ) => Promise<MechanicalGateCompactReport>
  nowIso?: () => string
}

export interface DraftRecordReviewResult {
  projectPath: string
  draftId: string
  chapterName: string
  chapterNumber: number | null
  bodySha256: string
  recordedAt: string
  reviewerRole: string
  gates: {
    consistency: BinaryReviewGateInput
    anti_ai: BinaryReviewGateInput
    quality: QualityReviewGateInput
  }
  overallVerdict: DeepChapterGateVerdict
  blockingGate: "consistency" | "anti_ai" | null
  overallScore: number | null
  dimensionScores: Partial<Record<SixReviewDimensionKey, number>> | null
  summary: string | null
  blockingIssues: string[]
  autoArm: {
    enabled: boolean
    armed: boolean
    target: DraftAutoArmStatus["target"]
    reason: string
    gateSnapshot: DraftAutoArmStatus["gateSnapshot"]
  }
  statusJsonUpdated: boolean
  statusJsonReason: DraftRecordReviewStatusJsonReason
  matchingDraftInStatus: boolean
  draftStatusBefore: NovelDraftStatus | null
  draftStatusAfter: NovelDraftStatus | null
  requiresHumanAccept: boolean
  workflowHint: string
}

function toGateRunStatus(value: BinaryReviewGateInput): GateRunStatus | undefined {
  if (value === "pass") return "pass"
  if (value === "fail") return "fail"
  return undefined
}

function toQualityAutoArmGateRunStatus(value: QualityReviewGateInput): GateRunStatus | undefined {
  // Watchlist #6：evaluateDraftAutoArm / DRAFT_AUTO_ARM_SCHEMA.gateSnapshot 仅允许 pass|fail|not_evaluated；
  // quality === "warning" 映射为 "pass"（P2 warning 不挡 auto-arm），同时在 decision_gates.quality 保留 verdict="warning"。
  if (value === "pass" || value === "warning") return "pass"
  if (value === "fail") return "fail"
  return undefined
}

function resolveRecordedOverallVerdict(gates: {
  consistency: BinaryReviewGateInput
  anti_ai: BinaryReviewGateInput
  quality: QualityReviewGateInput
}): { overallVerdict: DeepChapterGateVerdict; blockingGate: "consistency" | "anti_ai" | null } {
  // 硬约束：Consistency(P0) > Anti-AI(P1) > Quality(P2)；P2 永不覆盖 P0/P1 失败。
  if (gates.consistency === "fail") {
    return { overallVerdict: "fail", blockingGate: "consistency" }
  }
  if (gates.anti_ai === "fail") {
    return { overallVerdict: "fail", blockingGate: "anti_ai" }
  }
  if (gates.quality === "fail") {
    return { overallVerdict: "fail", blockingGate: null }
  }
  if (gates.consistency === "not_evaluated" || gates.anti_ai === "not_evaluated") {
    return { overallVerdict: "pending", blockingGate: null }
  }
  if (gates.quality === "warning") {
    return { overallVerdict: "warning", blockingGate: null }
  }
  if (gates.quality === "not_evaluated") {
    return { overallVerdict: "pending", blockingGate: null }
  }
  return { overallVerdict: "pass", blockingGate: null }
}

function buildGateEntryFromInput(
  existing: DeepChapterDecisionGate | undefined,
  verdictInput: QualityReviewGateInput,
  recordedAt: string,
  repairSuggestions: string[],
  mechanicalFindings: NovelReviewResult[] = [],
): DeepChapterDecisionGate {
  const base: DeepChapterDecisionGate = existing
    ? {
        ...existing,
        findings: [...existing.findings],
        repair_suggestions: [...existing.repair_suggestions],
      }
    : emptyDecisionGates().consistency

  if (verdictInput === "pass") {
    return {
      ...base,
      status: "passed",
      verdict: "pass",
      findings: [],
      repair_suggestions: [],
      updated_at: recordedAt,
      manual_review_required: undefined,
    }
  }
  if (verdictInput === "warning") {
    return {
      ...base,
      status: "passed",
      verdict: "warning",
      findings: base.findings.filter((f) => f.severity !== "error"),
      repair_suggestions: repairSuggestions.length > 0 ? repairSuggestions : [],
      updated_at: recordedAt,
      manual_review_required: undefined,
    }
  }
  if (verdictInput === "fail") {
    return {
      ...base,
      status: "failed",
      verdict: "fail",
      findings: mechanicalFindings.length > 0 ? mechanicalFindings : base.findings,
      repair_suggestions: repairSuggestions.length > 0 ? repairSuggestions : base.repair_suggestions,
      updated_at: recordedAt,
    }
  }
  return {
    ...base,
    status: "pending",
    verdict: "pending",
    updated_at: recordedAt,
  }
}

function mergeRecordedDimensionResults(
  existing: NovelSessionStatus["dimension_results"],
  scores: Partial<Record<SixReviewDimensionKey, number>>,
  summary: string | null,
): NonNullable<NovelSessionStatus["dimension_results"]> {
  const merged: NonNullable<NovelSessionStatus["dimension_results"]> = { ...(existing ?? {}) }
  for (const key of SIX_REVIEW_DIMENSION_ORDER) {
    const score = scores[key]
    if (score === undefined) continue
    const prev = merged[key]
    const entry: DimensionReviewResult = prev
      ? {
          ...prev,
          score,
          ...(summary ? { summary } : {}),
        }
      : {
          dimensionKey: key,
          score,
          status: score >= 8 ? "pass" : score >= 6 ? "medium" : "high",
          summary: summary ?? "",
          thinking: "",
          issues: [],
        }
    merged[key] = entry
  }
  return merged
}

export async function runDraftRecordReview(
  projectPath: string,
  params: Record<string, unknown> = {},
  depsOverrides?: Partial<DraftRecordReviewDeps>,
): Promise<DraftRecordReviewResult> {
  const toolName = "draft.record_review"
  assertProjectPath(projectPath, toolName)
  assertObjectParams(params, DRAFT_RECORD_REVIEW_KEYS, toolName)

  const rawDraftId = params.draftId
  if (typeof rawDraftId !== "string" || !DRAFT_ID_PATTERN.test(rawDraftId.trim())) {
    throw new Error(`${toolName} 需要合法的 draftId（1-128 位字母、数字、下划线或连字符）`)
  }
  const draftId = rawDraftId.trim()

  const rawSha = params.expectedSha256
  if (typeof rawSha !== "string" || !SHA256_HEX_PATTERN.test(rawSha.trim())) {
    throw new Error(`${toolName} 需要合法的 64 位十六进制 expectedSha256`)
  }
  const expectedSha256 = rawSha.trim()

  if (!params.gates || typeof params.gates !== "object" || Array.isArray(params.gates)) {
    throw new Error(`${toolName} 需要对象参数 gates（含 consistency / anti_ai / 可选 quality）`)
  }
  const rawGates = params.gates as Record<string, unknown>
  for (const key of Object.keys(rawGates)) {
    if (!RECORD_REVIEW_GATE_KEYS.has(key)) {
      throw new Error(`${toolName} 的 gates 包含未知键：${key}`)
    }
  }
  if (typeof rawGates.consistency !== "string" || !BINARY_GATE_INPUTS.has(rawGates.consistency)) {
    throw new Error(`${toolName} 的 gates.consistency 必须是 pass | fail | not_evaluated`)
  }
  if (typeof rawGates.anti_ai !== "string" || !BINARY_GATE_INPUTS.has(rawGates.anti_ai)) {
    throw new Error(`${toolName} 的 gates.anti_ai 必须是 pass | fail | not_evaluated`)
  }
  let qualityGate: QualityReviewGateInput = "not_evaluated"
  if (rawGates.quality !== undefined) {
    if (typeof rawGates.quality !== "string" || !QUALITY_GATE_INPUTS.has(rawGates.quality)) {
      throw new Error(`${toolName} 的 gates.quality 必须是 pass | fail | warning | not_evaluated`)
    }
    qualityGate = rawGates.quality as QualityReviewGateInput
  }

  const gates = {
    consistency: rawGates.consistency as BinaryReviewGateInput,
    anti_ai: rawGates.anti_ai as BinaryReviewGateInput,
    quality: qualityGate,
  }

  let overallScore: number | null = null
  if (params.overallScore !== undefined) {
    if (
      typeof params.overallScore !== "number"
      || !Number.isFinite(params.overallScore)
      || params.overallScore < 0
      || params.overallScore > 10
    ) {
      throw new Error(`${toolName} 的 overallScore 必须是 0..10 的有限数字`)
    }
    overallScore = params.overallScore
  }

  let dimensionScores: Partial<Record<SixReviewDimensionKey, number>> | null = null
  if (params.dimensionScores !== undefined) {
    if (
      !params.dimensionScores
      || typeof params.dimensionScores !== "object"
      || Array.isArray(params.dimensionScores)
    ) {
      throw new Error(`${toolName} 的 dimensionScores 必须是对象`)
    }
    const parsedScores: Partial<Record<SixReviewDimensionKey, number>> = {}
    for (const [key, val] of Object.entries(params.dimensionScores as Record<string, unknown>)) {
      if (!SIX_DIMENSION_SET.has(key)) {
        throw new Error(
          `${toolName} 的 dimensionScores 包含非法维度键：${key}（合法值只能来自 SIX_REVIEW_DIMENSION_ORDER：${SIX_REVIEW_DIMENSION_ORDER.join(", ")}）`,
        )
      }
      if (typeof val !== "number" || !Number.isFinite(val) || val < 0 || val > 10) {
        throw new Error(`${toolName} 的 dimensionScores.${key} 必须是 0..10 的有限数字`)
      }
      parsedScores[key as SixReviewDimensionKey] = val
    }
    dimensionScores = parsedScores
  }

  let summary: string | null = null
  if (params.summary !== undefined) {
    if (typeof params.summary !== "string") {
      throw new Error(`${toolName} 的 summary 必须是字符串`)
    }
    if (params.summary.length > 4000) {
      throw new Error(`${toolName} 的 summary 超过 4000 字符上限`)
    }
    summary = params.summary.trim() || null
  }

  let blockingIssues: string[] = []
  if (params.blockingIssues !== undefined) {
    if (!Array.isArray(params.blockingIssues) || params.blockingIssues.length > 50) {
      throw new Error(`${toolName} 的 blockingIssues 必须是长度 <= 50 的字符串数组`)
    }
    blockingIssues = params.blockingIssues.map((item, idx) => {
      if (
        typeof item !== "string"
        || !item.trim()
        || item.length > MAX_DRAFT_REVIEW_BLOCKING_ISSUE_CHARS
      ) {
        throw new Error(
          `${toolName} 的 blockingIssues[${idx}] 必须是 1..${MAX_DRAFT_REVIEW_BLOCKING_ISSUE_CHARS} 字符的非空字符串`,
        )
      }
      return item.trim()
    })
  }

  let reviewerRole = "reviewer"
  if (params.reviewerRole !== undefined) {
    if (
      typeof params.reviewerRole !== "string"
      || !params.reviewerRole.trim()
      || params.reviewerRole.length > 64
    ) {
      throw new Error(`${toolName} 的 reviewerRole 必须是 1..64 字符的非空字符串`)
    }
    reviewerRole = params.reviewerRole.trim()
  }

  let autoArmEnabled = true
  if (params.autoArmEnabled !== undefined) {
    if (typeof params.autoArmEnabled !== "boolean") {
      throw new Error(`${toolName} 的 autoArmEnabled 必须是 boolean`)
    }
    autoArmEnabled = params.autoArmEnabled
  }

  const deps: DraftRecordReviewDeps = {
    listDrafts: listChapterDrafts,
    updateSessionStatus: updateNovelSessionStatus,
    runMechanicalGate: (input) => runMechanicalGateForMcp(input),
    nowIso: () => new Date().toISOString(),
    ...depsOverrides,
  }

  const drafts = await deps.listDrafts(projectPath)
  const draft = drafts.find((d) => d.id === draftId)
  if (!draft) {
    throw new Error(`找不到草稿：${draftId}`)
  }
  if (draft.status !== "draft") {
    throw new Error(
      `DRAFT_NOT_REVIEWABLE: 草稿 ${draftId} 当前状态为 ${draft.status}，仅允许对 status="draft" 的草稿记录审阅结论`,
    )
  }

  const actualSha256 = await computeCheckpointDigest(draft.content)
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `DRAFT_SHA256_MISMATCH: 草稿 ${draftId} 正文校验和不匹配（期望 ${expectedSha256}，实际 ${actualSha256}），请重新调用 draft.read 后复核`,
    )
  }

  const recordedAt = (deps.nowIso ?? (() => new Date().toISOString()))()
  const draftChapterNumber = readDraftChapterNumber(draft.chapterName)
  const targetKey = externalDraftTargetKey(projectPath, draft.chapterName)
  const pp = projectRoot(projectPath)
  const draftPath = `${pp}/${DRAFTS_DIR}/${draft.id}.md`

  // 反自证机械门控核验：当调用方声明 consistency="pass" 或 anti_ai="pass" 时，
  // 先执行零 LLM 确定性 runMechanicalGateForMcp；若存在 P0/P1 机械 error，强制覆写为 "fail" 并追加阻断项。
  const effectiveGates = { ...gates }
  const effectiveBlockingIssues = [...blockingIssues]
  const mechanicalOverrideNotes: string[] = []
  let mechanicalP0Findings: NovelReviewResult[] = []
  let mechanicalP1Findings: NovelReviewResult[] = []

  if (effectiveGates.consistency === "pass" || effectiveGates.anti_ai === "pass") {
    const mechanicalReport = await (deps.runMechanicalGate ?? runMechanicalGateForMcp)({
      projectPath,
      text: draft.content,
      chapterNumber: draftChapterNumber,
      detailLevel: "compact",
    })
    const p0Errors = mechanicalReport.issues.filter(
      (issue) => issue.priority === "P0" && issue.severity === "error",
    )
    const p1Errors = mechanicalReport.issues.filter(
      (issue) => issue.priority === "P1" && issue.severity === "error",
    )
    const hasP0Blockers = mechanicalReport.summary.p0ErrorCount > 0 || p0Errors.length > 0
    const hasP1Blockers = mechanicalReport.summary.p1ErrorCount > 0 || p1Errors.length > 0

    if (effectiveGates.consistency === "pass" && hasP0Blockers) {
      effectiveGates.consistency = "fail"
      const p0Blockers =
        p0Errors.length > 0
          ? p0Errors.map((issue) => `[机械P0阻断] ${issue.message}`)
          : [`[机械P0阻断] 检测到 ${mechanicalReport.summary.p0ErrorCount} 项 P0 机械连续性/规则错误`]
      mechanicalP0Findings = p0Errors.map((issue) => ({
        severity: issue.severity,
        type: issue.type,
        message: issue.message,
        evidence: issue.evidence,
        relatedMemory: "",
        suggestion: issue.suggestion,
        ...(issue.continuityMeta ? { continuityMeta: issue.continuityMeta } : {}),
      }))
      for (const msg of p0Blockers) {
        if (!effectiveBlockingIssues.includes(msg)) effectiveBlockingIssues.push(msg)
      }
      mechanicalOverrideNotes.push(
        `consistency 被机械门控覆写为 fail（${mechanicalReport.summary.p0ErrorCount || p0Errors.length} 项 P0 错误）`,
      )
    }

    if (effectiveGates.anti_ai === "pass" && hasP1Blockers) {
      effectiveGates.anti_ai = "fail"
      const p1Blockers =
        p1Errors.length > 0
          ? p1Errors.map((issue) => `[机械P1阻断] ${issue.message}`)
          : [`[机械P1阻断] 检测到 ${mechanicalReport.summary.p1ErrorCount} 项 P1 机械去 AI 味阻断错误`]
      mechanicalP1Findings = p1Errors.map((issue) => ({
        severity: issue.severity,
        type: issue.type,
        message: issue.message,
        evidence: issue.evidence,
        relatedMemory: "",
        suggestion: issue.suggestion,
      }))
      for (const msg of p1Blockers) {
        if (!effectiveBlockingIssues.includes(msg)) effectiveBlockingIssues.push(msg)
      }
      mechanicalOverrideNotes.push(
        `anti_ai 被机械门控覆写为 fail（${mechanicalReport.summary.p1ErrorCount || p1Errors.length} 项 P1 错误）`,
      )
    }
  }

  const { overallVerdict, blockingGate } = resolveRecordedOverallVerdict(effectiveGates)

  // 严格通过既有 auto-arm 纯函数链：最多升 ready，绝不 accept。
  // 保持 director-modes.ts 缺省 requiredGates=["consistency","anti_ai"] 不变；
  // 当 quality === "fail" 或 overallVerdict === "fail" 时把 quality 纳入 requiredGates，确保绝不升 ready。
  const requiredGates =
    effectiveGates.quality === "fail" || overallVerdict === "fail"
      ? (["consistency", "anti_ai", "quality"] as const)
      : (["consistency", "anti_ai"] as const)

  const autoArmDecision = evaluateDraftAutoArm({
    policy: {
      enabled: autoArmEnabled,
      requiredGates,
    },
    gateStatuses: {
      consistency: toGateRunStatus(effectiveGates.consistency),
      anti_ai: toGateRunStatus(effectiveGates.anti_ai),
      quality: toQualityAutoArmGateRunStatus(effectiveGates.quality),
    },
  })
  const autoArmRecord = buildDraftAutoArmRecord(autoArmDecision, recordedAt)
  const autoArmPatch = buildDraftAutoArmPatch(autoArmRecord)
  assertAutoArmPatchNeverAccepts(autoArmPatch)

  const buildNextDecisionGates = (
    prevGates: DeepChapterDecisionGates | undefined,
  ): DeepChapterDecisionGates => ({
    consistency: buildGateEntryFromInput(
      prevGates?.consistency,
      effectiveGates.consistency,
      recordedAt,
      effectiveGates.consistency === "fail" ? effectiveBlockingIssues : [],
      mechanicalP0Findings,
    ),
    anti_ai: buildGateEntryFromInput(
      prevGates?.anti_ai,
      effectiveGates.anti_ai,
      recordedAt,
      effectiveGates.anti_ai === "fail" && effectiveGates.consistency !== "fail"
        ? effectiveBlockingIssues
        : [],
      mechanicalP1Findings,
    ),
    quality: buildGateEntryFromInput(
      prevGates?.quality,
      effectiveGates.quality,
      recordedAt,
      effectiveGates.quality === "fail" && blockingGate === null ? effectiveBlockingIssues : [],
    ),
    overall: overallVerdict,
  })

  const buildExternalStateEntry = (
    prevEntry: ExternalDraftStatusEntry | undefined,
    draftStatus: NovelDraftStatus,
    nextGates: DeepChapterDecisionGates,
    nextDims: NovelSessionStatus["dimension_results"],
  ): ExternalDraftStatusEntry => ({
    draft_id: draft.id,
    file_path: draftPath,
    chapter_name: draft.chapterName,
    ...(draftChapterNumber !== undefined ? { chapter_number: draftChapterNumber } : {}),
    target_key: targetKey,
    draft_status: draftStatus,
    decision_gates: nextGates,
    draft_auto_arm: autoArmRecord,
    ...(nextDims !== undefined ? { dimension_results: nextDims } : {}),
    ...(draft.revisionRound !== undefined ? { revision_round: draft.revisionRound } : {}),
    updated_at: recordedAt,
    ...(prevEntry?.accepted_at ? { accepted_at: prevEntry.accepted_at } : {}),
    ...(prevEntry?.formal_chapter_path ? { formal_chapter_path: prevEntry.formal_chapter_path } : {}),
  })

  const statusOutcome: {
    updated: boolean
    reason: DraftRecordReviewStatusJsonReason
    matchingDraftInStatus: boolean
    draftStatusBefore: NovelDraftStatus | null
    draftStatusAfter: NovelDraftStatus | null
  } = {
    updated: false,
    reason: "status_json_not_initialized",
    matchingDraftInStatus: false,
    draftStatusBefore: null,
    draftStatusAfter: null,
  }

  await deps.updateSessionStatus(projectPath, (existing) => {
    const conversationId = draft.sourceConversationId || "mcp:draft.record_review"
    const taskId = `tsk-${conversationId.replace(/[^a-zA-Z0-9_-]/g, "-")}`

    // 1. status.json 尚未初始化：直接在唯一真源 `.novel/status.json` 内初始化并绑定本草稿（绝不新建第二份文件）。
    if (existing === null) {
      const nextDecisionGates = buildNextDecisionGates(undefined)
      const nextDimensionResults = dimensionScores
        ? mergeRecordedDimensionResults(undefined, dimensionScores, summary)
        : undefined
      const initialBase: NovelSessionStatus = {
        schema_version: "1",
        session_id: createNovelSessionId(new Date(recordedAt)),
        source: "deep_chapter_generation",
        created_at: recordedAt,
        updated_at: recordedAt,
        status: "running",
        active_step_index: 3,
        current_task: {
          task_id: taskId,
          conversation_id: conversationId,
          user_request: `外部草稿 ${draft.chapterName}`,
          chapter_number: draftChapterNumber,
          checkpoint_stage: "after_review",
          status: "running",
        },
        draft: {
          draft_id: draft.id,
          file_path: draftPath,
          draft_status: "pending",
          checkpoint_stage: "after_review",
          updated_at: recordedAt,
        },
        decision_gates: nextDecisionGates,
        evidence_refs: [draftPath],
        ...(nextDimensionResults !== undefined ? { dimension_results: nextDimensionResults } : {}),
        external_draft_revisions: { [targetKey]: draft.revisionRound ?? 0 },
      }
      assertAutoArmPatchNeverAccepts(autoArmPatch)
      const patched = applyDraftAutoArmPatch(initialBase, autoArmPatch)
      patched.external_draft_states = {
        [draft.id]: buildExternalStateEntry(
          undefined,
          patched.draft.draft_status,
          nextDecisionGates,
          nextDimensionResults,
        ),
      }
      statusOutcome.matchingDraftInStatus = true
      statusOutcome.draftStatusBefore = null
      statusOutcome.draftStatusAfter = patched.draft.draft_status
      statusOutcome.updated = true
      statusOutcome.reason = "initialized_for_draft"
      return patched
    }

    const isMatchingPrimary = existing.draft.draft_id === draft.id

    // 2. 主槽已绑定本草稿：原位更新门控、维度分与 auto-arm（严禁覆盖 ready/accepted/rejected/superseded）。
    if (isMatchingPrimary) {
      statusOutcome.matchingDraftInStatus = true
      statusOutcome.draftStatusBefore = existing.draft.draft_status
      const nextDecisionGates = buildNextDecisionGates(existing.decision_gates)
      const nextDimensionResults = dimensionScores
        ? mergeRecordedDimensionResults(existing.dimension_results, dimensionScores, summary)
        : existing.dimension_results

      const nextBuilt = buildNextStatus(existing, {
        updated_at: recordedAt,
        status: existing.status,
        decision_gates: nextDecisionGates,
        ...(nextDimensionResults !== undefined ? { dimension_results: nextDimensionResults } : {}),
      })
      const nextBase: NovelSessionStatus = {
        ...existing,
        ...nextBuilt,
      }

      assertAutoArmPatchNeverAccepts(autoArmPatch)
      const patched = applyDraftAutoArmPatch(nextBase, autoArmPatch)
      patched.external_draft_states = {
        ...(existing.external_draft_states ?? {}),
        [draft.id]: buildExternalStateEntry(
          existing.external_draft_states?.[draft.id],
          patched.draft.draft_status,
          nextDecisionGates,
          nextDimensionResults,
        ),
      }
      statusOutcome.draftStatusAfter = patched.draft.draft_status
      statusOutcome.updated = true
      statusOutcome.reason = "updated_matching_draft"
      return patched
    }

    // 3. 主槽正被运行中 Chat `.novel/drafts/` 会话占用：严禁覆盖主槽，落入 external_draft_states[draft.id]。
    if (isActiveChatDeepChapterSession(existing)) {
      const prevEntry = existing.external_draft_states?.[draft.id]
      const prevEntryStatus: NovelDraftStatus = prevEntry?.draft_status ?? "pending"
      const nextDecisionGates = buildNextDecisionGates(prevEntry?.decision_gates)
      const nextEntryDimensions = dimensionScores
        ? mergeRecordedDimensionResults(prevEntry?.dimension_results, dimensionScores, summary)
        : prevEntry?.dimension_results

      assertAutoArmPatchNeverAccepts(autoArmPatch)
      const patchedSlot = applyDraftAutoArmPatch(
        { draft: { draft_status: prevEntryStatus } },
        autoArmPatch,
      )
      const nextEntryStatus = patchedSlot.draft.draft_status as NovelDraftStatus
      const nextExternalStates: Record<string, ExternalDraftStatusEntry> = {
        ...(existing.external_draft_states ?? {}),
        [draft.id]: buildExternalStateEntry(
          prevEntry,
          nextEntryStatus,
          nextDecisionGates,
          nextEntryDimensions,
        ),
      }
      const nextBuilt = buildNextStatus(existing, {
        updated_at: recordedAt,
        status: existing.status,
        external_draft_states: nextExternalStates,
      })
      statusOutcome.matchingDraftInStatus = false
      statusOutcome.draftStatusBefore = prevEntryStatus
      statusOutcome.draftStatusAfter = nextEntryStatus
      statusOutcome.updated = true
      statusOutcome.reason = "updated_external_draft_state"
      return {
        ...existing,
        ...nextBuilt,
      }
    }

    // 4. 主槽指向旧 `.qm-drafts/` 草稿或已采纳/已完成空闲会话：重绑主槽至本草稿并应用 auto-arm。
    const prevEntry = existing.external_draft_states?.[draft.id]
    const prevDraftStatus: NovelDraftStatus = prevEntry?.draft_status ?? "pending"
    const nextDecisionGates = buildNextDecisionGates(prevEntry?.decision_gates)
    const nextDimensionResults = dimensionScores
      ? mergeRecordedDimensionResults(prevEntry?.dimension_results, dimensionScores, summary)
      : prevEntry?.dimension_results

    const nextBuilt = buildNextStatus(existing, {
      updated_at: recordedAt,
      status: "running",
      active_step_index: 3,
      current_task: {
        task_id: taskId,
        conversation_id: conversationId,
        user_request: `外部草稿 ${draft.chapterName}`,
        chapter_number: draftChapterNumber,
        checkpoint_stage: "after_review",
        status: "running",
        last_error: undefined,
      },
      draft: {
        draft_id: draft.id,
        file_path: draftPath,
        draft_status: prevDraftStatus,
        checkpoint_stage: "after_review",
        updated_at: recordedAt,
        accepted_at: prevEntry?.accepted_at,
        rejected_at: undefined,
        formal_chapter_path: prevEntry?.formal_chapter_path,
      },
      decision_gates: nextDecisionGates,
      resume_checkpoint: undefined,
      ...(nextDimensionResults !== undefined ? { dimension_results: nextDimensionResults } : {}),
    })
    const nextBase: NovelSessionStatus = {
      ...existing,
      ...nextBuilt,
    }
    assertAutoArmPatchNeverAccepts(autoArmPatch)
    const patched = applyDraftAutoArmPatch(nextBase, autoArmPatch)
    patched.external_draft_states = {
      ...(existing.external_draft_states ?? {}),
      [draft.id]: buildExternalStateEntry(
        prevEntry,
        patched.draft.draft_status,
        nextDecisionGates,
        nextDimensionResults,
      ),
    }
    statusOutcome.matchingDraftInStatus = true
    statusOutcome.draftStatusBefore = prevDraftStatus
    statusOutcome.draftStatusAfter = patched.draft.draft_status
    statusOutcome.updated = true
    statusOutcome.reason = "rebound_external_draft"
    return patched
  })

  const baseWorkflowHint = autoArmDecision.armed
    ? `草稿 ${draft.id} 已记录门控通过（P0+P1 PASS，auto-arm 已就绪为 ready）。请通知用户在 Niko Buddy 应用内人工审阅并采纳；任何自动化路径均不会自动 accept。`
    : blockingGate
      ? `草稿 ${draft.id} 的 ${blockingGate} 门未通过（P0 > P1 > P2，P2 不可覆盖）。请调用 draft.patch 进行精准修订后重新复检。`
      : effectiveGates.quality === "fail"
        ? `草稿 ${draft.id} 的 quality 门显式未通过（overallVerdict=fail），未触发 auto-arm ready。请根据审阅建议调用 draft.patch 修订后重新复检。`
        : `草稿 ${draft.id} 审阅结论已记录（未触发 auto-arm：${autoArmRecord.reason}）。请补齐未评估门控或继续修订。`
  const overrideSuffix =
    mechanicalOverrideNotes.length > 0
      ? `（确定性机械门控已覆写：${mechanicalOverrideNotes.join("；")}）`
      : ""
  const statusSuffix =
    statusOutcome.reason === "updated_external_draft_state"
      ? "（注：应用内 Chat 深章会话正在运行，本次审阅结论已隔离落盘于 status.json 的 external_draft_states，不覆盖主槽。）"
      : ""
  const workflowHint = `${baseWorkflowHint}${overrideSuffix}${statusSuffix}`

  return {
    projectPath,
    draftId: draft.id,
    chapterName: draft.chapterName,
    chapterNumber: draftChapterNumber ?? null,
    bodySha256: actualSha256,
    recordedAt,
    reviewerRole,
    gates: effectiveGates,
    overallVerdict,
    blockingGate,
    overallScore,
    dimensionScores,
    summary,
    blockingIssues: effectiveBlockingIssues,
    autoArm: {
      enabled: autoArmEnabled,
      armed: autoArmDecision.armed,
      target: autoArmRecord.target,
      reason: autoArmRecord.reason,
      gateSnapshot: autoArmRecord.gateSnapshot,
    },
    statusJsonUpdated: statusOutcome.updated,
    statusJsonReason: statusOutcome.reason,
    matchingDraftInStatus: statusOutcome.matchingDraftInStatus,
    draftStatusBefore: statusOutcome.draftStatusBefore,
    draftStatusAfter: statusOutcome.draftStatusAfter,
    requiresHumanAccept: autoArmDecision.armed,
    workflowHint,
  }
}
