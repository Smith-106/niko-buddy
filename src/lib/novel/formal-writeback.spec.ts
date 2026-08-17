import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  deleteFile: vi.fn(async () => {}),
  fileExists: vi.fn(async () => false),
  writeFileAtomic: vi.fn(async () => {}),
}))

const statusMocks = vi.hoisted(() => ({
  acceptDeepChapterDraft: vi.fn(async () => {}),
}))

const ledgerMocks = vi.hoisted(() => ({
  updateEmotionLedgerFromChapter: vi.fn(async () => {}),
  loggerWarn: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  deleteFile: fsMocks.deleteFile,
  fileExists: fsMocks.fileExists,
  writeFileAtomic: fsMocks.writeFileAtomic,
}))

vi.mock("./novel-session-status", () => ({
  acceptDeepChapterDraft: statusMocks.acceptDeepChapterDraft,
}))

vi.mock("./emotion-ledger", () => ({
  updateEmotionLedgerFromChapter: ledgerMocks.updateEmotionLedgerFromChapter,
}))

vi.mock("@/lib/utils", () => ({
  toErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  logger: { warn: ledgerMocks.loggerWarn, error: vi.fn() },
}))

import { commitAcceptedDeepChapterDraft } from "./formal-writeback"

describe("formal-writeback", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)
    fsMocks.deleteFile.mockResolvedValue(undefined)
    statusMocks.acceptDeepChapterDraft.mockResolvedValue(undefined)
    ledgerMocks.updateEmotionLedgerFromChapter.mockResolvedValue(undefined)
  })

  it("writes the formal chapter before accepting the managed draft", async () => {
    await commitAcceptedDeepChapterDraft({
      projectPath: "E:/Novel",
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      chapterPath: "E:/Novel/wiki/chapters/chapter-003.md",
      finalChapterContent: "# Chapter 3\n\ncontent",
      sessionId: "novel-20260629-010203",
    })

    expect(fsMocks.fileExists).toHaveBeenCalledWith("E:/Novel/wiki/chapters/chapter-003.md")
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      "E:/Novel/wiki/chapters/chapter-003.md",
      "# Chapter 3\n\ncontent",
    )
    expect(statusMocks.acceptDeepChapterDraft).toHaveBeenCalledWith({
      projectPath: "E:/Novel",
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      sessionId: "novel-20260629-010203",
      formalChapterPath: "E:/Novel/wiki/chapters/chapter-003.md",
    })
    expect(fsMocks.deleteFile).not.toHaveBeenCalled()
  })

  it("refuses to overwrite an existing formal chapter path", async () => {
    fsMocks.fileExists.mockResolvedValueOnce(true)

    await expect(commitAcceptedDeepChapterDraft({
      projectPath: "E:/Novel",
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      chapterPath: "E:/Novel/wiki/chapters/chapter-003.md",
      finalChapterContent: "# Chapter 3\n\ncontent",
    })).rejects.toThrow("Formal chapter already exists: E:/Novel/wiki/chapters/chapter-003.md")

    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(statusMocks.acceptDeepChapterDraft).not.toHaveBeenCalled()
    expect(fsMocks.deleteFile).not.toHaveBeenCalled()
  })

  it("rolls back the formal chapter file when draft acceptance fails", async () => {
    statusMocks.acceptDeepChapterDraft.mockRejectedValueOnce(new Error("accept failed"))

    await expect(commitAcceptedDeepChapterDraft({
      projectPath: "E:/Novel",
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      chapterPath: "E:/Novel/wiki/chapters/chapter-003.md",
      finalChapterContent: "# Chapter 3\n\ncontent",
    })).rejects.toThrow("accept failed")

    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      "E:/Novel/wiki/chapters/chapter-003.md",
      "# Chapter 3\n\ncontent",
    )
    expect(fsMocks.deleteFile).toHaveBeenCalledWith("E:/Novel/wiki/chapters/chapter-003.md")
  })

  it("surfaces rollback failure separately from the original accept error", async () => {
    statusMocks.acceptDeepChapterDraft.mockRejectedValueOnce(new Error("accept failed"))
    fsMocks.deleteFile.mockRejectedValueOnce(new Error("rollback failed"))

    await expect(commitAcceptedDeepChapterDraft({
      projectPath: "E:/Novel",
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      chapterPath: "E:/Novel/wiki/chapters/chapter-003.md",
      finalChapterContent: "# Chapter 3\n\ncontent",
    })).rejects.toThrow(
      "Failed to roll back formal chapter write after draft accept failure: rollback failed; original error: accept failed",
    )
  })

  it("warns but does not fail when emotion ledger write fails after accept", async () => {
    ledgerMocks.updateEmotionLedgerFromChapter.mockRejectedValueOnce(new Error("ledger disk full"))

    await expect(commitAcceptedDeepChapterDraft({
      projectPath: "E:/Novel",
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
      chapterPath: "E:/Novel/wiki/chapters/chapter-003.md",
      finalChapterContent: "# Chapter 3\n\ncontent",
    })).resolves.toBeUndefined()

    expect(ledgerMocks.loggerWarn).toHaveBeenCalledWith(
      "emotion-ledger",
      expect.stringContaining("ledger disk full"),
    )
    expect(fsMocks.deleteFile).not.toHaveBeenCalled()
  })
})
