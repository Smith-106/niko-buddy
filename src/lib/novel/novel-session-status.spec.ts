import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DeepChapterDecisionGates, DeepChapterGenerationResumeCheckpoint } from "./deep-chapter-generation"
import type { DimensionReviewResult, SixReviewDimensionKey } from "./dimension-review-adapter"
import type { NovelReviewResult } from "./review-adapter"

const fsState = vi.hoisted(() => {
  const fileMap = new Map<string, string>()
  const createdDirs = new Set<string>()
  return {
    fileMap,
    createdDirs,
    createDirectory: vi.fn<typeof import("@/commands/fs").createDirectory>(async (path) => {
      createdDirs.add(path)
    }),
    readFile: vi.fn<typeof import("@/commands/fs").readFile>(async (path) => {
      const content = fileMap.get(path)
      if (content === undefined) {
        throw new Error(`ENOENT: ${path}`)
      }
      return content
    }),
    writeFileAtomic: vi.fn<typeof import("@/commands/fs").writeFileAtomic>(async (path, content) => {
      fileMap.set(path, content)
    }),
  }
})

vi.mock("@/commands/fs", () => ({
  createDirectory: fsState.createDirectory,
  readFile: fsState.readFile,
  writeFileAtomic: fsState.writeFileAtomic,
}))

import {
  acceptDeepChapterDraft,
  appendStageMetric,
  blockDeepChapterSession,
  buildNextStatus,
  completeDeepChapterSession,
  createNovelSessionId,
  loadNovelDraftArtifact,
  loadNovelSessionStatus,
  novelDraftArtifactPath,
  novelSessionStatusPath,
  pauseDeepChapterSession,
  persistCheckpointBase,
  persistDeepChapterCheckpoint,
  rejectDeepChapterDraft,
  resolveInterruptedSessionResumeCheckpoint,
  resolveStatusResumeCheckpoint,
  startDeepChapterSession,
  computeChaseDebtState,
  accrueChaseDebtInterest,
  updateChaseDebtStatus,
  createChaseDebtFromHook,
  accrueAllChaseDebtInterest,
  type NovelSessionStatus,
  type ChaseDebt,
  type ChaseDebtEvent,
  type StageMetricEntry,
} from "./novel-session-status"
import { acceptFindingRewriteDraft, rejectFindingRewriteDraft, writeFindingRewriteDraft } from "./novel-session-status"

function readJson(path: string): Record<string, unknown> {
  const raw = fsState.fileMap.get(path)
  if (!raw) {
    throw new Error(`Missing file: ${path}`)
  }
  return JSON.parse(raw) as Record<string, unknown>
}

const projectPath = "E:\\Novel"
const normalizedProjectPath = "E:/Novel"
const statusPath = novelSessionStatusPath(projectPath)
const draftPath = novelDraftArtifactPath(projectPath, "conv-1")

const reviewResults: NovelReviewResult[] = [
  {
    severity: "error",
    type: "consistency",
    message: "character knows forbidden fact",
    evidence: "paragraph 3",
    relatedMemory: "protagonist should not know the truth yet",
    suggestion: "remove the leaked fact",
  },
]

describe("novel-session-status", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsState.fileMap.clear()
    fsState.createdDirs.clear()
  })

  it("formats deterministic ids and normalized artifact paths", () => {
    expect(createNovelSessionId(new Date("2026-06-27T01:02:03.000Z"))).toBe("novel-20260627-010203")
    expect(statusPath).toBe(`${normalizedProjectPath}/.novel/status.json`)
    expect(draftPath).toBe(`${normalizedProjectPath}/.novel/drafts/conv-1.json`)
  })

  it("starts a running deep chapter session and writes status.json", async () => {
    const status = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "  generate chapter 3  ",
      chapterNumber: 3,
    })

    expect(status.session_id).toMatch(/^novel-\d{8}-\d{6}$/)
    expect(status.status).toBe("running")
    expect(status.active_step_index).toBe(1)
    expect(status.current_task.user_request).toBe("generate chapter 3")
    expect(status.current_task.chapter_number).toBe(3)
    expect(fsState.createdDirs).toEqual(new Set([
      `${normalizedProjectPath}/.novel`,
      `${normalizedProjectPath}/.novel/drafts`,
    ]))

    const saved = readJson(statusPath)
    expect(saved.status).toBe("running")
    expect(saved.active_step_index).toBe(1)
    expect((saved.current_task as Record<string, unknown>).conversation_id).toBe("conv-1")
    expect((saved.current_task as Record<string, unknown>).user_request).toBe("generate chapter 3")
    expect(fsState.fileMap.has(draftPath)).toBe(false)
    expect(fsState.writeFileAtomic).toHaveBeenCalledWith(
      statusPath,
      expect.stringContaining('"conversation_id": "conv-1"'),
    )
  })

  it("persists checkpoints into pending draft artifacts and evidence refs", async () => {
    const session = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })
    const checkpoint: DeepChapterGenerationResumeCheckpoint = {
      version: 1,
      originalRequest: "generate chapter 3",
      chapterNumber: 3,
      stage: "after_draft",
      taskBrief: "task brief",
      draftContent: "draft body",
    }

    const status = await persistDeepChapterCheckpoint({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      checkpoint,
    })

    expect(status.status).toBe("running")
    expect(status.active_step_index).toBe(2)
    expect(status.resume_checkpoint?.stage).toBe("after_draft")
    expect(status.evidence_refs).toEqual([draftPath])

    const draft = readJson(draftPath)
    expect(draft.draft_status).toBe("pending")
    expect(draft.content).toBe("draft body")
    expect(draft.review_results).toEqual([])
    expect((draft.checkpoint as Record<string, unknown>).stage).toBe("after_draft")

    const reloaded = await loadNovelSessionStatus(projectPath)
    expect(reloaded?.resume_checkpoint?.stage).toBe("after_draft")
    expect(reloaded?.draft.file_path).toBe(draftPath)
  })

  it("derives the authoritative resume stage from active_step_index before using checkpoint metadata", () => {
    const checkpoint: DeepChapterGenerationResumeCheckpoint = {
      version: 1,
      originalRequest: "generate chapter 3",
      chapterNumber: 3,
      stage: "after_draft",
      taskBrief: "task brief",
      draftContent: "draft body",
      reviewResults,
    }
    const resolved = resolveStatusResumeCheckpoint({
      schema_version: "1",
      session_id: "novel-20260628-010203",
      source: "deep_chapter_generation",
      created_at: "2026-06-28T01:02:03.000Z",
      updated_at: "2026-06-28T01:05:03.000Z",
      status: "paused",
      active_step_index: 3,
      current_task: {
        task_id: "tsk-conv-1",
        conversation_id: "conv-1",
        user_request: "generate chapter 3",
        chapter_number: 3,
        checkpoint_stage: "after_review",
        status: "paused",
      },
      draft: {
        draft_id: "conv-1",
        file_path: draftPath,
        draft_status: "pending",
        checkpoint_stage: "after_draft",
        updated_at: "2026-06-28T01:05:03.000Z",
      },
      decision_gates: {
        consistency: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
        quality: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: "pending",
      },
      resume_checkpoint: checkpoint,
      evidence_refs: [draftPath],
    }, "conv-1")

    expect(resolved?.stage).toBe("after_review")
    expect(resolved?.chapterNumber).toBe(3)
  })

  it("only auto-resumes ordinary send flow for the same running conversation and request", () => {
    const checkpoint: DeepChapterGenerationResumeCheckpoint = {
      version: 1,
      originalRequest: "generate chapter 3",
      chapterNumber: 3,
      stage: "after_draft",
      taskBrief: "task brief",
      draftContent: "draft body",
      reviewResults,
    }
    const resumableStatus: NovelSessionStatus = {
      schema_version: "1",
      session_id: "novel-20260628-010203",
      source: "deep_chapter_generation",
      created_at: "2026-06-28T01:02:03.000Z",
      updated_at: "2026-06-28T01:05:03.000Z",
      status: "running",
      active_step_index: 3,
      current_task: {
        task_id: "tsk-conv-1",
        conversation_id: "conv-1",
        user_request: "generate chapter 3",
        chapter_number: 3,
        checkpoint_stage: "after_review",
        status: "running",
      },
      draft: {
        draft_id: "conv-1",
        file_path: draftPath,
        draft_status: "pending",
        checkpoint_stage: "after_draft",
        updated_at: "2026-06-28T01:05:03.000Z",
      },
      decision_gates: {
        consistency: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
        quality: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: "pending",
      },
      resume_checkpoint: checkpoint,
      evidence_refs: [draftPath],
    }

    expect(resolveInterruptedSessionResumeCheckpoint(resumableStatus, {
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
    })?.stage).toBe("after_review")

    expect(resolveInterruptedSessionResumeCheckpoint(resumableStatus, {
      conversationId: "conv-2",
      userRequest: "generate chapter 3",
    })).toBeUndefined()

    expect(resolveInterruptedSessionResumeCheckpoint({
      ...resumableStatus,
      status: "paused",
      current_task: {
        ...resumableStatus.current_task,
        status: "paused",
      },
    }, {
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
    })).toBeUndefined()

    expect(resolveInterruptedSessionResumeCheckpoint(resumableStatus, {
      conversationId: "conv-1",
      userRequest: "generate chapter 4",
    })).toBeUndefined()
  })

  it("marks completed sessions as ready drafts with final content", async () => {
    const session = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })
    const checkpoint: DeepChapterGenerationResumeCheckpoint = {
      version: 1,
      originalRequest: "generate chapter 3",
      chapterNumber: 3,
      stage: "after_revision",
      taskBrief: "task brief",
      draftContent: "draft body",
      reviewResults,
      currentContent: "revised body",
    }

    const status = await completeDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      checkpoint,
      finalContent: "final chapter body",
      reviewResults,
      // Wave 5 (v2.5.0): 上下文用量快照 additive 落盘
      contextUsage: {
        memoryChars: 100,
        retrievalChars: 5000,
        graphChars: 2000,
        bodyChars: 50000,
        otherChars: 25000,
        maxCtx: 100000,
      },
    })

    expect(status.status).toBe("completed")
    expect(status.active_step_index).toBe(5)
    expect(status.current_task.checkpoint_stage).toBe("completed")
    expect(status.draft.draft_status).toBe("ready")

    const draft = readJson(draftPath)
    expect(draft.draft_status).toBe("ready")
    expect(draft.content).toBe("final chapter body")
    expect(draft.review_results).toEqual(reviewResults)
    // context_usage additive round-trip
    expect(draft.context_usage).toEqual({
      memoryChars: 100,
      retrievalChars: 5000,
      graphChars: 2000,
      bodyChars: 50000,
      otherChars: 25000,
      maxCtx: 100000,
    })

    const savedStatus = readJson(statusPath)
    expect(savedStatus.status).toBe("completed")
    expect((savedStatus.current_task as Record<string, unknown>).status).toBe("completed")
  })

  it("缺省 contextUsage → 草稿不落 context_usage 字段（additive 降级）", async () => {
    const session = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })
    const checkpoint: DeepChapterGenerationResumeCheckpoint = {
      version: 1,
      originalRequest: "generate chapter 3",
      chapterNumber: 3,
      stage: "after_revision",
      taskBrief: "task brief",
      draftContent: "draft body",
      reviewResults,
      currentContent: "revised body",
    }
    await completeDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      checkpoint,
      finalContent: "final chapter body",
      reviewResults,
    })
    const draft = readJson(draftPath)
    expect(draft.context_usage).toBeUndefined()
  })

  it("accepts ready drafts and records the formal chapter path", async () => {
    const session = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })
    const checkpoint: DeepChapterGenerationResumeCheckpoint = {
      version: 1,
      originalRequest: "generate chapter 3",
      chapterNumber: 3,
      stage: "after_revision",
      taskBrief: "task brief",
      draftContent: "draft body",
      reviewResults,
      currentContent: "revised body",
    }

    await completeDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      checkpoint,
      finalContent: "final chapter body",
      reviewResults,
    })

    const status = await acceptDeepChapterDraft({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      formalChapterPath: `${normalizedProjectPath}/wiki/chapters/chapter-003.md`,
    })

    expect(status.draft.draft_status).toBe("accepted")
    expect(status.draft.formal_chapter_path).toBe(`${normalizedProjectPath}/wiki/chapters/chapter-003.md`)
    expect(status.draft.accepted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const draft = readJson(draftPath)
    expect(draft.draft_status).toBe("accepted")
    expect(draft.formal_chapter_path).toBe(`${normalizedProjectPath}/wiki/chapters/chapter-003.md`)
    expect(typeof draft.accepted_at).toBe("string")
  })

  it("reuses the existing session id when accepting a ready draft without an explicit session id", async () => {
    const session = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })
    const checkpoint: DeepChapterGenerationResumeCheckpoint = {
      version: 1,
      originalRequest: "generate chapter 3",
      chapterNumber: 3,
      stage: "after_review",
      taskBrief: "task brief",
      draftContent: "draft body",
      reviewResults,
    }

    await completeDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      checkpoint,
      finalContent: "final chapter body",
      reviewResults,
    })

    const status = await acceptDeepChapterDraft({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      formalChapterPath: `${normalizedProjectPath}/wiki/chapters/chapter-003.md`,
    })

    expect(status.session_id).toBe(session.session_id)
    expect(Date.parse(status.updated_at)).toBeGreaterThanOrEqual(Date.parse(status.created_at))

    const savedStatus = readJson(statusPath)
    expect(savedStatus.session_id).toBe(session.session_id)
  })

  it("rejects ready drafts without creating a formal chapter path", async () => {
    const session = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })
    const checkpoint: DeepChapterGenerationResumeCheckpoint = {
      version: 1,
      originalRequest: "generate chapter 3",
      chapterNumber: 3,
      stage: "after_review",
      taskBrief: "task brief",
      draftContent: "draft body",
      reviewResults,
    }

    await completeDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      checkpoint,
      finalContent: "final chapter body",
      reviewResults,
    })

    const status = await rejectDeepChapterDraft({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
    })

    expect(status.draft.draft_status).toBe("rejected")
    expect(status.draft.formal_chapter_path).toBeUndefined()
    expect(status.draft.rejected_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const draft = readJson(draftPath)
    expect(draft.draft_status).toBe("rejected")
    expect(draft.formal_chapter_path).toBeUndefined()
    expect(typeof draft.rejected_at).toBe("string")
  })

  it("persists dimension_results through complete/accept/reject (DC-2 twin-safe regression)", async () => {
    // DC-2 (odyssey-improve): accept/reject previously omitted dimension_results
    // entirely — on a fresh base (createBaseStatus never sets it) the 6-dim
    // review map was dropped. This test guards the resolveDimensionResults
    // helper so the F-003 twin-path defect cannot recur (4th recurrence fixed).
    const session = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-dim",
      userRequest: "generate chapter 4",
      chapterNumber: 4,
    })
    const dimensionResults: Partial<Record<SixReviewDimensionKey, DimensionReviewResult>> = {
      consistency: {
        dimensionKey: "consistency",
        score: 9.2,
        status: "pass",
        summary: "no consistency issues",
        thinking: "",
        issues: [],
      },
      thrill: {
        dimensionKey: "thrill",
        score: 7.0,
        status: "medium",
        summary: "could be more thrilling",
        thinking: "",
        issues: [],
      },
    }
    const checkpoint: DeepChapterGenerationResumeCheckpoint = {
      version: 1,
      originalRequest: "generate chapter 4",
      chapterNumber: 4,
      stage: "after_revision",
      taskBrief: "task brief",
      draftContent: "draft body",
      reviewResults,
      currentContent: "revised body",
      dimensionResults,
    }

    await completeDeepChapterSession({
      projectPath,
      conversationId: "conv-dim",
      userRequest: "generate chapter 4",
      chapterNumber: 4,
      sessionId: session.session_id,
      checkpoint,
      finalContent: "final chapter body",
      reviewResults,
    })

    // complete: dimension_results persisted to status.json
    const statusAfterComplete = readJson(statusPath)
    expect(statusAfterComplete.dimension_results).toEqual(dimensionResults)

    // accept: dimension_results survives the accept transition (was dropped
    // before DC-2 fix because accept omitted the field and base was fresh).
    await acceptDeepChapterDraft({
      projectPath,
      conversationId: "conv-dim",
      userRequest: "generate chapter 4",
      chapterNumber: 4,
      sessionId: session.session_id,
      formalChapterPath: `${normalizedProjectPath}/wiki/chapters/chapter-004.md`,
    })
    const statusAfterAccept = readJson(statusPath)
    expect(statusAfterAccept.dimension_results).toEqual(dimensionResults)
  })

  it("persists dimension_results through reject on a fresh base (DC-2)", async () => {
    // Companion to the accept test above: reject was the other twin that
    // omitted dimension_results. Verify the 6-dim map survives reject even
    // when the base has no prior dimension_results (fresh createBaseStatus).
    const session = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-rej-dim",
      userRequest: "generate chapter 5",
      chapterNumber: 5,
    })
    const dimensionResults: Partial<Record<SixReviewDimensionKey, DimensionReviewResult>> = {
      pacing: {
        dimensionKey: "pacing",
        score: 65,
        status: "medium",
        summary: "pacing drags in act 2",
        thinking: "",
        issues: [],
      },
    }
    const checkpoint: DeepChapterGenerationResumeCheckpoint = {
      version: 1,
      originalRequest: "generate chapter 5",
      chapterNumber: 5,
      stage: "after_revision",
      taskBrief: "task brief",
      draftContent: "draft body",
      reviewResults,
      currentContent: "revised body",
      dimensionResults,
    }

    await completeDeepChapterSession({
      projectPath,
      conversationId: "conv-rej-dim",
      userRequest: "generate chapter 5",
      chapterNumber: 5,
      sessionId: session.session_id,
      checkpoint,
      finalContent: "final chapter body",
      reviewResults,
    })

    await rejectDeepChapterDraft({
      projectPath,
      conversationId: "conv-rej-dim",
      userRequest: "generate chapter 5",
      chapterNumber: 5,
      sessionId: session.session_id,
    })
    const statusAfterReject = readJson(statusPath)
    expect(statusAfterReject.dimension_results).toEqual(dimensionResults)
  })

  it("refuses accept/reject when no managed deep chapter draft exists for the conversation", async () => {
    await expect(acceptDeepChapterDraft({
      projectPath,
      conversationId: "conv-missing",
      userRequest: "generate chapter 9",
      chapterNumber: 9,
      formalChapterPath: `${normalizedProjectPath}/wiki/chapters/chapter-009.md`,
    })).rejects.toThrow("No managed deep chapter draft found for this conversation.")

    await expect(rejectDeepChapterDraft({
      projectPath,
      conversationId: "conv-missing",
      userRequest: "generate chapter 9",
      chapterNumber: 9,
    })).rejects.toThrow("No managed deep chapter draft found for this conversation.")
  })

  it("pauses failed sessions and preserves the latest checkpoint plus error", async () => {
    const session = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })
    const checkpoint: DeepChapterGenerationResumeCheckpoint = {
      version: 1,
      originalRequest: "generate chapter 3",
      chapterNumber: 3,
      stage: "after_review",
      taskBrief: "task brief",
      draftContent: "draft body",
      reviewResults,
    }

    const status = await pauseDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      checkpoint,
      errorMessage: "network timeout",
    })

    expect(status.status).toBe("paused")
    expect(status.current_task.status).toBe("paused")
    expect(status.current_task.last_error).toBe("network timeout")
    expect(status.resume_checkpoint?.stage).toBe("after_review")
    expect(status.evidence_refs).toEqual([draftPath])

    const draft = readJson(draftPath)
    expect(draft.draft_status).toBe("pending")
    expect(draft.content).toBe("draft body")
    expect(draft.review_results).toEqual(reviewResults)

    const savedStatus = readJson(statusPath)
    expect(savedStatus.status).toBe("paused")
    expect((savedStatus.current_task as Record<string, unknown>).last_error).toBe("network timeout")
  })

  it("blocks manual-review sessions and keeps gate evidence in status plus draft", async () => {
    const session = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })
    const checkpoint: DeepChapterGenerationResumeCheckpoint = {
      version: 1,
      originalRequest: "generate chapter 3",
      chapterNumber: 3,
      stage: "after_revision",
      taskBrief: "task brief",
      draftContent: "draft body",
      reviewResults,
      currentContent: "revised body",
      retryCount: 3,
      manualReviewRequired: true,
      decisionGates: {
        consistency: {
          status: "failed",
          verdict: "manual_review",
          findings: reviewResults,
          repair_suggestions: ["remove the leaked fact"],
          retry_count: 3,
          manual_review_required: true,
        },
        anti_ai: {
          status: "passed",
          verdict: "pass",
          findings: [],
          repair_suggestions: [],
          retry_count: 3,
        },
        quality: {
          status: "passed",
          verdict: "pass",
          findings: [],
          repair_suggestions: [],
          retry_count: 3,
        },
        overall: "manual_review",
      },
    }

    const status = await blockDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      checkpoint,
      errorMessage: "MANUAL_REVIEW_REQUIRED: retry_count=3",
    })

    expect(status.status).toBe("blocked")
    expect(status.active_step_index).toBeNull()
    expect(status.current_task.status).toBe("blocked")
    expect(status.decision_gates.consistency.manual_review_required).toBe(true)
    expect(status.decision_gates.overall).toBe("manual_review")

    const draft = readJson(draftPath)
    const savedDraftGates = draft.decision_gates as Record<string, unknown>
    expect(savedDraftGates).toBeTruthy()
    expect((savedDraftGates.consistency as Record<string, unknown>).manual_review_required).toBe(true)

    const savedStatus = readJson(statusPath)
    const savedStatusGates = savedStatus.decision_gates as Record<string, unknown>
    expect(savedStatus.status).toBe("blocked")
    expect((savedStatusGates.consistency as Record<string, unknown>).retry_count).toBe(3)
  })

  it("archives previous drafts as superseded when a new session reuses the same conversation id", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-28T01:02:03.000Z"))
    const firstSession = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })
    await completeDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: firstSession.session_id,
      finalContent: "first draft body",
      reviewResults: [],
    })

    vi.setSystemTime(new Date("2026-06-28T01:02:05.000Z"))
    const secondSession = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "regenerate chapter 3",
      chapterNumber: 3,
    })
    await completeDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "regenerate chapter 3",
      chapterNumber: 3,
      sessionId: secondSession.session_id,
      finalContent: "second draft body",
      reviewResults: [],
    })

    const supersededEntries = [...fsState.fileMap.entries()].filter(([path]) =>
      path.includes("/.novel/drafts/conv-1.superseded."),
    )
    expect(supersededEntries).toHaveLength(1)
    const superseded = JSON.parse(supersededEntries[0][1]) as Record<string, unknown>
    expect(superseded.draft_status).toBe("superseded")
    expect(superseded.superseded_by).toBe(draftPath)

    const currentDraft = readJson(draftPath)
    expect(currentDraft.draft_status).toBe("ready")
    expect(currentDraft.content).toBe("second draft body")
    vi.useRealTimers()
  })

  it("fails fast when status.json cannot be read back after writing", async () => {
    const originalReadFile = fsState.readFile.getMockImplementation()
    fsState.readFile.mockImplementation(async (path: string) => {
      if (path === statusPath) {
        throw new Error(`EACCES: ${path}`)
      }
      if (!originalReadFile) {
        throw new Error(`ENOENT: ${path}`)
      }
      return originalReadFile(path)
    })

    await expect(startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })).rejects.toThrow(`小说会话状态文件 写入后回读失败（${statusPath}）：EACCES: ${statusPath}`)
  })
})

describe("novel-session-status 分支补足", () => {
  beforeEach(() => {
    fsState.fileMap.clear()
    fsState.createdDirs.clear()
    fsState.readFile.mockImplementation(async (path: string) => {
      const content = fsState.fileMap.get(path)
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return content
    })
    fsState.writeFileAtomic.mockImplementation(async (path: string, content: string) => {
      fsState.fileMap.set(path, content)
    })
  })

  it("writeVerifiedJson: 回读不是有效 JSON → 抛错", async () => {
    fsState.writeFileAtomic.mockImplementationOnce(async (path: string) => {
      fsState.fileMap.set(path, "{not-json")
    })
    await expect(startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })).rejects.toThrow(`小说会话状态文件 写入后回读不是有效 JSON（${statusPath}）`)
  })

  it("writeVerifiedJson: 回读校验失败 → 抛错", async () => {
    fsState.writeFileAtomic.mockImplementationOnce(async (path: string, _content: string) => {
      fsState.fileMap.set(path, JSON.stringify({ session_id: "other-session", current_task: {}, status: "x", draft: {} }))
    })
    await expect(startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })).rejects.toThrow(`小说会话状态文件 写入回读校验失败（${statusPath}）`)
  })

  it("stageToActiveStepIndex 覆盖 after_context / after_task_brief / after_revision / 未知值", async () => {
    const session = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })
    // after_context → 1
    const s1 = await persistDeepChapterCheckpoint({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      checkpoint: {
        version: 1, originalRequest: "r", chapterNumber: 3, stage: "after_context",
      },
    })
    expect(s1.active_step_index).toBe(1)
    // after_task_brief → 1
    const s2 = await persistDeepChapterCheckpoint({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      checkpoint: {
        version: 1, originalRequest: "r", chapterNumber: 3, stage: "after_task_brief",
      },
    })
    expect(s2.active_step_index).toBe(1)
    // after_revision → 4
    const s3 = await persistDeepChapterCheckpoint({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      checkpoint: {
        version: 1, originalRequest: "r", chapterNumber: 3, stage: "after_revision",
      },
    })
    expect(s3.active_step_index).toBe(4)
    // 未知 stage → default 0
    const s4 = await persistDeepChapterCheckpoint({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      checkpoint: {
        version: 1, originalRequest: "r", chapterNumber: 3, stage: "after_scene_breakdown",
      },
    })
    expect(s4.active_step_index).toBe(0)
  })

  it("cloneDecisionGates: 无 verdict 时按 status 推导 fail/pass; 保留 updated_at; overall 推导全部分支", () => {
    const base: NovelSessionStatus = {
      schema_version: "1",
      session_id: "s",
      source: "deep_chapter_generation",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "running",
      active_step_index: 1,
      current_task: { task_id: "t", conversation_id: "c", user_request: "r", checkpoint_stage: "started", status: "running" },
      draft: { draft_id: "d", file_path: "p", draft_status: "pending", updated_at: "2026-01-01T00:00:00.000Z" },
      decision_gates: {
        consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        quality: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: "pass",
      },
      evidence_refs: [],
    }
    // status failed 无 verdict → verdict 推导 fail; updated_at 保留
    const failed = buildNextStatus(base, {
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "running",
      decision_gates: {
        consistency: { status: "failed", verdict: "fail", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0, updated_at: "2026-01-02T00:00:00.000Z" },
        quality: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: "fail",
      },
    })
    expect(failed.decision_gates.consistency.verdict).toBe("fail")
    expect(failed.decision_gates.anti_ai.updated_at).toBe("2026-01-02T00:00:00.000Z")
    expect(failed.decision_gates.overall).toBe("fail")

    // 任一 failed → overall fail
    const failDerived = buildNextStatus(base, {
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "running",
      decision_gates: {
        consistency: { status: "failed", verdict: "fail", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        quality: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: "fail",
      },
    })
    expect(failDerived.decision_gates.overall).toBe("fail")
    // anti_ai failed → fail
    const antiFail = buildNextStatus(base, {
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "running",
      decision_gates: {
        consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "failed", verdict: "fail", findings: [], repair_suggestions: [], retry_count: 0 },
        quality: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: "fail",
      },
    })
    expect(antiFail.decision_gates.overall).toBe("fail")
    // quality verdict warning → warning
    const warn = buildNextStatus(base, {
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "running",
      decision_gates: {
        consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        quality: { status: "passed", verdict: "warning", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: "warning",
      },
    })
    expect(warn.decision_gates.overall).toBe("warning")
    // 全 passed → pass
    const pass = buildNextStatus(base, {
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "running",
      decision_gates: {
        consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        quality: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: "pass",
      },
    })
    expect(pass.decision_gates.overall).toBe("pass")
    // consistency passed + anti_ai pending → pending
    const pendAnti = buildNextStatus(base, {
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "running",
      decision_gates: {
        consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
        quality: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: "pending",
      },
    })
    expect(pendAnti.decision_gates.overall).toBe("pending")
    // consistency+anti_ai passed + quality pending → pending
    const pendQ = buildNextStatus(base, {
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "running",
      decision_gates: {
        consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        quality: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: "pending",
      },
    })
    expect(pendQ.decision_gates.overall).toBe("pending")
  })

  it("cloneDecisionGates: 无 overall 时推导 fail/warning/pending 全部分支", () => {
    const base: NovelSessionStatus = {
      schema_version: "1",
      session_id: "s",
      source: "deep_chapter_generation",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "running",
      active_step_index: 1,
      current_task: { task_id: "t", conversation_id: "c", user_request: "r", checkpoint_stage: "started", status: "running" },
      draft: { draft_id: "d", file_path: "p", draft_status: "pending", updated_at: "2026-01-01T00:00:00.000Z" },
      decision_gates: {
        consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        quality: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: "pass",
      },
      evidence_refs: [],
    }
    const gates = (overrides: Record<string, unknown> = {}): DeepChapterDecisionGates => ({
      consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
      anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
      quality: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
      ...overrides,
    } as unknown as DeepChapterDecisionGates)
    // quality failed → fail（无 overall 输入）
    const qFail = buildNextStatus(base, {
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "running",
      decision_gates: gates({ quality: { status: "failed", verdict: "fail", findings: [], repair_suggestions: [], retry_count: 0 } }),
    })
    expect(qFail.decision_gates.overall).toBe("fail")
    // quality verdict warning → warning
    const qWarn = buildNextStatus(base, {
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "running",
      decision_gates: gates({ quality: { status: "passed", verdict: "warning", findings: [], repair_suggestions: [], retry_count: 0 } }),
    })
    expect(qWarn.decision_gates.overall).toBe("warning")
    // consistency pending → pending
    const cPend = buildNextStatus(base, {
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "running",
      decision_gates: gates({ consistency: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 } }),
    })
    expect(cPend.decision_gates.overall).toBe("pending")
    // anti_ai pending → pending
    const aPend = buildNextStatus(base, {
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "running",
      decision_gates: gates({ anti_ai: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 } }),
    })
    expect(aPend.decision_gates.overall).toBe("pending")
    // quality pending → pending
    const qPend = buildNextStatus(base, {
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "running",
      decision_gates: gates({ quality: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 } }),
    })
    expect(qPend.decision_gates.overall).toBe("pending")
    // 全 passed 且无 overall → pass
    const allPass = buildNextStatus(base, {
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "running",
      decision_gates: gates(),
    })
    expect(allPass.decision_gates.overall).toBe("pass")
    // 无 verdict 时按 status 推导：failed → fail / passed → pass / 缺省 → pending
    const noVerdict = buildNextStatus(base, {
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "running",
      decision_gates: gates({
        consistency: { status: "failed", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "passed", findings: [], repair_suggestions: [], retry_count: 0 },
        quality: { findings: [], repair_suggestions: [], retry_count: 0 },
      }),
    })
    expect(noVerdict.decision_gates.consistency.verdict).toBe("fail")
    expect(noVerdict.decision_gates.anti_ai.verdict).toBe("pass")
    expect(noVerdict.decision_gates.quality.verdict).toBe("pending")
  })

  it("Wave 4: de_ai_batch additive 字段经 buildNextStatus 线穿（ADR-31）", () => {
    const base: NovelSessionStatus = {
      schema_version: "1" as const,
      session_id: "s",
      source: "deep_chapter_generation" as const,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "completed" as const,
      active_step_index: null,
      current_task: { task_id: "t", conversation_id: "c", user_request: "r", checkpoint_stage: "started", status: "running" },
      draft: { draft_id: "d", file_path: "p", draft_status: "pending", updated_at: "2026-01-01T00:00:00.000Z" },
      decision_gates: {
        consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        quality: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: "pass",
      },
      evidence_refs: [],
    }
    const batch = {
      schemaVersion: "de-ai-batch/1.0" as const,
      batchId: "de-ai-1",
      phase: "running" as const,
      concurrency: 3,
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      queue: [1, 2],
      perChapter: { 1: { status: "ready" as const, attempts: 1 } },
    }
    // 传入 → 线穿
    const withBatch = buildNextStatus(base, {
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "completed",
      de_ai_batch: batch,
    })
    expect(withBatch.de_ai_batch).toEqual(batch)
    // 省略 → 继承 base
    const inherited = buildNextStatus({ ...base, de_ai_batch: batch }, {
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "completed",
    })
    expect(inherited.de_ai_batch).toEqual(batch)
    // 显式 undefined → 清除
    const cleared = buildNextStatus({ ...base, de_ai_batch: batch }, {
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "completed",
      de_ai_batch: undefined,
    })
    expect(cleared.de_ai_batch).toBeUndefined()
  })

  it("extractDraftContent 全空 → draft 内容为空串; 无 draft 时保留现有草稿路径 (pause/block 无 checkpoint)", async () => {
    const session = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })
    // checkpoint 无 content 字段 + 无 finalContent → content ""
    const paused = await pauseDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      checkpoint: { version: 1, originalRequest: "r", stage: "after_context" },
      errorMessage: "err",
    })
    const draft = readJson(draftPath)
    expect(draft.content).toBe("")
    expect(paused.active_step_index).toBe(1)

    // pause 无 checkpoint → 保留 base.draft.file_path
    const paused2 = await pauseDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      errorMessage: "err2",
    })
    expect(paused2.draft.file_path).toBe(draftPath)
    expect(paused2.active_step_index).toBe(session.active_step_index)
    expect(paused2.draft.draft_status).toBe(session.draft.draft_status)

    // block 无 checkpoint → 保留现有路径, active_step_index null
    const blocked = await blockDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      errorMessage: "blocked",
    })
    expect(blocked.draft.file_path).toBe(draftPath)
    expect(blocked.active_step_index).toBeNull()
  })

  it("resolveStatusResumeCheckpoint 各守卫: null/会话不匹配/completed/无 checkpoint/无 stage/chapterNumber 回退", () => {
    const checkpoint: DeepChapterGenerationResumeCheckpoint = {
      version: 1, originalRequest: "generate chapter 3", stage: "after_draft", draftContent: "draft",
    }
    const mkStatus = (over: Partial<NovelSessionStatus>): NovelSessionStatus => ({
      schema_version: "1",
      session_id: "novel-1",
      source: "deep_chapter_generation",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "paused",
      active_step_index: 2,
      current_task: { task_id: "t", conversation_id: "conv-1", user_request: "r", chapter_number: 9, checkpoint_stage: "started", status: "paused" },
      draft: { draft_id: "d", file_path: "p", draft_status: "pending", updated_at: "2026-01-01T00:00:00.000Z" },
      decision_gates: {
        consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        quality: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: "pass",
      },
      resume_checkpoint: checkpoint,
      evidence_refs: [],
      ...over,
    })

    expect(resolveStatusResumeCheckpoint(null, "conv-1")).toBeUndefined()
    expect(resolveStatusResumeCheckpoint(mkStatus({}), "conv-other")).toBeUndefined()
    expect(resolveStatusResumeCheckpoint(mkStatus({ status: "completed" }), "conv-1")).toBeUndefined()
    expect(resolveStatusResumeCheckpoint(mkStatus({ resume_checkpoint: undefined }), "conv-1")).toBeUndefined()
    // active_step_index 缺失/超界 → 无 stage
    expect(resolveStatusResumeCheckpoint(mkStatus({ active_step_index: null }), "conv-1")).toBeUndefined()
    expect(resolveStatusResumeCheckpoint(mkStatus({ active_step_index: 5 }), "conv-1")).toBeUndefined()
    // checkpoint.stage 匹配 activeStepIndex
    const cp = resolveStatusResumeCheckpoint(mkStatus({}), "conv-1")
    expect(cp?.stage).toBe("after_draft")
    expect(cp?.chapterNumber).toBe(9) // checkpoint 无 chapterNumber → 用 current_task.chapter_number
    // checkpointStage 提供且匹配 active_step_index → 优先（active 3 ↔ after_review）
    const cp2 = resolveStatusResumeCheckpoint(
      mkStatus({ active_step_index: 3, current_task: { task_id: "t", conversation_id: "conv-1", user_request: "r", checkpoint_stage: "after_review", status: "paused" } }),
      "conv-1",
    )
    expect(cp2?.stage).toBe("after_review")
    // switch: active 1 无 taskBrief → after_context; 有 taskBrief → after_task_brief
    const cp3 = resolveStatusResumeCheckpoint(
      mkStatus({ active_step_index: 1, resume_checkpoint: { version: 1, originalRequest: "r", stage: "after_draft" } }),
      "conv-1",
    )
    expect(cp3?.stage).toBe("after_context")
    const cp4 = resolveStatusResumeCheckpoint(
      mkStatus({ active_step_index: 1, resume_checkpoint: { version: 1, originalRequest: "r", stage: "after_draft", taskBrief: "brief" } }),
      "conv-1",
    )
    expect(cp4?.stage).toBe("after_task_brief")
    // active 2/3/4 → after_draft/after_review/after_revision
    expect(resolveStatusResumeCheckpoint(mkStatus({ active_step_index: 2 }), "conv-1")?.stage).toBe("after_draft")
    expect(resolveStatusResumeCheckpoint(mkStatus({ active_step_index: 3 }), "conv-1")?.stage).toBe("after_review")
    expect(resolveStatusResumeCheckpoint(mkStatus({ active_step_index: 4 }), "conv-1")?.stage).toBe("after_revision")
    // active 0 → default undefined
    expect(resolveStatusResumeCheckpoint(mkStatus({ active_step_index: 0 }), "conv-1")).toBeUndefined()
  })

  it("startDeepChapterSession 复用同会话 (相同 conversation + user_request)", async () => {
    const first = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })
    const second = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "  generate chapter 3  ",
      chapterNumber: 3,
    })
    expect(second.session_id).toBe(first.session_id)
    expect(second.created_at).toBe(first.created_at)
  })

  it("startDeepChapterSession 带 resumeCheckpoint → 写 draft 工件 + 克隆 gates + evidence_refs", async () => {
    const status = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      resumeCheckpoint: {
        version: 1,
        originalRequest: "generate chapter 3",
        chapterNumber: 3,
        stage: "after_draft",
        draftContent: "draft body",
        reviewResults,
        decisionGates: {
          consistency: { status: "failed", verdict: "fail", findings: [], repair_suggestions: [], retry_count: 0 },
          anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
          quality: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
          overall: "fail",
        },
      },
    })
    expect(status.draft.file_path).toBe(draftPath)
    expect(status.evidence_refs).toEqual([draftPath])
    expect(status.decision_gates.consistency.status).toBe("failed")
    expect(readJson(draftPath).draft_status).toBe("pending")

    // reviewResults 缺省 → []
    const status2 = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-2",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      resumeCheckpoint: {
        version: 1, originalRequest: "r", stage: "after_context", draftContent: "d",
      },
    })
    expect(readJson(novelDraftArtifactPath(projectPath, "conv-2")).review_results).toEqual([])
    expect(status2.active_step_index).toBe(1)
  })

  it("persist/complete/pause/block 无既有会话 → createBaseStatus 兜底", async () => {
    fsState.fileMap.delete(statusPath)
    const cp: DeepChapterGenerationResumeCheckpoint = {
      version: 1, originalRequest: "r", chapterNumber: 3, stage: "after_draft", draftContent: "d",
    }
    const persisted = await persistDeepChapterCheckpoint({
      projectPath,
      conversationId: "conv-x",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: "sess-x",
      checkpoint: cp,
    })
    expect(persisted.session_id).toBe("sess-x")

    fsState.fileMap.delete(statusPath)
    const completed = await completeDeepChapterSession({
      projectPath,
      conversationId: "conv-y",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: "sess-y",
      finalContent: "final",
    })
    expect(completed.status).toBe("completed")
    expect(completed.draft.draft_status).toBe("ready")

    fsState.fileMap.delete(statusPath)
    const paused = await pauseDeepChapterSession({
      projectPath,
      conversationId: "conv-z",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: "sess-z",
      errorMessage: "e",
    })
    expect(paused.status).toBe("paused")

    fsState.fileMap.delete(statusPath)
    const blocked = await blockDeepChapterSession({
      projectPath,
      conversationId: "conv-w",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: "sess-w",
      errorMessage: "e",
    })
    expect(blocked.status).toBe("blocked")
  })

  it("persist/complete/pause 带 checkpoint 缺 chapterNumber → 回退 input.chapterNumber; 缺 reviewResults → []", async () => {
    const session = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })
    const cp = { version: 1, originalRequest: "r", stage: "after_draft", draftContent: "d" } as DeepChapterGenerationResumeCheckpoint
    const persisted = await persistDeepChapterCheckpoint({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      checkpoint: cp,
    })
    expect(persisted.current_task.chapter_number).toBe(3)

    const completed = await completeDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      checkpoint: cp,
      finalContent: "final",
    })
    expect(completed.current_task.chapter_number).toBe(3)

    const paused = await pauseDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      checkpoint: cp,
      errorMessage: "e",
    })
    expect(paused.current_task.chapter_number).toBe(3)
  })

  it("loadNovelDraftArtifact 非法 draft 工件 → null; loadNovelSessionStatus 非法 status.json → null", async () => {
    fsState.fileMap.set(draftPath, JSON.stringify({ draft_id: 123 }))
    await expect(loadNovelDraftArtifact(projectPath, "conv-1")).resolves.toBeNull()

    fsState.fileMap.set(statusPath, JSON.stringify({ schema_version: "2", session_id: 1 }))
    await expect(loadNovelSessionStatus(projectPath)).resolves.toBeNull()
  })

  it("requireManagedDeepChapterDraft: accept 只接受 ready; pending 不合法", async () => {
    const session = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      resumeCheckpoint: {
        version: 1, originalRequest: "r", chapterNumber: 3, stage: "after_draft", draftContent: "d",
      },
    })
    // draft_status = pending → accept 抛 "not eligible"
    await expect(acceptDeepChapterDraft({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      formalChapterPath: `${normalizedProjectPath}/wiki/chapters/chapter-003.md`,
    })).rejects.toThrow("Deep chapter draft is not eligible for accept in status pending.")
  })

  it("accept 无 formalChapterPath; 无既有 status → createBaseStatus; session 不匹配 → createBaseStatus", async () => {
    const session = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })
    await completeDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      finalContent: "final chapter body",
      reviewResults,
    })

    // 无 formalChapterPath
    const status = await acceptDeepChapterDraft({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
    })
    expect(status.draft.formal_chapter_path).toBeUndefined()
    expect(status.evidence_refs).toEqual([draftPath])

    // 重置草稿为 ready（accept 后草稿已是 accepted，先恢复才能再走决策）
    fsState.fileMap.set(draftPath, JSON.stringify({
      draft_id: "conv-1",
      conversation_id: "conv-1",
      user_request: "generate chapter 3",
      session_id: session.session_id,
      chapter_number: 3,
      draft_status: "ready",
      content: "final chapter body",
      review_results: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    }))

    // session 不匹配 → createBaseStatus 兜底 (新 session_id)
    const mismatch = await acceptDeepChapterDraft({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: "totally-different-session",
      formalChapterPath: `${normalizedProjectPath}/wiki/chapters/chapter-003.md`,
    })
    expect(mismatch.session_id).toBe("totally-different-session")
    expect(mismatch.draft.draft_status).toBe("accepted")
  })

  it("accept/reject 时 draft 无 checkpoint → 回退 base.resume_checkpoint / input.resumeCheckpoint", async () => {
    // 直接构造: 手工写入 draft artifact + status.json, 让 checkpoint 链路走回退分支
    const session = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })
    // complete 无 checkpoint → artifact.checkpoint = undefined
    await completeDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      finalContent: "final",
    })
    const artifact = JSON.parse(fsState.fileMap.get(draftPath)!) as Record<string, unknown>
    expect(artifact.checkpoint).toBeUndefined()
    // status.json 带 resume_checkpoint
    const saved = JSON.parse(fsState.fileMap.get(statusPath)!) as Record<string, unknown>
    saved.resume_checkpoint = {
      version: 1, originalRequest: "r", chapterNumber: 3, stage: "after_review", reviewResults,
    }
    fsState.fileMap.set(statusPath, JSON.stringify(saved))

    const status = await acceptDeepChapterDraft({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      formalChapterPath: `${normalizedProjectPath}/wiki/chapters/chapter-003.md`,
      resumeCheckpoint: {
        version: 1, originalRequest: "r", chapterNumber: 3, stage: "after_review", reviewResults,
      },
    })
    expect(status.resume_checkpoint?.stage).toBe("after_review")
    expect(status.draft.draft_status).toBe("accepted")
  })

  it("appendStageMetric: 无既有状态 → no-op; 有 → 追加; stage_metrics 非数组 → [] 起点; 上限 1024 shift", async () => {
    // 无既有 status.json
    fsState.fileMap.delete(statusPath)
    await expect(appendStageMetric(projectPath, { stage: "scene_breakdown", tokenCost: 10 })).resolves.toBeUndefined()
    expect(fsState.fileMap.has(statusPath)).toBe(false)

    // 有既有状态 (无 stage_metrics)
    const session = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })
    await appendStageMetric(projectPath, { stage: "scene_breakdown", tokenCost: 10, partial: true })
    let saved = JSON.parse(fsState.fileMap.get(statusPath)!) as { stage_metrics?: StageMetricEntry[] }
    expect(saved.stage_metrics).toHaveLength(1)
    expect(saved.stage_metrics![0]!.stage).toBe("scene_breakdown")

    // stage_metrics 非数组 (旧文件) → [] 起点
    const cur = JSON.parse(fsState.fileMap.get(statusPath)!) as Record<string, unknown>
    cur.stage_metrics = "corrupted"
    fsState.fileMap.set(statusPath, JSON.stringify(cur))
    await appendStageMetric(projectPath, { stage: "write_llm", latencyMs: 5 })
    saved = JSON.parse(fsState.fileMap.get(statusPath)!) as { stage_metrics?: StageMetricEntry[] }
    expect(saved.stage_metrics).toEqual([{ stage: "write_llm", latencyMs: 5 }])

    // 上限 1024: 预填 1024 条再追加 → shift 到 1024
    const big = JSON.parse(fsState.fileMap.get(statusPath)!) as { stage_metrics?: StageMetricEntry[] }
    big.stage_metrics = Array.from({ length: 1024 }, (_, i) => ({ stage: "write_llm" as const, latencyMs: i }))
    fsState.fileMap.set(statusPath, JSON.stringify(big))
    await appendStageMetric(projectPath, { stage: "pack", chapterId: "c1" })
    saved = JSON.parse(fsState.fileMap.get(statusPath)!) as { stage_metrics?: StageMetricEntry[] }
    expect(saved.stage_metrics).toHaveLength(1024)
    expect(saved.stage_metrics![1023]!.stage).toBe("pack")
    expect(saved.stage_metrics![0]!.latencyMs).toBe(1)
    expect(session.session_id).toMatch(/^novel-/)
  })

  it("persistCheckpointBase: evidenceEntries 合并 + sessionId 不匹配抛错", async () => {
    const session = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })
    const next = buildNextStatus(session, {
      updated_at: "2026-01-02T00:00:00.000Z",
      status: "paused",
      evidence_refs: undefined,
    })
    await persistCheckpointBase(projectPath, session.session_id, next, ["extra-evidence"])
    const saved = JSON.parse(fsState.fileMap.get(statusPath)!) as { evidence_refs: string[] }
    expect(saved.evidence_refs).toEqual(["extra-evidence"])

    // sessionId 不匹配 → 抛错
    await expect(persistCheckpointBase(projectPath, "wrong-session", next)).rejects.toThrow(
      "persistCheckpointBase 真源身份不匹配",
    )
  })

  it("computeChaseDebtState: paid/written_off 提前返回; 其他债务事件跳过; 部分/全额还款扣减", () => {
    const paid: ChaseDebt = {
      id: "d1", debt_type: "hook_strength", original_amount: 1, current_amount: 1,
      interest_rate: 0.1, source_chapter: 1, due_chapter: 5, status: "paid",
    }
    expect(computeChaseDebtState(paid, 10, [{ debt_id: "d1", event_type: "full_payment", amount: 1, chapter: 9 }])).toEqual({
      current_amount: 1, status: "paid",
    })
    const writtenOff: ChaseDebt = { ...paid, status: "written_off" }
    expect(computeChaseDebtState(writtenOff, 10, [])).toEqual({ current_amount: 1, status: "written_off" })

    // 其他债务的事件跳过 + 部分还款扣减
    const active: ChaseDebt = {
      id: "d2", debt_type: "micropayoff", original_amount: 2, current_amount: 2,
      interest_rate: 0.1, source_chapter: 1, due_chapter: 10, status: "active",
    }
    const events: ChaseDebtEvent[] = [
      { debt_id: "other", event_type: "interest_accrued", amount: 5, chapter: 2 },
      { debt_id: "d2", event_type: "interest_accrued", amount: 0.2, chapter: 2 },
      { debt_id: "d2", event_type: "partial_payment", amount: 0.5, chapter: 3 },
    ]
    const state = computeChaseDebtState(active, 3, events)
    expect(state.current_amount).toBeCloseTo(1.7)
    expect(state.status).toBe("active")

    // 全额还款 → 归零 (仍 active 因 current_amount=0)
    const fullEvents: ChaseDebtEvent[] = [{ debt_id: "d2", event_type: "full_payment", amount: 2.2, chapter: 3 }]
    expect(computeChaseDebtState(active, 3, fullEvents).current_amount).toBe(0)
  })

  it("updateChaseDebtStatus: 有 ledger → 更新匹配债务 + 追加事件 (paid/overdue/其他)", () => {
    const base: NovelSessionStatus = {
      schema_version: "1",
      session_id: "s",
      source: "deep_chapter_generation",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "running",
      active_step_index: 0,
      current_task: { task_id: "t", conversation_id: "c", user_request: "r", checkpoint_stage: "started", status: "running" },
      draft: { draft_id: "d", file_path: "p", draft_status: "pending", updated_at: "2026-01-01T00:00:00.000Z" },
      decision_gates: {
        consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        quality: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: "pass",
      },
      evidence_refs: [],
      chase_debt: {
        debts: [
          { id: "d1", debt_type: "hook_strength", original_amount: 1, current_amount: 1, interest_rate: 0.1, source_chapter: 1, due_chapter: 5, status: "active" },
          { id: "d2", debt_type: "coolpoint", original_amount: 2, current_amount: 2, interest_rate: 0.1, source_chapter: 1, due_chapter: 5, status: "active" },
        ],
        debt_events: [],
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    }
    const paid = updateChaseDebtStatus(base, "d1", "paid", 6)
    expect(paid.chase_debt!.debts[0]!.status).toBe("paid")
    expect(paid.chase_debt!.debts[1]!.status).toBe("active")
    expect(paid.chase_debt!.debt_events[0]!.event_type).toBe("full_payment")

    const overdue = updateChaseDebtStatus(base, "d2", "overdue", 7)
    expect(overdue.chase_debt!.debts[1]!.status).toBe("overdue")
    expect(overdue.chase_debt!.debt_events[0]!.event_type).toBe("overdue")

    const created = updateChaseDebtStatus(base, "d1", "active", 8)
    expect(created.chase_debt!.debt_events[0]!.event_type).toBe("created")
  })
})


describe("finding-rewrite draft helpers (RPC-2 / TASK-007)", () => {
  const sessionId = "sess-t07"
  const findingId = "finding-t07"
  const chapterId = "ch-t07"

  function draftPath() {
    return novelDraftArtifactPath(normalizedProjectPath, `finding-rewrite-${sessionId}`)
  }

  it("writeFindingRewriteDraft 写入 draft_status=pending 的 draft", async () => {
    await writeFindingRewriteDraft(normalizedProjectPath, sessionId, {
      chapterId,
      originalText: "原文片段",
      replacementText: "改写片段",
      findingId,
    })
    const draft = readJson(draftPath()) as Record<string, unknown>
    expect(draft.draft_status).toBe("pending")
    expect(draft.original_text).toBe("原文片段")
    expect(draft.replacement_text).toBe("改写片段")
    expect(draft.finding_id).toBe(findingId)
  })

  it("acceptFindingRewriteDraft 改 draft_status=accepted", async () => {
    await writeFindingRewriteDraft(normalizedProjectPath, sessionId, {
      chapterId,
      originalText: "原文片段",
      replacementText: "改写片段",
      findingId,
    })
    await acceptFindingRewriteDraft(normalizedProjectPath, sessionId)
    const draft = readJson(draftPath()) as Record<string, unknown>
    expect(draft.draft_status).toBe("accepted")
  })

  it("rejectFindingRewriteDraft 改 draft_status=rejected", async () => {
    await writeFindingRewriteDraft(normalizedProjectPath, sessionId, {
      chapterId,
      originalText: "原文片段",
      replacementText: "改写片段",
      findingId,
    })
    await rejectFindingRewriteDraft(normalizedProjectPath, sessionId)
    const draft = readJson(draftPath()) as Record<string, unknown>
    expect(draft.draft_status).toBe("rejected")
  })
})

describe("S2b chase_debt 追读债务 (webnovel ChaseDebtMeta 契约移植)", () => {
  beforeEach(() => {
    fsState.fileMap.clear()
    fsState.createdDirs.clear()
    // 恢复 readFile 默认实现 (上游 "fails fast" 测试用 mockImplementation 覆盖后未还原)
    fsState.readFile.mockImplementation(async (path: string) => {
      const content = fsState.fileMap.get(path)
      if (content === undefined) {
        throw new Error(`ENOENT: ${path}`)
      }
      return content
    })
    fsState.writeFileAtomic.mockImplementation(async (path: string, content: string) => {
      fsState.fileMap.set(path, content)
    })
  })

  it("chase_debt 是 additive-optional 字段: 旧 status.json 无该字段仍可加载", async () => {
    // 模拟旧版 status.json: 用真实 start 产物去掉 chase_debt 字段 (additive 兼容)
    fsState.fileMap.delete(statusPath)
    const started = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-legacy",
      userRequest: "写第一章",
      chapterNumber: 1,
    })
    expect(started.chase_debt).toBeUndefined() // 新会话默认无债务字段
    fsState.fileMap.set(statusPath, JSON.stringify(started, null, 2))
    const loaded = await loadNovelSessionStatus(normalizedProjectPath)
    expect(loaded).not.toBeNull()
    expect(loaded!.chase_debt).toBeUndefined() // additive: 无字段不填充
    expect(loaded!.schema_version).toBe("1")
  })

  it("chase_debt 字段可写入并在 status.json 中回读", async () => {
    const debt: ChaseDebt = {
      id: "debt-1",
      debt_type: "hook_strength",
      original_amount: 1.0,
      current_amount: 1.1,
      interest_rate: 0.1,
      source_chapter: 3,
      due_chapter: 8,
      status: "active",
    }
    fsState.fileMap.delete(statusPath)
    const started = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-2",
      userRequest: "写第二章",
      chapterNumber: 2,
    })
    const withDebt: NovelSessionStatus = {
      ...started,
      chase_debt: {
        debts: [debt],
        debt_events: [{ debt_id: "debt-1", event_type: "created", amount: 1.0, chapter: 3 }],
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    }
    fsState.fileMap.set(statusPath, JSON.stringify(withDebt, null, 2))
    const loaded = await loadNovelSessionStatus(normalizedProjectPath)
    expect(loaded).not.toBeNull()
    expect(loaded!.chase_debt?.debts).toHaveLength(1)
    expect(loaded!.chase_debt!.debts[0]!.debt_type).toBe("hook_strength")
    expect(loaded!.chase_debt!.debt_events[0]!.event_type).toBe("created")
  })

  it("契约区分: chase_debt (追读力债务) 与伏笔债务互不混用", () => {
    // chase_debt 只承载 hook/micropayoff/coolpoint 追读力债务;
    // 伏笔逾期由 foreshadowing-debt (related-chapters.findOverdueForeshadowing) 承载
    const debt: ChaseDebt = {
      id: "debt-2",
      debt_type: "micropayoff",
      original_amount: 2.0,
      current_amount: 2.0,
      interest_rate: 0.05,
      source_chapter: 5,
      due_chapter: 12,
      status: "active",
    }
    expect(debt.debt_type).not.toBe("foreshadowing") // 无混用
    expect(debt.debt_type).toBe("micropayoff")
  })

  it("computeChaseDebtState: 利息累加 + 到期判定 overdue", () => {
    const debt: ChaseDebt = {
      id: "debt-3",
      debt_type: "coolpoint",
      original_amount: 1.0,
      current_amount: 1.0,
      interest_rate: 0.1,
      source_chapter: 1,
      due_chapter: 5,
      status: "active",
    }
    const events: ChaseDebtEvent[] = [
      { debt_id: "debt-3", event_type: "interest_accrued", amount: 0.1, chapter: 2 },
      { debt_id: "debt-3", event_type: "interest_accrued", amount: 0.1, chapter: 3 },
    ]
    // 第 4 章: 未到期, 有利息
    const state4 = computeChaseDebtState(debt, 4, events)
    expect(state4.current_amount).toBeCloseTo(1.2)
    expect(state4.status).toBe("active")
    // 第 5 章: 到期且未偿清 → overdue
    const state5 = computeChaseDebtState(debt, 5, events)
    expect(state5.status).toBe("overdue")
  })

  it("accrueChaseDebtInterest 防重复计息 (同 debt 同章只计一次)", () => {
    const events: ChaseDebtEvent[] = [
      { debt_id: "d1", event_type: "interest_accrued", amount: 0.1, chapter: 3 },
    ]
    const first = accrueChaseDebtInterest(events, "d1", 3, 0.1)
    expect(first).toBeNull() // 已计过 → 拒绝
    const second = accrueChaseDebtInterest(events, "d1", 4, 0.1)
    expect(second).not.toBeNull() // 新章可计
    expect(second!.chapter).toBe(4)
  })

  it("updateChaseDebtStatus: 无 chase_debt 字段时安全 no-op", () => {
    const legacy: NovelSessionStatus = {
      schema_version: "1",
      session_id: "s",
      source: "deep_chapter_generation",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "running",
      active_step_index: 0,
      current_task: {
        task_id: "t",
        conversation_id: "c",
        user_request: "r",
        checkpoint_stage: "started",
        status: "running",
      },
      draft: {
        draft_id: "d",
        file_path: "p",
        draft_status: "pending",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      decision_gates: {
        consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        quality: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: "pending",
      },
      evidence_refs: [],
    }
    const result = updateChaseDebtStatus(legacy, "debt-x", "paid", 3)
    expect(result).toEqual(legacy) // 无字段 → 原样返回
  })

  it("buildNextStatus 支持 chase_debt 传递", () => {
    const base: NovelSessionStatus = {
      schema_version: "1",
      session_id: "s",
      source: "deep_chapter_generation",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "running",
      active_step_index: 0,
      current_task: {
        task_id: "t",
        conversation_id: "c",
        user_request: "r",
        checkpoint_stage: "started",
        status: "running",
      },
      draft: {
        draft_id: "d",
        file_path: "p",
        draft_status: "pending",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      decision_gates: {
        consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        quality: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: "pending",
      },
      evidence_refs: [],
    }
    const next = buildNextStatus(base, {
      updated_at: "2026-01-02T00:00:00.000Z",
      status: "paused",
      chase_debt: {
        debts: [],
        debt_events: [],
        updated_at: "2026-01-02T00:00:00.000Z",
      },
    })
    expect(next.chase_debt).toEqual({ debts: [], debt_events: [], updated_at: "2026-01-02T00:00:00.000Z" })
  })

  it("54 ④: createChaseDebtFromHook——承诺型悬念结尾创建追读债务", () => {
    const base: NovelSessionStatus = {
      schema_version: "1",
      session_id: "s",
      source: "deep_chapter_generation",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "running",
      active_step_index: 0,
      current_task: { task_id: "t", conversation_id: "c", user_request: "r", checkpoint_stage: "started", status: "running" },
      draft: { draft_id: "d", file_path: "p", draft_status: "pending", updated_at: "2026-01-01T00:00:00.000Z" },
      decision_gates: {
        consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        quality: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: "pending",
      },
      evidence_refs: [],
      chase_debt: { debts: [], debt_events: [], updated_at: "2026-01-01T00:00:00.000Z" },
    }
    // 承诺型悬念 → 创建
    const withDebt = createChaseDebtFromHook(base, 3, "他必须在天亮前找到真相")
    expect(withDebt.chase_debt!.debts).toHaveLength(1)
    expect(withDebt.chase_debt!.debts[0]!.debt_type).toBe("hook_strength")
    expect(withDebt.chase_debt!.debts[0]!.source_chapter).toBe(3)
    expect(withDebt.chase_debt!.debts[0]!.due_chapter).toBe(6)
    expect(withDebt.chase_debt!.debt_events[0]!.event_type).toBe("created")
    // 无承诺信号 → 不创建
    const noHook = createChaseDebtFromHook(base, 4, "夜色渐深，他合上了书。")
    expect(noHook.chase_debt!.debts).toHaveLength(0)
    // 无 chase_debt 字段 → 原样返回
    const { chase_debt: _cd, ...legacy } = base
    expect(createChaseDebtFromHook(legacy as NovelSessionStatus, 3, "他必须回来")).toBe(legacy)
  })

  it("54 ④: accrueAllChaseDebtInterest——既有未偿债务逐章计息 (防重复)", () => {
    const base: NovelSessionStatus = {
      schema_version: "1",
      session_id: "s",
      source: "deep_chapter_generation",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      status: "running",
      active_step_index: 0,
      current_task: { task_id: "t", conversation_id: "c", user_request: "r", checkpoint_stage: "started", status: "running" },
      draft: { draft_id: "d", file_path: "p", draft_status: "pending", updated_at: "2026-01-01T00:00:00.000Z" },
      decision_gates: {
        consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        quality: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: "pending",
      },
      evidence_refs: [],
      chase_debt: {
        debts: [
          { id: "d1", debt_type: "hook_strength", original_amount: 1, current_amount: 1, interest_rate: 0.1, source_chapter: 1, due_chapter: 5, status: "active" },
          { id: "d2", debt_type: "hook_strength", original_amount: 1, current_amount: 1, interest_rate: 0.1, source_chapter: 1, due_chapter: 5, status: "paid" },
        ],
        debt_events: [],
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    }
    const accrued = accrueAllChaseDebtInterest(base, 2)
    // 仅 active 债务计息; paid 跳过; 同章再调不重复计息
    expect(accrued.chase_debt!.debt_events).toHaveLength(1)
    expect(accrued.chase_debt!.debt_events[0]!.debt_id).toBe("d1")
    expect(accrued.chase_debt!.debt_events[0]!.event_type).toBe("interest_accrued")
    const again = accrueAllChaseDebtInterest(accrued, 2)
    expect(again.chase_debt!.debt_events).toHaveLength(1)
  })
})

describe("novel-session-status 全口径补齐：decision/fallback 分支", () => {
  const gates = {
    consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 1 },
    anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 1 },
    quality: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 1 },
    overall: "pass",
  } as const

  const readyDraftWithoutOptional = {
    draft_id: "conv-1",
    conversation_id: "conv-1",
    session_id: "draft-session",
    user_request: "generate chapter 3",
    draft_status: "ready",
    content: "final chapter body",
    review_results: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  }

  const minimalStatusJson = {
    schema_version: "1",
    session_id: "draft-session",
    status: "running",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    active_step_index: 3,
    current_task: {
      conversation_id: "conv-1",
      user_request: "generate chapter 3",
      status: "running",
    },
    draft: {
      draft_id: "conv-1",
      file_path: draftPath,
      draft_status: "ready",
    },
    evidence_refs: [],
  }

  it("resolveStatusResumeCheckpoint: activeStepIndex 2 → after_draft; 0 → undefined", () => {
    const checkpoint = { version: 1 as const, originalRequest: "r", chapterNumber: 3, stage: "after_review" as const }
    const status2: NovelSessionStatus = {
      schema_version: "1",
      session_id: "s",
      source: "deep_chapter_generation",
      status: "running",
      created_at: "",
      updated_at: "",
      active_step_index: 2,
      current_task: {
        task_id: "t",
        conversation_id: "conv-1",
        user_request: "r",
        checkpoint_stage: "started",
        status: "running",
      },
      draft: { draft_id: "d", file_path: "/p", draft_status: "pending", updated_at: "" },
      decision_gates: {
        consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 1 },
        anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 1 },
        quality: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 1 },
        overall: "pass",
      },
      resume_checkpoint: checkpoint,
      evidence_refs: [],
    }
    expect(resolveStatusResumeCheckpoint(status2, "conv-1")?.stage).toBe("after_draft")
    const status0 = { ...status2, active_step_index: 0 }
    expect(resolveStatusResumeCheckpoint(status0, "conv-1")).toBeUndefined()
  })

  it("accept: 无既有 status → createBaseStatus; draft 无 chapter_number/checkpoint → 全链回退", async () => {
    fsState.fileMap.set(draftPath, JSON.stringify(readyDraftWithoutOptional))
    const status = await acceptDeepChapterDraft({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 9,
      formalChapterPath: `${normalizedProjectPath}/wiki/chapters/chapter-009.md`,
    })
    expect(status.session_id).toBe("draft-session")
    expect(status.current_task.chapter_number).toBe(9)
    expect(status.draft.draft_status).toBe("accepted")
  })

  it("accept: 复用最小既有 status → base.current_task.chapter_number 缺失 → input 兜底", async () => {
    fsState.fileMap.set(statusPath, JSON.stringify(minimalStatusJson))
    fsState.fileMap.set(draftPath, JSON.stringify(readyDraftWithoutOptional))
    const status = await acceptDeepChapterDraft({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 9,
      sessionId: "draft-session",
    })
    expect(status.session_id).toBe("draft-session")
    expect(status.current_task.chapter_number).toBe(9)
  })

  it("reject: 无既有 status → createBaseStatus; draft 无 checkpoint/字段 → 全链回退", async () => {
    fsState.fileMap.set(draftPath, JSON.stringify(readyDraftWithoutOptional))
    const status = await rejectDeepChapterDraft({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 9,
    })
    expect(status.session_id).toBe("draft-session")
    expect(status.current_task.chapter_number).toBe(9)
    expect(status.draft.draft_status).toBe("rejected")
    // checkpoint 全链为空 → base.draft.checkpoint_stage 兜底（此处 createBaseStatus 为 undefined）
    expect(status.draft.checkpoint_stage).toBeUndefined()
  })

  it("reject: 复用最小既有 status + input.resumeCheckpoint 提供 reviewResults/decisionGates", async () => {
    fsState.fileMap.set(statusPath, JSON.stringify(minimalStatusJson))
    fsState.fileMap.set(draftPath, JSON.stringify(readyDraftWithoutOptional))
    const status = await rejectDeepChapterDraft({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 9,
      sessionId: "draft-session",
      resumeCheckpoint: {
        version: 1,
        originalRequest: "generate chapter 3",
        stage: "after_review",
        reviewResults,
        decisionGates: gates as never,
      },
    })
    expect(status.session_id).toBe("draft-session")
    expect(status.current_task.chapter_number).toBe(9)
    expect(status.resume_checkpoint?.stage).toBe("after_review")
  })

  it("reject: 既有 status 带 resume_checkpoint → draft 无 checkpoint 时回退 base.resume_checkpoint", async () => {
    fsState.fileMap.set(statusPath, JSON.stringify({
      ...minimalStatusJson,
      resume_checkpoint: {
        version: 1, originalRequest: "r", chapterNumber: 3, stage: "after_review",
      },
    }))
    fsState.fileMap.set(draftPath, JSON.stringify(readyDraftWithoutOptional))
    const status = await rejectDeepChapterDraft({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 9,
      sessionId: "draft-session",
    })
    expect(status.resume_checkpoint?.stage).toBe("after_review")
    expect(status.draft.draft_status).toBe("rejected")
  })

  it("block: checkpoint 无 reviewResults/decisionGates → 空数组/base 门控兜底", async () => {
    const session = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })
    const status = await blockDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      checkpoint: {
        version: 1, originalRequest: "r", chapterNumber: 3, stage: "after_draft", draftContent: "d",
      },
      errorMessage: "boom",
    })
    expect(status.status).toBe("blocked")
    expect(status.current_task.last_error).toBe("boom")
    expect(status.decision_gates.overall).toBe("pending")
    const draft = readJson(draftPath) as Record<string, unknown>
    expect(draft.review_results).toEqual([])
  })
})
