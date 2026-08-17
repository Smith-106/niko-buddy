// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  act,
  fireEvent,
  render,
  screen,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import { GraphSidebarPanel } from "./graph-sidebar-panel"

interface WikiStateLike {
  graphMode: string
  setGraphMode: (v: string) => void
  graphDisplayMode: string
  setGraphDisplayMode: (v: string) => void
  graphColorMode: string
  setGraphColorMode: (v: string) => void
  graphLabelDisplayMode: string
  setGraphLabelDisplayMode: (v: string) => void
  graphShowFilters: boolean
  setGraphShowFilters: (v: boolean) => void
  graphShowEdgeControls: boolean
  setGraphShowEdgeControls: (v: boolean) => void
  graphEdgeStyle: string
  setGraphEdgeStyle: (v: string) => void
  graphEdgeColorHex: string
  setGraphEdgeColorHex: (v: string) => void
  graphEdgeStrengthPercent: number
  setGraphEdgeStrengthPercent: (v: number) => void
  graphStats: {
    nodeCount: number
    edgeCount: number
    hiddenCount: number
    filteredNodeCount: number
    filteredEdgeCount: number
  }
  refreshGraph: (() => void) | null
}

const mocks = vi.hoisted(() => {
  const state: WikiStateLike = {
    graphMode: "overview",
    setGraphMode: vi.fn((v: string) => { state.graphMode = v }),
    graphDisplayMode: "graph",
    setGraphDisplayMode: vi.fn((v: string) => { state.graphDisplayMode = v }),
    graphColorMode: "type",
    setGraphColorMode: vi.fn((v: string) => { state.graphColorMode = v }),
    graphLabelDisplayMode: "all",
    setGraphLabelDisplayMode: vi.fn((v: string) => { state.graphLabelDisplayMode = v }),
    graphShowFilters: false,
    setGraphShowFilters: vi.fn((v: boolean) => { state.graphShowFilters = v }),
    graphShowEdgeControls: false,
    setGraphShowEdgeControls: vi.fn((v: boolean) => { state.graphShowEdgeControls = v }),
    graphEdgeStyle: "curve",
    setGraphEdgeStyle: vi.fn((v: string) => { state.graphEdgeStyle = v }),
    graphEdgeColorHex: "#7f8ea3",
    setGraphEdgeColorHex: vi.fn((v: string) => { state.graphEdgeColorHex = v }),
    graphEdgeStrengthPercent: 180,
    setGraphEdgeStrengthPercent: vi.fn((v: number) => { state.graphEdgeStrengthPercent = v }),
    graphStats: {
      nodeCount: 5,
      edgeCount: 7,
      hiddenCount: 0,
      filteredNodeCount: 3,
      filteredEdgeCount: 4,
    },
    refreshGraph: null,
  }
  return { state, t: vi.fn((key: string) => key) }
})

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: WikiStateLike) => unknown) => selector(mocks.state),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/components/layout/panel-header-with-help", () => ({
  PanelHeaderWithHelp: ({ title }: { title: string }) => <span data-testid="panel-title">{title}</span>,
}))

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled }: any) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}))

/** 根据 option 文案找到所属 select。 */
function selectByOption(text: string): HTMLSelectElement {
  const option = screen.getByText(text)
  const select = option.closest("select") as HTMLSelectElement
  expect(select).not.toBeNull()
  return select
}

describe("GraphSidebarPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupDomGlobals()
    mocks.state.graphMode = "overview"
    mocks.state.graphDisplayMode = "graph"
    mocks.state.graphColorMode = "type"
    mocks.state.graphLabelDisplayMode = "all"
    mocks.state.graphShowFilters = false
    mocks.state.graphShowEdgeControls = false
    mocks.state.graphEdgeStyle = "curve"
    mocks.state.graphEdgeColorHex = "#7f8ea3"
    mocks.state.graphEdgeStrengthPercent = 180
    mocks.state.graphStats = {
      nodeCount: 5,
      edgeCount: 7,
      hiddenCount: 0,
      filteredNodeCount: 3,
      filteredEdgeCount: 4,
    }
    mocks.state.refreshGraph = null
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanup()
  })

  it("默认渲染：标题/四个模式 select/统计徽标；refresh 禁用且不渲染边缘控制", () => {
    render(<GraphSidebarPanel />)
    expect(screen.getByTestId("panel-title")).toHaveTextContent("novel.graph.title")
    expect(selectByOption("novel.graph.modeLabels.overview").value).toBe("overview")
    expect(selectByOption("novel.graph.displayModeGraph").value).toBe("graph")
    expect(selectByOption("graph.type").value).toBe("type")
    expect(selectByOption("graph.labelDisplayAll").value).toBe("all")
    expect(screen.getByText("3/5 graph.pages")).toBeInTheDocument()
    expect(screen.getByText("4/7 graph.links")).toBeInTheDocument()
    expect(screen.queryByText("graph.hidden")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "" })).toBeDisabled()
    expect(screen.queryByText("线型")).not.toBeInTheDocument()
  })

  it("四个模式 select 切换分别调用对应 setter", () => {
    render(<GraphSidebarPanel />)
    fireEvent.change(selectByOption("novel.graph.modeLabels.overview"), { target: { value: "character" } })
    expect(mocks.state.setGraphMode).toHaveBeenCalledWith("character")

    fireEvent.change(selectByOption("novel.graph.displayModeGraph"), { target: { value: "document" } })
    expect(mocks.state.setGraphDisplayMode).toHaveBeenCalledWith("document")

    fireEvent.change(selectByOption("graph.type"), { target: { value: "community" } })
    expect(mocks.state.setGraphColorMode).toHaveBeenCalledWith("community")

    fireEvent.change(selectByOption("graph.labelDisplayAll"), { target: { value: "focused" } })
    expect(mocks.state.setGraphLabelDisplayMode).toHaveBeenCalledWith("focused")
  })

  it("refreshGraph 存在时可点击刷新", () => {
    const refresh = vi.fn()
    mocks.state.refreshGraph = refresh
    render(<GraphSidebarPanel />)
    const btn = screen.getByRole("button", { name: "" })
    expect(btn).toBeEnabled()
    fireEvent.click(btn)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("滤镜按钮切换 graphShowFilters", () => {
    const { rerender } = render(<GraphSidebarPanel />)
    const filterBtn = screen.getByText("graph.filter").closest("button") as HTMLButtonElement
    fireEvent.click(filterBtn)
    expect(mocks.state.setGraphShowFilters).toHaveBeenCalledWith(true)
    expect(mocks.state.graphShowFilters).toBe(true)
    // 重渲染：variant 三元切换 secondary 分支
    rerender(<GraphSidebarPanel />)
    fireEvent.click(screen.getByText("graph.filter").closest("button") as HTMLButtonElement)
    expect(mocks.state.setGraphShowFilters).toHaveBeenCalledWith(false)
  })

  it("线条设置按钮展开/收起边缘控制面板", () => {
    const { rerender } = render(<GraphSidebarPanel />)
    const edgeBtn = screen.getByText("线条设置").closest("button") as HTMLButtonElement
    fireEvent.click(edgeBtn)
    expect(mocks.state.setGraphShowEdgeControls).toHaveBeenCalledWith(true)
    expect(mocks.state.graphShowEdgeControls).toBe(true)

    rerender(<GraphSidebarPanel />)
    expect(screen.getByText("线型")).toBeInTheDocument()
    expect(screen.getByText("180%")).toBeInTheDocument()

    fireEvent.click(screen.getByText("线条设置").closest("button") as HTMLButtonElement)
    expect(mocks.state.setGraphShowEdgeControls).toHaveBeenCalledWith(false)
    expect(mocks.state.graphShowEdgeControls).toBe(false)
  })

  it("边缘控制：线型/颜色/强度变更调用对应 setter", () => {
    mocks.state.graphShowEdgeControls = true
    render(<GraphSidebarPanel />)

    fireEvent.change(selectByOption("曲线避让"), { target: { value: "arrow" } })
    expect(mocks.state.setGraphEdgeStyle).toHaveBeenCalledWith("arrow")

    const color = document.querySelector('input[type="color"]') as HTMLInputElement
    fireEvent.change(color, { target: { value: "#112233" } })
    expect(mocks.state.setGraphEdgeColorHex).toHaveBeenCalledWith("#112233")

    const range = document.querySelector('input[type="range"]') as HTMLInputElement
    fireEvent.change(range, { target: { value: "200" } })
    expect(mocks.state.setGraphEdgeStrengthPercent).toHaveBeenCalledWith(200)
  })

  it("hiddenCount > 0 时渲染琥珀徽标", () => {
    mocks.state.graphStats.hiddenCount = 2
    render(<GraphSidebarPanel />)
    expect(screen.getByText("2 graph.hidden")).toBeInTheDocument()
  })

  it("GRAPH_MODE_LABELS 全部模式都有对应 option", () => {
    render(<GraphSidebarPanel />)
    for (const mode of ["overview", "character", "chapter", "storyline", "foreshadowing"]) {
      expect(screen.getByText(`novel.graph.modeLabels.${mode}`)).toBeInTheDocument()
    }
  })
})
