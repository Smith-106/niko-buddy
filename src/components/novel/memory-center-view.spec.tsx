// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen, fireEvent, waitFor, within, setupDomGlobals } from "@/test-helpers/component-test-utils"
import { MemoryCenterView } from "./memory-center-view"
import type { MemoryCenterData, MemoryCenterSnapshotCard } from "@/lib/novel/memory-center"
import type { FrontmatterParseResult } from "@/lib/frontmatter"

const tMock = vi.hoisted(() => ({
  t: vi.fn((key: string, opts?: Record<string, unknown>) => (opts ? `${key}::${JSON.stringify(opts)}` : key)),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: tMock.t }),
}))

const wiki = vi.hoisted(() => {
  const state: Record<string, unknown> = {
    project: { id: "p1", name: "Novel", path: "E:/Novel" },
    selectedMemoryCenterEntry: null,
    setSelectedMemoryCenterEntry: vi.fn((value: string | null) => {
      state.selectedMemoryCenterEntry = value
    }),
    bumpDataVersion: vi.fn(),
  }
  return { state }
})

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: Record<string, unknown>) => unknown) => selector(wiki.state),
}))

const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(async () => "---\ntitle: 记忆\n---\n正文内容\n"),
  writeFile: vi.fn(async () => {}),
  deleteFile: vi.fn(async () => {}),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMock.readFile,
  writeFile: fsMock.writeFile,
  deleteFile: fsMock.deleteFile,
}))

const frontmatter = vi.hoisted(() => ({
  parseFrontmatter: vi.fn<() => FrontmatterParseResult>(() => ({ frontmatter: { title: "记忆" }, body: "正文内容\n", rawBlock: "---\ntitle: 记忆\n---\n" })),
}))

vi.mock("@/lib/frontmatter", () => ({
  parseFrontmatter: frontmatter.parseFrontmatter,
}))

vi.mock("@/components/editor/wiki-reader", () => ({
  WikiReader: ({ body }: { body: string }) => <div data-testid="wiki-reader">{body}</div>,
}))

const ingestMock = vi.hoisted(() => ({
  deleteChapterSnapshots: vi.fn(async () => {}),
}))

vi.mock("@/lib/novel/chapter-ingest", () => ({
  deleteChapterSnapshots: ingestMock.deleteChapterSnapshots,
}))

const snapshotViewerMock = vi.hoisted(() => ({
  onCloseRef: { current: (() => {}) as () => void },
  projectPathRef: { current: "" },
  chapterNumberRef: { current: -1 },
}))

vi.mock("@/components/novel/snapshot-viewer", () => ({
  SnapshotViewer: (props: { projectPath: string; chapterNumber: number; onClose: () => void }) => {
    snapshotViewerMock.projectPathRef.current = props.projectPath
    snapshotViewerMock.chapterNumberRef.current = props.chapterNumber
    snapshotViewerMock.onCloseRef.current = props.onClose
    return <div data-testid="snapshot-viewer">SnapshotViewer</div>
  },
}))

const memoryCenter = vi.hoisted(() => {
  const snapshotCard: MemoryCenterSnapshotCard = {    chapterNumber: 3,
    chapterTitle: "第三章 夜宴",
    summary: "夜宴上的交锋",
    endingHook: "门外响起叩门声",
    memorySynced: true,
    memorySyncedAt: "2026-07-25T10:00:00.000Z",
    snapshotPath: "E:/Novel/.novel/snapshots/3.snapshot.md",
    characterStateChanges: ["沈微：怀疑", "林烬：警惕"],
    knowledgeChanges: ["皇城布防"],
    foreshadowingChanges: [],
    timelineEvents: ["辰时 入城"],
    hasMoreCharacterStateChanges: true,
    hasMoreKnowledgeChanges: false,
    hasMoreForeshadowingChanges: false,
    hasMoreTimelineEvents: true,
  }
  const data: MemoryCenterData = {
    stats: { snapshotCount: 1, syncedSnapshotCount: 1, characterCount: 1, activeForeshadowingCount: 0, memoryFileCount: 1 },
    snapshots: [snapshotCard],
    files: [
      { key: "character-states", title: "character-states", path: "E:/Novel/wiki/memory/character-states.md", sections: [] },
    ],
    dismantlingProjects: [],
  }
  return {
    snapshotCard,
    loadMemoryCenterData: vi.fn(async () => data),
  }
})

vi.mock("@/lib/novel/memory-center", () => ({
  loadMemoryCenterData: memoryCenter.loadMemoryCenterData,
}))

function makeCard(overrides: Partial<MemoryCenterSnapshotCard>): MemoryCenterSnapshotCard {
  return {
    ...memoryCenter.snapshotCard,
    ...overrides,
  }
}

function makeData(overrides: Partial<MemoryCenterData>): MemoryCenterData {
  return {
    stats: { snapshotCount: 1, syncedSnapshotCount: 1, characterCount: 1, activeForeshadowingCount: 0, memoryFileCount: 1 },
    snapshots: [memoryCenter.snapshotCard],
    files: [
      { key: "character-states", title: "character-states", path: "E:/Novel/wiki/memory/character-states.md", sections: [] },
    ],
    dismantlingProjects: [],
    ...overrides,
  }
}

beforeEach(() => {
  setupDomGlobals({ scrollTo: true })
  // scrollIntoView 并非 jsdom 原生实现；全局提供幂等 stub（与 setupDomGlobals 同风格）
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = vi.fn() as never
  }
  vi.clearAllMocks()
  wiki.state.project = { id: "p1", name: "Novel", path: "E:/Novel" }
  wiki.state.selectedMemoryCenterEntry = null
  fsMock.readFile.mockResolvedValue("---\ntitle: 记忆\n---\n正文内容\n")
  fsMock.writeFile.mockResolvedValue(undefined)
  fsMock.deleteFile.mockResolvedValue(undefined)
  ingestMock.deleteChapterSnapshots.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
})

describe("MemoryCenterView", () => {
  it("shows the select prompt when nothing is selected", async () => {
    render(<MemoryCenterView />)
    expect(await screen.findByText("novel.memoryCenter.selectPrompt")).toBeInTheDocument()
    expect(screen.getByText("novel.memoryCenter.selectHint")).toBeInTheDocument()
  })

  it("clears detail when no project is open", async () => {
    wiki.state.project = null
    render(<MemoryCenterView />)
    expect(await screen.findByText("novel.memoryCenter.selectPrompt")).toBeInTheDocument()
  })

  it("clears selection when entry is dismantling-library", async () => {
    wiki.state.selectedMemoryCenterEntry = "dismantling-library"
    render(<MemoryCenterView />)
    await waitFor(() => {
      expect(wiki.state.setSelectedMemoryCenterEntry).toHaveBeenCalledWith(null)
    })
    // 不加载记忆中心数据
    expect(memoryCenter.loadMemoryCenterData).not.toHaveBeenCalled()
  })

  it("renders the snapshot list and its cards", async () => {
    wiki.state.selectedMemoryCenterEntry = "snapshots"
    render(<MemoryCenterView />)
    expect(await screen.findByText("第三章 夜宴")).toBeInTheDocument()
    expect(screen.getByText("novel.memoryCenter.snapshots.synced")).toBeInTheDocument()
    expect(screen.getByText("夜宴上的交锋")).toBeInTheDocument()
    expect(screen.getByText(/novel.snapshot.endingHook/)).toBeInTheDocument()
    expect(screen.getByText("门外响起叩门声")).toBeInTheDocument()
    // 列表项
    expect(screen.getByText("沈微：怀疑")).toBeInTheDocument()
    expect(screen.getByText("皇城布防")).toBeInTheDocument()
    expect(screen.getByText("辰时 入城")).toBeInTheDocument()
    // hasMore 省略号
    expect(screen.getAllByText("…").length).toBeGreaterThan(0)
    // 编辑/删除按钮
    expect(screen.getByText("novel.memoryCenter.edit")).toBeInTheDocument()
    expect(screen.getByText("novel.memoryCenter.delete")).toBeInTheDocument()
  })

  it("falls back to the default chapter title and unsynced label", async () => {
    const card: MemoryCenterSnapshotCard = {
      chapterNumber: 2,
      summary: "摘要",
      endingHook: "",
      memorySynced: false,
      snapshotPath: "E:/Novel/.novel/snapshots/2.snapshot.md",
      characterStateChanges: [],
      knowledgeChanges: [],
      foreshadowingChanges: [],
      timelineEvents: [],
      hasMoreCharacterStateChanges: false,
      hasMoreKnowledgeChanges: false,
      hasMoreForeshadowingChanges: false,
      hasMoreTimelineEvents: false,
    }
    memoryCenter.loadMemoryCenterData.mockResolvedValueOnce({
      stats: { snapshotCount: 1, syncedSnapshotCount: 0, characterCount: 0, activeForeshadowingCount: 0, memoryFileCount: 0 },
      snapshots: [card],
      files: [],
      dismantlingProjects: [],
    })
    wiki.state.selectedMemoryCenterEntry = "snapshots"
    render(<MemoryCenterView />)
    expect(await screen.findByText(/novel.memoryCenter.snapshots.chapter/)).toBeInTheDocument()
    expect(screen.getByText("novel.memoryCenter.snapshots.unsynced")).toBeInTheDocument()
    // 空列表不渲染标题
    expect(screen.queryByText("novel.snapshot.characterStateChanges")).not.toBeInTheDocument()
    // 无 endingHook 不渲染
    expect(screen.queryByText(/novel.snapshot.endingHook/)).not.toBeInTheDocument()
  })

  it("opens a snapshot detail, edits and deletes it as a chapter snapshot", async () => {
    wiki.state.selectedMemoryCenterEntry = "snapshots"
    render(<MemoryCenterView />)
    await screen.findByText("第三章 夜宴")
    fireEvent.click(screen.getByText("novel.memoryCenter.snapshots.openSnapshot"))
    // 快照文件 markdown 详情（editable=false，可删除）
    expect(await screen.findByTestId("wiki-reader")).toBeInTheDocument()
    // 非可编辑 → 无编辑按钮
    expect(screen.queryByText("novel.memoryCenter.edit")).not.toBeInTheDocument()
    const deleteButtons = screen.getAllByText("novel.memoryCenter.delete")
    fireEvent.click(deleteButtons[deleteButtons.length - 1])
    // 确认删除弹窗
    expect(await screen.findByText("novel.memoryCenter.deleteConfirmTitle")).toBeInTheDocument()
    fireEvent.click(screen.getByText("novel.memoryCenter.deleteConfirmAction"))
    await waitFor(() => {
      expect(ingestMock.deleteChapterSnapshots).toHaveBeenCalledWith("E:/Novel", 3)
    })
    expect(screen.getByText("novel.memoryCenter.deleteSuccess")).toBeInTheDocument()
    expect(wiki.state.bumpDataVersion).toHaveBeenCalled()
  })

  it("opens a markdown file detail and saves edits back to disk", async () => {
    wiki.state.selectedMemoryCenterEntry = "character-states"
    render(<MemoryCenterView />)
    expect(await screen.findByTestId("wiki-reader")).toBeInTheDocument()
    expect(fsMock.readFile).toHaveBeenCalledWith("E:/Novel/wiki/memory/character-states.md")
    // 可编辑 → 编辑按钮
    fireEvent.click(screen.getByText("novel.memoryCenter.edit"))
    const textarea = screen.getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "新正文" } })
    fireEvent.click(screen.getByText("novel.memoryCenter.save"))
    await waitFor(() => {
      expect(fsMock.writeFile).toHaveBeenCalledWith("E:/Novel/wiki/memory/character-states.md", "---\ntitle: 记忆\n---\n新正文")
    })
    expect(screen.getByText("novel.memoryCenter.saveSuccess")).toBeInTheDocument()
    expect(wiki.state.bumpDataVersion).toHaveBeenCalled()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  })

  it("cancels editing and restores the original content", async () => {
    wiki.state.selectedMemoryCenterEntry = "character-states"
    render(<MemoryCenterView />)
    await screen.findByTestId("wiki-reader")
    fireEvent.click(screen.getByText("novel.memoryCenter.edit"))
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "不要保存" } })
    fireEvent.click(screen.getByText("novel.memoryCenter.cancel"))
    expect(fsMock.writeFile).not.toHaveBeenCalled()
    expect(screen.getByTestId("wiki-reader")).toBeInTheDocument()
  })

  it("reports save failures", async () => {
    fsMock.writeFile.mockRejectedValueOnce(new Error("只读文件"))
    wiki.state.selectedMemoryCenterEntry = "character-states"
    render(<MemoryCenterView />)
    await screen.findByTestId("wiki-reader")
    fireEvent.click(screen.getByText("novel.memoryCenter.edit"))
    fireEvent.click(screen.getByText("novel.memoryCenter.save"))
    expect(await screen.findByText("只读文件")).toBeInTheDocument()
  })

  it("deletes a memory file directly", async () => {
    wiki.state.selectedMemoryCenterEntry = "character-states"
    render(<MemoryCenterView />)
    await screen.findByTestId("wiki-reader")
    fireEvent.click(screen.getByText("novel.memoryCenter.delete"))
    expect(await screen.findByText("novel.memoryCenter.deleteConfirmTitle")).toBeInTheDocument()
    fireEvent.click(screen.getByText("novel.memoryCenter.deleteConfirmAction"))
    await waitFor(() => {
      expect(fsMock.deleteFile).toHaveBeenCalledWith("E:/Novel/wiki/memory/character-states.md")
    })
    expect(screen.getByText("novel.memoryCenter.deleteSuccess")).toBeInTheDocument()
    expect(wiki.state.setSelectedMemoryCenterEntry).toHaveBeenCalledWith(null)
  })

  it("cancels the delete dialog", async () => {
    wiki.state.selectedMemoryCenterEntry = "character-states"
    render(<MemoryCenterView />)
    await screen.findByTestId("wiki-reader")
    fireEvent.click(screen.getByText("novel.memoryCenter.delete"))
    fireEvent.click(screen.getByText("novel.memoryCenter.cancel"))
    expect(fsMock.deleteFile).not.toHaveBeenCalled()
    expect(screen.queryByText("novel.memoryCenter.deleteConfirmTitle")).not.toBeInTheDocument()
  })

  it("closes the delete dialog via Escape", async () => {
    wiki.state.selectedMemoryCenterEntry = "character-states"
    render(<MemoryCenterView />)
    await screen.findByTestId("wiki-reader")
    fireEvent.click(screen.getByText("novel.memoryCenter.delete"))
    await screen.findByText("novel.memoryCenter.deleteConfirmTitle")
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByText("novel.memoryCenter.deleteConfirmTitle")).not.toBeInTheDocument()
  })

  it("reports load failure", async () => {
    memoryCenter.loadMemoryCenterData.mockRejectedValueOnce(new Error("读取记忆中心失败"))
    wiki.state.selectedMemoryCenterEntry = "snapshots"
    render(<MemoryCenterView />)
    expect(await screen.findByText("读取记忆中心失败")).toBeInTheDocument()
  })

  it("reports read failure when opening a markdown detail", async () => {
    fsMock.readFile.mockRejectedValueOnce(new Error("文件不存在"))
    wiki.state.selectedMemoryCenterEntry = "character-states"
    render(<MemoryCenterView />)
    expect(await screen.findByText("文件不存在")).toBeInTheDocument()
  })

  it("handles unknown memory entries by clearing the detail", async () => {
    wiki.state.selectedMemoryCenterEntry = "unknown-key"
    render(<MemoryCenterView />)
    await waitFor(() => {
      expect(memoryCenter.loadMemoryCenterData).toHaveBeenCalledWith("E:/Novel")
    })
    // 找不到 file → detailView null → 回到 loading 占位（entry 仍选中）
    expect(screen.getByText("novel.memoryCenter.loading")).toBeInTheDocument()
  })

  it("opens the SnapshotViewer from a card edit button", async () => {
    wiki.state.selectedMemoryCenterEntry = "snapshots"
    render(<MemoryCenterView />)
    await screen.findByText("第三章 夜宴")
    fireEvent.click(screen.getByText("novel.memoryCenter.edit"))
    expect(await screen.findByTestId("snapshot-viewer")).toBeInTheDocument()
    expect(snapshotViewerMock.projectPathRef.current).toBe("E:/Novel")
    expect(snapshotViewerMock.chapterNumberRef.current).toBe(3)
    // 关闭快照查看器 → 刷新
    snapshotViewerMock.onCloseRef.current()
    await waitFor(() => {
      expect(memoryCenter.loadMemoryCenterData).toHaveBeenCalledTimes(2)
    })
  })

  it("closes the detail and restores scroll position", async () => {
    wiki.state.selectedMemoryCenterEntry = "character-states"
    const { rerender } = render(<MemoryCenterView />)
    await screen.findByTestId("wiki-reader")
    fireEvent.click(document.getElementById("memory-center-close-detail") as HTMLElement)
    await waitFor(() => {
      expect(wiki.state.setSelectedMemoryCenterEntry).toHaveBeenCalledWith(null)
    })
    expect(screen.getByText("novel.memoryCenter.selectPrompt")).toBeInTheDocument()
    // 滚动恢复路径：再次打开 detail 触发 rAF
    wiki.state.selectedMemoryCenterEntry = "character-states"
    rerender(<MemoryCenterView />)
    expect(await screen.findByTestId("wiki-reader")).toBeInTheDocument()
  })

  it("returns to the snapshot list when closing a nested snapshot detail", async () => {
    wiki.state.selectedMemoryCenterEntry = "snapshots"
    render(<MemoryCenterView />)
    await screen.findByText("第三章 夜宴")
    fireEvent.click(screen.getByText("novel.memoryCenter.snapshots.openSnapshot"))
    await screen.findByTestId("wiki-reader")
    fireEvent.click(document.getElementById("memory-center-close-detail") as HTMLElement)
    // 回到快照列表（detailView.parentView）
    expect(await screen.findByText("第三章 夜宴")).toBeInTheDocument()
    expect(wiki.state.setSelectedMemoryCenterEntry).not.toHaveBeenCalled()
  })

  it("renders the loading spinner while refreshing", async () => {
    let resolveLoad: (v: MemoryCenterData) => void = () => {}
    memoryCenter.loadMemoryCenterData.mockImplementationOnce(
      () => new Promise<MemoryCenterData>((res) => { resolveLoad = res }),
    )
    wiki.state.selectedMemoryCenterEntry = "snapshots"
    render(<MemoryCenterView />)
    expect(await screen.findByText("novel.memoryCenter.loading")).toBeInTheDocument()
    resolveLoad({
      stats: { snapshotCount: 0, syncedSnapshotCount: 0, characterCount: 0, activeForeshadowingCount: 0, memoryFileCount: 0 },
      snapshots: [],
      files: [],
      dismantlingProjects: [],
    })
    await waitFor(() => {
      expect(screen.queryByText("novel.memoryCenter.loading")).not.toBeInTheDocument()
    })
  })

  it("supports the refresh button when no detail is open", async () => {
    wiki.state.selectedMemoryCenterEntry = null
    render(<MemoryCenterView />)
    await screen.findByText("novel.memoryCenter.selectPrompt")
    fireEvent.click(screen.getByText("novel.memoryCenter.refresh"))
    await waitFor(() => {
      expect(memoryCenter.loadMemoryCenterData).toHaveBeenCalledTimes(0)
    })
  })

  it("opens an outline snapshot and deletes it via chapter cleanup", async () => {
    memoryCenter.loadMemoryCenterData.mockResolvedValueOnce(
      makeData({ snapshots: [makeCard({ snapshotPath: "E:/Novel/.novel/snapshots/outline-3.snapshot.md" })] }),
    )
    wiki.state.selectedMemoryCenterEntry = "snapshots"
    render(<MemoryCenterView />)
    await screen.findByText("第三章 夜宴")
    fireEvent.click(screen.getByText("novel.memoryCenter.snapshots.openSnapshot"))
    await screen.findByTestId("wiki-reader")
    fireEvent.click(screen.getByText("novel.memoryCenter.delete"))
    await screen.findByText("novel.memoryCenter.deleteConfirmTitle")
    fireEvent.click(screen.getByText("novel.memoryCenter.deleteConfirmAction"))
    await waitFor(() => {
      expect(ingestMock.deleteChapterSnapshots).toHaveBeenCalledWith("E:/Novel", -3)
    })
  })

  it("opens a snapshot stored at a plain path as an editable markdown file", async () => {
    memoryCenter.loadMemoryCenterData.mockResolvedValueOnce(
      makeData({ snapshots: [makeCard({ snapshotPath: "E:/Novel/notes/random.md" })] }),
    )
    wiki.state.selectedMemoryCenterEntry = "snapshots"
    render(<MemoryCenterView />)
    await screen.findByText("第三章 夜宴")
    fireEvent.click(screen.getByText("novel.memoryCenter.snapshots.openSnapshot"))
    await screen.findByTestId("wiki-reader")
    // 普通路径 → 可编辑
    expect(screen.getByText("novel.memoryCenter.edit")).toBeInTheDocument()
    // 删除走文件分支
    fireEvent.click(screen.getByText("novel.memoryCenter.delete"))
    await screen.findByText("novel.memoryCenter.deleteConfirmTitle")
    fireEvent.click(screen.getByText("novel.memoryCenter.deleteConfirmAction"))
    await waitFor(() => {
      expect(fsMock.deleteFile).toHaveBeenCalledWith("E:/Novel/notes/random.md")
    })
  })

  it("deletes a snapshot from the card delete button", async () => {
    wiki.state.selectedMemoryCenterEntry = "snapshots"
    render(<MemoryCenterView />)
    await screen.findByText("第三章 夜宴")
    // 列表视图里卡片自身的删除按钮（此时仅一个）
    fireEvent.click(screen.getByText("novel.memoryCenter.delete"))
    await screen.findByText("novel.memoryCenter.deleteConfirmTitle")
    fireEvent.click(screen.getByText("novel.memoryCenter.deleteConfirmAction"))
    await waitFor(() => {
      expect(ingestMock.deleteChapterSnapshots).toHaveBeenCalledWith("E:/Novel", 3)
    })
    // 快照删除后自动刷新
    await waitFor(() => {
      expect(memoryCenter.loadMemoryCenterData).toHaveBeenCalledTimes(2)
    })
  })

  it("restores scroll position and refocuses the snapshot button after closing", async () => {
    const target = document.createElement("button")
    target.id = "memory-center-detail-snapshot-3"
    document.body.appendChild(target)
    const focusSpy = vi.spyOn(target, "focus")

    wiki.state.selectedMemoryCenterEntry = "snapshots"
    const { rerender } = render(<MemoryCenterView />)
    await screen.findByText("第三章 夜宴")
    fireEvent.click(screen.getByText("novel.memoryCenter.snapshots.openSnapshot"))
    await screen.findByTestId("wiki-reader")
    // 切到文件详情（parentView=null），关闭时触发滚动/焦点恢复
    wiki.state.selectedMemoryCenterEntry = "character-states"
    rerender(<MemoryCenterView />)
    await screen.findByTestId("wiki-reader")
    fireEvent.click(document.getElementById("memory-center-close-detail") as HTMLElement)
    await waitFor(() => {
      expect(focusSpy).toHaveBeenCalled()
    })
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    target.remove()
  })

  it("restores scroll position when the remembered target no longer exists", async () => {
    wiki.state.selectedMemoryCenterEntry = "snapshots"
    const { rerender, unmount } = render(<MemoryCenterView />)
    await screen.findByText("第三章 夜宴")
    fireEvent.click(screen.getByText("novel.memoryCenter.snapshots.openSnapshot"))
    await screen.findByTestId("wiki-reader")
    wiki.state.selectedMemoryCenterEntry = "character-states"
    rerender(<MemoryCenterView />)
    await screen.findByTestId("wiki-reader")
    fireEvent.click(document.getElementById("memory-center-close-detail") as HTMLElement)
    // 在 rAF 触发前立即卸载：容器为 null（跳过滚动），目标也不存在（不聚焦）
    unmount()
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()
  })

  it("reports read failure when opening a snapshot detail", async () => {
    fsMock.readFile.mockRejectedValueOnce("快照文件已丢失")
    wiki.state.selectedMemoryCenterEntry = "snapshots"
    render(<MemoryCenterView />)
    await screen.findByText("第三章 夜宴")
    fireEvent.click(screen.getByText("novel.memoryCenter.snapshots.openSnapshot"))
    expect(await screen.findByText("快照文件已丢失")).toBeInTheDocument()
  })

  it("keeps the delete dialog open and ignores confirm after the project is closed", async () => {
    wiki.state.selectedMemoryCenterEntry = "character-states"
    const { rerender } = render(<MemoryCenterView />)
    await screen.findByTestId("wiki-reader")
    fireEvent.click(screen.getByText("novel.memoryCenter.delete"))
    await screen.findByText("novel.memoryCenter.deleteConfirmTitle")
    wiki.state.project = null
    rerender(<MemoryCenterView />)
    fireEvent.click(screen.getByText("novel.memoryCenter.deleteConfirmAction"))
    await waitFor(() => {
      expect(fsMock.deleteFile).not.toHaveBeenCalled()
    })
    expect(screen.getByText("novel.memoryCenter.deleteConfirmTitle")).toBeInTheDocument()
  })

  it("reports delete failure with an Error instance", async () => {
    ingestMock.deleteChapterSnapshots.mockRejectedValueOnce(new Error("快照删除失败"))
    wiki.state.selectedMemoryCenterEntry = "snapshots"
    render(<MemoryCenterView />)
    await screen.findByText("第三章 夜宴")
    fireEvent.click(screen.getByText("novel.memoryCenter.delete"))
    await screen.findByText("novel.memoryCenter.deleteConfirmTitle")
    fireEvent.click(screen.getByText("novel.memoryCenter.deleteConfirmAction"))
    expect(await screen.findByText("快照删除失败")).toBeInTheDocument()
  })

  it("reports delete failure", async () => {
    ingestMock.deleteChapterSnapshots.mockRejectedValueOnce("删除快照失败")
    wiki.state.selectedMemoryCenterEntry = "snapshots"
    render(<MemoryCenterView />)
    await screen.findByText("第三章 夜宴")
    fireEvent.click(screen.getByText("novel.memoryCenter.delete"))
    await screen.findByText("novel.memoryCenter.deleteConfirmTitle")
    fireEvent.click(screen.getByText("novel.memoryCenter.deleteConfirmAction"))
    expect(await screen.findByText("删除快照失败")).toBeInTheDocument()
  })

  it("traps Tab focus inside the delete dialog", async () => {
    wiki.state.selectedMemoryCenterEntry = "character-states"
    render(<MemoryCenterView />)
    await screen.findByTestId("wiki-reader")
    fireEvent.click(screen.getByText("novel.memoryCenter.delete"))
    const dialog = await screen.findByRole("dialog")
    const buttons = within(dialog).getAllByRole("button")
    const cancel = buttons[0]
    const confirm = buttons[1]
    // 从第一个元素 shift+Tab → 跳到最后一个
    cancel.focus()
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true })
    expect(document.activeElement).toBe(confirm)
    // 从最后一个元素 Tab → 回到第一个
    fireEvent.keyDown(document, { key: "Tab" })
    expect(document.activeElement).toBe(cancel)
    // 中间元素 Tab → 不拦截
    dialog.focus()
    fireEvent.keyDown(document, { key: "Tab" })
    expect(document.activeElement).toBe(dialog)
  })

  it("ignores Tab and Escape while a delete is in progress", async () => {
    let resolveDelete: () => void = () => {}
    fsMock.deleteFile.mockImplementationOnce(
      () => new Promise<void>((res) => { resolveDelete = res }),
    )
    wiki.state.selectedMemoryCenterEntry = "character-states"
    render(<MemoryCenterView />)
    await screen.findByTestId("wiki-reader")
    fireEvent.click(screen.getByText("novel.memoryCenter.delete"))
    await screen.findByText("novel.memoryCenter.deleteConfirmTitle")
    fireEvent.click(screen.getByText("novel.memoryCenter.deleteConfirmAction"))
    // 删除进行中：按钮全部 disabled → 无 focusable → Tab 直接返回
    fireEvent.keyDown(document, { key: "Tab" })
    // 删除进行中：Escape 不取消
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.getByText("novel.memoryCenter.deleteConfirmTitle")).toBeInTheDocument()
    resolveDelete()
    await waitFor(() => {
      expect(screen.queryByText("novel.memoryCenter.deleteConfirmTitle")).not.toBeInTheDocument()
    })
    expect(screen.getByText("novel.memoryCenter.deleteSuccess")).toBeInTheDocument()
  })

  it("reports load failure with a non-Error value", async () => {
    memoryCenter.loadMemoryCenterData.mockRejectedValueOnce("字符串加载错误")
    wiki.state.selectedMemoryCenterEntry = "snapshots"
    render(<MemoryCenterView />)
    expect(await screen.findByText("字符串加载错误")).toBeInTheDocument()
  })

  it("reports read failure with an Error instance when opening a snapshot detail", async () => {
    fsMock.readFile.mockRejectedValueOnce(new Error("文件不存在哦"))
    wiki.state.selectedMemoryCenterEntry = "snapshots"
    render(<MemoryCenterView />)
    await screen.findByText("第三章 夜宴")
    fireEvent.click(screen.getByText("novel.memoryCenter.snapshots.openSnapshot"))
    expect(await screen.findByText("文件不存在哦")).toBeInTheDocument()
  })

  it("reports save failure with a non-Error value", async () => {
    fsMock.writeFile.mockRejectedValueOnce("字符串保存错误")
    wiki.state.selectedMemoryCenterEntry = "character-states"
    render(<MemoryCenterView />)
    await screen.findByTestId("wiki-reader")
    fireEvent.click(screen.getByText("novel.memoryCenter.edit"))
    fireEvent.click(screen.getByText("novel.memoryCenter.save"))
    expect(await screen.findByText("字符串保存错误")).toBeInTheDocument()
  })

  it("renders fallback texts for missing card fields", async () => {
    memoryCenter.loadMemoryCenterData.mockResolvedValueOnce(
      makeData({ snapshots: [makeCard({ chapterTitle: "", summary: "", endingHook: "" })], files: [] }),
    )
    wiki.state.selectedMemoryCenterEntry = "snapshots"
    render(<MemoryCenterView />)
    expect(await screen.findByText(/novel.memoryCenter.snapshots.chapter/)).toBeInTheDocument()
    expect(screen.getByText("novel.memoryCenter.snapshots.summaryFallback")).toBeInTheDocument()
    expect(screen.queryByText(/novel.snapshot.endingHook/)).not.toBeInTheDocument()
  })

  it("opens files with unknown keys using the generic title", async () => {
    memoryCenter.loadMemoryCenterData.mockResolvedValueOnce(
      makeData({ snapshots: [], files: [{ key: "custom-file", title: "custom", path: "E:/Novel/wiki/memory/custom.md", sections: [] }] }),
    )
    wiki.state.selectedMemoryCenterEntry = "custom-file"
    render(<MemoryCenterView />)
    expect(await screen.findByTestId("wiki-reader")).toBeInTheDocument()
    expect(screen.getByText("novel.memoryCenter.openFile")).toBeInTheDocument()
  })

  it("renders markdown without a frontmatter block", async () => {
    frontmatter.parseFrontmatter.mockReturnValueOnce({ frontmatter: null, body: "", rawBlock: "" })
    fsMock.readFile.mockResolvedValueOnce("无前言的正文")
    wiki.state.selectedMemoryCenterEntry = "character-states"
    render(<MemoryCenterView />)
    expect(await screen.findByTestId("wiki-reader")).toHaveTextContent("无前言的正文")
  })
})
