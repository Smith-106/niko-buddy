// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup } from "@testing-library/react"
import {
  fireEvent,
  render,
  screen,
} from "@/test-helpers/component-test-utils"
import { TrashPanel } from "./trash-panel"
import type { TrashItem, RestoreTrashResult } from "@/lib/trash"

interface ProjectLike {
  id: string
  name: string
  path: string
}

interface WikiStateLike {
  project: ProjectLike | null
  selectedTrashItem: TrashItem | null
  setFileTree: ReturnType<typeof vi.fn>
  setSelectedFile: ReturnType<typeof vi.fn>
  setSelectedTrashItem: ReturnType<typeof vi.fn>
  setFileContent: ReturnType<typeof vi.fn>
  setActiveView: ReturnType<typeof vi.fn>
  bumpDataVersion: ReturnType<typeof vi.fn>
}

const DEFAULT_PROJECT: ProjectLike = { id: "p1", name: "MyBook", path: "/p/mybook" }

function makeItem(overrides: Partial<TrashItem> = {}): TrashItem {
  const now = Date.now()
  return {
    id: "item-1",
    name: "page.md",
    originalPath: "/p/page.md",
    trashPath: "/p/.trash/item-1.md",
    deletedAt: now - 1000,
    expiresAt: now + 29 * 86_400_000,
    kind: "page",
    ...overrides,
  }
}

const mocks = vi.hoisted(() => {
  const state: WikiStateLike = {
    project: null,
    selectedTrashItem: null,
    setFileTree: vi.fn<() => void>(),
    setSelectedFile: vi.fn<() => void>(),
    setSelectedTrashItem: vi.fn<() => void>(),
    setFileContent: vi.fn<() => void>(),
    setActiveView: vi.fn<() => void>(),
    bumpDataVersion: vi.fn<() => void>(),
  }
  return {
    state,
    t: vi.fn<(key: string) => string>((key: string) => key),
    normalizePath: vi.fn<(p: string) => string>((p: string) => p),
    listDirectory: vi.fn<() => Promise<unknown[]>>(async () => []),
    listTrashItems: vi.fn<() => Promise<TrashItem[]>>(async () => []),
    cleanupExpiredTrashItems: vi.fn<(projectPath: string) => Promise<void>>(async () => {}),
    readTrashItemContent: vi.fn<(item: TrashItem) => Promise<string>>(async () => "content"),
    restoreTrashItem: vi.fn<(item: TrashItem) => Promise<RestoreTrashResult>>(async (): Promise<RestoreTrashResult> => ({
      item: makeItem(),
      restoredPath: "/p/page.md",
      renamed: false,
    })),
    permanentlyDeleteTrashItem: vi.fn<(item: TrashItem) => Promise<void>>(async () => {}),
    permanentlyDeleteAllTrashItems: vi.fn<(projectPath: string) => Promise<void>>(async () => {}),
    getTrashDaysRemaining: vi.fn<(item: TrashItem, now?: number) => number>(() => 29),
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: unknown) => unknown) => selector(mocks.state),
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: mocks.listDirectory,
}))

vi.mock("@/lib/path-utils", () => ({
  normalizePath: mocks.normalizePath,
}))

vi.mock("@/lib/trash", () => ({
  cleanupExpiredTrashItems: mocks.cleanupExpiredTrashItems,
  getTrashDaysRemaining: mocks.getTrashDaysRemaining,
  listTrashItems: mocks.listTrashItems,
  permanentlyDeleteAllTrashItems: mocks.permanentlyDeleteAllTrashItems,
  permanentlyDeleteTrashItem: mocks.permanentlyDeleteTrashItem,
  restoreTrashItem: mocks.restoreTrashItem,
  readTrashItemContent: mocks.readTrashItemContent,
}))

vi.mock("@/components/ui/button", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    type = "button",
    children,
    ...props
  }: {
    variant?: string
    size?: string
    type?: "button" | "submit" | "reset"
    children?: React.ReactNode
    [key: string]: unknown
  }) => (
    <button type={type} {...props}>
      {children}
    </button>
  ),
}))

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe("TrashPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.project = null
    mocks.state.selectedTrashItem = null
    mocks.listTrashItems.mockResolvedValue([])
    mocks.restoreTrashItem.mockImplementation(async () => ({
      item: makeItem(),
      restoredPath: "/p/page.md",
      renamed: false,
    }))
    mocks.readTrashItemContent.mockResolvedValue("content")
    mocks.permanentlyDeleteTrashItem.mockResolvedValue(undefined)
    mocks.permanentlyDeleteAllTrashItems.mockResolvedValue(undefined)
    mocks.listDirectory.mockResolvedValue([])
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("无项目时清空列表并显示空态", async () => {
    render(<TrashPanel />)
    await flushAsync()

    expect(mocks.cleanupExpiredTrashItems).not.toHaveBeenCalled()
    expect(mocks.listTrashItems).not.toHaveBeenCalled()
    expect(screen.getByText("trash.empty")).toBeTruthy()
    expect(screen.getByText("0")).toBeTruthy()
  })

  it("有项目时加载回收站并渲染条目、数量徽标与按钮", async () => {
    mocks.state.project = DEFAULT_PROJECT
    const items = [
      makeItem({ id: "i1", name: "章一.md", kind: "chapter" }),
      makeItem({ id: "i2", name: "大纲.md", kind: "outline" }),
      makeItem({ id: "i3", name: "旧版.md", kind: "history" }),
      makeItem({ id: "i4", name: "note.md", kind: "page" }),
    ]
    mocks.listTrashItems.mockResolvedValue(items)
    render(<TrashPanel />)
    await flushAsync()

    expect(mocks.normalizePath).toHaveBeenCalledWith("/p/mybook")
    expect(mocks.cleanupExpiredTrashItems).toHaveBeenCalledWith("/p/mybook")
    expect(mocks.listTrashItems).toHaveBeenCalledWith("/p/mybook")
    expect(screen.getByText("4")).toBeTruthy()
    expect(screen.getByText("章一.md")).toBeTruthy()
    expect(screen.getByText("大纲.md")).toBeTruthy()
    expect(screen.getByText("旧版.md")).toBeTruthy()
    expect(screen.getByText("note.md")).toBeTruthy()
    // kind 标签分支
    expect(screen.getByText(/trash.kindChapter/)).toBeTruthy()
    expect(screen.getByText(/trash.kindOutline/)).toBeTruthy()
    expect(screen.getByText(/trash.kindHistory/)).toBeTruthy()
    expect(screen.getByText(/trash.kindPage/)).toBeTruthy()
    // 剩余天数（每行一个）+ 清空回收站按钮
    expect(screen.getAllByText(/trash.remainingDays/).length).toBe(4)
    expect(screen.getByText("清空回收站")).toBeTruthy()
    expect(mocks.getTrashDaysRemaining).toHaveBeenCalled()
  })

  it("加载中显示 loading 文案", async () => {
    mocks.state.project = DEFAULT_PROJECT
    let release: () => void = () => {}
    mocks.listTrashItems.mockImplementation(
      () =>
        new Promise<TrashItem[]>((resolve) => {
          release = () => resolve([])
        }),
    )
    render(<TrashPanel />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.getByText("trash.loading")).toBeTruthy()
    await act(async () => {
      release()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.getByText("trash.empty")).toBeTruthy()
  })

  it("加载失败时记录错误并清空列表", async () => {
    mocks.state.project = DEFAULT_PROJECT
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.listTrashItems.mockRejectedValue(new Error("load-fail"))
    render(<TrashPanel />)
    await flushAsync()

    expect(consoleError).toHaveBeenCalled()
    expect(screen.getByText("trash.empty")).toBeTruthy()
  })

  it("点击条目读取内容并写入 store", async () => {
    mocks.state.project = DEFAULT_PROJECT
    const item = makeItem({ id: "i1", name: "page.md" })
    mocks.listTrashItems.mockResolvedValue([item])
    mocks.readTrashItemContent.mockResolvedValue("file-body")
    render(<TrashPanel />)
    await flushAsync()

    fireEvent.click(screen.getByText("page.md"))
    await flushAsync()

    expect(mocks.readTrashItemContent).toHaveBeenCalledWith(item)
    expect(mocks.state.setSelectedTrashItem).toHaveBeenCalledWith(item)
    expect(mocks.state.setFileContent).toHaveBeenCalledWith("file-body")
  })

  it("读取条目内容失败时记录错误", async () => {
    mocks.state.project = DEFAULT_PROJECT
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.listTrashItems.mockResolvedValue([makeItem()])
    mocks.readTrashItemContent.mockRejectedValue(new Error("read-fail"))
    render(<TrashPanel />)
    await flushAsync()

    fireEvent.click(screen.getByText("page.md"))
    await flushAsync()

    expect(consoleError).toHaveBeenCalled()
    expect(mocks.state.setFileContent).not.toHaveBeenCalled()
  })

  it("恢复条目：刷新列表、目录、bump 版本并跳转 wiki 视图", async () => {
    mocks.state.project = DEFAULT_PROJECT
    const item = makeItem({ id: "i1", name: "章一.md", kind: "chapter" })
    mocks.listTrashItems.mockResolvedValueOnce([item]).mockResolvedValue([])
    mocks.restoreTrashItem.mockImplementation(async () => ({
      item,
      restoredPath: "/p/章一.md",
      renamed: false,
    }))
    render(<TrashPanel />)
    await flushAsync()

    fireEvent.click(screen.getByTitle("trash.restoreTitle"))
    await flushAsync()

    expect(mocks.normalizePath).toHaveBeenCalledWith("/p/mybook")
    expect(mocks.restoreTrashItem).toHaveBeenCalledWith("/p/mybook", "i1")
    expect(mocks.listTrashItems).toHaveBeenCalled()
    expect(mocks.listDirectory).toHaveBeenCalledWith("/p/mybook")
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
    expect(mocks.state.setActiveView).toHaveBeenCalledWith("wiki")
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("/p/章一.md")
    expect(screen.getByText("trash.empty")).toBeTruthy()
  })

  it("恢复 history 条目时不切换视图", async () => {
    mocks.state.project = DEFAULT_PROJECT
    const item = makeItem({ id: "i1", name: "旧版.md", kind: "history" })
    mocks.listTrashItems.mockResolvedValue([item])
    mocks.restoreTrashItem.mockImplementation(async () => ({
      item,
      restoredPath: "/p/旧版.md",
      renamed: true,
    }))
    render(<TrashPanel />)
    await flushAsync()

    fireEvent.click(screen.getByTitle("trash.restoreTitle"))
    await flushAsync()

    expect(mocks.state.setActiveView).not.toHaveBeenCalled()
    expect(mocks.state.setSelectedFile).not.toHaveBeenCalled()
  })

  it("恢复时列表目录刷新失败被吞掉", async () => {
    mocks.state.project = DEFAULT_PROJECT
    mocks.listTrashItems.mockResolvedValue([makeItem({ id: "i1" })])
    mocks.listDirectory.mockRejectedValue(new Error("dir-fail"))
    render(<TrashPanel />)
    await flushAsync()

    fireEvent.click(screen.getByTitle("trash.restoreTitle"))
    await flushAsync()

    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
  })

  it("恢复失败时记录错误", async () => {
    mocks.state.project = DEFAULT_PROJECT
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.listTrashItems.mockResolvedValue([makeItem({ id: "i1" })])
    mocks.restoreTrashItem.mockRejectedValue(new Error("restore-fail"))
    render(<TrashPanel />)
    await flushAsync()

    fireEvent.click(screen.getByTitle("trash.restoreTitle"))
    await flushAsync()

    expect(consoleError).toHaveBeenCalled()
  })

  it("恢复进行中显示旋转图标，按钮被禁用", async () => {
    mocks.state.project = DEFAULT_PROJECT
    let release: (result: RestoreTrashResult) => void = () => {}
    mocks.listTrashItems.mockResolvedValue([makeItem({ id: "i1" })])
    mocks.restoreTrashItem.mockImplementation(
      () =>
        new Promise<RestoreTrashResult>((resolve) => {
          release = resolve
        }),
    )
    render(<TrashPanel />)
    await flushAsync()

    fireEvent.click(screen.getByTitle("trash.restoreTitle"))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const restoreBtn = screen.getByTitle("trash.restoreTitle") as HTMLButtonElement
    expect(restoreBtn.disabled).toBe(true)
    expect(screen.getByTitle("trash.restoreTitle").querySelector(".animate-spin")).toBeTruthy()

    await act(async () => {
      release({ item: makeItem({ id: "i1" }), restoredPath: "/p/page.md", renamed: false })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  })

  it("永久删除：stopPropagation 且选中项被清空", async () => {
    mocks.state.project = DEFAULT_PROJECT
    const item = makeItem({ id: "i1", name: "page.md" })
    mocks.state.selectedTrashItem = item
    mocks.listTrashItems.mockResolvedValueOnce([item]).mockResolvedValue([])
    render(<TrashPanel />)
    await flushAsync()

    fireEvent.click(screen.getByTitle("永久删除"))
    await flushAsync()

    expect(mocks.permanentlyDeleteTrashItem).toHaveBeenCalledWith("/p/mybook", "i1")
    expect(mocks.state.setSelectedTrashItem).toHaveBeenCalledWith(null)
    expect(screen.getByText("trash.empty")).toBeTruthy()
  })

  it("永久删除非选中项时不清空选中态", async () => {
    mocks.state.project = DEFAULT_PROJECT
    const item = makeItem({ id: "i1", name: "page.md" })
    mocks.state.selectedTrashItem = makeItem({ id: "other" })
    mocks.listTrashItems.mockResolvedValue([item])
    render(<TrashPanel />)
    await flushAsync()

    fireEvent.click(screen.getByTitle("永久删除"))
    await flushAsync()

    expect(mocks.state.setSelectedTrashItem).not.toHaveBeenCalled()
  })

  it("永久删除失败时记录错误", async () => {
    mocks.state.project = DEFAULT_PROJECT
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.listTrashItems.mockResolvedValue([makeItem({ id: "i1" })])
    mocks.permanentlyDeleteTrashItem.mockRejectedValue(new Error("del-fail"))
    render(<TrashPanel />)
    await flushAsync()

    fireEvent.click(screen.getByTitle("永久删除"))
    await flushAsync()

    expect(consoleError).toHaveBeenCalled()
  })

  it("删除进行中按钮被禁用", async () => {
    mocks.state.project = DEFAULT_PROJECT
    let release: () => void = () => {}
    mocks.listTrashItems.mockResolvedValue([makeItem({ id: "i1" })])
    mocks.permanentlyDeleteTrashItem.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    render(<TrashPanel />)
    await flushAsync()

    fireEvent.click(screen.getByTitle("永久删除"))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect((screen.getByTitle("永久删除") as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      release()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  })

  it("清空回收站：成功时清空列表与选中态", async () => {
    mocks.state.project = DEFAULT_PROJECT
    mocks.listTrashItems.mockResolvedValue([makeItem({ id: "i1" })])
    render(<TrashPanel />)
    await flushAsync()

    fireEvent.click(screen.getByText("清空回收站"))
    await flushAsync()

    expect(mocks.permanentlyDeleteAllTrashItems).toHaveBeenCalledWith("/p/mybook")
    expect(mocks.state.setSelectedTrashItem).toHaveBeenCalledWith(null)
    expect(screen.getByText("trash.empty")).toBeTruthy()
  })

  it("清空回收站失败时记录错误", async () => {
    mocks.state.project = DEFAULT_PROJECT
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.listTrashItems.mockResolvedValue([makeItem({ id: "i1" })])
    mocks.permanentlyDeleteAllTrashItems.mockRejectedValue(new Error("delall-fail"))
    render(<TrashPanel />)
    await flushAsync()

    fireEvent.click(screen.getByText("清空回收站"))
    await flushAsync()

    expect(consoleError).toHaveBeenCalled()
  })

  it("清空回收站进行中按钮显示清理中文案并禁用", async () => {
    mocks.state.project = DEFAULT_PROJECT
    let release: () => void = () => {}
    mocks.listTrashItems.mockResolvedValue([makeItem({ id: "i1" })])
    mocks.permanentlyDeleteAllTrashItems.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    render(<TrashPanel />)
    await flushAsync()

    fireEvent.click(screen.getByText("清空回收站"))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(screen.getByText("清理中…")).toBeTruthy()
    expect((screen.getByText("清理中…") as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      release()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  })

  it("选中条目高亮边框", async () => {
    mocks.state.project = DEFAULT_PROJECT
    const item = makeItem({ id: "i1", name: "page.md" })
    mocks.state.selectedTrashItem = item
    mocks.listTrashItems.mockResolvedValue([item])
    render(<TrashPanel />)
    await flushAsync()

    const row = screen.getByText("page.md").closest("div.group")
    expect(row?.className).toContain("border-primary")
  })
})
