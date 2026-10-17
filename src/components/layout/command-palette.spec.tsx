// @vitest-environment jsdom
/**
 * 命令面板（Ctrl/⌘+K）单测 —— ui-audit-20261016 P0/F-12。
 * 覆盖：列表来源（视图 + 章节）、过滤、键盘导航与执行、空态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen, fireEvent, setupDomGlobals } from "@/test-helpers/component-test-utils"
import { CommandPalette } from "./command-palette"

const mocks = vi.hoisted(() => {
  const state: {
    activeView: string
    fileTree: unknown[]
    setActiveView: ReturnType<typeof vi.fn>
    setSelectedFile: ReturnType<typeof vi.fn>
  } = {
    activeView: "wiki",
    fileTree: [],
    setActiveView: vi.fn(),
    setSelectedFile: vi.fn(),
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

  it("重新打开时清空上次查询", () => {
    const { rerender } = renderPalette(true)
    fireEvent.change(input(), { target: { value: "chapter-001" } })
    expect(input().value).toBe("chapter-001")
    rerender(<CommandPalette open={false} onOpenChange={vi.fn()} />)
    rerender(<CommandPalette open onOpenChange={vi.fn()} />)
    expect(input().value).toBe("")
  })
})
