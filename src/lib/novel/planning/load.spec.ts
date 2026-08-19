import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  createDirectory: vi.fn(),
  listDirectory: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
  createDirectory: fsMocks.createDirectory,
  listDirectory: fsMocks.listDirectory,
}))

import { buildChapterPlan } from "./aggregate"

const FORESHADOWING_JSON = JSON.stringify({
  lastUpdated: "2026-08-18T00:00:00.000Z",
  items: [
    {
      id: "f1",
      name: "青铜古戒",
      description: "",
      status: "planted",
      plantedChapter: 2,
      advancedChapters: [],
      relatedCharacters: [],
      relatedEvents: [],
      notes: "",
    },
  ],
})

const CHARACTERS_JSON = JSON.stringify({
  lastUpdated: "2026-08-18T00:00:00.000Z",
  characters: [
    {
      characterName: "林动",
      currentLocation: "青山镇",
      status: "健康",
      equipment: [],
      abilities: [],
      relationships: {},
      lastUpdatedChapter: 3,
      lastUpdatedAt: "2026-08-01T00:00:00.000Z",
    },
  ],
})

const SUBPLOTS_JSON = JSON.stringify({
  lastUpdated: "2026-08-18T00:00:00.000Z",
  items: [
    {
      id: "s1",
      title: "宗门大比",
      status: "active",
      startChapter: 1,
      relatedCharacters: [],
      summary: "",
      progress: ["第1章：报名", "第2章：初赛", "第3章：复赛", "第4章：决赛"],
      notes: "",
    },
  ],
})

const SNAPSHOT_JSON = JSON.stringify({
  chapterNumber: 3,
  title: "第三章",
  content: "林动出场",
  characters: ["林动"],
})

describe("buildChapterPlan (IO 编排)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMocks.listDirectory.mockResolvedValue([{ name: "3.snapshot.json" }])
    fsMocks.readFile.mockImplementation((path: string) => {
      if (path.endsWith("foreshadowing-tracker.json")) return Promise.resolve(FORESHADOWING_JSON)
      if (path.endsWith("character-states.json")) return Promise.resolve(CHARACTERS_JSON)
      if (path.endsWith("subplot-board.json")) return Promise.resolve(SUBPLOTS_JSON)
      if (path.endsWith("snapshots/003.snapshot.json")) return Promise.resolve(SNAPSHOT_JSON)
      return Promise.reject(new Error(`not found: ${path}`))
    })
  })

  it("四源并行装载并组合为计划视图", async () => {
    const view = await buildChapterPlan("/proj", 8)
    expect(view.chapterNumber).toBe(8)
    expect(view.foreshadowing.status).toBe("ok")
    expect(view.characters.status).toBe("ok")
    expect(view.threads.status).toBe("ok")
    expect(view.foreshadowing.report!.items[0].name).toBe("青铜古戒")
    expect(view.characters.items[0].name).toBe("林动")
    expect(view.threads.items[0].title).toBe("宗门大比")
  })

  it("单源失败 → 该维 degraded，其余维度正常（绝不整体失败）", async () => {
    fsMocks.readFile.mockImplementation((path: string) => {
      if (path.endsWith("character-states.json")) return Promise.reject(new Error("corrupt"))
      if (path.endsWith("foreshadowing-tracker.json")) return Promise.resolve(FORESHADOWING_JSON)
      if (path.endsWith("subplot-board.json")) return Promise.resolve(SUBPLOTS_JSON)
      if (path.endsWith("snapshots/003.snapshot.json")) return Promise.resolve(SNAPSHOT_JSON)
      return Promise.reject(new Error(`not found: ${path}`))
    })
    const view = await buildChapterPlan("/proj", 8)
    expect(view.characters.status).toBe("degraded")
    expect(view.foreshadowing.status).toBe("ok")
    expect(view.threads.status).toBe("ok")
    expect(view.characters.items).toEqual([])
  })

  it("字符源抛错 → 该维 degraded，其余维度按引擎 fail-open 语义降级为空（绝不整体失败）", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("disk error"))
    const view = await buildChapterPlan("/proj", 8)
    // character-states 损坏/IO 错误会 rethrow → degraded
    expect(view.characters.status).toBe("degraded")
    // foreshadowing/subplot 引擎语义：缺失 → 空 store（ok + 空数据）
    expect(view.foreshadowing.status).toBe("ok")
    expect(view.foreshadowing.report!.items).toEqual([])
    expect(view.threads.status).toBe("ok")
    expect(view.threads.items).toEqual([])
    expect(view.summary.openThreads).toBe(0)
  })

  it("快照缺失 → 出场数据降级为空但不影响其他维度", async () => {
    fsMocks.readFile.mockImplementation((path: string) => {
      if (path.endsWith("foreshadowing-tracker.json")) return Promise.resolve(FORESHADOWING_JSON)
      if (path.endsWith("character-states.json")) return Promise.resolve(CHARACTERS_JSON)
      if (path.endsWith("subplot-board.json")) return Promise.resolve(SUBPLOTS_JSON)
      return Promise.reject(new Error(`not found: ${path}`))
    })
    const view = await buildChapterPlan("/proj", 8)
    expect(view.characters.status).toBe("ok")
    expect(view.characters.items[0].chaptersSinceSeen).toBeUndefined()
  })

  it("快照目录不可读 → 出场数据降级为空（loadAllSnapshotsForPlan catch）", async () => {
    fsMocks.listDirectory.mockRejectedValue(new Error("no snapshots dir"))
    const view = await buildChapterPlan("/proj", 8)
    expect(view.characters.status).toBe("ok")
    expect(view.characters.items[0].chaptersSinceSeen).toBeUndefined()
  })
})
