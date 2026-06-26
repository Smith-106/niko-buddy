import { beforeEach, describe, expect, it, vi } from "vitest"
import { DraftStatus } from "./draft-state-machine"
import { parseNovelDraftRecord } from "./draft-record"

const fsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn(),
  fileExists: vi.fn(),
  findChapterFileByNumber: vi.fn(),
  readFile: vi.fn(),
  statusWrite: vi.fn(),
  writeFile: vi.fn(),
}))

const ingestMocks = vi.hoisted(() => ({
  ingestChapter: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: fsMocks.createDirectory,
  fileExists: fsMocks.fileExists,
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
}))

vi.mock("@/commands/status", async () => {
  const actual = await vi.importActual<typeof import("@/commands/status")>("@/commands/status")
  return {
    ...actual,
    statusWrite: fsMocks.statusWrite,
  }
})

vi.mock("./chapter-utils", () => ({
  findChapterFileByNumber: fsMocks.findChapterFileByNumber,
}))

vi.mock("./chapter-ingest", () => ({
  ingestChapter: ingestMocks.ingestChapter,
}))

vi.mock("./review-model", () => ({
  resolveReviewModel: () => "mock-review-model",
}))

import { acceptStatusDraft, explainFormalWriteDecision, rejectStatusDraft } from "./draft-decision"
import { createEmptyStatusSchema } from "./novel-session-status"
import type { StatusSchema } from "@/commands/status"

function readySchema(): StatusSchema {
  const schema = createEmptyStatusSchema()
  schema.draft = {
    draft_id: "conv-1-draft",
    draft_status: DraftStatus.Ready,
    conversation_id: "conv-1",
    chapter_number: 3,
    user_request: "生成第3章",
    task_brief: "任务书",
    draft_content: "草稿正文",
    final_content: "最终草稿正文",
    updated_at: "2026-06-22T10:00:00.000Z",
  }
  schema.decision_gates.consistency.status = "passed"
  schema.decision_gates.anti_ai.status = "passed"
  schema.decision_gates.quality.status = "warning"
  return schema
}

describe("draft-decision", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.findChapterFileByNumber.mockResolvedValue(null)
    fsMocks.readFile.mockResolvedValue("")
    fsMocks.statusWrite.mockResolvedValue(undefined)
    fsMocks.writeFile.mockResolvedValue(undefined)
    ingestMocks.ingestChapter.mockResolvedValue({
      snapshot: { chapterNumber: 3 },
    })
  })

  it("accept writes the formal layer and marks the draft accepted", async () => {
    const schema = readySchema()
    vi.spyOn(await import("./novel-session-status"), "loadOrCreateStatusSchema").mockResolvedValue(schema)

    const result = await acceptStatusDraft({
      projectPath: "E:/Novel",
      conversationId: "conv-1",
    })

    const formalWrite = fsMocks.writeFile.mock.calls.find(([path]) => String(path).includes("/wiki/chapters/"))
    const artifactWrite = fsMocks.writeFile.mock.calls.find(([path]) => String(path).includes("/.novel/drafts/"))
    expect(formalWrite).toBeTruthy()
    expect(String(formalWrite?.[1])).toContain("chapter_status: final")
    expect(artifactWrite).toBeTruthy()
    expect(ingestMocks.ingestChapter).toHaveBeenCalledTimes(1)
    expect(fsMocks.statusWrite).toHaveBeenCalledTimes(1)
    expect(result.draft.draft_status).toBe(DraftStatus.Accepted)
    expect(result.schema.draft).toMatchObject({
      draft_status: "accepted",
    })
  })

  it("reject updates status but does not write the formal layer", async () => {
    const schema = readySchema()
    vi.spyOn(await import("./novel-session-status"), "loadOrCreateStatusSchema").mockResolvedValue(schema)

    const result = await rejectStatusDraft({
      projectPath: "E:/Novel",
      conversationId: "conv-1",
    })

    expect(fsMocks.writeFile.mock.calls.some(([path]) => String(path).includes("/wiki/chapters/"))).toBe(false)
    expect(fsMocks.writeFile.mock.calls.some(([path]) => String(path).includes("/.novel/drafts/"))).toBe(true)
    expect(ingestMocks.ingestChapter).not.toHaveBeenCalled()
    expect(result.draft).toMatchObject({
      draft_status: "rejected",
    })
  })

  it("blocks accept when any decision gate still fails", async () => {
    const schema = readySchema()
    schema.decision_gates.consistency.status = "failed"
    vi.spyOn(await import("./novel-session-status"), "loadOrCreateStatusSchema").mockResolvedValue(schema)

    await expect(acceptStatusDraft({
      projectPath: "E:/Novel",
      conversationId: "conv-1",
    })).rejects.toThrow("consistency")

    expect(fsMocks.writeFile).not.toHaveBeenCalled()
    expect(ingestMocks.ingestChapter).not.toHaveBeenCalled()
  })

  it("keeps formal authority in decision_gates when review_results disagree", () => {
    const schema = readySchema()
    schema.draft = {
      ...schema.draft!,
      review_results: [
        {
          severity: "error",
          type: "setting",
          message: "设定提示仍需人工确认",
          suggestion: "人工复核后再决定是否修改",
        },
      ],
    }

    const summary = explainFormalWriteDecision({
      draft: parseNovelDraftRecord(schema.draft),
      decisionGates: schema.decision_gates,
    })

    expect(summary.reviewResultCounts.error).toBe(1)
    expect(summary.blockingGates).toEqual([])
    expect(summary.allowsFormalWrite).toBe(true)
    expect(summary.notes).toContain("review_results contain errors, but decision_gates still allow formal write")
  })
})
