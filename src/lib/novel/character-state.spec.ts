import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  createDirectory: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
  createDirectory: fsMocks.createDirectory,
}))

import {
  characterStatesToContextText,
  createEmptyCharacterStateStore,
  loadCharacterStates,
  saveCharacterStates,
  type CharacterState,
  type CharacterStateStore,
} from "./character-state"

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
