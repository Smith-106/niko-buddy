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
    novelReviewEntries: Array<{ resolved: boolean }>
  } = {
    items: [],
    novelReviewEntries: [],
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
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
      useWikiStore: Object.assign(
        (selector: (s: typeof mocks.wikiState) => unknown) => selector(mocks.wikiState),
        { getState: () => mocks.wikiState },
      ),
    
  }
})

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

/** 行内文案即按钮文本：行按钮含图标+文字+徽标，取其最近 button 祖先。
 * 图标行（回收站/封面/翻译/同人）无文本，回退到 title 定位。 */
function buttonForTooltip(text: string): HTMLButtonElement {
  const els = [...screen.queryAllByText(text), ...screen.queryAllByTitle(text)]
  for (const el of els) {
    const btn = el.closest("button")
    if (btn) return btn as HTMLButtonElement
  }
  throw new Error(`button not found for tooltip: ${text}`)
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
  // 交互用例沿用全展开（批5首刷默认折叠由 nav-items.spec 覆盖，避免 11 个点击用例重写）。
  localStorage.setItem("niko-buddy-nav-collapsed-groups", JSON.stringify([]))
  mocks.wikiState.activeView = "wiki"
  mocks.wikiState.selectedFile = null
  mocks.wikiState.theme = "system"
  mocks.reviewState.items = []
  mocks.reviewState.novelReviewEntries = []
})

describe("IconSidebar", () => {
  it("渲染全部导航项、搜索、回收站、主题、设置与切换项目按钮", () => {
    renderSidebar()
    // primary 常驻项首刷即见；lint 为 secondary，需先展开 More。
    fireEvent.click(screen.getByTestId("nav-more-shen"))
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
      // 图标行按钮（回收站）无文本，用 title 兼配
      const els = [...screen.queryAllByText(label), ...screen.queryAllByTitle(label)]
      expect(els.length, label).toBeGreaterThan(0)
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
      // lint 为 secondary，需先展开 shen 组 More。
      if (view === "lint" && screen.queryByTestId("nav-more-shen")) {
        fireEvent.click(screen.getByTestId("nav-more-shen"))
      }
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

  it("主题循环：system → light → dark → deep-blue → eye-care → system（含持久化与主题应用）", async () => {
    const { rerender } = renderSidebar()
    const steps: Array<[string, string, string]> = [
      ["system", "light", "theme.toLight"],
      ["light", "dark", "theme.toDark"],
      ["dark", "deep-blue", "theme.toDeepBlue"],
      ["deep-blue", "eye-care", "theme.toEyeCare"],
      ["eye-care", "system", "theme.toSystem"],
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
      ["deep-blue", "theme.toEyeCare"],
      ["eye-care", "theme.toSystem"],
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

  it("reviewCenter 徽标：pending=1 显示计数徽标", async () => {
    mocks.reviewState.items = [{ resolved: false }]
    renderSidebar()
    const btn = buttonForTooltip("novel.nav.reviewCenter")
    const badge = btn.querySelector('[data-testid="nav-badge"]')
    expect(badge?.textContent).toBe("1")
    fireEvent.click(btn)
    await waitFor(() => {
      expect(mocks.wikiState.setActiveView).toHaveBeenCalledWith("reviewCenter")
    })
  })

  it("reviewCenter 徽标：pending>99 显示 99+", () => {
    mocks.reviewState.items = Array.from({ length: 150 }, () => ({ resolved: false }))
    renderSidebar()
    const btn = buttonForTooltip("novel.nav.reviewCenter")
    expect(btn.querySelector('[data-testid="nav-badge"]')?.textContent).toBe("99+")
  })

  it("pending=1 时显示徽标", () => {
    mocks.reviewState.items = [{ resolved: true }, { resolved: false }]
    // pending = 1 → 仍有徽标
    renderSidebar()
    const btn = buttonForTooltip("novel.nav.reviewCenter")
    expect(btn.querySelector('[data-testid="nav-badge"]')?.textContent).toBe("1")
  })

  it("全部 resolved → 无徽标", () => {
    mocks.reviewState.items = [{ resolved: true }, { resolved: true }]
    renderSidebar()
    const btn = buttonForTooltip("novel.nav.reviewCenter")
    expect(btn.querySelector('[data-testid="nav-badge"]')).toBeNull()
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

  it("四组分组展示：组头渲染+分组内导航项齐全+条目数徽标", () => {
    // t mock 回显 key 本身，分组头文案即 key
    renderSidebar()
    for (const key of ["novel.nav.groupMa", "novel.nav.groupSi", "novel.nav.groupShen", "novel.nav.groupMaint"]) {
      expect(screen.getByText(key)).toBeTruthy()
    }
    // 分组顺序：写和审 < 开书 < 查账 < 设置（默认视图 章节库 落在首组）
    const html = document.body.innerHTML
    expect(html.indexOf("novel.nav.groupMa")).toBeLessThan(html.indexOf("novel.nav.groupSi"))
    expect(html.indexOf("novel.nav.groupSi")).toBeLessThan(html.indexOf("novel.nav.groupShen"))
    expect(html.indexOf("novel.nav.groupShen")).toBeLessThan(html.indexOf("novel.nav.groupMaint"))
    // 分层收纳：primary 首刷即见，secondary 需展开 More 后可达。
    const primaryViews = ["workbench", "wiki", "director", "storySimulation", "sources", "graph", "soul", "bookAnalysis", "canonEditor", "reviewCenter", "followUpCenter", "mainControl", "creativeHub", "bookshelf", "backupExport"]
    for (const v of primaryViews) {
      expect(document.querySelector(`[data-view="${v}"]`), v).toBeTruthy()
    }
    // secondary 首刷收起（More 未展开时不可见）
    expect(document.querySelector('[data-view="marketRadar"]')).toBeNull()
    expect(document.querySelector('[data-view="lint"]')).toBeNull()
    // 展开各组 More 后 31 个 data-view 无缺失
    for (const g of ["si", "shen", "maint"]) {
      const moreBtn = document.querySelector(`[data-testid="nav-more-${g}"]`) as HTMLButtonElement | null
      if (moreBtn) fireEvent.click(moreBtn)
    }
    const views = ["workbench", "wiki", "director", "sources", "graph", "lint", "soul", "skillLibrary", "storySimulation", "bookAnalysis", "canonEditor", "backupExport", "diagnosticsCenter", "reviewCenter", "dataManager", "followUpCenter", "mainControl", "liveExecution", "creativeHub", "bookshelf", "genreLibrary", "storyModeLibrary", "titleStudio", "styleEngine", "antiAiRules", "workflowEditor", "marketRadar", "modelRoutes", "mcpManager", "exportCenter", "help"]
    for (const v of views) {
      expect(document.querySelector(`[data-view="${v}"]`), v).toBeTruthy()
    }
    // 分组内容归属：审校组不再包含备份/诊断/数据管理（审计 F-03 分组语义错位修正）
    expect(document.querySelector('[data-nav-group="shen"] [data-view="backupExport"]')).toBeNull()
    expect(document.querySelector('[data-nav-group="maint"] [data-view="backupExport"]')).toBeTruthy()
    expect(document.querySelector('[data-nav-group="ma"] [data-view="wiki"]')).toBeTruthy()
    // 组头显示条目数
    expect(document.querySelector('[data-nav-group="ma"] [data-view="reviewCenter"]')).toBeTruthy()
    expect(document.querySelector('[data-nav-group="ma"] [data-view="followUpCenter"]')).toBeTruthy()
    expect(document.querySelector('[data-nav-group="ma"] [data-view="exportCenter"]')).toBeNull()
    expect(document.querySelector('[data-nav-group="maint"] [data-view="exportCenter"]')).toBeTruthy()
    expect(document.querySelector('[data-nav-group="ma"] button[aria-expanded]')?.textContent).toContain("4")
    expect(document.querySelector('[data-nav-group="si"] button[aria-expanded]')?.textContent).toContain("7")
  })

  it("首刷构思组默认收起：点开展开再收起（含 localStorage 持久化）", () => {
    window.localStorage.removeItem("niko-buddy-nav-collapsed-groups")
    renderSidebar()
    const header = document.querySelector('[data-nav-group="si"] button[aria-expanded]') as HTMLButtonElement
    expect(header.getAttribute("aria-expanded")).toBe("false")
    expect(document.querySelector('[data-nav-group="si"] [data-view="director"]')).toBeNull()

    fireEvent.click(header)
    expect(header.getAttribute("aria-expanded")).toBe("true")
    expect(document.querySelector('[data-nav-group="si"] [data-view="director"]')).toBeTruthy()
    expect(JSON.parse(window.localStorage.getItem("niko-buddy-nav-collapsed-groups") ?? "[]")).toEqual([
      "shen",
      "maint",
    ])

    fireEvent.click(header)
    expect(header.getAttribute("aria-expanded")).toBe("false")
    expect(document.querySelector('[data-nav-group="si"] [data-view="director"]')).toBeNull()
  })

  it("当前视图所在组被折叠时自动展开（键盘/外部跳转不会落到看不见的高亮项）", () => {
    window.localStorage.setItem("niko-buddy-nav-collapsed-groups", JSON.stringify(["si"]))
    mocks.wikiState.activeView = "director"
    renderSidebar()
    expect(document.querySelector('[data-nav-group="si"] [data-view="director"]')).toBeTruthy()
    window.localStorage.removeItem("niko-buddy-nav-collapsed-groups")
  })

  it("localStorage 存储值非法时降级为全部展开（不崩溃）", () => {
    window.localStorage.setItem("niko-buddy-nav-collapsed-groups", "{not-json")
    expect(() => renderSidebar()).not.toThrow()
    expect(document.querySelector('[data-nav-group="si"] [data-view="director"]')).toBeTruthy()
    window.localStorage.removeItem("niko-buddy-nav-collapsed-groups")
  })

  it("More 收纳：secondary 首刷隐藏，点击 More 后展开", () => {
    renderSidebar()
    expect(document.querySelector('[data-nav-group="maint"] [data-view="marketRadar"]')).toBeNull()
    fireEvent.click(screen.getByTestId("nav-more-maint"))
    expect(document.querySelector('[data-nav-group="maint"] [data-view="marketRadar"]')).toBeTruthy()
    fireEvent.click(screen.getByTestId("nav-more-maint"))
    expect(document.querySelector('[data-nav-group="maint"] [data-view="marketRadar"]')).toBeNull()
  })

  it("命中 secondary 时自动展开 More（外部跳转不落空）", () => {
    mocks.wikiState.activeView = "marketRadar"
    renderSidebar()
    expect(document.querySelector('[data-nav-group="maint"] [data-view="marketRadar"]')).toBeTruthy()
    mocks.wikiState.activeView = "wiki"
  })
})
