// @vitest-environment jsdom

import { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, setupDomGlobals, waitFor, within } from "@/test-helpers/component-test-utils"
import type { FileNode } from "@/types/wiki"
import { SourceSidebar } from "./source-sidebar"

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ── Mocks ──────────────────────────────────────────────────────────────────

interface ProjectLike {
  id: string
  name: string
  path: string
}

interface NovelConfigLike {
  autoExtractOnImport: boolean
  [key: string]: unknown
}

interface WikiStateMock {
  project: ProjectLike | null
  selectedFile: string | null
  setSelectedFile: ReturnType<typeof vi.fn>
  setFileTree: ReturnType<typeof vi.fn>
  novelConfig: NovelConfigLike
  setNovelConfig: ReturnType<typeof vi.fn>
  llmConfig: { provider: string; apiKey: string; model: string; [key: string]: unknown }
  dataVersion: number
}

const mocks = vi.hoisted(() => {
  const state: WikiStateMock = {
    project: null,
    selectedFile: null,
    setSelectedFile: vi.fn(),
    setFileTree: vi.fn(),
    novelConfig: { autoExtractOnImport: true },
    setNovelConfig: vi.fn(),
    llmConfig: { provider: "openai", apiKey: "k", model: "m" },
    dataVersion: 0,
  }
  return {
    state,
    getState: { bumpDataVersion: vi.fn() },
    isTauri: vi.fn(() => false),
    listDirectory: vi.fn(),
    copyFile: vi.fn(),
    deleteFile: vi.fn(),
    fileExists: vi.fn(),
    saveNovelConfig: vi.fn(),
    deleteSourceFile: vi.fn(),
    deleteSourceFolder: vi.fn(),
    enqueueSourceIngest: vi.fn(),
    importSourceFiles: vi.fn(),
    importSourceFolder: vi.fn(),
    queue: [] as Array<{ id: string; status: string; [key: string]: unknown }>,
    dialogOpen: vi.fn(),
  }
})

vi.mock("@/lib/platform", () => ({
  isTauri: mocks.isTauri,
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: WikiStateMock) => unknown) => selector(mocks.state),
    { getState: () => mocks.getState },
  ),
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: mocks.listDirectory,
  copyFile: mocks.copyFile,
  deleteFile: mocks.deleteFile,
  fileExists: mocks.fileExists,
}))

vi.mock("@/lib/project-store", () => ({
  saveNovelConfig: mocks.saveNovelConfig,
}))

vi.mock("@/lib/source-lifecycle", () => ({
  deleteSourceFile: mocks.deleteSourceFile,
  deleteSourceFolder: mocks.deleteSourceFolder,
  enqueueSourceIngest: mocks.enqueueSourceIngest,
  importSourceFiles: mocks.importSourceFiles,
  importSourceFolder: mocks.importSourceFolder,
}))

vi.mock("@/lib/ingest-queue", () => ({
  getQueue: () => mocks.queue,
}))

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.dialogOpen,
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// ── Fixtures ───────────────────────────────────────────────────────────────

const PROJECT: ProjectLike = { id: "p1", name: "MyBook", path: "/p" }

const fileA: FileNode = { name: "alpha.md", path: "/p/raw/sources/alpha.md", is_dir: false }
const fileB: FileNode = { name: "beta.md", path: "/p/raw/sources/beta.md", is_dir: false }
const dotFile: FileNode = { name: ".hidden.md", path: "/p/raw/sources/.hidden.md", is_dir: false }
const emptyFolder: FileNode = { name: "empty", path: "/p/raw/sources/empty", is_dir: true, children: [] }
const folder: FileNode = {
  name: "notes",
  path: "/p/raw/sources/notes",
  is_dir: true,
  children: [
    { name: "inner.md", path: "/p/raw/sources/notes/inner.md", is_dir: false },
    {
      name: "deep",
      path: "/p/raw/sources/notes/deep",
      is_dir: true,
      children: [{ name: "leaf.md", path: "/p/raw/sources/notes/deep/leaf.md", is_dir: false }],
    },
  ],
}
const licenseFile: FileNode = { name: "LICENSE", path: "/p/raw/sources/LICENSE", is_dir: false }
const sourcesTree: FileNode[] = [folder, fileA, licenseFile, fileB, dotFile, emptyFolder]

const wikiNodes: FileNode[] = [
  { name: "index.md", path: "/p/wiki/index.md", is_dir: false },
  { name: "pages", path: "/p/wiki/pages", is_dir: true, children: [{ name: "ch1.md", path: "/p/wiki/pages/ch1.md", is_dir: false }] },
]

function makeManyFiles(count: number): FileNode[] {
  return Array.from({ length: count }, (_v, i) => ({
    name: `f${i}.md`,
    path: `/p/raw/sources/f${i}.md`,
    is_dir: false,
  }))
}

// IntersectionObserver that captures callbacks so tests can drive load-more.
const ioCallbacks: Array<IntersectionObserverCallback> = []
class CapturingIntersectionObserver {
  root = null
  rootMargin = ""
  thresholds: number[] = []
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
  takeRecords = vi.fn(() => [])
  constructor(cb: IntersectionObserverCallback) {
    ioCallbacks.push(cb)
  }
}

function triggerIntersection(isIntersecting: boolean): void {
  const cb = ioCallbacks[ioCallbacks.length - 1]
  act(() => {
    cb([{ isIntersecting } as IntersectionObserverEntry], null as unknown as IntersectionObserver)
  })
}

// ── Setup ──────────────────────────────────────────────────────────────────

function defaultFsMocks(): void {
  mocks.listDirectory.mockImplementation((dir: string) => {
    if (dir.endsWith("/raw/sources")) return Promise.resolve(sourcesTree)
    return Promise.resolve([...sourcesTree, ...wikiNodes])
  })
  mocks.copyFile.mockResolvedValue(undefined)
  mocks.deleteFile.mockResolvedValue(undefined)
  mocks.fileExists.mockResolvedValue(false)
  mocks.saveNovelConfig.mockResolvedValue(undefined)
  mocks.deleteSourceFile.mockResolvedValue({ deletedWikiPaths: [], rewrittenSourcePages: 0 })
  mocks.deleteSourceFolder.mockResolvedValue({ deletedWikiPaths: [] })
  mocks.enqueueSourceIngest.mockResolvedValue(["task-1"])
  mocks.importSourceFiles.mockResolvedValue({ importedPaths: [], taskIdsByPath: {} })
  mocks.importSourceFolder.mockResolvedValue({ importedPaths: [], taskIdsByPath: {} })
}

function resetState(): void {
  mocks.state.project = PROJECT
  mocks.state.selectedFile = null
  mocks.state.novelConfig = { autoExtractOnImport: true }
  mocks.state.dataVersion = 0
  mocks.queue.length = 0
  ioCallbacks.length = 0
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
    CapturingIntersectionObserver as unknown as typeof IntersectionObserver
}

function stubGetAnimations(): void {
  if (typeof Element !== "undefined" && typeof Element.prototype.getAnimations !== "function") {
    ;(Element.prototype as unknown as { getAnimations: () => unknown }).getAnimations = () => []
  }
}

function fileRow(name: string): HTMLElement {
  const row = screen.getByText(name).closest("div[data-source-interactive='true']")
  expect(row).not.toBeNull()
  return row as HTMLElement
}

beforeEach(() => {
  vi.clearAllMocks()
  resetState()
  defaultFsMocks()
  stubGetAnimations()
  setupDomGlobals({ resizeObserver: true, scrollTo: true, matchMedia: true })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

// ── Tests ──────────────────────────────────────────────────────────────────

describe("SourceSidebar — 空态 / 数据态渲染", () => {
  it("无项目时不加载目录并显示空态", async () => {
    mocks.state.project = null
    render(<SourceSidebar />)
    await act(async () => {})
    expect(mocks.listDirectory).not.toHaveBeenCalled()
    expect(screen.getByText("novel.sources.noSources")).toBeTruthy()
  })

  it("项目目录为空时显示空态", async () => {
    mocks.listDirectory.mockResolvedValue([])
    render(<SourceSidebar />)
    expect(await screen.findByText("novel.sources.noSources")).toBeTruthy()
    expect(mocks.listDirectory).toHaveBeenCalledWith("/p/raw/sources")
  })

  it("目录读取失败时回退为空态", async () => {
    mocks.listDirectory.mockRejectedValue(new Error("boom"))
    render(<SourceSidebar />)
    expect(await screen.findByText("novel.sources.noSources")).toBeTruthy()
  })

  it("渲染过滤后的源树：过滤点文件与空目录，展示文件与文件夹", async () => {
    render(<SourceSidebar />)
    expect(await screen.findByText("alpha.md")).toBeTruthy()
    expect(screen.getByText("beta.md")).toBeTruthy()
    expect(screen.getByText("LICENSE")).toBeTruthy()
    expect(screen.getByText("notes")).toBeTruthy()
    expect(screen.queryByText(".hidden.md")).toBeNull()
    expect(screen.queryByText("empty")).toBeNull()
    // 文件夹初始展开 → 子文件可见
    expect(screen.getByText("inner.md")).toBeTruthy()
    expect(screen.getByText("deep")).toBeTruthy()
    expect(screen.getByText("leaf.md")).toBeTruthy()
  })

  it("dataVersion 变化时重新加载源树", async () => {
    const { rerender } = render(<SourceSidebar onRequestCreate={() => {}} />)
    await screen.findByText("alpha.md")
    const callsAfterMount = mocks.listDirectory.mock.calls.length
    mocks.state.dataVersion = 1
    rerender(<SourceSidebar />)
    await act(async () => {})
    expect(mocks.listDirectory.mock.calls.length).toBeGreaterThan(callsAfterMount)
  })
})

describe("SourceSidebar — 树交互", () => {
  it("点击文件行回调 setSelectedFile", async () => {
    render(<SourceSidebar />)
    fireEvent.click(await screen.findByText("alpha.md"))
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith(fileA.path)
  })

  it("selectedFile 命中时文件行使用选中样式", async () => {
    mocks.state.selectedFile = fileA.path
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    const row = fileRow("alpha.md")
    expect(row.className).toContain("qm-selected")
    const betaRow = fileRow("beta.md")
    expect(betaRow.className).toContain("qm-hover")
  })

  it("文件夹可折叠/展开（子节点隐藏，再次点击展开）", async () => {
    render(<SourceSidebar />)
    await screen.findByText("notes")
    const folderToggle = screen.getByText("notes").closest("button") as HTMLButtonElement
    fireEvent.click(folderToggle)
    expect(screen.queryByText("inner.md")).toBeNull()
    expect(screen.queryByText("deep")).toBeNull()
    fireEvent.click(folderToggle)
    expect(screen.getByText("inner.md")).toBeTruthy()
    expect(screen.getByText("leaf.md")).toBeTruthy()
  })

  it("大量节点时先渲染 160 行，IntersectionObserver 触发加载更多", async () => {
    mocks.listDirectory.mockImplementation((_dir: string) => Promise.resolve(makeManyFiles(165)))
    render(<SourceSidebar />)
    expect(await screen.findByText("f0.md")).toBeTruthy()
    expect(screen.getByText("sources.loadingMore")).toBeTruthy()
    // localeCompare 排序下 f99.md 位于第 161 行之后 → 初始不可见
    expect(screen.queryByText("f99.md")).toBeNull()

    // 非交叉 → 不变
    triggerIntersection(false)
    expect(screen.queryByText("f99.md")).toBeNull()

    // 交叉 → 加载更多
    triggerIntersection(true)
    await act(async () => {})
    expect(screen.getByText("f99.md")).toBeTruthy()
    // 全部可见后 loadingMore 消失
    await waitFor(() => expect(screen.queryByText("sources.loadingMore")).toBeNull())
  })
})

describe("SourceSidebar — 自动提取开关", () => {
  it("切换自动提取并保存配置", async () => {
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    const toggle = document.querySelector("button[aria-pressed]") as HTMLButtonElement
    expect(toggle.getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(toggle)
    await waitFor(() => {
      expect(mocks.state.setNovelConfig).toHaveBeenCalledWith({ autoExtractOnImport: false })
    })
    expect(mocks.saveNovelConfig).toHaveBeenCalledWith(
      expect.objectContaining({ autoExtractOnImport: false }),
      PROJECT.id,
      PROJECT.path,
    )
  })

  it("切换开关时保存失败仅记录错误", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.saveNovelConfig.mockRejectedValue(new Error("save-fail"))
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    const toggle = document.querySelector("button[aria-pressed]") as HTMLButtonElement
    fireEvent.click(toggle)
    await waitFor(() => expect(errorSpy).toHaveBeenCalled())
    errorSpy.mockRestore()
  })

  it("autoExtractOnImport=false 时开关渲染未启用样式", async () => {
    mocks.state.novelConfig = { autoExtractOnImport: false }
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    const toggle = document.querySelector("button[aria-pressed]") as HTMLButtonElement
    expect(toggle.getAttribute("aria-pressed")).toBe("false")
    expect(toggle.className).toContain("bg-input")
    const knob = toggle.querySelector("span") as HTMLSpanElement
    expect(knob.className).toContain("translate-x-0")
  })

  it("无项目时切换开关直接返回", async () => {
    mocks.state.project = null
    render(<SourceSidebar />)
    await act(async () => {})
    const toggle = document.querySelector("button[aria-pressed]") as HTMLButtonElement
    fireEvent.click(toggle)
    expect(mocks.state.setNovelConfig).not.toHaveBeenCalled()
  })
})

describe("SourceSidebar — 删除（arm → fire 两段式）", () => {
  it("文件删除：首次点击 arm 显示确认，再次点击 fire 走删除链路并清空选中", async () => {
    mocks.state.selectedFile = fileA.path
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    const row = fileRow("alpha.md")

    fireEvent.click(within(row).getByTitle("sources.deleteFile"))
    expect(within(row).getByTitle("sources.deleteFileConfirm")).toBeTruthy()

    fireEvent.click(within(row).getByTitle("sources.deleteFileConfirm"))
    await waitFor(() => expect(mocks.deleteSourceFile).toHaveBeenCalledWith("/p", fileA.path))
    expect(mocks.listDirectory).toHaveBeenCalledWith("/p")
    expect(mocks.state.setFileTree).toHaveBeenCalled()
    expect(mocks.getState.bumpDataVersion).toHaveBeenCalled()
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith(null)
  })

  it("文件删除：deletedWikiPaths 包含选中文件时清空选中", async () => {
    mocks.state.selectedFile = "/p/wiki/other-target.md"
    mocks.deleteSourceFile.mockResolvedValue({ deletedWikiPaths: ["/p/wiki/other-target.md"], rewrittenSourcePages: 0 })
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    const row = fileRow("alpha.md")
    fireEvent.click(within(row).getByTitle("sources.deleteFile"))
    fireEvent.click(within(row).getByTitle("sources.deleteFileConfirm"))
    await waitFor(() => expect(mocks.state.setSelectedFile).toHaveBeenCalledWith(null))
  })

  it("文件删除：选中文件不相关时不重置选中", async () => {
    mocks.state.selectedFile = "/p/wiki/other.md"
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    const row = fileRow("alpha.md")
    fireEvent.click(within(row).getByTitle("sources.deleteFile"))
    fireEvent.click(within(row).getByTitle("sources.deleteFileConfirm"))
    await waitFor(() => expect(mocks.deleteSourceFile).toHaveBeenCalled())
    expect(mocks.state.setSelectedFile).not.toHaveBeenCalledWith(null)
  })

  it("文件删除失败时 alert + console.error", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.deleteSourceFile.mockRejectedValue(new Error("del-fail"))
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    const row = fileRow("alpha.md")
    fireEvent.click(within(row).getByTitle("sources.deleteFile"))
    fireEvent.click(within(row).getByTitle("sources.deleteFileConfirm"))
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining("删除失败")))
    expect(errorSpy).toHaveBeenCalled()
    alertSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it("无项目时删除直接返回", async () => {
    const { rerender } = render(<SourceSidebar onRequestCreate={() => {}} />)
    await screen.findByText("alpha.md")
    mocks.state.project = null
    rerender(<SourceSidebar />)
    const row = fileRow("alpha.md")
    fireEvent.click(within(row).getByTitle("sources.deleteFile"))
    fireEvent.click(within(row).getByTitle("sources.deleteFileConfirm"))
    await act(async () => {})
    expect(mocks.deleteSourceFile).not.toHaveBeenCalled()
    // 文件夹删除同样被 !project 守卫拦下
    const folderRow = fileRow("notes")
    fireEvent.click(within(folderRow).getByTitle("sources.deleteFolder"))
    fireEvent.click(within(folderRow).getByTitle("sources.deleteFolderConfirm"))
    await act(async () => {})
    expect(mocks.deleteSourceFolder).not.toHaveBeenCalled()
  })

  it("文件夹删除：选中与 deletedWikiPaths 均不相关时不重置选中", async () => {
    mocks.state.selectedFile = "/p/wiki/unrelated.md"
    render(<SourceSidebar />)
    await screen.findByText("notes")
    const row = fileRow("notes")
    fireEvent.click(within(row).getByTitle("sources.deleteFolder"))
    fireEvent.click(within(row).getByTitle("sources.deleteFolderConfirm"))
    await waitFor(() => expect(mocks.deleteSourceFolder).toHaveBeenCalled())
    expect(mocks.state.setSelectedFile).not.toHaveBeenCalledWith(null)
  })

  it("文件夹删除：arm → fire-folder，选中子文件时清空选中", async () => {
    mocks.state.selectedFile = "/p/raw/sources/notes/inner.md"
    render(<SourceSidebar />)
    await screen.findByText("notes")
    const row = fileRow("notes")

    fireEvent.click(within(row).getByTitle("sources.deleteFolder"))
    expect(within(row).getByTitle("sources.deleteFolderConfirm")).toBeTruthy()

    fireEvent.click(within(row).getByTitle("sources.deleteFolderConfirm"))
    await waitFor(() => expect(mocks.deleteSourceFolder).toHaveBeenCalledWith("/p", folder))
    expect(mocks.state.setFileTree).toHaveBeenCalled()
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith(null)
  })

  it("文件夹删除：deletedWikiPaths 命中选中文件时清空选中", async () => {
    mocks.state.selectedFile = "/p/wiki/notes-page.md"
    mocks.deleteSourceFolder.mockResolvedValue({ deletedWikiPaths: ["/p/wiki/notes-page.md"] })
    render(<SourceSidebar />)
    await screen.findByText("notes")
    const row = fileRow("notes")
    fireEvent.click(within(row).getByTitle("sources.deleteFolder"))
    fireEvent.click(within(row).getByTitle("sources.deleteFolderConfirm"))
    await waitFor(() => expect(mocks.state.setSelectedFile).toHaveBeenCalledWith(null))
  })

  it("文件夹删除失败时 alert", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.deleteSourceFolder.mockRejectedValue(new Error("folder-fail"))
    render(<SourceSidebar />)
    await screen.findByText("notes")
    const row = fileRow("notes")
    fireEvent.click(within(row).getByTitle("sources.deleteFolder"))
    fireEvent.click(within(row).getByTitle("sources.deleteFolderConfirm"))
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining("删除文件夹失败")))
    expect(errorSpy).toHaveBeenCalled()
    alertSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it("arm 后 5 秒未确认自动取消 pending 状态", async () => {
    vi.useFakeTimers()
    render(<SourceSidebar />)
    await act(async () => {
      await Promise.resolve()
    })
    const row = fileRow("alpha.md")
    fireEvent.click(within(row).getByTitle("sources.deleteFile"))
    expect(within(row).getByTitle("sources.deleteFileConfirm")).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(within(row).queryByTitle("sources.deleteFileConfirm")).toBeNull()
  })
})

describe("SourceSidebar — 摄取队列", () => {
  it("摄取成功：注册任务，轮询完成后标记已提取（Check 图标）", async () => {
    vi.useFakeTimers()
    render(<SourceSidebar />)
    await act(async () => {})
    const row = fileRow("alpha.md")
    fireEvent.click(within(row).getByTitle("novel.outlineGenerator.ingest"))
    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.enqueueSourceIngest).toHaveBeenCalled()

    mocks.queue.push({ id: "task-1", status: "done" })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    await act(async () => {})
        expect(row.querySelector(".lucide-check")).toBeTruthy()
    expect(row.querySelector(".text-emerald-600")).toBeTruthy()
    expect(row.querySelector(".lucide-book-open")).toBeNull()
  })

  it("摄取失败任务：移除任务但不上勾", async () => {
    vi.useFakeTimers()
    mocks.enqueueSourceIngest.mockResolvedValue(["task-fail"])
    render(<SourceSidebar />)
    await act(async () => {})
    const row = fileRow("alpha.md")
    fireEvent.click(within(row).getByTitle("novel.outlineGenerator.ingest"))
    await act(async () => {
      await Promise.resolve()
    })
    mocks.queue.push({ id: "task-fail", status: "failed", error: "x" })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    await act(async () => {})
    expect(row.querySelector(".text-emerald-600")).toBeNull()
  })

  it("任务仍在 pending 时保持提取中（Loader2 旋转）", async () => {
    vi.useFakeTimers()
    mocks.enqueueSourceIngest.mockResolvedValue(["task-pending"])
    render(<SourceSidebar />)
    await act(async () => {})
    const row = fileRow("alpha.md")
    fireEvent.click(within(row).getByTitle("novel.outlineGenerator.ingest"))
    await act(async () => {
      await Promise.resolve()
    })
    mocks.queue.push({ id: "task-pending", status: "pending" })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    await act(async () => {})
    expect(row.querySelector(".animate-spin")).toBeTruthy()
  })

  it("队列中找不到任务 id 时也视为完成", async () => {
    vi.useFakeTimers()
    mocks.enqueueSourceIngest.mockResolvedValue(["ghost-task"])
    render(<SourceSidebar />)
    await act(async () => {})
    const row = fileRow("alpha.md")
    fireEvent.click(within(row).getByTitle("novel.outlineGenerator.ingest"))
    await act(async () => {
      await Promise.resolve()
    })
    mocks.queue.length = 0
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    await act(async () => {})
    expect(row.querySelector(".animate-spin")).toBeNull()
    expect(row.querySelector(".lucide-check")).toBeTruthy()
  })

  it("enqueueSourceIngest 返回空数组时不注册任务", async () => {
    mocks.enqueueSourceIngest.mockResolvedValue([])
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    const row = fileRow("alpha.md")
    fireEvent.click(within(row).getByTitle("novel.outlineGenerator.ingest"))
    await waitFor(() => expect(mocks.enqueueSourceIngest).toHaveBeenCalled())
    await act(async () => {})
    expect(row.querySelector(".animate-spin")).toBeNull()
  })

  it("摄取失败时 console.error，且 ingesting 状态复位", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.enqueueSourceIngest.mockRejectedValue(new Error("ingest-fail"))
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    const row = fileRow("alpha.md")
    fireEvent.click(within(row).getByTitle("novel.outlineGenerator.ingest"))
    await waitFor(() => expect(errorSpy).toHaveBeenCalled())
    await waitFor(() => expect(row.querySelector(".animate-spin")).toBeNull())
    errorSpy.mockRestore()
  })

  it("已有摄取进行中时重复点击被忽略", async () => {
    let resolveIngest: (v: string[]) => void = () => {}
    mocks.enqueueSourceIngest.mockImplementation(
      () => new Promise<string[]>((resolve) => { resolveIngest = resolve }),
    )
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    fireEvent.click(within(fileRow("alpha.md")).getByTitle("novel.outlineGenerator.ingest"))
    await act(async () => {})
    // ingestingPath 已设置 → 第二次点击直接返回
    fireEvent.click(within(fileRow("beta.md")).getByTitle("novel.outlineGenerator.ingest"))
    expect(mocks.enqueueSourceIngest).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveIngest(["task-1"])
    })
  })

  it("无项目时摄取直接返回", async () => {
    const { rerender } = render(<SourceSidebar onRequestCreate={() => {}} />)
    await screen.findByText("alpha.md")
    mocks.state.project = null
    rerender(<SourceSidebar />)
    const row = fileRow("alpha.md")
    fireEvent.click(within(row).getByTitle("novel.outlineGenerator.ingest"))
    await act(async () => {})
    expect(mocks.enqueueSourceIngest).not.toHaveBeenCalled()
  })
})

describe("SourceSidebar — 导入菜单", () => {
  it("非 Tauri 环境点击导入文件/文件夹弹窗提示", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    fireEvent.click(screen.getByRole("button", { name: "novel.sources.import" }))
    fireEvent.click(screen.getByText("sources.importFiles"))
    expect(alertSpy).toHaveBeenCalledWith("导入文件功能仅在桌面端可用")
    fireEvent.click(screen.getByText("sources.importFolder"))
    expect(alertSpy).toHaveBeenCalledWith("导入文件夹功能仅在桌面端可用")
    alertSpy.mockRestore()
  })

  it("无项目时点击导入文件直接返回（不弹窗不导入）", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    mocks.state.project = null
    render(<SourceSidebar />)
    await act(async () => {})
    fireEvent.click(screen.getByRole("button", { name: "novel.sources.import" }))
    fireEvent.click(screen.getByText("sources.importFiles"))
    fireEvent.click(screen.getByText("sources.importFolder"))
    await act(async () => {})
    expect(alertSpy).not.toHaveBeenCalled()
    expect(mocks.importSourceFiles).not.toHaveBeenCalled()
    expect(mocks.importSourceFolder).not.toHaveBeenCalled()
    alertSpy.mockRestore()
  })

  it("Tauri：对话框取消时不导入", async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.dialogOpen.mockResolvedValue(null)
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    fireEvent.click(screen.getByRole("button", { name: "novel.sources.import" }))
    fireEvent.click(screen.getByText("sources.importFiles"))
    await act(async () => {})
    expect(mocks.importSourceFiles).not.toHaveBeenCalled()
    // 菜单保持打开
    expect(screen.getByText("sources.importFiles")).toBeTruthy()
  })

  it("Tauri：导入单个文件（open 返回 string）", async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.dialogOpen.mockResolvedValue("/tmp/one.md")
    mocks.importSourceFiles.mockResolvedValue({
      importedPaths: ["/p/raw/sources/one.md"],
      taskIdsByPath: { "/p/raw/sources/one.md": ["t-1"] },
    })
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    fireEvent.click(screen.getByRole("button", { name: "novel.sources.import" }))
    fireEvent.click(screen.getByText("sources.importFiles"))
    await waitFor(() => expect(mocks.importSourceFiles).toHaveBeenCalled())
    expect(mocks.dialogOpen).toHaveBeenCalledWith(expect.objectContaining({ multiple: true }))
    expect(mocks.listDirectory).toHaveBeenCalled()
    // 菜单在 finally 中关闭
    await waitFor(() => expect(screen.queryByText("sources.importFiles")).toBeNull())
  })

  it("Tauri：导入多个文件（open 返回数组）并进入 importing 状态", async () => {
    mocks.isTauri.mockReturnValue(true)
    let resolveImport: (v: { importedPaths: string[]; taskIdsByPath: Record<string, string[]> }) => void = () => {}
    mocks.dialogOpen.mockResolvedValue(["/tmp/a.md", "/tmp/b.md"])
    mocks.importSourceFiles.mockImplementation(
      () => new Promise((resolve) => { resolveImport = resolve }),
    )
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    fireEvent.click(screen.getByRole("button", { name: "novel.sources.import" }))
    fireEvent.click(screen.getByText("sources.importFiles"))
    await waitFor(() => expect(screen.getByText("sources.importing")).toBeTruthy())
    // importing 时导入按钮禁用
    expect(screen.getByRole("button", { name: "sources.importing" }).hasAttribute("disabled")).toBe(true)
    await act(async () => {
      resolveImport({ importedPaths: ["/p/raw/sources/a.md"], taskIdsByPath: {} })
    })
    await waitFor(() => expect(screen.queryByText("sources.importing")).toBeNull())
  })

  it("Tauri：导入文件夹（open 返回 string）", async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.dialogOpen.mockResolvedValue("/tmp/folder")
    mocks.importSourceFolder.mockResolvedValue({
      importedPaths: ["/p/raw/sources/folder/x.md"],
      taskIdsByPath: { "/p/raw/sources/folder/x.md": ["t-2"] },
    })
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    fireEvent.click(screen.getByRole("button", { name: "novel.sources.import" }))
    fireEvent.click(screen.getByText("sources.importFolder"))
    await waitFor(() => expect(mocks.importSourceFolder).toHaveBeenCalled())
    expect(mocks.dialogOpen).toHaveBeenCalledWith(expect.objectContaining({ directory: true }))
    await waitFor(() => expect(screen.queryByText("sources.importFolder")).toBeNull())
  })

  it("Tauri：导入文件夹对话框返回非字符串时直接返回", async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.dialogOpen.mockResolvedValue(["/tmp/a", "/tmp/b"])
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    fireEvent.click(screen.getByRole("button", { name: "novel.sources.import" }))
    fireEvent.click(screen.getByText("sources.importFolder"))
    await act(async () => {})
    expect(mocks.importSourceFolder).not.toHaveBeenCalled()
  })

  it("导入注册任务：taskIdsByPath 为空且无 importedPaths 时直接返回", async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.dialogOpen.mockResolvedValue("/tmp/plain.md")
    mocks.importSourceFiles.mockResolvedValue({ importedPaths: [], taskIdsByPath: {} })
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    fireEvent.click(screen.getByRole("button", { name: "novel.sources.import" }))
    fireEvent.click(screen.getByText("sources.importFiles"))
    await waitFor(() => expect(mocks.importSourceFiles).toHaveBeenCalled())
  })

  it("导入注册任务：有 importedPaths 时先清空已提取标记再注册", async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.dialogOpen.mockResolvedValue("/tmp/one.md")
    mocks.importSourceFiles.mockResolvedValue({
      importedPaths: ["/p/raw/sources/one.md"],
      taskIdsByPath: { "/p/raw/sources/one.md": ["t-9"] },
    })
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    fireEvent.click(screen.getByRole("button", { name: "novel.sources.import" }))
    fireEvent.click(screen.getByText("sources.importFiles"))
    await waitFor(() => expect(mocks.importSourceFiles).toHaveBeenCalled())
  })

  it("导入菜单：外部 mousedown / Escape 关闭，菜单内点击不关闭", async () => {
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    fireEvent.click(screen.getByRole("button", { name: "novel.sources.import" }))
    expect(screen.getByText("sources.importFiles")).toBeTruthy()

    // 菜单内 pointerdown → 保持打开
    fireEvent.mouseDown(screen.getByText("sources.importFiles"))
    expect(screen.getByText("sources.importFiles")).toBeTruthy()

    // 外部 pointerdown → 关闭
    fireEvent.mouseDown(document.body)
    expect(screen.queryByText("sources.importFiles")).toBeNull()

    // 重新打开后 Escape 关闭
    fireEvent.click(screen.getByRole("button", { name: "novel.sources.import" }))
    expect(screen.getByText("sources.importFiles")).toBeTruthy()
    fireEvent.keyDown(document, { key: "a" })
    expect(screen.getByText("sources.importFiles")).toBeTruthy()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByText("sources.importFiles")).toBeNull()
  })

  it("导入菜单：非 Node 目标 pointerdown 被忽略", async () => {
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    fireEvent.click(screen.getByRole("button", { name: "novel.sources.import" }))
    const evt = new MouseEvent("mousedown")
    Object.defineProperty(evt, "target", { value: {} })
    act(() => {
      document.dispatchEvent(evt)
    })
    // 非 Node 目标直接 return，菜单保持打开
    expect(screen.getByText("sources.importFiles")).toBeTruthy()
  })
})

describe("SourceSidebar — 空白右键创建菜单 / 文件菜单", () => {
  it("空白区域右键打开创建菜单，点击新建大纲/文件夹回调 onRequestCreate", async () => {
    const onRequestCreate = vi.fn()
    const { container } = render(<SourceSidebar onRequestCreate={onRequestCreate} />)
    await screen.findByText("alpha.md")
    const root = container.querySelector(".relative.flex.h-full.flex-col") as HTMLElement
    fireEvent.contextMenu(root)
    expect(screen.getByText("sidebar.newOutline")).toBeTruthy()
    expect(screen.getByText("sidebar.newFolder")).toBeTruthy()

    fireEvent.click(screen.getByText("sidebar.newOutline"))
    expect(onRequestCreate).toHaveBeenCalledWith({ kind: "outline" })
    expect(screen.queryByText("sidebar.newOutline")).toBeNull()

    fireEvent.contextMenu(root)
    fireEvent.click(screen.getByText("sidebar.newFolder"))
    expect(onRequestCreate).toHaveBeenCalledWith({ kind: "folder" })
  })

  it("交互元素上右键不打开创建菜单", async () => {
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    fireEvent.contextMenu(screen.getByText("alpha.md"))
    expect(screen.queryByText("sidebar.newOutline")).toBeNull()
  })

  it("文本节点上的右键被忽略（target 非 HTMLElement）", async () => {
    render(<SourceSidebar />)
    await screen.findByText("notes")
    // 事件 target 是文本节点（非 HTMLElement）→ handleBlankContextMenu 直接返回
    const textNode = screen.getByText("notes").firstChild as Node
    const evt = new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
    act(() => {
      textNode.dispatchEvent(evt)
    })
    expect(screen.queryByText("sidebar.newOutline")).toBeNull()
  })

  it("文件夹行（交互元素）上右键不打开创建菜单", async () => {
    render(<SourceSidebar />)
    await screen.findByText("notes")
    fireEvent.contextMenu(screen.getByText("notes"))
    expect(screen.queryByText("sidebar.newOutline")).toBeNull()
    expect(screen.queryByText("knowledgeTree.rename")).toBeNull()
  })

  it("创建菜单/文件菜单可通过文档 mousedown 与键盘关闭", async () => {
    const { container } = render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    const root = container.querySelector(".relative.flex.h-full.flex-col") as HTMLElement
    fireEvent.contextMenu(root)
    expect(screen.getByText("sidebar.newOutline")).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByText("sidebar.newOutline")).toBeNull()

    fireEvent.contextMenu(root)
    expect(screen.getByText("sidebar.newOutline")).toBeTruthy()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByText("sidebar.newOutline")).toBeNull()
  })

  it("点击容器空白区域关闭菜单", async () => {
    const { container } = render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    const root = container.querySelector(".relative.flex.h-full.flex-col") as HTMLElement
    fireEvent.contextMenu(root)
    expect(screen.getByText("sidebar.newOutline")).toBeTruthy()
    fireEvent.click(root)
    expect(screen.queryByText("sidebar.newOutline")).toBeNull()
  })

  it("文件右键打开文件菜单，重命名按钮对文件进入重命名态", async () => {
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    fireEvent.contextMenu(screen.getByText("alpha.md"))
    expect(screen.getByText("knowledgeTree.rename")).toBeTruthy()
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
    const input = document.querySelector("input[type='text']") as HTMLInputElement
    expect(input).not.toBeNull()
  })

  it("文件菜单重命名对目录目标 / 失效目标仅关闭菜单", async () => {
    const { rerender } = render(<SourceSidebar onRequestCreate={() => {}} />)
    await screen.findByText("alpha.md")

    // 场景 1：菜单打开后 alpha.md 被同名目录替换 → node.is_dir → 仅关闭菜单
    // 注意：替换后的树必须保留 notes 文件夹（含 inner.md），否则场景 2 无法再次打开 inner.md 的菜单
    fireEvent.contextMenu(screen.getByText("alpha.md"))
    mocks.listDirectory.mockResolvedValue([
      { name: "alpha.md", path: "/p/raw/sources/alpha.md", is_dir: true, children: [fileB] },
      licenseFile,
      folder,
    ])
    mocks.state.dataVersion = 1
    rerender(<SourceSidebar />)
    await act(async () => {})
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
    expect(screen.queryByText("knowledgeTree.rename")).toBeNull()
    expect(document.querySelector("input[type='text']")).toBeNull()

    // 场景 2：菜单在嵌套文件 inner.md 上打开，随后 inner.md 从树中消失 →
    // findNodeByPath 递归未命中（match=null）→ 仅关闭菜单
    fireEvent.contextMenu(screen.getByText("inner.md"))
    expect(screen.getByText("knowledgeTree.rename")).toBeTruthy()
    mocks.listDirectory.mockResolvedValue([
      fileA,
      fileB,
      { name: "notes", path: "/p/raw/sources/notes", is_dir: true, children: [] },
    ])
    mocks.state.dataVersion = 2
    rerender(<SourceSidebar />)
    await act(async () => {})
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
    expect(screen.queryByText("knowledgeTree.rename")).toBeNull()
    expect(document.querySelector("input[type='text']")).toBeNull()
  })
})

describe("SourceSidebar — 重命名", () => {
  async function startRename(): Promise<HTMLInputElement> {
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    fireEvent.contextMenu(screen.getByText("alpha.md"))
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
    const input = document.querySelector("input[type='text']") as HTMLInputElement
    expect(input).not.toBeNull()
    return input
  }

  it("重命名成功：copy + delete + 刷新 + 更新选中", async () => {
    mocks.state.selectedFile = fileA.path
    const input = await startRename()
    fireEvent.change(input, { target: { value: "renamed" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(mocks.copyFile).toHaveBeenCalledWith(fileA.path, "/p/raw/sources/renamed.md"))
    expect(mocks.deleteFile).toHaveBeenCalledWith(fileA.path)
    expect(mocks.state.setFileTree).toHaveBeenCalled()
    expect(mocks.getState.bumpDataVersion).toHaveBeenCalled()
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("/p/raw/sources/renamed.md")
    await waitFor(() => expect(document.querySelector("input[type='text']")).toBeNull())
  })

  it("重命名冲突时自动追加 -2 序号", async () => {
    mocks.fileExists.mockImplementation((path: string) => Promise.resolve(path === "/p/raw/sources/renamed.md"))
    const input = await startRename()
    fireEvent.change(input, { target: { value: "renamed" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(mocks.copyFile).toHaveBeenCalledWith(fileA.path, "/p/raw/sources/renamed-2.md"),
    )
  })

  it("重命名为相同路径时取消重命名", async () => {
    const input = await startRename()
    fireEvent.change(input, { target: { value: "alpha" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(document.querySelector("input[type='text']")).toBeNull())
    expect(mocks.copyFile).not.toHaveBeenCalled()
  })

  it("空名称（仅空白）提交时取消重命名", async () => {
    const input = await startRename()
    fireEvent.change(input, { target: { value: "   " } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(document.querySelector("input[type='text']")).toBeNull())
    expect(mocks.copyFile).not.toHaveBeenCalled()
  })

  it("Escape 取消重命名", async () => {
    const input = await startRename()
    fireEvent.keyDown(input, { key: "Escape" })
    await waitFor(() => expect(document.querySelector("input[type='text']")).toBeNull())
    expect(mocks.copyFile).not.toHaveBeenCalled()
  })

  it("输入框 onBlur 提交重命名", async () => {
    const input = await startRename()
    fireEvent.change(input, { target: { value: "blur-name" } })
    fireEvent.blur(input)
    await waitFor(() => expect(mocks.copyFile).toHaveBeenCalled())
    await waitFor(() => expect(document.querySelector("input[type='text']")).toBeNull())
  })

  it("输入框上的 mousedown/click/focus 阻止冒泡，其他按键无分支", async () => {
    const input = await startRename()
    fireEvent.mouseDown(input)
    fireEvent.click(input)
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: "x" })
    expect(mocks.state.setSelectedFile).not.toHaveBeenCalled()
    expect(mocks.copyFile).not.toHaveBeenCalled()
  })

  it("重命名失败时 alert + console.error 并复位状态", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.copyFile.mockRejectedValue(new Error("copy-fail"))
    const input = await startRename()
    fireEvent.change(input, { target: { value: "renamed" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining("重命名失败")))
    expect(errorSpy).toHaveBeenCalled()
    await waitFor(() => expect(document.querySelector("input[type='text']")).toBeNull())
    alertSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it("无扩展名文件重命名时不追加扩展名", async () => {
    render(<SourceSidebar />)
    await screen.findByText("LICENSE")
    fireEvent.contextMenu(screen.getByText("LICENSE"))
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
    const input = document.querySelector("input[type='text']") as HTMLInputElement
    fireEvent.change(input, { target: { value: "renamed" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(mocks.copyFile).toHaveBeenCalledWith("/p/raw/sources/LICENSE", "/p/raw/sources/renamed"),
    )
  })

  it("重命名嵌套文件夹内文件（findNodeByPath 递归命中）", async () => {
    render(<SourceSidebar />)
    await screen.findByText("inner.md")
    fireEvent.contextMenu(screen.getByText("inner.md"))
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
    const input = document.querySelector("input[type='text']") as HTMLInputElement
    fireEvent.change(input, { target: { value: "renamed" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(mocks.copyFile).toHaveBeenCalledWith(
        "/p/raw/sources/notes/inner.md",
        "/p/raw/sources/notes/renamed.md",
      ),
    )
  })

  it("重命名进行中再次提交被忽略（renamingBusy 守卫）", async () => {
    let resolveCopy: (v: undefined) => void = () => {}
    mocks.copyFile.mockImplementation(() => new Promise((resolve) => { resolveCopy = resolve }))
    const input = await startRename()
    fireEvent.change(input, { target: { value: "renamed" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await act(async () => {})
    // busy 状态下 Escape → cancelRename 的 renamingBusy 守卫返回
    fireEvent.keyDown(input, { key: "Escape" })
    // busy 状态下 blur → onSubmitRename → renamingBusy 守卫返回
    fireEvent.blur(input)
    await act(async () => {
      resolveCopy(undefined)
    })
    await act(async () => {})
    expect(mocks.deleteFile).toHaveBeenCalledTimes(1)
  })
})

describe("SourceSidebar — W4E5 补全（冲突循环/非 HTMLElement/rect-null/null 选中/菜单 mousedown）", () => {
  it("重命名带扩展名双重冲突：renamed.md 与 renamed-2.md 都存在 → 追加到 -3", async () => {
    mocks.fileExists.mockImplementation(
      (path: string) =>
        Promise.resolve(
          path === "/p/raw/sources/renamed.md" || path === "/p/raw/sources/renamed-2.md",
        ),
    )
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    fireEvent.contextMenu(screen.getByText("alpha.md"))
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
    const input = document.querySelector("input[type='text']") as HTMLInputElement
    fireEvent.change(input, { target: { value: "renamed" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(mocks.copyFile).toHaveBeenCalledWith(fileA.path, "/p/raw/sources/renamed-3.md"),
    )
  })

  it("无扩展名重命名冲突：candidateName 直接作为 stem（extension 假分支）且双重冲突递增", async () => {
    mocks.fileExists.mockImplementation(
      (path: string) =>
        Promise.resolve(path === "/p/raw/sources/renamed" || path === "/p/raw/sources/renamed-2"),
    )
    render(<SourceSidebar />)
    await screen.findByText("LICENSE")
    fireEvent.contextMenu(screen.getByText("LICENSE"))
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
    const input = document.querySelector("input[type='text']") as HTMLInputElement
    fireEvent.change(input, { target: { value: "renamed" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(mocks.copyFile).toHaveBeenCalledWith(
        "/p/raw/sources/LICENSE",
        "/p/raw/sources/renamed-3",
      ),
    )
  })

  it("非 HTMLElement target（SVG 元素）右键：handleBlankContextMenu 守卫返回", () => {
    const { container } = render(<SourceSidebar onRequestCreate={vi.fn()} />)
    const root = container.querySelector(".relative.flex.h-full.flex-col") as HTMLElement
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    root.appendChild(svg)
    fireEvent.contextMenu(svg)
    expect(screen.queryByText("sidebar.newOutline")).toBeNull()
  })

  it("创建菜单内 mousedown 不关闭（stopPropagation）", () => {
    const { container } = render(<SourceSidebar onRequestCreate={vi.fn()} />)
    const root = container.querySelector(".relative.flex.h-full.flex-col") as HTMLElement
    fireEvent.contextMenu(root)
    const menu = screen.getByText("sidebar.newOutline").closest("div") as HTMLElement
    fireEvent.mouseDown(menu)
    expect(screen.getByText("sidebar.newOutline")).toBeTruthy()
  })

  it("文件菜单内 mousedown 不关闭（stopPropagation）", async () => {
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    fireEvent.contextMenu(screen.getByText("alpha.md"))
    const menu = screen.getByText("knowledgeTree.rename").closest("div") as HTMLElement
    fireEvent.mouseDown(menu)
    expect(screen.getByText("knowledgeTree.rename")).toBeTruthy()
  })

  it("getBoundingClientRect 为 null：空白右键菜单坐标回退到 event.clientX/Y", () => {
    const rectSpy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue(null as unknown as DOMRect)
    const { container } = render(<SourceSidebar onRequestCreate={vi.fn()} />)
    const root = container.querySelector(".relative.flex.h-full.flex-col") as HTMLElement
    fireEvent.contextMenu(root)
    const menu = screen.getByText("sidebar.newOutline").closest("div") as HTMLElement
    expect(menu.style.left).toBe("0px")
    rectSpy.mockRestore()
  })

  it("getBoundingClientRect 为 null：文件右键菜单坐标回退到 event.clientX/Y", async () => {
    const rectSpy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue(null as unknown as DOMRect)
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    fireEvent.contextMenu(screen.getByText("alpha.md"))
    const menu = screen.getByText("knowledgeTree.rename").closest("div") as HTMLElement
    expect(menu.style.left).toBe("0px")
    rectSpy.mockRestore()
  })

  it("删除文件时 selectedFile 为 null：deletedWikiPaths.includes(\"\") 不重置", async () => {
    mocks.state.selectedFile = null
    render(<SourceSidebar />)
    await screen.findByText("alpha.md")
    const row = fileRow("alpha.md")
    fireEvent.click(within(row).getByTitle("sources.deleteFile"))
    fireEvent.click(within(row).getByTitle("sources.deleteFileConfirm"))
    await waitFor(() => expect(mocks.deleteSourceFile).toHaveBeenCalled())
    expect(mocks.state.setSelectedFile).not.toHaveBeenCalled()
  })

  it("删除文件夹时 selectedFile 为 null：不重置选中", async () => {
    mocks.state.selectedFile = null
    render(<SourceSidebar />)
    await screen.findByText("notes")
    const row = fileRow("notes")
    fireEvent.click(within(row).getByTitle("sources.deleteFolder"))
    fireEvent.click(within(row).getByTitle("sources.deleteFolderConfirm"))
    await waitFor(() => expect(mocks.deleteSourceFolder).toHaveBeenCalled())
    expect(mocks.state.setSelectedFile).not.toHaveBeenCalled()
  })
})
