// @vitest-environment jsdom
// chapter-ingest-history：saveEditedSnapshot 的编辑影响分析必须 fail-open（非致命）。
import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(async (_path: string) => ""),
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

import { listActualChapterNumbers, saveEditedSnapshot } from "./chapter-ingest-history"

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

describe("M2-02 listActualChapterNumbers 分卷递归与草稿过滤", () => {
  function chapterMd(num: number): string {
    return `---\ntype: chapter\nchapter_number: ${num}\ntitle: "第${num}章"\n---\n正文\n`
  }

  it("嵌套 node.children 分卷：递归收集所有嵌套子目录章号，不重复 listDirectory", async () => {
    const files = new Map<string, string>([
      ["/proj/wiki/chapters/chapter-001.md", chapterMd(1)],
      ["/proj/wiki/chapters/vol-1/chapter-002.md", chapterMd(2)],
      ["/proj/wiki/chapters/vol-1/part-b/chapter-003.md", chapterMd(3)],
    ])
    fsMocks.listDirectory.mockImplementation(async (dir: string) => {
      if (dir === "/proj/wiki/chapters") {
        return [
          { name: "chapter-001.md", path: "/proj/wiki/chapters/chapter-001.md", is_dir: false },
          {
            name: "vol-1",
            path: "/proj/wiki/chapters/vol-1",
            is_dir: true,
            children: [
              { name: "chapter-002.md", path: "/proj/wiki/chapters/vol-1/chapter-002.md", is_dir: false },
              {
                name: "part-b",
                path: "/proj/wiki/chapters/vol-1/part-b",
                is_dir: true,
                children: [
                  { name: "chapter-003.md", path: "/proj/wiki/chapters/vol-1/part-b/chapter-003.md", is_dir: false },
                ],
              },
            ],
          },
        ]
      }
      throw new Error(`Unexpected listDirectory call: ${dir}`)
    })
    fsMocks.readFile.mockImplementation(async (p: string) => {
      const content = files.get(p)
      if (content === undefined) throw new Error(`ENOENT: ${p}`)
      return content
    })

    const nums = await listActualChapterNumbers("/proj")
    expect(nums.sort((a, b) => a - b)).toEqual([1, 2, 3])
    expect(fsMocks.listDirectory).toHaveBeenCalledTimes(1)
  })

  it("浅层懒递归分卷：node.children 为 undefined 时递归调用 listDirectory(node.path)", async () => {
    const files = new Map<string, string>([
      ["/proj/wiki/chapters/vol-1/chapter-001.md", chapterMd(1)],
      ["/proj/wiki/chapters/vol-1/arc-2/chapter-002.md", chapterMd(2)],
      ["/proj/wiki/chapters/vol-2/chapter-003.md", chapterMd(3)],
    ])
    fsMocks.listDirectory.mockImplementation(async (dir: string) => {
      if (dir === "/proj/wiki/chapters") {
        return [
          { name: "vol-1", path: "/proj/wiki/chapters/vol-1", is_dir: true },
          { name: "vol-2", path: "/proj/wiki/chapters/vol-2", is_dir: true },
        ]
      }
      if (dir === "/proj/wiki/chapters/vol-1") {
        return [
          { name: "chapter-001.md", path: "/proj/wiki/chapters/vol-1/chapter-001.md", is_dir: false },
          { name: "arc-2", path: "/proj/wiki/chapters/vol-1/arc-2", is_dir: true },
        ]
      }
      if (dir === "/proj/wiki/chapters/vol-1/arc-2") {
        return [
          { name: "chapter-002.md", path: "/proj/wiki/chapters/vol-1/arc-2/chapter-002.md", is_dir: false },
        ]
      }
      if (dir === "/proj/wiki/chapters/vol-2") {
        return [
          { name: "chapter-003.md", path: "/proj/wiki/chapters/vol-2/chapter-003.md", is_dir: false },
        ]
      }
      throw new Error(`ENOENT: ${dir}`)
    })
    fsMocks.readFile.mockImplementation(async (p: string) => {
      const content = files.get(p)
      if (content === undefined) throw new Error(`ENOENT: ${p}`)
      return content
    })

    const nums = await listActualChapterNumbers("/proj")
    expect(nums.sort((a, b) => a - b)).toEqual([1, 2, 3])
    expect(fsMocks.listDirectory).toHaveBeenCalledWith("/proj/wiki/chapters/vol-1")
    expect(fsMocks.listDirectory).toHaveBeenCalledWith("/proj/wiki/chapters/vol-1/arc-2")
    expect(fsMocks.listDirectory).toHaveBeenCalledWith("/proj/wiki/chapters/vol-2")
  })

  it("草稿文件过滤：顶层与分卷子目录下的草稿（-去AI味稿.md / .draft.md / .tmp）均被排除且不读盘", async () => {
    const files = new Map<string, string>([
      ["/proj/wiki/chapters/chapter-001.md", chapterMd(1)],
      ["/proj/wiki/chapters/chapter-001-去AI味稿.md", chapterMd(1)],
      ["/proj/wiki/chapters/chapter-002.draft.md", chapterMd(2)],
      ["/proj/wiki/chapters/chapter-003.tmp", chapterMd(3)],
      ["/proj/wiki/chapters/vol-1/chapter-004.md", chapterMd(4)],
      ["/proj/wiki/chapters/vol-1/chapter-005.draft.md", chapterMd(5)],
    ])
    fsMocks.listDirectory.mockResolvedValue([
      { name: "chapter-001.md", path: "/proj/wiki/chapters/chapter-001.md", is_dir: false },
      { name: "chapter-001-去AI味稿.md", path: "/proj/wiki/chapters/chapter-001-去AI味稿.md", is_dir: false },
      { name: "chapter-002.draft.md", path: "/proj/wiki/chapters/chapter-002.draft.md", is_dir: false },
      { name: "chapter-003.tmp", path: "/proj/wiki/chapters/chapter-003.tmp", is_dir: false },
      {
        name: "vol-1",
        path: "/proj/wiki/chapters/vol-1",
        is_dir: true,
        children: [
          { name: "chapter-004.md", path: "/proj/wiki/chapters/vol-1/chapter-004.md", is_dir: false },
          { name: "chapter-005.draft.md", path: "/proj/wiki/chapters/vol-1/chapter-005.draft.md", is_dir: false },
        ],
      },
    ])
    fsMocks.readFile.mockImplementation(async (p: string) => {
      const content = files.get(p)
      if (content === undefined) throw new Error(`ENOENT: ${p}`)
      return content
    })

    const nums = await listActualChapterNumbers("/proj")
    expect(nums.sort((a, b) => a - b)).toEqual([1, 4])
    const readPaths = fsMocks.readFile.mock.calls.map(([p]) => String(p))
    expect(readPaths).toEqual([
      "/proj/wiki/chapters/chapter-001.md",
      "/proj/wiki/chapters/vol-1/chapter-004.md",
    ])
  })

  it("子目录权限错误 fail-loud 上抛（绝不静默丢章号）；顶层目录缺失仍返回 []", async () => {
    fsMocks.listDirectory.mockImplementation(async (dir: string) => {
      if (dir === "/proj/wiki/chapters") {
        return [
          { name: "chapter-001.md", path: "/proj/wiki/chapters/chapter-001.md", is_dir: false },
          { name: "vol-locked", path: "/proj/wiki/chapters/vol-locked", is_dir: true },
        ]
      }
      if (dir === "/proj/wiki/chapters/vol-locked") {
        throw new Error("EACCES: permission denied")
      }
      throw new Error(`ENOENT: ${dir}`)
    })
    fsMocks.readFile.mockResolvedValue(chapterMd(1))

    await expect(listActualChapterNumbers("/proj")).rejects.toThrow(/EACCES: permission denied/)

    // 顶层 chaptersDir 自身缺失 → 保留空数组兼容语义
    fsMocks.listDirectory.mockRejectedValueOnce(new Error("ENOENT: /proj/wiki/chapters"))
    await expect(listActualChapterNumbers("/proj")).resolves.toEqual([])
  })
})
