import { beforeEach, describe, expect, it, vi } from "vitest"
import { fileExists, readFile } from "@/commands/fs"
import { runDecisionGates } from "@/commands/gates"
import { statusRead, type StatusSchema } from "@/commands/status"
import type { GateSummary } from "@/commands/gates"
import { DraftStatus } from "./draft-state-machine"
import { acceptStatusDraft, rejectStatusDraft } from "./draft-decision"
import { syncDeepSessionStatus, type DeepSessionCheckpoint } from "./novel-session-status"

const ingestMocks = vi.hoisted(() => ({
  ingestChapter: vi.fn(async () => ({
    snapshot: { chapterNumber: 3 },
  })),
}))

vi.mock("./chapter-ingest", () => ({
  ingestChapter: ingestMocks.ingestChapter,
}))

vi.mock("./review-model", () => ({
  resolveReviewModel: () => "mock-review-model",
}))

function uniqueProjectPath(label: string): string {
  return `/writing-acceptance-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function createPassingGateSummary(): GateSummary {
  return {
    all_passed: true,
    gate_results: {
      consistency: {
        gate_type: "consistency",
        status: "passed",
        score: 100,
        finding_count: 0,
        retry_count: 0,
        mechanical_findings: [],
        semantic_findings: [],
        findings_desc: [],
      },
      anti_ai: {
        gate_type: "anti_ai",
        status: "passed",
        score: 98,
        finding_count: 0,
        retry_count: 0,
        mechanical_findings: [],
        semantic_findings: [],
        findings_desc: [],
      },
      quality: {
        gate_type: "quality",
        status: "warning",
        score: 82,
        finding_count: 1,
        retry_count: 0,
        mechanical_findings: [{ severity: "warning", description: "句子略长", location: null, suggestion: "适度拆句" }],
        semantic_findings: [],
        findings_desc: ["- [warning] 句子略长"],
      },
    },
    total_retries: 0,
    max_retry: 3,
    final_text: null,
  }
}

function createFailingGateSummary(): GateSummary {
  return {
    all_passed: false,
    gate_results: {
      consistency: {
        gate_type: "consistency",
        status: "failed",
        score: 58,
        finding_count: 1,
        retry_count: 3,
        mechanical_findings: [{ severity: "error", description: "设定冲突", location: "第 2 段", suggestion: "修正设定" }],
        semantic_findings: [],
        findings_desc: ["- [error] 设定冲突"],
      },
      anti_ai: {
        gate_type: "anti_ai",
        status: "passed",
        score: 97,
        finding_count: 0,
        retry_count: 0,
        mechanical_findings: [],
        semantic_findings: [],
        findings_desc: [],
      },
      quality: {
        gate_type: "quality",
        status: "warning",
        score: 75,
        finding_count: 1,
        retry_count: 0,
        mechanical_findings: [{ severity: "warning", description: "句子略长", location: null, suggestion: "适度拆句" }],
        semantic_findings: [],
        findings_desc: ["- [warning] 句子略长"],
      },
    },
    total_retries: 3,
    max_retry: 3,
    final_text: null,
  }
}

function createReviewErrorRecord() {
  return {
    severity: "error" as const,
    type: "setting",
    message: "设定细节仍需人工复核",
    evidence: "主角提前知道了不该知道的信息",
    relatedMemory: "memory://chapter-2/cognition",
    suggestion: "人工确认后决定是否改写",
  }
}

function createReadyCheckpoint(taskId: string): DeepSessionCheckpoint {
  return {
    version: 1,
    originalRequest: "生成第 3 章",
    taskId,
    chapterNumber: 3,
    stage: "after_review",
    contextAssembly: {
      task_id: taskId,
      sources: [
        { type: "outline", ref: "context/outline", priority: 1, status: "loaded" },
        { type: "snapshots", ref: "context/snapshots", priority: 2, status: "loaded" },
      ],
      token_budget: 14000,
      estimated_tokens: 2800,
      prompt_chars: 11200,
      hard_constraints: ["不能越过角色认知边界", "禁止改写正式正文"],
      gaps: [],
    },
    taskBrief: "继续推进旧案线索，并保持角色认知边界。",
    draftContent: "这是候选草稿正文，包含本章推进与钩子。",
    reviewResults: [],
    gateSummary: createPassingGateSummary(),
    currentContent: "这是候选草稿正文，包含本章推进与钩子。",
  }
}

async function seedReadyDraft(projectPath: string, conversationId: string, taskId: string): Promise<StatusSchema> {
  const next = await syncDeepSessionStatus({
    projectPath,
    conversationId,
    userRequest: "生成第 3 章",
    chapterNumber: 3,
    checkpoint: createReadyCheckpoint(taskId),
    draftStatus: DraftStatus.Ready,
    stage: "after_review",
    sessionStatus: "running",
  })

  if (!next) {
    throw new Error("expected syncDeepSessionStatus to persist status schema")
  }

  return next
}

async function seedBlockedDraft(projectPath: string, conversationId: string, taskId: string): Promise<StatusSchema> {
  const next = await syncDeepSessionStatus({
    projectPath,
    conversationId,
    userRequest: "生成第 3 章",
    chapterNumber: 3,
    checkpoint: {
      ...createReadyCheckpoint(taskId),
      gateSummary: createFailingGateSummary(),
    },
    draftStatus: DraftStatus.Ready,
    stage: "failed",
    sessionStatus: "blocked",
  })

  if (!next) {
    throw new Error("expected blocked status schema to persist")
  }

  return next
}

function createCompletedPassingGateSummary(): GateSummary {
  return {
    all_passed: true,
    gate_results: {
      consistency: {
        gate_type: "consistency",
        status: "passed",
        score: 100,
        finding_count: 0,
        retry_count: 0,
        mechanical_findings: [],
        semantic_findings: [],
        findings_desc: [],
      },
      anti_ai: {
        gate_type: "anti_ai",
        status: "passed",
        score: 98,
        finding_count: 0,
        retry_count: 0,
        mechanical_findings: [],
        semantic_findings: [],
        findings_desc: [],
      },
      quality: {
        gate_type: "quality",
        status: "warning",
        score: 82,
        finding_count: 1,
        retry_count: 0,
        mechanical_findings: [{ severity: "warning", description: "句子略长", location: null, suggestion: "适度拆句" }],
        semantic_findings: [],
        findings_desc: ["- [warning] 句子略长"],
      },
    },
    total_retries: 0,
    max_retry: 3,
    final_text: null,
  }
}

describe("writing acceptance integration", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("persists task id, context assembly, draft artifact, and evidence refs into .novel/status.json", async () => {
    const projectPath = uniqueProjectPath("status")
    const conversationId = "conv-status"
    const taskId = "tsk-ch003-conv-status"

    await seedReadyDraft(projectPath, conversationId, taskId)

    const schema = await statusRead(projectPath)
    expect(schema.current_task).toBe(taskId)
    expect(schema.context_assembly).toMatchObject({
      task_id: taskId,
      token_budget: 14000,
    })
    expect(schema.evidence_refs).toContain(`runs/${taskId}-gates.json`)
    expect(schema.draft).toMatchObject({
      draft_id: `${conversationId}-draft`,
      draft_status: "ready",
      source_task_id: taskId,
      chapter_number: 3,
    })

    const persistedStatus = JSON.parse(await readFile(`${projectPath}/.novel/status.json`))
    expect(persistedStatus.current_task).toBe(taskId)
    expect(persistedStatus.context_assembly.task_id).toBe(taskId)

    const persistedDraft = JSON.parse(await readFile(`${projectPath}/.novel/drafts/${conversationId}-draft.json`))
    expect(persistedDraft.draft_status).toBe("ready")
    expect(persistedDraft.source_task_id).toBe(taskId)
  })

  it("persists real non-tauri gate results into status.json decision_gates", async () => {
    const projectPath = uniqueProjectPath("gate-fallback")
    const conversationId = "conv-gate-fallback"
    const taskId = "tsk-ch003-conv-gate-fallback"
    const gateSummary = await runDecisionGates(
      projectPath,
      "他不知道这件事，却知道其中的关键细节。然而，事实上，他感到一阵复杂的感动，因为这一切显然意味着某种底层逻辑正在赋能他的判断，因此他进行评估并做出选择也就是说这意味着他正在正准备继续推进这个局面",
    )

    expect(gateSummary.gate_results.consistency.status).toBe("failed")
    expect(gateSummary.gate_results.anti_ai.status).toBe("failed")
    expect(gateSummary.gate_results.quality.status).toBe("warning")

    await syncDeepSessionStatus({
      projectPath,
      conversationId,
      userRequest: "生成第 3 章",
      chapterNumber: 3,
      checkpoint: {
        ...createReadyCheckpoint(taskId),
        gateSummary,
      },
      draftStatus: DraftStatus.Ready,
      stage: "after_review",
      sessionStatus: "running",
    })

    const persistedStatus = JSON.parse(await readFile(`${projectPath}/.novel/status.json`))
    expect(persistedStatus.decision_gates.consistency.status).toBe("failed")
    expect(persistedStatus.decision_gates.anti_ai.status).toBe("failed")
    expect(persistedStatus.decision_gates.quality.status).toBe("warning")
    expect(persistedStatus.decision_gates.consistency.retry_count).toBe(1)
    expect(persistedStatus.decision_gates.anti_ai.retry_count).toBe(1)
    expect(persistedStatus.evidence_refs).toContain(`runs/${taskId}-gates.json`)
  })

  it("accept writes the formal layer and updates status.json plus draft artifact", async () => {
    const projectPath = uniqueProjectPath("accept")
    const conversationId = "conv-accept"
    const taskId = "tsk-ch003-conv-accept"

    await seedReadyDraft(projectPath, conversationId, taskId)

    const result = await acceptStatusDraft({
      projectPath,
      conversationId,
    })

    expect(await fileExists(result.targetPath)).toBe(true)
    const chapterMarkdown = await readFile(result.targetPath)
    expect(chapterMarkdown).toContain("chapter_status: final")
    expect(chapterMarkdown).toContain("# 第3章")
    expect(chapterMarkdown).toContain("这是候选草稿正文")

    const schema = await statusRead(projectPath)
    expect(schema.status).toBe("completed")
    expect(schema.draft).toMatchObject({
      draft_status: "accepted",
      source_task_id: taskId,
      formal_chapter_path: result.targetPath,
    })
    expect(schema.memory_snapshot).toMatchObject({
      latest_formal_chapter_path: result.targetPath,
      latest_draft_status: "accepted",
    })

    const persistedDraft = JSON.parse(await readFile(`${projectPath}/.novel/drafts/${conversationId}-draft.json`))
    expect(persistedDraft.draft_status).toBe("accepted")
    expect(persistedDraft.formal_chapter_path).toBe(result.targetPath)
    expect(ingestMocks.ingestChapter).toHaveBeenCalledTimes(1)
  })

  it("accept still follows decision_gates when review_results keep an error record", async () => {
    const projectPath = uniqueProjectPath("accept-review-error")
    const conversationId = "conv-accept-review-error"
    const taskId = "tsk-ch003-conv-accept-review-error"

    await syncDeepSessionStatus({
      projectPath,
      conversationId,
      userRequest: "生成第 3 章",
      chapterNumber: 3,
      checkpoint: {
        ...createReadyCheckpoint(taskId),
        reviewResults: [createReviewErrorRecord()],
      },
      draftStatus: DraftStatus.Ready,
      stage: "after_review",
      sessionStatus: "running",
    })

    const beforeAccept = await statusRead(projectPath)
    expect(beforeAccept.draft).toMatchObject({
      draft_status: "ready",
      source_task_id: taskId,
      review_results: [createReviewErrorRecord()],
    })
    expect(beforeAccept.decision_gates.consistency.status).toBe("passed")
    expect(beforeAccept.decision_gates.anti_ai.status).toBe("passed")
    expect(beforeAccept.decision_gates.quality.status).toBe("warning")

    const result = await acceptStatusDraft({
      projectPath,
      conversationId,
    })

    const afterAccept = await statusRead(projectPath)
    expect(afterAccept.status).toBe("completed")
    expect(afterAccept.draft).toMatchObject({
      draft_status: "accepted",
      source_task_id: taskId,
      formal_chapter_path: result.targetPath,
      review_results: [createReviewErrorRecord()],
    })
    expect(afterAccept.decision_gates.consistency.status).toBe("passed")
    expect(afterAccept.decision_gates.anti_ai.status).toBe("passed")
    expect(afterAccept.decision_gates.quality.status).toBe("warning")
  })

  it("aligns completed persisted review_results with the final gate authority", async () => {
    const projectPath = uniqueProjectPath("completed-review-align")
    const conversationId = "conv-completed-review-align"
    const taskId = "tsk-ch003-conv-completed-review-align"

    await syncDeepSessionStatus({
      projectPath,
      conversationId,
      userRequest: "生成第 3 章",
      chapterNumber: 3,
      checkpoint: {
        ...createReadyCheckpoint(taskId),
        stage: "after_revision",
        reviewResults: [
          createReviewErrorRecord(),
          {
            severity: "warning",
            type: "style",
            message: "句子略长",
            evidence: "一段较长的描述句",
            relatedMemory: "",
            suggestion: "适度拆句",
          },
        ],
        gateSummary: createCompletedPassingGateSummary(),
        currentContent: "返修后的最终正文",
      },
      draftStatus: DraftStatus.Ready,
      stage: "completed",
      finalContent: "返修后的最终正文",
      sessionStatus: "completed",
    })

    const persistedStatus = await statusRead(projectPath)
    expect(persistedStatus.status).toBe("completed")
    expect(persistedStatus.decision_gates.consistency.status).toBe("passed")
    expect(persistedStatus.decision_gates.anti_ai.status).toBe("passed")
    expect(persistedStatus.decision_gates.quality.status).toBe("warning")
    expect(persistedStatus.draft).toMatchObject({
      draft_status: "ready",
      review_results: [
        {
          severity: "warning",
          type: "style",
          message: "句子略长",
        },
      ],
    })
  })

  it("reject keeps the formal layer untouched while recording rejected draft state", async () => {
    const projectPath = uniqueProjectPath("reject")
    const conversationId = "conv-reject"
    const taskId = "tsk-ch003-conv-reject"

    await seedReadyDraft(projectPath, conversationId, taskId)

    const schema = await rejectStatusDraft({
      projectPath,
      conversationId,
    })

    expect(await fileExists(`${projectPath}/wiki/chapters`)).toBe(false)
    expect(schema.draft).toMatchObject({
      draft_status: "rejected",
      source_task_id: taskId,
    })
    expect(schema.memory_snapshot).toMatchObject({
      latest_draft_status: "rejected",
    })

    const persistedStatus = await statusRead(projectPath)
    expect(persistedStatus.draft).toMatchObject({
      draft_status: "rejected",
    })

    const persistedDraft = JSON.parse(await readFile(`${projectPath}/.novel/drafts/${conversationId}-draft.json`))
    expect(persistedDraft.draft_status).toBe("rejected")
    expect(persistedDraft.formal_chapter_path).toBeUndefined()
    expect(ingestMocks.ingestChapter).not.toHaveBeenCalled()
  })

  it("persists blocked manual-review state after max_retry is exhausted", async () => {
    const projectPath = uniqueProjectPath("blocked")
    const conversationId = "conv-blocked"
    const taskId = "tsk-ch003-conv-blocked"

    const schema = await seedBlockedDraft(projectPath, conversationId, taskId)

    expect(schema.status).toBe("blocked")
    expect(schema.active_step_index).toBe(3)
    expect(schema.current_task).toBe(taskId)
    expect(schema.decision_gates.consistency.status).toBe("failed")
    expect(schema.decision_gates.consistency.retry_count).toBe(3)
    expect(schema.draft).toMatchObject({
      draft_status: "ready",
      source_task_id: taskId,
    })

    const persistedStatus = JSON.parse(await readFile(`${projectPath}/.novel/status.json`))
    expect(persistedStatus.status).toBe("blocked")
    expect(persistedStatus.decision_gates.consistency.status).toBe("failed")
    expect(persistedStatus.decision_gates.consistency.retry_count).toBe(3)
    expect(persistedStatus.evidence_refs).toContain(`runs/${taskId}-gates.json`)

    const persistedDraft = JSON.parse(await readFile(`${projectPath}/.novel/drafts/${conversationId}-draft.json`))
    expect(persistedDraft.draft_status).toBe("ready")
    expect(await fileExists(`${projectPath}/wiki/chapters`)).toBe(false)
    expect(ingestMocks.ingestChapter).not.toHaveBeenCalled()
  })
})
