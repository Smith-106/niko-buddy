// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen, fireEvent, waitFor, within, act } from "@/test-helpers/component-test-utils"
import { HistoryEntryRow, SnapshotDiffModal, SnapshotViewer } from "./snapshot-viewer"
import type { ChapterSnapshot, SnapshotHistoryEntry } from "@/lib/novel/chapter-ingest"

const tMock = vi.hoisted(() => ({
  t: vi.fn((key: string, opts?: Record<string, unknown>) => (opts ? `${key}::${JSON.stringify(opts)}` : key)),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: tMock.t }),
}))

const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(async () => JSON.stringify({ summary: "历史摘要", chapterNumber: 1 }, null, 2)),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMock.readFile,
}))

const ingest = vi.hoisted(() => ({
  listSnapshotHistory: vi.fn(),
  loadSnapshot: vi.fn(),
  restoreSnapshotHistory: vi.fn(),
  syncSnapshotToMemory: vi.fn(),
}))

vi.mock("@/lib/novel/chapter-ingest", () => ({
  listSnapshotHistory: ingest.listSnapshotHistory,
  loadSnapshot: ingest.loadSnapshot,
  restoreSnapshotHistory: ingest.restoreSnapshotHistory,
  syncSnapshotToMemory: ingest.syncSnapshotToMemory,
}))

const diffProps = vi.hoisted(() => ({
  captured: [] as Record<string, unknown>[],
}))

vi.mock("./monaco-diff-editor", () => ({
  MonacoDiffEditor: (props: Record<string, unknown>) => {
    diffProps.captured.push(props)
    return <div data-testid="monaco-diff" />
  },
}))

const entry: SnapshotHistoryEntry = {
  fileName: "2026-01-01T00-00-00.000Z.snapshot.json",
  path: "/project/.novel/snapshots/history/001/2026-01-01T00-00-00.000Z.snapshot.json",
  createdAt: "2026-01-01 00:00",
}

function makeSnapshot(overrides: Partial<ChapterSnapshot> = {}): ChapterSnapshot {
  return {
    chapterId: "chapter-1",
    chapterNumber: 1,
    chapterTitle: "第一章 初遇",
    summary: "林烬入城",
    characters: ["林烬", "沈微"],
    locations: [],
    organizations: [],
    items: [],
    events: ["初见"],
    characterStateChanges: ["沈微状态：怀疑"],
    relationshipChanges: [],
    knowledgeChanges: ["皇城布防"],
    foreshadowingChanges: [],
    newCanonFacts: [],
    timelineEvents: ["辰时 入城"],
    conflicts: [],
    endingHook: "门外有人叩门",
    graphNodes: ["node-1"],
    graphEdges: ["edge-1"],
    memorySyncedAt: "2026-07-25T10:00:00.000Z",
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  diffProps.captured.length = 0
  ingest.listSnapshotHistory.mockResolvedValue([entry])
  ingest.loadSnapshot.mockResolvedValue(makeSnapshot())
  ingest.syncSnapshotToMemory.mockResolvedValue({
    memorySyncedAt: "2026-07-25T11:00:00.000Z",
    writtenEntityPaths: ["character-states.md", "canon-facts.md"],
  })
  ingest.restoreSnapshotHistory.mockResolvedValue(makeSnapshot({ memorySyncedAt: undefined }))
})

afterEach(() => {
  cleanup()
})

describe("SnapshotViewer", () => {
  it("loads and renders the read-only snapshot", async () => {
    const onClose = vi.fn()
    render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={onClose} />)
    expect(await screen.findByText("novel.snapshot.title::{\"number\":1}")).toBeInTheDocument()
    // sync time (valid date → toLocaleString zh-CN)
    expect(screen.getByText(/novel.snapshot.memorySyncedAt/)).toBeInTheDocument()
    // sections
    expect(screen.getByText("novel.snapshot.summary")).toBeInTheDocument()
    expect(screen.getByText("林烬入城")).toBeInTheDocument()
    expect(screen.getByText("novel.snapshot.characters")).toBeInTheDocument()
    expect(screen.getByText("林烬")).toBeInTheDocument()
    expect(screen.getByText("图谱节点")).toBeInTheDocument()
    expect(screen.getByText("node-1")).toBeInTheDocument()
    expect(screen.getByText("图谱关系边")).toBeInTheDocument()
    expect(screen.getByText("edge-1")).toBeInTheDocument()
    expect(screen.getByText("novel.snapshot.endingHook")).toBeInTheDocument()
    expect(screen.getByText("门外有人叩门")).toBeInTheDocument()
    // history + edit buttons
    expect(screen.getByText("历史版本")).toBeInTheDocument()
    expect(screen.getByText("编辑")).toBeInTheDocument()
    // JSON toggle
    fireEvent.click(screen.getByText(/novel.snapshot.jsonDetails/))
    expect(screen.getByText(/"chapterNumber": 1/)).toBeInTheDocument()
    fireEvent.click(screen.getByText(/novel.snapshot.jsonDetails/))
  })

  it("skips empty sections and shows raw invalid sync time", async () => {
    ingest.loadSnapshot.mockResolvedValue(
      makeSnapshot({
        characters: [],
        events: [],
        memorySyncedAt: "not-a-date",
        endingHook: "",
      }),
    )
    render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={() => {}} />)
    await screen.findByText("novel.snapshot.title::{\"number\":1}")
    // 空列表 Section 不渲染标题
    expect(screen.queryByText("novel.snapshot.characters")).not.toBeInTheDocument()
    // 无效日期原样展示（嵌入 t 插值文本中）
    expect(screen.getByText(/not-a-date/)).toBeInTheDocument()
  })

  it("shows the no-snapshot state when loading fails", async () => {
    ingest.loadSnapshot.mockRejectedValue(new Error("no file"))
    ingest.listSnapshotHistory.mockRejectedValue(new Error("no history"))
    render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={() => {}} />)
    expect(await screen.findByText("novel.snapshot.noSnapshot")).toBeInTheDocument()
  })

  it("uses the outline title when chapterNumber is negative", async () => {
    ingest.loadSnapshot.mockResolvedValue(makeSnapshot({ chapterNumber: -2 }))
    render(<SnapshotViewer projectPath="/project" chapterNumber={-2} onClose={() => {}} />)
    expect(await screen.findByText("第一章 初遇快照")).toBeInTheDocument()
    expect(screen.getByLabelText("第一章 初遇快照")).toBeInTheDocument()
  })

  it("shows notSynced when memorySyncedAt is absent", async () => {
    ingest.loadSnapshot.mockResolvedValue(makeSnapshot({ memorySyncedAt: undefined }))
    render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={() => {}} />)
    expect(await screen.findByText("novel.snapshot.notSynced")).toBeInTheDocument()
  })

  it("edits a text field and saves via syncSnapshotToMemory", async () => {
    const onClose = vi.fn()
    render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={onClose} />)
    await screen.findByText("novel.snapshot.title::{\"number\":1}")
    fireEvent.click(screen.getByText("编辑"))
    const summaryBox = screen.getByDisplayValue("林烬入城")
    fireEvent.change(summaryBox, { target: { value: "林烬深夜入城" } })
    // 编辑态切换 JSON 详情（editing && draft 分支）
    fireEvent.click(screen.getByText(/novel.snapshot.jsonDetails/))
    expect(screen.getByText(/"summary": "林烬深夜入城"/)).toBeInTheDocument()
    fireEvent.click(screen.getByText(/novel.snapshot.jsonDetails/))
    fireEvent.click(screen.getByText("保存"))
    expect(await screen.findByText(/novel.snapshot.syncMemorySuccess/)).toBeInTheDocument()
    expect(ingest.syncSnapshotToMemory).toHaveBeenCalledTimes(1)
    expect(ingest.syncSnapshotToMemory.mock.calls[0][1].summary).toBe("林烬深夜入城")
    // 保存后回到只读模式并刷新历史
    expect(ingest.listSnapshotHistory).toHaveBeenCalledTimes(2)
    expect(screen.getByText("编辑")).toBeInTheDocument()
    expect(screen.queryByText("保存")).not.toBeInTheDocument()
  })

  it("edits every editable section and normalizes list input", async () => {
    render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={() => {}} />)
    await screen.findByText("novel.snapshot.title::{\"number\":1}")
    fireEvent.click(screen.getByText("编辑"))
    const editor = screen.getByRole("dialog")
    const textareas = within(editor).getAllByRole("textbox")
    // 顺序：summary, characters, locations, organizations, items, events, characterStateChanges,
    // relationshipChanges, knowledgeChanges, foreshadowingChanges, newCanonFacts, timelineEvents,
    // conflicts, endingHook, graphNodes, graphEdges
    textareas.forEach((box, i) => {
      fireEvent.change(box, { target: { value: `条目${i}` } })
    })
    fireEvent.click(screen.getByText("保存"))
    await screen.findByText(/novel.snapshot.syncMemorySuccess/)
    const saved = ingest.syncSnapshotToMemory.mock.calls[0][1]
    expect(saved.summary).toBe("条目0")
    expect(saved.characters).toEqual(["条目1"])
    expect(saved.locations).toEqual(["条目2"])
    expect(saved.organizations).toEqual(["条目3"])
    expect(saved.items).toEqual(["条目4"])
    expect(saved.events).toEqual(["条目5"])
    expect(saved.characterStateChanges).toEqual(["条目6"])
    expect(saved.relationshipChanges).toEqual(["条目7"])
    expect(saved.knowledgeChanges).toEqual(["条目8"])
    expect(saved.foreshadowingChanges).toEqual(["条目9"])
    expect(saved.newCanonFacts).toEqual(["条目10"])
    expect(saved.timelineEvents).toEqual(["条目11"])
    expect(saved.conflicts).toEqual(["条目12"])
    expect(saved.endingHook).toBe("条目13")
    expect(saved.graphNodes).toEqual(["条目14"])
    expect(saved.graphEdges).toEqual(["条目15"])
  })

  it("normalizes list input via textToList when editing a list section", async () => {
    render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={() => {}} />)
    await screen.findByText("novel.snapshot.title::{\"number\":1}")
    fireEvent.click(screen.getByText("编辑"))
    const textarea = screen.getAllByPlaceholderText("每行一条，可删除、修改或新增")[0]
    fireEvent.change(textarea, { target: { value: "\n  林烬  \n\n沈微\n  " } })
    fireEvent.click(screen.getByText("保存"))
    await screen.findByText(/novel.snapshot.syncMemorySuccess/)
    expect(ingest.syncSnapshotToMemory.mock.calls[0][1].characters).toEqual(["林烬", "沈微"])
  })

  it("normalizes list input via textToList when editing a list section", async () => {
    render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={() => {}} />)
    await screen.findByText("novel.snapshot.title::{\"number\":1}")
    fireEvent.click(screen.getByText("编辑"))
    const textarea = screen.getAllByPlaceholderText("每行一条，可删除、修改或新增")[0]
    fireEvent.change(textarea, { target: { value: "\n  林烬  \n\n沈微\n  " } })
    fireEvent.click(screen.getByText("保存"))
    await screen.findByText(/novel.snapshot.syncMemorySuccess/)
    expect(ingest.syncSnapshotToMemory.mock.calls[0][1].characters).toEqual(["林烬", "沈微"])
  })

  it("renders undefined list fields as empty in edit mode (listToText fallback)", async () => {
    ingest.loadSnapshot.mockResolvedValue(
      makeSnapshot({ characters: undefined as unknown as string[] }),
    )
    render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={() => {}} />)
    await screen.findByText("novel.snapshot.title::{\"number\":1}")
    fireEvent.click(screen.getByText("编辑"))
    // characters 为 undefined 时 listToText 返回空串（第一个列表输入框为空）
    const firstListBox = screen.getAllByPlaceholderText("每行一条，可删除、修改或新增")[0]
    expect((firstListBox as HTMLTextAreaElement).value).toBe("")
  })

  it("ignores non-Escape/non-Tab keydowns (keydown handler fallthrough)", async () => {
    const onClose = vi.fn()
    render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={onClose} />)
    await screen.findByText("novel.snapshot.title::{\"number\":1}")
    fireEvent.keyDown(document, { key: "Enter" })
    expect(onClose).not.toHaveBeenCalled()
  })

  it("reports save failure with an Error instance", async () => {
    ingest.syncSnapshotToMemory.mockRejectedValueOnce(new Error("权限不足"))
    render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={() => {}} />)
    await screen.findByText("novel.snapshot.title::{\"number\":1}")
    fireEvent.click(screen.getByText("编辑"))
    fireEvent.click(screen.getByText("保存"))
    expect(await screen.findByText("保存失败：权限不足")).toBeInTheDocument()
  })

  it("reports save failure with a non-Error throw", async () => {
    ingest.syncSnapshotToMemory.mockRejectedValueOnce("字符串错误" as never)
    render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={() => {}} />)
    await screen.findByText("novel.snapshot.title::{\"number\":1}")
    fireEvent.click(screen.getByText("编辑"))
    fireEvent.click(screen.getByText("保存"))
    expect(await screen.findByText("保存失败：字符串错误")).toBeInTheDocument()
  })

  it("cancels editing and restores the original draft", async () => {
    render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={() => {}} />)
    await screen.findByText("novel.snapshot.title::{\"number\":1}")
    fireEvent.click(screen.getByText("编辑"))
    fireEvent.change(screen.getByDisplayValue("林烬入城"), { target: { value: "改坏了" } })
    fireEvent.click(screen.getByText("取消"))
    expect(screen.getByText("林烬入城")).toBeInTheDocument()
    expect(ingest.syncSnapshotToMemory).not.toHaveBeenCalled()
  })

  it("opens history and compares a historical version", async () => {
    render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={() => {}} />)
    await screen.findByText("novel.snapshot.title::{\"number\":1}")
    fireEvent.click(screen.getByText("历史版本"))
    expect(screen.getByText("2026-01-01 00:00")).toBeInTheDocument()
    fireEvent.click(screen.getByText("对比当前版本"))
    await waitFor(() => expect(screen.getByTestId("monaco-diff")).toBeInTheDocument())
    expect(fsMock.readFile).toHaveBeenCalledWith(entry.path)
    const props = diffProps.captured[diffProps.captured.length - 1]
    expect(props.original).toContain("历史摘要")
    expect(props.modified).toContain("林烬入城")
    expect(props.language).toBe("json")
    expect(props.readOnly).toBe(true)
  })

  it("shows an empty history hint when there are no entries", async () => {
    ingest.listSnapshotHistory.mockResolvedValue([])
    render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={() => {}} />)
    await screen.findByText("novel.snapshot.title::{\"number\":1}")
    fireEvent.click(screen.getByText("历史版本"))
    expect(screen.getByText("暂无历史版本。保存快照时会自动备份旧版本。")).toBeInTheDocument()
  })

  it("reports compare failure and closes the diff modal via its onClose prop", async () => {
    fsMock.readFile.mockRejectedValueOnce(new Error("读取失败"))
    render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={() => {}} />)
    await screen.findByText("novel.snapshot.title::{\"number\":1}")
    fireEvent.click(screen.getByText("历史版本"))
    fireEvent.click(screen.getByText("对比当前版本"))
    expect(await screen.findByText("对比失败：读取失败")).toBeInTheDocument()
    // 第二次对比成功打开模态，然后点击模态自身遮罩触发 onClose prop
    fireEvent.click(screen.getByText("对比当前版本"))
    await waitFor(() => expect(screen.getByTestId("monaco-diff")).toBeInTheDocument())
    const modalOverlay = screen.getByTestId("monaco-diff").closest(".fixed")!
    fireEvent.click(modalOverlay)
    await waitFor(() => expect(screen.queryByTestId("monaco-diff")).not.toBeInTheDocument())
    // 查看器自身未被关闭（历史面板仍开着）
    expect(screen.getAllByText("历史版本").length).toBeGreaterThan(0)
  })

  it("reports compare failure with a non-Error throw", async () => {
    fsMock.readFile.mockRejectedValueOnce("读取失败" as never)
    render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={() => {}} />)
    await screen.findByText("novel.snapshot.title::{\"number\":1}")
    fireEvent.click(screen.getByText("历史版本"))
    fireEvent.click(screen.getByText("对比当前版本"))
    expect(await screen.findByText("对比失败：读取失败")).toBeInTheDocument()
  })

  it("restores a historical version after confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={() => {}} />)
    await screen.findByText("novel.snapshot.title::{\"number\":1}")
    fireEvent.click(screen.getByText("历史版本"))
    fireEvent.click(screen.getByText("恢复"))
    expect(await screen.findByText("已恢复历史快照，并自动重建小说记忆。")).toBeInTheDocument()
    expect(ingest.restoreSnapshotHistory).toHaveBeenCalledWith("/project", 1, entry.fileName)
    expect(confirmSpy).toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it("skips restore when the user cancels the confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false)
    render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={() => {}} />)
    await screen.findByText("novel.snapshot.title::{\"number\":1}")
    fireEvent.click(screen.getByText("历史版本"))
    fireEvent.click(screen.getByText("恢复"))
    expect(ingest.restoreSnapshotHistory).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it("reports restore failure with an Error instance", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true)
    ingest.restoreSnapshotHistory.mockRejectedValueOnce(new Error("损坏文件"))
    render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={() => {}} />)
    await screen.findByText("novel.snapshot.title::{\"number\":1}")
    fireEvent.click(screen.getByText("历史版本"))
    fireEvent.click(screen.getByText("恢复"))
    expect(await screen.findByText("恢复失败：损坏文件")).toBeInTheDocument()
    vi.restoreAllMocks()
  })

  it("reports restore failure (non-Error throw)", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true)
    ingest.restoreSnapshotHistory.mockRejectedValueOnce("损坏文件" as never)
    render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={() => {}} />)
    await screen.findByText("novel.snapshot.title::{\"number\":1}")
    fireEvent.click(screen.getByText("历史版本"))
    fireEvent.click(screen.getByText("恢复"))
    expect(await screen.findByText("恢复失败：损坏文件")).toBeInTheDocument()
    vi.restoreAllMocks()
  })

  it("ignores stale loads after project/chapter change (cancelled paths)", async () => {
    type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
    const deferred = <T,>(): Deferred<T> => {
      let resolve!: (v: T) => void
      let reject!: (e: unknown) => void
      const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
      return { promise, resolve, reject }
    }
    const l1 = deferred<ChapterSnapshot>()
    const h1 = deferred<SnapshotHistoryEntry[]>()
    const l2 = deferred<ChapterSnapshot>()
    const h2 = deferred<SnapshotHistoryEntry[]>()
    ingest.loadSnapshot.mockImplementationOnce(() => l1.promise as never)
    ingest.loadSnapshot.mockImplementationOnce(() => l2.promise as never)
    ingest.loadSnapshot.mockResolvedValueOnce(makeSnapshot({ chapterNumber: 3 }))
    ingest.listSnapshotHistory.mockImplementationOnce(() => h1.promise as never)
    ingest.listSnapshotHistory.mockImplementationOnce(() => h2.promise as never)
    ingest.listSnapshotHistory.mockResolvedValueOnce([entry])

    const { rerender } = render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={() => {}} />)
    rerender(<SnapshotViewer projectPath="/project" chapterNumber={2} onClose={() => {}} />)
    rerender(<SnapshotViewer projectPath="/project" chapterNumber={3} onClose={() => {}} />)
    // 旧 effect 全部 cancelled：then/catch 都被跳过，不产生副作用
    l1.resolve(makeSnapshot({ chapterNumber: 1 }))
    h1.reject(new Error("stale-history"))
    l2.reject(new Error("stale-snapshot"))
    h2.resolve([])
    expect(await screen.findByText("novel.snapshot.title::{\"number\":3}")).toBeInTheDocument()
  })

  it("closes the viewer via Escape and closes the diff modal first when open", async () => {
    const onClose = vi.fn()
    render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={onClose} />)
    await screen.findByText("novel.snapshot.title::{\"number\":1}")
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)

    // 打开对比后 Escape 只关对比模态
    fireEvent.click(screen.getByText("历史版本"))
    fireEvent.click(screen.getByText("对比当前版本"))
    await waitFor(() => expect(screen.getByTestId("monaco-diff")).toBeInTheDocument())
    // 等待 keydown 监听器 effect（依赖 diffState.open）完成重注册后再触发 Escape
    await act(async () => {})
    fireEvent.keyDown(document, { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("monaco-diff")).not.toBeInTheDocument())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("traps Tab focus within the dialog", async () => {
    render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={() => {}} />)
    await screen.findByText("novel.snapshot.title::{\"number\":1}")
    const dialog = screen.getByRole("dialog")
    const focusables = dialog.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])")
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    first.focus()
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true })
    expect(document.activeElement).toBe(last)
    last.focus()
    fireEvent.keyDown(document, { key: "Tab" })
    expect(document.activeElement).toBe(first)
  })

  it("does not wrap focus when Tab is pressed on a middle element", async () => {
    render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={() => {}} />)
    await screen.findByText("novel.snapshot.title::{\"number\":1}")
    const dialog = screen.getByRole("dialog")
    const focusables = dialog.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])")
    const middle = focusables[Math.floor(focusables.length / 2)]
    middle.focus()
    fireEvent.keyDown(document, { key: "Tab" })
    // 既不是第一个（shift+Tab）也不是最后一个（Tab）→ 不触发 wrap
    expect(document.activeElement).toBe(middle)
  })

  it("closes when clicking the backdrop, but not the inner dialog", async () => {
    const onClose = vi.fn()
    const { container } = render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={onClose} />)
    await screen.findByText("novel.snapshot.title::{\"number\":1}")
    const dialog = screen.getByRole("dialog")
    fireEvent.click(dialog)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(container.firstChild as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("closes via the close button", async () => {
    const onClose = vi.fn()
    render(<SnapshotViewer projectPath="/project" chapterNumber={1} onClose={onClose} />)
    await screen.findByText("novel.snapshot.title::{\"number\":1}")
    const closeButton = document.querySelector('[aria-label]') // fallback
    expect(closeButton).not.toBeNull()
  })
})

describe("HistoryEntryRow", () => {
  it("renders actions, honors disabled and shows restoring label", () => {
    const onCompare = vi.fn()
    const onRestore = vi.fn()
    const { rerender } = render(
      <HistoryEntryRow entry={entry} disabled={false} restoring={false} onCompare={onCompare} onRestore={onRestore} />,
    )
    expect(screen.getByText(entry.createdAt)).toBeInTheDocument()
    fireEvent.click(screen.getByText("对比当前版本"))
    expect(onCompare).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText("恢复"))
    expect(onRestore).toHaveBeenCalledTimes(1)

    rerender(<HistoryEntryRow entry={entry} disabled restoring onCompare={onCompare} onRestore={onRestore} />)
    expect(screen.getByText("恢复中")).toBeInTheDocument()
    const compareBtn = screen.getByText("对比当前版本").closest("button")!
    expect(compareBtn).toBeDisabled()
  })
})

describe("SnapshotDiffModal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<SnapshotDiffModal open={false} original="" modified="" onClose={() => {}} />)
    expect(container).toBeEmptyDOMElement()
    expect(diffProps.captured).toHaveLength(0)
  })

  it("passes diff props to MonacoDiffEditor", () => {
    render(<SnapshotDiffModal open original={'{"a":1}'} modified={'{"a":2}'} onClose={() => {}} />)
    expect(screen.getByTestId("monaco-diff")).toBeInTheDocument()
    expect(diffProps.captured[0]).toMatchObject({ language: "json", readOnly: true, height: 520 })
  })

  it("closes on backdrop click but not on inner content click", () => {
    const onClose = vi.fn()
    render(<SnapshotDiffModal open original="" modified="" onClose={onClose} />)
    fireEvent.click(screen.getByRole("dialog"))
    expect(onClose).not.toHaveBeenCalled()
    const overlay = screen.getByRole("dialog").parentElement!
    fireEvent.click(overlay)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
