import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn(),
  deleteFile: vi.fn(),
  fileExists: vi.fn(),
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: fsMocks.createDirectory,
  deleteFile: fsMocks.deleteFile,
  fileExists: fsMocks.fileExists,
  readFile: fsMocks.readFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
}))

import {
  deAiBatchDraftPath,
  deAiBatchDraftsDirPath,
  deleteDeAiBatchDraft,
  loadDeAiBatchDraft,
  saveDeAiBatchDraft,
} from "./drafts"
import { DE_AI_BATCH_SCHEMA, type DeAiBatchDraftArtifact } from "./types"

function artifact(chapterNumber: number): DeAiBatchDraftArtifact {
  return {
    schemaVersion: DE_AI_BATCH_SCHEMA,
    batchId: "de-ai-1",
    chapterNumber,
    sourcePath: "/p/wiki/chapters/第3章.md",
    originalContent: "原文",
    candidateContent: "改写",
    dualPassScore: 42,
    avoidWordsHits: [{ word: "不禁", count: 2 }],
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  }
}

describe("de-ai-batch drafts", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)
    fsMocks.deleteFile.mockResolvedValue(undefined)
  })

  it("路径：.novel/de-ai-batch-drafts/{chapterNumber}.json", () => {
    expect(deAiBatchDraftsDirPath("C:/book")).toBe("C:/book/.novel/de-ai-batch-drafts")
    expect(deAiBatchDraftPath("C:/book", 3)).toBe("C:/book/.novel/de-ai-batch-drafts/3.json")
  })

  it("saveDeAiBatchDraft：建目录 + 原子写，返回路径", async () => {
    const path = await saveDeAiBatchDraft("C:/book", artifact(3))
    expect(path).toBe("C:/book/.novel/de-ai-batch-drafts/3.json")
    expect(fsMocks.createDirectory).toHaveBeenCalledWith("C:/book/.novel/de-ai-batch-drafts")
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      "C:/book/.novel/de-ai-batch-drafts/3.json",
      expect.stringContaining('"chapterNumber": 3'),
    )
  })

  it("loadDeAiBatchDraft：roundtrip 成功", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify(artifact(3)))
    const loaded = await loadDeAiBatchDraft("C:/book", 3)
    expect(loaded?.candidateContent).toBe("改写")
    expect(loaded?.avoidWordsHits).toEqual([{ word: "不禁", count: 2 }])
  })

  it("loadDeAiBatchDraft：schema 不匹配返回 null", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ ...artifact(3), schemaVersion: "old" }))
    expect(await loadDeAiBatchDraft("C:/book", 3)).toBeNull()
  })

  it("loadDeAiBatchDraft：章节号不匹配返回 null", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify(artifact(3)))
    expect(await loadDeAiBatchDraft("C:/book", 4)).toBeNull()
  })

  it("loadDeAiBatchDraft：读失败返回 null", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("no file"))
    expect(await loadDeAiBatchDraft("C:/book", 3)).toBeNull()
  })

  it("deleteDeAiBatchDraft：存在则删除返回 true", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    expect(await deleteDeAiBatchDraft("C:/book", 3)).toBe(true)
    expect(fsMocks.deleteFile).toHaveBeenCalledWith("C:/book/.novel/de-ai-batch-drafts/3.json")
  })

  it("deleteDeAiBatchDraft：不存在返回 false 不删", async () => {
    fsMocks.fileExists.mockResolvedValue(false)
    expect(await deleteDeAiBatchDraft("C:/book", 3)).toBe(false)
    expect(fsMocks.deleteFile).not.toHaveBeenCalled()
  })
})
