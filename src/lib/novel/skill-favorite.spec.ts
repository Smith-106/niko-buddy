/**
 * skill-favorite.ts 行为测试（替代 C4 空壳）。
 * 覆盖：快照映射、全局/项目分轨加载、串行化保存、损坏条目过滤。
 * 零真实 IO：@/lib/web-store + @/commands/fs + @tauri-apps/api/path.join 均 mock。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const storeMocks = vi.hoisted(() => {
  const data: Record<string, unknown> = {}
  return {
    data,
    get: vi.fn(async (k: string) => (k in data ? data[k] : null)),
    set: vi.fn(async (k: string, v: unknown) => {
      data[k] = v
    }),
    save: vi.fn(async () => {}),
    reset() {
      for (const k of Object.keys(data)) delete data[k]
    },
  }
})

vi.mock("@/lib/web-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/web-store")>()
  return {
    ...actual,
    getStore: vi.fn(async () => storeMocks),
  }
})

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(async () => {}),
  createDirectory: vi.fn(async () => {}),
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

vi.mock("@tauri-apps/api/path", () => ({
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}))

import {
  buildWritingSnapshot,
  buildDeAiSnapshot,
  loadFavorites,
  saveFavorites,
  type FavoriteSkillEntry,
} from "./skill-favorite"
import type { UserSkill } from "./skill-library"
import type { DeAiSkill } from "./de-ai-skill-library"

function writingSkill(overrides: Partial<UserSkill> = {}): UserSkill {
  return {
    id: "skill:1",
    name: "承接",
    description: "承接描述",
    kind: ["structure"],
    stages: ["planning"],
    modes: ["standard"],
    content: "正文",
    source: "uploaded",
    priority: 50,
    tags: [],
    categoryId: "c1",
    ...overrides,
  }
}

function deAiSkill(overrides: Partial<DeAiSkill> = {}): DeAiSkill {
  return {
    id: "built-in:comprehensive",
    name: "综合去AI味",
    description: "去味描述",
    templateId: "comprehensive",
    content: "规则正文",
    source: "built-in",
    ...overrides,
  }
}

function entry(overrides: Partial<FavoriteSkillEntry> = {}): FavoriteSkillEntry {
  return {
    favoriteId: "fav-1",
    library: "writing",
    skillId: "skill:1",
    originProjectPath: "",
    source: "uploaded",
    snapshot: {
      name: "承接",
      description: "承接描述",
      content: "正文",
      kind: ["structure"],
      stages: ["planning"],
      modes: ["standard"],
      category: "大纲",
      templateId: "",
    },
    favoritedAt: 1700000000000,
    ...overrides,
  }
}

beforeEach(() => {
  storeMocks.reset()
  storeMocks.get.mockClear()
  storeMocks.set.mockClear()
  storeMocks.save.mockClear()
  fsMocks.readFile.mockReset()
  fsMocks.readFile.mockRejectedValue(new Error("missing"))
  fsMocks.writeFileAtomic.mockReset()
  fsMocks.writeFileAtomic.mockResolvedValue(undefined)
  fsMocks.createDirectory.mockReset()
  fsMocks.createDirectory.mockResolvedValue(undefined)
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

describe("buildWritingSnapshot", () => {
  it("透传技能字段并按 categoryId 反查分类名", () => {
    const snap = buildWritingSnapshot(
      writingSkill(),
      "加载到的正文",
      [{ id: "c1", name: "大纲" }],
    )
    expect(snap).toEqual({
      name: "承接",
      description: "承接描述",
      content: "加载到的正文",
      kind: ["structure"],
      stages: ["planning"],
      modes: ["standard"],
      category: "大纲",
      templateId: "",
    })
  })

  it("categoryId 命中失败 → category 为空字符串", () => {
    expect(buildWritingSnapshot(writingSkill({ categoryId: "ghost" }), "c", []).category).toBe("")
    expect(buildWritingSnapshot(writingSkill({ categoryId: "" }), "c", []).category).toBe("")
  })
})

describe("buildDeAiSnapshot", () => {
  it("硬编码 kind/stages/modes/分类，透传其余字段", () => {
    expect(buildDeAiSnapshot(deAiSkill(), "规则全文")).toEqual({
      name: "综合去AI味",
      description: "去味描述",
      content: "规则全文",
      kind: ["style"],
      stages: ["rewrite", "output"],
      modes: ["fast", "standard", "strict"],
      category: "去AI味",
      templateId: "comprehensive",
    })
  })
})

describe("loadFavorites", () => {
  it("无 projectPath：仅返回全局收藏", async () => {
    storeMocks.data["favoriteSkills"] = { version: 1, favorites: [entry(), entry({ favoriteId: "fav-2" })] }
    const config = await loadFavorites()
    expect(config.version).toBe(1)
    expect(config.favorites.map((f) => f.favoriteId)).toEqual(["fav-1", "fav-2"])
    expect(fsMocks.readFile).not.toHaveBeenCalled()
  })

  it("空字符串 projectPath 视为无项目：不读项目文件", async () => {
    storeMocks.data["favoriteSkills"] = { version: 1, favorites: [entry()] }
    const config = await loadFavorites("")
    expect(config.favorites).toHaveLength(1)
    expect(fsMocks.readFile).not.toHaveBeenCalled()
  })

  it("store 为空 → 空配置", async () => {
    expect(await loadFavorites()).toEqual({ version: 1, favorites: [] })
  })

  it("store 形状非法（无 favorites 数组）→ 空全局", async () => {
    storeMocks.data["favoriteSkills"] = { version: 1, favorites: "nope" }
    expect(await loadFavorites()).toEqual({ version: 1, favorites: [] })
    storeMocks.data["favoriteSkills"] = null
    expect(await loadFavorites()).toEqual({ version: 1, favorites: [] })
  })

  it("非法条目被过滤：非对象、缺字段、snapshot 为 null", async () => {
    storeMocks.data["favoriteSkills"] = {
      version: 1,
      favorites: [
        entry(),
        "字符串条目",
        null,
        { ...entry(), favoriteId: 123 },
        { ...entry(), favoritedAt: "昨天" },
        { ...entry(), snapshot: null },
        { ...entry(), library: 42 },
      ],
    }
    const config = await loadFavorites()
    expect(config.favorites.map((f) => f.favoriteId)).toEqual(["fav-1"])
  })

  it("带 projectPath：全局 + 项目合并", async () => {
    storeMocks.data["favoriteSkills"] = { version: 1, favorites: [entry()] }
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p === "proj/.niko-buddy/skill-favorites.json") {
        return JSON.stringify({ version: 1, favorites: [entry({ favoriteId: "pfav", originProjectPath: "proj" })] })
      }
      throw new Error("missing")
    })
    const config = await loadFavorites("proj")
    expect(config.favorites.map((f) => f.favoriteId)).toEqual(["fav-1", "pfav"])
  })

  it("项目文件缺失/损坏/形状非法 → 仅全局", async () => {
    storeMocks.data["favoriteSkills"] = { version: 1, favorites: [entry()] }
    fsMocks.readFile.mockRejectedValue(new Error("gone"))
    expect(await loadFavorites("proj")).toMatchObject({ favorites: [expect.objectContaining({ favoriteId: "fav-1" })] })

    fsMocks.readFile.mockResolvedValue("{broken")
    await expect((await loadFavorites("proj")).favorites).toHaveLength(1)

    fsMocks.readFile.mockResolvedValue(JSON.stringify({ version: 1, favorites: [entry({ favoriteId: "bad" }), "junk"] }))
    const merged = await loadFavorites("proj")
    expect(merged.favorites.map((f) => f.favoriteId)).toEqual(["fav-1", "bad"])

    fsMocks.readFile.mockResolvedValue(JSON.stringify({ version: 1, favorites: "nope" }))
    expect(await loadFavorites("proj")).toMatchObject({ favorites: [expect.objectContaining({ favoriteId: "fav-1" })] })
    fsMocks.readFile.mockResolvedValue("null")
    expect((await loadFavorites("proj")).favorites).toHaveLength(1)
  })

  it("store 抛错 → 空配置并记 warn", async () => {
    const { getStore } = await import("@/lib/web-store")
    vi.mocked(getStore).mockRejectedValueOnce(new Error("store down"))
    expect(await loadFavorites()).toEqual({ version: 1, favorites: [] })
    expect(console.warn).toHaveBeenCalled()
  })
})

describe("saveFavorites", () => {
  it("纯全局收藏：只写 KV，不写项目文件", async () => {
    await saveFavorites({ version: 1, favorites: [entry(), entry({ favoriteId: "fav-2" })] })
    expect(storeMocks.set).toHaveBeenCalledWith("favoriteSkills", {
      version: 1,
      favorites: [expect.objectContaining({ favoriteId: "fav-1" }), expect.objectContaining({ favoriteId: "fav-2" })],
    })
    expect(storeMocks.save).toHaveBeenCalled()
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("混合收藏 + projectPath：分轨落盘（全局→KV，项目→文件）", async () => {
    const config = {
      version: 1 as const,
      favorites: [entry(), entry({ favoriteId: "pfav", originProjectPath: "proj" })],
    }
    await saveFavorites(config, "proj")
    const kvArg = storeMocks.set.mock.calls[0][1] as { favorites: FavoriteSkillEntry[] }
    expect(kvArg.favorites.map((f) => f.favoriteId)).toEqual(["fav-1"])
    expect(fsMocks.createDirectory).toHaveBeenCalledWith("proj/.niko-buddy")
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    const [path, text] = fsMocks.writeFileAtomic.mock.calls[0] as unknown as [string, string]
    expect(path).toBe("proj/.niko-buddy/skill-favorites.json")
    const fileArg = JSON.parse(text) as { favorites: FavoriteSkillEntry[] }
    expect(fileArg.favorites.map((f) => f.favoriteId)).toEqual(["pfav"])
  })

  it("projectPath 有值但无项目收藏 → 不写项目文件", async () => {
    await saveFavorites({ version: 1, favorites: [entry()] }, "proj")
    expect(storeMocks.set).toHaveBeenCalledTimes(1)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("项目落盘失败 → 回退重试全局 KV 并成功返回", async () => {
    fsMocks.writeFileAtomic.mockRejectedValue(new Error("disk full"))
    const config = {
      version: 1 as const,
      favorites: [entry(), entry({ favoriteId: "pfav", originProjectPath: "proj" })],
    }
    await saveFavorites(config, "proj")
    // 首次全局 + catch 回退重试各一次
    expect(storeMocks.set).toHaveBeenCalledTimes(2)
  })

  it("连续两次保存串行化：第二次排队等待第一次", async () => {
    const order: string[] = []
    storeMocks.set.mockImplementation(async (k: string, v: unknown) => {
      order.push("set")
      storeMocks.data[k] = v
    })
    await saveFavorites({ version: 1, favorites: [entry()] })
    await saveFavorites({ version: 1, favorites: [entry({ favoriteId: "fav-2" })] })
    expect(order).toEqual(["set", "set"])
    const last = storeMocks.data["favoriteSkills"] as { favorites: FavoriteSkillEntry[] }
    expect(last.favorites[0].favoriteId).toBe("fav-2")
  })
})
