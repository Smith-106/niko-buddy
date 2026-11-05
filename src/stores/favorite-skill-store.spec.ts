/**
 * favorite-skill-store.ts 行为测试（替代 C4 空壳，原位重写）。
 * 覆盖：load 分轨守卫、toggle 收藏/取消（writing 链接固化、de-ai 内置原版替换、
 * 快照分支、乐观更新回滚）、removeFavorite、isFavorited、copyToCurrentProject
 * 全 reason 分支。零真实 IO：@/lib/novel 的 IO 函数、toast、wiki-store 均 mock；
 * 快照 builder 与内置去 AI 味常量用真实实现以断言替换语义。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}))
vi.mock("@/lib/toast", () => ({
  toast: toastMocks,
}))

const wikiMocks = vi.hoisted(() => ({
  project: null as { path: string } | null,
  bumpDataVersion: vi.fn(),
}))
vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: {
      getState: () => ({
        project: wikiMocks.project,
        bumpDataVersion: wikiMocks.bumpDataVersion,
      }),
    },
  }
})

const novelMocks = vi.hoisted(() => ({
  loadFavorites: vi.fn(),
  saveFavorites: vi.fn(),
  loadLinkedSkillContent: vi.fn(),
  loadUserSkillConfig: vi.fn(),
  saveUserSkillConfig: vi.fn(),
  loadDeAiSkillConfig: vi.fn(),
  saveDeAiSkillConfig: vi.fn(),
}))
vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    loadFavorites: novelMocks.loadFavorites,
    saveFavorites: novelMocks.saveFavorites,
    loadLinkedSkillContent: novelMocks.loadLinkedSkillContent,
    loadUserSkillConfig: novelMocks.loadUserSkillConfig,
    saveUserSkillConfig: novelMocks.saveUserSkillConfig,
    loadDeAiSkillConfig: novelMocks.loadDeAiSkillConfig,
    saveDeAiSkillConfig: novelMocks.saveDeAiSkillConfig,
  }
})

import { useFavoriteSkillStore } from "./favorite-skill-store"
import { BUILT_IN_DE_AI_SKILLS, DEFAULT_SKILL_PRIORITY } from "@/lib/novel"
import type { DeAiSkill, UserSkill } from "@/lib/novel"

function resetStore() {
  useFavoriteSkillStore.setState({
    favorites: [],
    currentProjectPath: "",
    loaded: false,
    loading: false,
  })
}

function writingSkill(overrides: Partial<UserSkill> = {}): UserSkill {
  return {
    id: "skill:1",
    name: "承接",
    description: "承接描述",
    kind: ["structure"],
    stages: ["planning"],
    modes: ["standard"],
    content: "正文内容",
    source: "uploaded",
    priority: 50,
    tags: [],
    categoryId: "c1",
    ...overrides,
  }
}

function deAiSkill(overrides: Partial<DeAiSkill> = {}): DeAiSkill {
  return {
    id: "project:1",
    name: "去AI味技能",
    description: "去AI味描述",
    content: "去AI味正文",
    source: "project",
    templateId: "custom",
    ...overrides,
  }
}

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
  vi.spyOn(console, "error").mockImplementation(() => {})
  wikiMocks.project = { path: "/P" }
})

async function loadEmpty() {
  novelMocks.loadFavorites.mockResolvedValue({ version: 1, favorites: [] })
  await useFavoriteSkillStore.getState().load("/P")
}

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------

describe("load", () => {
  it("loads favorites and records the project path", async () => {
    const stored = [
      {
        favoriteId: "fav-1",
        library: "writing",
        skillId: "skill:1",
        originProjectPath: "/P",
        source: "uploaded",
        snapshot: { name: "承接" },
        favoritedAt: 1,
      },
    ]
    novelMocks.loadFavorites.mockResolvedValue({ version: 1, favorites: stored })
    await useFavoriteSkillStore.getState().load("/P")
    const state = useFavoriteSkillStore.getState()
    expect(novelMocks.loadFavorites).toHaveBeenCalledWith("/P")
    expect(state.favorites).toEqual(stored)
    expect(state.currentProjectPath).toBe("/P")
    expect(state.loaded).toBe(true)
    expect(state.loading).toBe(false)
  })

  it("ignores the result when the wiki project no longer matches", async () => {
    novelMocks.loadFavorites.mockResolvedValue({ version: 1, favorites: [{ favoriteId: "x" }] })
    wikiMocks.project = { path: "/Other" }
    await useFavoriteSkillStore.getState().load("/P")
    const state = useFavoriteSkillStore.getState()
    expect(state.favorites).toEqual([])
    expect(state.loaded).toBe(false)
    expect(state.loading).toBe(false)
  })

  it("ignores the result when no wiki project is open", async () => {
    novelMocks.loadFavorites.mockResolvedValue({ version: 1, favorites: [{ favoriteId: "x" }] })
    wikiMocks.project = null
    await useFavoriteSkillStore.getState().load("/P")
    expect(useFavoriteSkillStore.getState().favorites).toEqual([])
    expect(useFavoriteSkillStore.getState().loaded).toBe(false)
  })

  it("toasts and keeps state when loading fails", async () => {
    novelMocks.loadFavorites.mockRejectedValue(new Error("disk down"))
    await useFavoriteSkillStore.getState().load("/P")
    expect(toastMocks.error).toHaveBeenCalledWith("收藏加载失败")
    const state = useFavoriteSkillStore.getState()
    expect(state.loaded).toBe(false)
    expect(state.loading).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// toggleFavorite
// ---------------------------------------------------------------------------

describe("toggleFavorite", () => {
  it("adds an uploaded writing skill with a real snapshot", async () => {
    await loadEmpty()
    novelMocks.saveFavorites.mockResolvedValue(undefined)
    await useFavoriteSkillStore
      .getState()
      .toggleFavorite({ library: "writing", skill: writingSkill(), writingCategories: [{ id: "c1", name: "开篇" }] })
    const state = useFavoriteSkillStore.getState()
    expect(state.favorites).toHaveLength(1)
    const entry = state.favorites[0]
    expect(entry.library).toBe("writing")
    expect(entry.skillId).toBe("skill:1")
    expect(entry.originProjectPath).toBe("/P")
    expect(entry.source).toBe("uploaded")
    expect(entry.favoriteId).toMatch(/^[0-9a-f-]{36}$/)
    expect(entry.snapshot.name).toBe("承接")
    expect(entry.snapshot.content).toBe("正文内容")
    expect(entry.snapshot.category).toBe("开篇")
    expect(novelMocks.saveFavorites).toHaveBeenCalledWith(
      { version: 1, favorites: state.favorites },
      "/P",
    )
    expect(toastMocks.success).toHaveBeenCalledWith("已收藏「承接」")
  })

  it("removes the entry when the same triple is toggled again", async () => {
    await loadEmpty()
    novelMocks.saveFavorites.mockResolvedValue(undefined)
    const api = () => useFavoriteSkillStore.getState()
    await api().toggleFavorite({ library: "writing", skill: writingSkill() })
    expect(api().favorites).toHaveLength(1)
    await api().toggleFavorite({ library: "writing", skill: writingSkill() })
    expect(api().favorites).toHaveLength(0)
    expect(toastMocks.success).toHaveBeenLastCalledWith("已取消收藏「承接」")
  })

  it("keeps same-skill entries from different origins as separate favorites", async () => {
    await loadEmpty()
    novelMocks.saveFavorites.mockResolvedValue(undefined)
    const api = () => useFavoriteSkillStore.getState()
    await api().toggleFavorite({ library: "writing", skill: writingSkill(), originProjectPath: "/A" })
    await api().toggleFavorite({ library: "writing", skill: writingSkill(), originProjectPath: "/B" })
    expect(api().favorites).toHaveLength(2)
  })

  it("reads linked skill content from disk before snapshotting", async () => {
    await loadEmpty()
    novelMocks.loadLinkedSkillContent.mockResolvedValue("磁盘真实正文")
    novelMocks.saveFavorites.mockResolvedValue(undefined)
    await useFavoriteSkillStore.getState().toggleFavorite({
      library: "writing",
      skill: writingSkill({ source: "linked", content: "占位" }),
    })
    expect(novelMocks.loadLinkedSkillContent).toHaveBeenCalled()
    expect(useFavoriteSkillStore.getState().favorites[0].snapshot.content).toBe("磁盘真实正文")
  })

  it("aborts with a toast when the linked file cannot be read", async () => {
    await loadEmpty()
    novelMocks.loadLinkedSkillContent.mockRejectedValue(new Error("gone"))
    await useFavoriteSkillStore.getState().toggleFavorite({
      library: "writing",
      skill: writingSkill({ source: "linked" }),
    })
    expect(useFavoriteSkillStore.getState().favorites).toHaveLength(0)
    expect(novelMocks.saveFavorites).not.toHaveBeenCalled()
    expect(toastMocks.error).toHaveBeenCalledWith("读取链接技能文件失败，无法收藏")
  })

  it("replaces a tampered built-in de-ai skill with the original", async () => {
    await loadEmpty()
    novelMocks.saveFavorites.mockResolvedValue(undefined)
    const original = BUILT_IN_DE_AI_SKILLS[0]
    const tampered: DeAiSkill = { ...original, name: "被篡改", description: "假", content: "假正文" }
    await useFavoriteSkillStore.getState().toggleFavorite({ library: "de-ai", skill: tampered })
    const snapshot = useFavoriteSkillStore.getState().favorites[0].snapshot
    expect(snapshot.name).toBe(original.name)
    expect(snapshot.description).toBe(original.description)
    expect(snapshot.content).toBe(original.content)
    expect(snapshot.templateId).toBe(original.templateId)
    expect(snapshot.category).toBe("去AI味")
    expect(useFavoriteSkillStore.getState().favorites[0].originProjectPath).toBe("")
  })

  it("keeps a built-in de-ai skill untouched when its id is unknown", async () => {
    await loadEmpty()
    novelMocks.saveFavorites.mockResolvedValue(undefined)
    const unknown: DeAiSkill = { ...deAiSkill(), id: "built-in:ghost", source: "built-in", name: "野技能" }
    await useFavoriteSkillStore.getState().toggleFavorite({ library: "de-ai", skill: unknown })
    const entry = useFavoriteSkillStore.getState().favorites[0]
    expect(entry.snapshot.name).toBe("野技能")
    expect(entry.originProjectPath).toBe("")
  })

  it("snapshots a custom de-ai project skill as-is", async () => {
    await loadEmpty()
    novelMocks.saveFavorites.mockResolvedValue(undefined)
    await useFavoriteSkillStore.getState().toggleFavorite({ library: "de-ai", skill: deAiSkill() })
    const entry = useFavoriteSkillStore.getState().favorites[0]
    expect(entry.originProjectPath).toBe("/P")
    expect(entry.snapshot.name).toBe("去AI味技能")
    expect(entry.snapshot.templateId).toBe("custom")
  })

  it("rolls back the optimistic update when saving fails", async () => {
    await loadEmpty()
    novelMocks.saveFavorites.mockRejectedValue(new Error("write down"))
    await useFavoriteSkillStore.getState().toggleFavorite({ library: "writing", skill: writingSkill() })
    expect(useFavoriteSkillStore.getState().favorites).toHaveLength(0)
    expect(toastMocks.error).toHaveBeenCalledWith("收藏保存失败，请重试")
  })
})

// ---------------------------------------------------------------------------
// removeFavorite / isFavorited
// ---------------------------------------------------------------------------

describe("removeFavorite / isFavorited", () => {
  it("removes by favoriteId and persists", async () => {
    await loadEmpty()
    novelMocks.saveFavorites.mockResolvedValue(undefined)
    const api = () => useFavoriteSkillStore.getState()
    await api().toggleFavorite({ library: "writing", skill: writingSkill() })
    const id = api().favorites[0].favoriteId
    expect(api().isFavorited("writing", "skill:1")).toBe(true)
    expect(api().isFavorited("de-ai", "skill:1")).toBe(false)
    expect(api().isFavorited("writing", "skill:other")).toBe(false)
    await api().removeFavorite(id)
    expect(api().favorites).toHaveLength(0)
    expect(novelMocks.saveFavorites).toHaveBeenLastCalledWith({ version: 1, favorites: [] }, "/P")
  })

  it("restores the list when deletion fails to persist", async () => {
    await loadEmpty()
    novelMocks.saveFavorites.mockResolvedValue(undefined)
    const api = () => useFavoriteSkillStore.getState()
    await api().toggleFavorite({ library: "writing", skill: writingSkill() })
    const id = api().favorites[0].favoriteId
    novelMocks.saveFavorites.mockRejectedValueOnce(new Error("write down"))
    await api().removeFavorite(id)
    expect(api().favorites).toHaveLength(1)
    expect(toastMocks.error).toHaveBeenCalledWith("删除失败，请重试")
  })
})

// ---------------------------------------------------------------------------
// copyToCurrentProject
// ---------------------------------------------------------------------------

describe("copyToCurrentProject", () => {
  async function seedWritingFavorite(content = "正文内容") {
    await loadEmpty()
    novelMocks.saveFavorites.mockResolvedValue(undefined)
    await useFavoriteSkillStore.getState().toggleFavorite({
      library: "writing",
      skill: writingSkill({ content }),
    })
    return useFavoriteSkillStore.getState().favorites[0].favoriteId
  }

  it("returns ok:false for an unknown favoriteId", async () => {
    await loadEmpty()
    expect(await useFavoriteSkillStore.getState().copyToCurrentProject("ghost")).toEqual({ ok: false })
  })

  it("refuses to copy when no project is open", async () => {
    const id = await seedWritingFavorite()
    useFavoriteSkillStore.setState({ currentProjectPath: "" })
    const result = await useFavoriteSkillStore.getState().copyToCurrentProject(id)
    expect(result).toEqual({ ok: false, reason: "no-project" })
    expect(toastMocks.error).toHaveBeenCalledWith("请先打开一个项目再复制")
  })

  it("refuses to copy an empty snapshot", async () => {
    const id = await seedWritingFavorite("   ")
    const result = await useFavoriteSkillStore.getState().copyToCurrentProject(id)
    expect(result).toEqual({ ok: false, reason: "empty-content" })
    expect(toastMocks.error).toHaveBeenCalledWith("原技能内容为空，无法复制")
  })

  it("copies a writing favorite into the project config", async () => {
    const id = await seedWritingFavorite()
    novelMocks.loadUserSkillConfig.mockResolvedValue({ skills: [] })
    novelMocks.saveUserSkillConfig.mockResolvedValue(undefined)
    const result = await useFavoriteSkillStore.getState().copyToCurrentProject(id)
    expect(result).toEqual({ ok: true })
    expect(novelMocks.loadUserSkillConfig).toHaveBeenCalledWith("/P")
    const [path, config] = novelMocks.saveUserSkillConfig.mock.calls[0] as [string, { skills: UserSkill[] }]
    expect(path).toBe("/P")
    expect(config.skills).toHaveLength(1)
    const created = config.skills[0]
    expect(created.id).toMatch(/^skill:\d+$/)
    expect(created.name).toBe("承接")
    expect(created.content).toBe("正文内容")
    expect(created.source).toBe("uploaded")
    expect(created.priority).toBe(DEFAULT_SKILL_PRIORITY)
    expect(created.tags).toEqual([])
    expect(created.categoryId).toBe("")
    expect(wikiMocks.bumpDataVersion).toHaveBeenCalled()
    expect(toastMocks.info).toHaveBeenCalledWith("已复制到当前项目，可在 [写作/去AI味] Tab 查看")
  })

  it("reports duplicate-name for writing without writing", async () => {
    const id = await seedWritingFavorite()
    novelMocks.loadUserSkillConfig.mockResolvedValue({ skills: [writingSkill({ name: "承接" })] })
    const result = await useFavoriteSkillStore.getState().copyToCurrentProject(id)
    expect(result).toEqual({ ok: false, reason: "duplicate-name" })
    expect(novelMocks.saveUserSkillConfig).not.toHaveBeenCalled()
  })

  it("reports write-failed when the writing config cannot be saved", async () => {
    const id = await seedWritingFavorite()
    novelMocks.loadUserSkillConfig.mockResolvedValue({ skills: [] })
    novelMocks.saveUserSkillConfig.mockRejectedValue(new Error("disk down"))
    const result = await useFavoriteSkillStore.getState().copyToCurrentProject(id)
    expect(result).toEqual({ ok: false, reason: "write-failed" })
    expect(toastMocks.error).toHaveBeenCalledWith("复制失败，请重试")
  })

  it("copies a de-ai favorite into the project skills", async () => {
    await loadEmpty()
    novelMocks.saveFavorites.mockResolvedValue(undefined)
    await useFavoriteSkillStore.getState().toggleFavorite({ library: "de-ai", skill: deAiSkill() })
    const id = useFavoriteSkillStore.getState().favorites[0].favoriteId
    novelMocks.loadDeAiSkillConfig.mockResolvedValue({ projectSkills: [] })
    novelMocks.saveDeAiSkillConfig.mockResolvedValue(undefined)
    const result = await useFavoriteSkillStore.getState().copyToCurrentProject(id)
    expect(result).toEqual({ ok: true })
    const [path, config] = novelMocks.saveDeAiSkillConfig.mock.calls[0] as [string, { projectSkills: DeAiSkill[] }]
    expect(path).toBe("/P")
    expect(config.projectSkills).toHaveLength(1)
    const created = config.projectSkills[0]
    expect(created.id).toMatch(/^project:\d+$/)
    expect(created.name).toBe("去AI味技能")
    expect(created.source).toBe("project")
    expect(created.templateId).toBe("custom")
    expect(created.createdAt).toBe(created.updatedAt)
  })

  it("falls back to the custom templateId when the snapshot has none", async () => {
    await loadEmpty()
    novelMocks.saveFavorites.mockResolvedValue(undefined)
    await useFavoriteSkillStore.getState().toggleFavorite({
      library: "de-ai",
      skill: deAiSkill({ templateId: "" }),
    })
    const id = useFavoriteSkillStore.getState().favorites[0].favoriteId
    novelMocks.loadDeAiSkillConfig.mockResolvedValue({ projectSkills: [] })
    novelMocks.saveDeAiSkillConfig.mockResolvedValue(undefined)
    expect(await useFavoriteSkillStore.getState().copyToCurrentProject(id)).toEqual({ ok: true })
    const [, config] = novelMocks.saveDeAiSkillConfig.mock.calls[0] as [string, { projectSkills: DeAiSkill[] }]
    expect(config.projectSkills[0].templateId).toBe("custom")
  })

  it("reports duplicate-name for de-ai", async () => {
    await loadEmpty()
    novelMocks.saveFavorites.mockResolvedValue(undefined)
    await useFavoriteSkillStore.getState().toggleFavorite({ library: "de-ai", skill: deAiSkill() })
    const id = useFavoriteSkillStore.getState().favorites[0].favoriteId
    novelMocks.loadDeAiSkillConfig.mockResolvedValue({ projectSkills: [deAiSkill()] })
    const result = await useFavoriteSkillStore.getState().copyToCurrentProject(id)
    expect(result).toEqual({ ok: false, reason: "duplicate-name" })
    expect(novelMocks.saveDeAiSkillConfig).not.toHaveBeenCalled()
  })

  it("reports write-failed when the de-ai config cannot be loaded", async () => {
    await loadEmpty()
    novelMocks.saveFavorites.mockResolvedValue(undefined)
    await useFavoriteSkillStore.getState().toggleFavorite({ library: "de-ai", skill: deAiSkill() })
    const id = useFavoriteSkillStore.getState().favorites[0].favoriteId
    novelMocks.loadDeAiSkillConfig.mockRejectedValue(new Error("disk down"))
    const result = await useFavoriteSkillStore.getState().copyToCurrentProject(id)
    expect(result).toEqual({ ok: false, reason: "write-failed" })
  })
})
