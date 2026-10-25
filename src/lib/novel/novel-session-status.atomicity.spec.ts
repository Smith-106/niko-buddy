import { beforeEach, describe, expect, it, vi } from "vitest"
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
    writeFilesAtomic: vi.fn(async (files: Array<[string, string]>) => {
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
    fsState.writeFilesAtomic.mockImplementation(async (files: Array<[string, string]>) => {
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
      checkpoint: checkpointFor("after_revision"),
      finalContent: "final chapter body",
    })
    fsState.writeFilesAtomic.mockClear()

    await acceptDeepChapterDraft({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: session.session_id,
      formalChapterPath: `${normalizedProjectPath}/wiki/chapters/chapter-003.md`,
    })

    expect(fsState.writeFilesAtomic).toHaveBeenCalledTimes(1)
    const batch = fsState.writeFilesAtomic.mock.calls[0][0] as Array<[string, string]>
    const paths = batch.map(([p]) => String(p))
    expect(paths).toContain(draftPathFor("conv-1"))
    expect(paths).toContain(statusPath)
    const draft = JSON.parse(fsState.fileMap.get(draftPathFor("conv-1")) as string) as Record<string, unknown>
    const status = JSON.parse(fsState.fileMap.get(statusPath) as string) as Record<string, unknown>
    expect(draft.draft_status).toBe("accepted")
    expect(status.status).toBe("completed")
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
      checkpoint: checkpointFor("after_revision"),
      finalContent: "final chapter body",
    })
    const oldDraftRaw = fsState.fileMap.get(draftPathFor("conv-1"))
    const oldStatusRaw = fsState.fileMap.get(statusPath)
    expect((JSON.parse(oldDraftRaw as string) as Record<string, unknown>).draft_status).toBe("ready")

    fsState.writeFilesAtomic.mockRejectedValueOnce(new Error("batch commit failed"))
    await expect(
      acceptDeepChapterDraft({
        projectPath,
        conversationId: "conv-1",
        userRequest: "generate chapter 3",
        chapterNumber: 3,
        sessionId: session.session_id,
        formalChapterPath: `${normalizedProjectPath}/wiki/chapters/chapter-003.md`,
      }),
    ).rejects.toThrow("batch commit failed")

    expect(fsState.fileMap.get(draftPathFor("conv-1"))).toBe(oldDraftRaw)
    expect(fsState.fileMap.get(statusPath)).toBe(oldStatusRaw)
    const draft = JSON.parse(fsState.fileMap.get(draftPathFor("conv-1")) as string) as Record<string, unknown>
    expect(draft.draft_status).toBe("ready")
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
