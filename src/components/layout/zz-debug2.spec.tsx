// @vitest-environment jsdom
import { it, vi, beforeEach, afterEach } from "vitest"
import { cleanup as rtlCleanup } from "@testing-library/react"
import { render, screen, fireEvent, act, within, setupDomGlobals } from "@/test-helpers/component-test-utils"
import type { FileNode, WikiProject } from "@/types/wiki"

const mocks = vi.hoisted(() => ({
  t: vi.fn((key: string, opts?: Record<string, unknown>) => (opts ? `${key}::${JSON.stringify(opts)}` : key)),
  wikiState: {
    project: null as WikiProject | null, fileTree: [] as FileNode[], selectedFile: null as string | null, dataVersion: 0,
    setSelectedFile: vi.fn(), setFileTree: vi.fn(), bumpDataVersion: vi.fn(),
  },
  readFile: vi.fn(), writeFile: vi.fn(), listDirectory: vi.fn(), deleteFile: vi.fn(),
  fileExists: vi.fn(), copyFile: vi.fn(), openFileLocation: vi.fn(),
  moveFileToTrash: vi.fn(), deleteNovelSourceMemory: vi.fn(),
  confirm: vi.fn(() => true), alert: vi.fn(),
}))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }) }))
vi.mock("@/i18n", () => ({ default: { t: mocks.t } }))
vi.mock("@/stores/wiki-store", () => ({ useWikiStore: Object.assign((s: any) => s(mocks.wikiState), { getState: () => mocks.wikiState }) }))
vi.mock("@/stores/import-progress-store", () => ({ useImportProgressStore: Object.assign((s: any) => s({ tasks: [], cancelTask: vi.fn() }), { getState: () => ({ tasks: [], cancelTask: vi.fn() }) }) }))
vi.mock("@/commands/fs", () => ({ readFile: mocks.readFile, writeFile: mocks.writeFile, listDirectory: mocks.listDirectory, deleteFile: mocks.deleteFile, fileExists: mocks.fileExists, copyFile: mocks.copyFile, openFileLocation: mocks.openFileLocation }))
vi.mock("@/lib/trash", () => ({ moveFileToTrash: mocks.moveFileToTrash }))
vi.mock("@/lib/novel/delete-source-memory", () => ({ deleteNovelSourceMemory: mocks.deleteNovelSourceMemory }))
import { KnowledgeTree } from "./knowledge-tree"

const PROJ = "/proj"
const OUTLINES = `${PROJ}/wiki/outlines`
const f = (name: string, path: string): FileNode => ({ name, path, is_dir: false })
const d = (name: string, path: string, children: FileNode[] = []): FileNode => ({ name, path, is_dir: true, children })
const CONTENTS: Record<string, string> = {
  [`${OUTLINES}/全书大纲.md`]: "---\ntitle: 全书大纲\ntags: [结构, 卷]\norigin: manual\n---\n# 全书大纲\n内容",
}
const wikiTree: FileNode[] = [d("outlines", OUTLINES, [f("全书大纲.md", `${OUTLINES}/全书大纲.md`)])]

beforeEach(() => {
  vi.clearAllMocks()
  setupDomGlobals()
  ;(Element.prototype as any).getAnimations = () => []
  mocks.wikiState.project = { id: "p1", name: "MyBook", path: PROJ }
  mocks.wikiState.fileTree = [d("wiki", `${PROJ}/wiki`, wikiTree)]
  mocks.readFile.mockImplementation(async (p: string) => CONTENTS[p] ?? "")
  mocks.listDirectory.mockImplementation(async (p: string) => {
    if (p === `${PROJ}/wiki`) return wikiTree
    if (p === PROJ) return [d("wiki", `${PROJ}/wiki`, wikiTree)]
    return []
  })
  mocks.fileExists.mockResolvedValue(false)
  mocks.writeFile.mockResolvedValue(undefined)
  mocks.deleteFile.mockResolvedValue(undefined)
  mocks.moveFileToTrash.mockResolvedValue({ id: "x" })
  mocks.deleteNovelSourceMemory.mockResolvedValue(undefined)
})
afterEach(() => { rtlCleanup(); vi.restoreAllMocks() })

it("debug outline delete", async () => {
  const view = render(<KnowledgeTree filterType="outline" />)
  await screen.findByText("全书大纲")
  const row = view.container.querySelector(`[data-page-path="${OUTLINES}/全书大纲.md"]`) as HTMLElement
  console.log("ROW BEFORE:", row.innerHTML.slice(0, 400))
  const delBtn = within(row).getByTitle(/knowledgeTree\.deleteTitle/)
  console.log("DEL BTN FOUND:", delBtn.outerHTML.slice(0, 200))
  fireEvent.click(delBtn)
  await act(async () => {})
  console.log("ROW AFTER CLICK:", row.innerHTML.slice(0, 600))
  console.log("TITLES:", [...row.querySelectorAll("[title]")].map((e) => e.getAttribute("title")))
  view.unmount()
})
