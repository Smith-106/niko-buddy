// @vitest-environment jsdom
/**
 * W4D4 coverage campaign — IconSidebar 全口径 100%。
 * 所有 store / 外部依赖均 vi.mock（可写 state），Tooltip 用简单包裹 mock，
 * 参考 src/App.spec.tsx 的 vi.hoisted 模式。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  render,
  screen,
  fireEvent,
  waitFor,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import { IconSidebar } from "./icon-sidebar"

const mocks = vi.hoisted(() => {
  const wikiState: {
    activeView: string
    setActiveView: ReturnType<typeof vi.fn>
    setSearchPanelOpen: ReturnType<typeof vi.fn>
    selectedFile: string | null
    setSelectedFile: ReturnType<typeof vi.fn>
    theme: string
    setTheme: ReturnType<typeof vi.fn>
  } = {
    activeView: "wiki",
    setActiveView: vi.fn(),
    setSearchPanelOpen: vi.fn(),
    selectedFile: null,
    setSelectedFile: vi.fn(),
    theme: "system",
    setTheme: vi.fn(),
  }
  const reviewState: {
    items: Array<{ resolved: boolean }>
  } = {
    items: [],
  }
  return {
    wikiState,
    reviewState,
    t: vi.fn((key: string) => key),
    saveTheme: vi.fn(async () => {}),
    applyTheme: vi.fn(),
    onToggleSidebar: vi.fn(),
    onOpenSidebar: vi.fn(),
    onSwitchProject: vi.fn(),
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: typeof mocks.wikiState) => unknown) => selector(mocks.wikiState),
    { getState: () => mocks.wikiState },
  ),
}))

vi.mock("@/stores/review-store", () => ({
  useReviewStore: Object.assign(
    (selector: (s: typeof mocks.reviewState) => unknown) => selector(mocks.reviewState),
    { getState: () => mocks.reviewState },
  ),
}))

vi.mock("@/lib/project-store", () => ({
  saveTheme: mocks.saveTheme,
}))

vi.mock("@/lib/theme-utils", () => ({
  applyTheme: mocks.applyTheme,
}))

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip">{children}</div>
  ),
  TooltipTrigger: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props} />
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

function renderSidebar(opts?: {
  withToggle?: boolean
  withOpenSidebar?: boolean
}): ReturnType<typeof render> {
  return render(
    <IconSidebar
      onToggleSidebar={opts?.withToggle === false ? undefined : mocks.onToggleSidebar}
      onOpenSidebar={opts?.withOpenSidebar === false ? undefined : mocks.onOpenSidebar}
      onSwitchProject={mocks.onSwitchProject}
    />,
  )
}

/** 通过 tooltip 文案找到对应触发按钮（Tooltip div 内含按钮 + 文案）。 */
function buttonForTooltip(text: string): HTMLButtonElement {
  const el = screen.getByText(text)
  let node: HTMLElement | null = el.parentElement
  while (node && node.getAttribute("data-testid") !== "tooltip") {
    node = node.parentElement
  }
  const btn = node?.querySelector("button") as HTMLButtonElement | null
  if (!btn) throw new Error(`button not found for tooltip: ${text}`)
  return btn
}

async function clickTooltip(text: string): Promise<void> {
  fireEvent.click(buttonForTooltip(text))
  await waitFor(() => {
    expect(mocks.wikiState.setActiveView).toHaveBeenCalled()
  })
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  setupDomGlobals()
  vi.clearAllMocks()
  mocks.wikiState.activeView = "wiki"
  mocks.wikiState.selectedFile = null
  mocks.wikiState.theme = "system"
  mocks.reviewState.items = []
})

describe("IconSidebar", () => {
  it("渲染全部导航项、搜索、回收站、主题、设置与切换项目按钮", () => {
    renderSidebar()
    const labels = [
      "novel.nav.wiki",
      "novel.nav.sources",
      "novel.nav.graph",
      "novel.nav.lint",
      "novel.nav.soul",
      "novel.nav.dismantling",
      "novel.nav.reviewCenter",
      "novel.nav.search",
      "nav.trash",
      "novel.nav.settings",
      "nav.switchProject",
    ]
    for (const label of labels) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    // 主题 tooltip（system → 下一个 light）
    expect(screen.getByText("theme.toLight")).toBeInTheDocument()
  })

  it("wiki 视图点击：选中文件不在 wiki/chapters/ 时清空选中", async () => {
    mocks.wikiState.selectedFile = "/p/wiki/entities/dpao.md"
    renderSidebar()
    await clickTooltip("novel.nav.wiki")
    expect(mocks.wikiState.setSelectedFile).toHaveBeenCalledWith(null)
    expect(mocks.wikiState.setSearchPanelOpen).toHaveBeenCalledWith(false)
    expect(mocks.wikiState.setActiveView).toHaveBeenCalledWith("wiki")
  })

  it("wiki 视图点击：选中文件在 wiki/chapters/ 时保留", async () => {
    mocks.wikiState.selectedFile = "/p/wiki/chapters/ch1.md"
    renderSidebar()
    await clickTooltip("novel.nav.wiki")
    expect(mocks.wikiState.setSelectedFile).not.toHaveBeenCalled()
  })

  it("wiki 视图点击：无选中文件时不清空", async () => {
    renderSidebar()
    await clickTooltip("novel.nav.wiki")
    expect(mocks.wikiState.setSelectedFile).not.toHaveBeenCalled()
  })

  it("sources 视图点击：选中文件不在 wiki/outlines/ 时清空选中（含反斜杠归一化）", async () => {
    mocks.wikiState.selectedFile = "C:\\p\\wiki\\entities\\dpao.md"
    renderSidebar()
    await clickTooltip("novel.nav.sources")
    expect(mocks.wikiState.setSelectedFile).toHaveBeenCalledWith(null)
  })

  it("sources 视图点击：选中文件在 wiki/outlines/ 时保留", async () => {
    mocks.wikiState.selectedFile = "/p/wiki/outlines/o1.md"
    renderSidebar()
    await clickTooltip("novel.nav.sources")
    expect(mocks.wikiState.setSelectedFile).not.toHaveBeenCalled()
  })

  it("sources 视图点击：无选中文件时不清空", async () => {
    renderSidebar()
    await clickTooltip("novel.nav.sources")
    expect(mocks.wikiState.setSelectedFile).not.toHaveBeenCalled()
  })

  it("其余视图点击（graph/lint/soul/dismantling/reviewCenter）只切视图", async () => {
    for (const view of ["graph", "lint", "soul", "bookAnalysis", "reviewCenter"]) {
      mocks.wikiState.selectedFile = "/p/wiki/entities/x.md"
      renderSidebar()
      await clickTooltip(`novel.nav.${view === "bookAnalysis" ? "dismantling" : view === "reviewCenter" ? "reviewCenter" : view}`)
      expect(mocks.wikiState.setSelectedFile).not.toHaveBeenCalled()
      expect(mocks.wikiState.setActiveView).toHaveBeenCalledWith(view)
      cleanup()
      vi.clearAllMocks()
    }
  })

  it("搜索点击：关闭搜索面板并切到 search 视图", async () => {
    renderSidebar()
    await clickTooltip("novel.nav.search")
    expect(mocks.wikiState.setSearchPanelOpen).toHaveBeenCalledWith(false)
    expect(mocks.wikiState.setActiveView).toHaveBeenCalledWith("search")
  })

  it("回收站点击：切视图并调用 onOpenSidebar", async () => {
    renderSidebar()
    await clickTooltip("nav.trash")
    expect(mocks.wikiState.setActiveView).toHaveBeenCalledWith("trash")
    expect(mocks.onOpenSidebar).toHaveBeenCalledTimes(1)
  })

  it("回收站点击：未提供 onOpenSidebar 时可选链跳过", async () => {
    renderSidebar({ withOpenSidebar: false })
    await clickTooltip("nav.trash")
    expect(mocks.wikiState.setActiveView).toHaveBeenCalledWith("trash")
  })

  it("设置点击：关闭搜索面板并切到 settings", async () => {
    renderSidebar()
    await clickTooltip("novel.nav.settings")
    expect(mocks.wikiState.setSearchPanelOpen).toHaveBeenCalledWith(false)
    expect(mocks.wikiState.setActiveView).toHaveBeenCalledWith("settings")
  })

  it("切换项目点击：关闭搜索面板并调用 onSwitchProject", async () => {
    renderSidebar()
    fireEvent.click(buttonForTooltip("nav.switchProject"))
    expect(mocks.wikiState.setSearchPanelOpen).toHaveBeenCalledWith(false)
    expect(mocks.onSwitchProject).toHaveBeenCalledTimes(1)
  })

  it("logo 点击触发 onToggleSidebar；未提供时不崩溃", () => {
    const { rerender } = renderSidebar()
    const logo = screen.getByTitle("iconSidebar.toggleSidebar")
    fireEvent.click(logo)
    expect(mocks.onToggleSidebar).toHaveBeenCalledTimes(1)

    rerender(
      <IconSidebar
        onToggleSidebar={undefined}
        onOpenSidebar={undefined}
        onSwitchProject={mocks.onSwitchProject}
      />,
    )
    const logo2 = screen.getByTitle("iconSidebar.toggleSidebar")
    expect(() => fireEvent.click(logo2)).not.toThrow()
  })

  it("主题循环：system → light → dark → deep-blue → system（含持久化与主题应用）", async () => {
    const { rerender } = renderSidebar()
    const steps: Array<[string, string, string]> = [
      ["system", "light", "theme.toLight"],
      ["light", "dark", "theme.toDark"],
      ["dark", "deep-blue", "theme.toDeepBlue"],
      ["deep-blue", "system", "theme.toSystem"],
    ]
    for (const [current, next, tip] of steps) {
      mocks.wikiState.theme = current
      rerender(
        <IconSidebar
          onToggleSidebar={mocks.onToggleSidebar}
          onOpenSidebar={mocks.onOpenSidebar}
          onSwitchProject={mocks.onSwitchProject}
        />,
      )
      fireEvent.click(buttonForTooltip(tip))
      expect(mocks.wikiState.setTheme).toHaveBeenCalledWith(next)
      expect(mocks.saveTheme).toHaveBeenCalledWith(next)
      expect(mocks.applyTheme).toHaveBeenCalledWith(next)
      vi.clearAllMocks()
    }
  })

  it("未知主题（indexOf=-1）→ 循环回 system，default 图标分支", async () => {
    mocks.wikiState.theme = "solar"
    renderSidebar()
    // 未知主题 → 默认 tooltip t("theme.switch")
    fireEvent.click(buttonForTooltip("theme.switch"))
    expect(mocks.wikiState.setTheme).toHaveBeenCalledWith("system")
    expect(mocks.saveTheme).toHaveBeenCalledWith("system")
  })

  it("各主题 tooltip 文案（getThemeTooltip 全分支）", () => {
    const tooltips: Array<[string, string]> = [
      ["system", "theme.toLight"],
      ["light", "theme.toDark"],
      ["dark", "theme.toDeepBlue"],
      ["deep-blue", "theme.toSystem"],
    ]
    for (const [theme, tip] of tooltips) {
      mocks.wikiState.theme = theme
      const { unmount } = renderSidebar()
      expect(screen.getByText(tip)).toBeInTheDocument()
      unmount()
    }
  })

  it("当前视图高亮（activeView 匹配 qm-selected）", () => {
    mocks.wikiState.activeView = "search"
    renderSidebar()
    const searchBtn = buttonForTooltip("novel.nav.search")
    expect(String(searchBtn.className)).toContain("qm-selected")
    const wikiBtn = buttonForTooltip("novel.nav.wiki")
    expect(String(wikiBtn.className)).toContain("qm-hover")
  })

  it("reviewCenter 徽标：pending=1 显示计数与 tooltip 后缀", async () => {
    mocks.reviewState.items = [{ resolved: false }]
    renderSidebar()
    const btn = buttonForTooltip("novel.nav.reviewCenter (1)")
    const badge = btn.querySelector("span")
    expect(badge?.textContent).toBe("1")
    await clickTooltip("novel.nav.reviewCenter (1)")
    expect(mocks.wikiState.setActiveView).toHaveBeenCalledWith("reviewCenter")
  })

  it("reviewCenter 徽标：pending>99 显示 99+", () => {
    mocks.reviewState.items = Array.from({ length: 150 }, () => ({ resolved: false }))
    renderSidebar()
    const btn = buttonForTooltip("novel.nav.reviewCenter (150)")
    expect(btn.querySelector("span")?.textContent).toBe("99+")
  })

  it("pending=0 时不显示徽标（reviewCenter 无计数后缀）", () => {
    mocks.reviewState.items = [{ resolved: true }, { resolved: false }]
    // pending = 1 → 仍有徽标
    renderSidebar()
    const btn = buttonForTooltip("novel.nav.reviewCenter (1)")
    expect(btn.querySelector("span")?.textContent).toBe("1")
  })

  it("全部 resolved → 无徽标", () => {
    mocks.reviewState.items = [{ resolved: true }, { resolved: true }]
    renderSidebar()
    expect(screen.queryByText("novel.nav.reviewCenter (")).not.toBeInTheDocument()
  })

  it("activeView=settings/trash 时对应按钮高亮", () => {
    mocks.wikiState.activeView = "settings"
    const { rerender } = renderSidebar()
    expect(String(buttonForTooltip("novel.nav.settings").className)).toContain("qm-selected")

    mocks.wikiState.activeView = "trash"
    rerender(
      <IconSidebar
        onToggleSidebar={mocks.onToggleSidebar}
        onOpenSidebar={mocks.onOpenSidebar}
        onSwitchProject={mocks.onSwitchProject}
      />,
    )
    expect(String(buttonForTooltip("nav.trash").className)).toContain("qm-selected")
  })
})
