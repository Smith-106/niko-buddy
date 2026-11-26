// @vitest-environment jsdom
/**
 * W4 coverage campaign — KnowledgeTree / RawSourcesSection 全口径 100%。
 * 所有 store / 外部依赖均 vi.mock（vi.hoisted 可写 state 模式，参考 src/App.spec.tsx）。
 * 断言对照 src/components/layout/knowledge-tree.tsx 的实现分支。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup as rtlCleanup } from "@testing-library/react"
import { render, screen, fireEvent, act, waitFor, within, setupDomGlobals } from "@/test-helpers/component-test-utils"
import type { FileNode, WikiProject } from "@/types/wiki"

type Mock = ReturnType<typeof vi.fn>

interface WikiStateShape {
  project: WikiProject | null
  fileTree: FileNode[]
  selectedFile: string | null
  dataVersion: number
  setSelectedFile: Mock
  setFileTree: Mock
  bumpDataVersion: Mock
  clearFinalChapterSaveForPath: Mock
}

interface ImportTaskShape {
  id: string
  projectPath: string
  kind: string
  status: string
  completed: number
  total: number
  currentTitle: string
  message?: string
  cancelling: boolean
  createdAt: number
  updatedAt: number
}

const mocks = vi.hoisted(() => {
  const wikiState: WikiStateShape = {
    project: null,
    fileTree: [],
    selectedFile: null,
    dataVersion: 0,
    setSelectedFile: vi.fn(),
    setFileTree: vi.fn(),
    bumpDataVersion: vi.fn(),
    clearFinalChapterSaveForPath: vi.fn(),
  }
  const importState = {
    tasks: [] as ImportTaskShape[],
    cancelTask: vi.fn(),
  }
  return {
    t: vi.fn((key: string, opts?: Record<string, unknown>) => {
      const base = lookupZhLocale(key) ?? key
      return opts ? `${base}::${JSON.stringify(opts)}` : base
    }),
    wikiState,
    importState,
    readFile: vi.fn(),
    writeFileAtomic: vi.fn(),
    listDirectory: vi.fn(),
    deleteFile: vi.fn(),
    fileExists: vi.fn(),
    copyFile: vi.fn(),
    openFileLocation: vi.fn(),
    moveFileToTrash: vi.fn(),
    deleteNovelSourceMemory: vi.fn(),
    confirm: vi.fn<(message?: string) => boolean>(() => true),
    readBatchQueue: vi.fn((): BatchExtractQueueState | null => null),
    restoreBatchQueue: vi.fn<() => Promise<BatchExtractQueueState | null>>(async () => null),
    discardBatch: vi.fn(async (): Promise<boolean> => false),
    resetCorruptBatch: vi.fn(async (): Promise<string> => "/proj/.novel/backup.json"),
    setAsideBatch: vi.fn(async (): Promise<boolean> => true),
    scanBackfill: vi.fn(),
    runBatch: vi.fn(),
    acceptBatch: vi.fn(),
    alert: vi.fn<(message?: string) => void>(() => {}),
    toastError: vi.fn<(message?: string) => void>(() => {}),
    toastInfo: vi.fn<(message?: string) => void>(() => {}),
  }
})

vi.mock("@/lib/toast", () => ({
  toast: { error: mocks.toastError, info: mocks.toastInfo, success: vi.fn() },
}))

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/i18n")>()
  return {
    ...actual,
      default: { t: mocks.t },
    
  }
})

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
      useWikiStore: Object.assign(
        (selector: (s: unknown) => unknown) => selector(mocks.wikiState),
        { getState: () => mocks.wikiState },
      ),
    
  }
})

vi.mock("./sidebar-panel-import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sidebar-panel-import")>()
  return {
    ...actual,
    getBatchExtractQueue: mocks.readBatchQueue,
    restoreBatchExtractQueue: () => mocks.restoreBatchQueue(),
    discardBatchExtractionDrafts: mocks.discardBatch,
    resetCorruptBatchExtractionDrafts: mocks.resetCorruptBatch,
    setAsideUncertainBatchDrafts: mocks.setAsideBatch,
    runBatchMemoryExtraction: mocks.runBatch,
    acceptBatchExtractionDrafts: mocks.acceptBatch,
  }
})

vi.mock("@/lib/novel/snapshot-scanner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/snapshot-scanner")>()
  return { ...actual, scanFinalChapterBackfill: (...args: Parameters<typeof actual.scanFinalChapterBackfill>) => mocks.scanBackfill(...args) }
})

vi.mock("@/stores/import-progress-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/import-progress-store")>()
  return {
    ...actual,
      useImportProgressStore: Object.assign(
        (selector: (s: unknown) => unknown) => selector(mocks.importState),
        { getState: () => mocks.importState },
      ),
    
  }
})

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      readFile: mocks.readFile,
      writeFileAtomic: mocks.writeFileAtomic,
      listDirectory: mocks.listDirectory,
      deleteFile: mocks.deleteFile,
      fileExists: mocks.fileExists,
      copyFile: mocks.copyFile,
      openFileLocation: mocks.openFileLocation,
    
  }
})

vi.mock("@/lib/trash", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/trash")>()
  return {
    ...actual,
      moveFileToTrash: mocks.moveFileToTrash,
    
  }
})

vi.mock("@/lib/novel/delete-source-memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/delete-source-memory")>()
  return {
    ...actual,
      deleteNovelSourceMemory: mocks.deleteNovelSourceMemory,
    
  }
})

import { KnowledgeTree, RawSourcesSection, BatchExtractScopeDialog } from "./knowledge-tree"
import { getChapterWriteCoordinator, resetChapterWriteCoordinatorForTests } from "./knowledge-tree-helpers"
import { CorruptBatchDraftArtifactError, type BatchExtractQueueState } from "@/lib/novel/snapshot-scanner"
import zhLocale from "@/i18n/zh.json"

function lookupZhLocale(key: string): string | undefined {
  let o: unknown = zhLocale
  for (const p of key.split(".")) {
    if (o == null || typeof o !== "object") return undefined
    o = (o as Record<string, unknown>)[p]
  }
  return typeof o === "string" ? o : undefined
}

// ── fixtures ────────────────────────────────────────────────────────────────

const PROJ = "/proj"
const CHAPTERS = `${PROJ}/wiki/chapters`
const OUTLINES = `${PROJ}/wiki/outlines`

function fileNode(name: string, path: string): FileNode {
  return { name, path, is_dir: false }
}
function dirNode(name: string, path: string, children: FileNode[] = []): FileNode {
  return { name, path, is_dir: true, children }
}

const CONTENTS: Record<string, string> = {
  [`${CHAPTERS}/卷1/第一章-开端.md`]: [
    "---",
    'title: "序章-开端"',
    'tags: ["主线", "导入"]',
    "origin: web-clip",
    "chapter_status: final",
    "chapter_number: 1",
    "---",
    "# 序章-开端",
    "开端正文内容",
  ].join("\n"),
  [`${CHAPTERS}/第二章-进展.md`]: "# 第二章-进展\n进展正文",
  [`${CHAPTERS}/第三章-高潮.md`]: "---\nchapter_status: draft\n---\n# 第三章-高潮\n高潮正文",
  [`${CHAPTERS}/第10章-终章.md`]: "---\nchapter_number: 0\n---\n# 第10章-终章\n终章正文",
  [`${CHAPTERS}/序章-引子.md`]: "# 序章-引子\n引子正文",
  [`${CHAPTERS}/随笔.md`]: "# 随笔\n内容",
  [`${CHAPTERS}/第7章-裸标题.md`]: [
    "---",
    "type: chapter",
    "chapter_number: '7'",
    "chapter_status: draft",
    "title: 第7章",
    "source: autonomous-campaign",
    "---",
    "# 第7章",
    "",
    "# 第7章 律师说没漏洞",
    "",
    "正文内容",
  ].join("\n"),
  [`${OUTLINES}/全书大纲.md`]: "---\ntitle: 全书大纲\ntags: [结构, 卷]\norigin: manual\n---\n# 全书大纲\n内容",
  [`${OUTLINES}/分卷大纲-2.md`]: "---\ntitle: 分卷大纲二\n---\n内容",
  [`${OUTLINES}/分卷大纲-2-3.md`]: "# 分卷大纲 2 3\n内容",
  [`${OUTLINES}/分卷A/分卷A-甲.md`]: "# 分卷A-甲\n内容",
  [`${PROJ}/wiki/sources/素材.md`]: "# 素材\n内容",
}

function defaultWikiTree(): FileNode[] {
  return [
    dirNode("chapters", CHAPTERS, [
      dirNode("卷1", `${CHAPTERS}/卷1`, [fileNode("第一章-开端.md", `${CHAPTERS}/卷1/第一章-开端.md`)]),
      fileNode("第二章-进展.md", `${CHAPTERS}/第二章-进展.md`),
      fileNode("第三章-高潮.md", `${CHAPTERS}/第三章-高潮.md`),
      fileNode("第10章-终章.md", `${CHAPTERS}/第10章-终章.md`),
      fileNode("序章-引子.md", `${CHAPTERS}/序章-引子.md`),
      fileNode("随笔.md", `${CHAPTERS}/随笔.md`),
      fileNode("notes.txt", `${CHAPTERS}/notes.txt`),
    ]),
    dirNode("outlines", OUTLINES, [
      dirNode("分卷A", `${OUTLINES}/分卷A`, [fileNode("分卷A-甲.md", `${OUTLINES}/分卷A/分卷A-甲.md`)]),
      dirNode("空文件夹", `${OUTLINES}/空文件夹`),
      fileNode("全书大纲.md", `${OUTLINES}/全书大纲.md`),
      fileNode("分卷大纲-2.md", `${OUTLINES}/分卷大纲-2.md`),
      fileNode("分卷大纲-2-3.md", `${OUTLINES}/分卷大纲-2-3.md`),
      fileNode("坏文件.md", `${OUTLINES}/坏文件.md`),
    ]),
    dirNode("sources", `${PROJ}/wiki/sources`, [fileNode("素材.md", `${PROJ}/wiki/sources/素材.md`)]),
    fileNode("index.md", `${PROJ}/wiki/index.md`),
    fileNode("log.md", `${PROJ}/wiki/log.md`),
  ]
}

function defaultFileTree(): FileNode[] {
  return [dirNode("wiki", `${PROJ}/wiki`, defaultWikiTree())]
}

function makeTask(overrides: Partial<ImportTaskShape> = {}): ImportTaskShape {
  return {
    id: "t1",
    projectPath: PROJ,
    kind: "outline",
    status: "running",
    completed: 1,
    total: 2,
    currentTitle: "",
    cancelling: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function renderTree(
  props: {
    filterType?: "chapter" | "outline"
    refreshKey?: number
    pendingPages?: Array<{ path: string; title: string; type: "chapter" | "outline"; tags: string[] }>
    onRequestCreate?: (request: unknown) => void
    onRemovePendingPage?: (pagePath: string) => void
  } = {},
) {
  return render(<KnowledgeTree filterType="chapter" {...props} />)
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function pageRow(container: HTMLElement, path: string): HTMLElement {
  const row = container.querySelector(`[data-page-path="${path}"]`)
  if (!(row instanceof HTMLElement)) throw new Error(`row not found: ${path}`)
  return row
}

function setElementFromPoint(el: Element | Text | null): void {
  ;(document as unknown as { elementFromPoint: Mock }).elementFromPoint = vi.fn(() => el) as never
}

beforeEach(() => {
  vi.clearAllMocks()
  resetChapterWriteCoordinatorForTests()
  setupDomGlobals()
  mocks.t.mockImplementation((key: string, opts?: Record<string, unknown>) => {
    const base = lookupZhLocale(key) ?? key
    return opts ? `${base}::${JSON.stringify(opts)}` : base
  })
  mocks.wikiState.project = { id: "p1", name: "MyBook", path: PROJ }
  mocks.wikiState.fileTree = defaultFileTree()
  mocks.wikiState.selectedFile = null
  mocks.wikiState.dataVersion = 0
  mocks.importState.tasks = []
  mocks.confirm.mockReturnValue(true)
  vi.spyOn(window, "confirm").mockImplementation((message?: string) => mocks.confirm(message) as never)
  vi.spyOn(window, "alert").mockImplementation((message?: string) => mocks.alert(message) as never)
  // base-ui ScrollArea viewport 的 useTimeout 会调用 getAnimations（jsdom 未实现）
  ;(Element.prototype as unknown as { getAnimations?: () => unknown[] }).getAnimations = () => []
  mocks.readFile.mockImplementation(async (p: string) => {
    if (p === `${OUTLINES}/坏文件.md`) throw new Error("unreadable")
    return CONTENTS[p] ?? ""
  })
  mocks.listDirectory.mockImplementation(async (p: string) => {
    if (p === `${PROJ}/wiki`) return defaultWikiTree()
    if (p === PROJ) return defaultFileTree()
    return []
  })
  mocks.fileExists.mockResolvedValue(false)
  mocks.writeFileAtomic.mockResolvedValue(undefined)
  mocks.deleteFile.mockResolvedValue(undefined)
  mocks.copyFile.mockResolvedValue(undefined)
  mocks.moveFileToTrash.mockResolvedValue({ id: "trash-1", name: "x", originalPath: "x", trashPath: "x", deletedAt: 0, expiresAt: 0, kind: "chapter" })
  mocks.deleteNovelSourceMemory.mockResolvedValue(undefined)
  mocks.openFileLocation.mockResolvedValue(undefined)
  mocks.wikiState.setSelectedFile.mockImplementation((p: string | null) => { mocks.wikiState.selectedFile = p })
  mocks.wikiState.setFileTree.mockImplementation((t: FileNode[]) => { mocks.wikiState.fileTree = t })
  mocks.wikiState.bumpDataVersion.mockImplementation(() => { mocks.wikiState.dataVersion += 1 })
  setElementFromPoint(null)
})

afterEach(() => {
  rtlCleanup()
  vi.restoreAllMocks()
})

// ── KnowledgeTree ───────────────────────────────────────────────────────────

describe("KnowledgeTree", () => {
  it("无项目时渲染 noProject 提示且不加载目录", async () => {
    mocks.wikiState.project = null
    const view = renderTree()
    await waitFor(() => expect(screen.getByText("未打开项目")).toBeInTheDocument())
    expect(mocks.listDirectory).not.toHaveBeenCalled()
    view.unmount()
  })

  it("空文件树显示空态提示（chapter/outline 两个变体）", async () => {
    mocks.wikiState.fileTree = []
    const view = renderTree()
    await waitFor(() => expect(screen.getByText('暂无{{label}}，点击 + 创建::{"label":"章节"}')).toBeInTheDocument())
    expect(screen.getByText("章节")).toBeInTheDocument()
    view.unmount()

    mocks.wikiState.fileTree = []
    const view2 = render(<KnowledgeTree filterType="outline" />)
    await waitFor(() => expect(screen.getByText('暂无{{label}}，点击 + 创建::{"label":"大纲"}')).toBeInTheDocument())
    expect(screen.getByText("大纲")).toBeInTheDocument()
    view2.unmount()
  })

  it("chapter 文件树渲染：卷/页/字数/来源图标/排序/非 md 过滤", async () => {
    const view = renderTree()
    await screen.findByText("第二章-进展")
    expect(screen.getByText("章节")).toBeInTheDocument()
    // 文件夹与计数
    expect(screen.getByText("卷1")).toBeInTheDocument()
    // frontmatter 标题 / heading 标题 / 回退标题
    expect(screen.getByText("序章-开端")).toBeInTheDocument()
    expect(screen.getByText("第二章-进展")).toBeInTheDocument()
    expect(screen.getByText("第三章-高潮")).toBeInTheDocument()
    expect(screen.getByText("第10章-终章")).toBeInTheDocument()
    expect(screen.getByText("序章-引子")).toBeInTheDocument()
    expect(screen.getByText("随笔")).toBeInTheDocument()
    // 字数标签（chapter wordCountLabel）
    expect(within(pageRow(view.container, `${CHAPTERS}/卷1/第一章-开端.md`)).getByText("6字")).toBeInTheDocument()
    expect(within(pageRow(view.container, `${CHAPTERS}/随笔.md`)).getByText("2字")).toBeInTheDocument()
    // web-clip 来源图标
    expect(view.container.querySelector("svg.lucide-globe")).not.toBeNull()
    // 非 md 与 index/log 不渲染
    expect(screen.queryByText("notes.txt")).not.toBeInTheDocument()
    expect(screen.queryByText("index.md")).not.toBeInTheDocument()
    // 排序：文件夹在前、章号升序、无号靠后
    const paths = [...view.container.querySelectorAll("[data-page-path]")].map((el) => el.getAttribute("data-page-path"))
    expect(paths).toEqual([
      `${CHAPTERS}/卷1/第一章-开端.md`,
      `${CHAPTERS}/第二章-进展.md`,
      `${CHAPTERS}/第三章-高潮.md`,
      `${CHAPTERS}/第10章-终章.md`,
      `${CHAPTERS}/随笔.md`,
      `${CHAPTERS}/序章-引子.md`,
    ])
    view.unmount()
  })

  it("裸 frontmatter 标题（第N章）+ 正文富 H1 → 目录显示章节名（TOC 升级不降级）", async () => {
    const wiki = [
      dirNode("chapters", CHAPTERS, [fileNode("第7章-裸标题.md", `${CHAPTERS}/第7章-裸标题.md`)]),
      dirNode("outlines", OUTLINES, []),
      fileNode("index.md", `${PROJ}/wiki/index.md`),
      fileNode("log.md", `${PROJ}/wiki/log.md`),
    ]
    mocks.listDirectory.mockImplementation(async (p: string) => {
      if (p === `${PROJ}/wiki`) return wiki
      if (p === PROJ) return [dirNode("wiki", `${PROJ}/wiki`, wiki)]
      return []
    })
    mocks.wikiState.fileTree = [dirNode("wiki", `${PROJ}/wiki`, wiki)]
    const view = renderTree()
    await screen.findByText("第7章 律师说没漏洞")
    expect(
      within(pageRow(view.container, `${CHAPTERS}/第7章-裸标题.md`)).getByText("第7章 律师说没漏洞"),
    ).toBeInTheDocument()
    view.unmount()
  })

  it("outline 文件树渲染：文件夹在前、回退标题（读取失败页）、无字数标签", async () => {
    const view = render(<KnowledgeTree filterType="outline" />)
    await screen.findByText("全书大纲")
    expect(screen.getByText("大纲")).toBeInTheDocument()
    expect(screen.getByText("分卷A")).toBeInTheDocument()
    // 分卷A-甲 含连字符：真实标题仅异步 loadPages 完成后存在（回退标题会替换为空格）
    expect(await screen.findByText("分卷A-甲")).toBeInTheDocument()
    expect(screen.getByText("空文件夹")).toBeInTheDocument()
    expect(screen.getByText("分卷大纲二")).toBeInTheDocument()
    expect(screen.getByText("分卷大纲 2 3")).toBeInTheDocument()
    // 读取失败页 → 回退标题（pageInfoByPath 缺失时的 fallback 对象）
    expect(screen.getByText("坏文件")).toBeInTheDocument()
    // 文件夹先于文件（分卷A-甲 是第一个页面行）
    const paths = [...view.container.querySelectorAll("[data-page-path]")].map((el) => el.getAttribute("data-page-path"))
    expect(paths[0]).toBe(`${OUTLINES}/分卷A/分卷A-甲.md`)
    // outline 无字数标签
    expect(screen.queryByText(/字$/)).not.toBeInTheDocument()
    view.unmount()
  })

  it("点击页面触发 setSelectedFile 并显示选中态", async () => {
    const view = renderTree()
    await screen.findByText("第二章-进展")
    fireEvent.click(screen.getByText("第二章-进展"))
    expect(mocks.wikiState.setSelectedFile).toHaveBeenCalledWith(`${CHAPTERS}/第二章-进展.md`)
    view.rerender(<KnowledgeTree filterType="chapter" />)
    expect(pageRow(view.container, `${CHAPTERS}/第二章-进展.md`).className).toContain("qm-selected")
    view.unmount()
  })

  it("文件夹展开/折叠切换与 aria-expanded 同步", async () => {
    const view = renderTree()
    await screen.findByText("序章-开端")
    const folderButton = screen.getByText("卷1").closest("button") as HTMLButtonElement
    expect(folderButton).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("序章-开端")).toBeInTheDocument()
    fireEvent.click(folderButton)
    expect(folderButton).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("序章-开端")).not.toBeInTheDocument()
    fireEvent.click(folderButton)
    expect(folderButton).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("序章-开端")).toBeInTheDocument()
    view.unmount()
  })

  it("删除：二次确认 + 回收站 + 记忆清理 + 状态刷新", async () => {
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    const row = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    fireEvent.click(within(row).getByTitle(/移入回收站/))
    expect(within(row).getByTitle(/再次点击确认/)).toBeInTheDocument()
    fireEvent.click(within(row).getByTitle(/再次点击确认/))
    expect(within(row).getByTitle(/正在移入回收站/)).toBeInTheDocument()
    await flush()
    expect(mocks.moveFileToTrash).toHaveBeenCalledWith(PROJ, `${CHAPTERS}/第三章-高潮.md`, "chapter")
    expect(mocks.deleteNovelSourceMemory).toHaveBeenCalledWith(PROJ, {
      kind: "chapter",
      pagePath: `${CHAPTERS}/第三章-高潮.md`,
      content: CONTENTS[`${CHAPTERS}/第三章-高潮.md`],
    })
    expect(mocks.wikiState.setFileTree).toHaveBeenCalled()
    expect(mocks.wikiState.bumpDataVersion).toHaveBeenCalled()
    expect(within(row).queryByTitle(/deletingTitle/)).not.toBeInTheDocument()
    view.unmount()
  })

  it("删除武装后：非 Node target 不取消、外部点击/Escape 取消", async () => {
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    const row = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    fireEvent.click(within(row).getByTitle(/移入回收站/))
    expect(within(row).getByTitle(/再次点击确认/)).toBeInTheDocument()
    // 非 Node target（守卫分支：armed 保持）
    const nonNode = new MouseEvent("mousedown", { bubbles: true })
    Object.defineProperty(nonNode, "target", { value: {} })
    act(() => document.dispatchEvent(nonNode))
    expect(within(row).getByTitle(/再次点击确认/)).toBeInTheDocument()
    // 外部 mousedown → 取消武装
    act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })))
    expect(within(row).queryByTitle(/confirmDeleteTitle/)).not.toBeInTheDocument()
    // Escape → 取消武装
    fireEvent.click(within(row).getByTitle(/移入回收站/))
    expect(within(row).getByTitle(/再次点击确认/)).toBeInTheDocument()
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    expect(within(row).queryByTitle(/confirmDeleteTitle/)).not.toBeInTheDocument()
    view.unmount()
  })

  it("删除选中的页面：setSelectedFile(null) + onRemovePendingPage；源文件读取失败被忽略", async () => {
    mocks.wikiState.selectedFile = `${CHAPTERS}/序章-引子.md`
    const onRemovePendingPage = vi.fn()
    const view = renderTree({ onRemovePendingPage })
    await screen.findByText("序章-引子")
    const row = pageRow(view.container, `${CHAPTERS}/序章-引子.md`)
    mocks.readFile.mockImplementationOnce(() => Promise.reject(new Error("read-fail")))
    fireEvent.click(within(row).getByTitle(/移入回收站/))
    fireEvent.click(within(row).getByTitle(/再次点击确认/))
    await flush()
    expect(mocks.moveFileToTrash).toHaveBeenCalledWith(PROJ, `${CHAPTERS}/序章-引子.md`, "chapter")
    expect(mocks.wikiState.setSelectedFile).toHaveBeenCalledWith(null)
    expect(onRemovePendingPage).toHaveBeenCalledWith(`${CHAPTERS}/序章-引子.md`)
    view.unmount()
  })

  it("删除失败 console.error；记忆清理失败 warn 但删除继续", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    const row = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    // 删除失败
    mocks.moveFileToTrash.mockRejectedValueOnce(new Error("trash-fail"))
    fireEvent.click(within(row).getByTitle(/移入回收站/))
    fireEvent.click(within(row).getByTitle(/再次点击确认/))
    await flush()
    expect(errSpy).toHaveBeenCalled()
    expect(within(row).queryByTitle(/deletingTitle/)).not.toBeInTheDocument()
    // 记忆清理失败 → warn，删除仍完成
    mocks.moveFileToTrash.mockResolvedValueOnce({ id: "t2", name: "x", originalPath: "x", trashPath: "x", deletedAt: 0, expiresAt: 0, kind: "chapter" })
    mocks.deleteNovelSourceMemory.mockRejectedValueOnce(new Error("mem-fail"))
    fireEvent.click(within(row).getByTitle(/移入回收站/))
    fireEvent.click(within(row).getByTitle(/再次点击确认/))
    await flush()
    expect(warnSpy).toHaveBeenCalled()
    expect(mocks.wikiState.setFileTree).toHaveBeenCalled()
    view.unmount()
  })

  it("outline 删除：不读源文件、kind=outline", async () => {
    const view = render(<KnowledgeTree filterType="outline" />)
    await screen.findByText("全书大纲")
    const row = pageRow(view.container, `${OUTLINES}/全书大纲.md`)
    mocks.readFile.mockClear()
    fireEvent.click(within(row).getByTitle(/移入回收站/))
    fireEvent.click(within(row).getByTitle(/再次点击确认/))
    await flush()
    expect(mocks.moveFileToTrash).toHaveBeenCalledWith(PROJ, `${OUTLINES}/全书大纲.md`, "outline")
    view.unmount()
  })

  it("文件夹删除：确认后逐文件回收 + 空目录删除 + onRemovePendingPage", async () => {
    const onRemovePendingPage = vi.fn()
    const view = renderTree({ onRemovePendingPage })
    await screen.findByText("序章-开端")
    fireEvent.contextMenu(screen.getByText("卷1"))
    expect(screen.getByText("删除卷")).toBeInTheDocument()
    fireEvent.click(screen.getByText("删除卷"))
    expect(mocks.confirm).toHaveBeenCalledWith('确认将「{{name}}」及其下 {{count}} 个文件移入回收站吗？::{"name":"卷1","count":1}')
    await flush()
    expect(mocks.moveFileToTrash).toHaveBeenCalledWith(PROJ, `${CHAPTERS}/卷1/第一章-开端.md`, "chapter")
    expect(mocks.deleteNovelSourceMemory).toHaveBeenCalled()
    expect(onRemovePendingPage).toHaveBeenCalledWith(`${CHAPTERS}/卷1/第一章-开端.md`)
    expect(mocks.deleteFile).toHaveBeenCalledWith(`${CHAPTERS}/卷1`)
    expect(mocks.wikiState.setFileTree).toHaveBeenCalled()
    view.unmount()
  })

  it("空文件夹删除：deleteEmptyFolderConfirm 变体", async () => {
    const view = render(<KnowledgeTree filterType="outline" />)
    await screen.findByText("空文件夹")
    fireEvent.contextMenu(screen.getByText("空文件夹"))
    fireEvent.click(screen.getByText("删除文件夹"))
    expect(mocks.confirm).toHaveBeenCalledWith('确认删除空文件夹「{{name}}」吗？::{"name":"空文件夹"}')
    await flush()
    expect(mocks.deleteFile).toHaveBeenCalledWith(`${OUTLINES}/空文件夹`)
    view.unmount()
  })

  it("文件夹删除：confirm 拒绝则中止", async () => {
    mocks.confirm.mockReturnValue(false)
    const view = renderTree()
    await screen.findByText("序章-开端")
    fireEvent.contextMenu(screen.getByText("卷1"))
    fireEvent.click(screen.getByText("删除卷"))
    await flush()
    expect(mocks.moveFileToTrash).not.toHaveBeenCalled()
    expect(mocks.deleteFile).not.toHaveBeenCalled()
    view.unmount()
  })

  it("文件夹删除：目录非空时 alert 阻止删除目录", async () => {
    mocks.listDirectory.mockImplementation(async (p: string) => {
      if (p === `${CHAPTERS}/卷1`) return [fileNode("残留.txt", `${CHAPTERS}/卷1/残留.txt`)]
      if (p === `${PROJ}/wiki`) return defaultWikiTree()
      if (p === PROJ) return defaultFileTree()
      return []
    })
    const view = renderTree()
    await screen.findByText("序章-开端")
    fireEvent.contextMenu(screen.getByText("卷1"))
    fireEvent.click(screen.getByText("删除卷"))
    await flush()
    expect(mocks.toastError).toHaveBeenCalledWith('文件夹「{{name}}」中仍有未移入回收站的其他文件，已保留文件夹本身。::{"name":"卷1"}')
    expect(mocks.deleteFile).not.toHaveBeenCalledWith(`${CHAPTERS}/卷1`)
    view.unmount()
  })

  it("文件夹删除：单文件失败 warn 继续删目录", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    // 单文件失败（moveFileToTrash reject）→ warn 后继续删目录
    mocks.moveFileToTrash.mockRejectedValueOnce(new Error("file-fail"))
    const view = renderTree()
    await screen.findByText("序章-开端")
    fireEvent.contextMenu(screen.getByText("卷1"))
    fireEvent.click(screen.getByText("删除卷"))
    await flush()
    expect(warnSpy).toHaveBeenCalled()
    expect(mocks.deleteFile).toHaveBeenCalledWith(`${CHAPTERS}/卷1`)
    view.unmount()
  })

  it("文件夹删除：folder 不存在守卫（打开菜单后从树中移除）", async () => {
    const view = renderTree()
    await screen.findByText("序章-开端")
    fireEvent.contextMenu(screen.getByText("卷1"))
    // 打开菜单后把卷1从树中移除 → findNodeByPath 失败早退
    const treeWithout = defaultFileTree()
    const chaptersNode = treeWithout[0].children?.[0]
    if (chaptersNode) chaptersNode.children = chaptersNode.children?.filter((c) => c.name !== "卷1")
    mocks.wikiState.fileTree = treeWithout
    view.rerender(<KnowledgeTree filterType="chapter" />)
    fireEvent.click(screen.getByText("删除卷"))
    await flush()
    expect(mocks.moveFileToTrash).not.toHaveBeenCalled()
    expect(mocks.deleteFile).not.toHaveBeenCalled()
    view.unmount()
  })

  it("文件夹删除：外层异常（根目录 list 失败）→ console.error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.listDirectory.mockImplementation(async (p: string) => {
      if (p === `${PROJ}/wiki`) return defaultWikiTree()
      throw new Error("root-fail")
    })
    const view = renderTree()
    await screen.findByText("序章-开端")
    fireEvent.contextMenu(screen.getByText("卷1"))
    fireEvent.click(screen.getByText("删除卷"))
    await flush()
    expect(errSpy).toHaveBeenCalled()
    view.unmount()
  })

  it("空白区右键：创建菜单（无删除项）+ 新建回调", async () => {
    const onRequestCreate = vi.fn()
    const view = renderTree({ onRequestCreate })
    await screen.findByText("第二章-进展")
    fireEvent.contextMenu(screen.getByText("章节"))
    expect(screen.getByText("新建章节")).toBeInTheDocument()
    expect(screen.getByText("新建卷")).toBeInTheDocument()
    expect(screen.queryByText("删除卷")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("新建章节"))
    expect(onRequestCreate).toHaveBeenCalledWith({ kind: "chapter", parentDir: undefined })
    expect(screen.queryByText("新建章节")).not.toBeInTheDocument()
    view.unmount()
  })

  it("页面右键菜单：新建/重命名/移动到卷/打开位置 + parentDir", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const onRequestCreate = vi.fn()
    const view = renderTree({ onRequestCreate })
    await screen.findByText("第三章-高潮")
    const row = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    fireEvent.contextMenu(row)
    expect(screen.getByText("重命名")).toBeInTheDocument()
    expect(screen.getByText("移动到卷")).toBeInTheDocument()
    expect(screen.getByText("打开文件所在位置")).toBeInTheDocument()
    fireEvent.click(screen.getByText("新建章节"))
    expect(onRequestCreate).toHaveBeenCalledWith({ kind: "chapter", parentDir: CHAPTERS })
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("新建卷"))
    expect(onRequestCreate).toHaveBeenCalledWith({ kind: "volume", parentDir: CHAPTERS })
    // 打开文件位置成功
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("打开文件所在位置"))
    expect(mocks.openFileLocation).toHaveBeenCalledWith(`${CHAPTERS}/第三章-高潮.md`)
    // 打开文件位置失败 → console.error
    mocks.openFileLocation.mockRejectedValueOnce(new Error("loc-fail"))
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("打开文件所在位置"))
    await flush()
    expect(errSpy).toHaveBeenCalled()
    view.unmount()
  })

  it("文件夹右键菜单：新建卷 parentDir 为文件夹路径", async () => {
    const onRequestCreate = vi.fn()
    const view = renderTree({ onRequestCreate })
    await screen.findByText("序章-开端")
    fireEvent.contextMenu(screen.getByText("卷1"))
    fireEvent.click(screen.getByText("新建卷"))
    expect(onRequestCreate).toHaveBeenCalledWith({ kind: "volume", parentDir: `${CHAPTERS}/卷1` })
    view.unmount()
  })

  it("outline 页面菜单：newOutline/newFolder 变体", async () => {
    const onRequestCreate = vi.fn()
    const view = render(<KnowledgeTree filterType="outline" onRequestCreate={onRequestCreate} />)
    await screen.findByText("全书大纲")
    const row = pageRow(view.container, `${OUTLINES}/全书大纲.md`)
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("新建大纲"))
    expect(onRequestCreate).toHaveBeenCalledWith({ kind: "outline", parentDir: OUTLINES })
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("新建文件夹"))
    expect(onRequestCreate).toHaveBeenCalledWith({ kind: "folder", parentDir: OUTLINES })
    view.unmount()
  })

  it("读取失败页的菜单：target 缺失时 parentDir undefined", async () => {
    const onRequestCreate = vi.fn()
    const view = render(<KnowledgeTree filterType="outline" onRequestCreate={onRequestCreate} />)
    await screen.findByText("坏文件")
    const row = pageRow(view.container, `${OUTLINES}/坏文件.md`)
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("新建大纲"))
    expect(onRequestCreate).toHaveBeenCalledWith({ kind: "outline", parentDir: undefined })
    view.unmount()
  })

  it("触摸 pointerdown 后右键被拦截（lastPointerType 非 mouse）", async () => {
    const view = renderTree()
    await screen.findByText("第二章-进展")
    const row = pageRow(view.container, `${CHAPTERS}/第二章-进展.md`)
    fireEvent.pointerDown(row, { pointerType: "touch", pointerId: 1, button: 0 })
    fireEvent.contextMenu(row)
    expect(screen.queryByText("重命名")).not.toBeInTheDocument()
    view.unmount()
  })

  it("菜单通过 document mousedown / Escape 与容器点击关闭，非 Escape 键不误关且支持键盘导航", async () => {
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    // document mousedown 关闭
    fireEvent.contextMenu(screen.getByText("章节"))
    expect(screen.getByRole("menu")).toBeInTheDocument()
    expect(screen.getByText("新建章节")).toBeInTheDocument()
    act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })))
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    // 非 Escape 键不关闭；ArrowDown/ArrowUp/Home/End 在 menuitem 间循环焦点；Escape 关闭
    const row = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    const triggerBtn = within(row).getByText("第三章-高潮").closest("button") as HTMLElement
    fireEvent.contextMenu(triggerBtn)
    const menu = screen.getByRole("menu")
    const items = within(menu).getAllByRole("menuitem")
    expect(items.length).toBeGreaterThan(2)
    expect(document.activeElement).toBe(items[0])
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true })))
    expect(screen.getByRole("menu")).toBeInTheDocument()
    fireEvent.keyDown(menu, { key: "ArrowDown" })
    expect(document.activeElement).toBe(items[1])
    fireEvent.keyDown(menu, { key: "End" })
    expect(document.activeElement).toBe(items[items.length - 1])
    fireEvent.keyDown(menu, { key: "Home" })
    expect(document.activeElement).toBe(items[0])
    fireEvent.keyDown(menu, { key: "ArrowUp" })
    expect(document.activeElement).toBe(items[items.length - 1])
    fireEvent.keyDown(menu, { key: "Escape" })
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    expect(document.activeElement).toBe(triggerBtn)
    // 容器 onClick 关闭
    fireEvent.contextMenu(screen.getByText("章节"))
    expect(screen.getByText("新建章节")).toBeInTheDocument()
    fireEvent.click(screen.getByText("章节"))
    expect(screen.queryByText("新建章节")).not.toBeInTheDocument()
    view.unmount()
  })

  it("移动到卷：copy+delete+刷新+选中跳转", async () => {
    mocks.wikiState.selectedFile = `${CHAPTERS}/第三章-高潮.md`
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    const row = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("移动到卷"))
    const menu = screen.getByText("重命名").closest("div.absolute") as HTMLElement
    fireEvent.click(within(menu).getByText("卷1"))
    await flush()
    expect(mocks.copyFile).toHaveBeenCalledWith(`${CHAPTERS}/第三章-高潮.md`, `${CHAPTERS}/卷1/第三章-高潮.md`)
    expect(mocks.deleteFile).toHaveBeenCalledWith(`${CHAPTERS}/第三章-高潮.md`)
    expect(mocks.wikiState.setSelectedFile).toHaveBeenCalledWith(`${CHAPTERS}/卷1/第三章-高潮.md`)
    expect(mocks.wikiState.setFileTree).toHaveBeenCalled()
    expect(mocks.wikiState.bumpDataVersion).toHaveBeenCalled()
    view.unmount()
  })

  it("移动到卷：目标已存在 alert；当前卷禁用；失败 console.error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    const row = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    // 目标已存在
    mocks.fileExists.mockResolvedValueOnce(true)
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("移动到卷"))
    let menu = screen.getByText("重命名").closest("div.absolute") as HTMLElement
    fireEvent.click(within(menu).getByText("卷1"))
    await flush()
    expect(mocks.toastError).toHaveBeenCalledWith("目标卷中已存在同名文件，无法移动")
    expect(mocks.copyFile).not.toHaveBeenCalled()
    // 当前卷禁用（第一章-开端 在卷1 内 → isCurrentVolume）
    const volRow = pageRow(view.container, `${CHAPTERS}/卷1/第一章-开端.md`)
    fireEvent.contextMenu(volRow)
    fireEvent.click(screen.getByText("移动到卷"))
    menu = screen.getByText("重命名").closest("div.absolute") as HTMLElement
    const volBtn = within(menu).getByText("卷1").closest("button")
    expect(volBtn?.hasAttribute("disabled")).toBe(true)
    expect(within(menu).getByText("当前")).toBeInTheDocument()
    // copyFile 失败 → console.error
    mocks.copyFile.mockRejectedValueOnce(new Error("copy-fail"))
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("移动到卷"))
    menu = screen.getByText("重命名").closest("div.absolute") as HTMLElement
    fireEvent.click(within(menu).getByText("卷1"))
    await flush()
    expect(errSpy).toHaveBeenCalled()
    view.unmount()
  })

  it("重命名章节：成功改名 + 文件迁移 + 选中更新", async () => {
    mocks.wikiState.selectedFile = `${CHAPTERS}/第三章-高潮.md`
    const onRemovePendingPage = vi.fn()
    const view = renderTree({ onRemovePendingPage })
    await screen.findByText("第三章-高潮")
    const row = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("重命名"))
    const input = within(row).getByRole("textbox")
    expect(input).toHaveValue("第三章-高潮")
    fireEvent.change(input, { target: { value: "第四章-新篇章" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await flush()
    const targetPath = `${CHAPTERS}/第4章-新篇章.md`
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(targetPath, expect.stringContaining('title: "第4章-新篇章"'))
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(targetPath, expect.stringContaining("chapter_number: 4"))
    expect(mocks.deleteFile).toHaveBeenCalledWith(`${CHAPTERS}/第三章-高潮.md`)
    expect(mocks.wikiState.setSelectedFile).toHaveBeenCalledWith(targetPath)
    expect(onRemovePendingPage).toHaveBeenCalledWith(`${CHAPTERS}/第三章-高潮.md`)
    expect(mocks.wikiState.setFileTree).toHaveBeenCalled()
    expect(mocks.wikiState.bumpDataVersion).toHaveBeenCalled()
    view.unmount()
  })

  it("重命名：含 chapter_number 的章节 → 更新章号字段；无章号章节 → 纯标题", async () => {
    const view = renderTree()
    await screen.findByText("序章-开端")
    // 第一章-开端：frontmatter 已有 title/chapter_number → 都替换
    const row1 = pageRow(view.container, `${CHAPTERS}/卷1/第一章-开端.md`)
    fireEvent.contextMenu(row1)
    fireEvent.click(screen.getByText("重命名"))
    const input1 = within(row1).getByRole("textbox")
    fireEvent.change(input1, { target: { value: "第五章-开端改" } })
    fireEvent.keyDown(input1, { key: "Enter" })
    await flush()
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(`${CHAPTERS}/卷1/第5章-开端改.md`, expect.stringContaining("chapter_number: 5"))
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(`${CHAPTERS}/卷1/第5章-开端改.md`, expect.stringContaining('title: "第5章-开端改"'))
    expect(mocks.deleteFile).toHaveBeenCalledWith(`${CHAPTERS}/卷1/第一章-开端.md`)
    // 序章-引子：无章号 → 纯标题、无 chapter_number 写入
    await screen.findByText("序章-引子")
    const row2 = pageRow(view.container, `${CHAPTERS}/序章-引子.md`)
    fireEvent.contextMenu(row2)
    fireEvent.click(screen.getByText("重命名"))
    const input2 = within(row2).getByRole("textbox")
    fireEvent.change(input2, { target: { value: "引子修改" } })
    fireEvent.keyDown(input2, { key: "Enter" })
    await flush()
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(`${CHAPTERS}/引子修改.md`, expect.stringContaining("# 引子修改"))
    expect(mocks.deleteFile).toHaveBeenCalledWith(`${CHAPTERS}/序章-引子.md`)
    view.unmount()
  })

  it("重命名：重复标题/章号冲突显性反馈并保留输入框；空标题/相同标题取消；Escape 取消", async () => {
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    const row = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    // 重复标题 → 保留输入框 + role="alert" + toast.error
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("重命名"))
    let input = within(row).getByRole("textbox")
    fireEvent.change(input, { target: { value: "第二章-进展" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await flush()
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(within(row).getByRole("textbox")).toBeInTheDocument()
    expect(within(row).getByRole("textbox")).toHaveAttribute("aria-invalid", "true")
    expect(within(row).getByRole("alert")).toHaveTextContent(/第二章-进展/)
    expect(mocks.toastError).toHaveBeenCalled()
    // 修改输入清除错误，改为章号冲突（第三章 → 第二章 → 与第二章-进展 冲突）
    mocks.toastError.mockClear()
    fireEvent.change(within(row).getByRole("textbox"), { target: { value: "第二章-冲突" } })
    expect(within(row).queryByRole("alert")).not.toBeInTheDocument()
    fireEvent.keyDown(within(row).getByRole("textbox"), { key: "Enter" })
    await flush()
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(within(row).getByRole("textbox")).toBeInTheDocument()
    expect(within(row).getByRole("alert")).toHaveTextContent(/第二章-进展|2/)
    expect(mocks.toastError).toHaveBeenCalled()
    // Escape 取消冲突态输入框
    fireEvent.keyDown(within(row).getByRole("textbox"), { key: "Escape" })
    expect(within(row).queryByRole("textbox")).not.toBeInTheDocument()
    // 空标题 → 取消
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("重命名"))
    input = within(row).getByRole("textbox")
    fireEvent.change(input, { target: { value: "   " } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(within(row).queryByRole("textbox")).not.toBeInTheDocument()
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    // 相同标题 → 取消
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("重命名"))
    input = within(row).getByRole("textbox")
    fireEvent.change(input, { target: { value: "第三章-高潮" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(within(row).queryByRole("textbox")).not.toBeInTheDocument()
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    // Escape → 取消
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("重命名"))
    input = within(row).getByRole("textbox")
    fireEvent.keyDown(input, { key: "Escape" })
    expect(within(row).queryByRole("textbox")).not.toBeInTheDocument()
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    view.unmount()
  })

  it("重命名 outline：slug 同路径时不删旧文件（getUniquePagePath 同路径分支）", async () => {
    const view = render(<KnowledgeTree filterType="outline" />)
    await screen.findByText("分卷大纲二")
    const row = pageRow(view.container, `${OUTLINES}/分卷大纲-2.md`)
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("重命名"))
    const input = within(row).getByRole("textbox")
    fireEvent.change(input, { target: { value: "分卷大纲 2" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await flush()
    // slug("分卷大纲 2") === "分卷大纲-2" → 同路径写回
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(`${OUTLINES}/分卷大纲-2.md`, expect.stringContaining('title: "分卷大纲 2"'))
    expect(mocks.deleteFile).not.toHaveBeenCalled()
    expect(mocks.wikiState.setFileTree).toHaveBeenCalled()
    view.unmount()
  })

  it("重命名 getUniquePagePath：首路径占用→-2 后缀；候选等于排除路径；全部占用→时间戳", async () => {
    const view = render(<KnowledgeTree filterType="outline" />)
    await screen.findByText("分卷大纲二")
    // 场景1：首路径被占（分卷大纲-2.md 存在）→ 返回 -2 后缀
    mocks.fileExists.mockImplementation(async (p: string) => p === `${OUTLINES}/分卷大纲-2.md`)
    const row1 = pageRow(view.container, `${OUTLINES}/分卷大纲-2-3.md`)
    fireEvent.contextMenu(row1)
    fireEvent.click(screen.getByText("重命名"))
    let input = within(row1).getByRole("textbox")
    fireEvent.change(input, { target: { value: "分卷大纲 2" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await flush()
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(`${OUTLINES}/分卷大纲-2-2.md`, expect.any(String))
    expect(mocks.deleteFile).toHaveBeenCalledWith(`${OUTLINES}/分卷大纲-2-3.md`)
    // 场景2：候选 -2 占用、-3 等于排除路径 → 同路径写回（覆盖 candidate === excludePath）
    mocks.fileExists.mockImplementation(async (p: string) => p === `${OUTLINES}/分卷大纲-2.md` || p === `${OUTLINES}/分卷大纲-2-2.md`)
    const row2 = pageRow(view.container, `${OUTLINES}/分卷大纲-2-3.md`)
    fireEvent.contextMenu(row2)
    fireEvent.click(screen.getByText("重命名"))
    input = within(row2).getByRole("textbox")
    fireEvent.change(input, { target: { value: "分卷大纲 2" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await flush()
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(`${OUTLINES}/分卷大纲-2-3.md`, expect.any(String))
    // 场景3：全部候选占用 → Date.now 时间戳兜底
    mocks.fileExists.mockImplementation(async (p: string) => p.startsWith(`${OUTLINES}/分卷大纲-2`))
    const row3 = pageRow(view.container, `${OUTLINES}/全书大纲.md`)
    fireEvent.contextMenu(row3)
    fireEvent.click(screen.getByText("重命名"))
    input = within(row3).getByRole("textbox")
    fireEvent.change(input, { target: { value: "分卷大纲 2" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await flush()
    const fallbackCalls = mocks.writeFileAtomic.mock.calls.map(([p]) => p as string).filter((p) => p.startsWith(`${OUTLINES}/分卷大纲-2-`) && /-\d{13}\.md$/.test(p))
    expect(fallbackCalls.length).toBeGreaterThan(0)
    view.unmount()
  })

  it("重命名：busy 时 Escape 无效；readFile 失败 → console.error 且状态清理", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    const row = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    // busy 场景：readFile 挂起 → 期间 Escape 无效（cancelRenamePage busy 守卫）
    let resolveRead!: (v: string) => void
    mocks.readFile.mockImplementationOnce(() => new Promise<string>((resolve) => { resolveRead = resolve }))
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("重命名"))
    const input = within(row).getByRole("textbox")
    fireEvent.change(input, { target: { value: "第四章-新篇章" } })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.keyDown(input, { key: "Escape" })
    resolveRead(CONTENTS[`${CHAPTERS}/第三章-高潮.md`])
    await flush()
    expect(mocks.writeFileAtomic).toHaveBeenCalled()
    // readFile 失败 → console.error + toast.error + inline role="alert"，Escape 后关闭输入框
    mocks.readFile.mockRejectedValueOnce(new Error("read-fail"))
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("重命名"))
    const input2 = within(row).getByRole("textbox")
    fireEvent.change(input2, { target: { value: "第四章-新篇章" } })
    fireEvent.keyDown(input2, { key: "Enter" })
    await flush()
    expect(errSpy).toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalled()
    expect(within(row).getByRole("alert")).toHaveTextContent(/read-fail/)
    fireEvent.keyDown(within(row).getByRole("textbox"), { key: "Escape" })
    expect(within(row).queryByRole("textbox")).not.toBeInTheDocument()
    view.unmount()
  })

  it("拖拽排序：pointer 流程 + 章号重写 + 错误 pointerId 不结束", async () => {
    mocks.wikiState.selectedFile = `${CHAPTERS}/第二章-进展.md`
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    vi.useFakeTimers()
    const source = pageRow(view.container, `${CHAPTERS}/第二章-进展.md`)
    const targetRow = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    setElementFromPoint(targetRow)
    vi.spyOn(targetRow, "getBoundingClientRect").mockReturnValue({ top: 0, height: 100 } as DOMRect)
    fireEvent.pointerDown(source, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 0, clientY: 0 })
    // 拖拽开始前的 window pointermove（dragSourceRef 空 → 早退）
    act(() => { window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, pointerType: "mouse", clientX: 0, clientY: 0 })) })
    act(() => { vi.advanceTimersByTime(300) })
    // 拖拽已开始：源行 ring、目标行 insert 边框（top half → insertIndex=2=第三章 index）
    expect(source.className).toContain("ring-2")
    expect(targetRow.className).toContain("border-t-[3px]")
    // 底部半区 → insertIndex 3
    act(() => { window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, pointerType: "mouse", clientX: 0, clientY: 90 })) })
    // 错误 pointerId 的 pointerup → 不结束
    act(() => { window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 99, clientX: 0, clientY: 90 })) })
    expect(source.className).toContain("ring-2")
    // 正确 pointerup → finishDrag → executeChapterReorder
    act(() => { window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 0, clientY: 90 })) })
    await act(async () => {})
    expect(mocks.writeFileAtomic).toHaveBeenCalled()
    expect(mocks.wikiState.setFileTree).toHaveBeenCalled()
    expect(mocks.wikiState.bumpDataVersion).toHaveBeenCalled()
    vi.useRealTimers()
    view.unmount()
  })

  it("重排写入内容：追加/替换/无 frontmatter 前置 chapter_number", async () => {
    mocks.wikiState.selectedFile = `${CHAPTERS}/第二章-进展.md`
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    vi.useFakeTimers()
    const source = pageRow(view.container, `${CHAPTERS}/第二章-进展.md`)
    const targetRow = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    setElementFromPoint(targetRow)
    vi.spyOn(targetRow, "getBoundingClientRect").mockReturnValue({ top: 0, height: 100 } as DOMRect)
    fireEvent.pointerDown(source, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 0, clientY: 0 })
    act(() => { vi.advanceTimersByTime(300) })
    // 底部半区 → insertIndex 3（否则 top half 等价无操作）
    act(() => { window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, pointerType: "mouse", clientX: 0, clientY: 90 })) })
    act(() => { window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 0, clientY: 90 })) })
    await act(async () => {})
    const calls = mocks.writeFileAtomic.mock.calls.map(([p, c]) => [p as string, c as string])
    // 高潮(3→2)：有 frontmatter 无 chapter_number → 追加
    const high = calls.find(([p]) => p === `${CHAPTERS}/第三章-高潮.md`)
    expect(high?.[1]).toContain("chapter_number: 2")
    // 进展(2→3)：无 frontmatter → 前置
    const prog = calls.find(([p]) => p === `${CHAPTERS}/第二章-进展.md`)
    expect(prog?.[1]).toMatch(/^---\nchapter_number: 3\n---/)
    // 终章(10→4)：已有 chapter_number: 0 → 替换
    const fin = calls.find(([p]) => p === `${CHAPTERS}/第10章-终章.md`)
    expect(fin?.[1]).toContain("chapter_number: 4")
    // 随笔/序章 无 frontmatter → 前置（随笔排前，序章-引子最后）
    const sui = calls.find(([p]) => p === `${CHAPTERS}/随笔.md`)
    expect(sui?.[1]).toMatch(/^---\nchapter_number: 5\n---/)
    const xu = calls.find(([p]) => p === `${CHAPTERS}/序章-引子.md`)
    expect(xu?.[1]).toMatch(/^---\nchapter_number: 6\n---/)
    vi.useRealTimers()
    view.unmount()
  })

  it("重排失败：部分写入后回滚；回滚失败被忽略并抛原错误", async () => {
    mocks.wikiState.selectedFile = `${CHAPTERS}/第二章-进展.md`
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    vi.useFakeTimers()
    const source = pageRow(view.container, `${CHAPTERS}/第二章-进展.md`)
    const targetRow = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    setElementFromPoint(targetRow)
    vi.spyOn(targetRow, "getBoundingClientRect").mockReturnValue({ top: 0, height: 100 } as DOMRect)
    // 第1次写入成功（高潮）、第2次失败（进展）、回滚（高潮原文）再失败
    mocks.writeFileAtomic
      .mockImplementationOnce(async () => {})
      .mockRejectedValueOnce(new Error("write-fail"))
      .mockRejectedValueOnce(new Error("rollback-fail"))
    fireEvent.pointerDown(source, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 0, clientY: 0 })
    act(() => { vi.advanceTimersByTime(300) })
    act(() => { window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, pointerType: "mouse", clientX: 0, clientY: 90 })) })
    act(() => { window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 0, clientY: 90 })) })
    await act(async () => {})
    expect(errSpy).toHaveBeenCalled()
    vi.useRealTimers()
    view.unmount()
  })

  it("拖拽辅助分支：elementFromPoint 各类返回值 + 提前 pointerup 空操作", async () => {
    mocks.wikiState.selectedFile = `${CHAPTERS}/第二章-进展.md`
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    vi.useFakeTimers()
    const source = pageRow(view.container, `${CHAPTERS}/第二章-进展.md`)
    const targetRow = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    const plainDiv = document.createElement("div")
    const emptyPathRow = document.createElement("div")
    emptyPathRow.setAttribute("data-page-path", "")
    const unknownRow = document.createElement("div")
    unknownRow.setAttribute("data-page-path", "not-in-sorted")
    const returns: Array<Element | Text | null> = [
      null,                              // elementFromPoint null → 早退
      document.createTextNode("x"),      // 非 HTMLElement → 早退
      plainDiv,                          // 无 data-page-path → 早退
      emptyPathRow,                      // data-page-path 空 → 早退
      unknownRow,                        // 不在 sortedChapterPages → 早退
      targetRow,                         // 正常 → top half
    ]
    let i = 0
    ;(document as unknown as { elementFromPoint: Mock }).elementFromPoint = vi.fn(() => returns[i++] ?? null) as never
    vi.spyOn(targetRow, "getBoundingClientRect").mockReturnValue({ top: 0, height: 100 } as DOMRect)
    fireEvent.pointerDown(source, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 0, clientY: 0 })
    // 拖拽中：每个 pointermove 消费一个返回值
    for (let k = 0; k < returns.length; k += 1) {
      act(() => { window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, pointerType: "mouse", clientX: 0, clientY: k === returns.length - 1 ? 10 : 0 })) })
    }
    // 提前 pointerup（timer 未到）→ finishDrag 无 source → 空操作并清理监听
    const earlyUp = new PointerEvent("pointerup", { pointerId: 7 })
    act(() => { window.dispatchEvent(earlyUp) })
    await act(async () => {})
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    vi.useRealTimers()
    view.unmount()
  })

  it("拖拽不可读页面：sourceIndex<0 与 rowIndex<0 早退（fallback 页）", async () => {
    mocks.readFile.mockImplementation(async (p: string) => {
      if (p === `${CHAPTERS}/第二章-进展.md`) throw new Error("boom")
      return CONTENTS[p] ?? ""
    })
    mocks.wikiState.selectedFile = `${CHAPTERS}/第二章-进展.md`
    const view = renderTree()
    await screen.findByText("第二章 进展")
    vi.useFakeTimers()
    const row = pageRow(view.container, `${CHAPTERS}/第二章-进展.md`)
    const targetRow = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    setElementFromPoint(targetRow)
    vi.spyOn(targetRow, "getBoundingClientRect").mockReturnValue({ top: 0, height: 100 } as DOMRect)
    fireEvent.pointerDown(row, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 0, clientY: 0 })
    act(() => { vi.advanceTimersByTime(300) })
    // 悬停无效行（fallback 页自身）→ rowIndex<0 早退
    setElementFromPoint(row)
    act(() => { window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, pointerType: "mouse", clientX: 0, clientY: 0 })) })
    act(() => { window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 0, clientY: 0 })) })
    await act(async () => {})
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    vi.useRealTimers()
    view.unmount()
  })

  it("容器 pointermove：未注册 pointerId 早退；拖拽前仅更新位置", async () => {
    mocks.wikiState.selectedFile = `${CHAPTERS}/第二章-进展.md`
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    vi.useFakeTimers()
    const source = pageRow(view.container, `${CHAPTERS}/第二章-进展.md`)
    const targetRow = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    setElementFromPoint(targetRow)
    fireEvent.pointerDown(source, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 0, clientY: 0 })
    // 未注册 pointerId → 早退
    fireEvent.pointerMove(view.container as HTMLElement, { pointerId: 5, clientX: 0, clientY: 0 })
    // 已注册但未开始拖拽 → 仅更新 pending 位置
    fireEvent.pointerMove(view.container as HTMLElement, { pointerId: 1, clientX: 10, clientY: 20 })
    act(() => { vi.advanceTimersByTime(300) })
    // 拖拽开始后容器 pointermove → 更新插入点
    fireEvent.pointerMove(view.container as HTMLElement, { pointerId: 1, clientX: 0, clientY: 90 })
    act(() => { window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 })) })
    await act(async () => {})
    expect(mocks.writeFileAtomic).toHaveBeenCalled()
    vi.useRealTimers()
    view.unmount()
  })

  it("outline 模式 pointerdown 早退（filterType !== chapter）", async () => {
    const view = render(<KnowledgeTree filterType="outline" />)
    await screen.findByText("全书大纲")
    vi.useFakeTimers()
    const row = pageRow(view.container, `${OUTLINES}/全书大纲.md`)
    fireEvent.pointerDown(row, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 0, clientY: 0 })
    act(() => { vi.advanceTimersByTime(300) })
    expect(row.className).not.toContain("ring-2")
    vi.useRealTimers()
    view.unmount()
  })

  it("selectstart：页面行拦截；文件夹行/SVG 不拦截；outline 不挂监听", async () => {
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    const pageRowEl = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    const evt1 = new Event("selectstart", { bubbles: true, cancelable: true })
    pageRowEl.dispatchEvent(evt1)
    expect(evt1.defaultPrevented).toBe(true)
    const folderRow = screen.getByText("卷1").closest("[data-knowledge-interactive]") as HTMLElement
    const evt2 = new Event("selectstart", { bubbles: true, cancelable: true })
    folderRow.dispatchEvent(evt2)
    expect(evt2.defaultPrevented).toBe(false)
    const svg = folderRow.querySelector("svg") as SVGElement
    const evt3 = new Event("selectstart", { bubbles: true, cancelable: true })
    svg.dispatchEvent(evt3)
    expect(evt3.defaultPrevented).toBe(false)
    view.unmount()
    // outline 模式：effect 跳过，不拦截
    const view2 = render(<KnowledgeTree filterType="outline" />)
    await screen.findByText("全书大纲")
    const outlineRow = pageRow(view2.container, `${OUTLINES}/全书大纲.md`)
    const evt4 = new Event("selectstart", { bubbles: true, cancelable: true })
    outlineRow.dispatchEvent(evt4)
    expect(evt4.defaultPrevented).toBe(false)
    view2.unmount()
  })

  it("pendingPages：覆盖标题 + 空树时无空态 + 异类型过滤", async () => {
    const pending: Array<{ path: string; title: string; type: "chapter" | "outline"; tags: string[] }> = [
      { path: `${CHAPTERS}/第二章-进展.md`, title: "第二章-进展(待定)", type: "chapter", tags: [] },
      { path: `${OUTLINES}/全书大纲.md`, title: "大纲(临时)", type: "outline", tags: [] },
    ]
    const view = renderTree({ pendingPages: pending })
    await screen.findByText("第二章-进展(待定)")
    mocks.wikiState.fileTree = []
    view.rerender(<KnowledgeTree filterType="chapter" pendingPages={pending} />)
    expect(screen.queryByText(/knowledgeTree\.emptyFiltered/)).not.toBeInTheDocument()
    view.unmount()
  })

  it("加载失败：wiki 目录读取失败 → console.error + 空页列表", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.listDirectory.mockImplementation(async (p: string) => {
      if (p === `${PROJ}/wiki`) throw new Error("wiki-fail")
      return []
    })
    const view = renderTree()
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    view.unmount()
  })

  it("排序：文件先于文件夹时 dir 优先（比较器 dir/file 双向分支）", async () => {
    const wiki = [
      dirNode("chapters", CHAPTERS, [
        fileNode("第二章-进展.md", `${CHAPTERS}/第二章-进展.md`),
        dirNode("卷1", `${CHAPTERS}/卷1`, [fileNode("第一章-开端.md", `${CHAPTERS}/卷1/第一章-开端.md`)]),
        fileNode("第三章-高潮.md", `${CHAPTERS}/第三章-高潮.md`),
      ]),
      dirNode("outlines", OUTLINES, []),
      fileNode("index.md", `${PROJ}/wiki/index.md`),
      fileNode("log.md", `${PROJ}/wiki/log.md`),
    ]
    mocks.listDirectory.mockImplementation(async (p: string) => {
      if (p === `${PROJ}/wiki`) return wiki
      if (p === PROJ) return [dirNode("wiki", `${PROJ}/wiki`, wiki)]
      return []
    })
    mocks.wikiState.fileTree = [dirNode("wiki", `${PROJ}/wiki`, wiki)]
    const view = renderTree()
    await screen.findByText("第二章-进展")
    const paths = [...view.container.querySelectorAll("[data-page-path]")].map((el) => el.getAttribute("data-page-path"))
    expect(paths).toEqual([`${CHAPTERS}/卷1/第一章-开端.md`, `${CHAPTERS}/第二章-进展.md`, `${CHAPTERS}/第三章-高潮.md`])
    view.unmount()
  })

  it("章节排序：null 号页在前时比较器 leftOrder!=null/rightOrder==null 分支", async () => {
    const wiki = [
      dirNode("chapters", CHAPTERS, [
        fileNode("随笔.md", `${CHAPTERS}/随笔.md`),
        fileNode("第一章-甲.md", `${CHAPTERS}/第一章-甲.md`),
        fileNode("第二章-乙.md", `${CHAPTERS}/第二章-乙.md`),
      ]),
      dirNode("outlines", OUTLINES, []),
      fileNode("index.md", `${PROJ}/wiki/index.md`),
      fileNode("log.md", `${PROJ}/wiki/log.md`),
    ]
    const contents: Record<string, string> = {
      [`${CHAPTERS}/随笔.md`]: "# 随笔\n内容",
      [`${CHAPTERS}/第一章-甲.md`]: "# 第一章-甲\n内容",
      [`${CHAPTERS}/第二章-乙.md`]: "# 第二章-乙\n内容",
    }
    mocks.listDirectory.mockImplementation(async (p: string) => {
      if (p === `${PROJ}/wiki`) return wiki
      if (p === PROJ) return [dirNode("wiki", `${PROJ}/wiki`, wiki)]
      return []
    })
    mocks.readFile.mockImplementation(async (p: string) => contents[p] ?? "")
    mocks.wikiState.fileTree = [dirNode("wiki", `${PROJ}/wiki`, wiki)]
    const view = renderTree()
    await screen.findByText("第一章-甲")
    const paths = [...view.container.querySelectorAll("[data-page-path]")].map((el) => el.getAttribute("data-page-path"))
    expect(paths).toEqual([`${CHAPTERS}/第一章-甲.md`, `${CHAPTERS}/第二章-乙.md`, `${CHAPTERS}/随笔.md`])
    view.unmount()
  })

  it("章号提取：'第二十章' 无单位 → 十位单独处理", async () => {
    const wiki = [
      dirNode("chapters", CHAPTERS, [
        fileNode("第一章-甲.md", `${CHAPTERS}/第一章-甲.md`),
        fileNode("第二十章-乙.md", `${CHAPTERS}/第二十章-乙.md`),
      ]),
      dirNode("outlines", OUTLINES, []),
      fileNode("index.md", `${PROJ}/wiki/index.md`),
      fileNode("log.md", `${PROJ}/wiki/log.md`),
    ]
    const contents: Record<string, string> = {
      [`${CHAPTERS}/第一章-甲.md`]: "# 第一章-甲\n内容",
      [`${CHAPTERS}/第二十章-乙.md`]: "# 第二十章-乙\n内容",
    }
    mocks.listDirectory.mockImplementation(async (p: string) => {
      if (p === `${PROJ}/wiki`) return wiki
      if (p === PROJ) return [dirNode("wiki", `${PROJ}/wiki`, wiki)]
      return []
    })
    mocks.readFile.mockImplementation(async (p: string) => contents[p] ?? "")
    mocks.wikiState.fileTree = [dirNode("wiki", `${PROJ}/wiki`, wiki)]
    const view = renderTree()
    await screen.findByText("第一章-甲")
    const paths = [...view.container.querySelectorAll("[data-page-path]")].map((el) => el.getAttribute("data-page-path"))
    expect(paths).toEqual([`${CHAPTERS}/第一章-甲.md`, `${CHAPTERS}/第二十章-乙.md`])
    view.unmount()
  })

  it("删除武装：容器内 mousedown 保持武装；非 Escape 键保持", async () => {
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    const row = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    fireEvent.click(within(row).getByTitle(/移入回收站/))
    expect(within(row).getByTitle(/再次点击确认/)).toBeInTheDocument()
    // 容器内 mousedown → 早退，武装保持
    act(() => { row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })) })
    expect(within(row).getByTitle(/再次点击确认/)).toBeInTheDocument()
    // 非 Escape 键 → 武装保持
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true })) })
    expect(within(row).getByTitle(/再次点击确认/)).toBeInTheDocument()
    view.unmount()
  })

  it("删除选中卷内页面：selectedFile 前缀匹配 → setSelectedFile(null)", async () => {
    mocks.wikiState.selectedFile = `${CHAPTERS}/卷1/第一章-开端.md`
    const view = renderTree()
    await screen.findByText("序章-开端")
    fireEvent.contextMenu(screen.getByText("卷1"))
    fireEvent.click(screen.getByText("删除卷"))
    await flush()
    expect(mocks.wikiState.setSelectedFile).toHaveBeenCalledWith(null)
    view.unmount()
  })

  it("文件夹删除：目录内含子目录 → flattenAllFiles 递归展平", async () => {
    mocks.listDirectory.mockImplementation(async (p: string) => {
      if (p === `${CHAPTERS}/卷1`) return [
        { name: "空目录", path: `${CHAPTERS}/卷1/空目录`, is_dir: true } as FileNode,
        dirNode("子目录", `${CHAPTERS}/卷1/子目录`, [fileNode("甲.md", `${CHAPTERS}/卷1/子目录/甲.md`)]),
      ]
      if (p === `${PROJ}/wiki`) return defaultWikiTree()
      if (p === PROJ) return defaultFileTree()
      return []
    })
    const view = renderTree()
    await screen.findByText("序章-开端")
    fireEvent.contextMenu(screen.getByText("卷1"))
    fireEvent.click(screen.getByText("删除卷"))
    await flush()
    // 递归展平后仍有文件 → 阻止删除目录
    expect(mocks.toastError).toHaveBeenCalledWith('文件夹「{{name}}」中仍有未移入回收站的其他文件，已保留文件夹本身。::{"name":"卷1"}')
    expect(mocks.deleteFile).not.toHaveBeenCalledWith(`${CHAPTERS}/卷1`)
    view.unmount()
  })

  it("文件夹计数：非 md 文件计 0；children 缺失目录 ?? []", async () => {
    const wiki = [
      dirNode("chapters", CHAPTERS, [
        dirNode("卷1", `${CHAPTERS}/卷1`, [
          fileNode("第一章-开端.md", `${CHAPTERS}/卷1/第一章-开端.md`),
          fileNode("notes.txt", `${CHAPTERS}/卷1/notes.txt`),
        ]),
        { name: "空壳卷", path: `${CHAPTERS}/空壳卷`, is_dir: true } as FileNode,
        fileNode("第二章-进展.md", `${CHAPTERS}/第二章-进展.md`),
      ]),
      dirNode("outlines", OUTLINES, []),
      fileNode("index.md", `${PROJ}/wiki/index.md`),
      fileNode("log.md", `${PROJ}/wiki/log.md`),
    ]
    mocks.listDirectory.mockImplementation(async (p: string) => {
      if (p === `${PROJ}/wiki`) return wiki
      if (p === PROJ) return [dirNode("wiki", `${PROJ}/wiki`, wiki)]
      return []
    })
    mocks.wikiState.fileTree = [dirNode("wiki", `${PROJ}/wiki`, wiki)]
    const view = renderTree()
    await screen.findByText("第二章-进展")
    const volRow = screen.getByText("卷1").closest("[data-knowledge-interactive]") as HTMLElement
    expect(within(volRow).getByText("1")).toBeInTheDocument()
    const shellRow = screen.getByText("空壳卷").closest("[data-knowledge-interactive]") as HTMLElement
    expect(within(shellRow).getByText("0")).toBeInTheDocument()
    view.unmount()
  })

  it("移动到卷：源页未选中时跳过 setSelectedFile", async () => {
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    const row = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("移动到卷"))
    const menu = screen.getByText("重命名").closest("div.absolute") as HTMLElement
    fireEvent.click(within(menu).getByText("卷1"))
    await flush()
    expect(mocks.copyFile).toHaveBeenCalled()
    expect(mocks.wikiState.setSelectedFile).not.toHaveBeenCalled()
    view.unmount()
  })

  it("重排：向上拖动（sourceIndex >= targetIndex → effectiveTarget 直取）", async () => {
    mocks.wikiState.selectedFile = `${CHAPTERS}/第三章-高潮.md`
    const view = renderTree()
    await screen.findByText("第二章-进展")
    vi.useFakeTimers()
    const source = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    const targetRow = pageRow(view.container, `${CHAPTERS}/第二章-进展.md`)
    setElementFromPoint(targetRow)
    vi.spyOn(targetRow, "getBoundingClientRect").mockReturnValue({ top: 0, height: 100 } as DOMRect)
    fireEvent.pointerDown(source, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 0, clientY: 0 })
    act(() => { vi.advanceTimersByTime(300) })
    // 顶部半区 → insertIndex 1（源 index 2 >= 1 → 直取）
    act(() => { window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, pointerType: "mouse", clientX: 0, clientY: 10 })) })
    act(() => { window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 0, clientY: 10 })) })
    await act(async () => {})
    expect(mocks.writeFileAtomic).toHaveBeenCalled()
    const calls = mocks.writeFileAtomic.mock.calls.map(([p, c]) => [p as string, c as string])
    const high = calls.find(([p]) => p === `${CHAPTERS}/第三章-高潮.md`)
    expect(high?.[1]).toContain("chapter_number: 2")
    vi.useRealTimers()
    view.unmount()
  })

  it("重排守卫：fallback 行 sourceIndex<0 早退", async () => {
    mocks.readFile.mockImplementation(async (p: string) => {
      if (p === `${CHAPTERS}/第二章-进展.md`) throw new Error("boom")
      return CONTENTS[p] ?? ""
    })
    mocks.wikiState.selectedFile = `${CHAPTERS}/第二章-进展.md`
    const view = renderTree()
    await screen.findByText("第二章 进展")
    vi.useFakeTimers()
    const source = pageRow(view.container, `${CHAPTERS}/第二章-进展.md`)
    const targetRow = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    setElementFromPoint(targetRow)
    vi.spyOn(targetRow, "getBoundingClientRect").mockReturnValue({ top: 0, height: 100 } as DOMRect)
    fireEvent.pointerDown(source, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 0, clientY: 0 })
    act(() => { vi.advanceTimersByTime(300) })
    act(() => { window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, pointerType: "mouse", clientX: 0, clientY: 10 })) })
    act(() => { window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 0, clientY: 10 })) })
    await act(async () => {})
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    vi.useRealTimers()
    view.unmount()
  })

  it("重排守卫：放置到自身位置（effectiveTarget === sourceIndex）早退", async () => {
    mocks.wikiState.selectedFile = `${CHAPTERS}/第二章-进展.md`
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    vi.useFakeTimers()
    const source = pageRow(view.container, `${CHAPTERS}/第二章-进展.md`)
    setElementFromPoint(source)
    vi.spyOn(source, "getBoundingClientRect").mockReturnValue({ top: 0, height: 100 } as DOMRect)
    fireEvent.pointerDown(source, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 0, clientY: 0 })
    act(() => { vi.advanceTimersByTime(300) })
    // 顶部半区 → insertIndex 1 === sourceIndex 1 → 早退
    act(() => { window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, pointerType: "mouse", clientX: 0, clientY: 10 })) })
    act(() => { window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 0, clientY: 10 })) })
    await act(async () => {})
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    vi.useRealTimers()
    view.unmount()
  })

  it("重排：timer 未到提前 pointerup → finishDrag 清理 pending timer", async () => {
    mocks.wikiState.selectedFile = `${CHAPTERS}/第二章-进展.md`
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    vi.useFakeTimers()
    const source = pageRow(view.container, `${CHAPTERS}/第二章-进展.md`)
    fireEvent.pointerDown(source, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 0, clientY: 0 })
    // 300ms 内 pointerup → finishDrag：清 timer + 无 source → 空操作
    act(() => { window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 0, clientY: 0 })) })
    await act(async () => {})
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    // timer 已清：再 advance 也不触发拖拽
    act(() => { vi.advanceTimersByTime(300) })
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    vi.useRealTimers()
    view.unmount()
  })

  it("拖拽辅助：elementFromPoint null/文本/空路径/未知行 早退", async () => {
    mocks.wikiState.selectedFile = `${CHAPTERS}/第二章-进展.md`
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    vi.useFakeTimers()
    const source = pageRow(view.container, `${CHAPTERS}/第二章-进展.md`)
    const emptyPathRow = document.createElement("div")
    emptyPathRow.setAttribute("data-page-path", "")
    const unknownRow = document.createElement("div")
    unknownRow.setAttribute("data-page-path", "not-in-sorted")
    const returns: Array<Element | Text | null> = [
      null,
      document.createTextNode("x"),
      emptyPathRow,
      unknownRow,
    ]
    let i = 0
    ;(document as unknown as { elementFromPoint: Mock }).elementFromPoint = vi.fn(() => returns[i++] ?? null) as never
    fireEvent.pointerDown(source, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 0, clientY: 0 })
    act(() => { vi.advanceTimersByTime(300) })
    for (let k = 0; k < returns.length; k += 1) {
      act(() => { window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, pointerType: "mouse", clientX: 0, clientY: 10 })) })
    }
    act(() => { window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 0, clientY: 10 })) })
    await act(async () => {})
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    vi.useRealTimers()
    view.unmount()
  })

  it("容器 pointermove：未注册 pointerId/未开始/已开始 三分支", async () => {
    mocks.wikiState.selectedFile = `${CHAPTERS}/第二章-进展.md`
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    vi.useFakeTimers()
    const source = pageRow(view.container, `${CHAPTERS}/第二章-进展.md`)
    const targetRow = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    const inner = screen.getByText("第三章-高潮")
    setElementFromPoint(targetRow)
    vi.spyOn(targetRow, "getBoundingClientRect").mockReturnValue({ top: 0, height: 100 } as DOMRect)
    fireEvent.pointerDown(source, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 0, clientY: 0 })
    // 未注册 pointerId → 早退
    fireEvent.pointerMove(inner, { pointerId: 99, clientX: 0, clientY: 0 })
    // 已注册未开始 → 仅更新 pending 位置
    fireEvent.pointerMove(inner, { pointerId: 1, clientX: 5, clientY: 5 })
    act(() => { vi.advanceTimersByTime(300) })
    // 已开始 → 更新插入点（底部半区 → insertIndex 3）
    fireEvent.pointerMove(inner, { pointerId: 1, clientX: 0, clientY: 90 })
    act(() => { window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 0, clientY: 90 })) })
    await act(async () => {})
    expect(mocks.writeFileAtomic).toHaveBeenCalled()
    vi.useRealTimers()
    view.unmount()
  })

  it("pointerdown 守卫：button!==0 早退；pointerType 空串 → mouse 回退", async () => {
    const view = renderTree()
    await screen.findByText("第二章-进展")
    const row = pageRow(view.container, `${CHAPTERS}/第二章-进展.md`)
    vi.useFakeTimers()
    fireEvent.pointerDown(row, { pointerId: 1, pointerType: "mouse", button: 2, clientX: 0, clientY: 0 })
    act(() => { vi.advanceTimersByTime(300) })
    expect(row.className).not.toContain("ring-2")
    // pointerType "" → lastPointerTypeRef = "mouse" → 右键菜单不被拦截
    fireEvent.pointerDown(row, { pointerId: 2, pointerType: "", button: 0, clientX: 0, clientY: 0 })
    act(() => { vi.advanceTimersByTime(300) })
    expect(row.className).not.toContain("ring-2")
    fireEvent.contextMenu(row)
    expect(screen.getByText("重命名")).toBeInTheDocument()
    vi.useRealTimers()
    view.unmount()
  })

  it("pointerdown 重复：pending timer 被清后重启拖拽", async () => {
    mocks.wikiState.selectedFile = `${CHAPTERS}/第二章-进展.md`
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    vi.useFakeTimers()
    const source = pageRow(view.container, `${CHAPTERS}/第二章-进展.md`)
    const targetRow = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    setElementFromPoint(targetRow)
    vi.spyOn(targetRow, "getBoundingClientRect").mockReturnValue({ top: 0, height: 100 } as DOMRect)
    fireEvent.pointerDown(source, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 0, clientY: 0 })
    // 第二次 pointerdown：清除 pending timer 后重启（pointerId 2）
    fireEvent.pointerDown(source, { pointerId: 2, pointerType: "mouse", button: 0, clientX: 0, clientY: 0 })
    act(() => { vi.advanceTimersByTime(300) })
    // 底部半区 → insertIndex 3 → effectiveTarget 2 ≠ sourceIndex 1 → 重排
    act(() => { window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 2, pointerType: "mouse", clientX: 0, clientY: 90 })) })
    act(() => { window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 2, clientX: 0, clientY: 90 })) })
    await act(async () => {})
    vi.useRealTimers()
    expect(mocks.writeFileAtomic).toHaveBeenCalled()
    view.unmount()
  })

  it("重命名：busy 期间再提交被守卫；blur 提交；mousedown/click 拦截；非 Enter/Escape 键", async () => {
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    const row = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    let resolveRead!: (v: string) => void
    mocks.readFile.mockImplementationOnce(() => new Promise<string>((resolve) => { resolveRead = resolve }))
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("重命名"))
    const input = within(row).getByRole("textbox")
    // mousedown/click 冒泡拦截（stopPropagation）
    fireEvent.mouseDown(input)
    fireEvent.click(input)
    // 非 Enter/Escape 键 → 无操作
    fireEvent.keyDown(input, { key: "x" })
    // Enter 提交 → busy；再次 Enter/blur → 守卫早退
    fireEvent.change(input, { target: { value: "第四章-新篇章" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(within(row).getByRole("textbox").hasAttribute("disabled")).toBe(true))
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.blur(input)
    resolveRead(CONTENTS[`${CHAPTERS}/第三章-高潮.md`])
    await flush()
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it("重命名态 WCAG 4.1.2：input 不嵌套在 button 内，点击重命名容器不切换选中文件", async () => {
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    const row = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("重命名"))
    const input = within(row).getByRole("textbox")
    expect(input.closest("button")).toBeNull()
    const group = within(row).getByRole("group")
    fireEvent.click(group)
    expect(mocks.wikiState.setSelectedFile).not.toHaveBeenCalled()
    view.unmount()
  })

  it("重命名开始：清除拖拽 pending timer（pointerdown 后立即 rename）", async () => {
    mocks.wikiState.selectedFile = `${CHAPTERS}/第二章-进展.md`
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    vi.useFakeTimers()
    const row = pageRow(view.container, `${CHAPTERS}/第二章-进展.md`)
    fireEvent.pointerDown(row, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 0, clientY: 0 })
    // 300ms 内右键 → 重命名：清除 pending timer
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("重命名"))
    expect(within(row).getByRole("textbox")).toBeInTheDocument()
    // timer 已清：advance 后无拖拽
    act(() => { vi.advanceTimersByTime(300) })
    await act(async () => {})
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(row.className).not.toContain("ring-2")
    vi.useRealTimers()
    view.unmount()
  })

  it("创建菜单：mousedown 冒泡拦截；outline 新建文件夹变体", async () => {
    const onRequestCreate = vi.fn()
    const view = render(<KnowledgeTree filterType="outline" onRequestCreate={onRequestCreate} />)
    await screen.findByText("全书大纲")
    fireEvent.contextMenu(screen.getByText("大纲"))
    expect(screen.getByText("新建大纲")).toBeInTheDocument()
    // mousedown 不冒泡到 document → 菜单保持打开
    const menu = screen.getByText("新建大纲").closest("div.absolute") as HTMLElement
    fireEvent.mouseDown(within(menu).getByText("新建文件夹"))
    expect(screen.getByText("新建大纲")).toBeInTheDocument()
    // outline → folder 变体
    fireEvent.click(screen.getByText("新建文件夹"))
    expect(onRequestCreate).toHaveBeenCalledWith({ kind: "folder", parentDir: undefined })
    view.unmount()
  })

  it("outline 坏文件菜单：rename 无 target 不触发；newFolder parentDir undefined", async () => {
    const onRequestCreate = vi.fn()
    const view = render(<KnowledgeTree filterType="outline" onRequestCreate={onRequestCreate} />)
    await screen.findByText("坏文件")
    const row = pageRow(view.container, `${OUTLINES}/坏文件.md`)
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("重命名"))
    expect(within(row).queryByRole("textbox")).not.toBeInTheDocument()
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("新建文件夹"))
    expect(onRequestCreate).toHaveBeenCalledWith({ kind: "folder", parentDir: undefined })
    view.unmount()
  })

  it("移动子菜单：再次点击 moveToVolume 关闭子菜单；禁用卷点击不移动", async () => {
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    const row = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    fireEvent.contextMenu(row)
    const menu = screen.getByText("重命名").closest("div.absolute") as HTMLElement
    // 页面菜单 mousedown 冒泡拦截
    fireEvent.mouseDown(within(menu).getByText("重命名"))
    expect(within(menu).getByText("重命名")).toBeInTheDocument()
    fireEvent.click(within(menu).getByText("移动到卷"))
    expect(menu.querySelector(".max-h-48")).not.toBeNull()
    fireEvent.click(within(menu).getByText("移动到卷"))
    expect(menu.querySelector(".max-h-48")).toBeNull()
    // 卷内页面：当前卷按钮禁用 → 点击不触发移动
    const volRow = pageRow(view.container, `${CHAPTERS}/卷1/第一章-开端.md`)
    fireEvent.contextMenu(volRow)
    const volMenu = screen.getByText("重命名").closest("div.absolute") as HTMLElement
    fireEvent.click(within(volMenu).getByText("移动到卷"))
    const volBtn = volMenu.querySelector(".max-h-48 button") as HTMLButtonElement
    expect(volBtn.hasAttribute("disabled")).toBe(true)
    fireEvent.click(volBtn)
    expect(mocks.copyFile).not.toHaveBeenCalled()
    view.unmount()
  })

  it("章节排序：章号提取各分支（数字/中文/十/混合/无效/数字回退）", async () => {
    const wiki = [
      dirNode("chapters", CHAPTERS, [
        fileNode("第一章-甲.md", `${CHAPTERS}/第一章-甲.md`),
        fileNode("第十章-乙.md", `${CHAPTERS}/第十章-乙.md`),
        fileNode("第十一章-丙.md", `${CHAPTERS}/第十一章-丙.md`),
        fileNode("第二十三章-丁.md", `${CHAPTERS}/第二十三章-丁.md`),
        fileNode("第1二章-戊.md", `${CHAPTERS}/第1二章-戊.md`),
        fileNode("番外2010.md", `${CHAPTERS}/番外2010.md`),
        fileNode("序章-己.md", `${CHAPTERS}/序章-己.md`),
      ]),
      dirNode("outlines", OUTLINES, []),
      fileNode("index.md", `${PROJ}/wiki/index.md`),
      fileNode("log.md", `${PROJ}/wiki/log.md`),
    ]
    const contents: Record<string, string> = {
      [`${CHAPTERS}/第一章-甲.md`]: "# 第一章-甲\n内容",
      [`${CHAPTERS}/第十章-乙.md`]: "# 第十章-乙\n内容",
      [`${CHAPTERS}/第十一章-丙.md`]: "# 第十一章-丙\n内容",
      [`${CHAPTERS}/第二十三章-丁.md`]: "# 第二十三章-丁\n内容",
      [`${CHAPTERS}/第1二章-戊.md`]: "# 第1二章-戊\n内容",
      [`${CHAPTERS}/番外2010.md`]: "# 番外2010\n内容",
      [`${CHAPTERS}/序章-己.md`]: "# 序章-己\n内容",
    }
    mocks.listDirectory.mockImplementation(async (p: string) => {
      if (p === `${PROJ}/wiki`) return wiki
      if (p === PROJ) return [dirNode("wiki", `${PROJ}/wiki`, wiki)]
      return []
    })
    mocks.readFile.mockImplementation(async (p: string) => contents[p] ?? "")
    mocks.wikiState.fileTree = [dirNode("wiki", `${PROJ}/wiki`, wiki)]
    const view = renderTree()
    await screen.findByText("第一章-甲")
    const paths = [...view.container.querySelectorAll("[data-page-path]")].map((el) => el.getAttribute("data-page-path"))
    // 前两位为 1（第一章-甲 与 第1二章-戊，数字回退→1）
    expect(paths.slice(0, 2).sort()).toEqual([`${CHAPTERS}/第一章-甲.md`, `${CHAPTERS}/第1二章-戊.md`].sort())
    expect(paths[2]).toBe(`${CHAPTERS}/第十章-乙.md`)      // 十 → 10
    expect(paths[3]).toBe(`${CHAPTERS}/第十一章-丙.md`)    // 十一 → 11
    expect(paths[4]).toBe(`${CHAPTERS}/第二十三章-丁.md`)  // 二十三 → 23
    expect(paths[5]).toBe(`${CHAPTERS}/番外2010.md`)       // 数字回退 → 2010
    expect(paths[6]).toBe(`${CHAPTERS}/序章-己.md`)        // 无号 → 最后
    view.unmount()
  })
})

// ── RawSourcesSection ────────────────────────────────────────────────────────

describe("RawSourcesSection", () => {
  it("无项目/无任务：展开显示暂无提取任务", async () => {
    mocks.wikiState.project = null
    const view = render(<RawSourcesSection />)
    expect(screen.getByText("提取中")).toBeInTheDocument()
    expect(screen.queryByText("暂无提取任务")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("提取中"))
    expect(screen.getByText("暂无提取任务")).toBeInTheDocument()
    fireEvent.click(screen.getByText("提取中"))
    expect(screen.queryByText("暂无提取任务")).not.toBeInTheDocument()
    view.unmount()
  })

  it("running 任务自动展开 + 进度/计数 + 取消按钮 + 其他项目任务过滤", async () => {
    mocks.importState.tasks = [
      makeTask({ id: "t1", kind: "outline", status: "running", completed: 1, total: 2, currentTitle: "", updatedAt: 2 }),
      makeTask({ id: "t-other", projectPath: "/other", kind: "chapter", status: "running", updatedAt: 9 }),
    ]
    const view = render(<RawSourcesSection />)
    // 自动展开
    expect(screen.getByText("AI 大纲提取中")).toBeInTheDocument()
    expect(screen.getByText("50%")).toBeInTheDocument()
    expect(screen.getByText("1/2 · AI 大纲")).toBeInTheDocument()
    expect(screen.getByText("1 个任务运行中")).toBeInTheDocument()
    expect(screen.queryByText(/其他项目/)).not.toBeInTheDocument()
    expect(view.container.querySelector(".bg-primary")).not.toBeNull()
    fireEvent.click(screen.getByText("停止"))
    expect(mocks.importState.cancelTask).toHaveBeenCalledWith("t1")
    view.unmount()
  })

  it("批量提取行：仅取消所选 batch 任务，不触其它行", async () => {
    mocks.importState.tasks = [
      makeTask({ id: "tb", kind: "batch_extraction", status: "running", completed: 1, total: 3, currentTitle: "batch chapter", updatedAt: 5 }),
      makeTask({ id: "to", kind: "outline_generation", status: "running", completed: 0, total: 1, currentTitle: "", updatedAt: 6 }),
      makeTask({ id: "tx", projectPath: "/other", kind: "batch_extraction", status: "running", updatedAt: 7 }),
    ]
    render(<RawSourcesSection />)
    const row = screen.getByText("batch chapter").closest("div.flex.items-center.justify-between")! as HTMLElement
    fireEvent.click(within(row).getByRole("button", { name: "停止" }))
    expect(mocks.importState.cancelTask).toHaveBeenCalledTimes(1)
    expect(mocks.importState.cancelTask).toHaveBeenCalledWith("tb")
  })

  it("running：cancelling 文案 + currentTitle + total=0 + completed=0", async () => {
    mocks.importState.tasks = [
      makeTask({ id: "t1", kind: "outline", status: "running", completed: 0, total: 0, currentTitle: "", cancelling: true }),
    ]
    const view = render(<RawSourcesSection />)
    expect(screen.getByText("正在取消AI 大纲提取...")).toBeInTheDocument()
    expect(screen.getByText("0%")).toBeInTheDocument()
    expect(screen.queryByText(/· AI 大纲/)).not.toBeInTheDocument()
    expect(screen.getByText("停止").closest("button")?.hasAttribute("disabled")).toBe(true)
    view.unmount()
    // currentTitle（非 cancelling）→ 显示 currentTitle（running → 仍显示停止按钮）
    mocks.importState.tasks = [
      makeTask({ id: "t2", kind: "outline_generation", status: "running", currentTitle: "第三章-草稿", cancelling: false }),
    ]
    const view2 = render(<RawSourcesSection />)
    expect(screen.getByText("第三章-草稿")).toBeInTheDocument()
    expect(screen.getByText("停止")).toBeInTheDocument()
    view2.unmount()
  })

  it("未知状态任务：无 message → 空标签（?? 回退）", async () => {
    mocks.importState.tasks = [makeTask({ id: "t6", kind: "chapter", status: "weird" })]
    const view = render(<RawSourcesSection />)
    fireEvent.click(screen.getByText("提取中"))
    const emptyLabel = [...view.container.querySelectorAll("span")].find((s) => s.textContent === "" && s.className === "")
    expect(emptyLabel).toBeDefined()
    expect(screen.queryByText("停止")).not.toBeInTheDocument()
    view.unmount()
  })

  it("done/error/cancelled/未知状态 + kind 标签分支", async () => {
    mocks.importState.tasks = [
      makeTask({ id: "t1", kind: "outline", status: "done", currentTitle: "", completed: 2, total: 2, updatedAt: 5 }),
      makeTask({ id: "t2", kind: "outline_generation", status: "error", currentTitle: "", updatedAt: 4 }),
      makeTask({ id: "t3", kind: "outline_refinement", status: "cancelled", currentTitle: "", updatedAt: 3 }),
      makeTask({ id: "t4", kind: "chapter", status: "done", currentTitle: "", updatedAt: 2 }),
      makeTask({ id: "t5", kind: "outline", status: "weird", message: "未知消息", updatedAt: 1 }),
    ]
    const view = render(<RawSourcesSection />)
    // 非 running → 初始折叠
    expect(screen.queryByText("AI 大纲提取完成")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("提取中"))
    expect(screen.getByText("AI 大纲提取完成")).toBeInTheDocument()
    expect(screen.getByText("生成大纲提取失败")).toBeInTheDocument()
    expect(screen.getByText("细化生成提取已取消")).toBeInTheDocument()
    expect(screen.getByText("章节提取完成")).toBeInTheDocument()
    expect(screen.getByText("未知消息")).toBeInTheDocument()
    expect(screen.queryByText("停止")).not.toBeInTheDocument()
    // 按 updatedAt 降序
    const titles = [...view.container.querySelectorAll(".truncate")].map((el) => el.textContent)
    expect(titles[0]).toBe("AI 大纲提取完成")
    view.unmount()
  })

  it("pending/skipped 任务：渲染 Clock/MinusCircle 图标并给 .truncate 设置完整 title", async () => {
    mocks.importState.tasks = [
      makeTask({ id: "t-pending-msg", kind: "chapter", status: "pending", message: "等待主控同步记忆", updatedAt: 4 }),
      makeTask({ id: "t-pending-default", kind: "outline", status: "pending", updatedAt: 3 }),
      makeTask({ id: "t-skipped-msg", kind: "chapter", status: "skipped", message: "未配置模型已跳过", updatedAt: 2 }),
      makeTask({ id: "t-skipped-default", kind: "outline_generation", status: "skipped", updatedAt: 1 }),
    ]
    const view = render(<RawSourcesSection />)
    fireEvent.click(screen.getByText("提取中"))

    expect(screen.getByText("等待主控同步记忆")).toBeInTheDocument()
    expect(screen.getByText("AI 大纲待处理")).toBeInTheDocument()
    expect(screen.getByText("未配置模型已跳过")).toBeInTheDocument()
    expect(screen.getByText("生成大纲已跳过")).toBeInTheDocument()

    // 2 个 pending → 2 个 Clock 图标；2 个 skipped → 2 个 MinusCircle 图标
    expect(view.container.querySelectorAll("svg.lucide-clock").length).toBe(2)
    expect(view.container.querySelectorAll("svg.lucide-circle-minus, svg.lucide-minus-circle").length).toBe(2)

    // .truncate span 具备完整 title 属性用于截断悬停提示
    const truncatedTitles = [...view.container.querySelectorAll(".truncate")].map((el) => el.getAttribute("title"))
    expect(truncatedTitles).toEqual([
      "等待主控同步记忆",
      "AI 大纲待处理",
      "未配置模型已跳过",
      "生成大纲已跳过",
    ])
    view.unmount()
  })
})

describe("BatchExtractScopeDialog 草稿保留/丢弃回归", () => {
  const readyQueue: BatchExtractQueueState = {
    projectPath: "/proj",
    status: "done",
    budget: 20,
    admitted: [1],
    skippedByBudget: [],
    drafts: [{ chapter: 1, status: "ready", updatedAt: 0, snapshot: { chapterNumber: 1 } as never, source: { readPath: "/proj/wiki/chapters/c1.md", chapterNumber: 1, bodySha256: "b", contentSha256: "c" } }],
    completed: 0,
    failed: 0,
    previousOutcomes: [{ path: "/proj/wiki/chapters/c1.md", chapterNumber: 1, status: "failed", reason: "fixture" } as never],
  }
  const uncertainQueue: BatchExtractQueueState = {
    projectPath: "/proj",
    status: "done",
    budget: 20,
    admitted: [2],
    skippedByBudget: [],
    drafts: [{ chapter: 2, status: "uncertain", updatedAt: 0, snapshot: { chapterNumber: 2 } as never, source: { readPath: "/proj/wiki/chapters/c2.md", chapterNumber: 2, bodySha256: "b2", contentSha256: "c2" } }],
    completed: 0,
    failed: 0,
  }
  const okScan = { total: 2, chapters: [], pending: [{ chapterNumber: 2, path: "/proj/wiki/chapters/c2.md", status: "missing_memory" as const }], errors: [], paths: { 2: "/proj/wiki/chapters/c2.md" }, excluded: { invalid: 0, nonFinal: 0, unreadable: 0, duplicateChapters: [] } }

  beforeEach(() => {
    mocks.importState.tasks = []
    mocks.readBatchQueue.mockReturnValue(null)
    mocks.restoreBatchQueue.mockImplementation(async () => mocks.readBatchQueue())
    mocks.discardBatch.mockResolvedValue(false)
    mocks.resetCorruptBatch.mockResolvedValue("/proj/.novel/backup.json")
    mocks.setAsideBatch.mockResolvedValue(true)
    mocks.scanBackfill.mockResolvedValue(okScan)
  })

  it("ready 草稿存在 → Start 禁用 + 内联二次确认丢弃（取消不执行、确认后执行）", async () => {
    mocks.readBatchQueue.mockReturnValue(readyQueue)
    mocks.discardBatch.mockImplementationOnce(async () => {
      mocks.readBatchQueue.mockReturnValue(null)
      return true
    })
    const view = render(<BatchExtractScopeDialog open projectPath="/proj" onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole("button", { name: "丢弃待确认草稿" })).toBeInTheDocument())
    expect(screen.getByRole("button", { name: "开始批量提取" })).toBeDisabled()

    // 点击丢弃 → 弹出内联确认条，绝不调 window.confirm，也未立即执行 discard
    fireEvent.click(screen.getByRole("button", { name: "丢弃待确认草稿" }))
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.discardBatch).not.toHaveBeenCalled()
    const confirmBox = screen.getByTestId("batch-extract-inline-confirm")
    expect(confirmBox).toHaveAttribute("role", "alertdialog")
    expect(confirmBox).toHaveTextContent(lookupZhLocale("extract.batchDiscardConfirm")!)

    // 点击取消 → 收起确认条且不调用 discardBatch
    fireEvent.click(within(confirmBox).getByRole("button", { name: "取消" }))
    expect(screen.queryByTestId("batch-extract-inline-confirm")).not.toBeInTheDocument()
    expect(mocks.discardBatch).not.toHaveBeenCalled()

    // 再次点击丢弃并确认 → 调用 discardBatch 并刷新状态
    fireEvent.click(screen.getByRole("button", { name: "丢弃待确认草稿" }))
    const confirmBox2 = screen.getByTestId("batch-extract-inline-confirm")
    fireEvent.click(within(confirmBox2).getByRole("button", { name: "确认" }))
    await waitFor(() => expect(mocks.discardBatch).toHaveBeenCalledWith("/proj", readyQueue))
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(screen.queryByTestId("batch-extract-inline-confirm")).not.toBeInTheDocument()
    view.unmount()
  })

  it("resetCorrupt 工件损坏 → 内联二次确认（取消不执行、确认后备份并重扫）", async () => {
    mocks.restoreBatchQueue
      .mockRejectedValueOnce(new CorruptBatchDraftArtifactError("fp-corrupt-1"))
      .mockResolvedValueOnce(null)
    const view = render(<BatchExtractScopeDialog open projectPath="/proj" onClose={vi.fn()} />)
    const resetBtn = await screen.findByRole("button", { name: lookupZhLocale("extract.batchResetCorrupt")! })
    fireEvent.click(resetBtn)
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.resetCorruptBatch).not.toHaveBeenCalled()

    const confirmBox = screen.getByTestId("batch-extract-inline-confirm")
    expect(confirmBox).toHaveAttribute("role", "alertdialog")
    expect(confirmBox).toHaveTextContent(lookupZhLocale("extract.batchResetCorruptConfirm")!)

    // 取消 → 收起且不调用 resetCorruptBatch
    fireEvent.click(within(confirmBox).getByRole("button", { name: "取消" }))
    expect(screen.queryByTestId("batch-extract-inline-confirm")).not.toBeInTheDocument()
    expect(mocks.resetCorruptBatch).not.toHaveBeenCalled()

    // 确认 → 执行 resetCorruptBatch 并触发重扫
    fireEvent.click(resetBtn)
    fireEvent.click(within(screen.getByTestId("batch-extract-inline-confirm")).getByRole("button", { name: "确认" }))
    await waitFor(() => expect(mocks.resetCorruptBatch).toHaveBeenCalledWith("/proj", "fp-corrupt-1"))
    expect(mocks.confirm).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByTestId("batch-extract-inline-confirm")).not.toBeInTheDocument())
    view.unmount()
  })

  it("setAside 中断草稿 → 内联二次确认（取消不执行、确认后搁置）", async () => {
    mocks.readBatchQueue.mockReturnValue(uncertainQueue)
    mocks.setAsideBatch.mockImplementationOnce(async () => {
      mocks.readBatchQueue.mockReturnValue(null)
      return true
    })
    const view = render(<BatchExtractScopeDialog open projectPath="/proj" onClose={vi.fn()} />)
    const setAsideBtn = await screen.findByRole("button", { name: lookupZhLocale("extract.batchSetAside")! })
    fireEvent.click(setAsideBtn)
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.setAsideBatch).not.toHaveBeenCalled()

    const confirmBox = screen.getByTestId("batch-extract-inline-confirm")
    expect(confirmBox).toHaveAttribute("role", "alertdialog")
    expect(confirmBox).toHaveTextContent(lookupZhLocale("extract.batchSetAsideConfirm")!)

    // 取消 → 收起且不调用 setAsideBatch
    fireEvent.click(within(confirmBox).getByRole("button", { name: "取消" }))
    expect(screen.queryByTestId("batch-extract-inline-confirm")).not.toBeInTheDocument()
    expect(mocks.setAsideBatch).not.toHaveBeenCalled()

    // 确认 → 执行 setAsideBatch
    fireEvent.click(setAsideBtn)
    fireEvent.click(within(screen.getByTestId("batch-extract-inline-confirm")).getByRole("button", { name: "确认" }))
    await waitFor(() => expect(mocks.setAsideBatch).toHaveBeenCalledWith("/proj", uncertainQueue))
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(screen.queryByTestId("batch-extract-inline-confirm")).not.toBeInTheDocument()
    view.unmount()
  })

  it("budget 输入框越界夹取 [1, 60]、小数截断与忽略非有限输入", async () => {
    const view = render(<BatchExtractScopeDialog open projectPath="/proj" onClose={vi.fn()} />)
    const budgetInput = await screen.findByTestId("batch-budget-input") as HTMLInputElement
    const maxBudget = Number(budgetInput.max)
    expect(maxBudget).toBe(60)

    // 下界夹取：0 与负数 → 1
    fireEvent.change(budgetInput, { target: { value: "0" } })
    expect(budgetInput.value).toBe("1")
    fireEvent.change(budgetInput, { target: { value: "-5" } })
    expect(budgetInput.value).toBe("1")

    // 上界夹取：超过 budgetMax → budgetMax (60)
    fireEvent.change(budgetInput, { target: { value: String(maxBudget + 50) } })
    expect(budgetInput.value).toBe(String(maxBudget))

    // 小数整数截断
    fireEvent.change(budgetInput, { target: { value: "3.9" } })
    expect(budgetInput.value).toBe("3")

    // 非有限/空输入 → 忽略，保持上一次有效值
    fireEvent.change(budgetInput, { target: { value: "" } })
    expect(budgetInput.value).toBe("3")
    fireEvent.change(budgetInput, { target: { value: "abc" } })
    expect(budgetInput.value).toBe("3")
    view.unmount()
  })

  it("P1-03 起止章号范围筛选与起>止错误提示", async () => {
    mocks.scanBackfill.mockResolvedValueOnce({
      total: 4,
      chapters: [1, 2, 3, 4],
      pending: [
        { chapter: 1, reason: "missing_optional_field", missingFields: [], revision: null },
        { chapter: 2, reason: "missing_optional_field", missingFields: [], revision: null },
        { chapter: 3, reason: "missing_optional_field", missingFields: [], revision: null },
        { chapter: 4, reason: "missing_optional_field", missingFields: [], revision: null },
      ],
      errors: [],
      paths: {},
      excluded: { invalid: 0, nonFinal: 0, unreadable: 0, duplicateChapters: [], duplicateChapterPaths: {} },
    })
    const view = render(<BatchExtractScopeDialog open projectPath="/proj" onClose={vi.fn()} />)
    const startInput = await screen.findByTestId("batch-range-start")
    const endInput = screen.getByTestId("batch-range-end")

    fireEvent.change(startInput, { target: { value: "2" } })
    fireEvent.change(endInput, { target: { value: "3" } })
    expect(screen.getByText(/将提取.*::\{"count":2,"skipped":0\}/)).toBeInTheDocument()

    // 起始 > 结束 → 渲染 role="alert" 且可提取数为 0
    fireEvent.change(startInput, { target: { value: "5" } })
    expect(screen.getByRole("alert")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "开始批量提取" })).toBeDisabled()
    view.unmount()
  })

  it("P1-03 同号正式章冲突排查卡：展示 duplicateChapterPaths、支持打开定位与一键顺延章号后重扫", async () => {
    const dupA = `${CHAPTERS}/第3章-正本.md`
    const dupB = `${CHAPTERS}/第3章-副本.md`
    mocks.readFile.mockImplementation(async (p: string) => {
      if (p === dupB) {
        return "---\ntype: chapter\ntitle: \"第3章-副本\"\nchapter_number: 3\nchapter_status: final\n---\n# 第3章-副本\n副本正文"
      }
      return CONTENTS[p] ?? ""
    })
    mocks.scanBackfill
      .mockResolvedValueOnce({
        total: 1,
        chapters: [1],
        pending: [],
        errors: [`第 3 章发现 2 个正式章文件，全部跳过：${dupA}, ${dupB}`],
        paths: { 1: `${CHAPTERS}/卷1/第一章-开端.md` },
        excluded: {
          invalid: 0,
          nonFinal: 0,
          unreadable: 0,
          duplicateChapters: [3],
          duplicateChapterPaths: { 3: [dupA, dupB] },
        },
      })
      .mockResolvedValueOnce({
        total: 2,
        chapters: [1, 3],
        pending: [],
        errors: [],
        paths: { 1: `${CHAPTERS}/卷1/第一章-开端.md`, 3: dupA },
        excluded: { invalid: 0, nonFinal: 0, unreadable: 0, duplicateChapters: [], duplicateChapterPaths: {} },
      })

    const onClose = vi.fn()
    const view = render(<BatchExtractScopeDialog open projectPath={PROJ} onClose={onClose} />)
    const card = await screen.findByTestId("batch-duplicate-conflict-card")
    expect(within(card).getByText("第3章-正本.md")).toBeInTheDocument()
    expect(within(card).getByText("第3章-副本.md")).toBeInTheDocument()

    // 一键顺延章号 → 原子写新文件、删旧文件、刷新并触发重扫
    const relocateBtn = within(card).getByTestId("batch-relocate-duplicate")
    fireEvent.click(relocateBtn)
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled())
    expect(mocks.deleteFile).toHaveBeenCalledWith(dupB)
    expect(mocks.wikiState.bumpDataVersion).toHaveBeenCalled()
    await waitFor(() => expect(mocks.scanBackfill).toHaveBeenCalledTimes(2))

    // 再测试「打开定位」
    mocks.scanBackfill.mockResolvedValueOnce({
      total: 1,
      chapters: [1],
      pending: [],
      errors: [],
      paths: {},
      excluded: {
        invalid: 0,
        nonFinal: 0,
        unreadable: 0,
        duplicateChapters: [3],
        duplicateChapterPaths: { 3: [dupA, dupB] },
      },
    })
    view.unmount()
    const view2 = render(<BatchExtractScopeDialog open projectPath={PROJ} onClose={onClose} />)
    const card2 = await screen.findByTestId("batch-duplicate-conflict-card")
    const locateButtons = within(card2).getAllByRole("button", { name: /打开定位|batchDuplicateLocate/ })
    fireEvent.click(locateButtons[0])
    expect(mocks.wikiState.setSelectedFile).toHaveBeenCalledWith(dupA)
    expect(onClose).toHaveBeenCalled()
    view2.unmount()
  })

  it("采纳成功 → 重新扫描刷新候选，队列清空后 Start 仍禁用", async () => {
    mocks.scanBackfill.mockResolvedValueOnce(okScan).mockResolvedValueOnce({ ...okScan, pending: [] })
    mocks.readBatchQueue.mockReturnValue(readyQueue)
    mocks.acceptBatch.mockImplementationOnce(async () => {
      mocks.readBatchQueue.mockReturnValue(null)
      return { accepted: [1], failed: [], outcomes: [] }
    })
    const view = render(<BatchExtractScopeDialog open projectPath="/proj" onClose={vi.fn()} />)
    const accept = await screen.findByRole("button", { name: "accept 回填正式记忆" })
    await waitFor(() => expect(accept).toBeEnabled())
    fireEvent.click(accept)
    await waitFor(() => expect(mocks.scanBackfill).toHaveBeenCalledTimes(2))
    expect(mocks.scanBackfill).toHaveBeenLastCalledWith("/proj")
    await waitFor(() => expect(screen.getByRole("button", { name: "开始批量提取" })).toBeDisabled())
    view.unmount()
  })

  it("refreshes the candidates even if the acceptance receipt could not be saved", async () => {
    mocks.scanBackfill.mockResolvedValueOnce(okScan).mockResolvedValueOnce({ ...okScan, pending: [] })
    mocks.readBatchQueue.mockReturnValue(readyQueue)
    mocks.acceptBatch.mockImplementationOnce(async () => {
      mocks.readBatchQueue.mockReturnValue(null)
      throw new Error("synthetic receipt write failure")
    })
    const view = render(<BatchExtractScopeDialog open projectPath="/proj" onClose={vi.fn()} />)
    const accept = await screen.findByRole("button", { name: "accept 回填正式记忆" })
    await waitFor(() => expect(accept).toBeEnabled())
    fireEvent.click(accept)
    await waitFor(() => expect(mocks.scanBackfill).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole("button", { name: "开始批量提取" })).toBeDisabled())
    expect(screen.getByRole("status")).toHaveTextContent("synthetic receipt write failure")
    view.unmount()
  })
})

describe("KnowledgeTree — U4-02 章节重命名/移卷协调与围栏", () => {
  it("移卷：先于 listDirectory 完成 noteRelocation 与 setSelectedFile，支持反斜杠路径比对", async () => {
    const sourcePath = `${CHAPTERS}/第三章-高潮.md`
    const destPath = `${CHAPTERS}/卷1/第三章-高潮.md`
    // 模拟 Windows 反斜杠 selectedFile
    mocks.wikiState.selectedFile = sourcePath.replace(/\//g, "\\")
    const coordinator = getChapterWriteCoordinator()
    const seqBefore = coordinator.currentSequence()
    const events: string[] = []
    const unsub = coordinator.subscribe(sourcePath, (ev) => events.push(ev))

    const order: string[] = []
    let resolveList!: (nodes: FileNode[]) => void
    mocks.copyFile.mockImplementationOnce(async () => { order.push("copy") })
    mocks.deleteFile.mockImplementationOnce(async () => { order.push("delete") })
    mocks.wikiState.setSelectedFile.mockImplementation((p: string | null) => {
      order.push(`select:${p}`)
      mocks.wikiState.selectedFile = p
    })

    const view = renderTree()
    await screen.findByText("第三章-高潮")

    // 挂起移卷后的 loadPages listDirectory，验证在这之前 selectedFile 与 noteRelocation 已完成
    mocks.listDirectory.mockImplementationOnce(() => new Promise<FileNode[]>((resolve) => {
      order.push("listDirectory")
      resolveList = resolve
    }))

    const row = pageRow(view.container, sourcePath)
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("移动到卷"))
    const menu = screen.getByText("重命名").closest("div.absolute") as HTMLElement
    fireEvent.click(within(menu).getByText("卷1"))
    await waitFor(() => expect(order).toContain("listDirectory"))

    expect(order.indexOf("delete")).toBeLessThan(order.indexOf(`select:${destPath}`))
    expect(order.indexOf(`select:${destPath}`)).toBeLessThan(order.indexOf("listDirectory"))
    expect(coordinator.wasRelocatedSince(sourcePath, seqBefore)).toBe(true)
    expect(events).toContain("relocation")

    resolveList(defaultWikiTree())
    await flush()
    unsub()
    view.unmount()
  })

  it("移卷被采纳栅栏拦截 → toast.error 提示且零 copy/delete", async () => {
    const sourcePath = `${CHAPTERS}/第三章-高潮.md`
    const coordinator = getChapterWriteCoordinator()
    const begin = coordinator.beginAdoption(sourcePath, {})
    expect(begin.ok).toBe(true)

    const view = renderTree()
    await screen.findByText("第三章-高潮")
    const row = pageRow(view.container, sourcePath)
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("移动到卷"))
    const menu = screen.getByText("重命名").closest("div.absolute") as HTMLElement
    fireEvent.click(within(menu).getByText("卷1"))
    await flush()

    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining("正在被保存或采纳"))
    expect(mocks.copyFile).not.toHaveBeenCalled()
    expect(mocks.deleteFile).not.toHaveBeenCalled()
    if (begin.ok && begin.lease) coordinator.releaseAdoption(begin.lease)
    view.unmount()
  })

  it("章节重命名被采纳栅栏拦截 → toast.error 提示且零写盘/删旧", async () => {
    const sourcePath = `${CHAPTERS}/第三章-高潮.md`
    const coordinator = getChapterWriteCoordinator()
    const begin = coordinator.beginAdoption(sourcePath, {})
    expect(begin.ok).toBe(true)

    const view = renderTree()
    await screen.findByText("第三章-高潮")
    const row = pageRow(view.container, sourcePath)
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("重命名"))
    const input = within(row).getByRole("textbox")
    fireEvent.change(input, { target: { value: "第四章-被拦重命名" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await flush()

    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining("正在被保存或采纳"))
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(mocks.deleteFile).not.toHaveBeenCalled()
    if (begin.ok && begin.lease) coordinator.releaseAdoption(begin.lease)
    view.unmount()
  })

  it("并发竞态：知识树重命名挂起在 readFile 期间原路径被编辑区迁移 → relocated 拦截并 toast.error", async () => {
    const sourcePath = `${CHAPTERS}/第三章-高潮.md`
    const coordinator = getChapterWriteCoordinator()
    const view = renderTree()
    await screen.findByText("第三章-高潮")

    let resolveRead!: (content: string) => void
    mocks.readFile.mockImplementationOnce(() => new Promise<string>((resolve) => { resolveRead = resolve }))

    const row = pageRow(view.container, sourcePath)
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("重命名"))
    const input = within(row).getByRole("textbox")
    fireEvent.change(input, { target: { value: "第四章-树改名" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await flush()

    // 模拟编辑区在 readFile 挂起期间完成重定位
    const editorIntent = coordinator.captureIntent("title", sourcePath)
    coordinator.noteRelocation(editorIntent, sourcePath, `${CHAPTERS}/第3章-编辑区改名.md`)

    resolveRead(CONTENTS[sourcePath])
    await flush()

    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining("已发生重命名或移动"))
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(mocks.deleteFile).not.toHaveBeenCalled()
    view.unmount()
  })

  it("并发串行：编辑区在途写入未落定时，知识树移卷必须等待前驱写盘完成后才执行 copy+delete", async () => {
    const sourcePath = `${CHAPTERS}/第三章-高潮.md`
    const coordinator = getChapterWriteCoordinator()
    const order: string[] = []
    let finishEditorWrite!: () => void
    const editorWriteIntent = coordinator.captureIntent("debounce-save", sourcePath)
    const editorAdm = coordinator.admitMutation(editorWriteIntent, [sourcePath], async () => {
      order.push("editor-write:start")
      await new Promise<void>((resolve) => { finishEditorWrite = resolve })
      order.push("editor-write:end")
    })
    expect(editorAdm.kind).toBe("admitted")
    mocks.copyFile.mockImplementationOnce(async () => { order.push("tree-move:copy") })
    mocks.deleteFile.mockImplementationOnce(async () => { order.push("tree-move:delete") })

    const view = renderTree()
    await screen.findByText("第三章-高潮")
    const row = pageRow(view.container, sourcePath)
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("移动到卷"))
    const menu = screen.getByText("重命名").closest("div.absolute") as HTMLElement
    fireEvent.click(within(menu).getByText("卷1"))
    await flush()

    // 编辑区写入未落定前，copyFile 尚未执行
    expect(mocks.copyFile).not.toHaveBeenCalled()
    finishEditorWrite()
    await flush()

    expect(order).toEqual(["editor-write:start", "editor-write:end", "tree-move:copy", "tree-move:delete"])
    view.unmount()
  })

  it("BLK-02：编辑区在途写盘挂起时触发知识树重命名，等待落盘后重读最新正文并保留编辑区新提交内容", async () => {
    const sourcePath = `${CHAPTERS}/第三章-高潮.md`
    const targetPath = `${CHAPTERS}/第4章-新篇章.md`
    const coordinator = getChapterWriteCoordinator()
    const disk = new Map<string, string>([
      ...Object.entries(CONTENTS),
    ])
    const order: string[] = []
    let finishEditorWrite!: () => void

    mocks.readFile.mockImplementation(async (p: string) => {
      if (p === sourcePath) order.push(`read:${disk.get(p)?.includes("编辑区刚落盘的新正文") ? "latest" : "old"}`)
      return disk.get(p) ?? ""
    })
    mocks.writeFileAtomic.mockImplementation(async (p: string, content: string) => {
      order.push(`write:${p}`)
      disk.set(p, content)
    })

    const view = renderTree()
    await screen.findByText("第三章-高潮")
    order.length = 0

    // 编辑区已准入一笔正文/终稿写盘，尚未落盘
    const editorIntent = coordinator.captureIntent("final-save", sourcePath)
    const editorAdm = coordinator.admitMutation(editorIntent, [sourcePath], async () => {
      order.push("editor-write:start")
      await new Promise<void>((resolve) => { finishEditorWrite = resolve })
      disk.set(sourcePath, "---\nchapter_status: final\n---\n# 第三章-高潮\n编辑区刚落盘的新正文")
      order.push("editor-write:end")
    })
    expect(editorAdm.kind).toBe("admitted")
    // 让前驱微任务进入执行态，确保编辑区写盘已真正处于在途状态
    await flush()

    // 在编辑区写盘挂起期间触发知识树重命名（外层预读拿到的还是旧 draft 正文）
    const row = pageRow(view.container, sourcePath)
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("重命名"))
    const input = within(row).getByRole("textbox")
    fireEvent.change(input, { target: { value: "第四章-新篇章" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await flush()

    // 编辑区写盘未落定前，知识树不得写新文件
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()

    finishEditorWrite()
    await flush()

    // 断言重命名临界区在 editor-write:end 之后才重读最新正文并写入 targetPath（后续 loadPages 读盘不计入）
    expect(order.slice(0, 5)).toEqual([
      "editor-write:start",
      "read:old",
      "editor-write:end",
      "read:latest",
      `write:${targetPath}`,
    ])
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      targetPath,
      expect.stringContaining("编辑区刚落盘的新正文"),
    )
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      targetPath,
      expect.stringContaining("chapter_status: final"),
    )
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      targetPath,
      expect.stringContaining('title: "第4章-新篇章"'),
    )
    view.unmount()
  })

  it("R2-U05 章节删除受采纳栅栏拦截，正常删除时标记重定位防编辑区复活并清 finalChapterSave", async () => {
    const targetPath = `${CHAPTERS}/第三章-高潮.md`
    const coordinator = getChapterWriteCoordinator()
    const begin = coordinator.beginAdoption(targetPath, {})
    expect(begin.ok).toBe(true)

    const view = renderTree()
    await screen.findByText("第三章-高潮")
    const row = pageRow(view.container, targetPath)
    // 二次点击触发删除
    const deleteBtn1 = within(row).getByTitle(/移入回收站/)
    fireEvent.click(deleteBtn1)
    const confirmBtn1 = within(row).getByRole("button", { name: /确认/ })
    fireEvent.click(confirmBtn1)
    await flush()

    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining("正在被保存或采纳"))
    expect(mocks.moveFileToTrash).not.toHaveBeenCalled()
    if (begin.ok && begin.lease) coordinator.releaseAdoption(begin.lease)

    // 栅栏释放后删除成功：markDeleted 触发 relocation、清 finalChapterSave 并清 selectedFile
    mocks.wikiState.selectedFile = targetPath
    const seqBefore = coordinator.currentSequence()
    const deleteBtn2 = within(row).getByTitle(/移入回收站/)
    fireEvent.click(deleteBtn2)
    const confirmBtn2 = within(row).getByRole("button", { name: /确认/ })
    fireEvent.click(confirmBtn2)
    await waitFor(() => expect(mocks.moveFileToTrash).toHaveBeenCalledWith(PROJ, targetPath, "chapter"))
    expect(coordinator.wasRelocatedSince(targetPath, seqBefore)).toBe(true)
    expect(mocks.wikiState.clearFinalChapterSaveForPath).toHaveBeenCalledWith(targetPath)
    expect(mocks.wikiState.setSelectedFile).toHaveBeenCalledWith(null)
    view.unmount()
  })

  it("R2-U08 BatchExtractScopeDialog 运行期展示进度条、支持取消、cancelling 禁用按钮并拦截关窗", async () => {
    const onClose = vi.fn()
    mocks.importState.tasks = [{
      id: "batch-1",
      projectPath: "/proj",
      kind: "batch_extraction",
      status: "running",
      completed: 2,
      total: 5,
      currentTitle: "第 3 章",
      cancelling: false,
      createdAt: 1,
      updatedAt: 2,
    }]
    const view = render(<BatchExtractScopeDialog open projectPath="/proj" onClose={onClose} />)

    const progressEl = await screen.findByTestId("batch-extract-progress")
    expect(progressEl).toBeInTheDocument()
    const bar = within(progressEl).getByRole("progressbar")
    expect(bar).toHaveAttribute("aria-valuenow", "2")
    expect(bar).toHaveAttribute("aria-valuemax", "5")

    const cancelBtn = within(progressEl).getByTestId("batch-extract-cancel")
    expect(cancelBtn).not.toBeDisabled()
    fireEvent.click(cancelBtn)
    expect(mocks.importState.cancelTask).toHaveBeenCalledWith("batch-1")

    // 运行期关闭按钮禁用且不可通过 Escape 关闭
    const closeBtn = screen.getByRole("button", { name: "关闭" })
    expect(closeBtn).toBeDisabled()
    fireEvent.click(closeBtn)
    expect(onClose).not.toHaveBeenCalled()

    // cancelling=true 时禁用取消按钮
    mocks.importState.tasks = [{
      ...mocks.importState.tasks[0],
      cancelling: true,
    }]
    view.rerender(<BatchExtractScopeDialog open projectPath="/proj" onClose={onClose} />)
    expect(screen.getByTestId("batch-extract-cancel")).toBeDisabled()
    view.unmount()
  })
})
