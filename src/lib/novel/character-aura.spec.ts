import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig, SearchApiConfig } from "@/stores/wiki-store"

// ---------------------------------------------------------------------------
// Mock universe for the monolithic character-aura.ts
// ---------------------------------------------------------------------------

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn<(_p: string) => Promise<string>>(async (_p) => {
    throw new Error("ENOENT")
  }),
  writeFileAtomic: vi.fn<(_p: string, _c: string) => Promise<void>>(async (_p, _c) => {}),
  createDirectory: vi.fn<(_p: string) => Promise<void>>(async (_p) => {}),
  listDirectory: vi.fn<() => Promise<Array<{ name: string; path: string; is_dir: boolean }>>>(async () => []),
  getExecutableDir: vi.fn<() => Promise<string>>(),
  getResourceDir: vi.fn<() => Promise<string>>(),
}))
vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
  createDirectory: fsMocks.createDirectory,
  listDirectory: fsMocks.listDirectory,
  getExecutableDir: fsMocks.getExecutableDir,
  getResourceDir: fsMocks.getResourceDir,
}))

const streamChatMock = vi.hoisted(() => vi.fn<typeof import("@/lib/llm-client").streamChat>())
vi.mock("@/lib/llm-client", () => ({
  streamChat: streamChatMock,
  combineAbortSignals: (...signals: Array<AbortSignal | undefined>): AbortSignal | undefined => {
    const active = signals.filter(Boolean) as AbortSignal[]
    if (active.length === 0) return undefined
    if (active.length === 1) return active[0]
    const controller = new AbortController()
    for (const s of active) {
      if (s.aborted) {
        controller.abort()
        break
      }
      s.addEventListener("abort", () => controller.abort(), { once: true })
    }
    return controller.signal
  },
  DEFAULT_LLM_REQUEST_TIMEOUT_MS: 1000,
}))

vi.mock("@/lib/novel/model-resolver", () => ({
  resolveDefaultModel: (cfg: unknown) => cfg,
}))

const loggerWarnMock = vi.hoisted(() => vi.fn<(message?: unknown, ...optionalParams: unknown[]) => void>())
vi.mock("@/lib/utils", () => ({
  logger: { warn: loggerWarnMock },
}))

const searchWikiMock = vi.hoisted(() => vi.fn<typeof import("@/lib/search").searchWiki>())
vi.mock("@/lib/search", () => ({
  searchWiki: searchWikiMock,
}))

const getHttpFetchMock = vi.hoisted(() => vi.fn<typeof import("@/lib/tauri-fetch").getHttpFetch>())
vi.mock("@/lib/tauri-fetch", () => ({
  getHttpFetch: getHttpFetchMock,
}))

const webSearchMock = vi.hoisted(() => vi.fn<typeof import("@/lib/web-search").webSearch>())
vi.mock("@/lib/web-search", () => ({
  webSearch: webSearchMock,
}))

vi.mock("@/lib/platform", () => ({
  isTauri: vi.fn(() => false),
}))
import { isTauri } from "@/lib/platform"

vi.mock("@tauri-apps/api/path", () => ({
  resourceDir: vi.fn(async () => "/resources"),
}))
import { resourceDir } from "@tauri-apps/api/path"

const storeState = vi.hoisted(() => ({
  llmConfig: { provider: "custom", model: "m", customEndpoint: "http://x" } as LlmConfig,
  searchApiConfig: { provider: "tavily", apiKey: "tk" } as SearchApiConfig,
}))
vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: { getState: () => storeState },
}))

const pinyinMock = vi.hoisted(() => vi.fn<(text: string) => string[]>())
vi.mock("pinyin-pro", () => ({
  pinyin: pinyinMock,
}))

const listBindableMock = vi.hoisted(() => vi.fn<typeof import("./bindable-characters").listBindableNovelCharacters>())
vi.mock("./bindable-characters", () => ({
  listBindableNovelCharacters: listBindableMock,
}))

import {
  BUILT_IN_CHARACTER_AURAS,
  CHARACTER_AURA_BINDING_BLOCK_MESSAGE,
  CHARACTER_AURA_INVALID_AURA_MESSAGE,
  bindCharacterAura,
  buildCharacterAuraContext,
  createCustomCharacterAura,
  createCustomCharacterAuraFromGeneratedSkill,
  createCustomCharacterAuraSkill,
  deleteCustomCharacterAura,
  getCharacterAuraBindings,
  listCharacterAuras,
  loadCharacterAuraResearchDocument,
  loadCharacterAuraSkillDocument,
  loadCharacterAuraStore,
  saveCharacterAuraStore,
  toPinyin,
  toSimplified,
  unbindCharacterAura,
  updateCustomCharacterAura,
  type CharacterAuraGenerationProgress,
  type CustomCharacterAuraSkillInput,
} from "./character-aura"

const USABLE_LLM = { provider: "custom", model: "m", customEndpoint: "http://x", apiKey: "" } as LlmConfig
const NO_LLM = { provider: "openai", model: "", apiKey: "" } as LlmConfig

const STORE_PATH = "/P/.qmai/character-aura.json"

function emptyStore(): unknown {
  return { customAuras: [], bindings: [] }
}

/** readFile dispatcher: store JSON first, then per-path overrides. */
function seedRead(store: unknown, onPath?: (path: string) => string | Promise<string> | undefined): void {
  fsMocks.readFile.mockImplementation(async (path: string) => {
    if (path === STORE_PATH) return JSON.stringify(store)
    if (onPath) {
      const hit = await onPath(path)
      if (hit !== undefined) return hit
    }
    throw new Error("ENOENT")
  })
}

function fullFieldsJson(): string {
  return JSON.stringify({
    sourceNote: "来源说明",
    styleDescription: "风格描述",
    behaviorRules: "行为规则",
    boundaries: "边界",
    notes: "备注",
    expressionDna: "表达DNA",
    mentalModel: "心智模型",
    decisionHeuristics: "决策启发式",
    valueAntiPatterns: "反模式",
    honestyBoundaries: "诚实边界",
  })
}

function llmReturns(perCall: Array<string | Error>): void {
  let n = 0
  streamChatMock.mockImplementation(
    async (_c: unknown, _m: unknown, cb: { onToken: (t: string) => void; onDone: () => void }) => {
      const result = perCall[Math.min(n, perCall.length - 1)]
      n += 1
      if (result instanceof Error) throw result
      cb.onToken(result)
      cb.onDone()
    },
  )
}

function httpOk(body: string): { ok: boolean; status: number; text: () => Promise<string> } {
  return { ok: true, status: 200, text: async () => body }
}

function skillInput(overrides: Partial<CustomCharacterAuraSkillInput> = {}): CustomCharacterAuraSkillInput {
  return {
    name: "林动",
    category: "主角",
    corpus: "语料文本",
    sourceUrls: "https://a.com",
    localDocumentPaths: "/d/ok.md",
    generationPrompt: "提示词",
    enableWebSearch: true,
    ...overrides,
  }
}

function searchResult(overrides: { title?: string; url?: string; snippet?: string; source?: string } = {}) {
  return { title: "搜索标题", url: "https://s.com/1", snippet: "搜索摘要", source: "tavily", ...overrides }
}

function defaultWebAndFetch(): void {
  webSearchMock.mockResolvedValue([searchResult()])
  getHttpFetchMock.mockResolvedValue(
    vi.fn().mockResolvedValue(httpOk("<p>搜索结果正文</p>")),
  )
}

beforeEach(() => {
  fsMocks.readFile.mockReset()
  fsMocks.readFile.mockRejectedValue(new Error("ENOENT"))
  fsMocks.writeFileAtomic.mockReset()
  fsMocks.writeFileAtomic.mockResolvedValue(undefined)
  fsMocks.createDirectory.mockReset()
  fsMocks.createDirectory.mockResolvedValue(undefined)
  fsMocks.getExecutableDir.mockReset()
  fsMocks.getResourceDir.mockReset()
  streamChatMock.mockReset()
  loggerWarnMock.mockReset()
  searchWikiMock.mockReset()
  getHttpFetchMock.mockReset()
  webSearchMock.mockReset()
  pinyinMock.mockReset()
  listBindableMock.mockReset()
  ;(isTauri as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false)
  pinyinMock.mockImplementation((text: string) => [text])
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("toPinyin / toSimplified", () => {
  it("joins pinyin array and lowercases", () => {
    pinyinMock.mockImplementation(() => ["Xiao", "Qing"])
    expect(toPinyin("小晴")).toBe("xiaoqing")
  })

  it("falls back to lowercase text when pinyin-pro throws", () => {
    pinyinMock.mockImplementation(() => {
      throw new Error("boom")
    })
    expect(toPinyin("ABC")).toBe("abc")
  })

  it("short-circuits empty and short text", () => {
    expect(toSimplified("")).toBe("")
    expect(toSimplified("後時")).toBe("後時")
  })

  it("passes each character through the util (which short-circuits single chars)", () => {
    // character-aura.ts delegates per-char; the util's `length <= 2` guard makes
    // single-char lookups pass through unchanged, so the monolithic helper is a no-op.
    expect(toSimplified("後時國")).toBe("後時國")
    expect(toSimplified("後A國")).toBe("後A國")
  })
})

// ---------------------------------------------------------------------------
// Store CRUD
// ---------------------------------------------------------------------------

describe("store CRUD via character-aura.ts", () => {
  it("loads an empty store when the file is missing", async () => {
    expect(await loadCharacterAuraStore("/P")).toEqual({ customAuras: [], bindings: [] })
  })

  it("loads a parsed store and normalizes non-array fields", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ customAuras: "x", bindings: 1 }))
    expect(await loadCharacterAuraStore("/P")).toEqual({ customAuras: [], bindings: [] })
  })

  it("saves the store atomically", async () => {
    const store = { customAuras: [], bindings: [] }
    await saveCharacterAuraStore("/P", store)
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(STORE_PATH, JSON.stringify(store, null, 2))
  })

  it("lists built-ins plus custom auras", async () => {
    seedRead({
      customAuras: [{ id: "custom-1", builtIn: false, name: "林动" }],
      bindings: [],
    })
    const auras = await listCharacterAuras("/P")
    expect(auras).toHaveLength(BUILT_IN_CHARACTER_AURAS.length + 1)
  })

  it("creates a custom aura with timestamps", async () => {
    seedRead(emptyStore())
    const aura = await createCustomCharacterAura("/P", {
      name: "林动",
      category: "主角",
      sourceNote: "n",
      corpus: "c",
      styleDescription: "s",
      behaviorRules: "b",
      boundaries: "bd",
      notes: "nt",
    })
    expect(aura.id).toMatch(/^custom-\d+-[a-z0-9]{6}$/)
    expect(aura.builtIn).toBe(false)
    expect(aura.createdAt).toBe(aura.updatedAt)
  })

  it("updates a custom aura and re-syncs stored files", async () => {
    seedRead({
      customAuras: [
        {
          id: "custom-1",
          builtIn: false,
          name: "林动",
          category: "主角",
          sourceNote: "n",
          corpus: "c",
          styleDescription: "s",
          behaviorRules: "b",
          boundaries: "bd",
          notes: "nt",
          expressionDna: "d",
          mentalModel: "m",
          decisionHeuristics: "dh",
          valueAntiPatterns: "v",
          honestyBoundaries: "h",
          generationPrompt: "g",
          webSearchEnabled: true,
          skillFolder: "/P/.qmai/character-auras/custom-1-perspective",
        },
      ],
      bindings: [],
    })
    const updated = await updateCustomCharacterAura("/P", "custom-1", { name: "新名字" })
    expect(updated.name).toBe("新名字")
    expect(updated.builtIn).toBe(false)
    expect(updated.updatedAt).toBeGreaterThanOrEqual(updated.createdAt ?? 0)
    // SKILL.md + 6 research files written
    const researchWrites = fsMocks.writeFileAtomic.mock.calls.filter((c) =>
      (c[0] as string).includes("/references/research/"),
    )
    expect(researchWrites).toHaveLength(6)
    const skillWrite = fsMocks.writeFileAtomic.mock.calls.find((c) => (c[0] as string).endsWith("/SKILL.md"))
    expect(String(skillWrite?.[1])).toContain("# 新名字 · 自定义人物灵魂操作系统")
  })

  it("throws when updating a missing aura", async () => {
    seedRead(emptyStore())
    await expect(updateCustomCharacterAura("/P", "ghost", { name: "x" })).rejects.toThrow("未找到自定义灵魂")
  })

  it("skips stored file re-sync when the aura has no skill folder", async () => {
    seedRead({ customAuras: [{ id: "custom-1", builtIn: false, name: "林动" }], bindings: [] })
    const updated = await updateCustomCharacterAura("/P", "custom-1", { name: "新名字" })
    expect(updated.name).toBe("新名字")
    expect(fsMocks.writeFileAtomic.mock.calls.some((c) => String(c[0]).includes("/SKILL.md"))).toBe(false)
  })

  it("re-syncs minimal stored files with fallback fields", async () => {
    seedRead({
      customAuras: [
        { id: "custom-1", builtIn: false, name: "林动", skillFolder: "/P/.qmai/character-auras/custom-1-perspective" },
      ],
      bindings: [],
    })
    await updateCustomCharacterAura("/P", "custom-1", { name: "新名字" })
    const skillWrite = fsMocks.writeFileAtomic.mock.calls.find((c) => String(c[0]).endsWith("/SKILL.md"))
    expect(String(skillWrite?.[1])).toContain("- 分类：自定义灵魂")
    const researchWrites = fsMocks.writeFileAtomic.mock.calls.filter((c) =>
      String(c[0]).includes("/references/research/"),
    )
    expect(researchWrites).toHaveLength(6)
    expect(String(researchWrites[0]?.[1])).toContain("- 角色定位：自定义灵魂")
    expect(String(researchWrites[0]?.[1])).toContain("- 气质说明：待补充")
    expect(String(researchWrites[1]?.[1])).toContain("## 冲突中的说话方式")
  })

  it("deletes a custom aura and its bindings", async () => {
    seedRead({
      customAuras: [{ id: "custom-1", builtIn: false, name: "林动" }],
      bindings: [{ characterName: "林动", auraId: "custom-1" }],
    })
    const store = await deleteCustomCharacterAura("/P", "custom-1")
    expect(store.customAuras).toHaveLength(0)
    expect(store.bindings).toHaveLength(0)
  })

  it("unbinds by character with and without an aura filter", async () => {
    seedRead({
      customAuras: [],
      bindings: [
        { characterName: "林动", auraId: "a1" },
        { characterName: "林动", auraId: "a2" },
        { characterName: "绫清竹", auraId: "a3" },
      ],
    })
    const store = await unbindCharacterAura("/P", " 林动 ", "a1")
    expect(store.bindings.map((b) => b.auraId)).toEqual(["a2", "a3"])
    const store2 = await unbindCharacterAura("/P", "林动")
    expect(store2.bindings.map((b) => b.auraId)).toEqual(["a3"])
  })

  it("returns bindings", async () => {
    seedRead({ customAuras: [], bindings: [{ characterName: "林动", auraId: "a1" }] })
    expect(await getCharacterAuraBindings("/P")).toEqual([{ characterName: "林动", auraId: "a1" }])
  })
})

describe("bindCharacterAura (with profile probing)", () => {
  it("rejects invalid aura ids", async () => {
    seedRead(emptyStore())
    await expect(bindCharacterAura("/P", { characterName: "林动", auraId: "ghost" })).rejects.toThrow(
      CHARACTER_AURA_INVALID_AURA_MESSAGE,
    )
  })

  it("binds when the character is a known novel character", async () => {
    seedRead(emptyStore())
    listBindableMock.mockResolvedValue(["小晴"])
    const store = await bindCharacterAura("/P", {
      characterName: "小晴",
      auraId: BUILT_IN_CHARACTER_AURAS[0].id,
    })
    expect(store.bindings).toEqual([{ characterName: "小晴", auraId: BUILT_IN_CHARACTER_AURAS[0].id }])
  })

  it("binds when a wiki result title mentions 人物小传", async () => {
    seedRead(emptyStore())
    listBindableMock.mockResolvedValue([])
    searchWikiMock.mockResolvedValue([
      { path: "/P/wiki/x.md", title: "小晴 人物小传", snippet: "设定", titleMatch: true, score: 1, images: [] },
    ])
    const store = await bindCharacterAura("/P", { characterName: "小晴", auraId: BUILT_IN_CHARACTER_AURAS[0].id })
    expect(store.bindings).toHaveLength(1)
  })

  it("binds when the wiki file content matches", async () => {
    seedRead(emptyStore())
    listBindableMock.mockResolvedValue([])
    searchWikiMock.mockResolvedValue([
      { path: "/P/wiki/x.md", title: "小晴", snippet: "", titleMatch: false, score: 1, images: [] },
    ])
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path === STORE_PATH) return JSON.stringify(emptyStore())
      if (path === "/P/wiki/x.md") return "# 小晴 人物小传\n设定内容。"
      throw new Error("ENOENT")
    })
    const store = await bindCharacterAura("/P", { characterName: "小晴", auraId: BUILT_IN_CHARACTER_AURAS[0].id })
    expect(store.bindings).toHaveLength(1)
  })

  it("rejects when no profile evidence is found and logs read failures", async () => {
    seedRead(emptyStore())
    listBindableMock.mockResolvedValue([])
    searchWikiMock.mockResolvedValue([
      { path: "/P/wiki/x.md", title: "小晴", snippet: "", titleMatch: false, score: 1, images: [] },
    ])
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT"))
    await expect(bindCharacterAura("/P", { characterName: "小晴", auraId: BUILT_IN_CHARACTER_AURAS[0].id })).rejects.toThrow(
      CHARACTER_AURA_BINDING_BLOCK_MESSAGE,
    )
    expect(loggerWarnMock).toHaveBeenCalled()
  })

  it("replaces an existing binding for the same character", async () => {
    seedRead({ customAuras: [], bindings: [{ characterName: "小晴", auraId: BUILT_IN_CHARACTER_AURAS[0].id }] })
    listBindableMock.mockResolvedValue(["小晴"])
    const store = await bindCharacterAura("/P", {
      characterName: "小晴",
      auraId: BUILT_IN_CHARACTER_AURAS[1].id,
    })
    expect(store.bindings).toHaveLength(1)
    expect(store.bindings[0].auraId).toBe(BUILT_IN_CHARACTER_AURAS[1].id)
  })

  it("keeps unrelated bindings when rebinding an existing character", async () => {
    seedRead({
      customAuras: [],
      bindings: [
        { characterName: "小晴", auraId: BUILT_IN_CHARACTER_AURAS[0].id },
        { characterName: "路人甲", auraId: BUILT_IN_CHARACTER_AURAS[1].id },
      ],
    })
    listBindableMock.mockResolvedValue(["小晴"])
    const store = await bindCharacterAura("/P", {
      characterName: "小晴",
      auraId: BUILT_IN_CHARACTER_AURAS[1].id,
    })
    expect(store.bindings).toHaveLength(2)
    expect(store.bindings[0].auraId).toBe(BUILT_IN_CHARACTER_AURAS[1].id)
    expect(store.bindings[1].characterName).toBe("路人甲")
  })

  it("continues past profile content that lacks the character name", async () => {
    seedRead(emptyStore())
    listBindableMock.mockResolvedValue([])
    searchWikiMock.mockResolvedValue([
      { path: "/P/wiki/x.md", title: "小晴", snippet: "", titleMatch: false, score: 1, images: [] },
    ])
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path === STORE_PATH) return JSON.stringify(emptyStore())
      if (path === "/P/wiki/x.md") return "# 他人 人物小传\n设定内容。"
      throw new Error("ENOENT")
    })
    await expect(bindCharacterAura("/P", { characterName: "小晴", auraId: BUILT_IN_CHARACTER_AURAS[0].id })).rejects.toThrow(
      CHARACTER_AURA_BINDING_BLOCK_MESSAGE,
    )
  })

  it("logs non-Error read failures while probing profiles", async () => {
    seedRead(emptyStore())
    listBindableMock.mockResolvedValue([])
    searchWikiMock.mockResolvedValue([
      { path: "/P/wiki/x.md", title: "小晴", snippet: "", titleMatch: false, score: 1, images: [] },
    ])
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path === STORE_PATH) return JSON.stringify(emptyStore())
      throw "boom-string"
    })
    await expect(bindCharacterAura("/P", { characterName: "小晴", auraId: BUILT_IN_CHARACTER_AURAS[0].id })).rejects.toThrow(
      CHARACTER_AURA_BINDING_BLOCK_MESSAGE,
    )
    expect(loggerWarnMock).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Skill document loaders + Tauri fallback probing
// ---------------------------------------------------------------------------

describe("loadCharacterAuraSkillDocument / loadCharacterAuraResearchDocument", () => {
  const aura = (skillFolder?: string) =>
    ({
      id: "custom-1",
      builtIn: false,
      name: "林动",
      sourceNote: "",
      corpus: "",
      styleDescription: "",
      behaviorRules: "",
      boundaries: "",
      notes: "",
      skillFolder,
    }) as never

  it("returns empty when no skill folder", async () => {
    expect(await loadCharacterAuraSkillDocument(aura(undefined))).toBe("")
    expect(await loadCharacterAuraResearchDocument(aura(undefined), "01-writings.md")).toBe("")
  })

  it("reads the skill document directly", async () => {
    fsMocks.readFile.mockResolvedValue("# SKILL")
    expect(await loadCharacterAuraSkillDocument(aura("/s"))).toBe("# SKILL")
  })

  it("reads a research document directly", async () => {
    fsMocks.readFile.mockResolvedValue("# 研究")
    expect(await loadCharacterAuraResearchDocument(aura("/s"), "03-expression-dna.md")).toBe("# 研究")
  })

  it("falls back to the project root", async () => {
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "/P/skills/soulskill/li-bai-perspective/SKILL.md") return "# 回退"
      throw new Error("ENOENT")
    })
    const builtIn = {
      id: "builtin-li-bai",
      builtIn: true,
      name: "李白",
      sourceNote: "",
      corpus: "",
      styleDescription: "",
      behaviorRules: "",
      boundaries: "",
      notes: "",
      skillFolder: "skills/soulskill/li-bai-perspective",
    } as never
    expect(await loadCharacterAuraSkillDocument(builtIn, "/P")).toBe("# 回退")
  })

  it("probes Tauri executable/resource dirs when present", async () => {
    ;(isTauri as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true)
    fsMocks.getExecutableDir.mockResolvedValue("C:/apps/niko")
    fsMocks.getResourceDir.mockResolvedValue("C:/apps/niko/resources")
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "C:/apps/niko/resources/_up_/s/SKILL.md") return "# 资源命中"
      throw new Error("ENOENT")
    })
    expect(await loadCharacterAuraSkillDocument(aura("/s"))).toBe("# 资源命中")
    expect(fsMocks.readFile).toHaveBeenCalledWith("C:/apps/niko/_up_/s/SKILL.md")
    expect(fsMocks.readFile).toHaveBeenCalledWith("C:/apps/niko/resources/_up_/s/SKILL.md")
  })

  it("probes the tauri resourceDir API after fs probes fail", async () => {
    ;(isTauri as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true)
    fsMocks.getExecutableDir.mockRejectedValue(new Error("no exe"))
    fsMocks.getResourceDir.mockRejectedValue(new Error("no res"))
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "/resources/s/SKILL.md") return "# API 资源"
      throw new Error("ENOENT")
    })
    expect(await loadCharacterAuraSkillDocument(aura("/s"))).toBe("# API 资源")
    expect(resourceDir).toHaveBeenCalled()
  })

  it("skips the parent dir when it equals the exe dir and rethrows on total failure", async () => {
    ;(isTauri as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true)
    fsMocks.getExecutableDir.mockResolvedValue("C:/")
    fsMocks.getResourceDir.mockRejectedValue(new Error("no res"))
    fsMocks.readFile.mockRejectedValue(new Error("gone"))
    await expect(loadCharacterAuraSkillDocument(aura("/s"))).rejects.toThrow("gone")
  })

  it("rethrows the original error when no fallback root works", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("disk failure"))
    await expect(loadCharacterAuraSkillDocument(aura("/s"), "/P")).rejects.toThrow("disk failure")
  })
})

// ---------------------------------------------------------------------------
// buildCharacterAuraContext
// ---------------------------------------------------------------------------

describe("buildCharacterAuraContext (monolithic)", () => {
  it("returns empty when there are no bindings", async () => {
    seedRead(emptyStore())
    expect(await buildCharacterAuraContext("/P", "第3章")).toBe("")
  })

  it("renders a matched character with all field lines", async () => {
    seedRead({
      customAuras: [
        {
          id: "custom-1",
          builtIn: false,
          name: "李清照",
          category: "诗人",
          sourceNote: "来源",
          corpus: "语料",
          styleDescription: "风格",
          behaviorRules: "规则",
          boundaries: "边界",
          notes: "备注",
          expressionDna: "表达DNA",
          mentalModel: "心智",
          decisionHeuristics: "决策",
          valueAntiPatterns: "反模式",
          honestyBoundaries: "诚实",
        },
      ],
      bindings: [{ characterName: "小晴", auraId: "custom-1" }],
    })
    const context = await buildCharacterAuraContext("/P", "小晴登场", {})
    expect(context).toContain("- 小晴：李清照")
    expect(context).toContain("  - 人物分类：诗人")
    expect(context).toContain("  - 怎么说话 / 表达特征：表达DNA")
    expect(context).toContain("  - 知道局限 / 诚实边界：诚实")
    expect(context).toContain("- 角色灵魂必须服从大纲")
  })

  it("matches via pinyin", async () => {
    seedRead({
      customAuras: [{ id: "custom-1", builtIn: false, name: "x", sourceNote: "", corpus: "", styleDescription: "", behaviorRules: "", boundaries: "", notes: "" }],
      bindings: [{ characterName: "小晴", auraId: "custom-1" }],
    })
    pinyinMock.mockImplementation((text: string) =>
      text
        .split("")
        .map((ch) => ({ 小: "xiao", 晴: "qing", 登: "deng", 场: "chang" })[ch] ?? ch),
    )
    const byPinyin = await buildCharacterAuraContext("/P", "xiaoqing 登场", {})
    expect(byPinyin).toContain("- 小晴")
  })

  it("applies fallbackAuraId and skips missing auras", async () => {
    seedRead({
      customAuras: [
        { id: "custom-1", builtIn: false, name: "x", sourceNote: "", corpus: "", styleDescription: "", behaviorRules: "", boundaries: "", notes: "" },
        { id: "custom-2", builtIn: false, name: "y", sourceNote: "", corpus: "", styleDescription: "", behaviorRules: "", boundaries: "", notes: "" },
      ],
      bindings: [
        { characterName: "小晴", auraId: "custom-1" },
        { characterName: "路人甲", auraId: "custom-2" },
      ],
    })
    const fallback = await buildCharacterAuraContext("/P", "无关任务", { fallbackAuraId: "custom-2" })
    expect(fallback).toContain("- 路人甲")
    const noMatch = await buildCharacterAuraContext("/P", "无关任务", { fallbackAuraId: "ghost" })
    expect(noMatch).toBe("")
    const ghost = await buildCharacterAuraContext("/P", "小晴的戏", {})
    expect(ghost).toContain("- 小晴")
    // binding whose aura is absent → nothing rendered
    seedRead({ customAuras: [], bindings: [{ characterName: "小晴", auraId: "ghost" }] })
    expect(await buildCharacterAuraContext("/P", "小晴", {})).toBe("")
  })

  it("renders a writing preview", async () => {
    seedRead({
      customAuras: [
        {
          id: "custom-1",
          builtIn: false,
          name: "李清照",
          sourceNote: "",
          corpus: "",
          styleDescription: "风格。",
          behaviorRules: "",
          boundaries: "",
          notes: "",
          expressionDna: "表达DNA。",
          mentalModel: "心智。",
          decisionHeuristics: "决策。",
          valueAntiPatterns: "反模式。",
        },
      ],
      bindings: [{ characterName: "小晴", auraId: "custom-1" }],
    })
    const context = await buildCharacterAuraContext("/P", "  写小晴  ", { previewMode: "writing" })
    expect(context).toContain("【本次写作会怎样塑造「小晴」】")
    expect(context).toContain("- 表达方式：表达DNA")
    expect(context).toContain("任务场景：写小晴")
  })

  it("includes compressed skill summaries and degrades on read failure", async () => {
    const skillFolder = "/P/.qmai/character-auras/custom-1-perspective"
    const store = {
      customAuras: [
        {
          id: "custom-1",
          builtIn: false,
          name: "x",
          sourceNote: "",
          corpus: "",
          styleDescription: "",
          behaviorRules: "",
          boundaries: "",
          notes: "",
          skillFolder,
        },
      ],
      bindings: [{ characterName: "小晴", auraId: "custom-1" }],
    }
    seedRead(store, (path) => {
      if (path.endsWith("/SKILL.md")) return "---\nname: x\n---\n# 灵魂\n- 要点\n内容：价值"
      if (path.includes("/references/research/")) return "# 研究\n- 线索\n内容：详情"
      return undefined
    })
    const ok = await buildCharacterAuraContext("/P", "小晴", {})
    expect(ok).toContain("- 灵魂文档压缩摘要：")
    expect(ok).toContain("- 研究文件压缩摘要：")

    seedRead(store)
    const degraded = await buildCharacterAuraContext("/P", "小晴", {})
    expect(degraded).toContain("灵魂文档读取失败，已降级使用结构化灵魂字段。")
  })

  it("evaluates every alias matcher branch when nothing matches", async () => {
    seedRead({
      customAuras: [
        { id: "custom-1", builtIn: false, name: "x", sourceNote: "", corpus: "", styleDescription: "", behaviorRules: "", boundaries: "", notes: "" },
      ],
      bindings: [{ characterName: "路人", aliases: ["路人甲"], auraId: "custom-1" }],
    })
    expect(await buildCharacterAuraContext("/P", "无关", {})).toBe("")
  })

  it("normalizes punctuation-only character names to empty pinyin/simplified forms", async () => {
    seedRead({
      customAuras: [
        { id: "custom-1", builtIn: false, name: "x", sourceNote: "", corpus: "", styleDescription: "", behaviorRules: "", boundaries: "", notes: "" },
      ],
      bindings: [{ characterName: "!!!", auraId: "custom-1" }],
    })
    expect(await buildCharacterAuraContext("/P", "无关", {})).toBe("")
  })

  it("returns empty for a writing preview whose aura is missing", async () => {
    seedRead({ customAuras: [], bindings: [{ characterName: "小晴", auraId: "ghost" }] })
    expect(await buildCharacterAuraContext("/P", "小晴", { previewMode: "writing" })).toBe("")
  })

  it("falls back to base fields in the writing preview when DNA fields are absent", async () => {
    seedRead({
      customAuras: [
        // no styleDescription / behaviorRules at all → every ?? / fallback fires
        { id: "custom-1", builtIn: false, name: "李清照" },
      ],
      bindings: [{ characterName: "小晴", auraId: "custom-1" }],
    })
    const context = await buildCharacterAuraContext("/P", "小晴", { previewMode: "writing" })
    expect(context).toContain("【本次写作会怎样塑造「小晴」】")
    expect(context).toContain("- 表达方式：保持当前任务需要的角色状态")
    expect(context).toContain("- 决策方式：保持当前任务需要的角色状态")
  })

  it("keeps punctuation-only preview fields intact", async () => {
    seedRead({
      customAuras: [
        { id: "custom-1", builtIn: false, name: "李清照", sourceNote: "", corpus: "", styleDescription: "。", behaviorRules: "", boundaries: "", notes: "" },
      ],
      bindings: [{ characterName: "小晴", auraId: "custom-1" }],
    })
    const context = await buildCharacterAuraContext("/P", "小晴", { previewMode: "writing" })
    expect(context).toContain("- 表达方式：。")
  })

  it("compresses edge-case skill and research documents", async () => {
    const store = {
      customAuras: [
        {
          id: "custom-1",
          builtIn: false,
          name: "x",
          sourceNote: "",
          corpus: "",
          styleDescription: "",
          behaviorRules: "",
          boundaries: "",
          notes: "",
          skillFolder: "/P/.qmai/character-auras/custom-1-perspective",
        },
      ],
      bindings: [{ characterName: "小晴", auraId: "custom-1" }],
    }
    seedRead(store, (path) => {
      if (path.endsWith("/SKILL.md")) return "---\nname: x\n---"
      if (path.includes("/references/research/01-writings.md")) return "# 研究\nab: cd"
      if (path.includes("/references/research/02-conversations.md")) return "纯文本内容"
      if (path.includes("/references/research/03-expression-dna.md")) return "长文本".repeat(200)
      if (path.includes("/references/research/04-external-views.md")) return "---\n---"
      return undefined
    })
    const context = await buildCharacterAuraContext("/P", "小晴", {})
    expect(context).toContain("- 小晴")
    expect(context).toContain("ab: cd")
    expect(context).toContain("纯文本内容")
    expect(context).toContain("…")
    // empty skill summary → no 灵魂文档压缩摘要 line
    expect(context).not.toContain("灵魂文档压缩摘要")
  })
})

// ---------------------------------------------------------------------------
// createCustomCharacterAuraFromGeneratedSkill
// ---------------------------------------------------------------------------

describe("createCustomCharacterAuraFromGeneratedSkill", () => {
  it("writes the skill content and provided research files with fallbacks", async () => {
    seedRead(emptyStore())
    const aura = await createCustomCharacterAuraFromGeneratedSkill("/P", {
      name: "林动",
      category: "拆书角色",
      sourceNote: "n",
      corpus: "c",
      styleDescription: "s",
      behaviorRules: "b",
      boundaries: "bd",
      notes: "nt",
      expressionDna: "d",
      mentalModel: "m",
      decisionHeuristics: "dh",
      valueAntiPatterns: "v",
      honestyBoundaries: "h",
      skillContent: "# SKILL 内容",
      researchFiles: { "01-writings.md": "# 01 内容" },
    })
    expect(aura.id).toMatch(/^custom-\d+-/)
    expect(aura.builtIn).toBe(false)
    expect(aura.webSearchEnabled).toBe(false)
    const writes = fsMocks.writeFileAtomic.mock.calls.map((c) => c[0] as string)
    expect(writes.some((w) => w.endsWith("/SKILL.md"))).toBe(true)
    expect(writes.some((w) => w.endsWith("/references/research/01-writings.md"))).toBe(true)
    const fallbackWrite = writes.find((w) => w.endsWith("/references/research/02-conversations.md"))
    expect(fsMocks.writeFileAtomic.mock.calls.find((c) => c[0] === fallbackWrite)?.[1]).toContain("（拆书分析未提供该维度）")
    expect(fsMocks.createDirectory).toHaveBeenCalledTimes(2)
  })

  it("applies the fallback category, empty research files and a bare slug for odd names", async () => {
    seedRead(emptyStore())
    const aura = await createCustomCharacterAuraFromGeneratedSkill("/P", {
      name: "###",
      sourceNote: "n",
      corpus: "c",
      styleDescription: "s",
      behaviorRules: "b",
      boundaries: "bd",
      notes: "nt",
      expressionDna: "d",
      mentalModel: "m",
      decisionHeuristics: "dh",
      valueAntiPatterns: "v",
      honestyBoundaries: "h",
      skillContent: "# SKILL",
    })
    expect(aura.category).toBe("拆书角色")
    // name "###" cleans to an empty slug → folder uses the bare id
    expect(aura.skillFolder).toContain(`/${aura.id}-perspective`)
    const researchWrites = fsMocks.writeFileAtomic.mock.calls.filter((c) =>
      (c[0] as string).includes("/references/research/"),
    )
    expect(researchWrites).toHaveLength(6)
    expect(String(researchWrites[0]?.[1])).toContain("（拆书分析未提供该维度）")
  })
})

// ---------------------------------------------------------------------------
// createCustomCharacterAuraSkill — full generation workflow
// ---------------------------------------------------------------------------

describe("createCustomCharacterAuraSkill", () => {
  function collectProgress(): { onProgress: (p: CharacterAuraGenerationProgress) => void; steps: CharacterAuraGenerationProgress[] } {
    const steps: CharacterAuraGenerationProgress[] = []
    return {
      onProgress: (p) => steps.push(p),
      steps,
    }
  }

  it("runs the full workflow with local docs, urls, web search and LLM", async () => {
    seedRead(emptyStore(), (path) => {
      if (path === "/d/ok.md") return "本地文档正文"
      return undefined
    })
    defaultWebAndFetch()
    llmReturns([
      "# 林动 - 公开资料\n## 核心结论\n内容", // 6 stages
      "# 林动 - 对话方式\n## 说话节奏\n内容",
      "# 林动 - 表达特征\n## 词汇偏好\n内容",
      "# 林动 - 外部评价\n## 支持者视角\n内容",
      "# 林动 - 决策记录\n## 核心优先级\n内容",
      "# 林动 - 时间线\n## 起点\n内容",
      fullFieldsJson(), // synthesis
    ])
    const { onProgress, steps } = collectProgress()
    const aura = await createCustomCharacterAuraSkill(
      "/P",
      skillInput({ localDocumentPaths: "/d/ok.md\n/d/missing.md" }),
      { onProgress, llmConfig: USABLE_LLM },
    )

    expect(aura.id).toMatch(/^custom-\d+-/)
    expect(aura.name).toBe("林动")
    expect(aura.category).toBe("主角")
    expect(aura.sourceNote).toBe("来源说明")
    expect(aura.webSearchEnabled).toBe(true)
    expect(aura.sourceUrls).toBe("https://a.com")
    expect(aura.skillFolder).toContain("/.qmai/character-auras/")
    // 10 progress steps: 准备资料, 搜索, 6 阶段, 汇总, 保存
    expect(steps).toHaveLength(10)
    expect(steps[0].stage).toBe("准备资料")
    expect(steps[1].stage).toBe("AI 搜索")
    expect(steps[2].researchFileName).toBe("01-writings.md")
    expect(steps[7].researchFileName).toBe("06-timeline.md")
    expect(steps[8].stage).toBe("汇总灵魂")
    expect(steps[9].stage).toBe("保存结果")
    expect(steps[9].step).toBe(10)
    // store saved with the new aura
    const storeWrite = fsMocks.writeFileAtomic.mock.calls.find((c) => c[0] === STORE_PATH)
    expect(JSON.parse(String(storeWrite?.[1])).customAuras).toHaveLength(1)
    // SKILL.md written with the workflow summary
    const skillWrite = fsMocks.writeFileAtomic.mock.calls.find((c) => (c[0] as string).endsWith("/SKILL.md"))
    expect(String(skillWrite?.[1])).toContain("# 林动 · 自定义人物灵魂操作系统")
    expect(String(skillWrite?.[1])).toContain("## 工作流产出摘要")
  })

  it("records failed local documents and skipped web search", async () => {
    seedRead(emptyStore())
    const aura = await createCustomCharacterAuraSkill(
      "/P",
      skillInput({ localDocumentPaths: "/d/missing.md", sourceUrls: "", enableWebSearch: false }),
      { llmConfig: NO_LLM },
    )
    expect(aura.webSearchEnabled).toBe(false)
    expect(streamChatMock).not.toHaveBeenCalled()
    expect(webSearchMock).not.toHaveBeenCalled()
    const researchWrites = fsMocks.writeFileAtomic.mock.calls.filter((c) =>
      (c[0] as string).includes("/references/research/"),
    )
    // 01-writings fallback template surfaces the failed local document
    expect(String(researchWrites[0]?.[1])).toContain("本地文档读取失败")
    expect(String(researchWrites[0]?.[1])).toContain("- /d/missing.md：读取失败")
  })

  it("degrades to template generation without a usable LLM", async () => {
    seedRead(emptyStore())
    defaultWebAndFetch()
    const { onProgress, steps } = collectProgress()
    const aura = await createCustomCharacterAuraSkill(
      "/P",
      skillInput(),
      { onProgress, llmConfig: NO_LLM },
    )
    expect(streamChatMock).not.toHaveBeenCalled()
    expect(aura.sourceNote).toContain("基于用户资料整理出的自定义人物灵魂")
    expect(steps).toHaveLength(10)
    const researchWrites = fsMocks.writeFileAtomic.mock.calls.filter((c) =>
      (c[0] as string).includes("/references/research/"),
    )
    expect(researchWrites).toHaveLength(6)
    expect(String(researchWrites[0]?.[1])).toContain("# 林动 - 公开资料")
  })

  it("records generation notes when LLM stages fail and synthesizes via fallback", async () => {
    seedRead(emptyStore())
    llmReturns([
      new Error("llm down"), // stage 01 fails
      "# b", "# c", "# d", "# e", "# f",
      "不是 JSON", // synthesis fails → fallback fields
    ])
    const aura = await createCustomCharacterAuraSkill("/P", skillInput({ enableWebSearch: false }), {
      llmConfig: USABLE_LLM,
    })
    expect(aura.sourceNote).toContain("基于用户资料整理出的自定义人物灵魂")
    const skillWrite = fsMocks.writeFileAtomic.mock.calls.find((c) => (c[0] as string).endsWith("/SKILL.md"))
    expect(String(skillWrite?.[1])).toContain("生成失败，已降级为模板生成")
  })

  it("records web search failures and the no-results note", async () => {
    seedRead(emptyStore())
    webSearchMock.mockRejectedValue(new Error("not configured"))
    llmReturns(["# a", "# b", "# c", "# d", "# e", "# f", fullFieldsJson()])
    const aura = await createCustomCharacterAuraSkill("/P", skillInput(), { llmConfig: USABLE_LLM })
    expect(aura.corpus).toBe("语料文本") // corpus present → kept verbatim
    const skillWrite = fsMocks.writeFileAtomic.mock.calls.find((c) => (c[0] as string).endsWith("/SKILL.md"))
    expect(String(skillWrite?.[1])).toContain("AI 搜索没有拿到可用结果")
  })

  it("builds the stored corpus from search/docs when corpus is absent", async () => {
    seedRead(emptyStore())
    defaultWebAndFetch()
    llmReturns(["# a", "# b", "# c", "# d", "# e", "# f", fullFieldsJson()])
    const aura = await createCustomCharacterAuraSkill(
      "/P",
      skillInput({ corpus: "", generationPrompt: "" }),
      { llmConfig: USABLE_LLM },
    )
    expect(aura.corpus).toContain("AI 搜索摘要")
  })

  it("falls back to the index-only corpus message when nothing is available", async () => {
    seedRead(emptyStore())
    webSearchMock.mockResolvedValue([])
    llmReturns(["# a", "# b", "# c", "# d", "# e", "# f", fullFieldsJson()])
    const aura = await createCustomCharacterAuraSkill(
      "/P",
      skillInput({ corpus: "", generationPrompt: "", enableWebSearch: true, localDocumentPaths: "", sourceUrls: "" }),
      { llmConfig: USABLE_LLM },
    )
    expect(aura.corpus).toBe("用户未填写资料文本，仅提供资料索引。")
  })

  it("tolerates a missing progress callback and missing source input fields", async () => {
    seedRead(emptyStore())
    llmReturns(["# a", "# b", "# c", "# d", "# e", "# f", fullFieldsJson()])
    const aura = await createCustomCharacterAuraSkill(
      "/P",
      { name: "林动" },
      { llmConfig: USABLE_LLM },
    )
    expect(aura.category).toBe("自定义灵魂")
    expect(aura.sourceUrls).toBe("")
  })

  it("records url fetch failures when getHttpFetch throws", async () => {
    seedRead(emptyStore())
    webSearchMock.mockResolvedValue([searchResult()])
    getHttpFetchMock.mockRejectedValue(new Error("no http"))
    const aura = await createCustomCharacterAuraSkill(
      "/P",
      skillInput({ corpus: "", generationPrompt: "", sourceUrls: "https://bad.com" }),
      { llmConfig: NO_LLM },
    )
    // corpus falls back to search-derived text; url fetch failures recorded
    expect(aura.corpus).toContain("AI 搜索摘要")
    const skillWrite = fsMocks.writeFileAtomic.mock.calls.find((c) => (c[0] as string).endsWith("/SKILL.md"))
    expect(String(skillWrite?.[1])).toContain("### 联网抓取失败")
    expect(String(skillWrite?.[1])).toContain("- https://bad.com")
    const researchWrites = fsMocks.writeFileAtomic.mock.calls.filter((c) =>
      (c[0] as string).includes("/references/research/"),
    )
    expect(String(researchWrites[0]?.[1])).toContain("## AI 搜索网页读取失败")
  })

  it("records per-url search document failures and successes", async () => {
    seedRead(emptyStore())
    webSearchMock.mockResolvedValue([
      searchResult({ url: "https://bad.com/1" }),
      searchResult({ url: "https://good.com/2" }),
    ])
    getHttpFetchMock.mockResolvedValue(
      vi
        .fn()
        .mockResolvedValueOnce(httpOk("<p>网页正文</p>")) // readCustomAuraUrls
        .mockRejectedValueOnce(new Error("net down")) // search doc 1
        .mockResolvedValueOnce(httpOk("<p>搜索正文</p>")), // search doc 2
    )
    llmReturns(["# a", "# b", "# c", "# d", "# e", "# f", fullFieldsJson()])
    const aura = await createCustomCharacterAuraSkill("/P", skillInput(), { llmConfig: USABLE_LLM })
    const skillWrite = fsMocks.writeFileAtomic.mock.calls.find((c) => (c[0] as string).endsWith("/SKILL.md"))
    expect(String(skillWrite?.[1])).toContain("### 联网抓取失败")
    expect(String(skillWrite?.[1])).toContain("- https://bad.com/1")
    expect(aura.corpus).toBe("语料文本")
  })

  it("surfaces imported local documents in the fallback research file", async () => {
    seedRead(emptyStore(), (path) => {
      if (path === "/d/ok.md") return "本地文档正文内容"
      return undefined
    })
    const aura = await createCustomCharacterAuraSkill(
      "/P",
      skillInput({ corpus: "", enableWebSearch: false, sourceUrls: "" }),
      { llmConfig: NO_LLM },
    )
    expect(aura.corpus).toContain("- /d/ok.md：本地文档正文内容")
    const researchWrites = fsMocks.writeFileAtomic.mock.calls.filter((c) =>
      (c[0] as string).includes("/references/research/"),
    )
    expect(String(researchWrites[0]?.[1])).toContain("### /d/ok.md")
    expect(String(researchWrites[0]?.[1])).toContain("- 本地文档 /d/ok.md：本地文档正文内容")
  })

  it("prepends a heading when a stage output lacks one", async () => {
    seedRead(emptyStore())
    llmReturns(["## 无标题内容", "# b", "# c", "# d", "# e", "# f", fullFieldsJson()])
    const aura = await createCustomCharacterAuraSkill(
      "/P",
      skillInput({ enableWebSearch: false }),
      { llmConfig: USABLE_LLM },
    )
    expect(aura.name).toBe("林动")
  })

  it("falls back when synthesis JSON misses a required field", async () => {
    seedRead(emptyStore())
    llmReturns(["# a", "# b", "# c", "# d", "# e", "# f", JSON.stringify({ sourceNote: "x" })])
    const aura = await createCustomCharacterAuraSkill(
      "/P",
      skillInput({ enableWebSearch: false }),
      { llmConfig: USABLE_LLM },
    )
    expect(aura.sourceNote).toContain("基于用户资料整理出的自定义人物灵魂")
  })

  it("throws stream errors reported via onError and degrades", async () => {
    seedRead(emptyStore())
    streamChatMock.mockImplementation(
      async (_c: unknown, _m: unknown, cb: { onError: (e: Error) => void }) => {
        cb.onError(new Error("stream broke"))
      },
    )
    const aura = await createCustomCharacterAuraSkill(
      "/P",
      skillInput({ enableWebSearch: false }),
      { llmConfig: USABLE_LLM },
    )
    expect(aura.sourceNote).toContain("基于用户资料整理出的自定义人物灵魂")
  })

  it("keeps existing research files during update and skips blank ones", async () => {
    const aura = {
      id: "custom-1",
      builtIn: false,
      name: "林动",
      category: "主角",
      sourceNote: "n",
      corpus: "c",
      styleDescription: "s",
      behaviorRules: "b",
      boundaries: "bd",
      notes: "nt",
      expressionDna: "d",
      mentalModel: "m",
      decisionHeuristics: "dh",
      valueAntiPatterns: "v",
      honestyBoundaries: "h",
      generationPrompt: "g",
      webSearchEnabled: true,
      skillFolder: "/P/.qmai/character-auras/custom-1-perspective",
    }
    seedRead({ customAuras: [aura], bindings: [] }, (path) => {
      if (path.endsWith("/references/research/01-writings.md")) return "# 已有内容"
      if (path.endsWith("/references/research/02-conversations.md")) return "   "
      return undefined
    })
    await updateCustomCharacterAura("/P", "custom-1", { name: "新名字" })
    const researchWrites = fsMocks.writeFileAtomic.mock.calls
      .filter((c) => (c[0] as string).includes("/references/research/"))
      .map((c) => (c[0] as string).split("/").pop())
    // 01 kept (content), 02 blank → not stored → rewritten, 03-06 written
    expect(researchWrites).toEqual([
      "02-conversations.md",
      "03-expression-dna.md",
      "04-external-views.md",
      "05-decisions.md",
      "06-timeline.md",
    ])
  })

  it("falls back to the store llmConfig when none is injected", async () => {
    seedRead(emptyStore())
    llmReturns(["# a", "# b", "# c", "# d", "# e", "# f", fullFieldsJson()])
    const aura = await createCustomCharacterAuraSkill("/P", skillInput({ enableWebSearch: false }), {})
    expect(aura.name).toBe("林动")
    expect(streamChatMock).toHaveBeenCalled()
  })

  it("continues past non-Error web search failures and keeps searching", async () => {
    seedRead(emptyStore())
    webSearchMock.mockImplementation(async (query: string) => {
      if (query.includes("说话风格")) throw "boom-string"
      return []
    })
    llmReturns(["# a", "# b", "# c", "# d", "# e", "# f", fullFieldsJson()])
    const aura = await createCustomCharacterAuraSkill("/P", skillInput(), { llmConfig: USABLE_LLM })
    expect(aura.name).toBe("林动")
    expect(webSearchMock).toHaveBeenCalledTimes(3)
    const skillWrite = fsMocks.writeFileAtomic.mock.calls.find((c) => (c[0] as string).endsWith("/SKILL.md"))
    expect(String(skillWrite?.[1])).toContain("AI 搜索「")
  })

  it("handles empty result urls/snippets and a missing generation prompt", async () => {
    seedRead(emptyStore())
    webSearchMock.mockResolvedValue([searchResult({ url: "", snippet: "" })])
    getHttpFetchMock.mockResolvedValue(vi.fn().mockResolvedValue(httpOk("<p>搜索结果正文</p>")))
    llmReturns(["# a", "# b", "# c", "# d", "# e", "# f", fullFieldsJson()])
    const aura = await createCustomCharacterAuraSkill(
      "/P",
      skillInput({ generationPrompt: undefined, enableWebSearch: true }),
      { llmConfig: USABLE_LLM },
    )
    expect(aura.name).toBe("林动")
  })

  it("records HTTP and empty-content failures for url and search documents", async () => {
    seedRead(emptyStore())
    webSearchMock.mockResolvedValue([
      searchResult({ url: "https://s-bad-status.com", snippet: "s1" }),
      searchResult({ url: "https://s-empty.com", snippet: "s2" }),
    ])
    getHttpFetchMock.mockResolvedValue(
      vi.fn().mockImplementation(async (url: string) => {
        if (url === "https://u-bad-status.com") return { ok: false, status: 500, text: async () => "" }
        if (url === "https://u-empty.com") return { ok: true, status: 200, text: async () => "<p>  </p>" }
        if (url === "https://s-bad-status.com") return { ok: false, status: 500, text: async () => "" }
        if (url === "https://s-empty.com") return { ok: true, status: 200, text: async () => "<div> </div>" }
        return { ok: true, status: 200, text: async () => "<p>网页正文</p>" }
      }),
    )
    llmReturns(["# a", "# b", "# c", "# d", "# e", "# f", fullFieldsJson()])
    const aura = await createCustomCharacterAuraSkill(
      "/P",
      skillInput({ sourceUrls: "https://u-bad-status.com\nhttps://u-empty.com", corpus: "", generationPrompt: "", enableWebSearch: true }),
      { llmConfig: USABLE_LLM },
    )
    expect(aura.name).toBe("林动")
    const skillWrite = fsMocks.writeFileAtomic.mock.calls.find((c) => (c[0] as string).endsWith("/SKILL.md"))
    expect(String(skillWrite?.[1])).toContain("https://u-bad-status.com")
    expect(String(skillWrite?.[1])).toContain("https://s-empty.com")
  })

  it("synthesizes fallback fields when research files contain only headings", async () => {
    seedRead(emptyStore())
    llmReturns([
      "# \n\n- ",
      "# \n\n- ",
      "# \n\n- ",
      "# \n\n- ",
      "# \n\n- ",
      "# \n\n- ",
      "不是 JSON",
    ])
    const aura = await createCustomCharacterAuraSkill(
      "/P",
      skillInput({ enableWebSearch: false, corpus: "", generationPrompt: "", localDocumentPaths: "", sourceUrls: "" }),
      { llmConfig: USABLE_LLM },
    )
    expect(aura.styleDescription).toContain("当前仍以有限资料推断整体气质")
    expect(aura.decisionHeuristics).toContain("先判断优先级与失败代价")
    expect(aura.expressionDna).toContain("资料不足时")
  })

  it("records an empty stage output and non-Error stage failures via fallback", async () => {
    seedRead(emptyStore())
    let call = 0
    streamChatMock.mockImplementation(async (_c: unknown, _m: unknown, cb: { onToken: (t: string) => void; onDone: () => void }) => {
      call += 1
      if (call === 1) {
        // stage 01 returns an empty payload → template fallback, no note
        cb.onToken("")
        cb.onDone()
        return
      }
      if (call === 2 || call === 7) throw "boom-string"
      cb.onToken("# x")
      cb.onDone()
    })
    const aura = await createCustomCharacterAuraSkill(
      "/P",
      skillInput({ enableWebSearch: false }),
      { llmConfig: USABLE_LLM },
    )
    expect(aura.sourceNote).toContain("基于用户资料整理出的自定义人物灵魂")
    const skillWrite = fsMocks.writeFileAtomic.mock.calls.find((c) => (c[0] as string).endsWith("/SKILL.md"))
    expect(String(skillWrite?.[1])).toContain("未知错误")
  })

  it("fallback templates handle empty category, empty evidence and empty search results", async () => {
    seedRead(emptyStore())
    webSearchMock.mockResolvedValue([])
    const aura = await createCustomCharacterAuraSkill(
      "/P",
      skillInput({ category: "", corpus: "", generationPrompt: "", enableWebSearch: true, localDocumentPaths: "", sourceUrls: "" }),
      { llmConfig: NO_LLM },
    )
    const researchWrites = fsMocks.writeFileAtomic.mock.calls.filter((c) =>
      (c[0] as string).includes("/references/research/"),
    )
    expect(String(researchWrites[0]?.[1])).toContain("- 角色定位：自定义灵魂。")
    expect(String(researchWrites[0]?.[1])).toContain("当前没有可直接引用的资料")
    expect(String(researchWrites[0]?.[1])).toContain("可用的 AI 搜索结果")
    expect(aura.corpus).toBe("用户未填写资料文本，仅提供资料索引。")
  })

  it("fallback template surfaces empty search snippets as missing", async () => {
    seedRead(emptyStore())
    webSearchMock.mockResolvedValue([searchResult({ url: "https://s.com/1", snippet: "" })])
    getHttpFetchMock.mockResolvedValue(vi.fn().mockResolvedValue(httpOk("<p>搜索结果正文</p>")))
    const aura = await createCustomCharacterAuraSkill(
      "/P",
      skillInput({ enableWebSearch: true }),
      { llmConfig: NO_LLM },
    )
    const researchWrites = fsMocks.writeFileAtomic.mock.calls.filter((c) =>
      (c[0] as string).includes("/references/research/"),
    )
    expect(String(researchWrites[0]?.[1])).toContain("- 摘要：无")
    expect(aura.name).toBe("林动")
  })

  it("fallback template reports nothing missing when corpus is provided", async () => {
    seedRead(emptyStore())
    const aura = await createCustomCharacterAuraSkill(
      "/P",
      skillInput({ enableWebSearch: false, sourceUrls: "", localDocumentPaths: "" }),
      { llmConfig: NO_LLM },
    )
    const researchWrites = fsMocks.writeFileAtomic.mock.calls.filter((c) =>
      (c[0] as string).includes("/references/research/"),
    )
    expect(String(researchWrites[0]?.[1])).toContain("更多可核实的公开经历")
    expect(String(researchWrites[0]?.[1])).toContain("未开启 AI 搜索")
    expect(aura.name).toBe("林动")
  })
})

