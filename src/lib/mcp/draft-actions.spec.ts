// @vitest-environment jsdom
/**
 * draft-actions 覆盖 spec（方案 `d23eb1df` P2）。
 *
 * 钉死两条：
 * 1. **报给调用方的路径必须与写入器同一个常量**。第一版手拼 `.novel/drafts/`，
 *    而 `writeDraft` 实际落 `.qm-drafts/`——真机验收当场抓到调用方拿到不存在的路径。
 * 2. 两个写动作都只产出草稿：章节走 `writeDraft`（既有 Draft-first 入口），记忆带
 *    `status: draft` 落在 `.novel/drafts/memory`，正式目录一律不碰。
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

const writeDraft = vi.hoisted(() => vi.fn())
const fsMocks = vi.hoisted(() => ({
  writeFile: vi.fn(async () => undefined),
  createDirectory: vi.fn(async () => undefined),
  fileExists: vi.fn(async () => true),
}))

vi.mock("@/lib/novel", () => ({
  writeDraft,
  // 故意给一个和 `.novel/drafts` 不同的值：如果实现里手拼路径，下面就会挂。
  DRAFTS_DIR: ".qm-drafts",
}))

vi.mock("@/commands/fs", () => fsMocks)

import { writeChapterDraft, writeMemoryDraft } from "./draft-actions"

beforeEach(() => {
  writeDraft.mockReset()
  fsMocks.writeFile.mockClear()
  fsMocks.createDirectory.mockClear()
  fsMocks.fileExists.mockClear()
})

describe("writeChapterDraft", () => {
  it("路径用写入器同一个 DRAFTS_DIR 常量，不是手拼的", async () => {
    writeDraft.mockResolvedValue({ id: "draft_1", chapterName: "第一章", content: "x" })
    const res = await writeChapterDraft("/proj", { chapterName: "第一章", content: "正文" })
    expect(res.path).toBe("/proj/.qm-drafts/draft_1.md")
    expect(res.draftId).toBe("draft_1")
  })

  it("明确告知未进入正式章节", async () => {
    writeDraft.mockResolvedValue({ id: "draft_1", chapterName: "第一章", content: "x" })
    const res = await writeChapterDraft("/proj", { chapterName: "第一章", content: "正文" })
    expect(res.note).toContain("草稿")
    expect(res.note).toContain("确认")
  })

  it("章节名里的路径分隔符被清洗（否则会写到草稿目录之外）", async () => {
    writeDraft.mockResolvedValue({ id: "draft_1", chapterName: "x", content: "x" })
    await writeChapterDraft("/proj", { chapterName: "../../etc/passwd", content: "正文" })
    const passedName = writeDraft.mock.calls[0][1] as string
    expect(passedName).not.toContain("/")
    expect(passedName).not.toContain("\\")
  })

  it("缺 chapterName 或 content 直接拒绝", async () => {
    await expect(writeChapterDraft("/proj", { content: "正文" })).rejects.toThrow(/chapterName/)
    await expect(writeChapterDraft("/proj", { chapterName: "第一章" })).rejects.toThrow(/content/)
    await expect(writeChapterDraft("/proj", { chapterName: "第一章", content: "   " })).rejects.toThrow(
      /content/,
    )
    expect(writeDraft).not.toHaveBeenCalled()
  })
})

describe("writeMemoryDraft（当前明确拒绝）", () => {
  it("拒绝并说明原因：没有界面能审阅记忆草稿", async () => {
    await expect(writeMemoryDraft("/proj", { name: "设定", content: "内容" })).rejects.toThrow(
      /没有记忆草稿的审阅/,
    )
  })

  it("拒绝时不留任何文件（不静默丢弃）", async () => {
    await expect(writeMemoryDraft("/proj", { name: "设定", content: "内容" })).rejects.toThrow()
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
    expect(fsMocks.createDirectory).not.toHaveBeenCalled()
  })
})
