import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  createDirectory: vi.fn(),
  listDirectory: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: fsMocks.readFile,
    writeFileAtomic: fsMocks.writeFileAtomic,
    createDirectory: fsMocks.createDirectory,
    listDirectory: fsMocks.listDirectory,
  }
})

import { collectCompletionChecklistInput, loadStoryCompass, saveStoryCompass } from "./story-compass"

function dirEntries(names: string[]) {
  return names.map((name) => ({ name, path: `C:/novel/.novel/snapshots/${name}`, is_dir: false }))
}

describe("collectCompletionChecklistInput 机械项采集（§GAP-89-01）", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 快照：3 正章 + 1 大纲项（负号排除）→ completedChapters=3
    fsMocks.listDirectory.mockResolvedValue(dirEntries(["1.snapshot.json", "2.snapshot.json", "3.snapshot.json", "outline-001.snapshot.json"]))
  })

  it("快照计数排除大纲项 + 伏笔 planted/advanced 计数", async () => {
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("foreshadowing-tracker.json")) {
        return JSON.stringify({
          items: [
            { id: "f1", status: "planted" },
            { id: "f2", status: "advanced" },
            { id: "f3", status: "resolved" },
            { id: "f4", status: "abandoned" },
          ],
          lastUpdated: "T",
        })
      }
      if (p.endsWith("subplot-board.json")) {
        return JSON.stringify({ items: [], lastUpdated: "T" })
      }
      throw new Error(`ENOENT ${p}`)
    })
    const input = await collectCompletionChecklistInput("C:/novel", 3)
    expect(input.completedChapters).toBe(3)
    expect(input.activeForeshadowCount).toBe(2)
    expect(input.openThreads).toEqual([])
  })

  it("支线未终结弧派生为 openThreads（去重）", async () => {
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("foreshadowing-tracker.json")) {
        return JSON.stringify({ items: [], lastUpdated: "T" })
      }
      if (p.endsWith("subplot-board.json")) {
        return JSON.stringify({
          items: [
            { id: "s1", title: "复仇线", status: "active", startChapter: 1, relatedCharacters: [], summary: "", progress: ["推进1"], notes: "" },
            { id: "s2", title: "复仇线", status: "active", startChapter: 2, relatedCharacters: [], summary: "", progress: ["推进2"], notes: "" },
            { id: "s3", title: "宝藏线", status: "resolved", startChapter: 1, resolvedChapter: 2, relatedCharacters: [], summary: "", progress: [], notes: "" },
          ],
          lastUpdated: "T",
        })
      }
      throw new Error(`ENOENT ${p}`)
    })
    const input = await collectCompletionChecklistInput("C:/novel", 5)
    expect(input.openThreads).toEqual(["复仇线"])
  })

  it("显式 openThreads 优先于 store 派生 + 语义项透传", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT"))
    const input = await collectCompletionChecklistInput("C:/novel", 5, {
      openThreads: ["长线A"],
      endingAnswered: true,
      characterFatesClear: true,
      userExpectationMet: true,
      scaleRange: { min: 30, max: 40 },
    })
    expect(input.openThreads).toEqual(["长线A"])
    expect(input.endingAnswered).toBe(true)
    expect(input.characterFatesClear).toBe(true)
    expect(input.userExpectationMet).toBe(true)
    expect(input.scaleRange).toEqual({ min: 30, max: 40 })
  })

  it("全源失败降级零值不抛错", async () => {
    fsMocks.listDirectory.mockRejectedValue(new Error("no dir"))
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT"))
    const input = await collectCompletionChecklistInput("C:/novel", 5)
    expect(input.completedChapters).toBe(0)
    expect(input.activeForeshadowCount).toBe(0)
    expect(input.openThreads).toEqual([])
  })
})

describe("story-compass store 落盘（additive .novel/story-compass.json）", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("save/load 往返", async () => {
    let saved = ""
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.writeFileAtomic.mockImplementation(async (_p: string, content: string) => {
      saved = content
    })
    fsMocks.readFile.mockImplementation(async () => saved)
    const compass = {
      endingDirection: "权力与良知抉择",
      openThreads: ["长线A"],
      estimatedScale: "预计 4-6 卷",
      finalVolumeDeclared: false,
      lastUpdated: "T",
    }
    await saveStoryCompass("C:/novel", compass)
    expect(fsMocks.writeFileAtomic).toHaveBeenCalled()
    const loaded = await loadStoryCompass("C:/novel")
    expect(loaded.endingDirection).toBe("权力与良知抉择")
    expect(loaded.openThreads).toEqual(["长线A"])
  })
})
