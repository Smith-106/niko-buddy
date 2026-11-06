import { describe, expect, it, vi } from "vitest"

// cleanupDeletedChapterResidualEntities 的 best-effort 契约：逐个 entity 文件读/删，
// 单个失败只记 warn 并继续，绝不中断整轮清扫。
const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  deleteFile: vi.fn(),
  listEntityFiles: vi.fn(),
  warn: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, readFile: mocks.readFile, deleteFile: mocks.deleteFile }
})

vi.mock("./entity-subdir-resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./entity-subdir-resolver")>()
  return { ...actual, listEntityFiles: mocks.listEntityFiles }
})

vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>()
  return { ...actual, logger: { ...actual.logger, warn: mocks.warn } }
})

import { cleanupDeletedChapterResidualEntities } from "./chapter-ingest-snapshot-io"

describe("cleanupDeletedChapterResidualEntities best-effort", () => {
  it("读失败跳过该文件、删失败只 warn，两者都不中断清扫", async () => {
    mocks.warn.mockClear()
    mocks.listEntityFiles.mockResolvedValue([
      { name: "only-3", path: "/p/wiki/entities/only-3.md" },
      { name: "unreadable", path: "/p/wiki/entities/unreadable.md" },
    ])
    // only-3 只引用第 3 章快照 token → 命中删除条件；unreadable 读失败。
    // 注意判定是 exact token（SNAPSHOT_SOURCE_TOKEN_RE 抽取后 Set 命中），非 includes 子串。
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.includes("unreadable")) throw new Error("read boom")
      return "source: 003.snapshot.json"
    })
    mocks.deleteFile.mockRejectedValue(new Error("delete boom"))

    const deleted = await cleanupDeletedChapterResidualEntities("/p", 3)

    // 删除失败的文件不计入已删清单，但清扫整体正常返回
    expect(deleted).toEqual([])
    expect(mocks.warn).toHaveBeenCalledWith(
      "Chapter Ingest",
      "residual sweep read failed (non-fatal)",
      expect.objectContaining({ error: "read boom" }),
    )
    expect(mocks.warn).toHaveBeenCalledWith(
      "Chapter Ingest",
      "residual sweep delete failed (non-fatal)",
      expect.objectContaining({ error: "delete boom" }),
    )
  })
})
