import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildDecisionGates } from "./deep-chapter-decision-gates"
import type { DeepChapterGenerationResumeCheckpoint } from "./deep-chapter-generation"

/**
 * P0 原子提交（R4 模式）失败语义回归：
 * 6 个 lifecycle 函数（persist/complete/pause/block/accept/reject）此前先
 * writeDraftArtifact（drafts/*.json）再 saveNovelSessionStatus，中途崩溃 =
 * 状态分叉（draft 新 + status 旧）。现改为单次 writeFilesAtomic 批量事务
 *（draft + status 同事务；失败即零落盘，失败抛错由调用方处理）。
 *
 * 本 spec 断言：
 * - 成功时单次 writeFilesAtomic 同批含 draft + status 两文件；
 * - 批量抛错时直接上抛（禁止吞错），draft 与 status 要么全落要么全不落，
 *   旧文件原样保留（状态不分叉），evidence_refs 不合并（timeline 不推进）。
 */

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
    writeFilesAtomic: vi.fn(async (files: Array<[string, string]>, expectedContents?: Array<string | null>) => {
      if (expectedContents) {
        for (let i = 0; i < files.length; i++) {
          const current = fileMap.get(files[i][0]) ?? null
          if (current !== expectedContents[i]) {
            throw new Error(`expected bytes mismatch on '${files[i][0]}'`)
          }
        }
      }
      for (const [path, content] of files) {
        fileMap.set(path, content)
      }
    }),
  }
})

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    createDirectory: fsState.createDirectory,
    readFile: fsState.readFile,
    writeFileAtomic: fsState.writeFileAtomic,
    writeFilesAtomic: fsState.writeFilesAtomic,
  }
})

import {
  acceptDeepChapterDraft,
  blockDeepChapterSession,
  completeDeepChapterSession,
  novelDraftArtifactPath,
  novelSessionStatusPath,
  pauseDeepChapterSession,
  persistDeepChapterCheckpoint,
  startDeepChapterSession,
} from "./novel-session-status"

const projectPath = "E:\\Novel"
const normalizedProjectPath = "E:/Novel"
const statusPath = novelSessionStatusPath(projectPath)
const draftPathFor = (conv: string): string => novelDraftArtifactPath(projectPath, conv)
const formalChapterPath = `${normalizedProjectPath}/wiki/chapters/chapter-003.md`
const reviewedBody = "final chapter body"
const finalChapterContent = `---\ntype: chapter\nchapter_number: 3\nchapter_status: final\n---\n${reviewedBody}`

function checkpointFor(stage: DeepChapterGenerationResumeCheckpoint["stage"] = "after_draft"): DeepChapterGenerationResumeCheckpoint {
  return {
    version: 1,
    originalRequest: "generate chapter 3",
    chapterNumber: 3,
    stage,
    taskBrief: "task brief",
    draftContent: "draft body",
  }
}

async function prepareReviewedAcceptance() {
  const chapter = { projectPath, conversationId: "conv-1", userRequest: "generate chapter 3", chapterNumber: 3 }
  const session = await startDeepChapterSession(chapter)
  await completeDeepChapterSession({
    ...chapter,
    sessionId: session.session_id,
    checkpoint: checkpointFor("after_revision"),
    finalContent: reviewedBody,
    decisionGates: buildDecisionGates([], 0),
    finalConsistencyReviewed: true,
  })
  return { ...chapter, sessionId: session.session_id, formalChapterPath, finalChapterContent }
}

function mockFormalWriter() {
  const original = fsState.fileMap.get(formalChapterPath)
  const rollback = vi.fn(async () => {
    if (original === undefined) fsState.fileMap.delete(formalChapterPath)
    else fsState.fileMap.set(formalChapterPath, original)
  })
  const writeVerifiedChapter = vi.fn(async () => {
    fsState.fileMap.set(formalChapterPath, finalChapterContent)
    return rollback
  })
  return { rollback, writeVerifiedChapter }
}

describe("P0 原子提交（R4 批量事务）成功语义", () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
    fsState.writeFilesAtomic.mockImplementation(async (files: Array<[string, string]>, expectedContents?: Array<string | null>) => {
      if (expectedContents) {
        for (let i = 0; i < files.length; i++) {
          const current = fsState.fileMap.get(files[i][0]) ?? null
          if (current !== expectedContents[i]) {
            throw new Error(`expected bytes mismatch on '${files[i][0]}'`)
          }
        }
      }
      for (const [p, c] of files) {
        fsState.fileMap.set(p, c)
      }
    })
  })

  it("persist 成功时单次 writeFilesAtomic 同批落 draft + status", async () => {
    const session = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })
    fsState.writeFilesAtomic.mockClear()

    await persistDeepChapterCheckpoint({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      checkpoint: checkpointFor("after_draft"),
    })

    expect(fsState.writeFilesAtomic).toHaveBeenCalledTimes(1)
    const batch = fsState.writeFilesAtomic.mock.calls[0][0] as Array<[string, string]>
    const paths = batch.map(([p]) => String(p))
    expect(paths).toContain(draftPathFor("conv-1"))
    expect(paths).toContain(statusPath)
    // 双落盘：draft 与 status 内容一致（同事务）
    const draft = JSON.parse(fsState.fileMap.get(draftPathFor("conv-1")) as string) as Record<string, unknown>
    const status = JSON.parse(fsState.fileMap.get(statusPath) as string) as Record<string, unknown>
    expect(draft.draft_status).toBe("pending")
    expect(status.status).toBe("running")
    expect((status.draft as Record<string, unknown>).draft_status).toBe("pending")
    expect(status.evidence_refs).toContain(draftPathFor("conv-1"))
  })

  it("accept 成功时单次 writeFilesAtomic 同批落 accepted 草稿 + completed 状态", async () => {
    const input = await prepareReviewedAcceptance()
    const { writeVerifiedChapter, rollback } = mockFormalWriter()
    fsState.writeFilesAtomic.mockClear()

    // CAS 基线是逐字节原文（含 BOM）——exactUtf8 读保留 BOM，native 比较用它。
    const bomDraft = `﻿${fsState.fileMap.get(draftPathFor("conv-1"))}`
    const bomStatus = `﻿${fsState.fileMap.get(statusPath)}`
    fsState.fileMap.set(draftPathFor("conv-1"), bomDraft)
    fsState.fileMap.set(statusPath, bomStatus)
    await acceptDeepChapterDraft({ ...input, writeVerifiedChapter })

    expect(writeVerifiedChapter).toHaveBeenCalledOnce()
    expect(rollback).not.toHaveBeenCalled()
    expect(fsState.fileMap.get(formalChapterPath)).toBe(finalChapterContent)
    expect(fsState.writeFilesAtomic).toHaveBeenCalledTimes(1)
    expect(fsState.writeFilesAtomic.mock.calls[0][1]).toEqual([bomDraft, bomStatus])
    expect(writeVerifiedChapter.mock.invocationCallOrder[0]).toBeLessThan(fsState.writeFilesAtomic.mock.invocationCallOrder[0])
    expect(fsState.writeFilesAtomic.mock.calls[0][0].map(([path]) => path)).toEqual([draftPathFor("conv-1"), statusPath])
    const draft = JSON.parse(fsState.fileMap.get(draftPathFor("conv-1")) as string) as Record<string, unknown>
    const status = JSON.parse(fsState.fileMap.get(statusPath) as string) as Record<string, unknown>
    expect(draft.draft_status).toBe("accepted")
    expect(draft.content).toBe(reviewedBody)
    expect(status.status).toBe("completed")
  })

  it("native 批次成功后的 TS 回读失败不否定已落盘的 accepted 批次（verifyAfterCommit=false）", async () => {
    const input = await prepareReviewedAcceptance()
    const { writeVerifiedChapter, rollback } = mockFormalWriter()
    // native 批量（expectedContents + 终验）为权威：批次提交后再发生的 TS 读错误
    // 不参与 accept 判定——已成功的批次不被二次 IO 失败误报。
    let batchCommitted = false
    fsState.writeFilesAtomic.mockImplementation(async (files: Array<[string, string]>) => {
      for (const [p, c] of files) {
        fsState.fileMap.set(p, c)
      }
      batchCommitted = true
    })
    fsState.readFile.mockImplementation(async (path: string) => {
      if (batchCommitted) throw new Error("post-commit read error")
      const content = fsState.fileMap.get(path)
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return content
    })

    await expect(acceptDeepChapterDraft({ ...input, writeVerifiedChapter })).resolves.toBeDefined()

    expect(rollback).not.toHaveBeenCalled()
    const draft = JSON.parse(fsState.fileMap.get(draftPathFor("conv-1")) as string) as Record<string, unknown>
    const status = JSON.parse(fsState.fileMap.get(statusPath) as string) as Record<string, unknown>
    expect(draft.draft_status).toBe("accepted")
    expect(status.status).toBe("completed")
  })

  it.each(["draft", "status"] as const)("accept 期间 %s 被外部改写 → native CAS 拒写、rollback 回正式写、竞写字节原样保留", async (target) => {
    const input = await prepareReviewedAcceptance()
    const priorDraft = fsState.fileMap.get(draftPathFor("conv-1"))
    const priorStatus = fsState.fileMap.get(statusPath)
    const { writeVerifiedChapter, rollback } = mockFormalWriter()
    writeVerifiedChapter.mockImplementation(async () => {
      fsState.fileMap.set(formalChapterPath, finalChapterContent)
      // 正式写与批量提交之间竞争者改写了受管文件。
      fsState.fileMap.set(target === "draft" ? draftPathFor("conv-1") : statusPath, "competitor bytes")
      return rollback
    })

    await expect(acceptDeepChapterDraft({ ...input, writeVerifiedChapter })).rejects.toThrow("expected bytes mismatch")

    expect(rollback).toHaveBeenCalledOnce()
    expect(fsState.fileMap.get(target === "draft" ? draftPathFor("conv-1") : statusPath)).toBe("competitor bytes")
    // 另一个文件未被本次批次触碰（CAS 拒绝 → 全不落）。
    expect(fsState.fileMap.get(target === "draft" ? statusPath : draftPathFor("conv-1")))
      .toBe(target === "draft" ? priorStatus : priorDraft)
  })

  it("resumeCheckpoint 续写批次被拒 → 原 draft/status 均不变且只有一次两路径批量写", async () => {
    await prepareReviewedAcceptance()
    const priorDraft = fsState.fileMap.get(draftPathFor("conv-1"))
    const priorStatus = fsState.fileMap.get(statusPath)
    fsState.writeFilesAtomic.mockClear()
    fsState.writeFileAtomic.mockClear()

    // 竞争者改 status 发生在基线读与批量提交之间：首个 status 读返回旧字节
    // 的同时把竞写字节落盘 → native CAS 拒绝 resume 的同批写。
    let injected = false
    const priorRead = fsState.readFile.getMockImplementation()!
    fsState.readFile.mockImplementation(async (path: string) => {
      const current = await priorRead(path)
      if (!injected && String(path) === statusPath) {
        injected = true
        fsState.fileMap.set(statusPath, priorStatus + " ")
      }
      return current
    })
    await expect(startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      resumeCheckpoint: checkpointFor("after_draft"),
    })).rejects.toThrow("expected bytes mismatch")

    expect(fsState.writeFilesAtomic).toHaveBeenCalledTimes(1)
    expect((fsState.writeFilesAtomic.mock.calls[0][0] as Array<[string, string]>).map(([p]) => p))
      .toEqual([draftPathFor("conv-1"), statusPath])
    expect(fsState.writeFileAtomic).not.toHaveBeenCalled()
    expect(fsState.fileMap.get(statusPath)).toBe(priorStatus + " ")
    expect(fsState.fileMap.get(draftPathFor("conv-1"))).toBe(priorDraft)
  })
})

describe("P0 原子提交（R4 批量事务）失败语义：零落盘 / 状态不分叉", () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
    fsState.writeFilesAtomic.mockImplementation(async (files: Array<[string, string]>) => {
      for (const [p, c] of files) {
        fsState.fileMap.set(p, c)
      }
    })
  })

  it("persist 批量抛错时上抛且 draft 与 status 全不落（旧 status 原样保留）", async () => {
    const session = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })
    const oldStatusRaw = fsState.fileMap.get(statusPath)
    expect(oldStatusRaw).toBeTruthy()
    expect(fsState.fileMap.has(draftPathFor("conv-1"))).toBe(false)

    fsState.writeFilesAtomic.mockRejectedValueOnce(new Error("batch commit failed"))
    await expect(
      persistDeepChapterCheckpoint({
        projectPath,
        conversationId: "conv-1",
        userRequest: "generate chapter 3",
        chapterNumber: 3,
        sessionId: session.session_id,
        checkpoint: checkpointFor("after_draft"),
      }),
    ).rejects.toThrow("batch commit failed")

    // 零落盘：draft 未落，status 保持旧快照（evidence_refs 未合并新 draft）
    expect(fsState.fileMap.has(draftPathFor("conv-1"))).toBe(false)
    expect(fsState.fileMap.get(statusPath)).toBe(oldStatusRaw)
    const status = JSON.parse(fsState.fileMap.get(statusPath) as string) as Record<string, unknown>
    expect(status.evidence_refs).not.toContain(draftPathFor("conv-1"))
  })

  it("complete 批量抛错时上抛且 draft 与 status 全不落（旧文件原样保留）", async () => {
    const session = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })
    await persistDeepChapterCheckpoint({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      checkpoint: checkpointFor("after_draft"),
    })
    const oldDraftRaw = fsState.fileMap.get(draftPathFor("conv-1"))
    const oldStatusRaw = fsState.fileMap.get(statusPath)
    expect(oldDraftRaw).toBeTruthy()

    fsState.writeFilesAtomic.mockRejectedValueOnce(new Error("batch commit failed"))
    await expect(
      completeDeepChapterSession({
        projectPath,
        conversationId: "conv-1",
        userRequest: "generate chapter 3",
        chapterNumber: 3,
        sessionId: session.session_id,
        checkpoint: checkpointFor("after_revision"),
        finalContent: "final chapter body",
      }),
    ).rejects.toThrow("batch commit failed")

    // 状态不分叉：draft 未推进为 ready，status 未推进为 completed
    expect(fsState.fileMap.get(draftPathFor("conv-1"))).toBe(oldDraftRaw)
    expect(fsState.fileMap.get(statusPath)).toBe(oldStatusRaw)
    const draft = JSON.parse(fsState.fileMap.get(draftPathFor("conv-1")) as string) as Record<string, unknown>
    expect(draft.draft_status).toBe("pending")
  })

  it("pause 批量抛错时上抛且 draft 与 status 全不落", async () => {
    const session = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })
    const oldStatusRaw = fsState.fileMap.get(statusPath)

    fsState.writeFilesAtomic.mockRejectedValueOnce(new Error("batch commit failed"))
    await expect(
      pauseDeepChapterSession({
        projectPath,
        conversationId: "conv-1",
        userRequest: "generate chapter 3",
        chapterNumber: 3,
        sessionId: session.session_id,
        checkpoint: checkpointFor("after_review"),
        errorMessage: "network timeout",
      }),
    ).rejects.toThrow("batch commit failed")

    expect(fsState.fileMap.has(draftPathFor("conv-1"))).toBe(false)
    expect(fsState.fileMap.get(statusPath)).toBe(oldStatusRaw)
  })

  it("block 批量抛错时上抛且 draft 与 status 全不落", async () => {
    const session = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })
    const oldStatusRaw = fsState.fileMap.get(statusPath)

    fsState.writeFilesAtomic.mockRejectedValueOnce(new Error("batch commit failed"))
    await expect(
      blockDeepChapterSession({
        projectPath,
        conversationId: "conv-1",
        userRequest: "generate chapter 3",
        chapterNumber: 3,
        sessionId: session.session_id,
        checkpoint: checkpointFor("after_revision"),
        errorMessage: "MANUAL_REVIEW_REQUIRED",
      }),
    ).rejects.toThrow("batch commit failed")

    expect(fsState.fileMap.has(draftPathFor("conv-1"))).toBe(false)
    expect(fsState.fileMap.get(statusPath)).toBe(oldStatusRaw)
  })

  it("accept 批量抛错时上抛且 draft 与 status 全不落（ready 不变 completed 不推进）", async () => {
    const input = await prepareReviewedAcceptance()
    const original = "---\r\ntype: chapter\r\nchapter_number: 3\r\nchapter_status: planned\r\n---\r\n"
    fsState.fileMap.set(formalChapterPath, original)
    const { writeVerifiedChapter, rollback } = mockFormalWriter()
    const oldDraftRaw = fsState.fileMap.get(draftPathFor("conv-1"))
    const oldStatusRaw = fsState.fileMap.get(statusPath)
    expect((JSON.parse(oldDraftRaw as string) as Record<string, unknown>).draft_status).toBe("ready")

    fsState.writeFilesAtomic.mockClear()
    fsState.writeFilesAtomic.mockImplementationOnce(async (files) => {
      expect(fsState.fileMap.get(formalChapterPath)).toBe(finalChapterContent)
      expect(files.map(([path]) => path)).toEqual([draftPathFor("conv-1"), statusPath])
      throw new Error("batch commit failed")
    })
    await expect(acceptDeepChapterDraft({ ...input, writeVerifiedChapter })).rejects.toThrow("batch commit failed")

    expect(writeVerifiedChapter).toHaveBeenCalledOnce()
    expect(fsState.writeFilesAtomic).toHaveBeenCalledOnce()
    expect(rollback).toHaveBeenCalledOnce()
    expect(fsState.fileMap.get(formalChapterPath)).toBe(original)
    expect(fsState.fileMap.get(draftPathFor("conv-1"))).toBe(oldDraftRaw)
    expect(fsState.fileMap.get(statusPath)).toBe(oldStatusRaw)
    const draft = JSON.parse(fsState.fileMap.get(draftPathFor("conv-1")) as string) as Record<string, unknown>
    expect(draft.draft_status).toBe("ready")
  })

  it("reports both the batch and formal undo failures without advancing draft or status", async () => {
    const input = await prepareReviewedAcceptance()
    const { writeVerifiedChapter, rollback } = mockFormalWriter()
    const draftBefore = fsState.fileMap.get(draftPathFor("conv-1"))
    const statusBefore = fsState.fileMap.get(statusPath)
    fsState.writeFilesAtomic.mockRejectedValueOnce(new Error("batch commit failed"))
    rollback.mockRejectedValueOnce(new Error("rollback failed"))

    await expect(acceptDeepChapterDraft({ ...input, writeVerifiedChapter })).rejects.toThrow(
      "Failed to roll back formal chapter write: rollback failed; original error: batch commit failed",
    )
    expect(fsState.fileMap.get(draftPathFor("conv-1"))).toBe(draftBefore)
    expect(fsState.fileMap.get(statusPath)).toBe(statusBefore)
  })

  it("reject 批量抛错时上抛且 draft 与 status 全不落", async () => {
    const session = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-r",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })
    await completeDeepChapterSession({
      projectPath,
      conversationId: "conv-r",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      checkpoint: checkpointFor("after_revision"),
      finalContent: "final chapter body",
    })
    const oldDraftRaw = fsState.fileMap.get(draftPathFor("conv-r"))
    const oldStatusRaw = fsState.fileMap.get(statusPath)

    fsState.writeFilesAtomic.mockRejectedValueOnce(new Error("batch commit failed"))
    await expect(
      (await import("./novel-session-status")).rejectDeepChapterDraft({
        projectPath,
        conversationId: "conv-r",
        userRequest: "generate chapter 3",
        chapterNumber: 3,
        sessionId: session.session_id,
      }),
    ).rejects.toThrow("batch commit failed")

    expect(fsState.fileMap.get(draftPathFor("conv-r"))).toBe(oldDraftRaw)
    expect(fsState.fileMap.get(statusPath)).toBe(oldStatusRaw)
  })
})
