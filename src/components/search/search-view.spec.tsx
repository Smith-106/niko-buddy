// @vitest-environment jsdom
/**
 * W4 / SearchView 全口径覆盖 spec（目标 statements/branches/functions/lines 100%）。
 *
 * 策略（与 chat-panel.spec.tsx / App.spec.tsx 同模式）：
 * - vi.hoisted 提供可写的 wiki store state + 全部 lib/command mock。
 * - dynamic import（@/lib/search、@/lib/novel/search-adapter）同样被 vi.mock 拦截。
 * - localStorage 用于 search history 的读写；测试间清空。
 * - 高亮文本会把标题/摘要拆成 mark/span，因此标题类断言统一走 container.textContent。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  fireEvent,
  render,
  screen,
  setupDomGlobals,
  waitFor,
} from "@/test-helpers/component-test-utils"
import { SearchView } from "./search-view"

/* eslint-disable @typescript-eslint/no-explicit-any */

interface ProjectLike {
  id: string
  name: string
  path: string
}

const mocks = vi.hoisted(() => {
  const state: Record<string, any> = {
    novelMode: false,
    project: null as ProjectLike | null,
    searchHistory: [] as string[],
    searchTrigger: null as { query: string; ts: number } | null,
    setActiveView: vi.fn(),
    setSelectedFile: vi.fn(),
    setFileContent: vi.fn(),
    setPendingScrollImageSrc: vi.fn(),
    setSearchPanelOpen: vi.fn(),
    setSearchHistory: vi.fn((history: string[]) => {
      state.searchHistory = history
    }),
    setSearchTrigger: vi.fn((trigger: { query: string; ts: number } | null) => {
      state.searchTrigger = trigger
    }),
  }
  const useWikiStore = (selector: (s: any) => any) => selector(state)
  Object.assign(useWikiStore, { getState: () => state })
  return {
    state,
    useWikiStore,
    readFile: vi.fn(async (_path: string) => "file-content"),
    searchWiki: vi.fn(async () => [] as any[]),
    searchPlot: vi.fn(async () => [] as any[]),
    normalizePath: vi.fn((p: string) => p),
    resolveMarkdownImageSrc: vi.fn((url: string) => url),
    findRawSourceForImage: vi.fn(async () => null as string | null),
    imageUrlToAbsolute: vi.fn((url: string) => `abs:${url}`),
    isImeComposing: vi.fn(() => false),
    t: vi.fn((key: string, opts?: any) =>
      opts?.count !== undefined ? `${key}:${opts.count}` : key,
    ),
  }
})

vi.mock("@/stores/wiki-store", () => ({ useWikiStore: mocks.useWikiStore }))
vi.mock("@/commands/fs", () => ({ readFile: mocks.readFile }))
vi.mock("@/lib/search", () => ({ searchWiki: mocks.searchWiki }))
vi.mock("@/lib/novel/search-adapter", () => ({ searchPlot: mocks.searchPlot }))
vi.mock("@/lib/path-utils", () => ({ normalizePath: mocks.normalizePath }))
vi.mock("@/lib/markdown-image-resolver", () => ({
  resolveMarkdownImageSrc: mocks.resolveMarkdownImageSrc,
}))
vi.mock("@/lib/raw-source-resolver", () => ({
  findRawSourceForImage: mocks.findRawSourceForImage,
  imageUrlToAbsolute: mocks.imageUrlToAbsolute,
}))
vi.mock("@/lib/keyboard-utils", () => ({ isImeComposing: mocks.isImeComposing }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }) }))

const PROJECT: ProjectLike = { id: "p1", name: "MyBook", path: "/p/mybook" }

function wikiResult(overrides?: Partial<{ path: string; title: string; snippet: string; images: any[] }>): any {
  return {
    path: "/p/mybook/wiki/entities/foo.md",
    title: "总资产 page",
    snippet: "2023 年总资产合计 100 万",
    titleMatch: true,
    score: 1,
    images: [],
    ...overrides,
  }
}

function typeAndSearch(query: string): void {
  const input = screen.getByRole("textbox")
  fireEvent.change(input, { target: { value: query } })
  fireEvent.keyDown(input, { key: "Enter" })
}

function bodyContains(text: string): boolean {
  return (document.body.textContent ?? "").includes(text)
}

function resetState(): void {
  vi.clearAllMocks()
  mocks.state.novelMode = false
  mocks.state.project = PROJECT
  mocks.state.searchHistory = []
  mocks.state.searchTrigger = null
  mocks.searchWiki.mockResolvedValue([])
  mocks.searchPlot.mockResolvedValue([])
  mocks.readFile.mockResolvedValue("file-content")
  mocks.findRawSourceForImage.mockResolvedValue(null)
  mocks.isImeComposing.mockReturnValue(false)
  localStorage.clear()
  setupDomGlobals()
}

describe("SearchView 空态与挂载", () => {
  beforeEach(() => {
    resetState()
    mocks.state.project = null
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("无项目时渲染 pressEnter 占位且不渲染关闭按钮", () => {
    render(<SearchView />)
    expect(screen.getByText("search.pressEnter")).toBeInTheDocument()
    expect(screen.queryByText("关闭")).not.toBeInTheDocument()
    expect(mocks.state.setSearchHistory).not.toHaveBeenCalled()
  })

  it("传入 onClose 时渲染关闭按钮并可点击", () => {
    const onClose = vi.fn()
    render(<SearchView onClose={onClose} />)
    fireEvent.click(screen.getByText("关闭"))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("挂载时从 localStorage 加载历史（合法 JSON 数组）", () => {
    mocks.state.project = PROJECT
    localStorage.setItem("qmai_search_history_p1", JSON.stringify(["旧查询", "old query"]))
    render(<SearchView />)
    expect(mocks.state.setSearchHistory).toHaveBeenCalledWith(["旧查询", "old query"])
  })

  it("挂载时历史为空数组则不写 store", () => {
    mocks.state.project = PROJECT
    localStorage.setItem("qmai_search_history_p1", JSON.stringify([]))
    render(<SearchView />)
    expect(mocks.state.setSearchHistory).not.toHaveBeenCalled()
  })

  it("localStorage 损坏 JSON 时静默返回空历史", () => {
    mocks.state.project = PROJECT
    localStorage.setItem("qmai_search_history_p1", "not-json{{{")
    render(<SearchView />)
    expect(mocks.state.setSearchHistory).not.toHaveBeenCalled()
  })

  it("localStorage 非数组或含空串时过滤", () => {
    mocks.state.project = PROJECT
    localStorage.setItem("qmai_search_history_p1", JSON.stringify(["ok", "", 3]))
    render(<SearchView />)
    expect(mocks.state.setSearchHistory).toHaveBeenCalledWith(["ok"])
  })

  it("localStorage 非数组 JSON 时返回空历史", () => {
    mocks.state.project = PROJECT
    localStorage.setItem("qmai_search_history_p1", JSON.stringify(42))
    render(<SearchView />)
    expect(mocks.state.setSearchHistory).not.toHaveBeenCalled()
  })

  it("getItem 抛错时静默降级", () => {
    mocks.state.project = PROJECT
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied")
    })
    render(<SearchView />)
    expect(mocks.state.setSearchHistory).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it("无项目时回车搜索被跳过", () => {
    render(<SearchView />)
    typeAndSearch("hello")
    expect(mocks.searchWiki).not.toHaveBeenCalled()
    expect(mocks.state.setSearchHistory).not.toHaveBeenCalled()
    expect(screen.getByText("search.pressEnter")).toBeInTheDocument()
  })

  it("空查询回车搜索被跳过", () => {
    mocks.state.project = PROJECT
    render(<SearchView />)
    typeAndSearch("   ")
    expect(mocks.searchWiki).not.toHaveBeenCalled()
  })
})

describe("SearchView wiki 搜索与结果", () => {
  beforeEach(() => {
    resetState()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("完整搜索流程：searching → 结果页计数/图片区/页面区", async () => {
    let resolveSearch: (v: any[]) => void = () => {}
    mocks.searchWiki.mockImplementation(
      () =>
        new Promise<any[]>((resolve) => {
          resolveSearch = resolve
        }),
    )
    mocks.searchWiki.mockResolvedValue([
      wikiResult({
        images: [
          { url: "media/foo/img-1.png", alt: "2023年总资产合计" },
          { url: "media/foo/img-2.png", alt: "装饰图标" },
        ],
      }),
      wikiResult({
        path: "/p/mybook/wiki/concepts/bar.md",
        title: "bar concept",
        snippet: "some text",
        images: [{ url: "media/foo/img-1.png", alt: "重复图片" }],
      }),
    ])
    const { container } = render(<SearchView onOpenFile={vi.fn()} />)
    typeAndSearch("总资产")

    // searching 中间态（deferred promise 未 resolve）
    expect(screen.getByText("search.searching")).toBeInTheDocument()

    resolveSearch([
      wikiResult({
        images: [
          { url: "media/foo/img-1.png", alt: "2023年总资产合计" },
          { url: "media/foo/img-2.png", alt: "装饰图标" },
        ],
      }),
      wikiResult({
        path: "/p/mybook/wiki/concepts/bar.md",
        title: "bar concept",
        snippet: "some text",
        images: [{ url: "media/foo/img-1.png", alt: "重复图片" }],
      }),
    ])
    await waitFor(() => expect(bodyContains("search.pageCount:2")).toBe(true))
    expect(mocks.searchWiki).toHaveBeenCalledWith(
      "/p/mybook",
      "总资产",
      expect.objectContaining({ rerank: true, includeVector: true, topK: 100 }),
    )
    // 图片区：caption 命中 1 张 + supporting 提示（重复 url 去重成一张卡）
    expect(screen.getByText("search.imagesSection")).toBeInTheDocument()
    expect(bodyContains("search.imageMatchCount:1")).toBe(true)
    expect(bodyContains("search.supportingImagesHint:1")).toBe(true)
    expect(screen.getByText("search.pagesSection")).toBeInTheDocument()
    expect(screen.getByTitle("2023年总资产合计")).toBeInTheDocument()
    expect(screen.queryByTitle("装饰图标")).not.toBeInTheDocument()
    // 页面区
    expect(bodyContains("总资产 page")).toBe(true)
    expect(bodyContains("bar concept")).toBe(true)
    expect(container.querySelectorAll("mark").length).toBeGreaterThan(0)
  })

  it("历史去重：重复查询置顶并写入 localStorage", async () => {
    mocks.state.searchHistory = ["旧查询", "总资产"]
    mocks.searchWiki.mockResolvedValue([wikiResult()])
    render(<SearchView />)
    typeAndSearch("总资产")
    await waitFor(() => expect(bodyContains("search.pageCount:1")).toBe(true))
    expect(mocks.state.searchHistory[0]).toBe("总资产")
    expect(mocks.state.searchHistory[1]).toBe("旧查询")
    expect(JSON.parse(localStorage.getItem("qmai_search_history_p1") ?? "[]")).toEqual(["总资产", "旧查询"])
  })

  it("saveSearchHistory 写失败被吞掉", async () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota")
    })
    mocks.searchWiki.mockResolvedValue([wikiResult()])
    render(<SearchView />)
    typeAndSearch("hello")
    await waitFor(() => expect(bodyContains("search.pageCount:1")).toBe(true))
    spy.mockRestore()
  })

  it("无结果时显示 noResults 与查询词", async () => {
    const { container } = render(<SearchView />)
    typeAndSearch("不存在")
    await waitFor(() => expect(screen.getByText("search.noResults")).toBeInTheDocument())
    expect(bodyContains('"不存在"')).toBe(true)
    void container
  })

  it("搜索失败时清空结果并退出 searching", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.searchWiki.mockRejectedValue(new Error("boom"))
    render(<SearchView />)
    typeAndSearch("hello")
    await waitFor(() => {
      expect(screen.queryByText("search.searching")).not.toBeInTheDocument()
    })
    expect(screen.getByText("search.noResults")).toBeInTheDocument()
    errSpy.mockRestore()
  })

  it("搜索以非 Error 值失败时走 String(err) 分支", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.searchWiki.mockRejectedValue("plain-string-error")
    render(<SearchView />)
    typeAndSearch("hello")
    await waitFor(() => {
      expect(errSpy).toHaveBeenCalledWith(expect.anything(), "plain-string-error")
    })
    errSpy.mockRestore()
  })

  it("点击结果卡走 onOpenFile 回调", async () => {
    mocks.searchWiki.mockResolvedValue([wikiResult()])
    const onOpenFile = vi.fn()
    render(<SearchView onOpenFile={onOpenFile} />)
    typeAndSearch("总资产")
    await waitFor(() => expect(bodyContains("search.pageCount:1")).toBe(true))
    fireEvent.click(screen.getByText("entities/foo.md"))
    expect(onOpenFile).toHaveBeenCalledWith({ path: "/p/mybook/wiki/entities/foo.md" })
  })

  it("无 onOpenFile 时点击结果卡走 readFile + store 写回", async () => {
    mocks.searchWiki.mockResolvedValue([wikiResult()])
    const onClose = vi.fn()
    render(<SearchView onClose={onClose} />)
    typeAndSearch("总资产")
    await waitFor(() => expect(bodyContains("search.pageCount:1")).toBe(true))
    fireEvent.click(screen.getByText("entities/foo.md"))
    await waitFor(() => {
      expect(mocks.state.setActiveView).toHaveBeenCalledWith("wiki")
    })
    expect(mocks.state.setSearchPanelOpen).toHaveBeenCalledWith(false)
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("/p/mybook/wiki/entities/foo.md")
    expect(mocks.state.setFileContent).toHaveBeenCalledWith("file-content")
    expect(onClose).toHaveBeenCalled()
  })

  it("打开结果失败时记录错误且不崩溃", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.searchWiki.mockResolvedValue([wikiResult()])
    mocks.readFile.mockRejectedValue(new Error("read-fail"))
    render(<SearchView />)
    typeAndSearch("总资产")
    await waitFor(() => expect(bodyContains("search.pageCount:1")).toBe(true))
    fireEvent.click(screen.getByText("entities/foo.md"))
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    errSpy.mockRestore()
  })
})

describe("SearchView novel 模式", () => {
  beforeEach(() => {
    resetState()
    mocks.state.novelMode = true
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("novel 模式渲染 5 个搜索范围 chips 且占位符切换", () => {
    render(<SearchView />)
    expect(screen.getByPlaceholderText("novel.search.placeholder")).toBeInTheDocument()
    expect(screen.getByText("novel.search.keyword")).toBeInTheDocument()
    expect(screen.getByText("novel.search.vector")).toBeInTheDocument()
    expect(screen.getByText("novel.search.graph")).toBeInTheDocument()
    expect(screen.getByText("novel.search.recentChapters")).toBeInTheDocument()
    expect(screen.getByText("novel.search.canon")).toBeInTheDocument()
  })

  it("仅 keyword 开启时走 minimal wiki 搜索（不经 searchPlot）", async () => {
    mocks.searchWiki.mockResolvedValue([wikiResult()])
    render(<SearchView />)
    typeAndSearch("第一章")
    await waitFor(() => expect(bodyContains("search.pageCount:1")).toBe(true))
    expect(mocks.searchWiki).toHaveBeenCalledWith(
      "/p/mybook",
      "第一章",
      expect.objectContaining({ rerank: false, includeVector: false }),
    )
    expect(mocks.searchPlot).not.toHaveBeenCalled()
  })

  it("开启 vector 后走 advanced mixed 搜索并映射结果", async () => {
    mocks.searchPlot.mockResolvedValue([
      { path: "/p/mybook/wiki/chapters/ch1.md", title: "第一章", snippet: "s", relevance: 0.9 },
    ])
    render(<SearchView />)
    fireEvent.click(screen.getByText("novel.search.vector"))
    typeAndSearch("第一章")
    await waitFor(() => expect(bodyContains("search.pageCount:1")).toBe(true))
    expect(mocks.searchPlot).toHaveBeenCalled()
    expect(mocks.searchWiki).not.toHaveBeenCalled()
    // novel 结果映射：titleMatch true、images 空 → 无图片区
    expect(screen.queryByText("search.imagesSection")).not.toBeInTheDocument()
    expect(bodyContains("第一章")).toBe(true)
  })

  it("全部范围关闭时直接返回空结果（novel 空态文案）", async () => {
    render(<SearchView />)
    // keyword 默认开 → 点 1 次关闭；其余默认关 → 点 2 次（开→关）
    for (const label of ["novel.search.vector", "novel.search.graph", "novel.search.recentChapters", "novel.search.canon"]) {
      fireEvent.click(screen.getByText(label))
      fireEvent.click(screen.getByText(label))
    }
    fireEvent.click(screen.getByText("novel.search.keyword"))
    typeAndSearch("第一章")
    await waitFor(() => expect(screen.getByText("novel.search.noResults")).toBeInTheDocument())
    expect(mocks.searchPlot).not.toHaveBeenCalled()
    expect(mocks.searchWiki).not.toHaveBeenCalled()
  })

  it("store searchTrigger 触发自动搜索并消费 trigger", async () => {
    mocks.state.searchTrigger = { query: "auto", ts: 1 }
    // 默认仅 keyword → minimal 路径走 searchWiki
    mocks.searchWiki.mockResolvedValue([
      wikiResult({ path: "/p/mybook/wiki/chapters/ch2.md", title: "第二章" }),
    ])
    render(<SearchView />)
    await waitFor(() => expect(bodyContains("第二章")).toBe(true))
    expect(mocks.state.setSearchTrigger).toHaveBeenCalledWith(null)
    expect(screen.getByDisplayValue("auto")).toBeInTheDocument()
  })
})

describe("SearchView 图片网格与 lightbox", () => {
  beforeEach(() => {
    resetState()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  async function renderWithImages(alt: string, url: string) {
    mocks.searchWiki.mockResolvedValue([wikiResult({ images: [{ url, alt }] })])
    const onOpenFile = vi.fn()
    const onClose = vi.fn()
    const view = render(<SearchView onOpenFile={onOpenFile} onClose={onClose} />)
    typeAndSearch("总资产")
    await waitFor(() => expect(bodyContains("search.pageCount:1")).toBe(true))
    return { onOpenFile, onClose, ...view }
  }

  it("show/hide supporting images 切换", async () => {
    mocks.searchWiki.mockResolvedValue([
      wikiResult({
        images: [
          { url: "media/foo/a.png", alt: "2023年总资产合计" },
          { url: "media/foo/b.png", alt: "装饰图标" },
        ],
      }),
    ])
    render(<SearchView />)
    typeAndSearch("总资产")
    await waitFor(() => expect(bodyContains("search.pageCount:1")).toBe(true))
    // 默认只显示 caption 命中
    expect(screen.getByTitle("2023年总资产合计")).toBeInTheDocument()
    expect(screen.queryByTitle("装饰图标")).not.toBeInTheDocument()
    // 展开 supporting
    fireEvent.click(screen.getByText("search.showAllPlus:1"))
    expect(screen.getByTitle("装饰图标")).toBeInTheDocument()
    fireEvent.click(screen.getByText("search.hideSupporting"))
    expect(screen.queryByTitle("装饰图标")).not.toBeInTheDocument()
  })

  it("全部图片都不命中 caption 时仅显示 hint，且无可展开开关（设计如此）", async () => {
    mocks.searchWiki.mockResolvedValue([
      wikiResult({ images: [{ url: "media/foo/a.png", alt: "图标1" }] }),
    ])
    render(<SearchView />)
    typeAndSearch("总资产")
    await waitFor(() => expect(bodyContains("search.pageCount:1")).toBe(true))
    expect(bodyContains("search.supportingImagesHint:1")).toBe(true)
    // visibleImages = matchingImages 为空 → 图片区整体（含 toggle）不渲染
    expect(screen.queryByText("search.imagesSection")).not.toBeInTheDocument()
    expect(screen.queryByText("search.showAllPlus:1")).not.toBeInTheDocument()
    expect(screen.queryByTitle("图标1")).not.toBeInTheDocument()
  })

  it("仅标点查询走 fallback 匹配 alt", async () => {
    mocks.searchWiki.mockResolvedValue([
      wikiResult({ images: [{ url: "media/foo/a.png", alt: "标点!!!" }] }),
    ])
    render(<SearchView />)
    typeAndSearch("!!!")
    await waitFor(() => expect(bodyContains("search.pageCount:1")).toBe(true))
    expect(screen.getByTitle("标点!!!")).toBeInTheDocument()
  })

  it("单字查询 tokenize 为空 → altLower.includes(fallback) 分支", async () => {
    mocks.searchWiki.mockResolvedValue([
      wikiResult({ images: [{ url: "media/foo/a.png", alt: "黑猫" }] }),
    ])
    render(<SearchView />)
    typeAndSearch("猫")
    await waitFor(() => expect(bodyContains("search.pageCount:1")).toBe(true))
    expect(screen.getByTitle("黑猫")).toBeInTheDocument()
  })

  it("lightbox：打开 → X 关闭 → body overflow 恢复", async () => {
    const { onOpenFile } = await renderWithImages("2023年总资产合计", "media/foo/a.png")
    fireEvent.click(screen.getByTitle("2023年总资产合计"))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    // TASK-LE-5：Radix scroll lock 以 data-scroll-locked 标记（替代手写 overflow hidden）
    await waitFor(() => expect(document.body.hasAttribute("data-scroll-locked")).toBe(true))
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    await waitFor(() => expect(document.body.hasAttribute("data-scroll-locked")).toBe(false))
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it("lightbox：Escape 关闭", async () => {
    await renderWithImages("2023年总资产合计", "media/foo/a.png")
    fireEvent.click(screen.getByTitle("2023年总资产合计"))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("lightbox：点击 backdrop 关闭但点击内部不关闭", async () => {
    await renderWithImages("2023年总资产合计", "media/foo/a.png")
    fireEvent.click(screen.getByTitle("2023年总资产合计"))
    // TASK-LE-5：Radix 以 pointerdown 判定 outside + click 确认；role=dialog 在内容卡片上
    const backdrop = screen.getByRole("dialog").parentElement!
    fireEvent.pointerDown(backdrop)
    fireEvent.click(backdrop)
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())

    // 同一渲染内重新打开，点内部 img 不关闭
    fireEvent.click(screen.getByTitle("2023年总资产合计"))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("dialog").querySelector("img") as HTMLElement)
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  it("lightbox 无 caption 时显示 noCaption 文案", async () => {
    mocks.searchWiki.mockResolvedValue([
      wikiResult({
        images: [
          { url: "media/foo/a.png", alt: "2023年总资产合计" },
          { url: "media/foo/b.png", alt: "" },
        ],
      }),
    ])
    render(<SearchView />)
    typeAndSearch("总资产")
    await waitFor(() => expect(bodyContains("search.pageCount:1")).toBe(true))
    // 空 alt 属于 supporting → 先展开再点卡片（title 回退到 sourceTitle）
    fireEvent.click(screen.getByText("search.showAllPlus:1"))
    fireEvent.click(screen.getByTitle("总资产 page"))
    // 网格卡片与 lightbox 头部都会显示 noCaption（空 alt 分支）
    expect(screen.getAllByText("search.noCaption").length).toBeGreaterThan(0)
  })

  it("jump to source：命中 raw 文件时打开 raw + 记录绝对滚动目标", async () => {
    // 无 onOpenFile：走 store 写回路径
    mocks.searchWiki.mockResolvedValue([
      wikiResult({ images: [{ url: "media/foo/a.png", alt: "2023年总资产合计" }] }),
    ])
    const onClose = vi.fn()
    render(<SearchView onClose={onClose} />)
    typeAndSearch("总资产")
    await waitFor(() => expect(bodyContains("search.pageCount:1")).toBe(true))
    mocks.findRawSourceForImage.mockResolvedValue("/p/mybook/raw/sources/foo.pdf")
    fireEvent.click(screen.getByTitle("2023年总资产合计"))
    fireEvent.click(screen.getByRole("button", { name: "search.jumpToSource" }))
    await waitFor(() => {
      expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("/p/mybook/raw/sources/foo.pdf")
    })
    expect(mocks.state.setPendingScrollImageSrc).toHaveBeenCalledWith("abs:media/foo/a.png")
    expect(mocks.state.setFileContent).toHaveBeenCalledWith("file-content")
    expect(mocks.state.setActiveView).toHaveBeenCalledWith("wiki")
    expect(mocks.state.setSearchPanelOpen).toHaveBeenCalledWith(false)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(onClose).toHaveBeenCalled()
  })

  it("jump to source：无 raw 时回退打开 wiki 页（原 url 滚动目标）", async () => {
    mocks.searchWiki.mockResolvedValue([
      wikiResult({ images: [{ url: "media/foo/a.png", alt: "2023年总资产合计" }] }),
    ])
    const onClose = vi.fn()
    render(<SearchView onClose={onClose} />)
    typeAndSearch("总资产")
    await waitFor(() => expect(bodyContains("search.pageCount:1")).toBe(true))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    fireEvent.click(screen.getByTitle("2023年总资产合计"))
    fireEvent.click(screen.getByRole("button", { name: "search.jumpToSource" }))
    await waitFor(() => {
      expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("/p/mybook/wiki/entities/foo.md")
    })
    expect(mocks.state.setPendingScrollImageSrc).toHaveBeenCalledWith("media/foo/a.png")
    expect(warnSpy).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("jump to source：有 onOpenFile 时直接回调（含 scrollImageSrc）", async () => {
    const { onOpenFile } = await renderWithImages("2023年总资产合计", "media/foo/a.png")
    mocks.findRawSourceForImage.mockResolvedValue("/p/mybook/raw/sources/foo.pdf")
    fireEvent.click(screen.getByTitle("2023年总资产合计"))
    fireEvent.click(screen.getByRole("button", { name: "search.jumpToSource" }))
    await waitFor(() => {
      expect(onOpenFile).toHaveBeenCalledWith({
        path: "/p/mybook/raw/sources/foo.pdf",
        scrollImageSrc: "abs:media/foo/a.png",
      })
    })
  })

  it("jump to source 读文件失败记录错误", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.searchWiki.mockResolvedValue([
      wikiResult({ images: [{ url: "media/foo/a.png", alt: "2023年总资产合计" }] }),
    ])
    const onClose = vi.fn()
    render(<SearchView onClose={onClose} />)
    typeAndSearch("总资产")
    await waitFor(() => expect(bodyContains("search.pageCount:1")).toBe(true))
    mocks.readFile.mockRejectedValue(new Error("jump-fail"))
    fireEvent.click(screen.getByTitle("2023年总资产合计"))
    fireEvent.click(screen.getByRole("button", { name: "search.jumpToSource" }))
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    expect(onClose).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("lightbox 打开后项目被清空：jump 跳过 raw 查找并回退 sourcePath", async () => {
    mocks.searchWiki.mockResolvedValue([
      wikiResult({
        images: [
          { url: "media/foo/a.png", alt: "2023年总资产合计" },
          { url: "media/foo/b.png", alt: "装饰图标" },
        ],
      }),
    ])
    const onClose = vi.fn()
    render(<SearchView onClose={onClose} />)
    typeAndSearch("总资产")
    await waitFor(() => expect(bodyContains("search.pageCount:1")).toBe(true))
    fireEvent.click(screen.getByTitle("2023年总资产合计"))
    expect(screen.getByRole("dialog")).toBeInTheDocument()

    // 清空项目后重渲染：Lightbox / ImageHitCard 的 projectPath 走 null 分支
    // 对话框 aria-modal 使搜索框 aria-hidden，用 { hidden: true } 跳过可访问性检查
    mocks.state.project = null
    const input = screen.getByRole("textbox", { hidden: true })
    fireEvent.change(input, { target: { value: "总资产x" } })
    expect(mocks.resolveMarkdownImageSrc).toHaveBeenCalledWith(
      "media/foo/a.png",
      expect.anything(),
    )

    fireEvent.click(screen.getByRole("button", { name: "search.jumpToSource" }))
    await waitFor(() => {
      expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("/p/mybook/wiki/entities/foo.md")
    })
    // 未进入 raw 查找分支
    expect(mocks.findRawSourceForImage).not.toHaveBeenCalled()
    expect(mocks.state.setPendingScrollImageSrc).toHaveBeenCalledWith("media/foo/a.png")
    expect(onClose).toHaveBeenCalled()
  })

  it("非 Enter 键不触发搜索（isImeComposing 与 keydown 守卫）", () => {
    mocks.isImeComposing.mockReturnValue(false)
    render(<SearchView />)
    const input = screen.getByRole("textbox")
    fireEvent.change(input, { target: { value: "总资产" } })
    fireEvent.keyDown(input, { key: "a" })
    expect(mocks.searchWiki).not.toHaveBeenCalled()
    expect(screen.getByText("search.pressEnter")).toBeInTheDocument()
  })

  it("lightbox 中非 Escape 键不关闭", async () => {
    mocks.searchWiki.mockResolvedValue([
      wikiResult({ images: [{ url: "media/foo/a.png", alt: "2023年总资产合计" }] }),
    ])
    render(<SearchView />)
    typeAndSearch("总资产")
    await waitFor(() => expect(bodyContains("search.pageCount:1")).toBe(true))
    fireEvent.click(screen.getByTitle("2023年总资产合计"))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    fireEvent.keyDown(document, { key: "Enter" })
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  it("图片加载失败时设置 opacity 0", async () => {
    await renderWithImages("2023年总资产合计", "media/foo/a.png")
    const img = screen.getByTitle("2023年总资产合计").querySelector("img")
    expect(img).not.toBeNull()
    fireEvent.error(img as HTMLElement)
    expect((img as HTMLImageElement).style.opacity).toBe("0")
  })
})

describe("SearchView 输入与高亮", () => {
  beforeEach(() => {
    resetState()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("IME 组合中回车不触发搜索", () => {
    mocks.isImeComposing.mockReturnValue(true)
    render(<SearchView />)
    typeAndSearch("总资产")
    expect(mocks.searchWiki).not.toHaveBeenCalled()
    expect(screen.getByText("search.pressEnter")).toBeInTheDocument()
  })

  it("高亮：清空查询后渲染纯文本（无 mark）", async () => {
    mocks.searchWiki.mockResolvedValue([wikiResult()])
    const { container } = render(<SearchView />)
    typeAndSearch("总资产")
    await waitFor(() => expect(bodyContains("search.pageCount:1")).toBe(true))
    expect(container.querySelectorAll("mark").length).toBeGreaterThan(0)
    const input = screen.getByRole("textbox")
    fireEvent.change(input, { target: { value: "" } })
    expect(container.querySelectorAll("mark")).toHaveLength(0)
  })

  it("高亮：正则特殊字符被转义", async () => {
    mocks.searchWiki.mockResolvedValue([
      wikiResult({ title: "a(b)c title", snippet: "hello world" }),
    ])
    render(<SearchView />)
    typeAndSearch("(b)")
    await waitFor(() => expect(bodyContains("search.pageCount:1")).toBe(true))
    expect(screen.getAllByText("(b)").length).toBeGreaterThan(0)
    expect(screen.getByText("a")).toBeInTheDocument()
  })

  it("stop word 查询降级为整串高亮", async () => {
    mocks.searchWiki.mockResolvedValue([wikiResult({ title: "the page" })])
    render(<SearchView />)
    typeAndSearch("the")
    await waitFor(() => expect(bodyContains("search.pageCount:1")).toBe(true))
    expect(screen.getAllByText("the").length).toBeGreaterThan(0)
  })

  it("CJK 查询走 bigram tokenization 且高亮可用", async () => {
    mocks.searchWiki.mockResolvedValue([wikiResult({ title: "总资产明细 page" })])
    render(<SearchView />)
    typeAndSearch("总资产")
    await waitFor(() => expect(bodyContains("search.pageCount:1")).toBe(true))
    expect(screen.getAllByText("总资").length).toBeGreaterThan(0)
  })
})
