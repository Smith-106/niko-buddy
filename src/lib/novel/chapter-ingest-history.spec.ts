// @vitest-environment jsdom
// chapter-ingest-history：saveEditedSnapshot 的编辑影响分析必须 fail-open（非致命）。
import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(async () => ""),
  listDirectory: vi.fn(),
  writeFileAtomic: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
  createDirectory: vi.fn(async () => {}),
  fileExists: vi.fn(async () => false),
  deleteFile: vi.fn(async () => {}),
  writeFilesAtomic: vi.fn(async () => {}),
  analyzeEditImpact: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: fsMocks.readFile,
    listDirectory: fsMocks.listDirectory,
    writeFileAtomic: fsMocks.writeFileAtomic,
    writeFile: fsMocks.writeFile,
    createDirectory: fsMocks.createDirectory,
    fileExists: fsMocks.fileExists,
    deleteFile: fsMocks.deleteFile,
    writeFilesAtomic: fsMocks.writeFilesAtomic,
  }
})

vi.mock("./edit-impact-analyzer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./edit-impact-analyzer")>()
  return { ...actual, analyzeEditImpact: fsMocks.analyzeEditImpact }
})

vi.mock("./context-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./context-engine")>()
  return { ...actual, clearTemporalFactsCache: vi.fn() }
})

vi.mock("./snapshot-preview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./snapshot-preview")>()
  return {
    ...actual,
    projectSnapshotForImpact: () => "before-body",
    projectSnapshotToImpactStores: () => ({}) as never,
  }
})

import { saveEditedSnapshot } from "./chapter-ingest-history"

beforeEach(() => {
  vi.clearAllMocks()
  // readCurrentSnapshot: 无既有快照（目录读取抛错 → 走「无快照」分支）
  fsMocks.listDirectory.mockRejectedValue(new Error("no snapshots"))
})

describe("saveEditedSnapshot 影响分析非致命", () => {
  it("analyzeEditImpact 抛错 → 吞掉并返回 requireConfirmation=false（不阻断保存链路）", async () => {
    fsMocks.analyzeEditImpact.mockImplementation(() => {
      throw new Error("impact boom")
    })
    const result = await saveEditedSnapshot("/proj", {
      chapterId: "ch-1",
      chapterNumber: 1,
      title: "第一章",
      content: "正文",
    } as never)
    expect(result.requireConfirmation).toBe(false)
    expect(fsMocks.analyzeEditImpact).toHaveBeenCalled()
  })
})
