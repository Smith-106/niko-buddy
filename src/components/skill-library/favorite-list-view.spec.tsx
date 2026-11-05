// @vitest-environment jsdom
/** 真实行为测试：src/components/skill-library/favorite-list-view.tsx（替代 C4 空壳） */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { FavoriteListView } from "./favorite-list-view"
import type { FavoriteSkillEntry } from "@/lib/novel"

const mocks = vi.hoisted(() => ({
  favorites: [] as FavoriteSkillEntry[],
  loaded: false,
  project: null as { path: string } | null,
  setActiveView: vi.fn(),
  removeFavorite: vi.fn(async (_id: string) => {}),
  copyToCurrentProject: vi.fn(
    async (_id: string): Promise<{ ok: boolean; reason?: string }> => ({ ok: true }),
  ),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  confirmResult: true,
}))

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: (k: string) => k }),
}))

vi.mock("@/stores/favorite-skill-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/favorite-skill-store")>()
  return {
    ...actual,
    useFavoriteSkillStore: (selector: (s: typeof mocks) => unknown) => selector(mocks),
  }
})

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: (selector: (s: { project: unknown; setActiveView: unknown }) => unknown) =>
      selector({ project: mocks.project, setActiveView: mocks.setActiveView }),
  }
})

vi.mock("@/lib/toast", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}))

function entry(overrides: Partial<FavoriteSkillEntry> = {}): FavoriteSkillEntry {
  return {
    favoriteId: "fav-1",
    library: "writing",
    skillId: "skill:1",
    originProjectPath: "/proj/book",
    source: "project",
    snapshot: {
      name: "悬念钩子",
      description: "开篇三秒抓住读者",
      content: "正文内容……",
      kind: ["style"],
      stages: ["drafting"],
      modes: ["standard"],
      category: "开篇",
      templateId: "",
    },
    favoritedAt: 1700000002000,
    ...overrides,
  }
}

const OLDER = entry({
  favoriteId: "fav-older",
  library: "de-ai",
  skillId: "built-in:polish",
  originProjectPath: "",
  source: "built-in",
  snapshot: {
    name: "旧条目",
    description: "",
    content: "旧内容",
    kind: ["style"],
    stages: ["drafting"],
    modes: ["fast"],
    category: "",
    templateId: "t1",
  },
  favoritedAt: 1700000001000,
})

const NEWER = entry({ favoriteId: "fav-newer", snapshot: { ...entry().snapshot, name: "新条目" }, favoritedAt: 1700000003000 })

function seed(favorites: FavoriteSkillEntry[], loaded = true, project: { path: string } | null = { path: "/proj/book" }) {
  mocks.favorites = favorites
  mocks.loaded = loaded
  mocks.project = project
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.confirmResult = true
  seed([], false, null)
  window.confirm = (() => mocks.confirmResult) as typeof window.confirm
})

afterEach(() => {
  cleanup()
})

describe("FavoriteListView", () => {
  it("未加载时显示加载态", () => {
    seed([], false, null)
    render(<FavoriteListView />)
    expect(screen.getByText("加载中...")).toBeTruthy()
  })

  it("空收藏时显示空态，按钮跳转技能库", () => {
    seed([], true, null)
    render(<FavoriteListView />)
    expect(screen.getByText("skillLibrary.noFavorites")).toBeTruthy()
    expect(screen.getByText("skillLibrary.favoriteHint")).toBeTruthy()
    fireEvent.click(screen.getByText("去技能库挑一个"))
    expect(mocks.setActiveView).toHaveBeenCalledWith("skillLibrary")
  })

  it("按收藏时间降序排列并渲染标签与快照", () => {
    seed([OLDER, NEWER])
    const { container } = render(<FavoriteListView />)
    const titles = Array.from(container.querySelectorAll("h3")).map((h) => h.textContent)
    expect(titles).toEqual(["新条目", "旧条目"])
    // library 标签：写作 / 去AI味
    expect(screen.getByText("写作")).toBeTruthy()
    expect(screen.getByText("去AI味")).toBeTruthy()
    // source 标签：内置 / 项目
    expect(screen.getByText("内置")).toBeTruthy()
    expect(screen.getByText("项目")).toBeTruthy()
    // 快照内容与收藏时间
    expect(screen.getByText("开篇三秒抓住读者")).toBeTruthy()
    expect(screen.getByText("正文内容……")).toBeTruthy()
    expect(screen.getAllByText(/收藏于 /)).toHaveLength(2)
  })

  it("无描述时不渲染描述段落；渲染全部来源标签", () => {
    const sources: Array<FavoriteSkillEntry["source"]> = ["uploaded", "linked", "legacy"]
    const labels = ["上传", "链接", "旧版"]
    seed(sources.map((source, i) => entry({ favoriteId: `f-${source}`, source, snapshot: { ...entry().snapshot, name: `技能${i}`, description: "" } })))
    render(<FavoriteListView />)
    for (const label of labels) expect(screen.getByText(label)).toBeTruthy()
    expect(screen.queryByText("开篇三秒抓住读者")).toBeNull()
  })

  it("搜索按名称与描述过滤，无匹配时显示空结果", () => {
    seed([OLDER, NEWER])
    render(<FavoriteListView />)
    const input = screen.getByPlaceholderText("skillLibrary.searchFavorites")
    fireEvent.change(input, { target: { value: "不存在的技能xyz" } })
    expect(screen.getByText("没有匹配的收藏")).toBeTruthy()
    expect(screen.queryByText("新条目")).toBeNull()
    fireEvent.change(input, { target: { value: "旧条" } })
    expect(screen.getByText("旧条目")).toBeTruthy()
    expect(screen.queryByText("新条目")).toBeNull()
    // 描述命中同样过滤得出
    fireEvent.change(input, { target: { value: "开篇三秒" } })
    expect(screen.getByText("新条目")).toBeTruthy()
  })

  it("复制成功不弹错；同名复制失败弹 toast.error", async () => {
    seed([entry({ favoriteId: "fav-copy", originProjectPath: "/other/proj" })])
    render(<FavoriteListView />)
    fireEvent.click(screen.getByText("复制到当前项目"))
    await waitFor(() => expect(mocks.copyToCurrentProject).toHaveBeenCalledWith("fav-copy"))
    expect(mocks.toastError).not.toHaveBeenCalled()

    mocks.copyToCurrentProject.mockResolvedValueOnce({ ok: false, reason: "duplicate-name" })
    fireEvent.click(screen.getByText("复制到当前项目"))
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("当前项目已存在同名技能，复制失败"),
    )

    // 非重名失败不弹重名错
    mocks.toastError.mockClear()
    mocks.copyToCurrentProject.mockResolvedValueOnce({ ok: false })
    fireEvent.click(screen.getByText("复制到当前项目"))
    await waitFor(() => expect(mocks.copyToCurrentProject).toHaveBeenCalledTimes(3))
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it("复制中阻止重复提交（copyingId 守卫）", async () => {
    let resolveCopy!: (v: { ok: boolean }) => void
    mocks.copyToCurrentProject.mockImplementationOnce(
      () => new Promise<{ ok: boolean }>((r) => { resolveCopy = r }),
    )
    seed([
      entry({ favoriteId: "fav-a", originProjectPath: "/other/proj" }),
      entry({
        favoriteId: "fav-b",
        originProjectPath: "/other/proj",
        snapshot: { ...entry().snapshot, name: "乙技能" },
      }),
    ])
    render(<FavoriteListView />)
    fireEvent.click(screen.getAllByText("复制到当前项目")[0])
    await waitFor(() => expect(screen.getByText("复制中...")).toBeTruthy())
    // A 复制未完成时点 B 的复制按钮：copyingId 守卫直接 return，不再调用 store
    fireEvent.click(screen.getByText("乙技能").closest("div.rounded-lg")!.querySelectorAll("button")[0])
    expect(mocks.copyToCurrentProject).toHaveBeenCalledTimes(1)
    resolveCopy({ ok: true })
    await waitFor(() => expect(screen.getAllByText("复制到当前项目")).toHaveLength(2))
  })

  it("删除需二次确认：确认后删除并 toast，取消则不调", async () => {
    seed([NEWER])
    render(<FavoriteListView />)
    fireEvent.click(screen.getByText("删除"))
    await waitFor(() => expect(mocks.removeFavorite).toHaveBeenCalledWith("fav-newer"))
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已删除收藏「新条目」")

    mocks.confirmResult = false
    vi.clearAllMocks()
    fireEvent.click(screen.getByText("删除"))
    await new Promise((r) => setTimeout(r, 20))
    expect(mocks.removeFavorite).not.toHaveBeenCalled()
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })

  it("当前项目技能显示“已在当前项目”且禁用复制；无项目时复制禁用", () => {
    // originProjectPath 与当前项目一致 → 已在当前项目
    seed([NEWER])
    render(<FavoriteListView />)
    const disabled = screen.getByText("已在当前项目")
    expect((disabled as HTMLButtonElement).disabled).toBe(true)

    // built-in 来源同样视为已在当前项目
    cleanup()
    seed([OLDER])
    render(<FavoriteListView />)
    expect(screen.getByText("已在当前项目")).toBeTruthy()

    // 无项目时复制按钮禁用
    cleanup()
    seed([entry({ originProjectPath: "/other/proj" })], true, null)
    render(<FavoriteListView />)
    const btn = screen.getByText("复制到当前项目")
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })
})
