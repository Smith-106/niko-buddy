// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  act,
  fireEvent,
  render,
  screen,
  setupDomGlobals,
  waitFor,
  within,
} from "@/test-helpers/component-test-utils"
import { StoryDraftView } from "./story-draft-view"
import { useStorySimulationStore } from "@/stores/story-simulation-store"
import { useWikiStore } from "@/stores/wiki-store"
import { exportDraft, getNextChapterNumber, importDraftToChapters } from "@/lib/novel"
import { refreshProjectState } from "@/lib/project-refresh"
import type { StoryDraft, StoryFramework } from "@/lib/novel"
import zh from "@/i18n/zh.json"

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    exportDraft: vi.fn(),
    importDraftToChapters: vi.fn(),
    getNextChapterNumber: vi.fn(),
  }
})

vi.mock("@/lib/project-refresh", () => ({
  refreshProjectState: vi.fn(),
}))

const T = zh.storySimulation as unknown as Record<string, string>
const TC = zh.common as unknown as Record<string, string>
const PROJECT = { id: "p1", name: "proj", path: "C:/proj" }

function makeFramework(): StoryFramework {
  return {
    id: "fw-1",
    title: "测试框架",
    shortTitle: "短",
    premise: "前情",
    targetWords: 10000,
    simulationMode: "event-driven",
    sourceChapters: 0,
    nodes: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  }
}

function makeDraft(): StoryDraft {
  return {
    branchId: "b1",
    frameworkId: "fw-1",
    totalWords: 120,
    createdAt: "2026-01-01T00:00:00.000Z",
    chapters: [
      { title: "第一章·启程", content: "内容一", correspondingNode: 0 },
      {
        title: "第二章·转折",
        content: "编辑后内容",
        rawContent: "原始AI内容",
        correspondingNode: 1,
      },
    ],
  } as StoryDraft
}

function seed() {
  useWikiStore.setState({ project: PROJECT, activeView: "storySimulation", selectedFile: null } as never)
  useStorySimulationStore.setState({
    currentFramework: makeFramework(),
    currentDraft: makeDraft(),
    error: null,
    infoMessage: null,
  } as never)
}

let writeText!: ReturnType<typeof vi.fn>

beforeEach(() => {
  setupDomGlobals()
  vi.clearAllMocks()
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  })
  seed()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useStorySimulationStore.setState({
    currentFramework: null,
    currentDraft: null,
    error: null,
    infoMessage: null,
  } as never)
  useWikiStore.setState({ project: null, activeView: "wiki", selectedFile: null } as never)
})

function openImportDialog() {
  fireEvent.click(screen.getByText(T.importToChapters))
  return screen.findByText(T.importDraftTitle)
}

describe("StoryDraftView 基础渲染", () => {
  it("draft 为 null 时渲染 null", () => {
    useStorySimulationStore.setState({ currentDraft: null } as never)
    const onBack = vi.fn()
    const { container } = render(<StoryDraftView onBack={onBack} />)
    expect(container.innerHTML).toBe("")
  })

  it("渲染标题、总字数、章节与编辑痕迹徽章", () => {
    render(<StoryDraftView onBack={vi.fn()} />)
    expect(screen.getByText(T.draftTitle)).toBeTruthy()
    expect(document.body.textContent ?? "").toContain("120")
    expect(screen.getByText("第一章·启程")).toBeTruthy()
    expect(screen.getByText("内容一")).toBeTruthy()
    expect(screen.getByText(T.editedBadge)).toBeTruthy()
  })

  it("返回按钮调用 onBack", () => {
    const onBack = vi.fn()
    render(<StoryDraftView onBack={onBack} />)
    fireEvent.click(screen.getByRole("button", { name: TC.back }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})

describe("StoryDraftView 复制与导出", () => {
  it("复制全部拼接章节并显示已复制", async () => {
    render(<StoryDraftView onBack={vi.fn()} />)
    fireEvent.click(screen.getByText(T.copyAll))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1)
    })
    const text = writeText.mock.calls[0][0] as string
    expect(text).toContain("第一章·启程")
    expect(text).toContain("内容一")
    expect(text).toContain("---")
    expect(text).toContain("第二章·转折")
    expect(await screen.findByText(T.copied)).toBeTruthy()
  })

  it("导出成功提示路径", async () => {
    vi.mocked(exportDraft).mockResolvedValue("/exports/draft.md")
    render(<StoryDraftView onBack={vi.fn()} />)
    fireEvent.click(screen.getByText(T.exportMd))
    await waitFor(() => {
      expect(vi.mocked(exportDraft)).toHaveBeenCalledWith(
        "C:/proj",
        expect.objectContaining({ id: "fw-1" }),
        expect.objectContaining({ branchId: "b1" }),
      )
    })
    await waitFor(() => {
      expect(useStorySimulationStore.getState().infoMessage).toBe(
        T.draftExported.replace("{{path}}", "/exports/draft.md"),
      )
    })
  })

  it("导出失败写 error", async () => {
    vi.mocked(exportDraft).mockRejectedValue(new Error("disk full"))
    render(<StoryDraftView onBack={vi.fn()} />)
    fireEvent.click(screen.getByText(T.exportMd))
    await waitFor(() => {
      expect(useStorySimulationStore.getState().error).toContain("操作失败")
    })
  })

  it("无 projectPath 时导出直接返回", () => {
    useWikiStore.setState({ project: null } as never)
    render(<StoryDraftView onBack={vi.fn()} />)
    fireEvent.click(screen.getByText(T.exportMd))
    expect(vi.mocked(exportDraft)).not.toHaveBeenCalled()
  })
})

describe("StoryDraftView 导入对话框", () => {
  it("打开时自动计算起始章并默认全选", async () => {
    vi.mocked(getNextChapterNumber).mockResolvedValue(7)
    render(<StoryDraftView onBack={vi.fn()} />)
    await openImportDialog()
    await waitFor(() => {
      expect(vi.mocked(getNextChapterNumber)).toHaveBeenCalledWith("C:/proj")
    })
    expect(screen.getByText(T.selectedChapters.replace("{{selected}}", "2").replace("{{total}}", "2"))).toBeTruthy()
    expect(document.body.textContent ?? "").toContain("7")
  })

  it("起始章计算失败时保留默认值 1", async () => {
    vi.mocked(getNextChapterNumber).mockRejectedValue(new Error("no dir"))
    render(<StoryDraftView onBack={vi.fn()} />)
    await openImportDialog()
    await waitFor(() => {
      expect(screen.getByText(T.selectedChapters.replace("{{selected}}", "2").replace("{{total}}", "2"))).toBeTruthy()
    })
  })

  it("单选切换与全选/全不选切换", async () => {
    vi.mocked(getNextChapterNumber).mockResolvedValue(3)
    render(<StoryDraftView onBack={vi.fn()} />)
    await openImportDialog()
    await waitFor(() => {
      expect(vi.mocked(getNextChapterNumber)).toHaveBeenCalled()
    })
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[]
    // 章节 2 个 + 自动起始 + 覆盖 = 4 个 checkbox，前两个是章节
    expect(boxes[0].checked).toBe(true)
    fireEvent.click(boxes[0])
    expect(
      screen.getByText(T.selectedChapters.replace("{{selected}}", "1").replace("{{total}}", "2")),
    ).toBeTruthy()
    // 单选掉一个后 toggle 按钮翻为「全选」
    fireEvent.click(screen.getByText(T.selectAll))
    expect(
      screen.getByText(T.selectedChapters.replace("{{selected}}", "2").replace("{{total}}", "2")),
    ).toBeTruthy()
    // 全不选
    fireEvent.click(screen.getByText(T.deselectAll))
    // 全不选后 effect 会自动回填全选（防空守卫），确认按钮保持 2 章
    await waitFor(() => {
      expect(
        screen.getByText(T.selectedChapters.replace("{{selected}}", "2").replace("{{total}}", "2")),
      ).toBeTruthy()
    })
  })

  it("零选中时确认按钮禁用且不调用导入（空守卫经禁用态覆盖）", async () => {
    // 先关掉自动起始章，防空回填 effect 才不会把全不选又填回去
    vi.mocked(getNextChapterNumber).mockResolvedValue(1)
    render(<StoryDraftView onBack={vi.fn()} />)
    await openImportDialog()
    await waitFor(() => {
      expect(vi.mocked(getNextChapterNumber)).toHaveBeenCalled()
    })
    const autoBox = screen.getByText(T.autoStartChapter).closest("label")!.querySelector("input") as HTMLInputElement
    fireEvent.click(autoBox)
    fireEvent.click(screen.getByText(T.deselectAll))
    expect(
      screen.getByText(T.selectedChapters.replace("{{selected}}", "0").replace("{{total}}", "2")),
    ).toBeTruthy()
    // 确认按钮 disabled：disabled 原生抑制 click，handleImport 不被调用
    const confirm = screen.getByText(T.confirmImportCount.replace("{{count}}", "0")).closest("button") as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    expect(vi.mocked(importDraftToChapters)).not.toHaveBeenCalled()
    expect(useStorySimulationStore.getState().error).toBeNull()
  })

  it("导入成功：进度回调、结果视图、刷新项目、选中首章", async () => {
    vi.mocked(getNextChapterNumber).mockResolvedValue(5)
    vi.mocked(importDraftToChapters).mockImplementation(async (_p, _f, _d, opts) => {
      opts?.onProgress?.(1, 2, "第一章·启程")
      return {
        importedCount: 2,
        startChapter: 5,
        chapterPaths: ["/ch5.md", "/ch6.md"],
        backedUpPaths: ["/ch5.bak.md"],
      } as never
    })
    vi.mocked(refreshProjectState).mockResolvedValue(undefined)
    render(<StoryDraftView onBack={vi.fn()} />)
    await openImportDialog()
    await waitFor(() => {
      expect(vi.mocked(getNextChapterNumber)).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByText(T.confirmImportCount.replace("{{count}}", "2")))
    await waitFor(() => {
      expect(vi.mocked(importDraftToChapters)).toHaveBeenCalled()
    })
    const callOpts = vi.mocked(importDraftToChapters).mock.calls[0][3] as {
      startChapter: number
      overwrite: boolean
      selectedIndices: number[]
    }
    expect(callOpts.startChapter).toBe(5)
    expect(callOpts.selectedIndices).toEqual([0, 1])
    await waitFor(() => {
      expect(screen.getByText(T.importSuccess)).toBeTruthy()
    })
    expect(screen.getByText(T.importSuccessCount.replace("{{count}}", "2"))).toBeTruthy()
    expect(
      screen.getByText(
        T.chapterRange.replace("{{start}}", "5").replace("{{end}}", "6"),
      ),
    ).toBeTruthy()
    expect(screen.getByText(T.autoBackupCount.replace("{{count}}", "1"))).toBeTruthy()
    expect(vi.mocked(refreshProjectState)).toHaveBeenCalledWith("C:/proj")
    expect(useWikiStore.getState().selectedFile).toBe("/ch5.md")
  })

  it("导入失败写 error", async () => {
    vi.mocked(getNextChapterNumber).mockResolvedValue(1)
    vi.mocked(importDraftToChapters).mockRejectedValue(new Error("import boom"))
    render(<StoryDraftView onBack={vi.fn()} />)
    await openImportDialog()
    await waitFor(() => {
      expect(vi.mocked(getNextChapterNumber)).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByText(T.confirmImportCount.replace("{{count}}", "2")))
    await waitFor(() => {
      expect(useStorySimulationStore.getState().error).toContain("操作失败")
    })
    expect(screen.queryByText(T.importSuccess)).toBeNull()
  })

  it("导入中显示进度条（current/total/标题）", async () => {
    vi.mocked(getNextChapterNumber).mockResolvedValue(1)
    let release!: (v: never) => void
    vi.mocked(importDraftToChapters).mockImplementation((_p, _f, _d, opts) => {
      opts?.onProgress?.(1, 2, "第一章·启程")
      return new Promise((res) => {
        release = res as (v: never) => void
      })
    })
    render(<StoryDraftView onBack={vi.fn()} />)
    await openImportDialog()
    await waitFor(() => {
      expect(vi.mocked(getNextChapterNumber)).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByText(T.confirmImportCount.replace("{{count}}", "2")))
    await waitFor(() => {
      expect(screen.getByText(T.importingChapter.replace("{{title}}", "第一章·启程"))).toBeTruthy()
    })
    release({ importedCount: 1, startChapter: 1, chapterPaths: [], backedUpPaths: [] } as never)
    await waitFor(() => {
      expect(screen.getByText(T.importSuccess)).toBeTruthy()
    })
  })

  it("导入中确认按钮禁用；去章节库重置并切换视图", async () => {
    vi.mocked(getNextChapterNumber).mockResolvedValue(2)
    vi.mocked(importDraftToChapters).mockResolvedValue({
      importedCount: 1,
      startChapter: 2,
      chapterPaths: ["/ch2.md"],
      backedUpPaths: [],
    } as never)
    render(<StoryDraftView onBack={vi.fn()} />)
    await openImportDialog()
    await waitFor(() => {
      expect(vi.mocked(getNextChapterNumber)).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByText(T.confirmImportCount.replace("{{count}}", "2")))
    await screen.findByText(T.importSuccess)
    // 去章节库
    fireEvent.click(screen.getByText(T.goToChapters))
    expect(useWikiStore.getState().activeView).toBe("wiki")
    expect(screen.queryByText(T.importSuccess)).toBeNull()
  })

  it("留在原地仅关闭并重置选中", async () => {
    vi.mocked(getNextChapterNumber).mockResolvedValue(2)
    vi.mocked(importDraftToChapters).mockResolvedValue({
      importedCount: 1,
      startChapter: 2,
      chapterPaths: [],
      backedUpPaths: [],
    } as never)
    render(<StoryDraftView onBack={vi.fn()} />)
    await openImportDialog()
    await waitFor(() => {
      expect(vi.mocked(getNextChapterNumber)).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByText(T.confirmImportCount.replace("{{count}}", "2")))
    await screen.findByText(T.importSuccess)
    fireEvent.click(screen.getByText(T.stayHere))
    expect(screen.queryByText(T.importSuccess)).toBeNull()
    expect(useWikiStore.getState().activeView).toBe("storySimulation")
  })

  it("取消自动起始章可手动输入，0 被钳制为 1；重勾自动重新计算", async () => {
    vi.mocked(getNextChapterNumber).mockResolvedValue(9)
    render(<StoryDraftView onBack={vi.fn()} />)
    await openImportDialog()
    const callsAfterOpen = vi.mocked(getNextChapterNumber).mock.calls.length
    await waitFor(() => {
      expect(vi.mocked(getNextChapterNumber)).toHaveBeenCalled()
    })
    const autoBox = screen.getByText(T.autoStartChapter).closest("label")!.querySelector("input") as HTMLInputElement
    fireEvent.click(autoBox)
    const num = screen.getByText(T.startChapterLabel).parentElement!.querySelector("input") as HTMLInputElement
    fireEvent.change(num, { target: { value: "0" } })
    expect(num.value).toBe("1")
    fireEvent.change(num, { target: { value: "8" } })
    expect(num.value).toBe("8")
    fireEvent.click(autoBox)
    await waitFor(() => {
      expect(vi.mocked(getNextChapterNumber).mock.calls.length).toBeGreaterThan(callsAfterOpen)
    })
  })

  it("覆盖选项切换显示不同提示", async () => {
    vi.mocked(getNextChapterNumber).mockResolvedValue(1)
    render(<StoryDraftView onBack={vi.fn()} />)
    await openImportDialog()
    await waitFor(() => {
      expect(vi.mocked(getNextChapterNumber)).toHaveBeenCalled()
    })
    expect(screen.getByText(T.overwriteWarnHint)).toBeTruthy()
    const owBox = screen.getByText(T.overwriteFiles).closest("label")!.querySelector("input") as HTMLInputElement
    fireEvent.click(owBox)
    expect(screen.getByText(T.overwriteBackupHint)).toBeTruthy()
  })

  it("对话框取消按钮关闭并重置", async () => {
    vi.mocked(getNextChapterNumber).mockResolvedValue(1)
    render(<StoryDraftView onBack={vi.fn()} />)
    await openImportDialog()
    await waitFor(() => {
      expect(vi.mocked(getNextChapterNumber)).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByText(T.cancel))
    await waitFor(() => {
      expect(screen.queryByText(T.importDraftTitle)).toBeNull()
    })
  })
})

describe("StoryDraftView 定时器与守卫补充", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("复制后 2s 恢复未复制态", async () => {
    render(<StoryDraftView onBack={vi.fn()} />)
    fireEvent.click(screen.getByText(T.copyAll))
    await vi.advanceTimersByTimeAsync(2500)
    // 若 85 行回调未执行，按钮会停留在已复制态
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(screen.getByText(T.copyAll)).toBeTruthy()
    expect(screen.queryByText(T.copied)).toBeNull()
  })

  it("导出成功/失败的提示定时清理", async () => {
    vi.mocked(exportDraft).mockResolvedValueOnce("/d.md")
    render(<StoryDraftView onBack={vi.fn()} />)
    fireEvent.click(screen.getByText(T.exportMd))
    await vi.advanceTimersByTimeAsync(0)
    expect(useStorySimulationStore.getState().infoMessage).toContain("/d.md")
    await vi.advanceTimersByTimeAsync(6000)
    expect(useStorySimulationStore.getState().infoMessage).toBeNull()
    cleanup()
    seed()
    vi.mocked(exportDraft).mockRejectedValueOnce(new Error("disk"))
    render(<StoryDraftView onBack={vi.fn()} />)
    fireEvent.click(screen.getByText(T.exportMd))
    await vi.advanceTimersByTimeAsync(0)
    expect(useStorySimulationStore.getState().error).toContain("操作失败")
    await vi.advanceTimersByTimeAsync(6000)
    expect(useStorySimulationStore.getState().error).toBeNull()
  })

  it("导入失败的提示定时清理", async () => {
    vi.mocked(getNextChapterNumber).mockResolvedValue(1)
    vi.mocked(importDraftToChapters).mockRejectedValueOnce(new Error("boom"))
    render(<StoryDraftView onBack={vi.fn()} />)
    fireEvent.click(screen.getByText(T.importToChapters))
    await vi.advanceTimersByTimeAsync(0)
    fireEvent.click(screen.getByText(T.confirmImportCount.replace("{{count}}", "2")))
    await vi.advanceTimersByTimeAsync(0)
    expect(useStorySimulationStore.getState().error).toContain("操作失败")
    await vi.advanceTimersByTimeAsync(6000)
    expect(useStorySimulationStore.getState().error).toBeNull()
  })
})

describe("StoryDraftView 导入守卫与对话框回调", () => {
  it("导入时缺失 projectPath 直接返回（不调用导入）", async () => {
    vi.mocked(getNextChapterNumber).mockResolvedValue(1)
    render(<StoryDraftView onBack={vi.fn()} />)
    await openImportDialog()
    await waitFor(() => {
      expect(vi.mocked(getNextChapterNumber)).toHaveBeenCalled()
    })
    // 选中保持 2 章，随后丢失项目路径再确认 → 命中缺参守卫
    act(() => {
      useWikiStore.setState({ project: null } as never)
    })
    fireEvent.click(screen.getByText(T.confirmImportCount.replace("{{count}}", "2")))
    expect(vi.mocked(importDraftToChapters)).not.toHaveBeenCalled()
    expect(useStorySimulationStore.getState().error).toBeNull()
  })

  it("导入时缺失 currentFramework 直接返回", async () => {
    useStorySimulationStore.setState({ currentFramework: null } as never)
    vi.mocked(getNextChapterNumber).mockResolvedValue(1)
    render(<StoryDraftView onBack={vi.fn()} />)
    await openImportDialog()
    await waitFor(() => {
      expect(vi.mocked(getNextChapterNumber)).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByText(T.confirmImportCount.replace("{{count}}", "2")))
    expect(vi.mocked(importDraftToChapters)).not.toHaveBeenCalled()
    expect(useStorySimulationStore.getState().error).toBeNull()
  })

  it("toggle 可从空集新增选中", async () => {
    vi.mocked(getNextChapterNumber).mockResolvedValue(1)
    render(<StoryDraftView onBack={vi.fn()} />)
    await openImportDialog()
    await waitFor(() => {
      expect(vi.mocked(getNextChapterNumber)).toHaveBeenCalled()
    })
    const autoBox = screen.getByText(T.autoStartChapter).closest("label")!.querySelector("input") as HTMLInputElement
    fireEvent.click(autoBox)
    fireEvent.click(screen.getByText(T.deselectAll))
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[]
    fireEvent.click(boxes[1])
    expect(
      screen.getByText(T.selectedChapters.replace("{{selected}}", "1").replace("{{total}}", "2")),
    ).toBeTruthy()
  })

  it("导入中无进度时显示正在导入（importing 纯态）", async () => {
    vi.mocked(getNextChapterNumber).mockResolvedValue(1)
    let release!: (v: never) => void
    let progressCb: ((c: number, t: number, title: string) => void) | undefined
    vi.mocked(importDraftToChapters).mockImplementation((_p, _f, _d, opts) => {
      progressCb = opts?.onProgress
      return new Promise((res) => {
        release = res as (v: never) => void
      })
    })
    render(<StoryDraftView onBack={vi.fn()} />)
    await openImportDialog()
    await waitFor(() => {
      expect(vi.mocked(getNextChapterNumber)).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByText(T.confirmImportCount.replace("{{count}}", "2")))
    await waitFor(() => {
      expect(screen.getByText(T.importing)).toBeTruthy()
    })
    // 随后上报进度 → 切换为带计数的进度条
    act(() => {
      progressCb!(1, 2, "第一章·启程")
    })
    expect(screen.getByText(T.importingChapter.replace("{{title}}", "第一章·启程"))).toBeTruthy()
    release({ importedCount: 1, startChapter: 1, chapterPaths: [], backedUpPaths: [] } as never)
    await waitFor(() => {
      expect(screen.getByText(T.importSuccess)).toBeTruthy()
    })
  })

  it("Escape 关闭导入对话框与编辑对话框（onOpenChange 路径）", async () => {
    vi.mocked(getNextChapterNumber).mockResolvedValue(1)
    render(<StoryDraftView onBack={vi.fn()} />)
    await openImportDialog()
    await waitFor(() => {
      expect(vi.mocked(getNextChapterNumber)).toHaveBeenCalled()
    })
    fireEvent.keyDown(document, { key: "Escape" })
    await waitFor(() => {
      expect(screen.queryByText(T.importDraftTitle)).toBeNull()
    })
    // 编辑对话框同样经 onOpenChange(false) 取消
    const editBtns = screen.getAllByRole("button", { name: T.editChapter })
    fireEvent.click(editBtns[0])
    expect(screen.getByText(T.editChapterDesc)).toBeTruthy()
    fireEvent.keyDown(document, { key: "Escape" })
    await waitFor(() => {
      expect(screen.queryByText(T.editChapterDesc)).toBeNull()
    })
    expect(useStorySimulationStore.getState().currentDraft?.chapters[0].title).toBe("第一章·启程")
  })
})

describe("StoryDraftView 章节编辑", () => {
  it("编辑保存更新标题与内容（标题去空格）", () => {
    render(<StoryDraftView onBack={vi.fn()} />)
    const editBtns = screen.getAllByRole("button", { name: T.editChapter })
    fireEvent.click(editBtns[0])
    const dialog = screen.getByText(T.editChapterDesc).parentElement as HTMLElement
    const titleInput = within(dialog.parentElement as HTMLElement).getByDisplayValue("第一章·启程") as HTMLInputElement
    fireEvent.change(titleInput, { target: { value: "  新标题  " } })
    const contentBox = within(dialog.parentElement as HTMLElement).getByDisplayValue("内容一")
    fireEvent.change(contentBox, { target: { value: "新内容" } })
    fireEvent.click(screen.getByText(T.saveChanges))
    const st = useStorySimulationStore.getState()
    expect(st.currentDraft?.chapters[0].title).toBe("新标题")
    expect(st.currentDraft?.chapters[0].content).toBe("新内容")
    expect(screen.getByText("新标题")).toBeTruthy()
  })

  it("空标题保存时回退原标题", () => {
    render(<StoryDraftView onBack={vi.fn()} />)
    const editBtns = screen.getAllByRole("button", { name: T.editChapter })
    fireEvent.click(editBtns[0])
    const titleInput = screen.getByDisplayValue("第一章·启程") as HTMLInputElement
    fireEvent.change(titleInput, { target: { value: "   " } })
    fireEvent.click(screen.getByText(T.saveChanges))
    expect(useStorySimulationStore.getState().currentDraft?.chapters[0].title).toBe("第一章·启程")
  })

  it("取消编辑不修改草稿；字数统计随内容变化", () => {
    render(<StoryDraftView onBack={vi.fn()} />)
    const editBtns = screen.getAllByRole("button", { name: T.editChapter })
    fireEvent.click(editBtns[1])
    const contentBox = screen.getByDisplayValue("编辑后内容")
    fireEvent.change(contentBox, { target: { value: "abc" } })
    expect(screen.getByText(T.wordCount.replace("{{count}}", "3"))).toBeTruthy()
    fireEvent.click(screen.getByText(T.discard))
    expect(useStorySimulationStore.getState().currentDraft?.chapters[1].content).toBe("编辑后内容")
    expect(screen.queryByText(T.editChapterDesc)).toBeNull()
  })
})
