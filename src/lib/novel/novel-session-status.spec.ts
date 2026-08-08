import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DeepChapterGenerationResumeCheckpoint } from "./deep-chapter-generation"
import type { DimensionReviewResult, SixReviewDimensionKey } from "./dimension-review-adapter"
import type { NovelReviewResult } from "./review-adapter"

const fsState = vi.hoisted(() => {
  const fileMap = new Map<string, string>()
  const createdDirs = new Set<string>()
  return {
    fileMap,
    createdDirs,
    createDirectory: vi.fn(async (path: string) => {
      createdDirs.add(path)
    }),
    readFile: vi.fn(async (path: string) => {
      const content = fileMap.get(path)
      if (content === undefined) {
        throw new Error(`ENOENT: ${path}`)
      }
      return content
    }),
    writeFileAtomic: vi.fn(async (path: string, content: string) => {
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
  blockDeepChapterSession,
  completeDeepChapterSession,
  createNovelSessionId,
  loadNovelSessionStatus,
  novelDraftArtifactPath,
  novelSessionStatusPath,
  pauseDeepChapterSession,
  persistDeepChapterCheckpoint,
  rejectDeepChapterDraft,
  resolveInterruptedSessionResumeCheckpoint,
  resolveStatusResumeCheckpoint,
  startDeepChapterSession,
  type NovelSessionStatus,
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
    })

    expect(status.status).toBe("completed")
    expect(status.active_step_index).toBe(5)
    expect(status.current_task.checkpoint_stage).toBe("completed")
    expect(status.draft.draft_status).toBe("ready")

    const draft = readJson(draftPath)
    expect(draft.draft_status).toBe("ready")
    expect(draft.content).toBe("final chapter body")
    expect(draft.review_results).toEqual(reviewResults)

    const savedStatus = readJson(statusPath)
    expect(savedStatus.status).toBe("completed")
    expect((savedStatus.current_task as Record<string, unknown>).status).toBe("completed")
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
