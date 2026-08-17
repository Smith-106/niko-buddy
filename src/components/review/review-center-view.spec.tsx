// @vitest-environment jsdom
/**
 * W4E5 coverage campaign — ReviewCenterView 全口径 100%（原 SSR spec 无法覆盖 ReviewStartButton）。
 * jsdom + vi.mock：wiki-store 可写 state、ReviewView/DashboardView 渲染占位、
 * readFile / startSixDimensionReviewRun mock。断言对照源码实现。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  act,
  fireEvent,
  render,
  screen,
  setupDomGlobals,
  waitFor,
} from "@/test-helpers/component-test-utils"
import { ReviewCenterView } from "./review-center-view"
import type { ReactNode } from "react"

interface ReviewRunLike {
  running?: boolean
}

const mocks = vi.hoisted(() => {
  const state: {
    selectedReviewDimension: string | null
    novelMode: boolean
    project: { id: string; name: string; path: string } | null
    selectedReviewFilePath: string
    reviewRun: ReviewRunLike | null
  } = {
    selectedReviewDimension: "thrill",
    novelMode: true,
    project: { id: "p1", name: "Book", path: "/p" },
    selectedReviewFilePath: "/p/wiki/ch1.md",
    reviewRun: null,
  }
  return {
    state,
    t: vi.fn((key: string) => key),
    readFile: vi.fn(async (): Promise<string> => "# 正文"),
    startSixDimensionReviewRun: vi.fn(async () => {}),
  }
})

vi.mock("react-i18next", () => ({
  initReactI18next: {
    type: "3rdParty",
    init: vi.fn(),
  },
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: typeof mocks.state) => unknown) => selector(mocks.state),
}))

vi.mock("./review-view", () => ({
  ReviewView: (props: {
    title?: string
    emptyMessage?: string
    characterOnly?: boolean
    dimensionKey?: string
  }) => (
    <div
      data-review-view="true"
      data-title={props.title ?? ""}
      data-empty={props.emptyMessage ?? ""}
      data-character-only={props.characterOnly ? "true" : "false"}
      data-dimension-key={props.dimensionKey ?? ""}
    />
  ),
}))

vi.mock("@/components/dashboard/dashboard-view", () => ({
  DashboardView: ({ headerActions }: { headerActions?: ReactNode }) => (
    <div data-dashboard-view="true">{headerActions}</div>
  ),
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
}))

vi.mock("@/lib/novel/start-six-dimension-review-run", () => ({
  startSixDimensionReviewRun: mocks.startSixDimensionReviewRun,
}))

function resetState(): void {
  mocks.state.selectedReviewDimension = "thrill"
  mocks.state.novelMode = true
  mocks.state.project = { id: "p1", name: "Book", path: "/p" }
  mocks.state.selectedReviewFilePath = "/p/wiki/ch1.md"
  mocks.state.reviewRun = null
  mocks.readFile.mockResolvedValue("# 正文")
  mocks.startSixDimensionReviewRun.mockResolvedValue(undefined)
}

beforeEach(() => {
  vi.clearAllMocks()
  resetState()
  setupDomGlobals()
})

afterEach(() => {
  cleanup()
})

describe("ReviewCenterView — 路由", () => {
  it("ai-review → 无维度 key 的原生 ReviewView", () => {
    mocks.state.selectedReviewDimension = "ai-review"
    render(<ReviewCenterView />)
    const view = document.querySelector("[data-review-view]") as HTMLElement
    expect(view.getAttribute("data-dimension-key")).toBe("")
    expect(view.getAttribute("data-title")).toBe("")
  })

  it("character-report → 角色命中报告视图（characterOnly）", () => {
    mocks.state.selectedReviewDimension = "character-report"
    render(<ReviewCenterView />)
    const view = document.querySelector("[data-review-view]") as HTMLElement
    expect(view.getAttribute("data-title")).toBe("角色命中报告")
    expect(view.getAttribute("data-empty")).toBe("暂无角色命中报告，请先运行AI审稿。")
    expect(view.getAttribute("data-character-only")).toBe("true")
  })

  it("无 selectedReviewDimension → DashboardView + ReviewStartButton", () => {
    mocks.state.selectedReviewDimension = null
    render(<ReviewCenterView />)
    expect(document.querySelector("[data-dashboard-view]") as HTMLElement).toBeTruthy()
    expect(screen.getByRole("button", { name: "reviewCenter.startReview" })).toBeTruthy()
  })

  it("novelMode=false → DashboardView", () => {
    mocks.state.novelMode = false
    render(<ReviewCenterView />)
    expect(document.querySelector("[data-dashboard-view]") as HTMLElement).toBeTruthy()
  })

  it("非六维 key（未知字符串）→ DashboardView", () => {
    mocks.state.selectedReviewDimension = "bogus-tab"
    render(<ReviewCenterView />)
    expect(document.querySelector("[data-dashboard-view]") as HTMLElement).toBeTruthy()
  })

  it("六维 key → ReviewView 携带 dimensionKey 与 title", () => {
    mocks.state.selectedReviewDimension = "thrill"
    render(<ReviewCenterView />)
    const view = document.querySelector("[data-review-view]") as HTMLElement
    expect(view.getAttribute("data-dimension-key")).toBe("thrill")
    expect(view.getAttribute("data-title")).toBe("reviewCenter.dimension.thrill")
    expect(view.getAttribute("data-empty")).toBe("reviewCenter.noResults")
  })

  it("每个六维 key 均通过 isSixReviewDimensionKey", () => {
    for (const key of ["thrill", "consistency", "pacing", "character", "continuity", "pull"]) {
      mocks.state.selectedReviewDimension = key
      const { unmount } = render(<ReviewCenterView />)
      expect(
        (document.querySelector("[data-review-view]") as HTMLElement).getAttribute("data-dimension-key"),
      ).toBe(key)
      unmount()
    }
  })
})

describe("ReviewStartButton — 可用性", () => {
  function renderDashboard(): void {
    mocks.state.selectedReviewDimension = null
  }

  it("无项目时禁用（title 由 selectedReviewFilePath 单独决定）", () => {
    mocks.state.project = null
    renderDashboard()
    render(<ReviewCenterView />)
    const btn = screen.getByRole("button", { name: "reviewCenter.startReview" }) as HTMLButtonElement
    expect(btn.hasAttribute("disabled")).toBe(true)
    expect(btn.getAttribute("title")).toBeNull()
  })

  it("未选择审查文件时禁用并带提示 title", () => {
    mocks.state.selectedReviewFilePath = ""
    renderDashboard()
    render(<ReviewCenterView />)
    const btn = screen.getByRole("button", { name: "reviewCenter.startReview" }) as HTMLButtonElement
    expect(btn.hasAttribute("disabled")).toBe(true)
    expect(btn.getAttribute("title")).toBe("请先在左侧选择审查章节")
  })

  it("审查进行中（reviewRun.running）→ 禁用 + reviewingAction 文案", () => {
    mocks.state.reviewRun = { running: true }
    renderDashboard()
    render(<ReviewCenterView />)
    const btn = screen.getByRole("button", { name: "reviewCenter.reviewingAction" }) as HTMLButtonElement
    expect(btn.hasAttribute("disabled")).toBe(true)
  })

  it("可审查时按钮可用、无提示 title", () => {
    renderDashboard()
    render(<ReviewCenterView />)
    const btn = screen.getByRole("button", { name: "reviewCenter.startReview" }) as HTMLButtonElement
    expect(btn.hasAttribute("disabled")).toBe(false)
    expect(btn.getAttribute("title")).toBeNull()
  })

  it("reviewRun 为 null 时 isReviewing=false（?? 分支）", () => {
    renderDashboard()
    render(<ReviewCenterView />)
    expect(screen.getByRole("button", { name: "reviewCenter.startReview" })).toBeTruthy()
  })
})

describe("ReviewStartButton — 启动审查", () => {
  function renderDashboard(): void {
    mocks.state.selectedReviewDimension = null
  }

  it("点击 → readFile → startSixDimensionReviewRun（fileContent/projectPath/selectedFile/t）", async () => {
    renderDashboard()
    render(<ReviewCenterView />)
    fireEvent.click(screen.getByRole("button", { name: "reviewCenter.startReview" }))
    await waitFor(() => expect(mocks.readFile).toHaveBeenCalledWith("/p/wiki/ch1.md"))
    await waitFor(() =>
      expect(mocks.startSixDimensionReviewRun).toHaveBeenCalledWith({
        fileContent: "# 正文",
        projectPath: "/p",
        selectedFile: "/p/wiki/ch1.md",
        t: expect.any(Function),
      }),
    )
  })

  it("readFile 失败 → console.error（不调 startSixDimensionReviewRun）", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.readFile.mockRejectedValue(new Error("read-boom"))
    renderDashboard()
    render(<ReviewCenterView />)
    fireEvent.click(screen.getByRole("button", { name: "reviewCenter.startReview" }))
    await waitFor(() => expect(errorSpy).toHaveBeenCalledWith("[ReviewCenterView] 读取审查章节失败:", expect.any(Error)))
    expect(mocks.startSixDimensionReviewRun).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it("无项目时点击不触发读取（守卫返回）", async () => {
    mocks.state.project = null
    renderDashboard()
    render(<ReviewCenterView />)
    const btn = screen.getByRole("button", { name: "reviewCenter.startReview" }) as HTMLButtonElement
    fireEvent.click(btn)
    await act(async () => {})
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it("审查进行中时点击不触发读取（守卫返回）", async () => {
    mocks.state.reviewRun = { running: true }
    renderDashboard()
    render(<ReviewCenterView />)
    const btn = screen.getByRole("button", { name: "reviewCenter.reviewingAction" }) as HTMLButtonElement
    fireEvent.click(btn)
    await act(async () => {})
    expect(mocks.readFile).not.toHaveBeenCalled()
  })
})
