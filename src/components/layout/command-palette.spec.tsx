// @vitest-environment jsdom
/**
 * 命令面板（Ctrl/⌘+K）单测 —— ui-audit-20261016 P0/F-12。
 * 覆盖：列表来源（视图 + 章节）、过滤、键盘导航与执行、空态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen, fireEvent, setupDomGlobals } from "@/test-helpers/component-test-utils"
import { CommandPalette, buildChapterKeywords } from "./command-palette"

const mocks = vi.hoisted(() => {
  const state: {
    activeView: string
    fileTree: unknown[]
    focusMode: boolean
    setActiveView: ReturnType<typeof vi.fn>
    setSelectedFile: ReturnType<typeof vi.fn>
    setFocusMode: ReturnType<typeof vi.fn>
  } = {
    activeView: "wiki",
    fileTree: [],
    focusMode: false,
    setActiveView: vi.fn(),
    setSelectedFile: vi.fn(),
    setFocusMode: vi.fn(),
  }
  return { state, t: vi.fn((key: string) => key) }
})

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state },
  ),
}))

function renderPalette(open = true, onOpenChange = vi.fn()) {
  const result = render(<CommandPalette open={open} onOpenChange={onOpenChange} />)
  return { ...result, onOpenChange }
}

function input(): HTMLInputElement {
  return screen.getByRole("combobox") as HTMLInputElement
}

function optionLabels(): string[] {
  return screen.queryAllByRole("option").map((el) => el.textContent ?? "")
}

beforeEach(() => {
  setupDomGlobals()
  vi.clearAllMocks()
  mocks.state.activeView = "wiki"
  mocks.state.fileTree = [
    {
      name: "chapters",
      path: "/proj/wiki/chapters",
      is_dir: true,
      children: [
        { name: "chapter-001.md", path: "/proj/wiki/chapters/chapter-001.md", is_dir: false },
        { name: "chapter-002.md", path: "/proj/wiki/chapters/chapter-002.md", is_dir: false },
      ],
    },
    {
      name: "outlines",
      path: "/proj/wiki/outlines",
      is_dir: true,
      children: [{ name: "outline-001.md", path: "/proj/wiki/outlines/outline-001.md", is_dir: false }],
    },
  ]
})

afterEach(() => {
  cleanup()
})

describe("CommandPalette", () => {
  it("open=false 时不渲染面板", () => {
    renderPalette(false)
    expect(screen.queryByTestId("command-palette")).toBeNull()
  })

  it("打开时同时列出章节与非章节文件之外的视图项", () => {
    renderPalette()
    expect(screen.getByTestId("command-palette")).toBeTruthy()
    const labels = optionLabels()
    // 章节来自只读 fileTree（只收 /wiki/chapters/），outlines 不进列表
    expect(labels.some((l) => l.includes("chapter-001"))).toBe(true)
    expect(labels.some((l) => l.includes("outline-001"))).toBe(false)
    // 视图来自共享 NAV_ITEMS（labelKey 回显）
    expect(labels.some((l) => l.includes("novel.nav.wiki"))).toBe(true)
    expect(labels.some((l) => l.includes("novel.nav.reviewCenter"))).toBe(true)
  })

  it("输入过滤：路径片段命中章节（忽略分隔符与大小写）", () => {
    renderPalette()
    fireEvent.change(input(), { target: { value: "CHAPTER-002" } })
    const labels = optionLabels()
    expect(labels.some((l) => l.includes("chapter-002"))).toBe(true)
    expect(labels.some((l) => l.includes("chapter-001"))).toBe(false)
  })

  it("输入过滤：无匹配 → 显示空态文案", () => {
    renderPalette()
    fireEvent.change(input(), { target: { value: "zzz-not-found" } })
    expect(screen.queryAllByRole("option").length).toBe(0)
    expect(screen.getByText("commandPalette.empty")).toBeTruthy()
  })

  it("键盘：↓ 移动选中项，Enter 执行视图跳转并关闭面板", () => {
    const { onOpenChange } = renderPalette()
    fireEvent.change(input(), { target: { value: "novel.nav.soul" } })
    fireEvent.keyDown(input(), { key: "ArrowDown" })
    fireEvent.keyDown(input(), { key: "Enter" })
    expect(mocks.state.setActiveView).toHaveBeenCalledWith("soul")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("Enter 执行章节跳转：切到 wiki 视图并选中该章节", () => {
    const { onOpenChange } = renderPalette()
    fireEvent.change(input(), { target: { value: "chapter-001" } })
    fireEvent.keyDown(input(), { key: "Enter" })
    expect(mocks.state.setActiveView).toHaveBeenCalledWith("wiki")
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("/proj/wiki/chapters/chapter-001.md")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("鼠标点击条目同样执行（不依赖键盘）", () => {
    const { onOpenChange } = renderPalette()
    fireEvent.change(input(), { target: { value: "chapter-002" } })
    fireEvent.click(screen.queryAllByRole("option")[0])
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("/proj/wiki/chapters/chapter-002.md")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("无匹配结果时回车无选中项不崩溃（runEntry 早退）", () => {
    mocks.state.fileTree = []
    renderPalette()
    fireEvent.change(input(), { target: { value: "zzz-not-found" } })
    expect(() => fireEvent.keyDown(input(), { key: "Enter" })).not.toThrow()
    expect(mocks.state.setActiveView).not.toHaveBeenCalled()
    expect(mocks.state.setSelectedFile).not.toHaveBeenCalled()
  })

  it("可搜索并执行专注模式切换", () => {
    const { onOpenChange } = renderPalette()
    fireEvent.change(input(), { target: { value: "layout.focusMode.enter" } })
    fireEvent.click(screen.getAllByRole("option")[0])
    expect(mocks.state.setFocusMode).toHaveBeenCalledWith(true)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("重新打开时清空上次查询", () => {
    const { rerender } = renderPalette(true)
    fireEvent.change(input(), { target: { value: "chapter-001" } })
    expect(input().value).toBe("chapter-001")
    rerender(<CommandPalette open={false} onOpenChange={vi.fn()} />)
    rerender(<CommandPalette open onOpenChange={vi.fn()} />)
    expect(input().value).toBe("")
  })

  it("W3：搜索视图条目执行 setActiveView(search)", () => {
    const { onOpenChange } = renderPalette()
    fireEvent.change(input(), { target: { value: "novel.nav.search" } })
    expect(optionLabels().some((l) => l.includes("novel.nav.search"))).toBe(true)
    fireEvent.keyDown(input(), { key: "Enter" })
    expect(mocks.state.setActiveView).toHaveBeenCalledWith("search")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("W3：设置条目执行 setActiveView(settings)", () => {
    const { onOpenChange } = renderPalette()
    fireEvent.change(input(), { target: { value: "novel.nav.settings" } })
    expect(optionLabels().some((l) => l.includes("novel.nav.settings"))).toBe(true)
    fireEvent.keyDown(input(), { key: "Enter" })
    expect(mocks.state.setActiveView).toHaveBeenCalledWith("settings")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("W3：ArrowUp 回绕选中并触发 scrollIntoView", () => {
    const scrollSpy = vi.fn()
    const origScroll = Element.prototype.scrollIntoView
    // jsdom 无 scrollIntoView：补桩以捕获调用
    ;(Element.prototype as unknown as Record<string, unknown>).scrollIntoView = scrollSpy
    try {
      renderPalette()
      // 空查询 → 40 条，ArrowDown 到 1，再 ArrowUp 回 0（覆盖 prev+1 与 prev-1 两分支）
      fireEvent.keyDown(input(), { key: "ArrowDown" })
      expect(screen.queryAllByRole("option")[1].getAttribute("aria-selected")).toBe("true")
      fireEvent.keyDown(input(), { key: "ArrowUp" })
      expect(screen.queryAllByRole("option")[0].getAttribute("aria-selected")).toBe("true")
      expect(scrollSpy).toHaveBeenCalled()
    } finally {
      if (origScroll) (Element.prototype as unknown as Record<string, unknown>).scrollIntoView = origScroll
      else delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView
    }
  })

  it("W3：空列表时 ArrowUp/ArrowDown 早退不崩溃", () => {
    mocks.state.fileTree = []
    renderPalette()
    fireEvent.change(input(), { target: { value: "zzz-not-found" } })
    expect(() => fireEvent.keyDown(input(), { key: "ArrowUp" })).not.toThrow()
    expect(() => fireEvent.keyDown(input(), { key: "ArrowDown" })).not.toThrow()
    expect(mocks.state.setActiveView).not.toHaveBeenCalled()
  })

  it("W3：鼠标悬停切换高亮（onMouseEnter）", () => {
    const scrollSpy = vi.fn()
    ;(Element.prototype as unknown as Record<string, unknown>).scrollIntoView = scrollSpy
    renderPalette()
    const options = screen.queryAllByRole("option")
    expect(options.length).toBeGreaterThan(1)
    fireEvent.mouseEnter(options[2])
    expect(options[2].getAttribute("aria-selected")).toBe("true")
    // 语义锚点：悬停项与点击项一致，点击执行对应视图
    fireEvent.click(options[2])
    expect(mocks.state.setActiveView).toHaveBeenCalled()
  })

  it("W3：fileTree=null 与无 children 目录不崩溃（分支补齐）", () => {
    mocks.state.fileTree = null as unknown as []
    expect(() => renderPalette()).not.toThrow()
    cleanup()
    mocks.state.fileTree = [
      { name: "emptyDir", path: "/proj/wiki/chapters", is_dir: true } as unknown as never,
      { name: "note.txt", path: "/proj/wiki/chapters/note.txt", is_dir: false } as unknown as never,
    ] as unknown as []
    renderPalette()
    // 非 md / 非章节文件不进列表，但视图项仍在
    expect(optionLabels().some((l) => l.includes("novel.nav.wiki"))).toBe(true)
    expect(optionLabels().some((l) => l.includes("note"))).toBe(false)
  })

  it("W3：focusMode=true 时标签切换为退出专注", () => {
    mocks.state.focusMode = true
    renderPalette()
    expect(optionLabels().some((l) => l.includes("layout.focusMode.exit"))).toBe(true)
  })

  it("W3：非导航键不触发选择", () => {
    renderPalette()
    expect(() => fireEvent.keyDown(input(), { key: "a" })).not.toThrow()
    expect(mocks.state.setActiveView).not.toHaveBeenCalled()
  })

  it("U-7：100 章长篇下空查询优先展示全部视图与前 20 章，输入「第12章」「第85章」精准命中", () => {
    mocks.state.fileTree = [
      {
        name: "chapters",
        path: "/proj/wiki/chapters",
        is_dir: true,
        children: Array.from({ length: 100 }, (_, idx) => {
          const num = String(idx + 1).padStart(3, "0")
          return {
            name: `chapter-${num}.md`,
            path: `/proj/wiki/chapters/chapter-${num}.md`,
            is_dir: false,
          }
        }),
      },
    ]
    const { onOpenChange } = renderPalette()
    const idleLabels = optionLabels()
    // 视图全部优先可见，不被百章挤出
    expect(idleLabels.some((l) => l.includes("novel.nav.wiki"))).toBe(true)
    expect(idleLabels.some((l) => l.includes("novel.nav.mainControl"))).toBe(true)
    expect(idleLabels.some((l) => l.includes("novel.nav.search"))).toBe(true)
    expect(idleLabels.some((l) => l.includes("novel.nav.settings"))).toBe(true)
    // 空查询保留前 20 章预览
    expect(idleLabels.some((l) => l.includes("chapter-001"))).toBe(true)
    expect(idleLabels.some((l) => l.includes("chapter-020"))).toBe(true)
    expect(idleLabels.some((l) => l.includes("chapter-021"))).toBe(false)

    // 「第12章」命中 chapter-012.md
    fireEvent.change(input(), { target: { value: "第12章" } })
    const match12 = optionLabels()
    expect(match12.some((l) => l.includes("chapter-012"))).toBe(true)
    expect(match12.some((l) => l.includes("chapter-001"))).toBe(false)
    fireEvent.keyDown(input(), { key: "Enter" })
    expect(mocks.state.setActiveView).toHaveBeenCalledWith("wiki")
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("/proj/wiki/chapters/chapter-012.md")
    expect(onOpenChange).toHaveBeenCalledWith(false)

    // 超过前 20 章的「第85章」在检索时同样命中
    fireEvent.change(input(), { target: { value: "第85章" } })
    const match85 = optionLabels()
    expect(match85.some((l) => l.includes("chapter-085"))).toBe(true)
  })

  it("U-7：buildChapterKeywords 支持多格式章号提取并在无章号时回退 path", () => {
    expect(buildChapterKeywords("chapter-012", "/proj/wiki/chapters/chapter-012.md")).toBe(
      "第12章 第012章 chapter12 ch12 /proj/wiki/chapters/chapter-012.md",
    )
    expect(buildChapterKeywords("ch_3", "/proj/wiki/chapters/ch_3.md")).toContain("第3章 第003章 chapter3 ch3")
    expect(buildChapterKeywords("第7章 暗夜", "/proj/wiki/chapters/第7章 暗夜.md")).toContain("第7章 第007章 chapter7 ch7")
    expect(buildChapterKeywords("012-序幕", "/proj/wiki/chapters/012-序幕.md")).toContain("第12章 第012章 chapter12 ch12")
    expect(buildChapterKeywords("prologue", "/proj/wiki/chapters/prologue.md")).toBe("/proj/wiki/chapters/prologue.md")
    expect(buildChapterKeywords("chapter-000", "/proj/wiki/chapters/chapter-000.md")).toBe("/proj/wiki/chapters/chapter-000.md")
  })
})
