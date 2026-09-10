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

// ==================== P2-IMP-11 四新维 IO 三态 ====================

const COGNITION_JSON = JSON.stringify({
  characters: [
    { character: "林动", knows: ["父亲失踪"], doesNotKnow: ["黑市入口在城西", "黑衣人是他父亲"] },
  ],
  readerKnows: [],
  lastUpdatedChapter: 7,
})

const MATRIX_JSON = JSON.stringify({
  edges: [
    { a: "林动", b: "应欢欢", chapter: 3, context: "青山镇", witnessedBy: [] },
    // 本章共现 —— 'past' 口径必须排除（P2-IMP-05）
    { a: "林动", b: "绫清竹", chapter: 8, context: "大比", witnessedBy: [] },
  ],
  lastUpdated: "",
})

const PARTICLES_JSON = JSON.stringify({
  entries: [
    { kind: "money", character: "林动", name: "灵石", chapter: 2, delta: 100, state: "余额 100", note: "" },
    { kind: "injury", character: "林动", name: "左臂", chapter: 7, delta: 1, state: "骨折", note: "" },
  ],
  lastUpdated: "",
})

const RESOURCES_JSON = JSON.stringify({
  entries: [
    { item: "青铜古戒", currentHolder: "林动", acquiredChapter: 2, transferHistory: [] },
  ],
  lastUpdated: "",
})

const SUMMARIES_JSON = JSON.stringify({
  entries: [
    {
      chapter: 7,
      happened: "第七章",
      stateChanges: [{ kind: "item", entity: "青铜古戒", change: "归属 → 林动" }],
      keyReveals: [],
      endingHook: "",
    },
  ],
  lastUpdated: "",
})

/** 新维五文件齐备的 readFile 路由（其余文件走既有三维 fixture） */
function routeNewSources(overrides: Record<string, string> = {}) {
  fsMocks.readFile.mockImplementation((path: string) => {
    if (path.endsWith("foreshadowing-tracker.json")) return Promise.resolve(FORESHADOWING_JSON)
    if (path.endsWith("character-states.json")) return Promise.resolve(CHARACTERS_JSON)
    if (path.endsWith("subplot-board.json")) return Promise.resolve(SUBPLOTS_JSON)
    if (path.endsWith("snapshots/003.snapshot.json")) return Promise.resolve(SNAPSHOT_JSON)
    for (const [name, payload] of Object.entries(overrides)) {
      if (path.endsWith(name)) return Promise.resolve(payload)
    }
    if (path.endsWith("cognition-state.json")) return Promise.resolve(COGNITION_JSON)
    if (path.endsWith("encounter-matrix.json")) return Promise.resolve(MATRIX_JSON)
    if (path.endsWith("particle-ledger.json")) return Promise.resolve(PARTICLES_JSON)
    if (path.endsWith("resource-ledger.json")) return Promise.resolve(RESOURCES_JSON)
    if (path.endsWith("chapter-summaries.json")) return Promise.resolve(SUMMARIES_JSON)
    return Promise.reject(new Error(`not found: ${path}`))
  })
}

describe("buildChapterPlan — P2-IMP-11 四新维 IO 三态", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMocks.listDirectory.mockResolvedValue([{ name: "3.snapshot.json" }])
  })

  it("四源各有 → 四维 ok 且 POV 穿参生效", async () => {
    routeNewSources()
    const view = await buildChapterPlan("/proj", 8, { povCharacter: "林动" })
    expect(view.povCharacter).toBe("林动")
    expect(view.cognition!.status).toBe("ok")
    expect(view.cognition!.items).toEqual(["黑市入口在城西", "黑衣人是他父亲"])
    expect(view.encounter!.status).toBe("ok")
    expect(view.encounter!.items).toEqual(["应欢欢"])
    expect(view.particles!.status).toBe("ok")
    expect(view.particles!.items.map((p) => p.kind)).toEqual(["money", "injury"])
    expect(view.recentStateDeltas!.status).toBe("ok")
    expect(view.recentStateDeltas!.items[0]!.chapter).toBe(7)
    // 既有三维零回归
    expect(view.foreshadowing.status).toBe("ok")
    expect(view.characters.status).toBe("ok")
    expect(view.threads.status).toBe("ok")
  })

  it("四源全缺（新维文件不存在 + POV 真源未落地）→ 三维 degraded + 状态变更 ok 空，整体不抛", async () => {
    fsMocks.readFile.mockImplementation((path: string) => {
      if (path.endsWith("foreshadowing-tracker.json")) return Promise.resolve(FORESHADOWING_JSON)
      if (path.endsWith("character-states.json")) return Promise.resolve(CHARACTERS_JSON)
      if (path.endsWith("subplot-board.json")) return Promise.resolve(SUBPLOTS_JSON)
      return Promise.reject(new Error(`not found: ${path}`))
    })
    const view = await buildChapterPlan("/proj", 8)
    // POV 未解析 → 三维可见降级（而非伪报「无盲区」）
    expect(view.cognition!.status).toBe("degraded")
    expect(view.encounter!.status).toBe("degraded")
    expect(view.particles!.status).toBe("degraded")
    expect(view.cognition!.reason).toContain("POV")
    // 摘要投影缺失 = 合法空数据（createAtomicJsonStore onMissing:empty）→ ok
    expect(view.recentStateDeltas!.status).toBe("ok")
    expect(view.recentStateDeltas!.items).toEqual([])
    // 绝不整体失败：既有三维照旧产出
    expect(view.foreshadowing.report!.items[0]!.name).toBe("青铜古戒")
  })

  it("部分降级：cognition 损坏（onCorrupt throw）→ 只降认知维，其余三维不受影响", async () => {
    routeNewSources({ "cognition-state.json": "{ not json" })
    const view = await buildChapterPlan("/proj", 8, { povCharacter: "林动" })
    expect(view.cognition!.status).toBe("degraded")
    expect(view.cognition!.reason).toContain("认知")
    expect(view.encounter!.status).toBe("ok")
    expect(view.particles!.status).toBe("ok")
    expect(view.recentStateDeltas!.status).toBe("ok")
  })

  it("部分降级：见面矩阵未知新版本 fail-loud → 只降见面维", async () => {
    routeNewSources({ "encounter-matrix.json": JSON.stringify({ fileVersion: 99, edges: [] }) })
    const view = await buildChapterPlan("/proj", 8, { povCharacter: "林动" })
    expect(view.encounter!.status).toBe("degraded")
    expect(view.encounter!.reason).toContain("见面矩阵")
    expect(view.cognition!.status).toBe("ok")
    expect(view.particles!.status).toBe("ok")
    expect(view.recentStateDeltas!.status).toBe("ok")
  })

  it("粒子 + 摘要同时不可用 → 两维 degraded 且两维 ok（逐维独立降级）", async () => {
    routeNewSources({
      "particle-ledger.json": JSON.stringify({ fileVersion: 99, entries: [] }),
      "chapter-summaries.json": JSON.stringify({ fileVersion: 99, entries: [] }),
    })
    const view = await buildChapterPlan("/proj", 8, { povCharacter: "林动" })
    expect(view.particles!.status).toBe("degraded")
    expect(view.recentStateDeltas!.status).toBe("degraded")
    expect(view.cognition!.status).toBe("ok")
    expect(view.encounter!.status).toBe("ok")
  })

  it("options 透传：逐维 topN + 字符预算在 IO 层同样生效", async () => {
    routeNewSources()
    const view = await buildChapterPlan("/proj", 8, {
      povCharacter: "林动",
      cognitionTopN: 1,
      dimensionCharBudget: 8,
    })
    expect(view.cognition!.items).toEqual(["黑市入口在城西"])
    expect(view.cognition!.truncated).toBe(true)
    expect(view.cognition!.text.length).toBeLessThanOrEqual(8)
  })

  it("cognition-state.json 缺失（合法 no-data）≠ 装载失败：POV 穿参后该维 ok 空", async () => {
    routeNewSources()
    fsMocks.readFile.mockImplementation((path: string) => {
      if (path.endsWith("cognition-state.json")) return Promise.resolve("")
      return undefined as unknown as Promise<string>
    })
    const view = await buildChapterPlan("/proj", 8, { povCharacter: "林动" })
    expect(view.cognition!.status).toBe("ok")
    expect(view.cognition!.items).toEqual([])
  })
})
