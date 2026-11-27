import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  createDirectory: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      readFile: fsMocks.readFile,
      writeFileAtomic: fsMocks.writeFileAtomic,
      createDirectory: fsMocks.createDirectory,
    
  }
})

import {
  characterStatesToContextText,
  createEmptyCharacterStateStore,
  excludeDeadFromCast,
  loadCharacterStates,
  retainCharacterStates,
  saveCharacterStates,
  type CharacterState,
  type CharacterStateStore,
} from "./character-state"
import { applyStoreArrayFieldCaps } from "./projection-store"

function makeState(overrides: Partial<CharacterState> = {}): CharacterState {
  return {
    characterName: "林动",
    currentLocation: "青山镇",
    status: "健康",
    equipment: ["长剑"],
    abilities: ["武学"],
    relationships: {},
    lastUpdatedChapter: 3,
    lastUpdatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  }
}

describe("createEmptyCharacterStateStore", () => {
  it("returns an empty store with an ISO lastUpdated", () => {
    const store = createEmptyCharacterStateStore()
    expect(store.characters).toEqual([])
    expect(new Date(store.lastUpdated).toString()).not.toBe("Invalid Date")
  })
})

describe("saveCharacterStates", () => {
  beforeEach(() => {
    fsMocks.createDirectory.mockReset()
    fsMocks.writeFileAtomic.mockReset()
  })

  it("creates .novel and writes character-states.json atomically", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)
    const store: CharacterStateStore = { characters: [makeState()], lastUpdated: "t" }
    await saveCharacterStates("E:\\Novel", store)
    expect(fsMocks.createDirectory).toHaveBeenCalledWith("E:/Novel/.novel")
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      "E:/Novel/.novel/character-states.json",
      JSON.stringify(store, null, 2),
    )
  })
})

describe("loadCharacterStates", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
  })

  it("returns the parsed store for valid JSON", async () => {
    const store: CharacterStateStore = { characters: [makeState()], lastUpdated: "t" }
    fsMocks.readFile.mockResolvedValue(JSON.stringify(store))
    expect(await loadCharacterStates("/P")).toEqual(store)
  })

  it("returns an empty store for empty content", async () => {
    fsMocks.readFile.mockResolvedValue("")
    const store = await loadCharacterStates("/P")
    expect(store.characters).toEqual([])
  })

  it("returns an empty store for whitespace-only content", async () => {
    fsMocks.readFile.mockResolvedValue("   \n ")
    expect((await loadCharacterStates("/P")).characters).toEqual([])
  })

  it("throws a descriptive error for corrupt JSON", async () => {
    fsMocks.readFile.mockResolvedValue("{not json")
    await expect(loadCharacterStates("/P")).rejects.toThrow(/Failed to parse character-states\.json/)
  })

  it("stringifies non-Error parse failures (defensive String(err) path)", async () => {
    fsMocks.readFile.mockResolvedValue("{}")
    const parseSpy = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
      throw "boom"
    })
    try {
      await expect(loadCharacterStates("/P")).rejects.toThrow(/Failed to parse character-states\.json: boom/)
    } finally {
      parseSpy.mockRestore()
    }
  })

  it("returns an empty store when the file is missing (ENOENT)", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT: no such file"))
    expect((await loadCharacterStates("/P")).characters).toEqual([])
  })

  it("returns an empty store for other not-found messages", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("系统找不到指定的文件"))
    expect((await loadCharacterStates("/P")).characters).toEqual([])
  })

  it("rethrows unexpected errors", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("disk on fire"))
    await expect(loadCharacterStates("/P")).rejects.toThrow("disk on fire")
  })

  it("rethrows non-Error values as Error instances", async () => {
    fsMocks.readFile.mockRejectedValue("string error")
    await expect(loadCharacterStates("/P")).rejects.toThrow("string error")
  })
})

describe("characterStatesToContextText", () => {
  it("returns an empty string for an empty store", () => {
    expect(characterStatesToContextText(createEmptyCharacterStateStore())).toBe("")
  })

  it("renders character lines with equipment/ability fallbacks", () => {
    const store: CharacterStateStore = {
      characters: [
        makeState(),
        makeState({ characterName: "绫清竹", equipment: [], abilities: [], status: "重伤" }),
      ],
      lastUpdated: "t",
    }
    const text = characterStatesToContextText(store)
    expect(text).toContain("- 林动：位于青山镇，状态：健康，装备：长剑，能力：武学")
    expect(text).toContain("- 绫清竹：位于青山镇，状态：重伤，装备：无，能力：无")
  })
})

describe("excludeDeadFromCast", () => {
  it("excludes isAlive=false characters from cast", () => {
    const store: CharacterStateStore = {
      characters: [makeState({ characterName: "明成", isAlive: false, deathChapter: 2 }), makeState()],
      lastUpdated: "t",
    }
    expect(excludeDeadFromCast(["明成", "林动"], store)).toEqual({ alive: ["林动"], excluded: ["明成"] })
  })

  it("excludes by deathChapter even when isAlive is undefined", () => {
    const store: CharacterStateStore = {
      characters: [makeState({ characterName: "明成", deathChapter: 5 })],
      lastUpdated: "t",
    }
    expect(excludeDeadFromCast(["明成"], store)).toEqual({ alive: [], excluded: ["明成"] })
  })

  it("passes through a fully-alive cast untouched", () => {
    const store: CharacterStateStore = { characters: [makeState()], lastUpdated: "t" }
    expect(excludeDeadFromCast(["林动"], store)).toEqual({ alive: ["林动"], excluded: [] })
  })
})

describe("retainCharacterStates（百章级主角钉住与领域留存）", () => {
  it("恒定钉住索引 0 主角，按活跃度/丰富度/存活度排序并恢复原相对顺序", () => {
    const protagonist = makeState({
      characterName: "主角林动",
      lastUpdatedChapter: 1,
      lastSeenChapter: 1,
      equipment: [],
      abilities: [],
    })
    const oldMinor = makeState({
      characterName: "第一章路人",
      lastUpdatedChapter: 2,
      lastSeenChapter: 2,
      equipment: [],
      abilities: [],
      currentLocation: "",
      status: "",
    })
    const deadMid = makeState({
      characterName: "已死配角",
      lastUpdatedChapter: 50,
      lastSeenChapter: 50,
      equipment: [],
      abilities: [],
      isAlive: false,
      deathChapter: 50,
    })
    const aliveMid = makeState({
      characterName: "存活配角",
      lastUpdatedChapter: 50,
      lastSeenChapter: 50,
      equipment: [],
      abilities: [],
      isAlive: true,
    })
    const richMid = makeState({
      characterName: "核心配角",
      lastUpdatedChapter: 50,
      lastSeenChapter: 50,
      equipment: ["玄铁枪", "护心镜"],
      abilities: ["裂空掌"],
      relationships: { 主角林动: "挚友" },
    })
    const recentNpc = makeState({
      characterName: "百章新角",
      lastUpdatedChapter: 80,
      lastSeenChapter: 100,
    })

    const list = [protagonist, oldMinor, deadMid, aliveMid, richMid, recentNpc]
    const retained = retainCharacterStates(list, 4)

    // 保留主角(idx0) + recentNpc(recency 100) + richMid(recency 50, richness高) + aliveMid(recency 50, alive)
    // 严格恢复原相对顺序，且不修改原数组
    expect(retained.map((c) => c.characterName)).toEqual([
      "主角林动",
      "存活配角",
      "核心配角",
      "百章新角",
    ])
    expect(list).toHaveLength(6)
    expect(retainCharacterStates(list, 0)).toEqual([])
    expect(retainCharacterStates(list, 1).map((c) => c.characterName)).toEqual(["主角林动"])
    expect(retainCharacterStates(list, 10)).toHaveLength(6)
  })

  it("saveCharacterStates 超过 400 条上限时保留索引 0 主角并与 applyStoreArrayFieldCaps 同源", async () => {
    fsMocks.createDirectory.mockReset().mockResolvedValue(undefined)
    fsMocks.writeFileAtomic.mockReset().mockResolvedValue(undefined)

    const characters: CharacterState[] = [
      makeState({ characterName: "永不驱逐的主角", lastUpdatedChapter: 1, lastSeenChapter: 1 }),
      ...Array.from({ length: 420 }, (_, i) =>
        makeState({
          characterName: `配角-${i + 1}`,
          lastUpdatedChapter: i + 2,
          lastSeenChapter: i + 2,
        }),
      ),
    ]
    const input: CharacterStateStore = { characters, lastUpdated: "2026-11-27T00:00:00.000Z" }

    await saveCharacterStates("/Novel", input)
    const saved = JSON.parse(fsMocks.writeFileAtomic.mock.calls[0][1] as string) as CharacterStateStore
    expect(saved.characters).toHaveLength(400)
    expect(saved.characters[0].characterName).toBe("永不驱逐的主角")
    expect(saved.characters.some((c) => c.characterName === "配角-1")).toBe(false)
    expect(saved.characters.some((c) => c.characterName === "配角-420")).toBe(true)

    const replayed = applyStoreArrayFieldCaps("character-states.json", input)
    expect(replayed.characters.map((c) => c.characterName)).toEqual(
      saved.characters.map((c) => c.characterName),
    )
  })
})
