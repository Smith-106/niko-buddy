import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  addToRecentProjects,
  getLastProject,
  getRecentProjects,
  loadAiChatModel,
  loadActivePresetId,
  loadDefaultLlmModel,
  loadEmbeddingConfig,
  loadLanguage,
  loadLlmConfig,
  loadMaxHistoryMessages,
  loadMultimodalConfig,
  loadNovelConfig,
  loadNovelMode,
  loadOutputLanguage,
  loadProjectFileSyncEnabled,
  loadProviderConfigs,
  loadProxyConfig,
  loadRerankConfig,
  loadRevisionFeedbackWindowConfig,
  loadScheduledImportConfig,
  loadSearchApiConfig,
  loadSourceWatchConfig,
  loadTheme,
  removeFromRecentProjects,
  saveAiChatModel,
  saveActivePresetId,
  saveDefaultLlmModel,
  saveEmbeddingConfig,
  saveLanguage,
  saveLastProject,
  saveLlmConfig,
  saveMaxHistoryMessages,
  saveMultimodalConfig,
  saveNovelConfig,
  saveNovelMode,
  saveOutputLanguage,
  saveProjectFileSyncEnabled,
  saveProviderConfigs,
  saveProxyConfig,
  saveRerankConfig,
  saveRevisionFeedbackWindowConfig,
  saveScheduledImportConfig,
  saveSearchApiConfig,
  saveSourceWatchConfig,
  saveTheme,
  saveUiFontSizeScale,
  migratePlaintextApiKeys,
} from "./project-store"
import type { WikiProject } from "@/types/wiki"

const mocks = vi.hoisted(() => {
  const map = new Map<string, unknown>()
  return {
    store: {
      get: vi.fn<<T = unknown>(k: string) => Promise<T | undefined>>(async <T>(k: string) => (map.has(k) ? (map.get(k) as T) : undefined)),
      set: vi.fn(async (k: string, v: unknown) => {
        map.set(k, v)
      }),
      delete: vi.fn(async (k: string) => {
        map.delete(k)
      }),
      save: vi.fn(async () => {}),
    },
    clearStore: () => map.clear(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    fileExists: vi.fn(),
    loadNovelProjectMeta: vi.fn(),
    saveNovelProjectMeta: vi.fn(),
  }
})

vi.mock("@/lib/web-store", () => ({
  getStore: async () => mocks.store,
}))

// Provide a deterministic localStorage polyfill + platform mock so the real AES-GCM
// crypto module (imported via project-store) works in the node test environment.
// crypto.ts falls back to a localStorage-backed device fingerprint when isTauri() is false.
const lsMap = new Map<string, string>()
vi.stubGlobal("localStorage", {
  getItem: (k: string) => (lsMap.has(k) ? lsMap.get(k)! : null),
  setItem: (k: string, v: string) => { lsMap.set(k, v) },
  removeItem: (k: string) => { lsMap.delete(k) },
  key: (i: number) => Array.from(lsMap.keys())[i] ?? null,
  get length() { return lsMap.size },
})
vi.mock("@/lib/platform", () => ({ isTauri: () => false }))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  fileExists: mocks.fileExists,
}))

vi.mock("@/lib/novel/project-meta", () => ({
  loadNovelProjectMeta: mocks.loadNovelProjectMeta,
  saveNovelProjectMeta: mocks.saveNovelProjectMeta,
}))

const project: WikiProject = { id: "p1", name: "P", path: "C:/p" }

describe("recent projects", () => {
  beforeEach(() => {
    mocks.clearStore()
    vi.clearAllMocks()
  })

  it("returns [] and null for missing entries", async () => {
    await expect(getRecentProjects()).resolves.toEqual([])
    await expect(getLastProject()).resolves.toBeNull()
  })

  it("round-trips recent projects and the last project", async () => {
    const a: WikiProject = { id: "a", name: "A", path: "/a" }
    const b: WikiProject = { id: "b", name: "B", path: "/b" }
    await addToRecentProjects(a)
    await addToRecentProjects(b)
    await addToRecentProjects(a) // re-add dedupes by path and moves to front
    const recent = await getRecentProjects()
    expect(recent.map((p) => p.path)).toEqual(["/a", "/b"])

    await saveLastProject(b)
    await expect(getLastProject()).resolves.toEqual(b)
    expect((await getRecentProjects())[0].path).toBe("/b")
  })

  it("caps recent projects at 10", async () => {
    for (let i = 0; i < 12; i++) {
      await addToRecentProjects({ id: `p${i}`, name: `P${i}`, path: `/p${i}` })
    }
    const recent = await getRecentProjects()
    expect(recent).toHaveLength(10)
    expect(recent[0].path).toBe("/p11")
  })

  it("removes a project and clears the last-project pointer when it matches", async () => {
    await addToRecentProjects(project)
    await saveLastProject(project)
    await removeFromRecentProjects("C:/p")
    expect(await getRecentProjects()).toEqual([])
    expect(await getLastProject()).toBeNull()
    expect(mocks.store.delete).toHaveBeenCalledWith("lastProject")
  })

  it("keeps the last-project pointer when removing a different path", async () => {
    const other: WikiProject = { id: "o", name: "O", path: "/o" }
    await saveLastProject(other)
    await removeFromRecentProjects("C:/p")
    expect(await getLastProject()).toEqual(other)
  })
})

describe("llm / provider config round-trips", () => {
  beforeEach(() => {
    mocks.clearStore()
    vi.clearAllMocks()
  })

  it("round-trips llmConfig, chat model and default model", async () => {
    const config = { provider: "custom", apiKey: "k" }
    await saveLlmConfig(config as never)
    await expect(loadLlmConfig()).resolves.toEqual(config)
    await expect(loadLlmConfig().then(() => null)).resolves.toBeNull()
    await saveAiChatModel("claude")
    await expect(loadAiChatModel()).resolves.toBe("claude")
    await saveDefaultLlmModel("gpt")
    await expect(loadDefaultLlmModel()).resolves.toBe("gpt")
    await expect(loadDefaultLlmModel().then(() => null)).resolves.toBeNull()
  })

  it("round-trips provider configs and preset ids including null", async () => {
    const configs = { custom: { apiKey: "x" } }
    await saveProviderConfigs(configs as never)
    await expect(loadProviderConfigs()).resolves.toEqual(configs)
    await saveActivePresetId("preset-1")
    await expect(loadActivePresetId()).resolves.toBe("preset-1")
    await saveActivePresetId(null)
    await expect(loadActivePresetId()).resolves.toBeNull()
  })

  it("round-trips search/embedding/multimodal configs", async () => {
    const search = { apiKey: "s", engine: "e" }
    const embed = { enabled: true, model: "m" }
    const multi = { enabled: false }
    await saveSearchApiConfig(search as never)
    await expect(loadSearchApiConfig()).resolves.toEqual(search)
    await saveEmbeddingConfig(embed as never)
    await expect(loadEmbeddingConfig()).resolves.toEqual(embed)
    await saveMultimodalConfig(multi as never)
    await expect(loadMultimodalConfig()).resolves.toEqual(multi)
    await expect(loadSearchApiConfig().then(() => null)).resolves.toBeNull()
  })

  it("saveProxyConfig force-flushes to disk and round-trips", async () => {
    const proxy = { enabled: true, url: "http://127.0.0.1:8756", bypassLocal: true }
    await saveProxyConfig(proxy as never)
    expect(mocks.store.save).toHaveBeenCalled()
    await expect(loadProxyConfig()).resolves.toEqual(proxy)
  })
})

describe("apiKey encryption at the persistence boundary", () => {
  beforeEach(() => {
    mocks.clearStore()
    vi.clearAllMocks()
  })

  it("stores an encrypted apiKey in the raw store, not plaintext", async () => {
    const config = { provider: "custom", apiKey: "secret-key-123" }
    await saveLlmConfig(config as never)
    const raw = (await mocks.store.get("llmConfig")) as { apiKey: string }
    expect(String(raw.apiKey)).toMatch(/^enc::v1::/)
    expect(String(raw.apiKey)).not.toContain("secret-key-123")
  })

  it("empty apiKey stays empty (no spurious wrapping)", async () => {
    const config = { provider: "custom", apiKey: "" }
    await saveLlmConfig(config as never)
    const raw = (await mocks.store.get("llmConfig")) as { apiKey: string }
    expect(raw.apiKey).toBe("")
  })

  it("migratePlaintextApiKeys re-saves plaintext store values as encrypted", async () => {
    // Seed the store with a plaintext apiKey directly (simulating a pre-encryption install).
    await mocks.store.set("llmConfig", { provider: "custom", apiKey: "plaintext-key" })
    await migratePlaintextApiKeys()
    const raw = (await mocks.store.get("llmConfig")) as { apiKey: string }
    expect(String(raw.apiKey)).toMatch(/^enc::v1::/)
    // The decrypted round-trip still yields the original plaintext.
    const loaded = (await loadLlmConfig()) as { apiKey: string }
    expect(loaded.apiKey).toBe("plaintext-key")
  })

  it("migratePlaintextApiKeys is idempotent (already-encrypted values untouched)", async () => {
    const config = { provider: "custom", apiKey: "already-enc" }
    await saveLlmConfig(config as never)
    await migratePlaintextApiKeys()
    const raw = (await mocks.store.get("llmConfig")) as { apiKey: string }
    // Still encrypted (AES-GCM uses a fresh nonce each call, so ciphertext bytes differ; assert prefix).
    expect(String(raw.apiKey)).toMatch(/^enc::v1::/)
    // The decrypted round-trip still yields the original plaintext.
    const loaded = (await loadLlmConfig()) as { apiKey: string }
    expect(loaded.apiKey).toBe("already-enc")
  })

  it("migratePlaintextApiKeys re-saves every config family carrying plaintext keys", async () => {
    await mocks.store.set("llmConfig", { provider: "custom", apiKey: "plaintext-key" })
    await mocks.store.set("providerConfigs", { anthropic: { apiKey: "pk-1" } })
    await mocks.store.set("searchApiConfig", { provider: "serpapi", apiKey: "sk-search" })
    await mocks.store.set("embeddingConfig", {
      enabled: true,
      endpoint: "http://127.0.0.1:1234/v1/embeddings",
      apiKey: "sk-emb",
      model: "m",
    })
    await mocks.store.set("multimodalConfig", {
      enabled: true,
      useMainLlm: false,
      provider: "custom",
      apiKey: "sk-mm",
      model: "m",
      ollamaUrl: "",
      customEndpoint: "",
    })
    await migratePlaintextApiKeys()
    const rawLlm = (await mocks.store.get("llmConfig")) as { apiKey: string }
    const rawProviders = (await mocks.store.get("providerConfigs")) as Record<string, { apiKey: string }>
    const rawSearch = (await mocks.store.get("searchApiConfig")) as { apiKey: string }
    const rawEmb = (await mocks.store.get("embeddingConfig")) as { apiKey: string }
    const rawMm = (await mocks.store.get("multimodalConfig")) as { apiKey: string }
    expect(String(rawLlm.apiKey)).toMatch(/^enc::v1::/)
    expect(String(rawProviders.anthropic.apiKey)).toMatch(/^enc::v1::/)
    expect(String(rawSearch.apiKey)).toMatch(/^enc::v1::/)
    expect(String(rawEmb.apiKey)).toMatch(/^enc::v1::/)
    expect(String(rawMm.apiKey)).toMatch(/^enc::v1::/)
  })

  it("migratePlaintextApiKeys skips absent config families", async () => {
    // 仅 searchApiConfig 含明文 → needsMigration 为真，但 llmConfig 等缺失 → 对应 if 守卫走 false 分支
    await mocks.store.set("searchApiConfig", { provider: "serpapi", apiKey: "sk-search" })
    await migratePlaintextApiKeys()
    const rawSearch = (await mocks.store.get("searchApiConfig")) as { apiKey: string }
    expect(String(rawSearch.apiKey)).toMatch(/^enc::v1::/)
    expect(mocks.store.set).not.toHaveBeenCalledWith("llmConfig", expect.anything())
  })
})

describe("scheduled import config", () => {
  beforeEach(() => {
    mocks.clearStore()
    vi.clearAllMocks()
  })

  it("saves and loads a per-project config", async () => {
    const config = { enabled: true, path: "w", interval: 5, lastScan: 1 }
    await saveScheduledImportConfig("C:/p", config)
    expect(mocks.store.save).toHaveBeenCalled()
    await expect(loadScheduledImportConfig("C:/p")).resolves.toEqual(config)
  })

  it("migrates a legacy global config", async () => {
    const legacy = { enabled: false, path: "raw", interval: 10, lastScan: null }
    await mocks.store.set("scheduledImportConfig", legacy)
    await expect(loadScheduledImportConfig("C:/p")).resolves.toEqual(legacy)
    expect(mocks.store.delete).toHaveBeenCalledWith("scheduledImportConfig")
    // migrated copy is now the per-project value
    await expect(loadScheduledImportConfig("C:/p")).resolves.toEqual(legacy)
  })

  it("returns null when nothing is stored", async () => {
    await expect(loadScheduledImportConfig("C:/p")).resolves.toBeNull()
  })
})

describe("language / output language", () => {
  beforeEach(() => {
    mocks.clearStore()
    vi.clearAllMocks()
  })

  it("round-trips the ui language", async () => {
    await saveLanguage("zh-CN")
    await expect(loadLanguage()).resolves.toBe("zh-CN")
  })

  it("round-trips output language globally and per project", async () => {
    await saveOutputLanguage("Chinese")
    await expect(loadOutputLanguage()).resolves.toBe("Chinese")
    await saveOutputLanguage("English", "p1")
    await saveOutputLanguage("Japanese", "p2")
    await expect(loadOutputLanguage("p1")).resolves.toBe("English")
    await expect(loadOutputLanguage("p2")).resolves.toBe("Japanese")
    await expect(loadOutputLanguage("missing")).resolves.toBeNull()
    await expect(loadOutputLanguage().then(() => null)).resolves.toBeNull()
  })
})

describe("file sync flag", () => {
  beforeEach(() => {
    mocks.clearStore()
    vi.clearAllMocks()
  })

  it("stores per-project and default values, defaulting to true", async () => {
    await saveProjectFileSyncEnabled(false, "p1")
    await expect(loadProjectFileSyncEnabled("p1")).resolves.toBe(false)
    await expect(loadProjectFileSyncEnabled("p2")).resolves.toBe(true)
    await saveProjectFileSyncEnabled(false)
    await expect(loadProjectFileSyncEnabled()).resolves.toBe(false)
    await expect(loadProjectFileSyncEnabled("p2")).resolves.toBe(false)
  })
})

describe("source watch config", () => {
  beforeEach(() => {
    mocks.clearStore()
    vi.clearAllMocks()
    mocks.readFile.mockRejectedValue(new Error("no file"))
    mocks.fileExists.mockResolvedValue(false)
    mocks.writeFile.mockResolvedValue(undefined)
  })

  it("saves to the store and to a per-project file", async () => {
    const config = { enabled: true, autoIngest: true }
    await saveSourceWatchConfig(config as never, "p1", "C:/p")
    expect(mocks.writeFile).toHaveBeenCalledWith("C:/p/.qmai/source-watch-config.json", expect.any(String))
    const parsed = JSON.parse(mocks.writeFile.mock.calls[0][1] as string)
    expect(parsed.enabled).toBe(true)
  })

  it("stores under the default key when no project id is given", async () => {
    await saveSourceWatchConfig({ enabled: true } as never)
    const stored = (await mocks.store.get("sourceWatchConfig")) as Record<string, unknown> | undefined
    expect(stored?.default).toMatchObject({ enabled: true })
  })

  it("tolerates a failed file write on save", async () => {
    mocks.writeFile.mockRejectedValueOnce(new Error("disk"))
    await expect(saveSourceWatchConfig({ enabled: true } as never, "p1", "C:/p")).resolves.toBeUndefined()
  })

  it("loads from the per-project file first", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify({ enabled: true, autoIngest: false, maxFileSizeMb: 50 }))
    const config = await loadSourceWatchConfig("p1", "C:/p")
    expect(config.enabled).toBe(true)
    expect(config.maxFileSizeMb).toBe(50)
  })

  it("falls through to the store when the file is unreadable", async () => {
    mocks.readFile.mockRejectedValue(new Error("boom"))
    await mocks.store.set("sourceWatchConfig", {
      p1: { enabled: true, autoIngest: true, maxFileSizeMb: 20 },
    })
    const config = await loadSourceWatchConfig("p1", "C:/p")
    expect(config.enabled).toBe(true)
    // migration write happened
    expect(mocks.writeFile).toHaveBeenCalled()
  })

  it("falls back to the default entry and legacy file-sync flag", async () => {
    await mocks.store.set("sourceWatchConfig", {
      default: { enabled: false, autoIngest: false, maxFileSizeMb: 9 },
    })
    const fromDefault = await loadSourceWatchConfig("p1")
    expect(fromDefault.enabled).toBe(false)

    await mocks.store.delete("sourceWatchConfig")
    await mocks.store.set("projectFileSyncEnabled", { p1: false })
    const legacy = await loadSourceWatchConfig("p1")
    expect(legacy.enabled).toBe(false)
  })
})

describe("novel mode", () => {
  beforeEach(() => {
    mocks.clearStore()
    vi.clearAllMocks()
    mocks.loadNovelProjectMeta.mockRejectedValue(new Error("no meta"))
  })

  it("stores novel mode per project and globally", async () => {
    await saveNovelMode(true, "p1")
    await saveNovelMode(false)
    await expect(loadNovelMode("p1")).resolves.toBe(true)
    await expect(loadNovelMode("p2")).resolves.toBeNull()
    await expect(loadNovelMode()).resolves.toBe(false)
  })

  it("syncs the per-project file when project meta exists", async () => {
    mocks.loadNovelProjectMeta.mockResolvedValue({ title: "T", novelMode: false })
    await saveNovelMode(true, "p1", "C:/p")
    expect(mocks.saveNovelProjectMeta).toHaveBeenCalledWith("C:/p", expect.objectContaining({ novelMode: true }))
  })

  it("skips the meta write when project meta is null", async () => {
    mocks.loadNovelProjectMeta.mockResolvedValue(null)
    await expect(saveNovelMode(true, "p1", "C:/p")).resolves.toBeUndefined()
    expect(mocks.saveNovelProjectMeta).not.toHaveBeenCalled()
  })

  it("tolerates project-meta failures on save and load", async () => {
    mocks.loadNovelProjectMeta.mockRejectedValue(new Error("meta boom"))
    await expect(saveNovelMode(true, "p1", "C:/p")).resolves.toBeUndefined()
    // meta 读取失败 → 回落到项目级 store（saveNovelMode 已写入 p1=true）
    await expect(loadNovelMode("p1", "C:/p")).resolves.toBe(true)
  })

  it("reads novel mode from project meta when present", async () => {
    mocks.loadNovelProjectMeta.mockResolvedValue({ title: "T", novelMode: true })
    await expect(loadNovelMode("p1", "C:/p")).resolves.toBe(true)
    mocks.loadNovelProjectMeta.mockResolvedValue({ title: "T" })
    await expect(loadNovelMode("p1", "C:/p")).resolves.toBeNull()
  })
})

describe("revision feedback window config", () => {
  beforeEach(() => {
    mocks.clearStore()
    vi.clearAllMocks()
    mocks.readFile.mockRejectedValue(new Error("no file"))
    mocks.fileExists.mockResolvedValue(false)
    mocks.writeFile.mockResolvedValue(undefined)
  })

  it("round-trips with project/global keys and file persistence", async () => {
    const config = {
      currentChapterIncludeShouldImprove: false,
      previousChapterCarryEnabled: false,
      lookbackChapterCount: 4,
      lookbackIncludeMustFixOnly: false,
    }
    await saveRevisionFeedbackWindowConfig(config, "p1", "C:/p")
    expect(mocks.writeFile).toHaveBeenCalledWith("C:/p/.qmai/revision-feedback-config.json", expect.any(String))
    await expect(loadRevisionFeedbackWindowConfig("p1")).resolves.toEqual(config)
    await expect(loadRevisionFeedbackWindowConfig()).resolves.toEqual(config)
  })

  it("loads the file first and normalizes partial configs", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify({ lookbackChapterCount: 7 }))
    const config = await loadRevisionFeedbackWindowConfig("p1", "C:/p")
    expect(config).toEqual({
      currentChapterIncludeShouldImprove: true,
      previousChapterCarryEnabled: true,
      lookbackChapterCount: 7,
      lookbackIncludeMustFixOnly: true,
    })
  })

  it("returns defaults when nothing is stored, clamping negative lookbacks", async () => {
    const defaults = await loadRevisionFeedbackWindowConfig()
    expect(defaults.lookbackChapterCount).toBe(2)
    await mocks.store.set("revisionFeedbackWindowConfig", { lookbackChapterCount: -3 })
    expect((await loadRevisionFeedbackWindowConfig()).lookbackChapterCount).toBe(0)
  })

  it("tolerates failed file writes on save and migration", async () => {
    mocks.writeFile.mockRejectedValue(new Error("disk"))
    await expect(saveRevisionFeedbackWindowConfig({} as never, "p1", "C:/p")).resolves.toBeUndefined()
    await expect(loadRevisionFeedbackWindowConfig("p1", "C:/p")).resolves.toBeTruthy()
  })

  it("saves globally when no project id or path is given", async () => {
    const config = { lookbackChapterCount: 6 }
    await saveRevisionFeedbackWindowConfig(config as never)
    expect(mocks.store.set).toHaveBeenCalledWith("revisionFeedbackWindowConfig", config)
    expect(mocks.store.set).not.toHaveBeenCalledWith("projectRevisionFeedbackWindowConfigs", expect.anything())
    await expect(loadRevisionFeedbackWindowConfig()).resolves.toMatchObject({ lookbackChapterCount: 6 })
  })

  it("saves per project without a file when only the project id is given", async () => {
    await saveRevisionFeedbackWindowConfig({ lookbackChapterCount: 5 } as never, "p1")
    const stored = (await mocks.store.get("projectRevisionFeedbackWindowConfigs")) as Record<string, unknown> | undefined
    expect(stored?.["p1"]).toMatchObject({ lookbackChapterCount: 5 })
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("falls back to the global config when the project entry is missing", async () => {
    await mocks.store.set("projectRevisionFeedbackWindowConfigs", { p1: { lookbackChapterCount: 4 } })
    await mocks.store.set("revisionFeedbackWindowConfig", { lookbackChapterCount: 9 })
    const loaded = await loadRevisionFeedbackWindowConfig("p2")
    expect(loaded.lookbackChapterCount).toBe(9)
  })
})

describe("novel config", () => {
  beforeEach(() => {
    mocks.clearStore()
    vi.clearAllMocks()
    mocks.readFile.mockRejectedValue(new Error("no file"))
    mocks.fileExists.mockResolvedValue(false)
    mocks.writeFile.mockResolvedValue(undefined)
  })

  it("round-trips a full novel config and returns null when absent", async () => {
    const config = { searchTopK: 7, chapterTargetChars: 5000 }
    await saveNovelConfig(config as never)
    const loaded = await loadNovelConfig()
    expect(loaded?.searchTopK).toBe(7)
    expect(loaded?.chapterTargetChars).toBe(5000)
    await expect(loadNovelConfig().then(() => null)).resolves.toBeNull()
  })

  it("loads per-project and per-file configs", async () => {
    await saveNovelConfig({ searchTopK: 3 } as never, "p1")
    expect((await loadNovelConfig("p1"))?.searchTopK).toBe(3)
    // 文件优先
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify({ searchTopK: 9 }))
    expect((await loadNovelConfig("p1", "C:/p"))?.searchTopK).toBe(9)
    expect(mocks.writeFile).not.toHaveBeenCalled()
    // store 配置 + projectPath → 迁移写入文件
    mocks.fileExists.mockResolvedValue(false)
    await expect(loadNovelConfig("p1", "C:/p")).resolves.toMatchObject({ searchTopK: 3 })
    expect(mocks.writeFile).toHaveBeenCalledWith("C:/p/.qmai/novel-config.json", expect.any(String))
  })

  it("clamps numeric fields and applies defaults", async () => {
    await mocks.store.set("novelConfig", {
      contextTokenBudget: -5,
      recentSummaryWindow: 99,
      searchTopK: 0,
      chapterTargetChars: 100,
      entityBoostWeight: 5,
      communitySummaryInterval: 0,
    })
    const c = (await loadNovelConfig())!
    expect(c.contextTokenBudget).toBe(0)
    expect(c.recentSummaryWindow).toBe(30)
    expect(c.searchTopK).toBe(1)
    expect(c.chapterTargetChars).toBe(500)
    expect(c.entityBoostWeight).toBe(1)
    expect(c.communitySummaryInterval).toBe(1)
    expect(c.autoIngestOnSave).toBe(true)
    expect(c.sceneBreakdownEnabled).toBe(false)
    expect(c.relatedChaptersEnabled).toBe(true)
    expect(c.reviewReasoningEffort).toBe("high")
  })

  it("tolerates failed file reads and writes", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockRejectedValue(new Error("boom"))
    await expect(loadNovelConfig("p1", "C:/p")).resolves.toBeNull()
    mocks.writeFile.mockRejectedValue(new Error("disk"))
    await expect(saveNovelConfig({} as never, "p1", "C:/p")).resolves.toBeUndefined()
    // 文件读取失败 → 回落 store（p1 已存 {} → normalize 为默认全量配置，非 null）
    await expect(loadNovelConfig("p1", "C:/p")).resolves.toMatchObject({ contextTokenBudget: expect.any(Number) })
  })
})

describe("rerank config", () => {
  beforeEach(() => {
    mocks.clearStore()
    vi.clearAllMocks()
    mocks.readFile.mockRejectedValue(new Error("no file"))
    mocks.fileExists.mockResolvedValue(false)
    mocks.writeFile.mockResolvedValue(undefined)
  })

  it("round-trips and returns null when absent", async () => {
    const config = { enabled: true, model: "reranker", maxCandidates: 20 }
    await saveRerankConfig(config as never)
    const loaded = await loadRerankConfig()
    expect(loaded?.enabled).toBe(true)
    expect(loaded?.maxCandidates).toBe(20)
    await expect(loadRerankConfig().then(() => null)).resolves.toBeNull()
  })

  it("loads from the per-project file and clamps maxCandidates", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify({ maxCandidates: 2 }))
    expect((await loadRerankConfig("p1", "C:/p"))?.maxCandidates).toBe(3)
    await mocks.store.set("projectRerankConfigs", { p1: { maxCandidates: 99 } })
    expect((await loadRerankConfig("p1"))?.maxCandidates).toBe(30)
  })

  it("tolerates failed file reads and migration writes", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockRejectedValue(new Error("boom"))
    await expect(loadRerankConfig("p1", "C:/p")).resolves.toBeNull()
    mocks.writeFile.mockRejectedValue(new Error("disk"))
    await expect(loadRerankConfig("p1", "C:/p")).resolves.toBeNull()
  })

  it("saves per-project config into the shared map and tolerates file write failures", async () => {
    const config = { enabled: true, model: "reranker", maxCandidates: 8 }
    // projectId without projectPath — merged into the per-project map
    await saveRerankConfig(config as never, "p1")
    const stored = (await mocks.store.get("projectRerankConfigs")) as Record<string, unknown> | undefined
    expect(stored?.["p1"]).toMatchObject({ model: "reranker" })

    // projectId + projectPath — also writes the per-project file; a failing
    // write is non-critical
    mocks.writeFile.mockRejectedValue(new Error("disk full"))
    await expect(saveRerankConfig(config as never, "p1", "C:/p")).resolves.toBeUndefined()

    // merging into an existing map entry
    await saveRerankConfig({ enabled: false } as never, "p2")
    const again = (await mocks.store.get("projectRerankConfigs")) as Record<string, unknown> | undefined
    expect(Object.keys(again ?? {})).toEqual(["p1", "p2"])
  })

  it("loads the per-project map entry and normalizes a config without maxCandidates", async () => {
    await mocks.store.set("projectRerankConfigs", { p1: { enabled: true, model: "m" } })
    const loaded = await loadRerankConfig("p1")
    expect(loaded?.model).toBe("m")
    // maxCandidates falls back to the default
    expect(loaded?.maxCandidates).toBe(12)
  })

  it("migrates a stored config into the per-project file", async () => {
    await mocks.store.set("projectRerankConfigs", { p1: { enabled: true, model: "m" } })
    await loadRerankConfig("p1", "C:/p")
    expect(mocks.writeFile).toHaveBeenCalledWith(
      "C:/p/.qmai/rerank-config.json",
      expect.stringContaining('"model": "m"'),
    )
  })
})

describe("theme and ui settings", () => {
  beforeEach(() => {
    mocks.clearStore()
    vi.clearAllMocks()
  })

  it("round-trips the theme", async () => {
    await saveTheme("dark")
    await expect(loadTheme()).resolves.toBe("dark")
    await expect(loadTheme().then(() => null)).resolves.toBeNull()
  })

  it("stores ui font scale and max history messages with flush", async () => {
    await saveUiFontSizeScale(1.1)
    expect(mocks.store.save).toHaveBeenCalled()
    await saveMaxHistoryMessages(200)
    await expect(loadMaxHistoryMessages()).resolves.toBe(200)
    await expect(loadMaxHistoryMessages().then(() => null)).resolves.toBeNull()
  })
})

describe("empty-store fallbacks", () => {
  beforeEach(() => {
    mocks.clearStore()
    vi.clearAllMocks()
  })

  it("returns null when the store has no value for each config key", async () => {
    await expect(loadLlmConfig()).resolves.toBeNull()
    await expect(loadAiChatModel()).resolves.toBeNull()
    await expect(loadDefaultLlmModel()).resolves.toBeNull()
    await expect(loadProviderConfigs()).resolves.toBeNull()
    await expect(loadSearchApiConfig()).resolves.toBeNull()
    await expect(loadEmbeddingConfig()).resolves.toBeNull()
    await expect(loadMultimodalConfig()).resolves.toBeNull()
    await expect(loadProxyConfig()).resolves.toBeNull()
    await expect(loadLanguage()).resolves.toBeNull()
    await expect(loadOutputLanguage()).resolves.toBeNull()
    await expect(loadNovelMode()).resolves.toBeNull()
    await expect(loadTheme()).resolves.toBeNull()
    await expect(loadMaxHistoryMessages()).resolves.toBeNull()
  })

  it("saveProjectFileSyncEnabled falls back to {} when nothing is stored", async () => {
    // Both save paths start from an empty store so the `?? {}` fallback runs
    // (no-projectId call first, then the per-project call).
    await saveProjectFileSyncEnabled(true)
    expect(await mocks.store.get("projectFileSyncEnabled")).toEqual({ default: true })
    await saveProjectFileSyncEnabled(false, "p1")
    expect(await mocks.store.get("projectFileSyncEnabled")).toEqual({ default: true, p1: false })
  })

  it("removeFromRecentProjects tolerates an empty recents list", async () => {
    await removeFromRecentProjects("C:/p")
    expect(await getRecentProjects()).toEqual([])
  })
})

describe("getRecentProjects", () => {
  it("returns [] when absent", async () => {
    await expect(getRecentProjects()).resolves.toEqual([])
  })
})
