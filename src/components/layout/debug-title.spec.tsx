// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { cleanup as rtlCleanup } from "@testing-library/react"
import { render, screen, fireEvent, act, setupDomGlobals, userEvent } from "@/test-helpers/component-test-utils"

const CHAPTER_PATH = "/proj/wiki/chapters/第1章.md"
const CHAPTER_MD = ["---", 'type: chapter', 'title: "第一章"', "chapter_number: 1", "chapter_status: draft", "---", "", "# 第一章", "", "正文第一段。", ""].join("\n")

const mocks = vi.hoisted(() => {
  const state: Record<string, any> = {
    project: { path: "/proj" },
    selectedFile: null,
    selectedTrashItem: null,
    fileContent: "",
    novelMode: true,
    chatExpanded: false,
    pendingEditorHighlight: null,
    finalChapterSave: null,
    novelConfig: { reviewBeforeSave: false, autoIngestOnSave: false },
    llmConfig: { provider: "openai", apiKey: "k", model: "m" },
    setSelectedTrashItem: vi.fn((v: unknown) => { state.selectedTrashItem = v }),
    setChatExpanded: vi.fn((v: unknown) => { state.chatExpanded = v }),
    setFileContent: vi.fn((v: unknown) => { state.fileContent = v }),
    setFileTree: vi.fn(),
    setSelectedFile: vi.fn((v: unknown) => { state.selectedFile = v }),
    setPendingEditorHighlight: vi.fn((v: unknown) => { state.pendingEditorHighlight = v }),
    setFinalChapterSave: vi.fn((v: unknown) => { state.finalChapterSave = v }),
    bumpDataVersion: vi.fn(),
  }
  return {
    state,
    t: vi.fn((key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    writeFileAtomic: vi.fn(),
    listDirectory: vi.fn(),
    deleteFile: vi.fn(),
    fileExists: vi.fn(),
    preprocessFile: vi.fn(),
    copyFile: vi.fn(), copyDirectory: vi.fn(), findRelatedWikiPages: vi.fn(), createDirectory: vi.fn(),
    getFileModifiedTime: vi.fn(), getFileSize: vi.fn(), getFileMd5: vi.fn(), readFileAsBase64: vi.fn(),
    createProject: vi.fn(), openProject: vi.fn(), openProjectFolder: vi.fn(), openFileLocation: vi.fn(),
    getExecutableDir: vi.fn(), getResourceDir: vi.fn(),
    resolveDefaultModel: vi.fn((cfg: unknown) => cfg),
    hasUsableLlm: vi.fn(() => true),
    resolveReviewModel: vi.fn(() => "review-model"),
    buildDeAiRewriteMessages: vi.fn(() => []),
    loadSmartDeAiSkill: vi.fn(async () => null),
    startOutlineIngestTask: vi.fn(),
    streamChat: vi.fn(),
    reviewChapter: vi.fn(async () => []),
    ingestChapter: vi.fn(async () => ({ snapshot: null, failReason: "extract_failed" })),
    buildPolishSelectionMessages: vi.fn(() => []),
    rebuildChapterBody: vi.fn((h: string, b: string) => (h ? `# ${h}\n\n${b}` : b)),
    replaceChapterBodySelection: vi.fn(() => ({ ok: true as const, body: "new-body" })),
    replaceWholeChapterBody: vi.fn((_c: string, r: string) => r),
    splitChapterHeading: vi.fn((b: string) => ({ heading: "第一章", body: b })),
    shouldUseCompactChapterToolbar: vi.fn(() => true),
    getPreviewContentContainerClass: vi.fn(() => "container-class"),
  }
})

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign((selector: (s: Record<string, any>) => unknown) => selector(mocks.state), { getState: () => mocks.state }),
}))
vi.mock("@/stores/outline-generation-store", () => ({ useOutlineGenerationStore: (s: any) => s({ tasks: [] }) }))
vi.mock("@/stores/review-store", () => ({ useReviewStore: Object.assign((s: any) => s({ addNovelReviewEntry: vi.fn() }), { getState: () => ({ addNovelReviewEntry: vi.fn() }) }) }))
vi.mock("@/stores/import-progress-store", () => ({ useImportProgressStore: Object.assign((s: any) => s({ startTask: vi.fn(() => "t"), finishTask: vi.fn() }), { getState: () => ({ startTask: vi.fn(() => "t"), finishTask: vi.fn() }) }) }))
vi.mock("react-i18next", () => ({ initReactI18next: { type: "3rdParty", init: vi.fn() }, useTranslation: () => ({ t: mocks.t }) }))
vi.mock("@/i18n", () => ({ default: { t: mocks.t, exists: vi.fn(() => true) } }))
vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile, writeFile: mocks.writeFile, writeFileAtomic: mocks.writeFileAtomic,
  listDirectory: mocks.listDirectory, copyFile: mocks.copyFile, copyDirectory: mocks.copyDirectory,
  preprocessFile: mocks.preprocessFile, deleteFile: mocks.deleteFile, findRelatedWikiPages: mocks.findRelatedWikiPages,
  createDirectory: mocks.createDirectory, fileExists: mocks.fileExists,
  getFileModifiedTime: mocks.getFileModifiedTime, getFileSize: mocks.getFileSize, getFileMd5: mocks.getFileMd5,
  readFileAsBase64: mocks.readFileAsBase64, createProject: mocks.createProject, openProject: mocks.openProject,
  openProjectFolder: mocks.openProjectFolder, openFileLocation: mocks.openFileLocation,
  getExecutableDir: mocks.getExecutableDir, getResourceDir: mocks.getResourceDir,
}))
vi.mock("@/lib/novel/model-resolver", () => ({ resolveDefaultModel: mocks.resolveDefaultModel }))
vi.mock("@/lib/has-usable-llm", () => ({ hasUsableLlm: mocks.hasUsableLlm }))
vi.mock("@/lib/novel/review-model", () => ({ resolveReviewModel: mocks.resolveReviewModel }))
vi.mock("@/lib/novel/de-ai-adapter", () => ({ buildDeAiRewriteMessages: mocks.buildDeAiRewriteMessages, loadSmartDeAiSkill: mocks.loadSmartDeAiSkill }))
vi.mock("@/lib/novel/outline-generation", () => ({ startOutlineIngestTask: mocks.startOutlineIngestTask }))
vi.mock("@/lib/llm-client", () => ({ streamChat: mocks.streamChat }))
vi.mock("@/lib/chapter-selection", () => ({
  buildPolishSelectionMessages: mocks.buildPolishSelectionMessages, rebuildChapterBody: mocks.rebuildChapterBody,
  replaceChapterBodySelection: mocks.replaceChapterBodySelection, replaceWholeChapterBody: mocks.replaceWholeChapterBody,
  splitChapterHeading: mocks.splitChapterHeading,
}))
vi.mock("@/lib/novel/review-adapter", () => ({ reviewChapter: mocks.reviewChapter }))
vi.mock("@/lib/novel/chapter-ingest", () => ({ ingestChapter: mocks.ingestChapter }))
vi.mock("@/lib/workspace-layout", () => ({ shouldUseCompactChapterToolbar: mocks.shouldUseCompactChapterToolbar, getPreviewContentContainerClass: mocks.getPreviewContentContainerClass }))
vi.mock("@/components/editor/wiki-editor", () => ({ WikiEditor: (p: any) => <div data-testid="wiki-editor"><button data-testid="editor-save" onClick={() => p.onSave?.("x")}>s</button></div> }))
vi.mock("@/components/editor/wiki-reader", () => ({ WikiReader: () => <div /> }))
vi.mock("@/components/editor/file-preview", () => ({ FilePreview: () => <div /> }))
vi.mock("@/components/novel/cognition-panel", () => ({ CognitionPanel: () => <div /> }))
vi.mock("@/components/novel/persona-critique-panel", () => ({ PersonaCritiquePanel: () => <div /> }))
vi.mock("@/components/novel/de-ai-preview-dialog", () => ({ DeAiPreviewDialog: (p: any) => <div data-testid="deai" data-open={String(p.open)} /> }))
vi.mock("@/components/novel/text-transform-preview-dialog", () => ({ TextTransformPreviewDialog: (p: any) => <div data-testid="tt" data-open={String(p.open)} /> }))
vi.mock("@/components/novel/snapshot-viewer", () => ({ SnapshotViewer: () => <div /> }))

import { PreviewPanel } from "./preview-panel"

beforeEach(() => {
  vi.clearAllMocks()
  setupDomGlobals()
  mocks.state.project = { path: "/proj" }
  mocks.state.selectedFile = CHAPTER_PATH
  mocks.state.fileContent = CHAPTER_MD
  mocks.readFile.mockResolvedValue(CHAPTER_MD)
  mocks.fileExists.mockResolvedValue(false)
})
afterEach(() => rtlCleanup())

    it("switch flush debug", async () => {
      mocks.state.selectedFile = CHAPTER_PATH
      mocks.state.fileContent = CHAPTER_MD
      mocks.readFile.mockResolvedValue(CHAPTER_MD)
      const view = render(<PreviewPanel />)
      await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
      fireEvent.click(screen.getByTestId("editor-save"))
      mocks.state.selectedFile = "/proj/wiki/chapters/第二章.md"
      mocks.state.fileContent = "# 第二章\n\n内容"
      mocks.readFile.mockResolvedValue("# 第二章\n\n内容")
      view.rerender(<PreviewPanel />)
      await act(async () => { await new Promise((r) => setTimeout(r, 100)) })
      console.log("ALL writeFileAtomic calls:", JSON.stringify(mocks.writeFileAtomic.mock.calls))
      console.log("ALL deleteFile calls:", JSON.stringify(mocks.deleteFile.mock.calls))
      console.log("ALL fileExists calls:", JSON.stringify(mocks.fileExists.mock.calls))
      view.unmount()
    })

describe("debug", () => {
  it("title commit", async () => {
    render(<PreviewPanel />)
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
    const input = screen.getByRole("textbox") as HTMLInputElement
    await userEvent.click(input)
    await userEvent.clear(input)
    await userEvent.type(input, "新标题")
    console.log("value before Enter:", input.value)
    await userEvent.keyboard("{Enter}")
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    console.log("writeFileAtomic calls:", JSON.stringify(mocks.writeFileAtomic.mock.calls))
    console.log("fileExists calls:", JSON.stringify(mocks.fileExists.mock.calls))
    expect(mocks.writeFileAtomic).toHaveBeenCalled()
  })
})
