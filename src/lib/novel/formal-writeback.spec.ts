import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AcceptDeepChapterDraftInput } from "./novel-session-status"

const fsMocks = vi.hoisted(() => {
  const files = new Map<string, Buffer>()
  return {
    files,
    deleteFile: vi.fn(async (path: string, expected?: string) => {
      const current = files.get(path)
      if (expected !== undefined && (current === undefined || current.toString("utf8") !== expected)) {
        throw new Error("target changed after commit; left untouched")
      }
      files.delete(path)
    }),
    fileExists: vi.fn(async (path: string) => files.has(path)),
    readFile: vi.fn(async (path: string) => {
      const bytes = files.get(path)
      if (!bytes) throw new Error(`ENOENT: ${path}`)
      return bytes.toString("utf8")
    }),
    readFileAsBase64: vi.fn(async (path: string) => {
      const bytes = files.get(path)
      if (!bytes) throw new Error(`ENOENT: ${path}`)
      return { base64: bytes.toString("base64"), mimeType: "text/markdown" }
    }),
    writeFileAtomic: vi.fn(async (path: string, content: string) => {
      files.set(path, Buffer.from(content, "utf8"))
    }),
    writeFilesAtomic: vi.fn(async (entries: Array<[string, string]>, expectedContents?: (string | null)[]) => {
      for (const [i, [path]] of entries.entries()) {
        const current = files.has(path) ? files.get(path)!.toString("utf8") : null
        if (expectedContents !== undefined && current !== expectedContents[i]) {
          throw new Error(`Batch target '${path}' changed before staging; left untouched`)
        }
      }
      for (const [path, content] of entries) {
        await fsMocks.writeFileAtomic(path, content)
      }
    }),
  }
})

const statusMocks = vi.hoisted(() => {
  const afterWrite = vi.fn(async () => {})
  return {
    afterWrite,
    acceptDeepChapterDraft: vi.fn(async (input: AcceptDeepChapterDraftInput) => {
      if (!input.writeVerifiedChapter) throw new Error("Missing verified writer")
      const rollback = await input.writeVerifiedChapter()
      try {
        await afterWrite()
      } catch (error) {
        await rollback()
        throw error
      }
    }),
  }
})

const ledgerMocks = vi.hoisted(() => ({
  updateEmotionLedgerFromChapter: vi.fn(async () => {}),
  loggerWarn: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    deleteFile: fsMocks.deleteFile,
    fileExists: fsMocks.fileExists,
    readFile: fsMocks.readFile,
    readFileAsBase64: fsMocks.readFileAsBase64,
    writeFileAtomic: fsMocks.writeFileAtomic,
    writeFilesAtomic: fsMocks.writeFilesAtomic,
  }
})

vi.mock("./novel-session-status", () => ({
  acceptDeepChapterDraft: statusMocks.acceptDeepChapterDraft,
}))

vi.mock("./emotion-ledger", () => ({
  updateEmotionLedgerFromChapter: ledgerMocks.updateEmotionLedgerFromChapter,
}))

vi.mock("./promotion-bridge", async (importOriginal) => ({
  ...await importOriginal<typeof import("./promotion-bridge")>(),
  promote: vi.fn(),
}))

vi.mock("@/lib/utils", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/utils")>(),
  logger: { warn: ledgerMocks.loggerWarn, error: vi.fn() },
}))

import {
  buildManagedChapterDocument,
  commitAcceptedDeepChapterDraft,
  finalizeChapterFrontmatterBlock,
  readManagedChapterForWrite,
} from "./formal-writeback"
import { promote } from "./promotion-bridge"

const chapterPath = "E:/Novel/wiki/chapters/chapter-003.md"
const finalChapterContent = buildManagedChapterDocument(3, "第三章", "正文。")
const input = {
  projectPath: "E:/Novel",
  conversationId: "conv-1",
  userRequest: "generate chapter 3",
  chapterNumber: 3,
  chapterPath,
  finalChapterContent,
  sessionId: "novel-20260629-010203",
}
const originalContent = "\uFEFF---\r\ntype: chapter\r\nchapter_number: 3\r\nchapter_status: final\r\n---\r\n旧正文。\r\n"
const originalBytes = Buffer.from(originalContent, "utf8")

describe("formal-writeback", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    fsMocks.files.clear()
  })

  it("writes and reads back the formal chapter inside acceptance before finalizing the managed draft", async () => {
    await commitAcceptedDeepChapterDraft(input)

    expect(statusMocks.acceptDeepChapterDraft).toHaveBeenCalledWith({
      projectPath: input.projectPath,
      conversationId: input.conversationId,
      userRequest: input.userRequest,
      chapterNumber: input.chapterNumber,
      sessionId: input.sessionId,
      formalChapterPath: chapterPath,
      finalChapterContent,
      writeVerifiedChapter: expect.any(Function),
    })
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledExactlyOnceWith(chapterPath, finalChapterContent)
    expect(fsMocks.files.get(chapterPath)).toEqual(Buffer.from(finalChapterContent, "utf8"))
    expect(fsMocks.readFileAsBase64.mock.invocationCallOrder[0]).toBeLessThan(statusMocks.afterWrite.mock.invocationCallOrder[0])
    expect(fsMocks.deleteFile).not.toHaveBeenCalled()
  })

  it.each([
    ["short finalized prose", originalContent],
    ["unmarked prose", "留在这里。"],
  ])("refuses to overwrite %s without authorization", async (_label, existing) => {
    fsMocks.files.set(chapterPath, Buffer.from(existing, "utf8"))

    await expect(commitAcceptedDeepChapterDraft(input)).rejects.toThrow(`Formal chapter already exists: ${chapterPath}`)

    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(statusMocks.afterWrite).not.toHaveBeenCalled()
    expect(fsMocks.deleteFile).not.toHaveBeenCalled()
  })

  it("fills a planned skeleton with frontmatter but no body", async () => {
    fsMocks.files.set(chapterPath, Buffer.from("---\ntype: chapter\nchapter_number: 3\nchapter_status: planned\ntitle: '第3章'\n---\n\n"))

    await commitAcceptedDeepChapterDraft(input)

    expect(fsMocks.writeFileAtomic).toHaveBeenCalledExactlyOnceWith(
      chapterPath,
      "---\ntype: chapter\nchapter_number: 3\nchapter_status: final\ntitle: '第3章'\n---\n正文。",
    )
    expect(statusMocks.afterWrite).toHaveBeenCalledOnce()
  })

  it("allows an authorized overwrite of a custom filename identified by its existing chapter header", async () => {
    const customPath = "E:/Novel/wiki/chapters/换灯.md"
    fsMocks.files.set(customPath, originalBytes)
    const preserved = originalContent.slice(0, originalContent.indexOf("旧正文。")) + "正文。"

    await expect(readManagedChapterForWrite(customPath)).resolves.toBe(originalContent)
    await commitAcceptedDeepChapterDraft({ ...input, chapterPath: customPath, expectedExistingContent: originalContent, overwriteExisting: true })

    expect(fsMocks.writeFileAtomic).toHaveBeenCalledExactlyOnceWith(customPath, preserved)
    expect(fsMocks.files.get(customPath)).toEqual(Buffer.from(preserved, "utf8"))
    expect(promote).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      contentDigestPrefix: createHash("sha256").update(preserved, "utf8").digest("hex").slice(0, 16),
    }))
  })

  it.each([
    ["E:\\Novel\\wiki\\chapters\\chapter-004.md", originalContent, "filename does not match"],
    [chapterPath, originalContent.replace("chapter_number: 3", "chapter_number: 4"), "existing formal chapter does not match"],
    ["E:/Novel/wiki/chapters/unknown.md", "正文但无章号。", "existing formal chapter does not match"],
    ["E:/Novel/wiki/chapters/new-title.md", null, "canonical chapter filename"],
  ])("refuses a mismatched or unidentified target: %s", async (path, existing, error) => {
    if (existing !== null) fsMocks.files.set(path, Buffer.from(existing, "utf8"))

    await expect(commitAcceptedDeepChapterDraft({ ...input, chapterPath: path, overwriteExisting: true })).rejects.toThrow(error)

    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(statusMocks.afterWrite).not.toHaveBeenCalled()
  })

  it("refuses an authorized overwrite if the target bytes changed after confirmation", async () => {
    const changedBytes = Buffer.from(originalContent.replace(/\r\n/g, "\n"), "utf8")
    fsMocks.files.set(chapterPath, changedBytes)

    await expect(commitAcceptedDeepChapterDraft({ ...input, overwriteExisting: true, expectedExistingContent: originalContent }))
      .rejects.toThrow("The target chapter changed after confirmation")

    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(fsMocks.files.get(chapterPath)).toEqual(changedBytes)
  })

  it("rolls back a newly created file when acceptance fails after the write", async () => {
    statusMocks.afterWrite.mockRejectedValueOnce(new Error("accept failed"))

    await expect(commitAcceptedDeepChapterDraft(input)).rejects.toThrow("accept failed")

    expect(fsMocks.writeFileAtomic).toHaveBeenCalledExactlyOnceWith(chapterPath, finalChapterContent)
    expect(fsMocks.deleteFile).toHaveBeenCalledExactlyOnceWith(chapterPath, input.finalChapterContent)
    expect(fsMocks.files.has(chapterPath)).toBe(false)
    expect(ledgerMocks.updateEmotionLedgerFromChapter).not.toHaveBeenCalled()
  })

  it("keeps newer bytes when a competitor rewrites the new file before rollback", async () => {
    statusMocks.afterWrite.mockImplementationOnce(async () => {
      // 正式写与回滚之间目标被外部改写 → 回滚前置回读先拒删并上抛，竞写字节保留。
      fsMocks.files.set(chapterPath, Buffer.from("newer external bytes", "utf8"))
      throw new Error("accept failed")
    })

    await expect(commitAcceptedDeepChapterDraft(input)).rejects.toThrow("Formal chapter changed during acceptance")

    expect(fsMocks.files.get(chapterPath)?.toString("utf8")).toBe("newer external bytes")
  })

  it("boundary-race: deleteFile CAS itself sees competitor bytes and refuses removal", async () => {
    statusMocks.afterWrite.mockRejectedValueOnce(new Error("accept failed"))
    fsMocks.deleteFile.mockImplementationOnce(async (path: string, expected?: string) => {
      // 外部回读放行后、条件删除执行前目标被改写 → 守卫拒删保留新字节。
      fsMocks.files.set(path, Buffer.from("newer editor bytes", "utf8"))
      if (fsMocks.files.get(path)?.toString("utf8") !== expected) {
        throw new Error("rollback conflict")
      }
      fsMocks.files.delete(path)
    })

    await expect(commitAcceptedDeepChapterDraft(input)).rejects.toThrow()

    expect(fsMocks.deleteFile).toHaveBeenCalledExactlyOnceWith(chapterPath, input.finalChapterContent)
    expect(fsMocks.files.get(chapterPath)?.toString("utf8")).toBe("newer editor bytes")
  })

  it("DF-2: restores the exact original BOM and CRLF bytes when acceptance fails after overwrite", async () => {
    fsMocks.files.set(chapterPath, originalBytes)
    statusMocks.afterWrite.mockRejectedValueOnce(new Error("accept failed"))

    await expect(commitAcceptedDeepChapterDraft({ ...input, expectedExistingContent: originalContent, overwriteExisting: true }))
      .rejects.toThrow("accept failed")

    const preserved = originalContent.slice(0, originalContent.indexOf("旧正文。")) + "正文。"
    expect(fsMocks.writeFileAtomic).toHaveBeenNthCalledWith(1, chapterPath, preserved)
    expect(fsMocks.writeFileAtomic).toHaveBeenNthCalledWith(2, chapterPath, originalContent)
    expect(fsMocks.files.get(chapterPath)).toEqual(originalBytes)
    expect(fsMocks.deleteFile).not.toHaveBeenCalled()
  })

  it("DF-2: refuses to overwrite an unreadable target before any write", async () => {
    fsMocks.files.set(chapterPath, originalBytes)
    fsMocks.readFileAsBase64.mockRejectedValueOnce(new Error("EACCES: chapter-003.md"))

    await expect(commitAcceptedDeepChapterDraft({ ...input, overwriteExisting: true })).rejects.toThrow("EACCES")

    expect(fsMocks.files.get(chapterPath)).toEqual(originalBytes)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(fsMocks.deleteFile).not.toHaveBeenCalled()
  })

  it("DF-2: refuses a target whose legacy bytes cannot round-trip as UTF-8", async () => {
    const legacyBytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
    fsMocks.files.set(chapterPath, legacyBytes)

    await expect(commitAcceptedDeepChapterDraft({ ...input, overwriteExisting: true })).rejects.toThrow(/utf-8/i)

    expect(fsMocks.files.get(chapterPath)).toEqual(legacyBytes)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(fsMocks.deleteFile).not.toHaveBeenCalled()
  })

  it("restores the prior bytes if the first readback fails and recheck still sees the just-written bytes", async () => {
    fsMocks.files.set(chapterPath, originalBytes)
    fsMocks.readFileAsBase64
      .mockResolvedValueOnce({ base64: originalBytes.toString("base64"), mimeType: "text/markdown" })
      .mockResolvedValueOnce({ base64: originalBytes.toString("base64"), mimeType: "text/markdown" })
      .mockRejectedValueOnce(new Error("first readback failed"))

    await expect(commitAcceptedDeepChapterDraft({ ...input, overwriteExisting: true })).rejects.toThrow("first readback failed")

    expect(fsMocks.writeFileAtomic).toHaveBeenNthCalledWith(2, chapterPath, originalContent)
    expect(fsMocks.files.get(chapterPath)).toEqual(originalBytes)
    expect(statusMocks.afterWrite).not.toHaveBeenCalled()
  })

  it("reports both readback and rollback errors and leaves later external bytes untouched", async () => {
    const changedBytes = Buffer.from("external edit", "utf8")
    fsMocks.readFileAsBase64.mockImplementationOnce(async () => {
      fsMocks.files.set(chapterPath, changedBytes)
      throw new Error("first readback failed")
    })

    await expect(commitAcceptedDeepChapterDraft(input)).rejects.toThrow(
      "Failed to roll back formal chapter write: Formal chapter changed during acceptance; rollback left it untouched; original error: first readback failed",
    )

    expect(fsMocks.writeFileAtomic).toHaveBeenCalledOnce()
    expect(fsMocks.files.get(chapterPath)).toEqual(changedBytes)
    expect(fsMocks.deleteFile).not.toHaveBeenCalled()
    expect(statusMocks.afterWrite).not.toHaveBeenCalled()
  })

  it("warns but does not fail when emotion ledger write fails after accept", async () => {
    ledgerMocks.updateEmotionLedgerFromChapter.mockRejectedValueOnce(new Error("ledger disk full"))

    await expect(commitAcceptedDeepChapterDraft(input)).resolves.toBeUndefined()

    expect(ledgerMocks.loggerWarn).toHaveBeenCalledWith("emotion-ledger", expect.stringContaining("ledger disk full"))
    expect(fsMocks.deleteFile).not.toHaveBeenCalled()
  })

  it.each([
    ["draft", "chapter_status: draft", "chapter_status: final"],
    ["revised", "chapter_status: \"revised\" # 审校", "chapter_status: \"final\" # 审校"],
    ["outline", "chapter_status:   'outline'", "chapter_status:   'final'"],
    ["archived", "chapter_status: archived # 归档", "chapter_status: final # 归档"],
  ] as const)("upgrades existing %s header to final during authorized overwrite", async (_label, beforeLine, afterLine) => {
    const existing = `\uFEFF---\r\ntype: chapter\r\nchapter_number: 3\r\n${beforeLine}\r\n---\r\n旧正文。\r\n`
    fsMocks.files.set(chapterPath, Buffer.from(existing, "utf8"))

    await commitAcceptedDeepChapterDraft({
      ...input,
      expectedExistingContent: existing,
      overwriteExisting: true,
    })

    const expected = `\uFEFF---\r\ntype: chapter\r\nchapter_number: 3\r\n${afterLine}\r\n---\r\n正文。`
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledExactlyOnceWith(chapterPath, expected)
    expect(fsMocks.files.get(chapterPath)?.toString("utf8")).toBe(expected)
  })

  it("inserts chapter_status: final with preserved BOM and CRLF when missing from existing header", async () => {
    const existing = "\uFEFF---\r\ntype: chapter\r\nchapter_number: 3\r\ntitle: '第三章'\r\n---\r\n旧正文。\r\n"
    fsMocks.files.set(chapterPath, Buffer.from(existing, "utf8"))

    await commitAcceptedDeepChapterDraft({
      ...input,
      expectedExistingContent: existing,
      overwriteExisting: true,
    })

    const expected = "\uFEFF---\r\ntype: chapter\r\nchapter_number: 3\r\ntitle: '第三章'\r\nchapter_status: final\r\n---\r\n正文。"
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledExactlyOnceWith(chapterPath, expected)
    expect(fsMocks.files.get(chapterPath)?.toString("utf8")).toBe(expected)
  })

  it("fails loud before any write when existing chapter_status is custom/unrecognized", async () => {
    const existing = "---\ntype: chapter\nchapter_number: 3\nchapter_status: custom\n---\n旧正文。\n"
    const existingBytes = Buffer.from(existing, "utf8")
    fsMocks.files.set(chapterPath, existingBytes)

    await expect(commitAcceptedDeepChapterDraft({
      ...input,
      expectedExistingContent: existing,
      overwriteExisting: true,
    })).rejects.toThrow("Could not finalize the existing chapter header")

    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(statusMocks.afterWrite).not.toHaveBeenCalled()
    expect(fsMocks.files.get(chapterPath)).toEqual(existingBytes)
  })

  it("R3-M01: 二次修订采纳内容 digest 变更时递增 promote revision，避免与旧版 replayKey 碰撞", async () => {
    const promotionsPath = "E:/Novel/.novel/promotions.json"
    fsMocks.files.set(
      promotionsPath,
      Buffer.from(
        JSON.stringify({
          records: {
            "formal-writeback:chapter-3:chapter-3:1": {
              channel: "formal-writeback",
              sourceRef: { chapterId: "chapter-3", chapterNumber: 3, revision: 1 },
              targetRef: { entryId: "prom-1" },
              acceptTimestamp: "2026-09-01T00:00:00.000Z",
              replayKey: "formal-writeback:chapter-3:chapter-3:1",
              gatePass: { decisionGates: true, consistencyP0: true, manualFinal: false, evaluatedAt: "2026-09-01T00:00:00.000Z" },
              finalSnapshot: { chapterId: "chapter-3", contentDigestPrefix: "0000000000000000", extractedAt: "2026-09-01T00:00:00.000Z" },
              trustSource: { adrTrust: "blocked", license: "unknown" },
              status: "promoted",
              recordedAt: "2026-09-01T00:00:00.000Z",
            },
          },
        }),
        "utf8",
      ),
    )

    await commitAcceptedDeepChapterDraft(input)

    expect(promote).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel: "formal-writeback",
        chapterId: "chapter-3",
        chapterNumber: 3,
        revision: 2,
      }),
    )
  })
})

describe("finalizeChapterFrontmatterBlock", () => {
  it("returns already-final header byte-for-byte unchanged", () => {
    const raw = "\uFEFF---\r\ntype: chapter\r\nchapter_number: 3\r\nchapter_status: 'final' # 终稿\r\n---\r\n"
    expect(finalizeChapterFrontmatterBlock(raw)).toBe(raw)
  })

  it.each(["planned", "draft", "revised", "outline", "archived"] as const)(
    "upgrades %s to final preserving BOM, CRLF, quotes, indentation and trailing comments",
    (status) => {
      const raw = `\uFEFF---\r\n  type: chapter\r\n  chapter_number: 3\r\n  chapter_status: "${status}" # note\r\n---\r\n`
      expect(finalizeChapterFrontmatterBlock(raw)).toBe(
        "\uFEFF---\r\n  type: chapter\r\n  chapter_number: 3\r\n  chapter_status: \"final\" # note\r\n---\r\n",
      )
    },
  )

  it("inserts chapter_status: final before closing fence matching LF or BOM+CRLF", () => {
    expect(finalizeChapterFrontmatterBlock("---\ntype: chapter\nchapter_number: 3\n---\n")).toBe(
      "---\ntype: chapter\nchapter_number: 3\nchapter_status: final\n---\n",
    )
    expect(finalizeChapterFrontmatterBlock("\uFEFF---\r\ntype: chapter\r\nchapter_number: 3\r\n---\r\n")).toBe(
      "\uFEFF---\r\ntype: chapter\r\nchapter_number: 3\r\nchapter_status: final\r\n---\r\n",
    )
    expect(finalizeChapterFrontmatterBlock("---\ntype: chapter\nchapter_number: 3\n---")).toBe(
      "---\ntype: chapter\nchapter_number: 3\nchapter_status: final\n---",
    )
  })

  it.each([
    ["custom status", "---\ntype: chapter\nchapter_number: 3\nchapter_status: custom\n---\n"],
    ["empty status", "---\ntype: chapter\nchapter_number: 3\nchapter_status:\n---\n"],
    ["malformed header", "---\n: [invalid\n---\n"],
  ])("fails loud on %s", (_label, raw) => {
    expect(() => finalizeChapterFrontmatterBlock(raw)).toThrow("Could not finalize the existing chapter header")
  })
})
