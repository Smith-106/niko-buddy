// @vitest-environment jsdom
/**
 * DirectorSidebarPanel — 60号设计开书导演侧栏紧凑只读摘要真测试（替换C4空壳）。
 * 覆盖：无项目/无持久化→空态、持久化→五阶段列表、四种状态图标与样式、取消竞态、路径切换。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, act } from "@testing-library/react"
import { render, screen, setupDomGlobals, waitFor } from "@/test-helpers/component-test-utils"
import { DirectorSidebarPanel } from "./director-sidebar-panel"
import { DIRECTOR_PHASES } from "@/lib/novel"

const mocks = vi.hoisted(() => ({
  projectPath: null as string | null,
  hasPersisted: vi.fn(async (_path: string) => false),
  loadPersisted: vi.fn(async (_path: string) => ({ state: { statuses: {} } })),
  t: vi.fn((key: string) => key),
}))

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: (selector: (s: { project: { path: string } | null }) => unknown) =>
      selector({ project: mocks.projectPath ? { path: mocks.projectPath } : null }),
  }
})

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    hasPersistedDirectorState: mocks.hasPersisted,
    loadDirectorPersisted: mocks.loadPersisted,
  }
})

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  setupDomGlobals()
  vi.clearAllMocks()
  mocks.projectPath = null
  mocks.hasPersisted.mockResolvedValue(false)
  mocks.loadPersisted.mockResolvedValue({ state: { statuses: {} } })
})

afterEach(() => {
  cleanup()
})

describe("DirectorSidebarPanel", () => {
  it("无项目时渲染空态（不查持久化）", async () => {
    mocks.projectPath = null
    render(<DirectorSidebarPanel />)
    await flush()
    expect(mocks.hasPersisted).not.toHaveBeenCalled()
    expect(screen.getByTestId("director-sidebar-empty")).toBeTruthy()
    expect(screen.getByTestId("director-sidebar-empty").textContent).toContain("directorPanel.heroDesc")
  })

  it("有项目但无持久化 → 空态", async () => {
    mocks.projectPath = "/proj"
    mocks.hasPersisted.mockResolvedValue(false)
    render(<DirectorSidebarPanel />)
    await waitFor(() => expect(mocks.hasPersisted).toHaveBeenCalledWith("/proj"))
    await flush()
    expect(mocks.loadPersisted).not.toHaveBeenCalled()
    expect(screen.getByTestId("director-sidebar-empty")).toBeTruthy()
  })

  it("有持久化 → 渲染五阶段列表与标题", async () => {
    mocks.projectPath = "/proj"
    mocks.hasPersisted.mockResolvedValue(true)
    mocks.loadPersisted.mockResolvedValue({
      state: { statuses: { idea: "done", world: "failed", character: "running", outline: "pending", chapters: "pending" } },
    })
    render(<DirectorSidebarPanel />)
    await waitFor(() => expect(mocks.loadPersisted).toHaveBeenCalledWith("/proj"))
    await flush()
    for (const phase of DIRECTOR_PHASES) {
      expect(screen.getByTestId(`director-sidebar-${phase}`)).toBeTruthy()
    }
    expect(screen.getByTestId("director-sidebar").textContent).toContain("directorPanel.title")
    expect(screen.queryByTestId("director-sidebar-empty")).toBeNull()
  })

  it("四种状态图标：done=● failed=✗ running=◐ pending=○", async () => {
    mocks.projectPath = "/proj"
    mocks.hasPersisted.mockResolvedValue(true)
    mocks.loadPersisted.mockResolvedValue({
      state: { statuses: { idea: "done", world: "failed", character: "running", outline: "pending", chapters: "pending" } },
    })
    render(<DirectorSidebarPanel />)
    await flush()
    expect(screen.getByTestId("director-sidebar-idea").textContent).toContain("●")
    expect(screen.getByTestId("director-sidebar-world").textContent).toContain("✗")
    expect(screen.getByTestId("director-sidebar-character").textContent).toContain("◐")
    expect(screen.getByTestId("director-sidebar-outline").textContent).toContain("○")
    // 样式分支：done→success、failed→destructive、running→primary、pending→muted
    expect(screen.getByTestId("director-sidebar-idea").querySelector("span")?.className).toContain("text-success-foreground")
    expect(screen.getByTestId("director-sidebar-world").querySelector("span")?.className).toContain("text-destructive")
    expect(screen.getByTestId("director-sidebar-character").querySelector("span")?.className).toContain("text-primary")
    expect(screen.getByTestId("director-sidebar-outline").querySelector("span")?.className).toContain("text-muted-foreground")
  })

  it("阶段标签走 PHASE_LABEL_KEYS 映射", async () => {
    mocks.projectPath = "/proj"
    mocks.hasPersisted.mockResolvedValue(true)
    mocks.loadPersisted.mockResolvedValue({
      state: { statuses: { idea: "done", world: "done", character: "done", outline: "done", chapters: "done" } },
    })
    render(<DirectorSidebarPanel />)
    await flush()
    expect(screen.getByTestId("director-sidebar-idea").textContent).toContain("directorPanel.phaseIdea")
    expect(screen.getByTestId("director-sidebar-world").textContent).toContain("directorPanel.phaseWorld")
    expect(screen.getByTestId("director-sidebar-character").textContent).toContain("directorPanel.phaseCharacter")
    expect(screen.getByTestId("director-sidebar-outline").textContent).toContain("directorPanel.phaseOutline")
    expect(screen.getByTestId("director-sidebar-chapters").textContent).toContain("directorPanel.phaseChapters")
  })

  it("卸载取消竞态：has resolve 前卸载不写状态不崩溃", async () => {
    mocks.projectPath = "/proj"
    let resolveHas!: (v: boolean) => void
    mocks.hasPersisted.mockImplementation(() => new Promise<boolean>((r) => { resolveHas = r }))
    const { unmount } = render(<DirectorSidebarPanel />)
    unmount()
    await act(async () => { resolveHas(true) })
    await flush()
    // 卸载后 load 不应被调用（cancelled 早退）
    expect(mocks.loadPersisted).not.toHaveBeenCalled()
  })

  it("load resolve 前卸载不写状态", async () => {
    mocks.projectPath = "/proj"
    mocks.hasPersisted.mockResolvedValue(true)
    let resolveLoad!: (v: unknown) => void
    mocks.loadPersisted.mockImplementation(
      () => new Promise((r) => { resolveLoad = r as unknown as (v: unknown) => void }),
    )
    const { unmount } = render(<DirectorSidebarPanel />)
    await waitFor(() => expect(mocks.hasPersisted).toHaveBeenCalled())
    unmount()
    await act(async () => {
      resolveLoad({ state: { statuses: { idea: "done", world: "done", character: "done", outline: "done", chapters: "done" } } })
    })
    await flush()
    expect(document.body.textContent ?? "").not.toContain("director-sidebar-idea")
  })

  it("项目路径切换重新加载", async () => {
    mocks.projectPath = "/proj-a"
    mocks.hasPersisted.mockResolvedValue(false)
    const { rerender } = render(<DirectorSidebarPanel />)
    await waitFor(() => expect(mocks.hasPersisted).toHaveBeenCalledWith("/proj-a"))
    mocks.hasPersisted.mockClear()
    mocks.projectPath = "/proj-b"
    rerender(<DirectorSidebarPanel />)
    await waitFor(() => expect(mocks.hasPersisted).toHaveBeenCalledWith("/proj-b"))
  })
})
