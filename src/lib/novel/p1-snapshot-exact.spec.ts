// ISS-20260712-MAINT-4: snapshotSourceFileNameCandidates 跨章节子串风险 + truth store 残留修。
// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest"
import {
  snapshotSourceFileNameCandidates,
  extractSnapshotSourceTokens,
  hasSnapshotSourceReference,
  isOnlyCurrentChapterSource,
} from "./snapshot-paths"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(async (_p: string): Promise<string> => ""),
  listDirectory: vi.fn(async (): Promise<never[]> => []),
  deleteFile: vi.fn(async (_p: string): Promise<void> => {}),
  fileExists: vi.fn(async (): Promise<boolean> => false),
}))
vi.mock("@/commands/fs", async () => {
  const actual = await vi.importActual<typeof import("@/commands/fs")>("@/commands/fs")
  return { ...actual, readFile: fsMocks.readFile, listDirectory: fsMocks.listDirectory, deleteFile: fsMocks.deleteFile, fileExists: fsMocks.fileExists }
})

import { cleanupDeletedChapterResidualEntities } from "./chapter-ingest"
import { listEntityFiles } from "./entity-subdir-resolver"

vi.mock("./entity-subdir-resolver", async () => {
  const actual = await vi.importActual<typeof import("./entity-subdir-resolver")>("./entity-subdir-resolver")
  return { ...actual, listEntityFiles: vi.fn(async () => []) }
})

describe("ISS-20260712-MAINT-4 快照源 exact 匹配 + 残留清扫", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("候选双态：正数含补零与非补零；负数含 outline 双变体（无裸数字 legacy 碰撞）", () => {
    expect(snapshotSourceFileNameCandidates(3)).toEqual(expect.arrayContaining(["003.snapshot.json", "3.snapshot.json"]))
    const neg = snapshotSourceFileNameCandidates(-7)
    expect(neg).toEqual(expect.arrayContaining(["outline-007.snapshot.json", "outline-7.snapshot.json"]))
    // 负数不得含裸 \"007.snapshot.json\"（旧 bug 会与正数 7 碰撞）
    expect(neg).not.toContain("007.snapshot.json")
  })

  it("跨章节子串风险：003 不误匹配 1003（exact token 口径）", () => {
    const candidates = new Set(snapshotSourceFileNameCandidates(3))
    // 内容引用 1003 章快照：token 为 1003.snapshot.json，不在 3 章候选中
    expect(hasSnapshotSourceReference("see 1003.snapshot.json", candidates)).toBe(false)
    expect(isOnlyCurrentChapterSource("see 1003.snapshot.json", candidates)).toBe(false)
    // 内容引用 003 章快照：命中
    expect(hasSnapshotSourceReference("see 003.snapshot.json", candidates)).toBe(true)
    expect(isOnlyCurrentChapterSource("see 003.snapshot.json", candidates)).toBe(true)
    // 混引（同时含 003 与 013）：has 为 true 但 only 为 false → 永不删
    const mixed = "a 003.snapshot.json b 013.snapshot.json"
    expect(hasSnapshotSourceReference(mixed, candidates)).toBe(true)
    expect(isOnlyCurrentChapterSource(mixed, candidates)).toBe(false)
  })

  it("token 抽取：仅抽取 *.snapshot.json 全 token（非子串）", () => {
    expect(extractSnapshotSourceTokens("无引用")).toEqual([])
    expect(extractSnapshotSourceTokens("a 003.snapshot.json b")).toEqual(["003.snapshot.json"])
  })

  it("残留清扫：仅删全属于被删章节的孤儿，混引保留（truth store 残留修）", async () => {
    const mockedList = vi.mocked(listEntityFiles)
    mockedList.mockResolvedValue([
      { name: "orphan", path: "/P/wiki/entities/orphan.md" },
      { name: "mixed", path: "/P/wiki/entities/mixed.md" },
      { name: "other", path: "/P/wiki/entities/other.md" },
    ] as never)
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("orphan.md")) return "ref 003.snapshot.json"
      if (p.endsWith("mixed.md")) return "ref 003.snapshot.json + 004.snapshot.json"
      return "ref 009.snapshot.json"
    })
    const deleted = await cleanupDeletedChapterResidualEntities("/P", 3)
    // 仅 orphan 被删
    expect(deleted).toEqual(["/P/wiki/entities/orphan.md"])
    expect(fsMocks.deleteFile).toHaveBeenCalledTimes(1)
    expect(fsMocks.deleteFile).toHaveBeenCalledWith("/P/wiki/entities/orphan.md")
  })

  it("残留清扫失败不阻断（best-effort，返回已删清单）", async () => {
    const mockedList = vi.mocked(listEntityFiles)
    mockedList.mockRejectedValueOnce(new Error("list boom"))
    const deleted = await cleanupDeletedChapterResidualEntities("/P", 3)
    expect(deleted).toEqual([])
  })
})
