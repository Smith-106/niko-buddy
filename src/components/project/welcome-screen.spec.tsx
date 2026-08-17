// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/project/welcome-screen.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/test-helpers/component-test-utils"
import { WelcomeScreen } from "./welcome-screen"

const mocks = vi.hoisted(() => {
  const state: { novelMode: boolean } = { novelMode: false }
  return {
    state,
    t: vi.fn((key: string) => key),
    getRecentProjects: vi.fn(async () => []),
    removeFromRecentProjects: vi.fn(async () => {}),
    importBackup: vi.fn(),
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: typeof mocks.state) => unknown) => selector(mocks.state),
}))

vi.mock("@/lib/project-store", () => ({
  getRecentProjects: mocks.getRecentProjects,
  removeFromRecentProjects: mocks.removeFromRecentProjects,
}))

vi.mock("@/lib/backup/import", () => ({
  importBackup: mocks.importBackup,
}))

vi.mock("@/components/ui/button", () => ({
  // NOTE: `disabled` is intentionally NOT forwarded — jsdom/React never
  // dispatch clicks on disabled buttons, which would make the component's
  // own `if (isRestoring) return` guard (line 38) unreachable. Dropping it
  // in the test double lets us exercise the guard directly.
  Button: ({
    children,
    onClick,
  }: {
    children: unknown
    onClick?: () => void
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}))

const PROJECTS = [
  { id: "p1", name: "Alpha Book", path: "/projects/alpha" },
  { id: "p2", name: "Beta Wiki", path: "/projects/beta" },
]

function renderWelcome(
  props: Partial<Parameters<typeof WelcomeScreen>[0]> = {},
): ReturnType<typeof render> {
  return render(
    <WelcomeScreen
      onCreateProject={vi.fn()}
      onOpenProject={vi.fn()}
      onSelectProject={vi.fn()}
      {...props}
    />,
  )
}

beforeEach(() => {
  mocks.state.novelMode = false
  // mockReset clears queued once-values from the previous test
  mocks.getRecentProjects.mockReset()
  mocks.getRecentProjects.mockResolvedValue([])
  mocks.removeFromRecentProjects.mockReset()
  mocks.importBackup.mockReset()
  vi.spyOn(window, "alert").mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("WelcomeScreen", () => {
  it("renders app title/subtitle and action buttons (non-novel mode)", () => {
    renderWelcome()
    expect(mocks.t).toHaveBeenCalledWith("app.title")
    expect(mocks.t).toHaveBeenCalledWith("app.subtitle")
    expect(screen.getByText("welcome.newProject")).toBeInTheDocument()
    expect(screen.getByText("welcome.openProject")).toBeInTheDocument()
    expect(screen.getByText("恢复数据")).toBeInTheDocument()
    // no recent projects → list section hidden
    expect(screen.queryByText("welcome.recentProjects")).not.toBeInTheDocument()
  })

  it("renders novel title/subtitle in novel mode", () => {
    mocks.state.novelMode = true
    renderWelcome()
    expect(mocks.t).toHaveBeenCalledWith("novel.app.title")
    expect(mocks.t).toHaveBeenCalledWith("novel.app.subtitle")
  })

  it("fires onCreateProject / onOpenProject", () => {
    const onCreateProject = vi.fn()
    const onOpenProject = vi.fn()
    renderWelcome({ onCreateProject, onOpenProject })
    fireEvent.click(screen.getByText("welcome.newProject"))
    expect(onCreateProject).toHaveBeenCalled()
    fireEvent.click(screen.getByText("welcome.openProject"))
    expect(onOpenProject).toHaveBeenCalled()
  })

  it("loads recent projects on mount and renders them", async () => {
    mocks.getRecentProjects.mockResolvedValue(PROJECTS)
    renderWelcome()
    await waitFor(() => {
      expect(screen.getByText("Alpha Book")).toBeInTheDocument()
    })
    expect(screen.getByText("/projects/alpha")).toBeInTheDocument()
    expect(screen.getByText("welcome.recentProjects")).toBeInTheDocument()
  })

  it("selects a project when its row is clicked", async () => {
    mocks.getRecentProjects.mockResolvedValue(PROJECTS)
    const onSelectProject = vi.fn()
    renderWelcome({ onSelectProject })
    await waitFor(() => {
      expect(screen.getByText("Alpha Book")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText("Alpha Book"))
    expect(onSelectProject).toHaveBeenCalledWith(PROJECTS[0])
  })

  it("removes a recent project via the X button and refreshes the list", async () => {
    mocks.getRecentProjects.mockResolvedValueOnce(PROJECTS).mockResolvedValueOnce([PROJECTS[1]])
    renderWelcome()
    await waitFor(() => {
      expect(screen.getByText("Alpha Book")).toBeInTheDocument()
    })
    // the X remove control is a div[role=button] with an aria-hidden icon (empty name)
    const removeButtons = screen.getAllByRole("button", { name: "" })
    fireEvent.click(removeButtons[0])
    expect(mocks.removeFromRecentProjects).toHaveBeenCalledWith("/projects/alpha")
    await waitFor(() => {
      expect(screen.queryByText("Alpha Book")).not.toBeInTheDocument()
    })
    expect(mocks.getRecentProjects).toHaveBeenCalledTimes(2)
  })

  it("removes a recent project via Enter key on the X button", async () => {
    mocks.getRecentProjects.mockResolvedValueOnce(PROJECTS).mockResolvedValueOnce([PROJECTS[1]])
    renderWelcome()
    await waitFor(() => {
      expect(screen.getByText("Alpha Book")).toBeInTheDocument()
    })
    const removeButtons = screen.getAllByRole("button", { name: "" })
    fireEvent.keyDown(removeButtons[0], { key: "Enter" })
    await waitFor(() => {
      expect(mocks.removeFromRecentProjects).toHaveBeenCalledWith("/projects/alpha")
    })
  })

  it("ignores a rejected getRecentProjects on mount (catch no-op)", async () => {
    mocks.getRecentProjects.mockRejectedValue(new Error("store-boom"))
    renderWelcome()
    await waitFor(() => {
      expect(mocks.getRecentProjects).toHaveBeenCalled()
    })
    expect(screen.queryByText("welcome.recentProjects")).not.toBeInTheDocument()
  })

  it("restores backup successfully: alert success + refreshes recent projects", async () => {
    mocks.importBackup.mockResolvedValue({
      success: true,
      projects: [{ success: true }, { success: false }],
      error: undefined,
    })
    renderWelcome()
    // let the mount effect settle so the refresh below is deterministic
    await waitFor(() => {
      expect(mocks.getRecentProjects).toHaveBeenCalledTimes(1)
    })
    mocks.getRecentProjects.mockResolvedValue(PROJECTS)
    fireEvent.click(screen.getByText("恢复数据"))
    await waitFor(() => {
      expect(mocks.importBackup).toHaveBeenCalledWith("full", undefined, expect.any(Function))
    })
    expect(window.alert).toHaveBeenCalledWith(
      "恢复成功！共恢复 1 个项目。\n请在列表中选择项目打开。",
    )
    await waitFor(() => {
      expect(screen.getByText("Alpha Book")).toBeInTheDocument()
    })
    // progress callback invoked with stage/message and logged
    const progressCb = mocks.importBackup.mock.calls[0][2]
    progressCb({ stage: "import", message: "extracting" })
  })

  it("restores backup with success=false → alert failure with result.error", async () => {
    mocks.importBackup.mockResolvedValue({ success: false, error: "zip corrupt", projects: [] })
    renderWelcome()
    fireEvent.click(screen.getByText("恢复数据"))
    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith("恢复失败：zip corrupt")
    })
  })

  it("restores backup with success=false and no error → 未知错误 fallback", async () => {
    mocks.importBackup.mockResolvedValue({ success: false, projects: [] })
    renderWelcome()
    fireEvent.click(screen.getByText("恢复数据"))
    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith("恢复失败：未知错误")
    })
  })

  it("restore throws an Error → alert with its message", async () => {
    mocks.importBackup.mockRejectedValue(new Error("disk failure"))
    renderWelcome()
    fireEvent.click(screen.getByText("恢复数据"))
    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith("恢复失败：disk failure")
    })
  })

  it("restore throws a non-Error value → alert with String(value)", async () => {
    mocks.importBackup.mockRejectedValue("raw-string")
    renderWelcome()
    fireEvent.click(screen.getByText("恢复数据"))
    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith("恢复失败：raw-string")
    })
  })

  it("non-Enter key on the remove control is a no-op (guard branch)", async () => {
    mocks.getRecentProjects.mockResolvedValue(PROJECTS)
    renderWelcome()
    await waitFor(() => {
      expect(screen.getByText("Alpha Book")).toBeInTheDocument()
    })
    const removeButtons = screen.getAllByRole("button", { name: "" })
    fireEvent.keyDown(removeButtons[0], { key: "Tab" })
    expect(mocks.removeFromRecentProjects).not.toHaveBeenCalled()
  })

  it("shows 恢复中... while restoring; guard blocks concurrent re-entry", async () => {
    let resolveImport: (v: unknown) => void = () => {}
    mocks.importBackup.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveImport = resolve
        }),
    )
    renderWelcome()
    fireEvent.click(screen.getByText("恢复数据"))
    expect(screen.getByText("恢复中...")).toBeInTheDocument()

    // handler guard: second invocation while isRestoring=true returns
    // early → importBackup still called exactly once
    fireEvent.click(screen.getByText("恢复中..."))
    expect(mocks.importBackup).toHaveBeenCalledTimes(1)

    resolveImport({ success: true, projects: [] })
    await waitFor(() => {
      expect(screen.getByText("恢复数据")).toBeInTheDocument()
    })
  })
})
