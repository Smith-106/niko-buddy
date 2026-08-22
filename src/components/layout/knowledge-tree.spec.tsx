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
  }
  const importState = {
    tasks: [] as ImportTaskShape[],
    cancelTask: vi.fn(),
  }
  return {
    t: vi.fn((key: string, opts?: Record<string, unknown>) => (opts ? `${key}::${JSON.stringify(opts)}` : key)),
    wikiState,
    importState,
    readFile: vi.fn(),
    writeFile: vi.fn(),
    listDirectory: vi.fn(),
    deleteFile: vi.fn(),
    fileExists: vi.fn(),
    copyFile: vi.fn(),
    openFileLocation: vi.fn(),
    moveFileToTrash: vi.fn(),
    deleteNovelSourceMemory: vi.fn(),
    confirm: vi.fn<(message?: string) => boolean>(() => true),
    alert: vi.fn<(message?: string) => void>(() => {}),
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/i18n", () => ({
  default: { t: mocks.t },
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector(mocks.wikiState),
    { getState: () => mocks.wikiState },
  ),
}))

vi.mock("@/stores/import-progress-store", () => ({
  useImportProgressStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector(mocks.importState),
    { getState: () => mocks.importState },
  ),
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  listDirectory: mocks.listDirectory,
  deleteFile: mocks.deleteFile,
  fileExists: mocks.fileExists,
  copyFile: mocks.copyFile,
  openFileLocation: mocks.openFileLocation,
}))

vi.mock("@/lib/trash", () => ({
  moveFileToTrash: mocks.moveFileToTrash,
}))

vi.mock("@/lib/novel/delete-source-memory", () => ({
  deleteNovelSourceMemory: mocks.deleteNovelSourceMemory,
}))

import { KnowledgeTree, RawSourcesSection } from "./knowledge-tree"

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
  setupDomGlobals()
  mocks.t.mockImplementation((key: string, opts?: Record<string, unknown>) => (opts ? `${key}::${JSON.stringify(opts)}` : key))
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
  mocks.writeFile.mockResolvedValue(undefined)
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
    await waitFor(() => expect(screen.getByText("knowledgeTree.noProject")).toBeInTheDocument())
    expect(mocks.listDirectory).not.toHaveBeenCalled()
    view.unmount()
  })

  it("空文件树显示空态提示（chapter/outline 两个变体）", async () => {
    mocks.wikiState.fileTree = []
    const view = renderTree()
    await waitFor(() => expect(screen.getByText('knowledgeTree.emptyFiltered::{"label":"trash.kindChapter"}')).toBeInTheDocument())
    expect(screen.getByText("sidebar.knowledge")).toBeInTheDocument()
    view.unmount()

    mocks.wikiState.fileTree = []
    const view2 = render(<KnowledgeTree filterType="outline" />)
    await waitFor(() => expect(screen.getByText('knowledgeTree.emptyFiltered::{"label":"trash.kindOutline"}')).toBeInTheDocument())
    expect(screen.getByText("sidebar.files")).toBeInTheDocument()
    view2.unmount()
  })

  it("chapter 文件树渲染：卷/页/字数/来源图标/排序/非 md 过滤", async () => {
    const view = renderTree()
    await screen.findByText("第二章-进展")
    expect(screen.getByText("sidebar.knowledge")).toBeInTheDocument()
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

  it("outline 文件树渲染：文件夹在前、回退标题（读取失败页）、无字数标签", async () => {
    const view = render(<KnowledgeTree filterType="outline" />)
    await screen.findByText("全书大纲")
    expect(screen.getByText("sidebar.files")).toBeInTheDocument()
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

  it("文件夹展开/折叠切换", async () => {
    const view = renderTree()
    await screen.findByText("序章-开端")
    expect(screen.getByText("序章-开端")).toBeInTheDocument()
    fireEvent.click(screen.getByText("卷1"))
    expect(screen.queryByText("序章-开端")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("卷1"))
    expect(screen.getByText("序章-开端")).toBeInTheDocument()
    view.unmount()
  })

  it("删除：二次确认 + 回收站 + 记忆清理 + 状态刷新", async () => {
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    const row = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    fireEvent.click(within(row).getByTitle(/knowledgeTree\.deleteTitle/))
    expect(within(row).getByTitle(/confirmDeleteTitle/)).toBeInTheDocument()
    fireEvent.click(within(row).getByTitle(/confirmDeleteTitle/))
    expect(within(row).getByTitle(/deletingTitle/)).toBeInTheDocument()
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
    fireEvent.click(within(row).getByTitle(/knowledgeTree\.deleteTitle/))
    expect(within(row).getByTitle(/confirmDeleteTitle/)).toBeInTheDocument()
    // 非 Node target（守卫分支：armed 保持）
    const nonNode = new MouseEvent("mousedown", { bubbles: true })
    Object.defineProperty(nonNode, "target", { value: {} })
    act(() => document.dispatchEvent(nonNode))
    expect(within(row).getByTitle(/confirmDeleteTitle/)).toBeInTheDocument()
    // 外部 mousedown → 取消武装
    act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })))
    expect(within(row).queryByTitle(/confirmDeleteTitle/)).not.toBeInTheDocument()
    // Escape → 取消武装
    fireEvent.click(within(row).getByTitle(/knowledgeTree\.deleteTitle/))
    expect(within(row).getByTitle(/confirmDeleteTitle/)).toBeInTheDocument()
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
    fireEvent.click(within(row).getByTitle(/knowledgeTree\.deleteTitle/))
    fireEvent.click(within(row).getByTitle(/confirmDeleteTitle/))
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
    fireEvent.click(within(row).getByTitle(/knowledgeTree\.deleteTitle/))
    fireEvent.click(within(row).getByTitle(/confirmDeleteTitle/))
    await flush()
    expect(errSpy).toHaveBeenCalled()
    expect(within(row).queryByTitle(/deletingTitle/)).not.toBeInTheDocument()
    // 记忆清理失败 → warn，删除仍完成
    mocks.moveFileToTrash.mockResolvedValueOnce({ id: "t2", name: "x", originalPath: "x", trashPath: "x", deletedAt: 0, expiresAt: 0, kind: "chapter" })
    mocks.deleteNovelSourceMemory.mockRejectedValueOnce(new Error("mem-fail"))
    fireEvent.click(within(row).getByTitle(/knowledgeTree\.deleteTitle/))
    fireEvent.click(within(row).getByTitle(/confirmDeleteTitle/))
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
    fireEvent.click(within(row).getByTitle(/knowledgeTree\.deleteTitle/))
    fireEvent.click(within(row).getByTitle(/confirmDeleteTitle/))
    await flush()
    expect(mocks.moveFileToTrash).toHaveBeenCalledWith(PROJ, `${OUTLINES}/全书大纲.md`, "outline")
    view.unmount()
  })

  it("文件夹删除：确认后逐文件回收 + 空目录删除 + onRemovePendingPage", async () => {
    const onRemovePendingPage = vi.fn()
    const view = renderTree({ onRemovePendingPage })
    await screen.findByText("序章-开端")
    fireEvent.contextMenu(screen.getByText("卷1"))
    expect(screen.getByText("knowledgeTree.deleteVolume")).toBeInTheDocument()
    fireEvent.click(screen.getByText("knowledgeTree.deleteVolume"))
    expect(mocks.confirm).toHaveBeenCalledWith('knowledgeTree.deleteFolderConfirm::{"name":"卷1","count":1}')
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
    fireEvent.click(screen.getByText("knowledgeTree.deleteFolder"))
    expect(mocks.confirm).toHaveBeenCalledWith('knowledgeTree.deleteEmptyFolderConfirm::{"name":"空文件夹"}')
    await flush()
    expect(mocks.deleteFile).toHaveBeenCalledWith(`${OUTLINES}/空文件夹`)
    view.unmount()
  })

  it("文件夹删除：confirm 拒绝则中止", async () => {
    mocks.confirm.mockReturnValue(false)
    const view = renderTree()
    await screen.findByText("序章-开端")
    fireEvent.contextMenu(screen.getByText("卷1"))
    fireEvent.click(screen.getByText("knowledgeTree.deleteVolume"))
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
    fireEvent.click(screen.getByText("knowledgeTree.deleteVolume"))
    await flush()
    expect(mocks.alert).toHaveBeenCalledWith('knowledgeTree.deleteFolderBlocked::{"name":"卷1"}')
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
    fireEvent.click(screen.getByText("knowledgeTree.deleteVolume"))
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
    fireEvent.click(screen.getByText("knowledgeTree.deleteVolume"))
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
    fireEvent.click(screen.getByText("knowledgeTree.deleteVolume"))
    await flush()
    expect(errSpy).toHaveBeenCalled()
    view.unmount()
  })

  it("空白区右键：创建菜单（无删除项）+ 新建回调", async () => {
    const onRequestCreate = vi.fn()
    const view = renderTree({ onRequestCreate })
    await screen.findByText("第二章-进展")
    fireEvent.contextMenu(screen.getByText("sidebar.knowledge"))
    expect(screen.getByText("sidebar.newChapter")).toBeInTheDocument()
    expect(screen.getByText("sidebar.newVolume")).toBeInTheDocument()
    expect(screen.queryByText("knowledgeTree.deleteVolume")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("sidebar.newChapter"))
    expect(onRequestCreate).toHaveBeenCalledWith({ kind: "chapter", parentDir: undefined })
    expect(screen.queryByText("sidebar.newChapter")).not.toBeInTheDocument()
    view.unmount()
  })

  it("页面右键菜单：新建/重命名/移动到卷/打开位置 + parentDir", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const onRequestCreate = vi.fn()
    const view = renderTree({ onRequestCreate })
    await screen.findByText("第三章-高潮")
    const row = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    fireEvent.contextMenu(row)
    expect(screen.getByText("knowledgeTree.rename")).toBeInTheDocument()
    expect(screen.getByText("knowledgeTree.moveToVolume")).toBeInTheDocument()
    expect(screen.getByText("打开文件所在位置")).toBeInTheDocument()
    fireEvent.click(screen.getByText("sidebar.newChapter"))
    expect(onRequestCreate).toHaveBeenCalledWith({ kind: "chapter", parentDir: CHAPTERS })
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("sidebar.newVolume"))
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
    fireEvent.click(screen.getByText("sidebar.newVolume"))
    expect(onRequestCreate).toHaveBeenCalledWith({ kind: "volume", parentDir: `${CHAPTERS}/卷1` })
    view.unmount()
  })

  it("outline 页面菜单：newOutline/newFolder 变体", async () => {
    const onRequestCreate = vi.fn()
    const view = render(<KnowledgeTree filterType="outline" onRequestCreate={onRequestCreate} />)
    await screen.findByText("全书大纲")
    const row = pageRow(view.container, `${OUTLINES}/全书大纲.md`)
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("sidebar.newOutline"))
    expect(onRequestCreate).toHaveBeenCalledWith({ kind: "outline", parentDir: OUTLINES })
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("sidebar.newFolder"))
    expect(onRequestCreate).toHaveBeenCalledWith({ kind: "folder", parentDir: OUTLINES })
    view.unmount()
  })

  it("读取失败页的菜单：target 缺失时 parentDir undefined", async () => {
    const onRequestCreate = vi.fn()
    const view = render(<KnowledgeTree filterType="outline" onRequestCreate={onRequestCreate} />)
    await screen.findByText("坏文件")
    const row = pageRow(view.container, `${OUTLINES}/坏文件.md`)
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("sidebar.newOutline"))
    expect(onRequestCreate).toHaveBeenCalledWith({ kind: "outline", parentDir: undefined })
    view.unmount()
  })

  it("触摸 pointerdown 后右键被拦截（lastPointerType 非 mouse）", async () => {
    const view = renderTree()
    await screen.findByText("第二章-进展")
    const row = pageRow(view.container, `${CHAPTERS}/第二章-进展.md`)
    fireEvent.pointerDown(row, { pointerType: "touch", pointerId: 1, button: 0 })
    fireEvent.contextMenu(row)
    expect(screen.queryByText("knowledgeTree.rename")).not.toBeInTheDocument()
    view.unmount()
  })

  it("菜单通过 document mousedown/keydown 与容器点击关闭", async () => {
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    // document mousedown 关闭
    fireEvent.contextMenu(screen.getByText("sidebar.knowledge"))
    expect(screen.getByText("sidebar.newChapter")).toBeInTheDocument()
    act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })))
    expect(screen.queryByText("sidebar.newChapter")).not.toBeInTheDocument()
    // document keydown 关闭
    fireEvent.contextMenu(screen.getByText("sidebar.knowledge"))
    expect(screen.getByText("sidebar.newChapter")).toBeInTheDocument()
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true })))
    expect(screen.queryByText("sidebar.newChapter")).not.toBeInTheDocument()
    // 容器 onClick 关闭
    fireEvent.contextMenu(screen.getByText("sidebar.knowledge"))
    expect(screen.getByText("sidebar.newChapter")).toBeInTheDocument()
    fireEvent.click(screen.getByText("sidebar.knowledge"))
    expect(screen.queryByText("sidebar.newChapter")).not.toBeInTheDocument()
    view.unmount()
  })

  it("移动到卷：copy+delete+刷新+选中跳转", async () => {
    mocks.wikiState.selectedFile = `${CHAPTERS}/第三章-高潮.md`
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    const row = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("knowledgeTree.moveToVolume"))
    const menu = screen.getByText("knowledgeTree.rename").closest("div.absolute") as HTMLElement
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
    fireEvent.click(screen.getByText("knowledgeTree.moveToVolume"))
    let menu = screen.getByText("knowledgeTree.rename").closest("div.absolute") as HTMLElement
    fireEvent.click(within(menu).getByText("卷1"))
    await flush()
    expect(mocks.alert).toHaveBeenCalledWith("knowledgeTree.moveTargetExists")
    expect(mocks.copyFile).not.toHaveBeenCalled()
    // 当前卷禁用（第一章-开端 在卷1 内 → isCurrentVolume）
    const volRow = pageRow(view.container, `${CHAPTERS}/卷1/第一章-开端.md`)
    fireEvent.contextMenu(volRow)
    fireEvent.click(screen.getByText("knowledgeTree.moveToVolume"))
    menu = screen.getByText("knowledgeTree.rename").closest("div.absolute") as HTMLElement
    const volBtn = within(menu).getByText("卷1").closest("button")
    expect(volBtn?.hasAttribute("disabled")).toBe(true)
    expect(within(menu).getByText("当前")).toBeInTheDocument()
    // copyFile 失败 → console.error
    mocks.copyFile.mockRejectedValueOnce(new Error("copy-fail"))
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("knowledgeTree.moveToVolume"))
    menu = screen.getByText("knowledgeTree.rename").closest("div.absolute") as HTMLElement
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
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
    const input = within(row).getByRole("textbox")
    expect(input).toHaveValue("第三章-高潮")
    fireEvent.change(input, { target: { value: "第四章-新篇章" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await flush()
    const targetPath = `${CHAPTERS}/第4章-新篇章.md`
    expect(mocks.writeFile).toHaveBeenCalledWith(targetPath, expect.stringContaining('title: "第4章-新篇章"'))
    expect(mocks.writeFile).toHaveBeenCalledWith(targetPath, expect.stringContaining("chapter_number: 4"))
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
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
    const input1 = within(row1).getByRole("textbox")
    fireEvent.change(input1, { target: { value: "第五章-开端改" } })
    fireEvent.keyDown(input1, { key: "Enter" })
    await flush()
    expect(mocks.writeFile).toHaveBeenCalledWith(`${CHAPTERS}/卷1/第5章-开端改.md`, expect.stringContaining("chapter_number: 5"))
    expect(mocks.writeFile).toHaveBeenCalledWith(`${CHAPTERS}/卷1/第5章-开端改.md`, expect.stringContaining('title: "第5章-开端改"'))
    expect(mocks.deleteFile).toHaveBeenCalledWith(`${CHAPTERS}/卷1/第一章-开端.md`)
    // 序章-引子：无章号 → 纯标题、无 chapter_number 写入
    await screen.findByText("序章-引子")
    const row2 = pageRow(view.container, `${CHAPTERS}/序章-引子.md`)
    fireEvent.contextMenu(row2)
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
    const input2 = within(row2).getByRole("textbox")
    fireEvent.change(input2, { target: { value: "引子修改" } })
    fireEvent.keyDown(input2, { key: "Enter" })
    await flush()
    expect(mocks.writeFile).toHaveBeenCalledWith(`${CHAPTERS}/引子修改.md`, expect.stringContaining("# 引子修改"))
    expect(mocks.deleteFile).toHaveBeenCalledWith(`${CHAPTERS}/序章-引子.md`)
    view.unmount()
  })

  it("重命名：重复标题/章号冲突中止；空标题/相同标题取消；Escape 取消", async () => {
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    const row = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    // 重复标题
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
    let input = within(row).getByRole("textbox")
    fireEvent.change(input, { target: { value: "第二章-进展" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await flush()
    expect(mocks.writeFile).not.toHaveBeenCalled()
    // 章号冲突（第三章 → 第二章 → 与第二章-进展 冲突）
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
    input = within(row).getByRole("textbox")
    fireEvent.change(input, { target: { value: "第二章-冲突" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await flush()
    expect(mocks.writeFile).not.toHaveBeenCalled()
    // 空标题 → 取消
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
    input = within(row).getByRole("textbox")
    fireEvent.change(input, { target: { value: "   " } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(within(row).queryByRole("textbox")).not.toBeInTheDocument()
    expect(mocks.writeFile).not.toHaveBeenCalled()
    // 相同标题 → 取消
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
    input = within(row).getByRole("textbox")
    fireEvent.change(input, { target: { value: "第三章-高潮" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(within(row).queryByRole("textbox")).not.toBeInTheDocument()
    expect(mocks.writeFile).not.toHaveBeenCalled()
    // Escape → 取消
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
    input = within(row).getByRole("textbox")
    fireEvent.keyDown(input, { key: "Escape" })
    expect(within(row).queryByRole("textbox")).not.toBeInTheDocument()
    expect(mocks.writeFile).not.toHaveBeenCalled()
    view.unmount()
  })

  it("重命名 outline：slug 同路径时不删旧文件（getUniquePagePath 同路径分支）", async () => {
    const view = render(<KnowledgeTree filterType="outline" />)
    await screen.findByText("分卷大纲二")
    const row = pageRow(view.container, `${OUTLINES}/分卷大纲-2.md`)
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
    const input = within(row).getByRole("textbox")
    fireEvent.change(input, { target: { value: "分卷大纲 2" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await flush()
    // slug("分卷大纲 2") === "分卷大纲-2" → 同路径写回
    expect(mocks.writeFile).toHaveBeenCalledWith(`${OUTLINES}/分卷大纲-2.md`, expect.stringContaining('title: "分卷大纲 2"'))
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
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
    let input = within(row1).getByRole("textbox")
    fireEvent.change(input, { target: { value: "分卷大纲 2" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await flush()
    expect(mocks.writeFile).toHaveBeenCalledWith(`${OUTLINES}/分卷大纲-2-2.md`, expect.any(String))
    expect(mocks.deleteFile).toHaveBeenCalledWith(`${OUTLINES}/分卷大纲-2-3.md`)
    // 场景2：候选 -2 占用、-3 等于排除路径 → 同路径写回（覆盖 candidate === excludePath）
    mocks.fileExists.mockImplementation(async (p: string) => p === `${OUTLINES}/分卷大纲-2.md` || p === `${OUTLINES}/分卷大纲-2-2.md`)
    const row2 = pageRow(view.container, `${OUTLINES}/分卷大纲-2-3.md`)
    fireEvent.contextMenu(row2)
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
    input = within(row2).getByRole("textbox")
    fireEvent.change(input, { target: { value: "分卷大纲 2" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await flush()
    expect(mocks.writeFile).toHaveBeenCalledWith(`${OUTLINES}/分卷大纲-2-3.md`, expect.any(String))
    // 场景3：全部候选占用 → Date.now 时间戳兜底
    mocks.fileExists.mockImplementation(async (p: string) => p.startsWith(`${OUTLINES}/分卷大纲-2`))
    const row3 = pageRow(view.container, `${OUTLINES}/全书大纲.md`)
    fireEvent.contextMenu(row3)
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
    input = within(row3).getByRole("textbox")
    fireEvent.change(input, { target: { value: "分卷大纲 2" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await flush()
    const fallbackCalls = mocks.writeFile.mock.calls.map(([p]) => p as string).filter((p) => p.startsWith(`${OUTLINES}/分卷大纲-2-`) && /-\d{13}\.md$/.test(p))
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
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
    const input = within(row).getByRole("textbox")
    fireEvent.change(input, { target: { value: "第四章-新篇章" } })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.keyDown(input, { key: "Escape" })
    resolveRead(CONTENTS[`${CHAPTERS}/第三章-高潮.md`])
    await flush()
    expect(mocks.writeFile).toHaveBeenCalled()
    // readFile 失败 → console.error + 输入框清理
    mocks.readFile.mockRejectedValueOnce(new Error("read-fail"))
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
    const input2 = within(row).getByRole("textbox")
    fireEvent.change(input2, { target: { value: "第四章-新篇章" } })
    fireEvent.keyDown(input2, { key: "Enter" })
    await flush()
    expect(errSpy).toHaveBeenCalled()
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
    expect(mocks.writeFile).toHaveBeenCalled()
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
    const calls = mocks.writeFile.mock.calls.map(([p, c]) => [p as string, c as string])
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
    mocks.writeFile
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
    expect(mocks.writeFile).not.toHaveBeenCalled()
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
    expect(mocks.writeFile).not.toHaveBeenCalled()
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
    expect(mocks.writeFile).toHaveBeenCalled()
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
    fireEvent.click(within(row).getByTitle(/knowledgeTree\.deleteTitle/))
    expect(within(row).getByTitle(/confirmDeleteTitle/)).toBeInTheDocument()
    // 容器内 mousedown → 早退，武装保持
    act(() => { row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })) })
    expect(within(row).getByTitle(/confirmDeleteTitle/)).toBeInTheDocument()
    // 非 Escape 键 → 武装保持
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true })) })
    expect(within(row).getByTitle(/confirmDeleteTitle/)).toBeInTheDocument()
    view.unmount()
  })

  it("删除选中卷内页面：selectedFile 前缀匹配 → setSelectedFile(null)", async () => {
    mocks.wikiState.selectedFile = `${CHAPTERS}/卷1/第一章-开端.md`
    const view = renderTree()
    await screen.findByText("序章-开端")
    fireEvent.contextMenu(screen.getByText("卷1"))
    fireEvent.click(screen.getByText("knowledgeTree.deleteVolume"))
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
    fireEvent.click(screen.getByText("knowledgeTree.deleteVolume"))
    await flush()
    // 递归展平后仍有文件 → 阻止删除目录
    expect(mocks.alert).toHaveBeenCalledWith('knowledgeTree.deleteFolderBlocked::{"name":"卷1"}')
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
    fireEvent.click(screen.getByText("knowledgeTree.moveToVolume"))
    const menu = screen.getByText("knowledgeTree.rename").closest("div.absolute") as HTMLElement
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
    expect(mocks.writeFile).toHaveBeenCalled()
    const calls = mocks.writeFile.mock.calls.map(([p, c]) => [p as string, c as string])
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
    expect(mocks.writeFile).not.toHaveBeenCalled()
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
    expect(mocks.writeFile).not.toHaveBeenCalled()
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
    expect(mocks.writeFile).not.toHaveBeenCalled()
    // timer 已清：再 advance 也不触发拖拽
    act(() => { vi.advanceTimersByTime(300) })
    expect(mocks.writeFile).not.toHaveBeenCalled()
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
    expect(mocks.writeFile).not.toHaveBeenCalled()
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
    expect(mocks.writeFile).toHaveBeenCalled()
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
    expect(screen.getByText("knowledgeTree.rename")).toBeInTheDocument()
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
    expect(mocks.writeFile).toHaveBeenCalled()
    view.unmount()
  })

  it("重命名：busy 期间再提交被守卫；blur 提交；mousedown/click 拦截；非 Enter/Escape 键", async () => {
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    const row = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    let resolveRead!: (v: string) => void
    mocks.readFile.mockImplementationOnce(() => new Promise<string>((resolve) => { resolveRead = resolve }))
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
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
    expect(mocks.writeFile).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it("重命名中点击行按钮：renamingPath === pagePath 早退", async () => {
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    const row = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
    const rowButton = row.querySelector("button") as HTMLElement
    expect(rowButton.hasAttribute("disabled")).toBe(true)
    fireEvent.click(rowButton)
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
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
    expect(within(row).getByRole("textbox")).toBeInTheDocument()
    // timer 已清：advance 后无拖拽
    act(() => { vi.advanceTimersByTime(300) })
    await act(async () => {})
    expect(mocks.writeFile).not.toHaveBeenCalled()
    expect(row.className).not.toContain("ring-2")
    vi.useRealTimers()
    view.unmount()
  })

  it("创建菜单：mousedown 冒泡拦截；outline 新建文件夹变体", async () => {
    const onRequestCreate = vi.fn()
    const view = render(<KnowledgeTree filterType="outline" onRequestCreate={onRequestCreate} />)
    await screen.findByText("全书大纲")
    fireEvent.contextMenu(screen.getByText("sidebar.files"))
    expect(screen.getByText("sidebar.newOutline")).toBeInTheDocument()
    // mousedown 不冒泡到 document → 菜单保持打开
    const menu = screen.getByText("sidebar.newOutline").closest("div.absolute") as HTMLElement
    fireEvent.mouseDown(within(menu).getByText("sidebar.newFolder"))
    expect(screen.getByText("sidebar.newOutline")).toBeInTheDocument()
    // outline → folder 变体
    fireEvent.click(screen.getByText("sidebar.newFolder"))
    expect(onRequestCreate).toHaveBeenCalledWith({ kind: "folder", parentDir: undefined })
    view.unmount()
  })

  it("outline 坏文件菜单：rename 无 target 不触发；newFolder parentDir undefined", async () => {
    const onRequestCreate = vi.fn()
    const view = render(<KnowledgeTree filterType="outline" onRequestCreate={onRequestCreate} />)
    await screen.findByText("坏文件")
    const row = pageRow(view.container, `${OUTLINES}/坏文件.md`)
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("knowledgeTree.rename"))
    expect(within(row).queryByRole("textbox")).not.toBeInTheDocument()
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("sidebar.newFolder"))
    expect(onRequestCreate).toHaveBeenCalledWith({ kind: "folder", parentDir: undefined })
    view.unmount()
  })

  it("移动子菜单：再次点击 moveToVolume 关闭子菜单；禁用卷点击不移动", async () => {
    const view = renderTree()
    await screen.findByText("第三章-高潮")
    const row = pageRow(view.container, `${CHAPTERS}/第三章-高潮.md`)
    fireEvent.contextMenu(row)
    const menu = screen.getByText("knowledgeTree.rename").closest("div.absolute") as HTMLElement
    // 页面菜单 mousedown 冒泡拦截
    fireEvent.mouseDown(within(menu).getByText("knowledgeTree.rename"))
    expect(within(menu).getByText("knowledgeTree.rename")).toBeInTheDocument()
    fireEvent.click(within(menu).getByText("knowledgeTree.moveToVolume"))
    expect(menu.querySelector(".max-h-48")).not.toBeNull()
    fireEvent.click(within(menu).getByText("knowledgeTree.moveToVolume"))
    expect(menu.querySelector(".max-h-48")).toBeNull()
    // 卷内页面：当前卷按钮禁用 → 点击不触发移动
    const volRow = pageRow(view.container, `${CHAPTERS}/卷1/第一章-开端.md`)
    fireEvent.contextMenu(volRow)
    const volMenu = screen.getByText("knowledgeTree.rename").closest("div.absolute") as HTMLElement
    fireEvent.click(within(volMenu).getByText("knowledgeTree.moveToVolume"))
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
    const onCancelExtraction = vi.fn()
    const view = render(<RawSourcesSection onCancelExtraction={onCancelExtraction} />)
    // 自动展开
    expect(screen.getByText("AI 大纲提取中")).toBeInTheDocument()
    expect(screen.getByText("50%")).toBeInTheDocument()
    expect(screen.getByText("1/2 · AI 大纲")).toBeInTheDocument()
    expect(screen.getByText("1 个任务运行中")).toBeInTheDocument()
    expect(screen.queryByText(/其他项目/)).not.toBeInTheDocument()
    expect(view.container.querySelector(".bg-primary")).not.toBeNull()
    fireEvent.click(screen.getByText("停止"))
    expect(mocks.importState.cancelTask).toHaveBeenCalledWith("t1")
    expect(onCancelExtraction).toHaveBeenCalled()
    view.unmount()
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
})
