import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn(async (_p: string) => {}),
  writeFileAtomic: vi.fn(async (_p: string, _c: string) => {}),
  readFile: vi.fn(async (_p: string): Promise<string> => {
    throw new Error("ENOENT")
  }),
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: fsMocks.createDirectory,
  writeFileAtomic: fsMocks.writeFileAtomic,
  readFile: fsMocks.readFile,
}))

// character-aura-store dynamically imports the markdown module inside
// syncStoredCustomAuraFiles — mock it to avoid pulling the LLM chain.
const markdownMocks = vi.hoisted(() => ({
  storedCustomSkillMarkdown: vi.fn((aura: unknown) => `SKILL:${(aura as { name: string }).name}`),
  storedCustomResearchMarkdown: vi.fn((aura: unknown, file: string) => `RESEARCH:${(aura as { name: string }).name}:${file}`),
}))
vi.mock("./character-aura-markdown", () => markdownMocks)

import { BUILT_IN_CHARACTER_AURAS } from "./character-aura-builtin"
import {
  bindCharacterAura,
  createCustomCharacterAura,
  deleteCustomCharacterAura,
  getCharacterAuraBindings,
  listCharacterAuras,
  loadCharacterAuraStore,
  loadExistingResearchFiles,
  saveCharacterAuraStore,
  syncStoredCustomAuraFiles,
  unbindCharacterAura,
  updateCustomCharacterAura,
  type CharacterAura,
  type CharacterAuraStore,
} from "./character-aura-store"

const STORE_PATH = "/P/.qmai/character-aura.json"

beforeEach(() => {
  fsMocks.readFile.mockReset()
  fsMocks.readFile.mockRejectedValue(new Error("ENOENT"))
  fsMocks.writeFileAtomic.mockReset()
  fsMocks.writeFileAtomic.mockResolvedValue(undefined)
  fsMocks.createDirectory.mockReset()
  fsMocks.createDirectory.mockResolvedValue(undefined)
  markdownMocks.storedCustomSkillMarkdown.mockClear()
  markdownMocks.storedCustomResearchMarkdown.mockClear()
})

function auraInput(): Parameters<typeof createCustomCharacterAura>[1] {
  return {
    name: "林动",
    category: "主角",
    sourceNote: "note",
    corpus: "语料",
    styleDescription: "风格",
    behaviorRules: "规则",
    boundaries: "边界",
    notes: "备注",
  }
}

function customAura(id: string, name = "林动"): CharacterAura {
  return {
    id,
    builtIn: false,
    name,
    category: "主角",
    sourceNote: "note",
    corpus: "语料",
    styleDescription: "风格",
    behaviorRules: "规则",
    boundaries: "边界",
    notes: "备注",
    skillFolder: `/P/.qmai/character-auras/${id}-perspective`,
  }
}

function emptyStore(): CharacterAuraStore {
  return { customAuras: [], bindings: [] }
}

function seedStore(store: CharacterAuraStore): void {
  fsMocks.readFile.mockImplementation(async (path: string) => {
    if (path === STORE_PATH) return JSON.stringify(store)
    throw new Error("ENOENT")
  })
}

describe("loadCharacterAuraStore", () => {
  it("parses a valid store file", async () => {
    seedStore({ customAuras: [customAura("custom-1")], bindings: [{ characterName: "林动", auraId: "custom-1" }] })
    const store = await loadCharacterAuraStore("/P")
    expect(store.customAuras).toHaveLength(1)
    expect(store.bindings).toHaveLength(1)
  })

  it("falls back to empty arrays when parsed fields are not arrays", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ customAuras: "nope", bindings: 42 }))
    const store = await loadCharacterAuraStore("/P")
    expect(store).toEqual(emptyStore())
  })

  it("returns an empty store when the file is missing", async () => {
    expect(await loadCharacterAuraStore("/P")).toEqual(emptyStore())
  })

  it("returns an empty store on corrupt JSON", async () => {
    fsMocks.readFile.mockResolvedValue("{not json")
    expect(await loadCharacterAuraStore("/P")).toEqual(emptyStore())
  })
})

describe("saveCharacterAuraStore", () => {
  it("writes the store JSON at the store path", async () => {
    const store = emptyStore()
    await saveCharacterAuraStore("/P", store)
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(STORE_PATH, JSON.stringify(store, null, 2))
  })
})

describe("listCharacterAuras", () => {
  it("returns built-ins plus custom auras", async () => {
    seedStore({ customAuras: [customAura("custom-1")], bindings: [] })
    const auras = await listCharacterAuras("/P")
    expect(auras.length).toBe(BUILT_IN_CHARACTER_AURAS.length + 1)
    expect(auras[auras.length - 1].id).toBe("custom-1")
  })
})

describe("createCustomCharacterAura", () => {
  it("creates a custom aura, appends it to the store and persists", async () => {
    seedStore(emptyStore())
    const aura = await createCustomCharacterAura("/P", auraInput())
    expect(aura.id).toMatch(/^custom-\d+-[a-z0-9]{6}$/)
    expect(aura.builtIn).toBe(false)
    expect(aura.createdAt).toBe(aura.updatedAt)
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fsMocks.writeFileAtomic.mock.calls[0][1]) as CharacterAuraStore
    expect(body.customAuras).toHaveLength(1)
    expect(body.customAuras[0].id).toBe(aura.id)
  })
})

describe("updateCustomCharacterAura", () => {
  it("applies the patch and re-syncs stored skill files", async () => {
    seedStore({ customAuras: [customAura("custom-1")], bindings: [] })
    const updated = await updateCustomCharacterAura("/P", "custom-1", { name: "新名字" })
    expect(updated.name).toBe("新名字")
    expect(updated.builtIn).toBe(false)
    expect(fsMocks.createDirectory).toHaveBeenCalledWith("/P/.qmai/character-auras/custom-1-perspective")
    expect(fsMocks.createDirectory).toHaveBeenCalledWith(
      "/P/.qmai/character-auras/custom-1-perspective/references/research",
    )
    expect(markdownMocks.storedCustomSkillMarkdown).toHaveBeenCalled()
    // readFile for research files throws → 6 fallback research files written
    const researchWrites = fsMocks.writeFileAtomic.mock.calls.filter((c) =>
      (c[0] as string).includes("/references/research/"),
    )
    expect(researchWrites.map((c) => (c[0] as string).split("/").pop())).toEqual([
      "01-writings.md",
      "02-conversations.md",
      "03-expression-dna.md",
      "04-external-views.md",
      "05-decisions.md",
      "06-timeline.md",
    ])
  })

  it("throws when the aura id does not exist", async () => {
    seedStore(emptyStore())
    await expect(updateCustomCharacterAura("/P", "missing", { name: "x" })).rejects.toThrow("未找到自定义灵魂")
  })
})

describe("deleteCustomCharacterAura", () => {
  it("removes the aura and its bindings, then persists", async () => {
    seedStore({
      customAuras: [customAura("custom-1"), customAura("custom-2", "绫清竹")],
      bindings: [
        { characterName: "林动", auraId: "custom-1" },
        { characterName: "绫清竹", auraId: "custom-2" },
      ],
    })
    const store = await deleteCustomCharacterAura("/P", "custom-1")
    expect(store.customAuras.map((a) => a.id)).toEqual(["custom-2"])
    expect(store.bindings.map((b) => b.characterName)).toEqual(["绫清竹"])
    expect(fsMocks.writeFileAtomic).toHaveBeenCalled()
  })
})

describe("bindCharacterAura", () => {
  const hasProfile: (projectPath: string, characterName: string) => Promise<boolean> = async (_p, name) => name === "林动"

  it("throws when the aura id is invalid", async () => {
    seedStore(emptyStore())
    await expect(bindCharacterAura("/P", { characterName: "林动", auraId: "nope" }, hasProfile)).rejects.toThrow(
      "请选择有效的角色灵魂",
    )
  })

  it("throws when the character has no profile", async () => {
    seedStore(emptyStore())
    await expect(
      bindCharacterAura("/P", { characterName: "路人", auraId: BUILT_IN_CHARACTER_AURAS[0].id }, hasProfile),
    ).rejects.toThrow("请先在大纲中添加人物小传或人物设定，再绑定角色灵魂")
  })

  it("adds a binding for a new character", async () => {
    seedStore(emptyStore())
    const store = await bindCharacterAura(
      "/P",
      { characterName: " 林动 ", auraId: BUILT_IN_CHARACTER_AURAS[0].id },
      hasProfile,
    )
    expect(store.bindings).toEqual([{ characterName: "林动", auraId: BUILT_IN_CHARACTER_AURAS[0].id }])
  })

  it("replaces an existing binding for the same character", async () => {
    seedStore({
      customAuras: [],
      bindings: [{ characterName: "林动", auraId: BUILT_IN_CHARACTER_AURAS[0].id }],
    })
    const store = await bindCharacterAura(
      "/P",
      { characterName: "林动", auraId: BUILT_IN_CHARACTER_AURAS[1].id },
      hasProfile,
    )
    expect(store.bindings).toHaveLength(1)
    expect(store.bindings[0].auraId).toBe(BUILT_IN_CHARACTER_AURAS[1].id)
  })

  it("keeps other characters' bindings untouched while replacing one (map else branch)", async () => {
    seedStore({
      customAuras: [],
      bindings: [
        { characterName: "林动", auraId: BUILT_IN_CHARACTER_AURAS[0].id },
        { characterName: "绫清竹", auraId: "a3" },
      ],
    })
    const store = await bindCharacterAura(
      "/P",
      { characterName: "林动", auraId: BUILT_IN_CHARACTER_AURAS[1].id },
      hasProfile,
    )
    expect(store.bindings).toHaveLength(2)
    expect(store.bindings.find((b) => b.characterName === "林动")?.auraId).toBe(BUILT_IN_CHARACTER_AURAS[1].id)
    expect(store.bindings.find((b) => b.characterName === "绫清竹")?.auraId).toBe("a3")
  })
})

describe("unbindCharacterAura", () => {
  function storeWithTwoBindings(): CharacterAuraStore {
    return {
      customAuras: [],
      bindings: [
        { characterName: "林动", auraId: "a1" },
        { characterName: "林动", auraId: "a2" },
        { characterName: "绫清竹", auraId: "a3" },
      ],
    }
  }

  it("removes every binding for the character when no auraId is given", async () => {
    seedStore(storeWithTwoBindings())
    const store = await unbindCharacterAura("/P", "林动")
    expect(store.bindings.map((b) => b.characterName)).toEqual(["绫清竹"])
  })

  it("removes only the matching aura binding when auraId is given", async () => {
    seedStore(storeWithTwoBindings())
    const store = await unbindCharacterAura("/P", "林动", "a1")
    expect(store.bindings.map((b) => b.auraId)).toEqual(["a2", "a3"])
  })

  it("trims the character name before matching", async () => {
    seedStore(storeWithTwoBindings())
    const store = await unbindCharacterAura("/P", "  林动  ", "a1")
    expect(store.bindings.map((b) => b.auraId)).toEqual(["a2", "a3"])
  })
})

describe("getCharacterAuraBindings", () => {
  it("returns the stored bindings", async () => {
    seedStore({ customAuras: [], bindings: [{ characterName: "林动", auraId: "a1" }] })
    expect(await getCharacterAuraBindings("/P")).toEqual([{ characterName: "林动", auraId: "a1" }])
  })
})

describe("syncStoredCustomAuraFiles", () => {
  it("returns early when the aura has no skill folder", async () => {
    const aura = customAura("custom-1")
    delete aura.skillFolder
    await syncStoredCustomAuraFiles(aura)
    expect(fsMocks.createDirectory).not.toHaveBeenCalled()
  })

  it("writes SKILL.md and only missing research files", async () => {
    const aura = customAura("custom-1")
    // 01 exists with content, 02 exists with blank content, rest throw
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path.includes("01-writings.md")) return "# 已有内容"
      if (path.includes("02-conversations.md")) return "   "
      throw new Error("ENOENT")
    })
    await syncStoredCustomAuraFiles(aura)
    expect(fsMocks.createDirectory).toHaveBeenCalledWith(aura.skillFolder)
    expect(fsMocks.createDirectory).toHaveBeenCalledWith(`${aura.skillFolder}/references/research`)
    expect(markdownMocks.storedCustomSkillMarkdown).toHaveBeenCalledTimes(1)
    const researchWrites = fsMocks.writeFileAtomic.mock.calls.filter((c) =>
      (c[0] as string).includes("/references/research/"),
    )
    // 01 has content → skipped; 02 blank → not stored → written; 03-06 written
    expect(researchWrites.map((c) => (c[0] as string).split("/").pop())).toEqual([
      "02-conversations.md",
      "03-expression-dna.md",
      "04-external-views.md",
      "05-decisions.md",
      "06-timeline.md",
    ])
  })
})

describe("loadExistingResearchFiles", () => {
  it("collects non-blank research file contents and skips failures", async () => {
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path.includes("01-writings.md")) return "# a"
      if (path.includes("02-conversations.md")) return "   "
      throw new Error("ENOENT")
    })
    const files = await loadExistingResearchFiles("/P/skill")
    expect(Object.keys(files)).toEqual(["01-writings.md"])
    expect(files["01-writings.md"]).toBe("# a")
  })
})
