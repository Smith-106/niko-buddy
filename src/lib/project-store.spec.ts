import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  addToRecentProjects,
  getLastProject,
  getRecentProjects,
  loadAiChatModel,
  loadActivePresetId,
  loadAiWorkflowMode,
  loadDefaultLlmModel,
  loadMcpConfig,
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
  saveAiWorkflowMode,
  saveDefaultLlmModel,
  saveMcpConfig,
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
  __resetWritingModelDeprecationWarningsForTest,
} from "./project-store"
import { getDiscardedWritingConfig } from "./discarded-writing-config-notice"
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

vi.mock("@/lib/web-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/web-store")>()
  return {
    ...actual,
      getStore: async () => mocks.store,
    
  }
})

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
vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>()
  return {
    ...actual, isTauri: () => false 
  }
})

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      readFile: mocks.readFile,
      writeFile: mocks.writeFile,
      fileExists: mocks.fileExists,
    
  }
})

vi.mock("@/lib/novel/project-meta", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/project-meta")>()
  return {
    ...actual,
      loadNovelProjectMeta: mocks.loadNovelProjectMeta,
      saveNovelProjectMeta: mocks.saveNovelProjectMeta,
    
  }
})

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
    expect(mocks.writeFile).toHaveBeenCalledWith("C:/p/.niko-buddy/source-watch-config.json", expect.any(String))
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
    expect(mocks.writeFile).toHaveBeenCalledWith("C:/p/.niko-buddy/revision-feedback-config.json", expect.any(String))
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
    expect(mocks.writeFile).toHaveBeenCalledWith("C:/p/.niko-buddy/novel-config.json", expect.any(String))
  })

  it("rejects configs that try to disable safety invariants (P1-IMP-01)", async () => {
    await saveNovelConfig({ fold_atomic_fsync: false } as never)
    await expect(loadNovelConfig()).rejects.toThrow()
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify({ promotion_require_accept: false }))
    await expect(loadNovelConfig("p1", "C:/p")).rejects.toThrow()
    // 常规配置键不误伤
    mocks.readFile.mockResolvedValue(JSON.stringify({ searchTopK: 12 }))
    await expect(loadNovelConfig("p1", "C:/p")).resolves.toMatchObject({ searchTopK: 12 })
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

  it("F11-2：journalTtlMs 稀疏透传（显式正数保留；缺席/非法→undefined=走全局链）", async () => {
    await saveNovelConfig({ journalTtlMs: 600_000 } as never)
    expect((await loadNovelConfig())?.journalTtlMs).toBe(600_000)
    await saveNovelConfig({} as never)
    expect((await loadNovelConfig())?.journalTtlMs).toBeUndefined()
    await saveNovelConfig({ journalTtlMs: -5 } as never)
    expect((await loadNovelConfig())?.journalTtlMs).toBeUndefined()
  })

  // ── DEC-R5=A：writingModel 废弃迁移日志。
  //   契约：只告警不阻断、不改返回结构、命中才 warn、同作用域进程内只 warn 一次。
  it("含旧键 writingModel → warn 一条中文迁移提示，且不阻断载入、不带回该键", async () => {
    __resetWritingModelDeprecationWarningsForTest()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    // 旧版本落盘的原样配置（字段与值都在）—— 绕过 saveNovelConfig 直接进 store
    await mocks.store.set("projectNovelConfigs", {
      "legacy-project": { searchTopK: 4, writingModel: "gpt-4-legacy" },
    })

    const loaded = await loadNovelConfig("legacy-project")

    // 不阻断：仍返回完整配置，业务键照常生效
    expect(loaded?.searchTopK).toBe(4)
    expect(loaded?.chapterTargetChars).toBeGreaterThan(0)
    // 值被丢弃：白名单重建不把旧键带回来
    expect(loaded && Object.prototype.hasOwnProperty.call(loaded, "writingModel")).toBe(false)

    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0][0])
    expect(message).toContain("writingModel")
    expect(message).toContain("废弃")
    expect(message).toContain("丢弃")
    expect(message).toContain("legacy-project") // 带项目标识
    warn.mockRestore()
  })

  it("不含旧键 → 静默（不 warn），避免每次载入刷屏", async () => {
    __resetWritingModelDeprecationWarningsForTest()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await mocks.store.set("projectNovelConfigs", { "clean-project": { searchTopK: 5 } })

    const loaded = await loadNovelConfig("clean-project")

    expect(loaded?.searchTopK).toBe(5)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it("旧键值为空串也算旧数据：仍告警（旧版本会主动落盘 writingModel: \"\"）", async () => {
    __resetWritingModelDeprecationWarningsForTest()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await mocks.store.set("projectNovelConfigs", {
      "empty-legacy-project": { searchTopK: 6, writingModel: "" },
    })

    expect((await loadNovelConfig("empty-legacy-project"))?.searchTopK).toBe(6)

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('""') // 值被原样带入提示
    warn.mockRestore()
  })

  it("配置是非对象的脏数据（数字/字符串）时不告警、不登记、按默认值重建", async () => {
    // store 里的旧值可能被手工改坏成标量：pickInvariantOverrides 对非对象返回 {}，
    // 因此载入流程能继续；warnDeprecatedWritingModel 的 typeof 守卫在此短路，
    // 不把标量当 hasOwnProperty 宿主（否则会抛）。可观察结论：无迁移告警、无留痕、
    // 返回的是完整默认配置而不是标量或 null。
    __resetWritingModelDeprecationWarningsForTest()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      for (const [scope, dirty] of [["scalar-number", 42], ["scalar-string", "oops"]] as const) {
        await mocks.store.set("projectNovelConfigs", { [scope]: dirty })
        const loaded = await loadNovelConfig(scope)
        expect(loaded?.searchTopK).toBeGreaterThan(0)
        expect(loaded?.chapterTargetChars).toBeGreaterThan(0)
        expect(getDiscardedWritingConfig(scope)).toBeNull()
      }
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it("同一项目重复载入只 warn 一次（进程内按作用域去重）", async () => {
    __resetWritingModelDeprecationWarningsForTest()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await mocks.store.set("projectNovelConfigs", {
      "repeat-project": { searchTopK: 7, writingModel: "gpt-4" },
    })

    await loadNovelConfig("repeat-project")
    await loadNovelConfig("repeat-project")
    await loadNovelConfig("repeat-project")

    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it("去重粒度是项目而非进程：不同项目各自告警一次", async () => {
    __resetWritingModelDeprecationWarningsForTest()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await mocks.store.set("projectNovelConfigs", {
      "proj-a": { writingModel: "gpt-4" },
      "proj-b": { writingModel: "claude-legacy" },
    })

    await loadNovelConfig("proj-a")
    await loadNovelConfig("proj-a")
    await loadNovelConfig("proj-b")

    expect(warn).toHaveBeenCalledTimes(2)
    expect(String(warn.mock.calls[0][0])).toContain("proj-a")
    expect(String(warn.mock.calls[1][0])).toContain("proj-b")
    warn.mockRestore()
  })

  it("项目文件（.niko-buddy/novel-config.json）里的旧键也告警，标识带文件路径", async () => {
    __resetWritingModelDeprecationWarningsForTest()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(
      JSON.stringify({ searchTopK: 2, writingModel: "claude-legacy" }),
    )

    const loaded = await loadNovelConfig("file-project", "C:/legacy-proj")

    expect(loaded?.searchTopK).toBe(2)
    expect(loaded && Object.prototype.hasOwnProperty.call(loaded, "writingModel")).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain("C:/legacy-proj")
    warn.mockRestore()
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
      "C:/p/.niko-buddy/rerank-config.json",
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

// ── DEBT-residual-04「留痕 + 告知」的 **跨模块** 契约（RV-002 / RV-008）。
//
// 上一版的缺陷正是这一段缺失造成的：写侧把人类可读作用域串（`项目文件 <path>`）当 key，
// 读侧用裸项目路径查，两两不可能相等，`getDiscardedWritingConfig` 恒返回 null，
// 设置页横幅在生产环境一次都不会渲染 —— 而组件 spec 自己构造 key，掩盖了它。
//
// 所以这里必须走 `loadNovelConfig`（真实写侧），再断言**读侧同一函数**能查到。
describe("DEBT-residual-04：留痕的写读 key 契约", () => {
  it("项目文件里的旧键 → 用同一项目路径能查到留痕（含原值与作用域标签）", async () => {
    __resetWritingModelDeprecationWarningsForTest()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(
      JSON.stringify({ searchTopK: 2, writingModel: "deepseek/muse-spark-1.3-contributor-free" }),
    )

    await loadNovelConfig("file-project-2", "C:/notice-proj")

    const notice = getDiscardedWritingConfig("C:/notice-proj")
    expect(notice).not.toBeNull()
    expect(notice?.value).toBe("deepseek/muse-spark-1.3-contributor-free")
    expect(notice?.label).toContain("项目文件") // 人类可读作用域降级为 label，只用于诊断
    warn.mockRestore()
  })

  it("路径分隔符与尾斜杠归一化：反斜杠与尾斜杠等价于正斜杠", async () => {
    __resetWritingModelDeprecationWarningsForTest()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.fileExists.mockResolvedValue(true)
    // 用 charCode 拼反斜杠：避免源码里出现转义歧义
    const BS = String.fromCharCode(92)
    const winPath = `C:${BS}proj${BS}`
    mocks.readFile.mockResolvedValue(JSON.stringify({ writingModel: "legacy-a" }))

    await loadNovelConfig("norm-project", winPath)

    expect(getDiscardedWritingConfig("C:/proj")?.value).toBe("legacy-a")
    expect(getDiscardedWritingConfig("C:/proj/")?.value).toBe("legacy-a")
    expect(getDiscardedWritingConfig(`C:${BS}proj`)?.value).toBe("legacy-a")
    warn.mockRestore()
  })

  it("没有项目路径（纯 store 配置）→ 落到全局哨兵，能用空路径查到", async () => {
    __resetWritingModelDeprecationWarningsForTest()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await mocks.store.set("projectNovelConfigs", {
      "global-fallback": { writingModel: "gpt-4-global" },
    })

    await loadNovelConfig("global-fallback")

    expect(getDiscardedWritingConfig(undefined)?.value).toBe("gpt-4-global")
    expect(getDiscardedWritingConfig(null)?.value).toBe("gpt-4-global")
    warn.mockRestore()
  })

  it("不同项目的留痕互不串台", async () => {
    __resetWritingModelDeprecationWarningsForTest()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValueOnce(JSON.stringify({ writingModel: "proj-a-model" }))
    await loadNovelConfig("iso-a", "C:/iso-a")
    mocks.readFile.mockResolvedValueOnce(JSON.stringify({ writingModel: "proj-b-model" }))
    await loadNovelConfig("iso-b", "C:/iso-b")

    expect(getDiscardedWritingConfig("C:/iso-a")?.value).toBe("proj-a-model")
    expect(getDiscardedWritingConfig("C:/iso-b")?.value).toBe("proj-b-model")
    expect(getDiscardedWritingConfig("C:/iso-c")).toBeNull()
    warn.mockRestore()
  })

  it("旧键值为空串时也留痕（value 为空串，供 UI 自行决定不展示）", async () => {
    __resetWritingModelDeprecationWarningsForTest()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify({ writingModel: "" }))

    await loadNovelConfig("empty-project", "C:/empty-proj")

    expect(getDiscardedWritingConfig("C:/empty-proj")?.value).toBe("")
    warn.mockRestore()
  })
})

// RV2-001（第二轮独立复核 high）：上面 5 条只钉住了**文件分支**。
// 变异实验证明：让项目 store 分支或全局回退分支漏传 projectPath，整套 spec 依然全绿。
// 而全局回退分支恰恰是**最常见的生产路径**（项目从未落过 novel 配置文件时走它），
// 一旦漏传，留痕落到 __global__ 哨兵、横幅用真实项目路径查 → 永不渲染，
// 与 RV-002 完全同一个 failure mode。下面两条各自钉一个变异点。
describe("DEBT-residual-04：另两个写侧分支也必须按项目留痕（RV2-001）", () => {
  it("项目 store 分支（projectNovelConfigs[projectId] 命中）→ 登在项目 key 下，不是全局哨兵", async () => {
    __resetWritingModelDeprecationWarningsForTest()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.fileExists.mockResolvedValue(false) // 没有 novel 配置文件 → 走 store 分支
    await mocks.store.set("projectNovelConfigs", {
      "store-proj": { searchTopK: 5, writingModel: "store-branch-model" },
    })

    await loadNovelConfig("store-proj", "C:/store-proj")

    expect(getDiscardedWritingConfig("C:/store-proj")?.value).toBe("store-branch-model")
    // 关键：不能落到全局哨兵（漏传 projectPath 时就会）
    expect(getDiscardedWritingConfig(undefined)).toBeNull()
    warn.mockRestore()
  })

  it("全局回退分支（项目无自有配置，只有全局 old key）→ 仍登在该项目 key 下", async () => {
    __resetWritingModelDeprecationWarningsForTest()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.fileExists.mockResolvedValue(false)
    // 没有 projectNovelConfigs 条目 → 回退到全局配置，这里带旧键
    await mocks.store.set("novelConfig", { searchTopK: 9, writingModel: "global-fallback-model" })

    await loadNovelConfig("fallback-proj", "C:/fallback-proj")

    // 最重要的生产路径：留痕必须挂在**该项目**下，横幅才查得到
    expect(getDiscardedWritingConfig("C:/fallback-proj")?.value).toBe("global-fallback-model")
    expect(getDiscardedWritingConfig(undefined)).toBeNull()
    warn.mockRestore()
  })
})

describe("saveAiWorkflowMode / loadAiWorkflowMode（应用级单键偏好）", () => {
  beforeEach(() => {
    mocks.clearStore()
  })

  it("未设置时读出 null（归一化留给 resolveAiWorkflowMode）", async () => {
    await expect(loadAiWorkflowMode()).resolves.toBeNull()
  })

  it("保存后原值读回", async () => {
    await saveAiWorkflowMode("strict")
    await expect(loadAiWorkflowMode()).resolves.toBe("strict")
    await saveAiWorkflowMode("fast")
    await expect(loadAiWorkflowMode()).resolves.toBe("fast")
  })
})

describe("saveMcpConfig / loadMcpConfig（归一化落盘）", () => {
  beforeEach(() => {
    mocks.clearStore()
  })

  it("未设置时读出 null", async () => {
    await expect(loadMcpConfig()).resolves.toBeNull()
  })

  it("非法输入归一为默认空配置后读回", async () => {
    await saveMcpConfig({ servers: [{ id: "g", name: "图谱" }] } as never)
    const loaded = await loadMcpConfig()
    expect(loaded?.servers).toHaveLength(1)
    expect(loaded?.servers[0].id).toBe("g")
    expect(loaded?.servers[0].enabled).toBe(true)
  })

  it("缺 id/name 的 server 条目被过滤", async () => {
    await saveMcpConfig({ servers: [{ id: "", name: "" }, { id: "ok", name: "可用" }] } as never)
    const loaded = await loadMcpConfig()
    expect(loaded?.servers.map((s) => s.id)).toEqual(["ok"])
  })
})
