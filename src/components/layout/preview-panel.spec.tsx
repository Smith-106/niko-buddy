// @vitest-environment jsdom
/**
 * PreviewPanel 全口径覆盖 spec（W4PS 组）。
 * - vi.hoisted 可写 store state（App.spec.tsx 模式）
 * - 覆盖空态 / 数据态 / 交互 / 错误态 / 回调
 * - 不改源文件；仅此 spec 文件
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { cleanup as rtlCleanup, configure } from "@testing-library/react"
// 全量负载下持久化链变慢：放宽 waitFor 默认超时，避免时序偶发
configure({ asyncUtilTimeout: 5000 })
import { render, screen, fireEvent, waitFor, act, setupDomGlobals } from "@/test-helpers/component-test-utils"
import type { IngestResult, NovelReviewResult, DeAiBatchSummary, DeAiBatchOptions } from "@/lib/novel"
import type { ChapterBodySelection } from "@/lib/chapter-selection"
import type { ComponentProps } from "react"
import type { ChapterDraftDockAdoptAndIngest } from "./chapter-draft-dock"
import { createHash, webcrypto } from "node:crypto"
import { parseFrontmatter } from "@/lib/frontmatter"
const CHAPTER_PATH = "/proj/wiki/chapters/第1章.md"
const COMPLETED_MEMORY_INGEST = {
  snapshot: { chapterNumber: 1 },
  failReason: null,
  ledgerSaveFailed: false,
  factsStoreFailed: false,
  failedProjections: [],
  pendingProjections: [],
  committedProjections: ["sync_snapshot_to_memory"],
  canonOutcome: { status: "skipped", reason: "no_facts" },
  receipt: {
    readPath: CHAPTER_PATH,
    chapterNumber: 1,
    bodySha256: "body-sha",
    contentSha256: "content-sha",
    snapshotIdAtExtractionCommit: "chapter-1-r7",
    snapshotRevisionAtExtractionCommit: 7,
    snapshotJsonSha256AtExtractionCommit: "json-sha",
    canonOutcome: { status: "skipped", reason: "no_facts" },
  },
  projectionReceipt: {
    extractionHistoryPath: "/proj/.novel/extraction-history/chapter-1.md",
    snapshotId: "chapter-1-r8",
    revision: 8,
    snapshotJsonSha256: "json-sha",
  },
} as const
const OUTLINE_PATH = "/proj/wiki/outlines/大纲.md"

const CHAPTER_MD = [
  "---",
  'type: chapter',
  'title: "第一章"',
  "chapter_number: 1",
  "chapter_status: draft",
  "---",
  "",
  "# 第一章",
  "",
  "正文第一段。",
  "",
].join("\n")

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
    clearFinalChapterSaveForPath: vi.fn((path: string) => {
      if (state.finalChapterSave && state.finalChapterSave.filePath === path && state.finalChapterSave.phase !== "saving" && !state.finalChapterSave.saving) {
        state.finalChapterSave = null
      }
    }),
    bumpDataVersion: vi.fn(),
  }
  const outlineState: Record<string, any> = { tasks: [] }
  const reviewState: Record<string, any> = { addNovelReviewEntry: vi.fn() }
  const importState: Record<string, any> = {
    startTask: vi.fn(() => "task-1"),
    finishTask: vi.fn(),
  }
  const compactToolbar: { value: boolean } = { value: true }
  const chapterMetaFinalGate = { value: true }
  const saveText = { value: "用户改动的内容" }
  const selectionText = { value: "选中文本" }
  return {
    verifyAutoMemory: vi.fn(async (..._args: unknown[]) => {}),
    state,
    outlineState,
    reviewState,
    importState,
    compactToolbar,
    chapterMetaFinalGate,
    saveText,
    selectionText,
    deAiAdapterImportError: { value: null as Error | null },
    realEditor: { value: false },
    confirmTarget: { value: "/proj/wiki/chapters/第1章.md" },
    confirmError: vi.fn(),
    acceptSettled: vi.fn(),
    acceptChapterDraft: vi.fn(),
    t: vi.fn<(key: string, opts?: { defaultValue?: string } | string) => string | number>((key, opts) =>
      lookupZhLocale(key) ?? (typeof opts === "string" ? opts : opts?.defaultValue) ?? key
    ),
    readFile: vi.fn(),
    writeFileAtomic: vi.fn(),
    listDirectory: vi.fn(),
    deleteFile: vi.fn(),
    fileExists: vi.fn(),
    preprocessFile: vi.fn(),
    copyFile: vi.fn(),
    copyDirectory: vi.fn(),
    findRelatedWikiPages: vi.fn(),
    createDirectory: vi.fn(),
    getFileModifiedTime: vi.fn(),
    getFileSize: vi.fn(),
    getFileMd5: vi.fn(),
    readFileAsBase64: vi.fn(),
    createProject: vi.fn(),
    openProject: vi.fn(),
    openProjectFolder: vi.fn(),
    openFileLocation: vi.fn(),
    getExecutableDir: vi.fn(),
    getResourceDir: vi.fn(),
    resolveDefaultModel: vi.fn((cfg: unknown) => cfg),
    hasUsableLlm: vi.fn(() => true),
    resolveReviewModel: vi.fn(() => "review-model"),
    buildDeAiRewriteMessages: vi.fn(() => []),
    loadSmartDeAiSkill: vi.fn(async () => null),
    runDeAiBatch: vi.fn<(projectPath: string, options: DeAiBatchOptions) => Promise<DeAiBatchSummary>>(async () => ({
      schemaVersion: "de-ai-batch/1.0",
      batchId: "de-ai-1",
      phase: "completed",
      total: 2,
      processed: 2,
      failed: [],
      skipped: 0,
      durationMs: 1000,
      startedAt: "2026-08-19T00:00:00.000Z",
      finishedAt: "2026-08-19T00:00:01.000Z",
    })),
    acceptAllDeAiBatchDrafts: vi.fn(async () => ({ accepted: 1, skipped: 0 })),
    acceptDeAiBatchDraft: vi.fn(async () => true),
    rejectDeAiBatchDraft: vi.fn(async () => true),
    loadDeAiBatchState: vi.fn(async () => ({
      schemaVersion: "de-ai-batch/1.0",
      batchId: "de-ai-1",
      phase: "completed",
      concurrency: 3,
      startedAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
      queue: [1, 2],
      perChapter: {
        1: { status: "ready", attempts: 1 },
        2: { status: "failed", attempts: 2, lastError: "boom" },
      },
    })),
    startOutlineIngestTask: vi.fn(),
    streamChat: vi.fn(),
    reviewChapter: vi.fn<() => Promise<NovelReviewResult[]>>(async () => []),
    ingestChapter: vi.fn<() => Promise<{ snapshot: { chapterNumber: number } | null; failReason: string | null } & Omit<IngestResult, "snapshot" | "failReason">>>(async () => ({ snapshot: null, failReason: "extract_failed" })),
    buildPolishSelectionMessages: vi.fn(() => []),
    rebuildChapterBody: vi.fn((h: string, b: string) => (h ? `# ${h}\n\n${b}` : b)),
    replaceChapterBodySelection: vi.fn<(currentBody: string, selection: ChapterBodySelection, replacement: string) => { ok: true; body: string } | { ok: false; reason: "changed" | "empty" }>(() => ({ ok: true as const, body: "new-body" })),
    replaceWholeChapterBody: vi.fn((_c: string, r: string) => r),
    splitChapterHeading: vi.fn((b: string) => {
      const match = b.match(/^#\s+(.+)$/m)
      if (!match) return { heading: "第一章", body: b }
      return { heading: match[1], body: b.replace(/^#\s+.+$(\r?\n)?/m, "").replace(/^\n+/, "") }
    }),
    shouldUseCompactChapterToolbar: vi.fn(() => compactToolbar.value),
    getPreviewContentContainerClass: vi.fn(() => "container-class"),
  }
})

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
      useWikiStore: Object.assign(
        (selector: (s: Record<string, any>) => unknown) => selector(mocks.state),
        { getState: () => mocks.state },
      ),
    
  }
})

vi.mock("@/stores/outline-generation-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/outline-generation-store")>()
  return {
    ...actual,
      useOutlineGenerationStore: (selector: (s: Record<string, any>) => unknown) => selector(mocks.outlineState),
    
  }
})

vi.mock("@/stores/review-store", () => ({
  useReviewStore: Object.assign(
    (selector: (s: Record<string, any>) => unknown) => selector(mocks.reviewState),
    { getState: () => mocks.reviewState },
  ),
}))

vi.mock("@/stores/import-progress-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/import-progress-store")>()
  return {
    ...actual,
      useImportProgressStore: Object.assign(
        (selector: (s: Record<string, any>) => unknown) => selector(mocks.importState),
        { getState: () => mocks.importState },
      ),
    
  }
})

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: vi.fn() },
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/i18n")>()
  return {
    ...actual,
      default: { t: mocks.t, exists: vi.fn(() => true) },
    
  }
})

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      readFile: mocks.readFile,
      writeFileAtomic: mocks.writeFileAtomic,
      listDirectory: mocks.listDirectory,
      copyFile: mocks.copyFile,
      copyDirectory: mocks.copyDirectory,
      preprocessFile: mocks.preprocessFile,
      deleteFile: mocks.deleteFile,
      findRelatedWikiPages: mocks.findRelatedWikiPages,
      createDirectory: mocks.createDirectory,
      fileExists: mocks.fileExists,
      getFileModifiedTime: mocks.getFileModifiedTime,
      getFileSize: mocks.getFileSize,
      getFileMd5: mocks.getFileMd5,
      readFileAsBase64: mocks.readFileAsBase64,
      createProject: mocks.createProject,
      openProject: mocks.openProject,
      openProjectFolder: mocks.openProjectFolder,
      openFileLocation: mocks.openFileLocation,
      getExecutableDir: mocks.getExecutableDir,
      getResourceDir: mocks.getResourceDir,
    
  }
})

vi.mock("@/lib/novel/rebuild", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/rebuild")>()
  return {
    ...actual,
    verifyRebuildOutcome: (...args: Parameters<typeof actual.verifyRebuildOutcome>) =>
      args[2].receipt === COMPLETED_MEMORY_INGEST.receipt ? mocks.verifyAutoMemory(...args) : actual.verifyRebuildOutcome(...args),
  }
})
vi.mock("@/lib/novel/model-resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/model-resolver")>()
  return {
    ...actual, resolveDefaultModel: mocks.resolveDefaultModel 
  }
})
vi.mock("@/lib/has-usable-llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/has-usable-llm")>()
  return {
    ...actual, hasUsableLlm: mocks.hasUsableLlm 
  }
})
vi.mock("@/lib/novel/review-model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/review-model")>()
  return {
    ...actual, resolveReviewModel: mocks.resolveReviewModel 
  }
})
vi.mock("@/lib/novel/de-ai-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/de-ai-adapter")>()
  const mod: Record<string, unknown> = {
    ...actual,
    buildDeAiRewriteMessages: mocks.buildDeAiRewriteMessages,
  }
  Object.defineProperty(mod, "loadSmartDeAiSkill", {
    enumerable: true,
    configurable: true,
    get() {
      if (mocks.deAiAdapterImportError.value) throw mocks.deAiAdapterImportError.value
      return mocks.loadSmartDeAiSkill
    },
  })
  Object.defineProperty(mod, "runDeAiDetection", {
    enumerable: true,
    configurable: true,
    get() {
      if (mocks.deAiAdapterImportError.value) throw mocks.deAiAdapterImportError.value
      return actual.runDeAiDetection
    },
  })
  return mod
})
vi.mock("@/lib/novel/de-ai-batch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/de-ai-batch")>()
  return {
    ...actual,
      runDeAiBatch: mocks.runDeAiBatch,
      acceptAllDeAiBatchDrafts: mocks.acceptAllDeAiBatchDrafts,
      acceptDeAiBatchDraft: mocks.acceptDeAiBatchDraft,
      rejectDeAiBatchDraft: mocks.rejectDeAiBatchDraft,
      loadDeAiBatchState: mocks.loadDeAiBatchState,
    
  }
})
vi.mock("@/lib/novel/outline-generation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/outline-generation")>()
  return {
    ...actual, startOutlineIngestTask: mocks.startOutlineIngestTask 
  }
})
vi.mock("@/lib/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-client")>()
  return {
    ...actual, streamChat: mocks.streamChat 
  }
})
vi.mock("@/lib/chapter-selection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chapter-selection")>()
  return {
    ...actual,
      buildPolishSelectionMessages: mocks.buildPolishSelectionMessages,
      rebuildChapterBody: mocks.rebuildChapterBody,
      replaceChapterBodySelection: mocks.replaceChapterBodySelection,
      replaceWholeChapterBody: mocks.replaceWholeChapterBody,
      splitChapterHeading: mocks.splitChapterHeading,
    
  }
})
vi.mock("@/lib/novel/review-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/review-adapter")>()
  return {
    ...actual, reviewChapter: mocks.reviewChapter 
  }
})
vi.mock("@/lib/novel/chapter-ingest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/chapter-ingest")>()
  return {
    ...actual, ingestChapter: mocks.ingestChapter 
  }
})
vi.mock("@/lib/workspace-layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workspace-layout")>()
  return {
    ...actual,
    shouldUseCompactChapterToolbar: mocks.shouldUseCompactChapterToolbar,
    getPreviewContentContainerClass: mocks.getPreviewContentContainerClass,
  }
})

vi.mock("@/components/editor/wiki-editor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/editor/wiki-editor")>()
  return { WikiEditor: (props: ComponentProps<typeof actual.WikiEditor>) => mocks.realEditor.value
    ? <actual.WikiEditor {...props} />
    : (
    <div data-testid="wiki-editor">
      <span data-testid="editor-content">{props.content}</span>
      <span data-testid="editor-mode">{props.defaultMode}</span>
      <button data-testid="editor-save" onClick={() => props.onSave?.(mocks.saveText.value)}>save</button>
      <button
        data-testid="editor-selection-polish"
        onClick={() => props.onSelectionAction?.("polish", { start: 0, end: 4, text: mocks.selectionText.value, bodySnapshot: "body" })}
      >
        polish
      </button>
      <button
        data-testid="editor-selection-deai"
        onClick={() => props.onSelectionAction?.("de-ai", { start: 0, end: 2, text: mocks.selectionText.value, bodySnapshot: "body" })}
      >
        deai
      </button>
      <button data-testid="editor-highlight-handled" onClick={() => props.onHighlightHandled?.()}>
        hl
      </button>
      <span data-testid="editor-highlight">{props.highlightRequest ? props.highlightRequest.text : "none"}</span>
      <button data-testid="editor-reemit" onClick={() => props.onSave(props.content)}>reemit</button>
    </div>
  ) }
})

// R6-PC integration uses the REAL WritingWorkspace + PreviewPanel + coordinator.
// Only the confirmed accept I/O seam / Dock's second-click driver are controlled.
vi.mock("@/lib/novel/draft-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/draft-manager")>()
  return { ...actual, acceptChapterDraft: mocks.acceptChapterDraft, listChapterDrafts: vi.fn(async () => []) }
})
vi.mock("./chapter-draft-dock", () => ({
  ChapterDraftDock: ({ adoptAndIngest, onAdopted }: {
    adoptAndIngest?: ChapterDraftDockAdoptAndIngest
    onAdopted?: (path: string) => void
  }) => (
    <button data-testid="workspace-confirm" onClick={() => {
      void adoptAndIngest?.({
        projectPath: "/proj",
        draftId: "controlled-draft",
        formalChapterPath: mocks.confirmTarget.value,
        onAcceptSettled: mocks.acceptSettled,
      }).then((result) => onAdopted?.(result.formalChapterPath), (error: unknown) => mocks.confirmError(error))
    }}>second confirmation</button>
  ),
}))
vi.mock("@/components/chat/chat-panel", () => ({ ChatPanel: () => <div data-testid="workspace-chat" /> }))
vi.mock("@/components/novel/campaign-dashboard-dialog", () => ({ CampaignDashboardDialog: () => null }))

vi.mock("@/components/editor/wiki-reader", () => ({
  WikiReader: (props: { body: string }) => <div data-testid="wiki-reader">{props.body}</div>,
}))

vi.mock("@/components/editor/file-preview", () => ({
  FilePreview: (props: { filePath: string; textContent: string }) => (
    <div data-testid="file-preview">
      <span>{props.filePath}</span>
      <span>{props.textContent}</span>
    </div>
  ),
}))

vi.mock("@/components/novel/cognition-panel", () => ({
  CognitionPanel: (props: { projectPath: string; onClose: () => void }) => (
    <div data-testid="cognition-panel">
      <span>{props.projectPath}</span>
      <button data-testid="cognition-close" onClick={props.onClose}>close</button>
    </div>
  ),
}))

vi.mock("@/components/novel/persona-critique-panel", () => ({
  PersonaCritiquePanel: (props: { projectPath: string; onClose: () => void }) => (
    <div data-testid="persona-panel">
      <span>{props.projectPath}</span>
      <button data-testid="persona-close" onClick={props.onClose}>close</button>
    </div>
  ),
}))

vi.mock("@/components/novel/de-ai-preview-dialog", () => ({
  DeAiPreviewDialog: (props: Record<string, any>) => (
    <div
      data-testid="de-ai-dialog"
      data-open={String(props.open)}
      data-mode={props.mode}
      data-has-failed={String(Boolean(props.editResult && !props.editResult.ok))}
      data-processing={String(Boolean(props.processing))}
      data-edit-error={props.editError ?? ""}
      data-candidate={props.candidateContent}
      data-applied={props.editResult && props.editResult.ok ? String(props.editResult.applied.length) : ""}
    >
      {props.open && (
        <>
          <button data-testid="de-ai-switch-detect" onClick={() => props.onModeChange?.("detect")}>detect</button>
          <button data-testid="de-ai-switch-rewrite" onClick={() => props.onModeChange?.("rewrite")}>rewrite</button>
          <button data-testid="de-ai-switch-edit" onClick={() => props.onModeChange?.("edit")}>edit</button>
          <button data-testid="de-ai-apply" onClick={props.onApply}>apply</button>
          <button data-testid="de-ai-save-draft" onClick={props.onSaveDraft}>draft</button>
          <button data-testid="de-ai-close" onClick={props.onClose}>close</button>
        </>
      )}
    </div>
  ),
}))

vi.mock("@/components/novel/de-ai-batch-dialog", () => ({
  DeAiBatchDialog: (props: Record<string, any>) => (
    <div data-testid="de-ai-batch-dialog" data-open={String(props.open)} data-running={String(props.running)}>
      <button data-testid="de-ai-batch-cancel" onClick={props.onCancel}>cancel</button>
      <button data-testid="de-ai-batch-accept-all" onClick={props.onAcceptAll}>accept-all</button>
      <button data-testid="de-ai-batch-accept-1" onClick={() => props.onAcceptChapter(1)}>accept-1</button>
      <button data-testid="de-ai-batch-reject-1" onClick={() => props.onRejectChapter(1)}>reject-1</button>
      <button data-testid="de-ai-batch-close" onClick={props.onClose}>close</button>
    </div>
  ),
}))

vi.mock("@/components/novel/text-transform-preview-dialog", () => ({
  TextTransformPreviewDialog: (props: Record<string, any>) => (
    <div data-testid="tt-dialog" data-open={String(props.open)} data-title={props.title}>
      <button data-testid="tt-apply" onClick={props.onApply}>apply</button>
      <button data-testid="tt-close" onClick={props.onClose}>close</button>
    </div>
  ),
}))

vi.mock("@/components/novel/snapshot-viewer", () => ({
  SnapshotViewer: (props: { projectPath: string; chapterNumber: number; onClose: () => void }) => (
    <div data-testid="snapshot-viewer">
      <span>{props.projectPath}:{props.chapterNumber}</span>
      <button data-testid="snapshot-close" onClick={props.onClose}>close</button>
    </div>
  ),
}))

vi.mock("@/lib/novel/chapter-meta", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/chapter-meta")>()
  return {
    ...actual,
    isFinalChapter: vi.fn((frontmatter: Record<string, unknown>) => (
      mocks.chapterMetaFinalGate.value && actual.isFinalChapter(frontmatter)
    )),
  }
})

import { PreviewPanel } from "./preview-panel"
import { WritingWorkspace } from "./writing-workspace"
import type { PreviewPanelAdoptionStart, PreviewPanelWriteGate } from "./preview-panel"
import {
  createChapterWriteCoordinator,
  getChapterWriteCoordinator,
  resetChapterWriteCoordinator,
  normalizeChapterWriting,
  type ChapterWriteCoordinator,
} from "./preview-panel-helpers"
import zhLocale from "@/i18n/zh.json"

function lookupZhLocale(key: string): string | undefined {
  let o: unknown = zhLocale
  for (const p of key.split(".")) {
    if (o == null || typeof o !== "object") return undefined
    o = (o as Record<string, unknown>)[p]
  }
  return typeof o === "string" ? o : undefined
}

async function flushAsync(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

/**
 * 起一次采纳受理。begin 会等「装载守卫真正提交到 DOM」，必须让一次渲染发生；
 * 把 `await begin()` 塞进同一个 async act 会自锁（act 内的更新要等回调结束才提交）。
 */
async function beginAdoption(
  gateRef: { current: PreviewPanelWriteGate | null },
  path: string,
): Promise<PreviewPanelAdoptionStart> {
  const pending = gateRef.current!.begin(path)
  await flushAsync(20)
  return pending
}

async function renderPanel(): Promise<{ rerender: () => void; cleanup: () => void }> {
  const view = render(<PreviewPanel />)
  await flushAsync(10)
  return {
    rerender: () => view.rerender(<PreviewPanel />),
    cleanup: () => view.unmount(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  setupDomGlobals()
  // 写入协调器是同进程共享实例：每个用例从干净的瞬时状态开始。
  resetChapterWriteCoordinator()
  mocks.state.project = { path: "/proj" }
  mocks.state.selectedFile = null
  mocks.state.selectedTrashItem = null
  mocks.state.fileContent = ""
  mocks.state.novelMode = true
  mocks.state.chatExpanded = false
  mocks.state.pendingEditorHighlight = null
  mocks.state.finalChapterSave = null
  mocks.state.novelConfig = { reviewBeforeSave: false, autoIngestOnSave: false }
  mocks.state.llmConfig = { provider: "openai", apiKey: "k", model: "m" }
  mocks.outlineState.tasks = []
  mocks.compactToolbar.value = true
  mocks.chapterMetaFinalGate.value = true
  mocks.saveText.value = "用户改动的内容"
  mocks.selectionText.value = "选中文本"
  mocks.deAiAdapterImportError.value = null
  mocks.realEditor.value = false
  mocks.confirmTarget.value = CHAPTER_PATH
  mocks.acceptChapterDraft.mockResolvedValue(undefined)
  mocks.state.focusMode = false
  mocks.state.chatDockPosition = "bottom"
  mocks.state.dataVersion = 0
  mocks.state.thrilSoftGateAcknowledgedByChapter = {}
  mocks.state.setFocusMode = vi.fn((value: boolean) => { mocks.state.focusMode = value })
  mocks.state.setActiveView = vi.fn()
  mocks.getFileModifiedTime.mockResolvedValue(0)
  mocks.readFile.mockResolvedValue("")
  mocks.writeFileAtomic.mockResolvedValue(undefined)
  mocks.writeFileAtomic.mockResolvedValue(undefined)
  mocks.listDirectory.mockResolvedValue([])
  mocks.deleteFile.mockResolvedValue(undefined)
  mocks.fileExists.mockResolvedValue(false)
  mocks.hasUsableLlm.mockReturnValue(true)
  mocks.reviewChapter.mockResolvedValue([])
  mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "extract_failed" })
  mocks.streamChat.mockReset()
})

afterEach(() => {
  rtlCleanup()
  vi.restoreAllMocks()
})

describe("PreviewPanel 空态与加载态", () => {
  it("无选中文件时显示可操作空态（指引 + 快捷入口）并清空内容", async () => {
    mocks.state.fileTree = [
      { name: "章节", path: "/proj/wiki/chapters", is_dir: true, children: [
        { name: "chapter-001.md", path: "/proj/wiki/chapters/chapter-001.md", is_dir: false },
        { name: "chapter-002.md", path: "/proj/wiki/chapters/chapter-002.md", is_dir: false },
      ] },
    ]
    const { cleanup } = await renderPanel()
    // ui-audit-20261016 P0：旧空态只有一句「选择文件以预览」（无动作），
    // 现在必须给出下一步指引 + 最近章节快捷入口。
    expect(screen.getByTestId("preview-empty-state")).toBeInTheDocument()
    expect(screen.getByText("还没有打开章节")).toBeInTheDocument()
    expect(screen.getByText(/在左侧「章节」面板点一章/)).toBeInTheDocument()
    const chips = screen.getByTestId("preview-empty-recent").querySelectorAll("button")
    expect(chips.length).toBe(2)
    fireEvent.click(chips[0])
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("/proj/wiki/chapters/chapter-002.md")
    expect(mocks.state.setFileContent).toHaveBeenCalledWith("")
    cleanup()
  })

  it("无章节时显示可点新建入口（不再是一句无动作提示）", async () => {
    mocks.state.fileTree = []
    const { cleanup } = await renderPanel()
    expect(screen.getByTestId("preview-empty-create")).toBeInTheDocument()
    cleanup()
  })

  it("无项目时同样显示空态", async () => {
    mocks.state.project = null
    const { cleanup } = await renderPanel()
    expect(screen.getByTestId("preview-empty-state")).toBeInTheDocument()
    cleanup()
  })

  it("选中二进制文件时直接进入 FilePreview 分支", async () => {
    mocks.state.selectedFile = "/proj/assets/cover.png"
    const { cleanup } = await renderPanel()
    expect(screen.getByTestId("file-preview")).toBeInTheDocument()
    expect(screen.getByText("/proj/assets/cover.png")).toBeInTheDocument()
    cleanup()
  })

  it("readFile 挂起时显示 loading 文案", async () => {
    mocks.state.selectedFile = "/proj/wiki/notes.md"
    mocks.readFile.mockReturnValue(new Promise(() => {}))
    const { cleanup } = await renderPanel()
    expect(screen.getByText("正在加载...")).toBeInTheDocument()
    cleanup()
  })

  it("预览头关闭按钮具备可访问名（aria-label）", async () => {
    mocks.state.selectedFile = "/proj/wiki/notes.md"
    mocks.readFile.mockResolvedValue("# 笔记\n\n内容")
    const { cleanup } = await renderPanel()
    expect(screen.getByLabelText("关闭预览")).toBeInTheDocument()
    cleanup()
  })

  it("非章节 markdown 读取成功 → WikiEditor(read 模式) + 非章节保存走原样写入", async () => {
    mocks.state.selectedFile = "/proj/wiki/notes.md"
    mocks.readFile.mockResolvedValue("# 笔记\n\n内容")
    const { cleanup } = await renderPanel()
    expect(screen.getByTestId("wiki-editor")).toBeInTheDocument()
    expect(screen.getByTestId("editor-mode").textContent).toBe("read")
    expect(screen.getByTestId("editor-content").textContent).toBe("# 笔记\n\n内容")
    fireEvent.click(screen.getByTestId("editor-save"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalledWith("/proj/wiki/notes.md", "用户改动的内容"), { timeout: 3000 })
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
    cleanup()
  })

  // R4 共识（deepseek+glm high；glm+qwen critical）: 原先把错误文本写进编辑器内容，
  // 编辑器再 emit 会被 1s 防抖写回覆盖原文件（数据丢失）。
  // 旧断言把该缺陷写成了预期（断言编辑器里出现 “Error loading file”）——评审债，已反转：
  // 现在断言编辑器内容**未被污染**、失败如实上报，且在防抖窗口后确实没有发生回写。
  it("读取失败 → 编辑器内容不被错误文本污染（杜绝回写覆盖）+ 如实上报", async () => {
    mocks.state.selectedFile = "/proj/wiki/notes.md"
    mocks.readFile.mockRejectedValue(new Error("boom"))
    const { cleanup } = await renderPanel()
    expect(screen.getByTestId("wiki-editor")).toBeInTheDocument()
    expect(screen.getByTestId("editor-content").textContent).toBe("")
    expect(screen.getByText(/操作失败：boom/)).toBeInTheDocument()
    // 数据丢失证明：即便过了防抖窗口，也不得把任何内容写回磁盘
    await flushAsync(1200)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    cleanup()
  })

  it("保存与磁盘内容一致时跳过写入（no-op save）", async () => {
    mocks.state.selectedFile = "/proj/wiki/notes.md"
    mocks.saveText.value = "# 笔记\n\n内容"
    mocks.readFile.mockResolvedValue("# 笔记\n\n内容")
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-save"))
    await flushAsync(1200)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    cleanup()
  })
})

describe("PreviewPanel 章节数据态与章节标题交互", () => {
  it("章节文件加载 → 章节头渲染（draft 徽章 + 字数）+ 标题输入框交互", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()

    const input = screen.getByRole("textbox")
    expect(input).toHaveValue("第一章")
    expect(screen.getByText("草稿")).toBeInTheDocument()
    expect(screen.getByText(/^\d+字$/)).toBeInTheDocument()

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "新标题" } })
    expect(input).toHaveValue("新标题")
    // 实现：Enter 处理器只调用 e.currentTarget.blur()（preview-panel.tsx onKeyDown），
    // jsdom 中 blur() 不派发 React onBlur，需显式 fireEvent.blur 触发 commitChapterTitleDraft。
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.blur(input)
    // 实现：commitChapterTitleDraft → syncChapterToCanonicalPath（preview-panel.tsx），
    // 标题经 makeDefaultChapterTitle 规范为「第N章-名称」并写入新的 canonical 路径，
    // 随后 deleteFile 旧路径。
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled())
    const writeArgs = mocks.writeFileAtomic.mock.calls[0] as [string, string]
    expect(writeArgs[0]).toBe("/proj/wiki/chapters/第1章-新标题.md")
    expect(writeArgs[1]).toContain("# 第1章-新标题")
    expect(writeArgs[1]).toContain('title: "第1章-新标题"')
    expect(mocks.deleteFile).toHaveBeenCalledWith(CHAPTER_PATH)
    cleanup()
  })

  it("标题已规范时 commit 早退（nextTitle === chapterDisplayTitle）", async () => {
    const md = CHAPTER_MD.replace("# 第一章", "# 第1章-第一章").replace('title: "第一章"', 'title: "第1章-第一章"')
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = md
    mocks.readFile.mockResolvedValue(md)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    fireEvent.focus(input)
    fireEvent.blur(input)
    await flushAsync(20)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    cleanup()
  })

  it("Escape 取消标题编辑", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "不要这个" } })
    fireEvent.keyDown(input, { key: "Escape" })
    expect(input).toHaveValue("第一章")
    cleanup()
  })

  it("标题同步失败 → console.error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.writeFileAtomic.mockRejectedValue(new Error("write-fail"))
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "新标题" } })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.blur(input) // jsdom 需显式 blur 触发 commit（同上用例）
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    expect(String(errSpy.mock.calls[0][0])).toContain("章节标题同步失败")
    errSpy.mockRestore()
    cleanup()
  })

  it("final 状态的章节渲染 final 徽章（Check 图标分支）", async () => {
    const finalMd = CHAPTER_MD.replace("chapter_status: draft", "chapter_status: final")
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = finalMd
    mocks.readFile.mockResolvedValue(finalMd)
    const { cleanup } = await renderPanel()
    expect(screen.getByText("正式章节")).toBeInTheDocument()
    cleanup()
  })

  it("archived 状态章节走 else 徽章分支", async () => {
    const archivedMd = CHAPTER_MD.replace("chapter_status: draft", "chapter_status: archived")
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = archivedMd
    mocks.readFile.mockResolvedValue(archivedMd)
    const { cleanup } = await renderPanel()
    expect(screen.getByText("废弃草稿")).toBeInTheDocument()
    cleanup()
  })

  it("章节头为空（无标题正文）→ 从路径推导显示标题", async () => {
    const md = [
      "---",
      'type: chapter',
      "chapter_number: 2",
      "chapter_status: draft",
      "---",
      "",
      "没有标题正文",
      "",
    ].join("\n")
    mocks.state.selectedFile = "/proj/wiki/chapters/第二章-测试.md"
    mocks.state.fileContent = md
    mocks.readFile.mockResolvedValue(md)
    const { cleanup } = await renderPanel()
    expect(screen.getByRole("textbox")).toHaveValue("第二章-测试")
    cleanup()
  })
})

describe("PreviewPanel 工具栏收敛回归锁定 (C项防退化)", () => {
  it("章节工具栏默认 compact：More 按钮存在，非 compact 全铺按钮不存在", async () => {
    // compact+More 骨架是 C 折叠的既有实现：默认 compact=true（:237），
    // compact 下动作进 More 溢出菜单（:1278），非 compact 全铺（:1433+）仅宽屏响应式触发。
    // 本用例锁定该行为，防后续改动退化为全铺默认。
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    // More 按钮存在（compact 模式标志）
    expect(screen.getByLabelText("更多功能")).toBeInTheDocument()
    // More 菜单默认关闭（溢出项不在 DOM）
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    // 打开 More 后溢出动作出现（去 AI 味/排版等进菜单而非常显）
    fireEvent.click(screen.getByLabelText("更多功能"))
    await waitFor(() => expect(screen.getByRole("group")).toBeInTheDocument())
    cleanup()
  })
})

describe("PreviewPanel 文件切换与保存 flush", () => {
  it("S4-R2：pagehide 刷出待保存章节（防抖窗口内不丢稿）", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.saveText.value = CHAPTER_MD + "\n新增段落"
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-save"))
    mocks.writeFileAtomic.mockClear()
    fireEvent(window, new Event("pagehide"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled())
    expect(mocks.writeFileAtomic.mock.calls[0][0]).toBe(CHAPTER_PATH)
    view.unmount()
  })

  it("S4-R2：visibilitychange hidden 刷出待保存章节", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.saveText.value = CHAPTER_MD + "\n新增段落"
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-save"))
    mocks.writeFileAtomic.mockClear()
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true })
    document.dispatchEvent(new Event("visibilitychange"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled())
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
    view.unmount()
  })

  it("章节切换到另一文件时 flush 前一章节（canonical 路径相同 → 不删除）", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-save"))
    mocks.state.selectedFile = "/proj/wiki/chapters/第二章.md"
    // 不要直接改写 state.fileContent：组件首个 effect 会把 fileContentRef 同步为最新
    // store 值（preview-panel.tsx useEffect [fileContent]），导致 flush 拿到新文件内容并
    // 把前一章节重命名到新文件的 canonical 名。真实流程中内容由 readFile 异步装载。
    mocks.readFile.mockResolvedValue("# 第二章\n\n内容")
    view.rerender(<PreviewPanel />)
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled())
    expect(mocks.writeFileAtomic.mock.calls[0][0]).toBe(CHAPTER_PATH)
    expect(mocks.deleteFile).not.toHaveBeenCalled()
    view.unmount()
  })

  it("flush 时目标路径与当前不同 → 删除旧文件 + 刷新树 + 更新选中路径", async () => {
    const nonCanonical = "/proj/wiki/chapters/旧名字.md"
    const md = CHAPTER_MD
    mocks.state.selectedFile = nonCanonical
    mocks.state.fileContent = md
    mocks.readFile.mockResolvedValue(md)
    mocks.saveText.value = md + "\n新增段落"
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-save"))
    view.unmount()
    await flushAsync(20)
    expect(mocks.writeFileAtomic).toHaveBeenCalled()
    expect(mocks.deleteFile).toHaveBeenCalledWith(nonCanonical)
    expect(mocks.state.setFileTree).toHaveBeenCalled()
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith(CHAPTER_PATH)
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
  })

  it("finalChapterSave saving 中同路径 → flush 早退", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.finalChapterSave = { projectPath: "/proj", filePath: CHAPTER_PATH, saving: true, phase: "saving" }
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-save"))
    view.unmount()
    await flushAsync(20)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("章节文件 canonical 重命名冲突时走 -2 后缀", async () => {
    // 实现：canonical 重命名只发生在 syncChapterToCanonicalPath（preview-panel.tsx），
    // 触发点是 flush（切文件/卸载）或标题提交；editor-save 的 handleSave 只写当前路径。
    // 故用「编辑 + 卸载 flush」触发：内容带 frontmatter 标题「第一章」→ canonical 名为
    // 第1章.md；fileExists 仅占用第1章.md → getUniqueSiblingPath 返回第1章-2.md。
    mocks.state.selectedFile = "/proj/wiki/chapters/第一章.md"
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.saveText.value = CHAPTER_MD + "\n新增段落"
    mocks.fileExists.mockImplementation(async (p: string) => p === "/proj/wiki/chapters/第1章.md")
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-save"))
    view.unmount()
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalledWith("/proj/wiki/chapters/第1章-2.md", expect.anything()), { timeout: 3000 })
    expect(mocks.deleteFile).toHaveBeenCalledWith("/proj/wiki/chapters/第一章.md")
  })

  it("canonical 全部被占 → Date.now 兜底", async () => {
    // 同上一用例：经卸载 flush 触发 syncChapterToCanonicalPath；
    // fileExists 恒 true → getUniqueSiblingPath 1..99 全占 → 第1章-<Date.now()>.md。
    mocks.state.selectedFile = "/proj/wiki/chapters/第一章.md"
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.saveText.value = CHAPTER_MD + "\n新增段落"
    mocks.fileExists.mockResolvedValue(true)
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-save"))
    view.unmount()
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalledWith(expect.stringMatching(/第1章-\d+\.md$/), expect.anything()), { timeout: 3000 })
  })

  it("无标题内容 → canonical 路径 = 当前路径（无重命名）", async () => {
    const md = "# 无前置元数据\n\n正文"
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = md
    mocks.readFile.mockResolvedValue(md)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-save"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled(), { timeout: 3000 })
    expect(mocks.writeFileAtomic.mock.calls[0][0]).toBe(CHAPTER_PATH)
    expect(mocks.deleteFile).not.toHaveBeenCalled()
    cleanup()
  })

  it("切换文件时 flush 失败 → console.error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.writeFileAtomic.mockRejectedValue(new Error("flush-fail"))
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-save"))
    mocks.state.selectedFile = "/proj/wiki/chapters/第二章.md"
    mocks.readFile.mockResolvedValue("# 二")
    view.rerender(<PreviewPanel />)
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    expect(String(errSpy.mock.calls[0][0])).toContain("切换章节前同步文件失败")
    errSpy.mockRestore()
    view.unmount()
  })
})

describe("PreviewPanel 大纲摄入", () => {
  it("大纲文件加载 → 检测初始记忆已提取（fileExists true）", async () => {
    mocks.state.selectedFile = OUTLINE_PATH
    mocks.state.fileContent = "# 大纲\n\n内容"
    mocks.readFile.mockResolvedValue("# 大纲\n\n内容")
    mocks.fileExists.mockResolvedValue(true)
    mocks.compactToolbar.value = false
    const { cleanup } = await renderPanel()
    await waitFor(() => expect(screen.getByText(/已提取记忆/)).toBeInTheDocument())
    expect(mocks.fileExists).toHaveBeenCalledWith(expect.stringContaining(".novel/snapshots/outline-"))
    cleanup()
  })

  it("大纲摄入按钮（compact 菜单）触发 startOutlineIngestTask", async () => {
    mocks.state.selectedFile = OUTLINE_PATH
    mocks.state.fileContent = "# 大纲"
    mocks.readFile.mockResolvedValue("# 大纲")
    mocks.fileExists.mockResolvedValue(false)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    await waitFor(() => expect(screen.getByText("提取初始记忆")).toBeInTheDocument())
    fireEvent.click(screen.getByText("提取初始记忆"))
    expect(mocks.startOutlineIngestTask).toHaveBeenCalledWith("/proj", OUTLINE_PATH)
    cleanup()
  })

  it("摄入中任务 → 按钮禁用文案 + message 写入 saveStatus", async () => {
    // 实现：加载 effect 在 readFile 解析后调用 setSaveStatus("")（preview-panel.tsx），
    // 会覆盖任务 message；只有 currentOutlineTask 变化时 message effect 重跑，saveStatus
    // 才保留。本 mock store 无订阅，需 rerender 注入 ingesting 任务触发该 effect。
    mocks.state.selectedFile = OUTLINE_PATH
    mocks.state.fileContent = "# 大纲"
    mocks.readFile.mockResolvedValue("# 大纲")
    const view = render(<PreviewPanel />)
    await flushAsync(20)
    mocks.outlineState.tasks = [{
      id: "t1",
      projectPath: "/proj",
      kind: "ingest",
      genre: "", scale: "", premise: "", prompt: "", userRequest: "",
      selectedSectionKey: null, displayTitle: null, writeMode: null,
      targetPath: null, outlinePath: OUTLINE_PATH,
      status: "ingesting",
      message: "正在提取大纲记忆",
      error: null,
      createdAt: 1, updatedAt: 1,
    }]
    view.rerender(<PreviewPanel />)
    await waitFor(() => expect(screen.getByText("正在提取大纲记忆")).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText("更多功能"))
    await waitFor(() => expect(screen.getByText("正在提取初始记忆...")).toBeInTheDocument())
    view.unmount()
  })

  it("fileExists 拒绝 → outlineIngested false", async () => {
    mocks.state.selectedFile = OUTLINE_PATH
    mocks.state.fileContent = "# 大纲"
    mocks.readFile.mockResolvedValue("# 大纲")
    mocks.fileExists.mockRejectedValue(new Error("x"))
    const { cleanup } = await renderPanel()
    await flushAsync(20)
    fireEvent.click(screen.getByLabelText("更多功能"))
    expect(screen.getByText("提取初始记忆")).toBeInTheDocument()
    cleanup()
  })

  it("非大纲文件时不触发快照存在性检查", async () => {
    mocks.state.selectedFile = "/proj/wiki/notes.md"
    mocks.state.fileContent = "# 笔记"
    mocks.readFile.mockResolvedValue("# 笔记")
    const { cleanup } = await renderPanel()
    await flushAsync(20)
    expect(mocks.fileExists).not.toHaveBeenCalled()
    cleanup()
  })
})

describe("PreviewPanel 保存为正式章节（handleSaveAsFinal）", () => {
  function chapterSetup(novelConfig: Record<string, any>): void {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.novelConfig = novelConfig
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.compactToolbar.value = false
  }

  it("reviewBeforeSave + 错误 → blocked_by_review 并写入 review entry", async () => {
    chapterSetup({ reviewBeforeSave: true, autoIngestOnSave: false })
    mocks.reviewChapter.mockResolvedValue([
      { severity: "error", type: "consistency", message: "错误", evidence: "", relatedMemory: "", suggestion: "" },
      { severity: "warning", type: "consistency", message: "警告", evidence: "", relatedMemory: "", suggestion: "" },
    ])
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("保存为正式章节"))
    // 实现：handleSaveAsFinal 传 chapterFrontmatter.chapterNumber（preview-panel.tsx），
    // parseFrontmatter 返回原始 YAML 键（chapter_number），故该字段为 undefined。
    await waitFor(() => expect(mocks.reviewChapter).toHaveBeenCalledWith("/proj", CHAPTER_MD, undefined))
    expect(mocks.reviewState.addNovelReviewEntry).toHaveBeenCalled()
    expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      // findings-2 W-08：文案键声明了 {{details}}，调用点必须传具体问题清单（前 3 条）
      expect.objectContaining({ saving: false, phase: "blocked_by_review", params: { count: 1, warnings: 1, details: "错误" } }),
    )
    cleanup()
  })

  it("reviewBeforeSave + 仅警告 → review_warnings 后继续保存", async () => {
    chapterSetup({ reviewBeforeSave: true, autoIngestOnSave: false })
    mocks.reviewChapter.mockResolvedValue([
      { severity: "warning", type: "consistency", message: "警告", evidence: "", relatedMemory: "", suggestion: "" },
    ])
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("保存为正式章节"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled())
    expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ saving: true, phase: "review_warnings", params: { count: 1 } }),
    )
    cleanup()
  })

  it("review 抛错 → review_failed_proceed 后继续保存", async () => {
    chapterSetup({ reviewBeforeSave: true, autoIngestOnSave: false })
    mocks.reviewChapter.mockRejectedValue(new Error("llm down"))
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("保存为正式章节"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled())
    expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ saving: true, phase: "review_failed_proceed" }),
    )
    cleanup()
  })

  it("直接保存（无审查）→ saved", async () => {
    chapterSetup({ reviewBeforeSave: false, autoIngestOnSave: false })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("保存为正式章节"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled())
    expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ saving: false, phase: "saved" }),
    )
    expect(mocks.writeFileAtomic.mock.calls[0][1]).toContain("chapter_status: final")
    cleanup()
  })

  it("autoIngestOnSave + 无可用 LLM → ingest_no_llm", async () => {
    chapterSetup({ reviewBeforeSave: false, autoIngestOnSave: true })
    mocks.hasUsableLlm.mockReturnValue(false)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("保存为正式章节"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ saving: false, phase: "ingest_no_llm" }),
    ))
    cleanup()
  })

  it("autoIngestOnSave + memory completed → ingested", async () => {
    chapterSetup({ reviewBeforeSave: false, autoIngestOnSave: true })
    mocks.ingestChapter.mockResolvedValue(COMPLETED_MEMORY_INGEST)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("保存为正式章节"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ saving: false, phase: "ingested", params: { chapter: 1 } }),
    ), { timeout: 3000 })
    expect(mocks.importState.startTask).toHaveBeenCalled()
    expect(mocks.importState.finishTask).toHaveBeenCalledWith("task-1", "done", expect.anything())
    cleanup()
  })

  it.each([
    { failedProjections: ["vector"], pendingProjections: [], terminal: "error" },
    { failedProjections: [], pendingProjections: ["community_summary"], terminal: "pending" },
  ])("keeps formal save distinct from incomplete memory: %j", async ({ terminal, ...projections }) => {
    chapterSetup({ reviewBeforeSave: false, autoIngestOnSave: true })
    mocks.ingestChapter.mockResolvedValue({
      ...COMPLETED_MEMORY_INGEST,
      ...projections,
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("保存为正式章节"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ saving: false, phase: "ingest_incomplete" }),
    ))
    expect(mocks.writeFileAtomic.mock.calls[0][1]).toContain("chapter_status: final")
    expect(mocks.importState.finishTask).toHaveBeenCalledWith("task-1", terminal, expect.anything())
    cleanup()
  })

  it("autoIngestOnSave + invalid_chapter_number → ingest_no_chapter_number", async () => {
    chapterSetup({ reviewBeforeSave: false, autoIngestOnSave: true })
    mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "invalid_chapter_number" })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("保存为正式章节"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingest_no_chapter_number" }),
    ))
    cleanup()
  })

  it("autoIngestOnSave + not_final → ingest_not_final", async () => {
    chapterSetup({ reviewBeforeSave: false, autoIngestOnSave: true })
    mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "not_final" })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("保存为正式章节"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingest_not_final" }),
    ))
    cleanup()
  })

  it("autoIngestOnSave + extract_failed → ingest_extract_failed", async () => {
    chapterSetup({ reviewBeforeSave: false, autoIngestOnSave: true })
    mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "extract_failed" })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("保存为正式章节"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingest_extract_failed" }),
    ))
    cleanup()
  })

  it("autoIngestOnSave + 其他 failReason → ingest_failed", async () => {
    chapterSetup({ reviewBeforeSave: false, autoIngestOnSave: true })
    mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "unknown" })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("保存为正式章节"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingest_failed" }),
    ))
    cleanup()
  })

  it("autoIngestOnSave + 磁盘验证非 final → 重写回写后提取", async () => {
    chapterSetup({ reviewBeforeSave: false, autoIngestOnSave: true })
    mocks.ingestChapter.mockResolvedValue(COMPLETED_MEMORY_INGEST)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("保存为正式章节"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingested" }),
    ), { timeout: 3000 })
    expect(mocks.writeFileAtomic).toHaveBeenCalled()
    cleanup()
  })

  it("formal write failure is announced as a save failure, not a memory failure", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    chapterSetup({ reviewBeforeSave: false, autoIngestOnSave: false })
    mocks.writeFileAtomic.mockRejectedValue(new Error("disk-full"))
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("保存为正式章节"))
    await waitFor(() => expect(mocks.t).toHaveBeenCalledWith("chat.saveFailed", { message: "disk-full" }))
    expect(mocks.ingestChapter).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
    cleanup()
  })

  it("无项目时 save-as-final 按钮不渲染（canSaveAsFinal=false）", async () => {
    mocks.state.project = null
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.compactToolbar.value = false
    const { cleanup } = await renderPanel()
    expect(screen.queryByText("保存为正式章节")).not.toBeInTheDocument()
    cleanup()
  })
})

describe("PreviewPanel 重新提取（handleReingest）", () => {
  function finalSetup(): void {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD.replace("chapter_status: draft", "chapter_status: final")
    mocks.readFile.mockResolvedValue(mocks.state.fileContent)
    mocks.compactToolbar.value = false
  }

  it("快照存在但缺少回执时不报成功", async () => {
    finalSetup()
    mocks.ingestChapter.mockResolvedValue({ snapshot: { chapterNumber: 1 }, failReason: null })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("重新提取记忆"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "reingest_unverified" }),
    ))
    expect(mocks.importState.finishTask).toHaveBeenCalledWith("task-1", "error", expect.objectContaining({ completed: 0 }))
    expect(screen.queryByRole("button", { name: "复制核验回执" })).not.toBeInTheDocument()
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    cleanup()
  })

  it("只有回读来源、快照链和账本通过后才显示成功并可复制原回执", async () => {
    finalSetup()
    const source = CHAPTER_MD.replace("chapter_status: draft", "chapter_status: final")
    const hash = (text: string) => createHash("sha256").update(text).digest("hex")
    const extraction = { chapterNumber: 1, snapshotId: "chapter-1-r3", revision: 3, isHistorical: false }
    const extractionHistoryPath = "/proj/.novel/snapshots/history/001/2026-01-02T03-04-05.snapshot.json"
    const projected = JSON.stringify({ ...extraction, snapshotId: "chapter-1-r4", revision: 4, supersedes: "chapter-1-r3" }, null, 2)
    const reads = new Map([
      [CHAPTER_PATH, source],
      [extractionHistoryPath, JSON.stringify({ ...extraction, isHistorical: true }, null, 2)],
      ["/proj/.novel/snapshots/001.snapshot.json", projected],
      ["/proj/.novel/projection-status.json", JSON.stringify({ schemaVersion: "2", chapters: { "1": { sync_snapshot_to_memory: { projection: "sync_snapshot_to_memory", category: "fold_rebuildable", status: "committed", updated_at: "2026-01-02T03:04:05.006Z", last_error: "" } } } })],
    ])
    const receipt = {
      readPath: CHAPTER_PATH,
      chapterNumber: 1,
      bodySha256: hash(parseFrontmatter(source).body),
      contentSha256: hash(source),
      snapshotIdAtExtractionCommit: extraction.snapshotId,
      snapshotRevisionAtExtractionCommit: 3,
      snapshotJsonSha256AtExtractionCommit: hash(JSON.stringify(extraction, null, 2)),
      canonOutcome: { status: "skipped", reason: "no_facts" } as const,
    }
    const projectionReceipt = { extractionHistoryPath, snapshotId: "chapter-1-r4", revision: 4, snapshotJsonSha256: hash(projected) }
    mocks.readFile.mockImplementation(async (path: string) => {
      const data = reads.get(path)
      if (data === undefined) throw new Error(`Unexpected read: ${path}`)
      return data
    })
    mocks.ingestChapter.mockResolvedValue({
      snapshot: { chapterNumber: 1 }, failReason: null, receipt, projectionReceipt,
      ledgerSaveFailed: false, factsStoreFailed: false, failedProjections: [], pendingProjections: [],
      committedProjections: ["sync_snapshot_to_memory"],
    })
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    vi.stubGlobal("crypto", webcrypto)
    try {
      const { cleanup } = await renderPanel()
      fireEvent.click(screen.getByText("重新提取记忆"))
      const button = await screen.findByRole("button", { name: "复制核验回执" })
      expect(mocks.ingestChapter).toHaveBeenCalledWith("/proj", CHAPTER_PATH, "review-model", expect.any(AbortSignal), expect.objectContaining({ awaitCommunitySummary: true }))
      expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(expect.objectContaining({ phase: "reingest_verified", reingestReceipt: { receipt, projectionReceipt } }))
      expect(mocks.importState.finishTask).toHaveBeenCalledWith("task-1", "done", expect.objectContaining({ completed: 1 }))
      expect(writeText).not.toHaveBeenCalled()
      fireEvent.click(button)
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(JSON.stringify({ receipt, projectionReceipt }, null, 2)))
      expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
      cleanup()
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard)
      else Reflect.deleteProperty(navigator, "clipboard")
      vi.unstubAllGlobals()
    }
  })

  it("final 章节 + invalid_chapter_number → ingest_no_chapter_number", async () => {
    finalSetup()
    mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "invalid_chapter_number" })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("重新提取记忆"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingest_no_chapter_number" }),
    ))
    cleanup()
  })

  it("final 章节 + 其他失败 → ingest_failed", async () => {
    finalSetup()
    mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "boom" })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("重新提取记忆"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingest_failed" }),
    ))
    cleanup()
  })

  it("reingest 抛错 → ingest_failed + finishTask error", async () => {
    finalSetup()
    mocks.ingestChapter.mockRejectedValue(new Error("reingest-fail"))
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("重新提取记忆"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingest_failed" }),
    ))
    expect(mocks.importState.finishTask).toHaveBeenCalledWith("task-1", "error", expect.anything())
    cleanup()
  })
})

describe("PreviewPanel 一键排版与去AI味", () => {
  function chapterSetup(): void {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.compactToolbar.value = false
  }

  it("一键排版 → 格式化写入 + bumpDataVersion", async () => {
    chapterSetup()
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("一键排版"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled())
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
    cleanup()
  })

  it("一键排版写盘失败 → console.error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    chapterSetup()
    mocks.writeFileAtomic.mockRejectedValue(new Error("fmt-fail"))
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("一键排版"))
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    expect(String(errSpy.mock.calls[0][0])).toContain("格式化写作内容失败")
    errSpy.mockRestore()
    cleanup()
  })

  it("去AI味流程（onToken/onDone）→ 打开预览对话框", async () => {
    chapterSetup()
    mocks.streamChat.mockImplementation((_cfg: unknown, _msgs: unknown, cb: any) => {
      cb.onToken("改")
      cb.onToken("写")
      cb.onDone()
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.open).toBe("true"))
    expect(mocks.buildDeAiRewriteMessages).toHaveBeenCalled()
    expect(mocks.loadSmartDeAiSkill).toHaveBeenCalled()
    cleanup()
  })

  it("去AI味：空内容早退", async () => {
    chapterSetup()
    mocks.state.fileContent = ""
    // readFile 解析会把内容回填 store（mock setFileContent），后续重渲染（如 ResizeObserver
    // 布局 effect）会读到非空内容；因此装载内容也要置空，保证组件最后一次渲染的
    // fileContent 为空，命中 handleDeAiProcess 的空内容早退（preview-panel.tsx）。
    mocks.readFile.mockResolvedValue("")
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await flushAsync(20)
    expect(mocks.streamChat).not.toHaveBeenCalled()
    cleanup()
  })

  it("去AI味：无可用 LLM → 不调用 streamChat", async () => {
    chapterSetup()
    mocks.hasUsableLlm.mockReturnValue(false)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await flushAsync(20)
    expect(mocks.streamChat).not.toHaveBeenCalled()
    cleanup()
  })

  it("去AI味：onError → console.error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    chapterSetup()
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onError(new Error("llm error"))
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    expect(String(errSpy.mock.calls[0][0])).toContain("去AI味处理失败")
    errSpy.mockRestore()
    cleanup()
  })

  it("去AI味：streamChat 抛错 → console.error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    chapterSetup()
    mocks.streamChat.mockRejectedValue(new Error("transport"))
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    expect(String(errSpy.mock.calls[0][0])).toContain("去AI味处理失败")
    errSpy.mockRestore()
    cleanup()
  })

  it("对话框应用改写 → 保存替换后的正文", async () => {
    chapterSetup()
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("新正文")
      cb.onDone()
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.open).toBe("true"))
    fireEvent.click(screen.getByTestId("de-ai-apply"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled(), { timeout: 3000 })
    expect(mocks.writeFileAtomic.mock.calls[0][1]).toContain("新正文")
    cleanup()
  })

  it("对话框另存草稿 → 写草稿文件 + 刷新树", async () => {
    chapterSetup()
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("草稿内容")
      cb.onDone()
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-save-draft")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("de-ai-save-draft"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled())
    expect(mocks.writeFileAtomic.mock.calls[0][0]).toContain("去AI味稿.md")
    expect(mocks.state.setFileTree).toHaveBeenCalled()
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
    cleanup()
  })

  it("另存草稿失败 → console.error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    chapterSetup()
    mocks.writeFileAtomic.mockRejectedValue(new Error("draft-fail"))
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("x")
      cb.onDone()
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-save-draft")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("de-ai-save-draft"))
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    expect(String(errSpy.mock.calls[0][0])).toContain("另存去AI味草稿失败")
    errSpy.mockRestore()
    cleanup()
  })

  it("对话框关闭（handleDeAiClose）", async () => {
    chapterSetup()
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("x")
      cb.onDone()
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-close")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("de-ai-close"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.open).toBe("false"))
    cleanup()
  })

  it("无项目时去AI味仍可打开对话框（project null 路径）", async () => {
    mocks.state.project = null
    chapterSetup()
    mocks.state.project = null
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("x")
      cb.onDone()
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.open).toBe("true"))
    expect(mocks.loadSmartDeAiSkill).toHaveBeenCalledWith(null, "去AI味润色", undefined)
    cleanup()
  })

  // ── ISS-20260802-003: 去AI味三模式 (detect / rewrite / edit) ──────────────
  it("去AI味三模式：默认模式为 rewrite，透传到对话框", async () => {
    chapterSetup()
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("重写正文")
      cb.onDone()
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.open).toBe("true"))
    expect(screen.getByTestId("de-ai-dialog").dataset.mode).toBe("rewrite")
    expect(mocks.buildDeAiRewriteMessages).toHaveBeenCalled()
    cleanup()
  })

  it("去AI味三模式：切换 detect 模式为零 LLM，不调用 streamChat，且禁止写回正文与草稿", async () => {
    chapterSetup()
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("初始重写")
      cb.onDone()
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.open).toBe("true"))

    // 清除打开时的 streamChat 调用记录
    mocks.streamChat.mockClear()
    mocks.writeFileAtomic.mockClear()

    // 切换至 detect 模式
    fireEvent.click(screen.getByTestId("de-ai-switch-detect"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.mode).toBe("detect"))

    // 零 LLM 断言：切换 detect 模式绝不发起 streamChat
    expect(mocks.streamChat).not.toHaveBeenCalled()

    // detect 模式下点击 apply 或 draft 不执行写盘
    fireEvent.click(screen.getByTestId("de-ai-apply"))
    fireEvent.click(screen.getByTestId("de-ai-save-draft"))
    await flushAsync(20)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    cleanup()
  })

  it("去AI味三模式：edit 模式正常应用 LLM 片段修改并允许写回正文（RV-008 真实 applier 断言）", async () => {
    chapterSetup()
    // 预置可唯一匹配的章节正文（带 frontmatter + 一级标题，验证回写保留）
    const chapterMarkdown = [
      "---",
      'title: "第一章 测试"',
      "chapter_number: 1",
      "---",
      "",
      "# 第一章 测试",
      "",
      "院子里落满了枯叶。显而易见的事实摆在眼前。天色渐暗。",
      "",
    ].join("\n")
    mocks.state.fileContent = chapterMarkdown
    mocks.readFile.mockResolvedValue(chapterMarkdown)

    // 首轮 rewrite
    mocks.streamChat.mockImplementationOnce((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("初始")
      cb.onDone()
      return Promise.resolve()
    })

    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.open).toBe("true"))

    // 切换到 edit 模式：LLM 返回有效 JSON 片段
    mocks.streamChat.mockImplementationOnce((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken(JSON.stringify([
        {
          original_text: "显而易见的事实摆在眼前",
          replacement_text: "真相就在眼前",
          note: "消去AI味",
        },
      ]))
      cb.onDone()
      return Promise.resolve()
    })

    // RV-008: 局部启用真实替换逻辑，断言「真正替换后的正文」落入候选正文与写盘内容
    const origReplace = mocks.replaceChapterBodySelection.getMockImplementation()
    mocks.replaceChapterBodySelection.mockImplementation((currentBody, selection, replacement) => ({
      ok: true as const,
      body: currentBody.replace(selection.text, replacement),
    }))

    try {
      fireEvent.click(screen.getByTestId("de-ai-switch-edit"))
      await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.mode).toBe("edit"))
      await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.hasFailed).toBe("false"))
      await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.applied).toBe("1"))

      // RV-006: edit 请求只带章节正文（frontmatter 与 H1 不进入 LLM 输入）
      const editMessages = mocks.streamChat.mock.calls[1][1] as Array<{ role: string; content: string }>
      expect(editMessages[1].content).not.toContain("chapter_number")
      expect(editMessages[1].content).not.toContain("# 第一章 测试")
      expect(editMessages[1].content).toContain("显而易见的事实摆在眼前")

      fireEvent.click(screen.getByTestId("de-ai-apply"))
      await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled())
      const written = String(mocks.writeFileAtomic.mock.calls[0][1])
      expect(written).toContain("真相就在眼前")
      expect(written).not.toContain("显而易见的事实摆在眼前")
      expect(written).toContain("院子里落满了枯叶。")
      // RV-006: apply 经 replaceWholeChapterBody 写回，首参为保留 frontmatter/标题的原全文
      expect(mocks.replaceWholeChapterBody).toHaveBeenCalledWith(
        chapterMarkdown,
        expect.stringContaining("真相就在眼前"),
      )
    } finally {
      if (origReplace) mocks.replaceChapterBodySelection.mockImplementation(origReplace)
    }
    cleanup()
  })

  it("去AI味三模式：edit 模式另存草稿保留原章标题，不带 frontmatter（避免被当成同号正式章节）", async () => {
    chapterSetup()
    const chapterMarkdown = [
      "---",
      'title: "第一章 测试"',
      "chapter_number: 1",
      "---",
      "",
      "# 第一章 测试",
      "",
      "院子里落满了枯叶。显而易见的事实摆在眼前。天色渐暗。",
      "",
    ].join("\n")
    mocks.state.fileContent = chapterMarkdown
    mocks.readFile.mockResolvedValue(chapterMarkdown)

    const origWhole = mocks.replaceWholeChapterBody.getMockImplementation()
    const origReplace = mocks.replaceChapterBodySelection.getMockImplementation()
    const actual = await vi.importActual<typeof import("@/lib/chapter-selection")>("@/lib/chapter-selection")
    mocks.replaceWholeChapterBody.mockImplementation(actual.replaceWholeChapterBody)
    mocks.replaceChapterBodySelection.mockImplementation((currentBody, selection, replacement) => ({
      ok: true as const,
      body: currentBody.replace(selection.text, replacement),
    }))

    try {
      mocks.streamChat.mockImplementationOnce((_c: unknown, _m: unknown, cb: any) => {
        cb.onToken("初始")
        cb.onDone()
        return Promise.resolve()
      })
      const { cleanup } = await renderPanel()
      fireEvent.click(screen.getByText("去AI味"))
      await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.open).toBe("true"))

      mocks.streamChat.mockImplementationOnce((_c: unknown, _m: unknown, cb: any) => {
        cb.onToken(JSON.stringify([{ original_text: "显而易见的事实摆在眼前", replacement_text: "真相就在眼前", note: "" }]))
        cb.onDone()
        return Promise.resolve()
      })
      fireEvent.click(screen.getByTestId("de-ai-switch-edit"))
      await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.applied).toBe("1"))

      fireEvent.click(screen.getByTestId("de-ai-save-draft"))
      await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled())
      const [draftPath, draft] = mocks.writeFileAtomic.mock.calls[0] as [string, string]
      expect(draftPath).toContain("去AI味稿.md")
      expect(draft.startsWith("# 第一章 测试\n")).toBe(true)
      expect(draft).not.toContain("chapter_number")
      expect(draft).not.toContain("---")
      expect(draft).toContain("真相就在眼前")
      expect(draft).not.toContain("显而易见的事实摆在眼前")
      cleanup()
    } finally {
      if (origWhole) mocks.replaceWholeChapterBody.mockImplementation(origWhole)
      if (origReplace) mocks.replaceChapterBodySelection.mockImplementation(origReplace)
    }
  })

  it("去AI味三模式：edit 模式锚点定位失败（ok: false）时禁止写回正文与草稿", async () => {
    chapterSetup()
    mocks.state.fileContent = "# 第一章 测试\n\n正文内容。"
    mocks.readFile.mockResolvedValue("# 第一章 测试\n\n正文内容。")

    mocks.streamChat.mockImplementationOnce((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("初始")
      cb.onDone()
      return Promise.resolve()
    })

    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.open).toBe("true"))

    // edit 模式返回不存在的原文锚点
    mocks.streamChat.mockImplementationOnce((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken(JSON.stringify([
        {
          original_text: "正文中根本不存在的文本",
          replacement_text: "新文本",
        },
      ]))
      cb.onDone()
      return Promise.resolve()
    })

    fireEvent.click(screen.getByTestId("de-ai-switch-edit"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.mode).toBe("edit"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.hasFailed).toBe("true"))

    mocks.writeFileAtomic.mockClear()
    // 点击 apply 与 save draft 被拦截，不发起写盘
    fireEvent.click(screen.getByTestId("de-ai-apply"))
    fireEvent.click(screen.getByTestId("de-ai-save-draft"))
    await flushAsync(20)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    cleanup()
  })

  // ── ISS-20260802-003 correction round 1: RV-001 / RV-002 / RV-004 ────────
  it("RV-001: 切模式后流未落定时禁用写回，且旧模式候选被清空（apply 不会写回别的模式的内容）", async () => {
    chapterSetup()
    const pending: Array<{ onToken: (token: string) => void; onDone: () => void }> = []
    // 首轮 rewrite 立即完成（对话框打开，candidate=旧模式内容）
    mocks.streamChat.mockImplementationOnce((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("旧模式的改写正文")
      cb.onDone()
      return Promise.resolve()
    })
    // 切 edit 后的流挂起，由用例手动落定
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      pending.push(cb)
      return Promise.resolve()
    })

    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.open).toBe("true"))
    expect(screen.getByTestId("de-ai-dialog").dataset.candidate).toContain("旧模式的改写正文")

    fireEvent.click(screen.getByTestId("de-ai-switch-edit"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.processing).toBe("true"))

    // 处理中：旧模式候选已清空，apply / save-draft 不得写盘
    expect(screen.getByTestId("de-ai-dialog").dataset.candidate).toBe("")
    mocks.writeFileAtomic.mockClear()
    fireEvent.click(screen.getByTestId("de-ai-apply"))
    fireEvent.click(screen.getByTestId("de-ai-save-draft"))
    await flushAsync(20)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()

    // 流落定后 edit 结果才能被应用
    await act(async () => {
      pending[0].onToken(JSON.stringify([
        { original_text: "正文第一段。", replacement_text: "改过的正文第一段。" },
      ]))
      pending[0].onDone()
    })
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.processing).toBe("false"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.mode).toBe("edit"))
    expect(screen.getByTestId("de-ai-dialog").dataset.applied).toBe("1")
    expect(screen.getByTestId("de-ai-dialog").dataset.candidate).toContain("new-body")

    fireEvent.click(screen.getByTestId("de-ai-apply"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled())
    expect(String(mocks.writeFileAtomic.mock.calls[0][1])).toContain("new-body")
    cleanup()
  })

  it("RV-001: 被取代的流（切到 detect 后落定）不得覆写模式或候选", async () => {
    chapterSetup()
    const pending: Array<{ onToken: (token: string) => void; onDone: () => void }> = []
    mocks.streamChat.mockImplementationOnce((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("初始改写")
      cb.onDone()
      return Promise.resolve()
    })
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      pending.push(cb)
      return Promise.resolve()
    })

    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.open).toBe("true"))

    // edit 流在途 → 切回 detect（作废代际）
    fireEvent.click(screen.getByTestId("de-ai-switch-edit"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.processing).toBe("true"))
    fireEvent.click(screen.getByTestId("de-ai-switch-detect"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.mode).toBe("detect"))

    // 过期的 edit 流此时才落定：不得把模式改回 edit、不得写入候选
    await act(async () => {
      pending[0].onToken(JSON.stringify([
        { original_text: "正文第一段。", replacement_text: "过期替换。" },
      ]))
      pending[0].onDone()
    })
    await flushAsync(20)
    expect(screen.getByTestId("de-ai-dialog").dataset.mode).toBe("detect")
    expect(screen.getByTestId("de-ai-dialog").dataset.applied).toBe("")
    expect(screen.getByTestId("de-ai-dialog").dataset.candidate).not.toContain("过期替换。")
    cleanup()
  })

  it("RV-004: 关闭对话框作废在途流，onDone 不再重开对话框", async () => {
    chapterSetup()
    const pending: Array<{ onToken: (token: string) => void; onDone: () => void }> = []
    mocks.streamChat.mockImplementationOnce((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("初始改写")
      cb.onDone()
      return Promise.resolve()
    })
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      pending.push(cb)
      return Promise.resolve()
    })

    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.open).toBe("true"))

    fireEvent.click(screen.getByTestId("de-ai-switch-edit"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.processing).toBe("true"))

    fireEvent.click(screen.getByTestId("de-ai-close"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.open).toBe("false"))

    await act(async () => {
      pending[0].onToken(JSON.stringify([
        { original_text: "正文第一段。", replacement_text: "关闭后的替换。" },
      ]))
      pending[0].onDone()
    })
    await flushAsync(20)
    expect(screen.getByTestId("de-ai-dialog").dataset.open).toBe("false")
    expect(screen.getByTestId("de-ai-dialog").dataset.processing).toBe("false")
    cleanup()
  })

  it("RV-002: edit 输出不可解析 → 错误态且禁止写回正文/草稿", async () => {
    chapterSetup()
    mocks.streamChat.mockImplementationOnce((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("初始改写")
      cb.onDone()
      return Promise.resolve()
    })
    mocks.streamChat.mockImplementationOnce((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("我把这句话改得更自然了一些。")
      cb.onDone()
      return Promise.resolve()
    })

    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.open).toBe("true"))

    fireEvent.click(screen.getByTestId("de-ai-switch-edit"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.editError).toBe("unparseable"))
    expect(screen.getByTestId("de-ai-dialog").dataset.candidate).toBe("")
    expect(screen.getByTestId("de-ai-dialog").dataset.hasFailed).toBe("false")

    mocks.writeFileAtomic.mockClear()
    fireEvent.click(screen.getByTestId("de-ai-apply"))
    fireEvent.click(screen.getByTestId("de-ai-save-draft"))
    await flushAsync(20)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    cleanup()
  })

  it("RV-002: edit 合法但 0 处修改（[]）→ 无可应用内容，禁止写回", async () => {
    chapterSetup()
    mocks.streamChat.mockImplementationOnce((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("初始改写")
      cb.onDone()
      return Promise.resolve()
    })
    mocks.streamChat.mockImplementationOnce((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("[]")
      cb.onDone()
      return Promise.resolve()
    })

    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.open).toBe("true"))

    fireEvent.click(screen.getByTestId("de-ai-switch-edit"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.applied).toBe("0"))
    expect(screen.getByTestId("de-ai-dialog").dataset.editError).toBe("")

    mocks.writeFileAtomic.mockClear()
    fireEvent.click(screen.getByTestId("de-ai-apply"))
    fireEvent.click(screen.getByTestId("de-ai-save-draft"))
    await flushAsync(20)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    cleanup()
  })

  // ── Wave 4 (v2.5.0): 批量去AI味 ──────────────────────────────────────────
  it("批量去AI味：点击 → runDeAiBatch + 对话框打开 + 完成后刷新章节列表", async () => {
    chapterSetup()
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("批量去AI味"))
    await waitFor(() => expect(mocks.runDeAiBatch).toHaveBeenCalled())
    expect(mocks.runDeAiBatch.mock.calls[0][0]).toBe("/proj")
    expect(mocks.runDeAiBatch.mock.calls[0][1].llmConfig).toBeTruthy()
    expect(typeof mocks.runDeAiBatch.mock.calls[0][1].onProgress).toBe("function")
    await waitFor(() => expect(screen.getByTestId("de-ai-batch-dialog").dataset.open).toBe("true"))
    await waitFor(() => expect(mocks.loadDeAiBatchState).toHaveBeenCalled())
    expect(mocks.state.bumpDataVersion).not.toHaveBeenCalled()
    cleanup()
  })

  it("批量去AI味：无可用 LLM → 不调用 runDeAiBatch", async () => {
    chapterSetup()
    mocks.hasUsableLlm.mockReturnValue(false)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("批量去AI味"))
    await flushAsync(20)
    expect(mocks.runDeAiBatch).not.toHaveBeenCalled()
    expect(screen.getByTestId("de-ai-batch-dialog").dataset.open).toBe("false")
    cleanup()
  })

  it("批量去AI味：中止 → abort 控制器", async () => {
    chapterSetup()
    mocks.runDeAiBatch.mockImplementation(async (_p: string, options: DeAiBatchOptions) => {
      options.signal?.addEventListener("abort", () => {})
      return new Promise<DeAiBatchSummary>((resolve) => {
        setTimeout(() => {
          resolve({
            schemaVersion: "de-ai-batch/1.0",
            batchId: "de-ai-1",
            phase: "paused",
            total: 2,
            processed: 1,
            failed: [],
            skipped: 0,
            durationMs: 500,
            startedAt: "2026-08-19T00:00:00.000Z",
            finishedAt: "2026-08-19T00:00:00.500Z",
          })
        }, 50)
      })
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("批量去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-batch-dialog").dataset.open).toBe("true"))
    fireEvent.click(screen.getByTestId("de-ai-batch-cancel"))
    await waitFor(() => expect(mocks.runDeAiBatch.mock.calls[0][1].signal?.aborted).toBe(true))
    cleanup()
  })

  it("批量去AI味：运行失败 → saveStatus 显示错误", async () => {
    chapterSetup()
    mocks.runDeAiBatch.mockRejectedValue(new Error("batch-boom"))
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("批量去AI味"))
    await waitFor(() => expect(screen.getByText(/操作失败：batch-boom/)).toBeTruthy())
    cleanup()
  })

  it("批量回填全部 → acceptAllDeAiBatchDrafts + bumpDataVersion", async () => {
    chapterSetup()
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("批量去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-batch-accept-all")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("de-ai-batch-accept-all"))
    await waitFor(() => expect(mocks.acceptAllDeAiBatchDrafts).toHaveBeenCalledWith("/proj"))
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
    cleanup()
  })

  it("单章回填 → acceptDeAiBatchDraft(1)", async () => {
    chapterSetup()
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("批量去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-batch-accept-1")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("de-ai-batch-accept-1"))
    await waitFor(() => expect(mocks.acceptDeAiBatchDraft).toHaveBeenCalledWith("/proj", 1))
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
    cleanup()
  })

  it("单章拒绝 → rejectDeAiBatchDraft(1)", async () => {
    chapterSetup()
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("批量去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-batch-reject-1")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("de-ai-batch-reject-1"))
    await waitFor(() => expect(mocks.rejectDeAiBatchDraft).toHaveBeenCalledWith("/proj", 1))
    cleanup()
  })

  it("批量对话框关闭（handleDeAiBatchClose）", async () => {
    chapterSetup()
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("批量去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-batch-close")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("de-ai-batch-close"))
    await waitFor(() => expect(screen.getByTestId("de-ai-batch-dialog").dataset.open).toBe("false"))
    cleanup()
  })
})

describe("PreviewPanel 选区变换（handleSelectionAction）", () => {
  function chapterSetup(): void {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
  }

  async function openTransformDialog(): Promise<void> {
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("改写结果")
      cb.onDone()
      return Promise.resolve()
    })
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await waitFor(() => expect(screen.getByTestId("tt-dialog").dataset.open).toBe("true"))
  }

  it("处理中二次点击 → 防重入只调用一次 streamChat", async () => {
    chapterSetup()
    mocks.streamChat.mockImplementation(() => new Promise(() => {}))
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await flushAsync(20)
    expect(mocks.streamChat).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it("处理中点击取消 → 状态「已取消」且不打开预览", async () => {
    chapterSetup()
    const captured: { cb: any; signal: AbortSignal } = {} as { cb: any; signal: AbortSignal }
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any, signal: AbortSignal) => {
      captured.cb = cb
      captured.signal = signal
      return new Promise(() => {})
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await waitFor(() => expect(screen.getByText(/正在调用模型/)).toBeInTheDocument())
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "取消" }))
    expect(captured.signal.aborted).toBe(true)
    // 模拟真实传输层：signal 中止后回调 onDone
    act(() => {
      captured.cb.onDone()
    })
    await waitFor(() => expect(screen.getByText(/已取消/)).toBeInTheDocument())
    expect(screen.getByTestId("tt-dialog").dataset.open).toBe("false")
    cleanup()
  })

  it("零 token 超时 → 黑洞/冷启动失败文案", async () => {
    chapterSetup()
    const { cleanup } = await renderPanel()
    vi.useFakeTimers()
    const captured: { cb: any; signal: AbortSignal } = {} as { cb: any; signal: AbortSignal }
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any, signal: AbortSignal) => {
      captured.cb = cb
      captured.signal = signal
      return new Promise(() => {})
    })
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    act(() => {
      vi.advanceTimersByTime(90_000)
    })
    expect(captured.signal.aborted).toBe(true)
    act(() => {
      captured.cb.onDone()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText(/未返回任何内容/)).toBeInTheDocument()
    vi.useRealTimers()
    cleanup()
  })

  it("有 token 超时 → 生成超时文案", async () => {
    chapterSetup()
    const { cleanup } = await renderPanel()
    vi.useFakeTimers()
    const captured: { cb: any; signal: AbortSignal } = {} as { cb: any; signal: AbortSignal }
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any, signal: AbortSignal) => {
      captured.cb = cb
      captured.signal = signal
      return new Promise(() => {})
    })
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    act(() => {
      captured.cb.onToken("部分内容")
    })
    act(() => {
      vi.advanceTimersByTime(90_000)
    })
    act(() => {
      captured.cb.onDone()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText(/生成超时/)).toBeInTheDocument()
    vi.useRealTimers()
    cleanup()
  })

  it("成功后防重入护栏复位（可再次触发）", async () => {
    chapterSetup()
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("改写结果")
      cb.onDone()
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await waitFor(() => expect(screen.getByTestId("tt-dialog").dataset.open).toBe("true"))
    fireEvent.click(screen.getByTestId("tt-close"))
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await waitFor(() => expect(mocks.streamChat).toHaveBeenCalledTimes(2))
    cleanup()
  })

  it("选中文本为空 → 早退", async () => {
    chapterSetup()
    mocks.selectionText.value = ""
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onDone()
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await flushAsync(30)
    expect(mocks.streamChat).not.toHaveBeenCalled()
    cleanup()
  })

  it("无可用 LLM → saveStatus 提示", async () => {
    chapterSetup()
    mocks.hasUsableLlm.mockReturnValue(false)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await waitFor(() => expect(screen.getByText(/未配置可用的 AI 模型/)).toBeInTheDocument())
    cleanup()
  })

  it("polish 流程 → 打开对话框（AI润色预览）→ 应用替换", async () => {
    chapterSetup()
    const { cleanup } = await renderPanel()
    await openTransformDialog()
    expect(screen.getByTestId("tt-dialog").dataset.title).toContain("AI润色预览")
    expect(mocks.buildPolishSelectionMessages).toHaveBeenCalledWith("选中文本")
    fireEvent.click(screen.getByTestId("tt-apply"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled(), { timeout: 3000 })
    expect(mocks.state.setFileContent).toHaveBeenCalledWith(expect.stringContaining("new-body"))
    cleanup()
  })

  it("de-ai 流程 → 打开对话框（去AI味预览）", async () => {
    chapterSetup()
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("改写结果")
      cb.onDone()
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-selection-deai"))
    await waitFor(() => expect(screen.getByTestId("tt-dialog").dataset.open).toBe("true"))
    expect(screen.getByTestId("tt-dialog").dataset.title).toContain("去AI味预览")
    expect(mocks.buildDeAiRewriteMessages).toHaveBeenCalledWith("选中文本", undefined)
    cleanup()
  })

  it("onError → 脱敏后的失败 saveStatus", async () => {
    chapterSetup()
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onError(new Error("http://secret.example.com/x Bearer abc"))
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await waitFor(() => expect(screen.getByText(/AI润色失败/)).toBeInTheDocument())
    expect(screen.getByText(/\[url\]/)).toBeInTheDocument()
    expect(screen.getByText(/\[redacted\]/)).toBeInTheDocument()
    cleanup()
  })

  it("streamChat 抛错 → 脱敏 catch 路径", async () => {
    chapterSetup()
    mocks.streamChat.mockRejectedValue(new Error("Bearer tok http://x.com"))
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await waitFor(() => expect(screen.getByText(/AI润色失败/)).toBeInTheDocument())
    cleanup()
  })

  it("onDone 时文件已切换 → 不打开对话框", async () => {
    chapterSetup()
    let cb: any
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, callbacks: any) => {
      cb = callbacks
      return new Promise(() => {})
    })
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await flushAsync(10)
    mocks.state.selectedFile = "/proj/wiki/chapters/其他.md"
    mocks.readFile.mockResolvedValue("# 其他")
    view.rerender(<PreviewPanel />)
    await flushAsync(20)
    cb.onDone()
    await flushAsync(30)
    expect(screen.getByTestId("tt-dialog").dataset.open).toBe("false")
    view.unmount()
  })

  it("应用时正文已变化（replace ok=false）→ 关闭并提示", async () => {
    chapterSetup()
    mocks.replaceChapterBodySelection.mockReturnValue({ ok: false, reason: "changed" })
    const { cleanup } = await renderPanel()
    await openTransformDialog()
    fireEvent.click(screen.getByTestId("tt-apply"))
    await waitFor(() => expect(screen.getByText("正文内容已变化，请重新选中文本后再试")).toBeInTheDocument())
    expect(screen.getByTestId("tt-dialog").dataset.open).toBe("false")
    cleanup()
  })

  it("对话框关闭（handleCloseSelectionTransform）", async () => {
    chapterSetup()
    const { cleanup } = await renderPanel()
    await openTransformDialog()
    fireEvent.click(screen.getByTestId("tt-close"))
    await waitFor(() => expect(screen.getByTestId("tt-dialog").dataset.open).toBe("false"))
    cleanup()
  })
})

describe("PreviewPanel 工具栏（compact / expanded）", () => {
  it("compact 模式：更多功能菜单开关 + 会话栏切换", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    const moreBtn = screen.getByLabelText("更多功能")
    fireEvent.click(moreBtn)
    expect(screen.getByText("打开会话栏")).toBeInTheDocument()
    fireEvent.click(screen.getByText("打开会话栏"))
    expect(mocks.state.setChatExpanded).toHaveBeenCalledWith(true)
    expect(screen.queryByText("打开会话栏")).not.toBeInTheDocument()
    cleanup()
  })

  it("compact 模式：chatExpanded=true 显示关闭会话栏", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.chatExpanded = true
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    expect(screen.getByText("关闭会话栏")).toBeInTheDocument()
    fireEvent.click(screen.getByText("关闭会话栏"))
    expect(mocks.state.setChatExpanded).toHaveBeenCalledWith(false)
    cleanup()
  })

  it("compact 模式：查看快照 + 快照查看器渲染（Suspense）", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    fireEvent.click(screen.getByText("查看记忆"))
    await waitFor(() => expect(screen.getByTestId("snapshot-viewer")).toBeInTheDocument())
    expect(screen.getByText("/proj:1")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("snapshot-close"))
    await waitFor(() => expect(screen.queryByTestId("snapshot-viewer")).not.toBeInTheDocument())
    cleanup()
  })

  it("compact 模式：大纲快照查看器", async () => {
    mocks.state.selectedFile = OUTLINE_PATH
    mocks.state.fileContent = "# 大纲"
    mocks.readFile.mockResolvedValue("# 大纲")
    mocks.fileExists.mockResolvedValue(true)
    const { cleanup } = await renderPanel()
    // compact 模式下「已提取记忆」按钮文案位于更多功能下拉内（preview-panel.tsx），
    // 先打开下拉再断言（fileExists 判定 outlineIngested 后文案才切换）。
    fireEvent.click(screen.getByLabelText("更多功能"))
    await waitFor(() => expect(screen.getByText("✓ 已提取记忆")).toBeInTheDocument())
    fireEvent.click(screen.getByText("查看记忆"))
    await waitFor(() => expect(screen.getByTestId("snapshot-viewer")).toBeInTheDocument())
    cleanup()
  })

  it("compact 模式：角色认知 + 人设批判面板", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    fireEvent.click(screen.getByText("角色认知状态"))
    expect(screen.getByTestId("cognition-panel")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("cognition-close"))
    expect(screen.queryByTestId("cognition-panel")).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText("更多功能"))
    fireEvent.click(screen.getByText("多视角评审"))
    expect(screen.getByTestId("persona-panel")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("persona-close"))
    expect(screen.queryByTestId("persona-panel")).not.toBeInTheDocument()
    cleanup()
  })

  // ui-audit-20261016 P1-02（W-02）：两个全屏遮罩面板旧版只能靠面板内关闭钮退出。
  it("P1-02：全屏遮罩面板可用 Esc 退出（人设点评 → 认知面板依次关闭）", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    fireEvent.click(screen.getByText("多视角评审"))
    expect(screen.getByTestId("persona-panel")).toBeInTheDocument()
    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByTestId("persona-panel")).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText("更多功能"))
    fireEvent.click(screen.getByText("角色认知状态"))
    expect(screen.getByTestId("cognition-panel")).toBeInTheDocument()
    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByTestId("cognition-panel")).not.toBeInTheDocument()
    cleanup()
  })

  it("P1-02：遮罩打开时非 Esc 按键不得关面板（只在 Esc 上接管）", async () => {
    // 接管 window keydown 后若对所有键都关面板，用户只要在遮罩上打字（如输入法候选）
    // 面板就会消失——所以非 Esc 必须早退、不 stopPropagation、不改状态。
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    fireEvent.click(screen.getByText("角色认知状态"))
    expect(screen.getByTestId("cognition-panel")).toBeInTheDocument()
    fireEvent.keyDown(window, { key: "a" })
    expect(screen.getByTestId("cognition-panel")).toBeInTheDocument()
    fireEvent.keyDown(window, { key: "Enter" })
    expect(screen.getByTestId("cognition-panel")).toBeInTheDocument()
    // 仍能由 Esc 正常关闭（非 Esc 早退没有把监听器消耗掉）
    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByTestId("cognition-panel")).not.toBeInTheDocument()
    cleanup()
  })

  it("expanded 模式：非 compact 工具栏按钮全集", async () => {
    mocks.compactToolbar.value = false
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    expect(screen.getByText("AI会话")).toBeInTheDocument()
    expect(screen.getByText("去AI味")).toBeInTheDocument()
    expect(screen.getByText("保存为正式章节")).toBeInTheDocument()
    expect(screen.getByText("一键排版")).toBeInTheDocument()
    expect(screen.getByText("查看记忆")).toBeInTheDocument()
    expect(screen.getByText("角色认知状态")).toBeInTheDocument()
    expect(screen.getByText("多视角评审")).toBeInTheDocument()
    fireEvent.click(screen.getByText("AI会话"))
    expect(mocks.state.setChatExpanded).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByText("角色认知状态"))
    expect(screen.getByTestId("cognition-panel")).toBeInTheDocument()
    cleanup()
  })

  it("expanded 模式：final 章节显示重新提取按钮", async () => {
    mocks.compactToolbar.value = false
    const finalMd = CHAPTER_MD.replace("chapter_status: draft", "chapter_status: final")
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = finalMd
    mocks.readFile.mockResolvedValue(finalMd)
    mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "boom" })
    const { cleanup } = await renderPanel()
    expect(screen.getByText("重新提取记忆")).toBeInTheDocument()
    expect(screen.queryByText("保存为正式章节")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("重新提取记忆"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingest_failed" }),
    ))
    cleanup()
  })

  it("非章节文件：无章节工具按钮，关闭按钮回到空态", async () => {
    mocks.compactToolbar.value = false
    mocks.state.selectedFile = "/proj/wiki/notes.md"
    mocks.state.fileContent = "# 笔记"
    mocks.readFile.mockResolvedValue("# 笔记")
    const { cleanup } = await renderPanel()
    expect(screen.queryByText("AI会话")).not.toBeInTheDocument()
    const xBtn = document.querySelector("button svg.lucide-x")?.closest("button") as HTMLButtonElement
    fireEvent.click(xBtn)
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith(null)
    cleanup()
  })

  it("普通 markdown 无标题输入框", async () => {
    mocks.state.selectedFile = "/proj/wiki/notes.md"
    mocks.state.fileContent = "# 笔记"
    mocks.readFile.mockResolvedValue("# 笔记")
    const { cleanup } = await renderPanel()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    cleanup()
  })
})

describe("PreviewPanel 编辑器高亮与 saveStatus", () => {
  it("pendingEditorHighlight 匹配当前文件 → 传给 WikiEditor + 处理后清除", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.pendingEditorHighlight = { path: CHAPTER_PATH, text: "正文第一段", nonce: 1 }
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    expect(screen.getByTestId("editor-highlight").textContent).toBe("正文第一段")
    fireEvent.click(screen.getByTestId("editor-highlight-handled"))
    expect(mocks.state.setPendingEditorHighlight).toHaveBeenCalledWith(null)
    cleanup()
  })

  it("pendingEditorHighlight 路径不匹配 → 不传递；onHighlightHandled 无高亮时不清除", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.pendingEditorHighlight = { path: "/other.md", text: "x", nonce: 1 }
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    expect(screen.getByTestId("editor-highlight").textContent).toBe("none")
    fireEvent.click(screen.getByTestId("editor-highlight-handled"))
    expect(mocks.state.setPendingEditorHighlight).not.toHaveBeenCalled()
    cleanup()
  })

  it("visibleSaveStatus：finalChapterSave 带 params → t(label, params)", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.finalChapterSave = {
      projectPath: "/proj", filePath: CHAPTER_PATH, saving: false, phase: "blocked_by_review", params: { count: 2, warnings: 1 },
    }
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    expect(mocks.t).toHaveBeenCalledWith("novel.chapter.reviewBlockedWithErrors", { count: 2, warnings: 1 })
    cleanup()
  })

  it("visibleSaveStatus：无 params → 直接 label 渲染", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.finalChapterSave = { projectPath: "/proj", filePath: CHAPTER_PATH, saving: false, phase: "ingested", params: undefined }
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    expect(screen.getByText("正式章节和记忆均已保存：第{{chapter}}章")).toBeInTheDocument()
    cleanup()
  })

  it("visibleSaveStatus：其他项目 finalChapterSave 不匹配 → saveStatus 兜底", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.finalChapterSave = { projectPath: "/other", filePath: CHAPTER_PATH, saving: false, phase: "ingested", params: undefined }
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    expect(screen.queryByText("novel.chapter.ingestSuccess")).not.toBeInTheDocument()
    cleanup()
  })

  it("章节输入框宽度测量：编辑态宽度变化", async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 120 } as DOMRect)
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    expect(input.style.width).toBe("122px")
    fireEvent.focus(input)
    expect(input.style.width).toBe("136px")
    rectSpy.mockRestore()
    cleanup()
  })

  it("章节输入宽度不变化时保持原值（相同宽度分支）", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    expect(input.style.width).toBe("48px")
    cleanup()
  })
})

describe("PreviewPanel 回收站预览", () => {
  it("markdown 回收项 → WikiReader + 关闭按钮", async () => {
    mocks.state.selectedTrashItem = {
      id: "t1", name: "已删章节.md", originalPath: "/proj/wiki/chapters/已删章节.md",
      trashPath: "/trash/x.md", deletedAt: 0, expiresAt: 0, kind: "chapter",
    }
    mocks.state.fileContent = "---\ntitle: 已删\n---\n\n回收站正文"
    const { cleanup } = await renderPanel()
    expect(screen.getByTestId("wiki-reader").textContent).toContain("回收站正文")
    expect(screen.getByText("已删章节.md")).toBeInTheDocument()
    fireEvent.click(screen.getByTitle("关闭预览"))
    expect(mocks.state.setSelectedTrashItem).toHaveBeenCalledWith(null)
    cleanup()
  })

  it("非 markdown 回收项（outline kind）→ FilePreview", async () => {
    mocks.state.selectedTrashItem = {
      id: "t2", name: "a.png", originalPath: "/proj/a.png",
      trashPath: "/trash/a.png", deletedAt: 0, expiresAt: 0, kind: "outline",
    }
    mocks.state.fileContent = "binary"
    const { cleanup } = await renderPanel()
    expect(screen.getByTestId("file-preview")).toBeInTheDocument()
    expect(mocks.t).toHaveBeenCalledWith("trash.kindOutline", expect.anything())
    cleanup()
  })

  it("history 与 page 种类标签", async () => {
    mocks.state.selectedTrashItem = {
      id: "t3", name: "h.md", originalPath: "/proj/history/h.md",
      trashPath: "/trash/h.md", deletedAt: 0, expiresAt: 0, kind: "history",
    }
    mocks.state.fileContent = "---\n---\n\nx"
    const { cleanup } = await renderPanel()
    expect(mocks.t).toHaveBeenCalledWith("trash.kindHistory", expect.anything())

    mocks.state.selectedTrashItem = {
      id: "t4", name: "p.md", originalPath: "/proj/pages/p.md",
      trashPath: "/trash/p.md", deletedAt: 0, expiresAt: 0, kind: "page",
    }
    mocks.state.fileContent = "---\n---\n\nx"
    const view2 = render(<PreviewPanel />)
    await flushAsync(10)
    expect(mocks.t).toHaveBeenCalledWith("trash.kindPage", expect.anything())
    view2.unmount()
    cleanup()
  })
})

describe("PreviewPanel 布局与生命周期", () => {
  it("ResizeObserver 缺失时退回 window resize 监听", async () => {
    (globalThis as Record<string, unknown>).ResizeObserver = undefined
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    window.dispatchEvent(new Event("resize"))
    await flushAsync(10)
    cleanup()
  })
})

describe("PreviewPanel 全口径补盲（W4E4 迭代）", () => {
  const NO_NUM_MD = [
    "---",
    "type: chapter",
    "chapter_status: draft",
    "---",
    "",
    "# 无编号章节",
    "",
    "正文。",
    "",
  ].join("\n")

  const NO_NUM_FINAL_MD = [
    "---",
    "type: chapter",
    "chapter_status: final",
    "---",
    "",
    "# 无编号终稿",
    "",
    "正文。",
    "",
  ].join("\n")

  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
    let resolve!: (v: T) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }

  // R4 共识（deepseek+glm；glm+qwen）: 写盘失败原先仅 console.error，用户以为已保存。
  // 旧断言把“只打日志”当作预期——评审债，已反转为断言错误如实上屏。
  it("保存写盘失败 → 如实上报（不再静默 console.error）", async () => {
    mocks.state.selectedFile = "/proj/wiki/notes.md"
    mocks.readFile.mockResolvedValue("# 笔记\n\n内容")
    mocks.writeFileAtomic.mockRejectedValue(new Error("disk-fail"))
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-save"))
    await waitFor(() => expect(screen.getByText(/操作失败：disk-fail/)).toBeTruthy(), { timeout: 3000 })
    cleanup()
  })

  it("连续两次保存 → 去抖清理前一次 timer，仅写入一次", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.saveText.value = "第一次改动"
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-save"))
    mocks.saveText.value = "第二次改动"
    fireEvent.click(screen.getByTestId("editor-save"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1), { timeout: 3000 })
    expect(mocks.writeFileAtomic.mock.calls[0][1]).toContain("第二次改动")
    cleanup()
  })

  it("readFile 挂起期间切换文件 → .then 守卫返回", async () => {
    const d = deferred<string>()
    mocks.readFile.mockReturnValue(d.promise)
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    mocks.state.selectedFile = "/proj/wiki/chapters/第二章.md"
    mocks.readFile.mockResolvedValue("# 第二章")
    view.rerender(<PreviewPanel />)
    await flushAsync(10)
    d.resolve("旧内容")
    await flushAsync(20)
    expect(mocks.state.fileContent).toBe("# 第二章")
    view.unmount()
  })

  it("readFile 挂起期间切换文件后拒绝 → .catch 守卫返回", async () => {
    const d = deferred<string>()
    mocks.readFile.mockReturnValue(d.promise)
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    mocks.state.selectedFile = "/proj/wiki/chapters/第二章.md"
    mocks.readFile.mockResolvedValue("# 第二章")
    view.rerender(<PreviewPanel />)
    await flushAsync(10)
    d.reject(new Error("late-fail"))
    await flushAsync(20)
    expect(mocks.state.fileContent).toBe("# 第二章")
    view.unmount()
  })

  it("无 chapter_number 章节：改标题 → 重命名同步（meta null 分支）", async () => {
    mocks.state.selectedFile = "/proj/wiki/chapters/无编号章节.md"
    mocks.state.fileContent = NO_NUM_MD
    mocks.readFile.mockResolvedValue(NO_NUM_MD)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "新标题" } })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.blur(input)
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled(), { timeout: 3000 })
    expect(mocks.deleteFile).toHaveBeenCalled()
    expect(mocks.state.setFileTree).toHaveBeenCalled()
    cleanup()
  })

  it("无 chapter_number 章节：清空标题 → fallback 后早退（不写盘）", async () => {
    mocks.state.selectedFile = "/proj/wiki/chapters/无编号章节.md"
    mocks.state.fileContent = NO_NUM_MD
    mocks.readFile.mockResolvedValue(NO_NUM_MD)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "" } })
    fireEvent.blur(input)
    await flushAsync(30)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    cleanup()
  })

  it("多任务大纲（done/error/无 outlinePath）→ 排序取最新 message", async () => {
    const task = (id: string, status: string, outlinePath: string | null, message: string, updatedAt: number) => ({
      id, projectPath: "/proj", kind: "ingest", genre: "", scale: "", premise: "", prompt: "", userRequest: "",
      selectedSectionKey: null, displayTitle: null, writeMode: null, targetPath: null, outlinePath,
      status, message, error: status === "error" ? "x" : null, createdAt: 1, updatedAt,
    })
    mocks.state.selectedFile = OUTLINE_PATH
    mocks.state.fileContent = "# 大纲"
    mocks.readFile.mockResolvedValue("# 大纲")
    const view = render(<PreviewPanel />)
    await flushAsync(20)
    mocks.outlineState.tasks = [
      task("t1", "done", OUTLINE_PATH, "旧任务", 10),
      task("t2", "error", OUTLINE_PATH, "错误任务", 20),
      task("t3", "ingesting", null, "null路径任务", 30),
    ]
    view.rerender(<PreviewPanel />)
    await waitFor(() => expect(screen.getByText("错误任务")).toBeInTheDocument())
    expect(screen.queryByText("旧任务")).not.toBeInTheDocument()
    view.unmount()
  })

  it("标题输入框 mouseDown/click → stopPropagation 处理器", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    fireEvent.mouseDown(input)
    fireEvent.click(input)
    expect(input).toHaveValue("第一章")
    cleanup()
  })

  it("compact 下拉：去AI味（挂起 streamChat）→ 处理中文案", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.streamChat.mockReturnValue(new Promise(() => {}))
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(mocks.streamChat).toHaveBeenCalled())
    fireEvent.click(screen.getByLabelText("更多功能"))
    await waitFor(() => expect(screen.getByText("处理中")).toBeInTheDocument())
    cleanup()
  })

  it("compact 下拉：保存为正式章节按钮", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    fireEvent.click(screen.getByText("保存为正式章节"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "saved" }),
    ))
    cleanup()
  })

  it("compact 下拉：finalChapterSave saving 中 → 保存按钮显示处理中文案", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.finalChapterSave = { projectPath: "/proj", filePath: CHAPTER_PATH, saving: true, phase: "saving" }
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    expect(screen.getAllByText("正在保存...").length).toBeGreaterThan(0)
    cleanup()
  })

  it("compact 下拉：final 章节 → 重新提取按钮 + 点击", async () => {
    const finalMd = CHAPTER_MD.replace("chapter_status: draft", "chapter_status: final")
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = finalMd
    mocks.readFile.mockResolvedValue(finalMd)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    expect(screen.getByText("重新提取记忆")).toBeInTheDocument()
    fireEvent.click(screen.getByText("重新提取记忆"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingest_failed" }),
    ))
    cleanup()
  })

  it("compact 下拉：final + saving 中 → 重新提取按钮显示处理中文案", async () => {
    const finalMd = CHAPTER_MD.replace("chapter_status: draft", "chapter_status: final")
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = finalMd
    mocks.state.finalChapterSave = { projectPath: "/proj", filePath: CHAPTER_PATH, saving: true, phase: "saving" }
    mocks.readFile.mockResolvedValue(finalMd)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    expect(screen.getAllByText("正在保存...").length).toBeGreaterThan(0)
    cleanup()
  })

  it("compact 下拉：一键排版", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    fireEvent.click(screen.getByText("一键排版"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled())
    cleanup()
  })

  it("expanded 大纲摄入按钮（未提取）→ startOutlineIngestTask", async () => {
    mocks.compactToolbar.value = false
    mocks.state.selectedFile = OUTLINE_PATH
    mocks.state.fileContent = "# 大纲"
    mocks.readFile.mockResolvedValue("# 大纲")
    mocks.fileExists.mockResolvedValue(false)
    const { cleanup } = await renderPanel()
    await waitFor(() => expect(screen.getByText("提取初始记忆")).toBeInTheDocument())
    fireEvent.click(screen.getByText("提取初始记忆"))
    expect(mocks.startOutlineIngestTask).toHaveBeenCalledWith("/proj", OUTLINE_PATH)
    cleanup()
  })

  it("expanded 大纲已提取 → ✓ 已提取记忆 文案 + 快照按钮", async () => {
    mocks.compactToolbar.value = false
    mocks.state.selectedFile = OUTLINE_PATH
    mocks.state.fileContent = "# 大纲"
    mocks.readFile.mockResolvedValue("# 大纲")
    mocks.fileExists.mockResolvedValue(true)
    const { cleanup } = await renderPanel()
    await waitFor(() => expect(screen.getByText("✓ 已提取记忆")).toBeInTheDocument())
    fireEvent.click(screen.getByText("查看记忆"))
    await waitFor(() => expect(screen.getByTestId("snapshot-viewer")).toBeInTheDocument())
    cleanup()
  })

  it("expanded 大纲摄入中 → 禁用按钮文案（guard）", async () => {
    mocks.compactToolbar.value = false
    mocks.state.selectedFile = OUTLINE_PATH
    mocks.state.fileContent = "# 大纲"
    mocks.readFile.mockResolvedValue("# 大纲")
    const view = render(<PreviewPanel />)
    await flushAsync(20)
    mocks.outlineState.tasks = [{
      id: "t1", projectPath: "/proj", kind: "ingest", genre: "", scale: "", premise: "", prompt: "", userRequest: "",
      selectedSectionKey: null, displayTitle: null, writeMode: null, targetPath: null, outlinePath: OUTLINE_PATH,
      status: "ingesting", message: "正在提取", error: null, createdAt: 1, updatedAt: 1,
    }]
    view.rerender(<PreviewPanel />)
    await waitFor(() => expect(screen.getByText("正在提取初始记忆...")).toBeInTheDocument())
    fireEvent.click(screen.getByText("正在提取初始记忆..."))
    await flushAsync(20)
    expect(mocks.startOutlineIngestTask).not.toHaveBeenCalled()
    view.unmount()
  })

  it("expanded 快照按钮 → SnapshotViewer", async () => {
    mocks.compactToolbar.value = false
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("查看记忆"))
    await waitFor(() => expect(screen.getByTestId("snapshot-viewer")).toBeInTheDocument())
    cleanup()
  })

  it("expanded 人设批判面板按钮", async () => {
    mocks.compactToolbar.value = false
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("多视角评审"))
    expect(screen.getByTestId("persona-panel")).toBeInTheDocument()
    cleanup()
  })

  it("大纲快照关闭 → onClose", async () => {
    mocks.state.selectedFile = OUTLINE_PATH
    mocks.state.fileContent = "# 大纲"
    mocks.readFile.mockResolvedValue("# 大纲")
    mocks.fileExists.mockResolvedValue(true)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    await waitFor(() => expect(screen.getByText("查看记忆")).toBeInTheDocument())
    fireEvent.click(screen.getByText("查看记忆"))
    await waitFor(() => expect(screen.getByTestId("snapshot-viewer")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("snapshot-close"))
    await waitFor(() => expect(screen.queryByTestId("snapshot-viewer")).not.toBeInTheDocument())
    cleanup()
  })

  it("reviewBeforeSave 无问题 → 直接保存（results 空分支）", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.novelConfig = { reviewBeforeSave: true, autoIngestOnSave: false }
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.compactToolbar.value = false
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("保存为正式章节"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "saved" }),
    ))
    expect(mocks.reviewState.addNovelReviewEntry).not.toHaveBeenCalled()
    cleanup()
  })

  it("保存为正式前有挂起去抖 timer → 清理后同步保存", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.compactToolbar.value = false
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-save"))
    fireEvent.click(screen.getByText("保存为正式章节"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "saved" }),
    ), { timeout: 3000 })
    cleanup()
  })

  it("autoIngest + 磁盘已是 final → 跳过重写直接提取", async () => {
    const finalMd = CHAPTER_MD.replace("chapter_status: draft", "chapter_status: final")
    const nonCanonical = "/proj/wiki/chapters/旧名字.md"
    mocks.state.selectedFile = nonCanonical
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.novelConfig = { reviewBeforeSave: false, autoIngestOnSave: true }
    // 加载读旧路径（draft）；rename 后 canonical 路径（第1章.md）与 verify 读都返回
    // final 内容 → verifyFm final → 跳过重写分支（preview-panel.tsx 634 else）。
    mocks.readFile.mockImplementation(async (p: string) => (p === nonCanonical ? CHAPTER_MD : finalMd))
    mocks.ingestChapter.mockResolvedValue(COMPLETED_MEMORY_INGEST)
    mocks.compactToolbar.value = false
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("保存为正式章节"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingested" }),
    ), { timeout: 3000 })
    cleanup()
  })

  it("autoIngest + 无标题无编号章节 → chapterTitle 兜底 第?章", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = NO_NUM_MD
    mocks.state.novelConfig = { reviewBeforeSave: false, autoIngestOnSave: true }
    mocks.readFile.mockResolvedValue(NO_NUM_MD)
    mocks.compactToolbar.value = false
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("保存为正式章节"))
    await waitFor(() => expect(mocks.importState.startTask).toHaveBeenCalledWith(
      expect.objectContaining({ currentTitle: "第?章" }),
    ), { timeout: 3000 })
    cleanup()
  })

  it("saveAsCanon 抛非 Error → catch 用 String(message)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.writeFileAtomic.mockRejectedValue("raw-disk-error")
    mocks.compactToolbar.value = false
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("保存为正式章节"))
    await waitFor(() => expect(mocks.t).toHaveBeenCalledWith("chat.saveFailed", { message: "raw-disk-error" }))
    errSpy.mockRestore()
    cleanup()
  })

  it("reingest 无标题无编号 final 章节 → 第?章 + ingest_failed", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = NO_NUM_FINAL_MD
    mocks.readFile.mockResolvedValue(NO_NUM_FINAL_MD)
    mocks.compactToolbar.value = false
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("重新提取记忆"))
    await waitFor(() => expect(mocks.importState.startTask).toHaveBeenCalledWith(
      expect.objectContaining({ currentTitle: "第?章" }),
    ))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingest_failed" }),
    ))
    cleanup()
  })

  it("reingest 抛非 Error → catch 用 String", async () => {
    const finalMd = CHAPTER_MD.replace("chapter_status: draft", "chapter_status: final")
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = finalMd
    mocks.readFile.mockResolvedValue(finalMd)
    mocks.ingestChapter.mockRejectedValue("raw-reingest-fail")
    mocks.compactToolbar.value = false
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("重新提取记忆"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingest_failed", params: expect.objectContaining({ message: expect.stringContaining("raw-reingest-fail") }) }),
    ))
    expect(mocks.importState.finishTask).toHaveBeenCalledWith("task-1", "error", expect.anything())
    cleanup()
  })

  it("无项目 + 另存草稿 → 早退（不写盘）", async () => {
    mocks.state.project = null
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.compactToolbar.value = false
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("x")
      cb.onDone()
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-save-draft")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("de-ai-save-draft"))
    await flushAsync(30)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    cleanup()
  })

  it("project null + 选区变换 → loadSmartDeAiSkill(null, 润色)", async () => {
    mocks.state.project = null
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("r")
      cb.onDone()
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await waitFor(() => expect(screen.getByTestId("tt-dialog").dataset.open).toBe("true"))
    expect(mocks.loadSmartDeAiSkill).toHaveBeenCalledWith(null, "润色", undefined)
    cleanup()
  })

  it("onError 时文件已切换 → 不显示失败状态", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    let cb: any
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, callbacks: any) => {
      cb = callbacks
      return new Promise(() => {})
    })
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await flushAsync(10)
    mocks.state.selectedFile = "/proj/wiki/chapters/其他.md"
    mocks.readFile.mockResolvedValue("# 其他")
    view.rerender(<PreviewPanel />)
    await flushAsync(20)
    cb.onError(new Error("boom"))
    await flushAsync(30)
    expect(screen.queryByText(/AI润色失败/)).not.toBeInTheDocument()
    view.unmount()
  })

  it("onError 非 Error → String 脱敏", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onError("plain failure")
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await waitFor(() => expect(screen.getByText(/AI润色失败：plain failure/)).toBeInTheDocument())
    cleanup()
  })

  it("streamChat 抛非 Error → catch String 脱敏", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.streamChat.mockRejectedValue("raw http://x.com Bearer tok")
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await waitFor(() => expect(screen.getByText(/AI润色失败/)).toBeInTheDocument())
    expect(screen.getByText(/\[url\]/)).toBeInTheDocument()
    cleanup()
  })

  it("streamChat 抛错后文件已切换 → 静默返回", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    let rejectFn!: (e: unknown) => void
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, _callbacks: any) => new Promise((_res, rej) => { rejectFn = rej }))
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await flushAsync(10)
    mocks.state.selectedFile = "/proj/wiki/chapters/其他.md"
    mocks.readFile.mockResolvedValue("# 其他")
    view.rerender(<PreviewPanel />)
    await flushAsync(20)
    rejectFn(new Error("late-fail"))
    await flushAsync(30)
    expect(errSpy).not.toHaveBeenCalled()
    expect(screen.queryByText(/AI润色失败/)).not.toBeInTheDocument()
    errSpy.mockRestore()
    view.unmount()
  })

  it("未打开变换对话框直接应用 → 早退", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("tt-apply"))
    await flushAsync(20)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    cleanup()
  })

  it("标题输入框按其他键 → Escape 分支 else", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: "a" })
    expect(input).toHaveValue("第一章")
    cleanup()
  })

  it("compact + novelMode=false → 无角色认知/人设按钮", async () => {
    mocks.state.novelMode = false
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    expect(screen.queryByText("角色认知状态")).not.toBeInTheDocument()
    expect(screen.queryByText("多视角评审")).not.toBeInTheDocument()
    cleanup()
  })

  it("visibleSaveStatus：t 返回非字符串 → saveStatus 兜底", async () => {
    mocks.t.mockImplementation((key: string, opts?: { defaultValue?: string } | string) => {
      if (key === "novel.chapter.reviewBlockedWithErrors") return 123
      if (typeof opts === "string") return opts
      return (opts && opts.defaultValue) ?? key
    })
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.finalChapterSave = {
      projectPath: "/proj", filePath: CHAPTER_PATH, saving: false, phase: "blocked_by_review", params: { count: 2, warnings: 1 },
    }
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    // R4: phaseLabelMap 改为存键（原先存译文 ⇒ 二次翻译且 params 无法插值）
    expect(mocks.t).toHaveBeenCalledWith("novel.chapter.reviewBlockedWithErrors", { count: 2, warnings: 1 })
    mocks.t.mockImplementation((key: string, opts?: { defaultValue?: string } | string) =>
      (typeof opts === "string" ? opts : opts?.defaultValue) ?? lookupZhLocale(key) ?? key
    )
    cleanup()
  })

  it("project=null 时章节重命名 → 跳过树刷新", async () => {
    mocks.state.project = null
    mocks.state.selectedFile = "/proj/wiki/chapters/旧名字.md"
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "新标题" } })
    fireEvent.blur(input)
    await waitFor(() => expect(mocks.deleteFile).toHaveBeenCalledWith("/proj/wiki/chapters/旧名字.md"), { timeout: 3000 })
    expect(mocks.state.setFileTree).not.toHaveBeenCalled()
    cleanup()
  })

  it("切换文件 flush 重命名时选中路径已变 → 不重置选中", async () => {
    const nonCanonical = "/proj/wiki/chapters/旧名字.md"
    mocks.state.selectedFile = nonCanonical
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.saveText.value = CHAPTER_MD + "\n新增段落"
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-save"))
    mocks.state.selectedFile = "/proj/wiki/chapters/第二章.md"
    mocks.readFile.mockResolvedValue("# 二")
    view.rerender(<PreviewPanel />)
    await waitFor(() => expect(mocks.state.setFileTree).toHaveBeenCalled())
    expect(mocks.state.setSelectedFile).not.toHaveBeenCalled()
    view.unmount()
  })

  it("frontmatter 存在但正文无标题 → syncChapterFrontmatterTitle 早退", async () => {
    const md = "---\ntype: chapter\nchapter_status: draft\n---\n\n正文无标题。"
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = md
    mocks.readFile.mockResolvedValue(md)
    mocks.saveText.value = md + "\n追加内容"
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-save"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled(), { timeout: 3000 })
    cleanup()
  })

  it("frontmatter title 非字符串 → fmTitle 空回退", async () => {
    const md = ["---", "type: chapter", "title: 123", "chapter_status: draft", "---", "", "# 第一章", "", "正文。", ""].join("\n")
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = md
    mocks.readFile.mockResolvedValue(md)
    mocks.saveText.value = md + "\n追加内容"
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-save"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled(), { timeout: 3000 })
    cleanup()
  })

  it("去AI味：onError 非 Error → String 化日志", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.compactToolbar.value = false
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onError("plain-llm-error")
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    expect(String(errSpy.mock.calls[0][0])).toContain("去AI味处理失败")
    expect(String(errSpy.mock.calls[0][1])).toBe("plain-llm-error")
    errSpy.mockRestore()
    cleanup()
  })

  it("去AI味：streamChat 抛非 Error → catch String 化日志", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.compactToolbar.value = false
    mocks.streamChat.mockRejectedValue("plain-transport-error")
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    expect(String(errSpy.mock.calls[0][1])).toBe("plain-transport-error")
    errSpy.mockRestore()
    cleanup()
  })

  it("章节标题与路径均无标题 → 标题回退链路保持空值", async () => {
    const md = "---\ntype: chapter\nchapter_status: draft\n---\n\n正文无标题。"
    mocks.state.selectedFile = "/proj/wiki/chapters/.md"
    mocks.state.fileContent = md
    mocks.readFile.mockResolvedValue(md)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    expect(input).toHaveValue("")
    fireEvent.focus(input)
    fireEvent.blur(input)
    await flushAsync(30)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    cleanup()
  })

  it("章节编号存在但标题与路径均为空 → 用户显式编辑清空后回退为默认章节名", async () => {
    const md = "---\ntype: chapter\nchapter_number: 1\nchapter_status: draft\n---\n\n正文无标题。"
    mocks.state.selectedFile = "/proj/wiki/chapters/.md"
    mocks.state.fileContent = md
    mocks.readFile.mockResolvedValue(md)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    expect(input).toHaveValue("")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "   " } })
    fireEvent.blur(input)
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      "/proj/wiki/chapters/第1章.md",
      expect.stringContaining("# 第1章"),
    ), { timeout: 3000 })
    cleanup()
  })
  it("重新提取时章节状态已变为非 final → 显示守卫提示并早退", async () => {
    const finalMd = CHAPTER_MD.replace("chapter_status: draft", "chapter_status: final")
    mocks.compactToolbar.value = false
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = finalMd
    mocks.readFile.mockResolvedValue(finalMd)
    const { cleanup } = await renderPanel()
    expect(screen.getByText("重新提取记忆")).toBeInTheDocument()
    mocks.chapterMetaFinalGate.value = false
    fireEvent.click(screen.getByText("重新提取记忆"))
    await waitFor(() => expect(screen.getByText("只有正式章节可以重新提取记忆")).toBeInTheDocument())
    expect(mocks.importState.startTask).not.toHaveBeenCalled()
    cleanup()
  })

  it("章节正文只有标题行 → updateChapterHeading bodyWithoutHeading 空分支", async () => {
    const headingOnlyMd = [
      "---",
      "type: chapter",
      'title: "第一章"',
      "chapter_number: 1",
      "chapter_status: draft",
      "---",
      "",
      "# 第一章",
      "",
    ].join("\n")
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = headingOnlyMd
    mocks.readFile.mockResolvedValue(headingOnlyMd)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "新标题" } })
    fireEvent.blur(input)
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled(), { timeout: 3000 })
    expect(mocks.writeFileAtomic.mock.calls[0][1]).toContain("# 第1章-新标题")
    cleanup()
  })
})

/**
 * G2-NATIVE-F1 回归（草稿采纳后编辑区不刷新 / 重载窗口丢稿 / 旧写盘越序）。
 *
 * 已确认缺陷：chapter-draft-dock 采纳成功后 onAdopted(formalChapterPath) 只做
 * `setSelectedFile(同一个 path)` + `setActiveView("wiki")`；而磁盘重载 effect 的
 * 依赖是 selectedFile 的 identity（preview-panel.tsx 装载 effect）——同路径写回时
 * identity 不变 ⇒ 不重跑 ⇒ 编辑区停在采纳前的旧正文。
 * 修正后的口径（本组用例锁定）：
 *  1) 令牌 +1 且令牌指认当前文件后必须重读磁盘并渲染权威正文；令牌指认别的文件则不动编辑区；
 *  2) 采纳是权威写入：writeGate.begin 必须作废待写盘、卸载旧编辑器、等在途写盘落定，
 *     之后才轮到正式采纳写入（否则旧缓冲可能在采纳之后落盘、覆盖刚采纳的正文）；
 *  3) 重载窗口内旧缓冲区已卸载 ⇒ 不存在「窗口内补的一笔被静默丢弃」；
 *  4) 采纳失败（abort）恢复编辑区并把未落盘正文重新排队；读盘失败如实报错且不写空内容；
 *  5) 采纳窗口内的 pagehide / 切章都不得把旧缓冲 flush 回正式章。
 */
describe("G2-NATIVE-F1 采纳后同路径重载", () => {
  const ADOPTED_MD = CHAPTER_MD.replace("正文第一段。", "采纳后的权威正文。")
  const SECOND_PATH = "/proj/wiki/chapters/第二章.md"
  const SECOND_MD = "# 第二章\n\n新章正文"

  function renderWithGate(): {
    gateRef: { current: PreviewPanelWriteGate | null }
    view: ReturnType<typeof render>
  } {
    const gateRef: { current: PreviewPanelWriteGate | null } = { current: null }
    const view = render(
      <PreviewPanel adoptionRefreshToken={0} adoptionRefreshPath="" writeGateRef={gateRef} />,
    )
    return { gateRef, view }
  }

  it("同路径采纳成功后重载权威正文（selectedFile identity 未变）", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const view = render(<PreviewPanel adoptionRefreshToken={0} adoptionRefreshPath="" />)
    await flushAsync(10)
    expect(screen.getByTestId("editor-content").textContent).toBe(CHAPTER_MD)

    // 采纳落盘：盘上换成正式正文，选中路径不变，令牌 +1（并指认这个路径）。
    mocks.readFile.mockResolvedValue(ADOPTED_MD)
    view.rerender(<PreviewPanel adoptionRefreshToken={1} adoptionRefreshPath={CHAPTER_PATH} />)
    await flushAsync(20)
    // mock store 非响应式：读盘结果经 setFileContent 落到 state，再渲一次取最新内容。
    view.rerender(<PreviewPanel adoptionRefreshToken={1} adoptionRefreshPath={CHAPTER_PATH} />)

    expect(mocks.readFile).toHaveBeenCalledTimes(2)
    expect(mocks.readFile).toHaveBeenLastCalledWith(CHAPTER_PATH)
    expect(screen.getByTestId("editor-content").textContent).toBe(ADOPTED_MD)
    // 重载本身是只读动作：不得顺手写盘。
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    view.unmount()
  })

  it("令牌指认的不是当前文件 → 不重读、不打扰当前编辑区的未保存文本", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.saveText.value = CHAPTER_MD + "\n正在写的内容"
    const view = render(<PreviewPanel adoptionRefreshToken={0} adoptionRefreshPath="" />)
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-save"))

    // 采纳写入的是另一章（例如此刻选中章被切走过）：当前这块正文必须原样留着。
    view.rerender(<PreviewPanel adoptionRefreshToken={1} adoptionRefreshPath={SECOND_PATH} />)
    await flushAsync(20)
    view.rerender(<PreviewPanel adoptionRefreshToken={1} adoptionRefreshPath={SECOND_PATH} />)

    expect(mocks.readFile).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("editor-content").textContent).toContain("正在写的内容")
    view.unmount()
  })

  it("重载作废采纳前排队的旧缓冲防抖写盘；随后真实用户保存仍然生效", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.saveText.value = CHAPTER_MD + "\n未采纳的旧缓冲改动"
    const view = render(<PreviewPanel adoptionRefreshToken={0} adoptionRefreshPath="" />)
    await flushAsync(10)
    // 用户在采纳前编辑过一次：1s 防抖写盘已排队但尚未执行。
    fireEvent.click(screen.getByTestId("editor-save"))
    mocks.readFile.mockResolvedValue(ADOPTED_MD)
    view.rerender(<PreviewPanel adoptionRefreshToken={1} adoptionRefreshPath={CHAPTER_PATH} />)
    await flushAsync(1200)
    // 旧缓冲绝不能覆盖刚采纳的正式正文（采纳是权威写入）。
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()

    // 采纳之后的真实用户编辑仍然照常写盘。
    mocks.saveText.value = ADOPTED_MD + "\n采纳后用户继续改"
    fireEvent.click(screen.getByTestId("editor-save"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled(), { timeout: 3000 })
    expect(mocks.writeFileAtomic.mock.calls[0][0]).toBe(CHAPTER_PATH)
    expect(mocks.writeFileAtomic.mock.calls[0][1]).toContain("采纳后用户继续改")
    view.unmount()
  })

  it("令牌不变时普通 rerender 不重复读盘（不打扰未保存文本）", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.saveText.value = CHAPTER_MD + "\n正在写的内容"
    const view = render(<PreviewPanel adoptionRefreshToken={1} adoptionRefreshPath={CHAPTER_PATH} />)
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-save"))
    view.rerender(<PreviewPanel adoptionRefreshToken={1} adoptionRefreshPath={CHAPTER_PATH} />)
    await flushAsync(20)
    // 只有初次装载那一次读盘：没有令牌变化就不许再读，免得覆盖未保存文本。
    expect(mocks.readFile).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("editor-content").textContent).toContain("正在写的内容")
    view.unmount()
  })

  it("令牌与切换文件同批发生 → 仍按原来的切文件路径 flush 前一章并装载新章", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.saveText.value = CHAPTER_MD + "\n前一章未保存改动"
    const view = render(<PreviewPanel adoptionRefreshToken={0} adoptionRefreshPath="" />)
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-save"))

    mocks.state.selectedFile = SECOND_PATH
    mocks.readFile.mockResolvedValue(SECOND_MD)
    view.rerender(<PreviewPanel adoptionRefreshToken={1} adoptionRefreshPath={CHAPTER_PATH} />)
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled(), { timeout: 3000 })
    // 前一章不是「同路径采纳」，必须照旧 flush（不丢无关未保存改动）。
    expect(mocks.writeFileAtomic.mock.calls[0][1]).toContain("前一章未保存改动")
    await flushAsync(20)
    view.rerender(<PreviewPanel adoptionRefreshToken={1} adoptionRefreshPath={CHAPTER_PATH} />)
    expect(screen.getByTestId("editor-content").textContent).toBe(SECOND_MD)
    view.unmount()
  })

  it("采纳重载窗口内旧缓冲区已卸载：不存在「窗口内补一笔被丢弃」", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const view = render(<PreviewPanel adoptionRefreshToken={0} adoptionRefreshPath="" />)
    await flushAsync(10)

    let resolveAdoption!: (content: string) => void
    mocks.readFile.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveAdoption = resolve }),
    )
    view.rerender(<PreviewPanel adoptionRefreshToken={1} adoptionRefreshPath={CHAPTER_PATH} />)
    await flushAsync(5)
    // 复用既有装载守卫：窗口内只渲染加载态，旧编辑器已卸载 ⇒ 不可能再接受输入，
    // 所以不存在「补了一笔又被静默丢弃」这条实现取舍。
    expect(screen.queryByTestId("editor-content")).toBeNull()
    expect(screen.queryByTestId("editor-save")).toBeNull()
    expect(screen.getByText("正在加载...")).toBeInTheDocument()

    await act(async () => { resolveAdoption(ADOPTED_MD) })
    await flushAsync(1200)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    view.rerender(<PreviewPanel adoptionRefreshToken={1} adoptionRefreshPath={CHAPTER_PATH} />)
    expect(screen.getByTestId("editor-content").textContent).toBe(ADOPTED_MD)
    view.unmount()
  })

  it("在途旧写盘：begin 先让出编辑区并等它落定，之后采纳重载读到的就是采纳正文", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.saveText.value = CHAPTER_MD + "\n未落盘的旧缓冲改动"
    const { gateRef, view } = renderWithGate()
    await flushAsync(10)

    // 用户改一笔 → 1s 防抖触发 → write_file_atomic 已在途（真实后端是独立 spawn_blocking）。
    let resolveOldWrite!: () => void
    mocks.writeFileAtomic.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveOldWrite = resolve }),
    )
    fireEvent.click(screen.getByTestId("editor-save"))
    await flushAsync(1200)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)

    // 正式采纳写入之前：静默门必须让出编辑区并等旧写盘落定。
    let beginSettled = false
    let beginPromise: Promise<PreviewPanelAdoptionStart> | null = null
    await act(async () => {
      beginPromise = gateRef.current!.begin(CHAPTER_PATH).then((start) => {
        beginSettled = true
        return start
      })
    })
    await flushAsync(5)
    expect(beginSettled).toBe(false)
    expect(screen.queryByTestId("editor-save")).toBeNull()
    expect(screen.getByText("正在加载...")).toBeInTheDocument()

    await act(async () => { resolveOldWrite() })
    const start = await beginPromise!
    expect(beginSettled).toBe(true)
    expect(start.status).toBe("ready")
    const snapshot = start.status === "ready" ? start.snapshot : null
    expect(snapshot?.path).toBe(CHAPTER_PATH)
    expect(snapshot?.buffer).toContain("未落盘的旧缓冲改动")

    // 采纳落盘（accept 写入）→ 令牌让编辑区重载：读回的就是采纳正文，旧缓冲不再覆盖。
    mocks.readFile.mockResolvedValue(ADOPTED_MD)
    view.rerender(<PreviewPanel adoptionRefreshToken={1} adoptionRefreshPath={CHAPTER_PATH} writeGateRef={gateRef} />)
    await flushAsync(20)
    view.rerender(<PreviewPanel adoptionRefreshToken={1} adoptionRefreshPath={CHAPTER_PATH} writeGateRef={gateRef} />)
    expect(mocks.readFile).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId("editor-content").textContent).toBe(ADOPTED_MD)
    // 全程只有那一次在途旧写盘：采纳之后没有任何旧缓冲写盘。
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)

    // 重载之后继续正常编辑：新改动照旧落盘。
    mocks.saveText.value = ADOPTED_MD + "\n采纳后继续写"
    fireEvent.click(screen.getByTestId("editor-save"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(2), { timeout: 3000 })
    expect(mocks.writeFileAtomic.mock.calls[1][0]).toBe(CHAPTER_PATH)
    expect(mocks.writeFileAtomic.mock.calls[1][1]).toContain("采纳后继续写")
    view.unmount()
  })

  it("采纳失败 abort：未存正文不丢、不自动回写（throw 不证明此前零 I/O）", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.saveText.value = CHAPTER_MD + "\n未落盘的旧缓冲改动"
    const { gateRef, view } = renderWithGate()
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-save"))

    const start = await beginAdoption(gateRef, CHAPTER_PATH)
    expect(start.status).toBe("ready")
    expect(screen.queryByTestId("editor-save")).toBeNull()

    act(() => { gateRef.current!.abort(start) })
    await flushAsync(1200)
    view.rerender(<PreviewPanel adoptionRefreshToken={0} adoptionRefreshPath="" writeGateRef={gateRef} />)
    // 编辑区回来了，未存正文还在（没有被采纳流程吞掉）。
    expect(screen.getByTestId("editor-content").textContent).toContain("未落盘的旧缓冲改动")
    // 但不无条件把旧缓冲回写正式文件：throw 不证明此前零 I/O（draft-manager 先写后读回）。
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    // 相同内容的 markdownUpdated 回声仍不是新意图，不能冒充用户显式保存。
    fireEvent.click(screen.getByTestId("editor-save"))
    await flushAsync(1200)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByTestId("editor-content"), { key: "s", ctrlKey: true })
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1), { timeout: 3000 })
    expect(mocks.writeFileAtomic.mock.calls[0][0]).toBe(CHAPTER_PATH)
    expect(mocks.writeFileAtomic.mock.calls[0][1]).toContain("未落盘的旧缓冲改动")
    view.unmount()
  })

  it("采纳窗口内 pagehide / 切章都不把旧缓冲 flush 回正式章", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.saveText.value = CHAPTER_MD + "\n未落盘的旧缓冲改动"
    const { gateRef, view } = renderWithGate()
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-save"))
    expect((await beginAdoption(gateRef, CHAPTER_PATH)).status).toBe("ready")

    // 标签页隐藏的既有 flush 不得把已被采纳取代的旧缓冲写回正式章。
    await act(async () => { window.dispatchEvent(new Event("pagehide")) })
    await flushAsync(20)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()

    // 采纳窗口内切章同理：旧章不 flush，新章照常装载。
    mocks.state.selectedFile = SECOND_PATH
    mocks.readFile.mockResolvedValue(SECOND_MD)
    view.rerender(<PreviewPanel adoptionRefreshToken={0} adoptionRefreshPath="" writeGateRef={gateRef} />)
    await flushAsync(20)
    view.rerender(<PreviewPanel adoptionRefreshToken={0} adoptionRefreshPath="" writeGateRef={gateRef} />)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(screen.getByTestId("editor-content").textContent).toBe(SECOND_MD)
    view.unmount()
  })

  it("采纳后读盘失败：如实报错且不把空内容写回正式章", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const view = render(<PreviewPanel adoptionRefreshToken={0} adoptionRefreshPath="" />)
    await flushAsync(10)

    mocks.readFile.mockRejectedValueOnce(new Error("disk gone"))
    view.rerender(<PreviewPanel adoptionRefreshToken={1} adoptionRefreshPath={CHAPTER_PATH} />)
    await flushAsync(20)
    view.rerender(<PreviewPanel adoptionRefreshToken={1} adoptionRefreshPath={CHAPTER_PATH} />)
    expect(screen.getByTestId("editor-content").textContent).toBe("")
    expect(screen.getByText(/操作失败：disk gone/)).toBeInTheDocument()
    await flushAsync(1200)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    view.unmount()
  })

  it("在途旧读盘结果被取消，迟到结果不得覆盖新正文", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const view = render(<PreviewPanel adoptionRefreshToken={0} adoptionRefreshPath="" />)
    await flushAsync(10)

    let resolveSlow!: (content: string) => void
    mocks.readFile.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveSlow = resolve }),
    )
    view.rerender(<PreviewPanel adoptionRefreshToken={1} adoptionRefreshPath={CHAPTER_PATH} />)
    await flushAsync(5)

    mocks.readFile.mockResolvedValue(ADOPTED_MD)
    view.rerender(<PreviewPanel adoptionRefreshToken={2} adoptionRefreshPath={CHAPTER_PATH} />)
    await flushAsync(20)

    await act(async () => { resolveSlow("迟到的旧正文") })
    view.rerender(<PreviewPanel adoptionRefreshToken={2} adoptionRefreshPath={CHAPTER_PATH} />)
    expect(screen.getByTestId("editor-content").textContent).toBe(ADOPTED_MD)
    view.unmount()
  })
})

/* ------------------------------------------------------------------------- *
 * G2 统一写入协议（R-1）。上面 G2-NATIVE-F1 组锁定的是「同路径刷新 + 写序」；
 * 这里补的是统一协议本体：意图/实际 I/O 准入分离、真实 FIFO 前驱、采纳栅栏（解锁后仍有效）、
 * 受影响路径组、全部自有写者接线、refs 先于解锁、归属清理与不丢输入。
 * ------------------------------------------------------------------------- */
describe("G2 统一写入协议 — 协调层（helpers 真实实现）", () => {
  const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>((res) => { resolve = res })
    return { promise, resolve }
  }

  it("A 已真实开始、B 不越过 A、begin 等整条尾链（不把 A 的调用数写成 0）", async () => {
    const coordinator: ChapterWriteCoordinator = createChapterWriteCoordinator()
    const a = deferred()
    const order: string[] = []
    const admitA = coordinator.admitMutation(
      coordinator.captureIntent("debounce-save", "/p/a.md"),
      ["/p/a.md"],
      async () => {
        order.push("A:start")
        await a.promise
        order.push("A:end")
      },
    )
    const admitB = coordinator.admitMutation(
      coordinator.captureIntent("debounce-save", "/p/a.md"),
      ["/p/a.md"],
      async () => {
        order.push("B:start")
      },
    )
    if (admitA.kind !== "admitted" || admitB.kind !== "admitted") throw new Error("expected admitted")
    await tick()
    // A 确实已经开始（不是 0 次调用），B 还排在它后面。
    expect(order).toEqual(["A:start"])

    const adopted = coordinator.beginAdoption("/p/a.md", {})
    if (!adopted.ok) throw new Error("expected adoption begin")
    let tailSettled = false
    void adopted.admittedTail.then(() => { tailSettled = true })
    await tick()
    // begin 不在 A 落定前放行（不是单槽「最后一笔」）。
    expect(tailSettled).toBe(false)

    a.resolve()
    await tick(5)
    expect(order).toEqual(["A:start", "A:end", "B:start"])
    expect(tailSettled).toBe(true)
  })

  it("采纳解锁后迟到的旧意图仍被拒；采纳之后捕获的新意图可以准入", async () => {
    const coordinator = createChapterWriteCoordinator()
    const stale = coordinator.captureIntent("format", "/p/a.md")
    const adopted = coordinator.beginAdoption("/p/a.md", {})
    if (!adopted.ok || !adopted.lease) throw new Error("expected exclusive adoption")
    expect(coordinator.releaseAdoption(adopted.lease)).toBe(true)
    expect(coordinator.leaseOf("/p/a.md")).toBeNull()

    const late = coordinator.admitMutation(stale, ["/p/a.md"], async () => {
      throw new Error("迟到意图不得执行")
    })
    expect(late.kind).toBe("fenced")
    if (late.kind === "fenced") {
      expect(late.refusals[0].path).toBe("/p/a.md")
      expect(late.refusals[0].leased).toBe(false)
    }

    const fresh = coordinator.captureIntent("debounce-save", "/p/a.md")
    expect(coordinator.admitMutation(fresh, ["/p/a.md"], async () => undefined).kind).toBe("admitted")
  })

  it("does not run a queued save against a deleted chapter path", async () => {
    const coordinator = createChapterWriteCoordinator()
    const oldPath = "/p/wiki/chapters/old.md"
    const newPath = "/p/wiki/chapters/new.md"
    const title = coordinator.captureIntent("title", oldPath)
    const move = coordinator.admitMutation(title, [oldPath, newPath], async () => {
      coordinator.noteRelocation(title, oldPath, newPath)
    })
    const staleWrite = vi.fn(async () => undefined)
    const stale = coordinator.admitMutation(coordinator.captureIntent("debounce-save", oldPath), [oldPath], staleWrite)
    if (move.kind !== "admitted" || stale.kind !== "admitted") throw new Error("expected admitted")
    await expect(stale.result).rejects.toThrow("重新确认")
    expect(staleWrite).not.toHaveBeenCalled()
  })

it("受影响路径组：同一 barrier 登记，write/delete 不自等，也不永久归并 alias", async () => {
    const coordinator = createChapterWriteCoordinator()
    const order: string[] = []
    const group = coordinator.admitMutation(
      coordinator.captureIntent("title", "/p/wiki/chapters/第1章.md"),
      ["/p/wiki/chapters/第1章.md", "/p/wiki/chapters/第1章-新标题.md"],
      async () => {
        order.push("write-new")
        order.push("delete-old")
      },
    )
    if (group.kind !== "admitted") throw new Error("expected admitted")
    // 自等会永久挂住：用真实超时把「自等」变成失败，而不是靠整条用例超时。
    const raced = await Promise.race([
      group.result.then(() => "done" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000)),
    ])
    expect(raced).toBe("done")
    expect(order).toEqual(["write-new", "delete-old"])
    expect(group.isCurrent()).toBe(true)

    const next = coordinator.admitMutation(
      coordinator.captureIntent("debounce-save", "/p/wiki/chapters/第1章-新标题.md"),
      ["/p/wiki/chapters/第1章-新标题.md"],
      async () => undefined,
    )
    expect(next.kind).toBe("admitted")
    expect(group.isCurrent()).toBe(false)
  })

  it("lease 归属：同目标并发采纳如实 busy，旧 lease 不能释放新 lease", async () => {
    const coordinator = createChapterWriteCoordinator()
    const ownerA = {}
    const ownerB = {}
    const first = coordinator.beginAdoption("/p/a.md", ownerA)
    if (!first.ok || !first.lease) throw new Error("expected first lease")
    expect(coordinator.beginAdoption("/p/a.md", ownerB)).toEqual({ ok: false, reason: "busy" })

    expect(coordinator.releaseAdoption(first.lease)).toBe(true)
    const second = coordinator.beginAdoption("/p/a.md", ownerB)
    if (!second.ok || !second.lease) throw new Error("expected second lease")
    expect(coordinator.leaseOf("/p/a.md")).toBe(second.lease)
    // 旧 lease 的重复释放不得清新 lease。
    expect(coordinator.releaseAdoption(first.lease)).toBe(false)
    expect(coordinator.leaseOf("/p/a.md")).toBe(second.lease)
    // owner 清理只释放自己的。
    expect(coordinator.releaseOwnedAdoptions(ownerA)).toBe(0)
    expect(coordinator.leaseOf("/p/a.md")).toBe(second.lease)
    expect(coordinator.releaseOwnedAdoptions(ownerB)).toBe(1)
    expect(coordinator.leaseOf("/p/a.md")).toBeNull()
  })

  it("栅栏比较的是意图序号：受理之前捕获的该目标意图被拒，之后捕获的可准入", async () => {
    const coordinator = createChapterWriteCoordinator()
    const unrelated = coordinator.captureIntent("debounce-save", "/p/b.md")
    const beforeAdoption = coordinator.captureIntent("leave-flush", "/p/a.md")
    const adopted = coordinator.beginAdoption("/p/a.md", {}, { exclusive: false })
    if (!adopted.ok) throw new Error("expected adoption begin")
    expect(adopted.lease).toBeNull()
    // 无关目标不受影响。
    expect(coordinator.admitMutation(unrelated, ["/p/b.md"], async () => undefined).kind).toBe("admitted")
    // 受理之前捕获的该目标意图被拒。
    expect(coordinator.admitMutation(beforeAdoption, ["/p/a.md"], async () => undefined).kind).toBe("fenced")
    // 受理之后捕获的新意图允许准入。
    const afterAdoption = coordinator.captureIntent("leave-flush", "/p/a.md")
    expect(coordinator.admitMutation(afterAdoption, ["/p/a.md"], async () => undefined).kind).toBe("admitted")
  })

  it("实际 I/O 失败只释放继续、不吞业务错误", async () => {
    const coordinator = createChapterWriteCoordinator()
    const failing = coordinator.admitMutation(
      coordinator.captureIntent("debounce-save", "/p/a.md"),
      ["/p/a.md"],
      async () => {
        throw new Error("disk full")
      },
    )
    const next = coordinator.admitMutation(
      coordinator.captureIntent("debounce-save", "/p/a.md"),
      ["/p/a.md"],
      async () => "ok",
    )
    if (failing.kind !== "admitted" || next.kind !== "admitted") throw new Error("expected admitted")
    await expect(failing.result).rejects.toThrow("disk full")
    await expect(next.result).resolves.toBe("ok")
  })
})

describe("G2 统一写入协议 — 编辑区真实写者交错", () => {
  const ADOPTED_MD = CHAPTER_MD.replace("正文第一段。", "采纳后的权威正文。")
  const SECOND_PATH = "/proj/wiki/chapters/第二章.md"
  const SECOND_MD = "# 第二章\n\n新章正文"
  const TITLE_TARGET = "/proj/wiki/chapters/第1章-新标题.md"

  function renderWithGate() {
    const gateRef: { current: PreviewPanelWriteGate | null } = { current: null }
    const view = render(
      <PreviewPanel adoptionRefreshToken={0} adoptionRefreshPath="" writeGateRef={gateRef} />,
    )
    return { gateRef, view }
  }

  it("两笔在途写盘：B 不越过 A，begin 等两笔全部落定后才允许采纳", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    let resolveA!: () => void
    mocks.writeFileAtomic.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveA = resolve }),
    )
    const { gateRef, view } = renderWithGate()
    await flushAsync(10)

    mocks.saveText.value = CHAPTER_MD + "\nA 笔"
    fireEvent.click(screen.getByTestId("editor-save"))
    await flushAsync(1200)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)

    mocks.saveText.value = CHAPTER_MD + "\nB 笔"
    fireEvent.click(screen.getByTestId("editor-save"))
    await flushAsync(1200)
    // B 的防抖已经触发，但真实写盘必须排在 A 之后（FIFO 尾链，不是并发两笔）。
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)

    let settled = false
    const beginPromise = gateRef.current!.begin(CHAPTER_PATH).then((start) => {
      settled = true
      return start
    })
    await flushAsync(20)
    expect(settled).toBe(false)

    resolveA()
    const start = await beginPromise
    expect(start.status).toBe("ready")
    // A、B 两笔都已真实落定：begin 等的是整条尾链。
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(2)
    expect(mocks.writeFileAtomic.mock.calls[1][1]).toContain("B 笔")
    view.unmount()
  })

  it("终稿评审未返回时不占采纳等待链；晚返回的终稿不写、不 final、不 ingest，busy 如实结束", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.novelConfig = { reviewBeforeSave: true, autoIngestOnSave: true }
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.compactToolbar.value = false
    let resolveReview!: (results: NovelReviewResult[]) => void
    mocks.reviewChapter.mockImplementation(
      () => new Promise<NovelReviewResult[]>((resolve) => { resolveReview = resolve }),
    )
    const { gateRef, view } = renderWithGate()
    await flushAsync(10)

    fireEvent.click(screen.getByText("保存为正式章节"))
    await waitFor(() => expect(mocks.reviewChapter).toHaveBeenCalled())

    // 评审还挂着：采纳必须能照常落定（评审不进入采纳必须等待的 I/O 尾链）。
    const start = await beginAdoption(gateRef, CHAPTER_PATH)
    expect(start.status).toBe("ready")

    mocks.readFile.mockResolvedValue(ADOPTED_MD)
    view.rerender(<PreviewPanel adoptionRefreshToken={1} adoptionRefreshPath={CHAPTER_PATH} writeGateRef={gateRef} />)
    await flushAsync(20)
    view.rerender(<PreviewPanel adoptionRefreshToken={1} adoptionRefreshPath={CHAPTER_PATH} writeGateRef={gateRef} />)
    expect(mocks.readFile).toHaveBeenCalledWith(CHAPTER_PATH)
    expect(await screen.findByTestId("editor-content")).toHaveTextContent("采纳后的权威正文。")

    // 评审迟到返回：不得写盘、不得标 final、不得 ingest。
    await act(async () => { resolveReview([]) })
    await flushAsync(50)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(mocks.ingestChapter).not.toHaveBeenCalled()
    expect(mocks.state.setFinalChapterSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ saving: false, phase: null }),
    )
    // busy 如实结束：按钮不再处于「保存中」。
    expect(screen.getByText("保存为正式章节")).not.toBeDisabled()
    view.unmount()
  })

  it("标题 canonical 解析晚于采纳解锁：旧意图被拒，不写/不删/不重指，标题输入不丢", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.compactToolbar.value = false
    // canonical 解析的唯一 await（fileExists）先挂住：标题意图已捕获，实际 I/O 尚未准入。
    let resolveExists!: (value: boolean) => void
    mocks.fileExists.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => { resolveExists = resolve }),
    )
    const { gateRef, view } = renderWithGate()
    await flushAsync(10)

    const input = screen.getByRole("textbox")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "新标题" } })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.blur(input)
    await flushAsync(20)

    const start = await beginAdoption(gateRef, CHAPTER_PATH)
    expect(start.status).toBe("ready")
    // 采纳未确认落盘 → 解锁（栅栏仍记录该目标最近采纳序号）。
    act(() => { gateRef.current!.abort(start) })
    await flushAsync(20)

    // 迟到解析才返回：仍然不得写、不得删旧文件、不得把选中项改指新路径。
    await act(async () => { resolveExists(false) })
    await flushAsync(50)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(mocks.deleteFile).not.toHaveBeenCalled()
    expect(mocks.state.setSelectedFile).not.toHaveBeenCalledWith(TITLE_TARGET)
    // 被拒的是写入，不是 raw 输入；编号化只能在新的正式标题提交后发生。
    expect(screen.getByRole("textbox")).toHaveValue("新标题")
    expect(getChapterWriteCoordinator().peekRecovery(CHAPTER_PATH)).toEqual(expect.objectContaining({
      titleDraft: "新标题", titleEditing: true,
    }))
    expect(screen.getByText(/章节标题未写入/)).toBeInTheDocument()
    errSpy.mockRestore()
    view.unmount()
  })

  it("排版写盘已准入时 begin 等它落定；排版被拒时不预标已保存", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.compactToolbar.value = false
    let resolveFormat!: () => void
    mocks.writeFileAtomic.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveFormat = resolve }),
    )
    const { gateRef, view } = renderWithGate()
    await flushAsync(10)

    fireEvent.click(screen.getByText("一键排版"))
    await flushAsync(20)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)

    let settled = false
    const beginPromise = gateRef.current!.begin(CHAPTER_PATH).then((start) => {
      settled = true
      return start
    })
    await flushAsync(20)
    expect(settled).toBe(false)

    resolveFormat()
    const start = await beginPromise
    expect(start.status).toBe("ready")
    act(() => { gateRef.current!.abort(start) })
    await flushAsync(20)

    view.unmount()
  })

  it("采纳窗口内旧输入入口整体关闭：保存/排版都不可达，不存在窗口内新写入", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.compactToolbar.value = false
    const { gateRef, view } = renderWithGate()
    await flushAsync(10)

    const start = await beginAdoption(gateRef, CHAPTER_PATH)
    expect(start.status).toBe("ready")
    // 装载守卫已提交：旧编辑器与全部写入口一起卸载（不存在「窗口内补一笔」）。
    expect(screen.queryByTestId("editor-save")).toBeNull()
    expect(screen.queryByTestId("editor-content")).toBeNull()
    expect(screen.queryByText("一键排版")).toBeNull()
    expect(screen.queryByText("保存为正式章节")).toBeNull()
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()

    act(() => { gateRef.current!.abort(start) })
    await flushAsync(20)
    view.rerender(<PreviewPanel adoptionRefreshToken={0} adoptionRefreshPath="" writeGateRef={gateRef} />)
    // 中止后受控地还回来，未存正文仍在。
    expect(screen.getByTestId("editor-content").textContent).toBe(CHAPTER_MD)
    expect(screen.getByText("一键排版")).toBeInTheDocument()
    view.unmount()
  })

  it("采纳重载读成功后立即 pagehide：refs 先同步再解锁，旧缓冲不落盘", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { gateRef, view } = renderWithGate()
    await flushAsync(10)
    // 旧缓冲已排队的防抖写盘（begin 会作废它）。
    mocks.saveText.value = CHAPTER_MD + "\n旧缓冲"
    fireEvent.click(screen.getByTestId("editor-save"))

    const start = await beginAdoption(gateRef, CHAPTER_PATH)
    expect(start.status).toBe("ready")

    let resolveRead!: (content: string) => void
    mocks.readFile.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveRead = resolve }),
    )
    view.rerender(<PreviewPanel adoptionRefreshToken={1} adoptionRefreshPath={CHAPTER_PATH} writeGateRef={gateRef} />)
    await flushAsync(5)

    // 读结果落定后紧接着（同一 tick 的后续微任务）就要 pagehide：refs 必须已经同步。
    resolveRead(ADOPTED_MD)
    await act(async () => {
      await Promise.resolve()
      window.dispatchEvent(new Event("pagehide"))
    })
    await flushAsync(1200)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    view.rerender(<PreviewPanel adoptionRefreshToken={1} adoptionRefreshPath={CHAPTER_PATH} writeGateRef={gateRef} />)
    expect(screen.getByTestId("editor-content").textContent).toBe(ADOPTED_MD)
    view.unmount()
  })

  it("采纳重载读失败后立即 pagehide：refs 同步恢复输入及失败回执，不写回正式章", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { gateRef, view } = renderWithGate()
    await flushAsync(10)
    mocks.saveText.value = CHAPTER_MD + "\n旧缓冲"
    fireEvent.click(screen.getByTestId("editor-save"))

    const start = await beginAdoption(gateRef, CHAPTER_PATH)
    expect(start.status).toBe("ready")

    mocks.readFile.mockRejectedValueOnce(new Error("disk gone"))
    view.rerender(<PreviewPanel adoptionRefreshToken={1} adoptionRefreshPath={CHAPTER_PATH} writeGateRef={gateRef} />)
    await flushAsync(20)
    window.dispatchEvent(new Event("pagehide"))
    await flushAsync(1200)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    view.rerender(<PreviewPanel adoptionRefreshToken={1} adoptionRefreshPath={CHAPTER_PATH} writeGateRef={gateRef} />)
    expect(screen.getByTestId("editor-content").textContent).toBe(CHAPTER_MD + "\n旧缓冲")
    expect(getChapterWriteCoordinator().peekRecovery(CHAPTER_PATH)?.buffer).toBe(CHAPTER_MD + "\n旧缓冲")
    expect(getChapterWriteCoordinator().isFenced(CHAPTER_PATH)).toBe(false)
    expect(screen.getByText(/操作失败：disk gone/)).toBeInTheDocument()
    view.unmount()
  })

  it("采纳窗口内切章：按归属释放 lease，旧 lease 不清新 lease，新编辑仍能正常保存", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { gateRef, view } = renderWithGate()
    await flushAsync(10)

    const start = await beginAdoption(gateRef, CHAPTER_PATH)
    expect(start.status).toBe("ready")

    // 采纳窗口内切到别章：旧章缓冲不得被 flush 回正式章；lease 仍在途（IPC 链未结束）。
    mocks.state.selectedFile = SECOND_PATH
    mocks.readFile.mockResolvedValue(SECOND_MD)
    view.rerender(<PreviewPanel adoptionRefreshToken={0} adoptionRefreshPath="" writeGateRef={gateRef} />)
    await flushAsync(20)
    view.rerender(<PreviewPanel adoptionRefreshToken={0} adoptionRefreshPath="" writeGateRef={gateRef} />)
    expect(screen.getByTestId("editor-content").textContent).toBe(SECOND_MD)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(getChapterWriteCoordinator().leaseOf(CHAPTER_PATH)).not.toBeNull()

    // 新目标可以再开一次采纳（不是被旧 lease 误拦同章，而是不同路径互不影响）。
    const second = await beginAdoption(gateRef, SECOND_PATH)
    expect(second.status).toBe("ready")
    const lease2 = getChapterWriteCoordinator().leaseOf(SECOND_PATH)
    expect(lease2).not.toBeNull()

    // 旧的读结果/旧 cleanup 落定不得清新 lease。
    view.rerender(<PreviewPanel adoptionRefreshToken={0} adoptionRefreshPath="" writeGateRef={gateRef} />)
    await flushAsync(20)
    expect(getChapterWriteCoordinator().leaseOf(SECOND_PATH)).toBe(lease2)

    // 旧章中止只释放自己的 lease，不碰新 lease。
    act(() => { gateRef.current!.abort(start) })
    expect(getChapterWriteCoordinator().leaseOf(CHAPTER_PATH)).toBeNull()
    expect(getChapterWriteCoordinator().leaseOf(SECOND_PATH)).toBe(lease2)

    act(() => { gateRef.current!.abort(second) })
    await flushAsync(20)
    view.rerender(<PreviewPanel adoptionRefreshToken={0} adoptionRefreshPath="" writeGateRef={gateRef} />)
    // 旧 lease 释放后正常编辑保存恢复（flush 没有被永久抑制）。
    mocks.saveText.value = SECOND_MD + "\n切章后继续写"
    fireEvent.click(screen.getByTestId("editor-save"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1), { timeout: 3000 })
    expect(mocks.writeFileAtomic.mock.calls[0][0]).toBe(SECOND_PATH)
    expect(mocks.writeFileAtomic.mock.calls[0][1]).toContain("切章后继续写")
    view.unmount()
  })

  it("采纳 abort 时当前在别章：不灌别章内容、不写快照路径，保留恢复快照归属", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { gateRef, view } = renderWithGate()
    await flushAsync(10)
    mocks.saveText.value = CHAPTER_MD + "\nA 章未存正文"
    fireEvent.click(screen.getByTestId("editor-save"))

    const start = await beginAdoption(gateRef, CHAPTER_PATH)
    expect(start.status).toBe("ready")
    const snapshotBuffer = start.status === "ready" ? start.snapshot.buffer : ""
    expect(snapshotBuffer).toContain("A 章未存正文")

    mocks.state.selectedFile = SECOND_PATH
    mocks.readFile.mockResolvedValue(SECOND_MD)
    view.rerender(<PreviewPanel adoptionRefreshToken={0} adoptionRefreshPath="" writeGateRef={gateRef} />)
    await flushAsync(20)
    view.rerender(<PreviewPanel adoptionRefreshToken={0} adoptionRefreshPath="" writeGateRef={gateRef} />)
    expect(screen.getByTestId("editor-content").textContent).toBe(SECOND_MD)

    act(() => { gateRef.current!.abort(start) })
    await flushAsync(50)
    // 当前别章内容不被旧快照覆盖，也不替旧章自动写盘。
    expect(screen.getByTestId("editor-content").textContent).toBe(SECOND_MD)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    // 未存输入不丢：恢复归属保留在协调层，等该章真实 UI 回来。
    expect(getChapterWriteCoordinator().peekRecovery(CHAPTER_PATH)?.buffer).toContain("A 章未存正文")
    view.unmount()
  })

  it("可选 props 全缺省（无写入门）：协议照常工作，防抖保存仍落盘", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    expect(screen.getByTestId("editor-content").textContent).toBe(CHAPTER_MD)
    mocks.saveText.value = CHAPTER_MD + "\n缺省 props 下的改动"
    fireEvent.click(screen.getByTestId("editor-save"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1), { timeout: 3000 })
    expect(mocks.writeFileAtomic.mock.calls[0][0]).toBe(CHAPTER_PATH)
    expect(mocks.writeFileAtomic.mock.calls[0][1]).toContain("缺省 props 下的改动")
    view.unmount()
  })
})

// The additional human-authorized R-1 slot: reverse interleavings missing from
// the frozen 233-test candidate. No gate facsimiles: all cases mount production
// PreviewPanel / WritingWorkspace and use the production shared coordinator.
describe("R6-PC additional executor — real reverse interleavings", () => {
  const OTHER_PATH = "/proj/wiki/chapters/第二章.md"
  const OTHER_CANONICAL_PATH = "/proj/wiki/chapters/第2章.md"
  const OTHER_MD = CHAPTER_MD.replace(/第一章/g, "第二章").replace("chapter_number: 1", "chapter_number: 2").replace("正文第一段。", "B 章盘上正文。")
  const ADOPTED_MD = CHAPTER_MD.replace("正文第一段。", "采纳后的权威正文。")

  function controlled<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }
  function titleInput(): HTMLInputElement {
    const input = document.querySelector("input[type='text']")
    if (!(input instanceof HTMLInputElement)) throw new Error("real chapter title input missing")
    return input
  }
  function bodyInput(): HTMLTextAreaElement {
    const input = document.querySelector("textarea")
    if (!(input instanceof HTMLTextAreaElement)) throw new Error("real WritingTextarea missing")
    return input
  }
  function setupDisk() {
    const disk = new Map([[CHAPTER_PATH, CHAPTER_MD], [OTHER_PATH, OTHER_MD]])
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockImplementation(async (path: string) => disk.get(path) ?? "")
    mocks.writeFileAtomic.mockImplementation(async (path: string, content: string) => { disk.set(path, content) })
    mocks.deleteFile.mockImplementation(async (path: string) => { disk.delete(path) })
    mocks.acceptChapterDraft.mockImplementation(async (input: { formalChapterPath: string }) => {
      await mocks.writeFileAtomic(input.formalChapterPath, ADOPTED_MD)
    })
    return disk
  }
  function panelWithGate() {
    const gateRef: { current: PreviewPanelWriteGate | null } = { current: null }
    const view = render(<PreviewPanel writeGateRef={gateRef} />)
    return { gateRef, view }
  }
  async function openConfirmation() {
    fireEvent.click(screen.getByTestId("workspace-desk-drafts"))
    await screen.findByTestId("workspace-confirm")
  }

  it("PC1 committed accept keeps body/title through a failed authority read and consumes only old body on successful remount", async () => {
    const disk = setupDisk()
    mocks.realEditor.value = true
    const coordinator = getChapterWriteCoordinator()
    const { gateRef, view } = panelWithGate()
    await flushAsync(20)
    const latestBody = "真实采纳前尚未保存的正文。"
    const latestTitle = "  读失败仍保留的原始标题  "
    fireEvent.change(bodyInput(), { target: { value: latestBody } })
    fireEvent.focus(titleInput())
    fireEvent.change(titleInput(), { target: { value: latestTitle } })
    const start = await beginAdoption(gateRef, CHAPTER_PATH)
    if (start.status !== "ready" || !start.lease) throw new Error("real adoption lease missing")
    await act(async () => {
      await coordinator.runAdoption(start.lease!, () => mocks.acceptChapterDraft({ formalChapterPath: CHAPTER_PATH }))
    })
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    expect(disk.get(CHAPTER_PATH)).toBe(ADOPTED_MD)

    mocks.readFile.mockRejectedValueOnce(new Error("adopted authority read failed"))
    view.rerender(<PreviewPanel adoptionRefreshToken={1} adoptionRefreshPath={CHAPTER_PATH} writeGateRef={gateRef} />)
    await flushAsync(20)
    expect(bodyInput()).toHaveValue(latestBody)
    expect(titleInput()).toHaveValue(latestTitle)
    expect(screen.getByText(/操作失败：adopted authority read failed/)).toBeInTheDocument()
    expect(coordinator.peekRecovery(CHAPTER_PATH)).toEqual(expect.objectContaining({
      titleDraft: latestTitle, titleEditing: true, adoptionCommitted: true,
    }))
    expect(coordinator.peekRecovery(CHAPTER_PATH)?.buffer).toContain(latestBody)
    window.dispatchEvent(new Event("pagehide"))
    await flushAsync(1100)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    expect(disk.get(CHAPTER_PATH)).toBe(ADOPTED_MD)
    view.unmount()

    const next = render(<PreviewPanel />)
    await flushAsync(20)
    expect(bodyInput()).toHaveValue("采纳后的权威正文。\n")
    expect(titleInput()).toHaveValue(latestTitle)
    expect(coordinator.peekRecovery(CHAPTER_PATH)).toEqual(expect.objectContaining({
      titleDraft: latestTitle, titleEditing: true, buffer: undefined, adoptionCommitted: false,
    }))
    window.dispatchEvent(new Event("pagehide"))
    await flushAsync(1100)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    expect(disk.get(CHAPTER_PATH)).not.toContain(latestTitle)
    next.unmount()
  })

  it("PC1 a new no-UI failed adoption cannot borrow the prior committed marker to discard recovered input", async () => {
    const disk = setupDisk()
    mocks.realEditor.value = true
    const coordinator = getChapterWriteCoordinator()
    const { gateRef, view } = panelWithGate()
    await flushAsync(20)
    const latestBody = "两次采纳之间仍未保存的输入。"
    const latestTitle = "  两次采纳之间的未提交标题  "
    fireEvent.change(bodyInput(), { target: { value: latestBody } })
    fireEvent.focus(titleInput())
    fireEvent.change(titleInput(), { target: { value: latestTitle } })
    const first = await beginAdoption(gateRef, CHAPTER_PATH)
    if (first.status !== "ready" || !first.lease) throw new Error("real first adoption lease missing")
    await act(async () => {
      await coordinator.runAdoption(first.lease!, () => mocks.acceptChapterDraft({ formalChapterPath: CHAPTER_PATH }))
    })
    mocks.readFile.mockRejectedValueOnce(new Error("first authority read failed"))
    view.rerender(<PreviewPanel adoptionRefreshToken={1} adoptionRefreshPath={CHAPTER_PATH} writeGateRef={gateRef} />)
    await flushAsync(20)
    expect(coordinator.peekRecovery(CHAPTER_PATH)?.adoptionCommitted).toBe(true)
    view.unmount()

    const second = coordinator.beginAdoption(CHAPTER_PATH, {})
    if (!second.ok || !second.lease) throw new Error("real no-UI adoption lease missing")
    expect(coordinator.peekRecovery(CHAPTER_PATH)).toEqual(expect.objectContaining({
      adoptionId: second.lease.id, adoptionCommitted: false,
    }))
    await expect(coordinator.runAdoption(second.lease, async () => {
      throw new Error("second accept failed")
    })).rejects.toThrow("second accept failed")
    expect(coordinator.releaseAdoption(second.lease)).toBe(true)
    const next = render(<PreviewPanel />)
    await flushAsync(20)
    expect(bodyInput()).toHaveValue(latestBody)
    expect(titleInput()).toHaveValue(latestTitle)
    expect(coordinator.peekRecovery(CHAPTER_PATH)?.adoptionCommitted).toBe(false)
    window.dispatchEvent(new Event("pagehide"))
    await flushAsync(1100)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    expect(disk.get(CHAPTER_PATH)).toBe(ADOPTED_MD)
    next.unmount()
  })

  it("PC1 normal selection clears another chapter's title without discarding the original pending input", async () => {
    setupDisk()
    mocks.realEditor.value = true
    const view = render(<PreviewPanel />)
    await flushAsync(20)
    const pendingTitle = "  A 章未提交的原始标题  "
    fireEvent.focus(titleInput())
    fireEvent.change(titleInput(), { target: { value: pendingTitle } })
    mocks.state.selectedFile = OTHER_PATH
    view.rerender(<PreviewPanel />)
    await flushAsync(20)
    expect(bodyInput()).toHaveValue("B 章盘上正文。\n")
    expect(titleInput()).toHaveValue("第二章")
    expect(getChapterWriteCoordinator().peekRecovery(CHAPTER_PATH)).toEqual(expect.objectContaining({
      titleDraft: pendingTitle, titleEditing: true,
    }))
    window.dispatchEvent(new Event("pagehide"))
    await flushAsync(20)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    mocks.state.selectedFile = CHAPTER_PATH
    view.rerender(<PreviewPanel />)
    await flushAsync(20)
    expect(bodyInput()).toHaveValue("正文第一段。\n")
    expect(titleInput()).toHaveValue(pendingTitle)
    window.dispatchEvent(new Event("pagehide"))
    await flushAsync(1100)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    view.unmount()
  })

  it("PC1 abort on another chapter restores latest body/title into REAL returning and remounted UI without writes", async () => {
    setupDisk()
    mocks.realEditor.value = true
    const { gateRef, view } = panelWithGate()
    await flushAsync(20)
    const latestBody = "A 章真正未存的最新正文。"
    const latestTitle = "  A 章未提交标题  "
    fireEvent.change(bodyInput(), { target: { value: latestBody } })
    fireEvent.focus(titleInput())
    fireEvent.change(titleInput(), { target: { value: latestTitle } })
    const originalGate = gateRef.current!
    const start = await beginAdoption(gateRef, CHAPTER_PATH)
    expect(start.status).toBe("ready")
    expect(document.querySelector("textarea")).toBeNull()

    mocks.state.selectedFile = OTHER_PATH
    view.rerender(<PreviewPanel writeGateRef={gateRef} />)
    await flushAsync(20)
    expect(bodyInput()).toHaveValue("B 章盘上正文。\n")
    act(() => originalGate.abort(start))
    await flushAsync(20)
    expect(bodyInput()).toHaveValue("B 章盘上正文。\n")
    expect(titleInput()).toHaveValue("第二章")

    mocks.state.selectedFile = CHAPTER_PATH
    view.rerender(<PreviewPanel writeGateRef={gateRef} />)
    await flushAsync(20)
    expect(bodyInput()).toHaveValue(latestBody)
    expect(titleInput()).toHaveValue(latestTitle)
    window.dispatchEvent(new Event("pagehide"))
    await flushAsync(1100)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    view.unmount()
    const remount = render(<PreviewPanel />)
    await flushAsync(20)
    expect(bodyInput()).toHaveValue(latestBody)
    expect(titleInput()).toHaveValue(latestTitle)
    window.dispatchEvent(new Event("pagehide"))
    await flushAsync(20)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    remount.unmount()
  })

  it("PC1 explicit Ctrl+S saves recovered body, not hydration, and keeps the pending title across remount", async () => {
    const disk = setupDisk()
    mocks.realEditor.value = true
    const { gateRef, view } = panelWithGate()
    await flushAsync(20)
    const latestBody = "恢复后明确保存的正文 B。"
    const latestTitle = "  仍未提交的标题 B  "
    fireEvent.change(bodyInput(), { target: { value: latestBody } })
    fireEvent.focus(titleInput())
    fireEvent.change(titleInput(), { target: { value: latestTitle } })
    const originalGate = gateRef.current!
    const start = await beginAdoption(gateRef, CHAPTER_PATH)
    act(() => originalGate.abort(start))
    await flushAsync(20)
    expect(bodyInput()).toHaveValue(latestBody)
    expect(titleInput()).toHaveValue(latestTitle)
    window.dispatchEvent(new Event("pagehide"))
    await flushAsync(1100)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()

    fireEvent.keyDown(bodyInput(), { key: "s", ctrlKey: true })
    window.dispatchEvent(new Event("pagehide"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1))
    expect(disk.get(CHAPTER_PATH)).toContain(latestBody)
    expect(disk.get(CHAPTER_PATH)).not.toContain(latestTitle)
    expect(getChapterWriteCoordinator().peekRecovery(CHAPTER_PATH)).toEqual(expect.objectContaining({
      titleDraft: latestTitle, titleEditing: true, buffer: undefined,
    }))
    view.unmount()
    const next = render(<PreviewPanel />)
    await flushAsync(20)
    // 显式保存沿用既有正文排版：两全角缩进，而非未存 raw 输入的尾换行。
    expect(bodyInput()).toHaveValue(`　　${latestBody}`)
    expect(titleInput()).toHaveValue(latestTitle)
    window.dispatchEvent(new Event("pagehide"))
    await flushAsync(1100)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    next.unmount()
  })

  it.each(["failed", "fenced"] as const)("PC1 late %s title retains its ORIGINAL input owner, never another chapter's title", async (mode) => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
    setupDisk()
    const exists = controlled<boolean>()
    const write = controlled<void>()
    if (mode === "fenced") mocks.fileExists.mockReturnValueOnce(exists.promise)
    else mocks.writeFileAtomic.mockReturnValueOnce(write.promise)
    const { gateRef, view } = panelWithGate()
    await flushAsync(20)
    const originalTitle = "  A 章原始标题输入  "
    fireEvent.focus(titleInput())
    fireEvent.change(titleInput(), { target: { value: originalTitle } })
    fireEvent.blur(titleInput())
    await flushAsync(20)
    const originalGate = gateRef.current!
    const start = mode === "fenced" ? await beginAdoption(gateRef, CHAPTER_PATH) : null
    mocks.state.selectedFile = OTHER_PATH
    view.rerender(<PreviewPanel writeGateRef={gateRef} />)
    await flushAsync(20)
    fireEvent.focus(titleInput())
    fireEvent.change(titleInput(), { target: { value: "B 章自己的新标题" } })
    if (start) act(() => originalGate.abort(start))
    await act(async () => {
      if (mode === "fenced") exists.resolve(false)
      else write.reject(new Error("old A title write failed"))
    })
    await flushAsync(20)
    expect(titleInput()).toHaveValue("B 章自己的新标题")
    mocks.state.selectedFile = CHAPTER_PATH
    view.rerender(<PreviewPanel writeGateRef={gateRef} />)
    await flushAsync(20)
    expect(titleInput()).toHaveValue(originalTitle)
    // A failure means an actual I/O was issued; a fenced late intent was not.
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(mode === "failed" ? 1 : 0)
    window.dispatchEvent(new Event("pagehide"))
    await flushAsync(20)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(mode === "failed" ? 1 : 0)
    view.unmount()
    errorLog.mockRestore()
  })

  it("PC2 old issued write -> begin -> unmount/new instance -> old result neither leaks nor clears a newer lease", async () => {
    const disk = setupDisk()
    const oldWrite = controlled<void>()
    mocks.writeFileAtomic.mockImplementationOnce(async (path: string, body: string) => {
      await oldWrite.promise
      disk.set(path, body)
    })
    mocks.compactToolbar.value = false
    const { gateRef, view } = panelWithGate()
    await flushAsync(20)
    fireEvent.click(screen.getByText("一键排版"))
    await flushAsync(20)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    mocks.saveText.value = CHAPTER_MD + "\n晚于已派发排版的 B 输入"
    fireEvent.click(screen.getByTestId("editor-save"))
    const oldGate = gateRef.current!
    const pendingBegin = oldGate.begin(CHAPTER_PATH)
    await flushAsync(20)
    view.unmount()
    const nextGateRef: { current: PreviewPanelWriteGate | null } = { current: null }
    const next = render(<PreviewPanel writeGateRef={nextGateRef} />)
    await flushAsync(20)
    // Already-issued old I/O is still pending; the new observer cannot hydrate
    // and enable the old on-disk buffer while that predecessor is outstanding.
    expect(screen.queryByTestId("editor-save")).toBeNull()
    await act(async () => oldWrite.resolve())
    const oldStart = await pendingBegin
    expect(oldStart).toEqual({ status: "blocked", reason: "cancelled" })
    await flushAsync(20)
    expect(screen.getByTestId("editor-content")).toHaveTextContent("晚于已派发排版的 B 输入")
    const newer = await beginAdoption(nextGateRef, CHAPTER_PATH)
    expect(newer.status).toBe("ready")
    const newerLease = getChapterWriteCoordinator().leaseOf(CHAPTER_PATH)
    expect(newerLease).not.toBeNull()
    act(() => nextGateRef.current!.abort(oldStart))
    expect(getChapterWriteCoordinator().leaseOf(CHAPTER_PATH)).toBe(newerLease)
    act(() => nextGateRef.current!.abort(newer))
    await flushAsync(20)
    // Re-emission of the restored markdown is hydration, not a user save.
    fireEvent.click(screen.getByTestId("editor-reemit"))
    window.dispatchEvent(new Event("pagehide"))
    await flushAsync(1100)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    next.unmount()
  })

  it("PC2 preparing lease survives REAL layout remount before the prior I/O tail settles", async () => {
    const disk = setupDisk()
    const oldWrite = controlled<void>()
    const acceptedWrite = controlled<void>()
    mocks.compactToolbar.value = false
    mocks.writeFileAtomic.mockImplementation(async (path: string, body: string) => {
      if (body === ADOPTED_MD) await acceptedWrite.promise
      else await oldWrite.promise
      disk.set(path, body)
    })
    const view = render(<WritingWorkspace />)
    await flushAsync(20)
    fireEvent.click(screen.getByText("一键排版"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1))
    mocks.saveText.value = CHAPTER_MD + "\n旧 I/O 之后尚未保存的 B 输入"
    fireEvent.click(screen.getByTestId("editor-save"))
    await openConfirmation()
    fireEvent.click(screen.getByTestId("workspace-confirm"))
    await flushAsync(20)
    const coordinator = getChapterWriteCoordinator()
    const preparingLease = coordinator.leaseOf(CHAPTER_PATH)
    expect(preparingLease).not.toBeNull()
    expect(mocks.acceptChapterDraft).not.toHaveBeenCalled()
    mocks.state.chatExpanded = true
    mocks.state.chatDockPosition = "right"
    view.rerender(<WritingWorkspace />)
    await flushAsync(20)
    expect(screen.queryByTestId("editor-save")).toBeNull()
    expect(coordinator.leaseOf(CHAPTER_PATH)).toBe(preparingLease)

    await act(async () => oldWrite.resolve())
    await waitFor(() => expect(mocks.acceptChapterDraft).toHaveBeenCalledTimes(1))
    expect(coordinator.leaseOf(CHAPTER_PATH)).toBe(preparingLease)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId("editor-save")).toBeNull()
    expect(coordinator.admitMutation(coordinator.captureIntent("format", CHAPTER_PATH), [CHAPTER_PATH], async () => undefined).kind).toBe("fenced")
    await act(async () => acceptedWrite.resolve())
    await waitFor(() => expect(mocks.acceptSettled).toHaveBeenCalledTimes(1))
    await flushAsync(20)
    view.rerender(<WritingWorkspace />)
    expect(screen.getByTestId("editor-content")).toHaveTextContent("采纳后的权威正文。")
    expect(mocks.confirmError).not.toHaveBeenCalled()
    expect(coordinator.leaseOf(CHAPTER_PATH)).toBeNull()
    window.dispatchEvent(new Event("pagehide"))
    await flushAsync(1100)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(2)
    view.unmount()
  })

  it("PC2 actual accept I/O -> REAL layout remount -> same-target writer stays behind accept while unrelated A works", async () => {
    const disk = setupDisk()
    const accepting = controlled<void>()
    const order: string[] = []
    mocks.writeFileAtomic.mockImplementation(async (path: string, body: string) => {
      order.push(`write:${path}`)
      if (body === ADOPTED_MD) {
        await accepting.promise
        order.push("accept-I/O:settled")
      }
      disk.set(path, body)
    })
    const view = render(<WritingWorkspace />)
    await flushAsync(20)
    await openConfirmation()
    fireEvent.click(screen.getByTestId("workspace-confirm"))
    await waitFor(() => expect(mocks.acceptChapterDraft).toHaveBeenCalledTimes(1))
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    mocks.state.chatExpanded = true
    mocks.state.chatDockPosition = "right"
    view.rerender(<WritingWorkspace />)
    await flushAsync(20)
    expect(screen.queryByTestId("editor-save")).toBeNull()
    const coordinator = getChapterWriteCoordinator()
    const forbiddenWrite = vi.fn(async () => undefined)
    const concurrent = coordinator.admitMutation(coordinator.captureIntent("format", CHAPTER_PATH), [CHAPTER_PATH], forbiddenWrite)
    expect(concurrent.kind).toBe("fenced")
    expect(forbiddenWrite).not.toHaveBeenCalled()

    mocks.state.selectedFile = OTHER_PATH
    view.rerender(<WritingWorkspace />)
    await flushAsync(20)
    mocks.saveText.value = OTHER_MD + "\n无关 A 正常编辑"
    fireEvent.click(screen.getByTestId("editor-save"))
    window.dispatchEvent(new Event("pagehide"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(mocks.state.selectedFile).toBe(OTHER_CANONICAL_PATH))
    expect(disk.get(OTHER_CANONICAL_PATH)).toContain("无关 A 正常编辑")
    expect(disk.has(OTHER_PATH)).toBe(false)
    expect(order).not.toContain("accept-I/O:settled")
    mocks.state.selectedFile = CHAPTER_PATH
    view.rerender(<WritingWorkspace />)
    await flushAsync(20)
    expect(screen.queryByTestId("editor-save")).toBeNull()
    await act(async () => accepting.resolve())
    await flushAsync(20)
    view.rerender(<WritingWorkspace />)
    expect(screen.getByTestId("editor-content")).toHaveTextContent("采纳后的权威正文。")
    window.dispatchEvent(new Event("pagehide"))
    await flushAsync(20)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(2)
    mocks.saveText.value = ADOPTED_MD + "\n新实例在采纳后继续写"
    fireEvent.click(screen.getByTestId("editor-save"))
    window.dispatchEvent(new Event("pagehide"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(3))
    expect(order.indexOf("accept-I/O:settled")).toBeLessThan(order.lastIndexOf(`write:${CHAPTER_PATH}`))
    expect(disk.get(CHAPTER_PATH)).toContain("新实例在采纳后继续写")
    expect(mocks.acceptSettled).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it("PC2/PC4 old B mutation pending while UI shows A -> adopt B waits B, ordinary selection does not reject adoption", async () => {
    const disk = setupDisk()
    const oldB = controlled<void>()
    const ingest = controlled<{ snapshot: { chapterNumber: number } | null; failReason: string | null }>()
    mocks.state.novelConfig = { reviewBeforeSave: false, autoIngestOnSave: true }
    mocks.ingestChapter.mockReturnValueOnce(ingest.promise)
    mocks.compactToolbar.value = false
    mocks.writeFileAtomic.mockImplementationOnce(async (path: string, body: string) => {
      await oldB.promise
      disk.set(path, body)
    })
    const view = render(<WritingWorkspace />)
    await flushAsync(20)
    fireEvent.click(screen.getByText("一键排版"))
    await flushAsync(20)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    mocks.state.selectedFile = OTHER_PATH
    view.rerender(<WritingWorkspace />)
    await flushAsync(20)
    await openConfirmation()
    fireEvent.click(screen.getByTestId("workspace-confirm"))
    await flushAsync(20)
    expect(mocks.acceptChapterDraft).not.toHaveBeenCalled()
    expect(screen.getByTestId("editor-content")).toHaveTextContent("B 章盘上正文。")
    mocks.saveText.value = OTHER_MD + "\nA 章继续使用"
    fireEvent.click(screen.getByTestId("editor-save"))
    window.dispatchEvent(new Event("pagehide"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(mocks.state.selectedFile).toBe(OTHER_CANONICAL_PATH))
    expect(disk.get(OTHER_CANONICAL_PATH)).toContain("A 章继续使用")
    expect(disk.has(OTHER_PATH)).toBe(false)
    await act(async () => oldB.resolve())
    await waitFor(() => expect(mocks.acceptSettled).toHaveBeenCalledTimes(1))
    expect(mocks.acceptChapterDraft).toHaveBeenCalledWith(expect.objectContaining({ formalChapterPath: CHAPTER_PATH, confirmed: true }))
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(3)
    expect(disk.get(CHAPTER_PATH)).toBe(ADOPTED_MD)
    // B 的成功 token 不负责重载已经完成自身 canonical 写入的 A。
    expect(screen.getByTestId("editor-content")).toHaveTextContent("A 章继续使用")
    expect(mocks.state.selectedFile).toBe(OTHER_CANONICAL_PATH)
    expect(mocks.confirmError).not.toHaveBeenCalled()
    await act(async () => ingest.resolve({ snapshot: { chapterNumber: 1 }, failReason: null }))
    view.unmount()
  })

  it("PC3 old format A -> newer unsaved B/title -> committed DOM closure -> partial accept failure preserves B, never auto-writes it", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
    const disk = setupDisk()
    mocks.realEditor.value = true
    mocks.compactToolbar.value = false
    const oldFormat = controlled<void>()
    mocks.writeFileAtomic.mockImplementationOnce(async (path: string, body: string) => {
      await oldFormat.promise
      disk.set(path, body)
    })
    const partial = CHAPTER_MD.replace("正文第一段。", "accept 已有部分 I/O。")
    mocks.acceptChapterDraft.mockImplementationOnce(async (input: { formalChapterPath: string }) => {
      await mocks.writeFileAtomic(input.formalChapterPath, partial)
      throw new Error("partial write then verification failed")
    })
    const view = render(<WritingWorkspace />)
    await flushAsync(20)
    await openConfirmation()
    fireEvent.click(screen.getByText("一键排版"))
    await flushAsync(20)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    const latestBody = "真正更晚的未存正文 B。\n第二行仍未存。"
    const latestTitle = "  真正更晚的未提交标题 B  "
    fireEvent.change(bodyInput(), { target: { value: latestBody } })
    fireEvent.focus(titleInput())
    fireEvent.change(titleInput(), { target: { value: latestTitle } })
    fireEvent.click(screen.getByTestId("workspace-confirm"))
    await flushAsync(20)
    expect(document.querySelector("textarea")).toBeNull()
    expect(document.querySelector("input[type='text']")).toBeNull()
    expect(screen.queryByText("一键排版")).toBeNull()
    expect(mocks.acceptChapterDraft).not.toHaveBeenCalled()
    await act(async () => oldFormat.resolve())
    await waitFor(() => expect(mocks.confirmError).toHaveBeenCalledTimes(1))
    view.rerender(<WritingWorkspace />)
    expect(bodyInput()).toHaveValue(latestBody)
    expect(titleInput()).toHaveValue(latestTitle)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(2)
    expect(disk.get(CHAPTER_PATH)).toBe(partial)
    expect(mocks.acceptSettled).not.toHaveBeenCalled()
    window.dispatchEvent(new Event("pagehide"))
    await flushAsync(1100)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(2)
    view.unmount()
    const remount = render(<WritingWorkspace />)
    await flushAsync(20)
    expect(bodyInput()).toHaveValue(latestBody)
    expect(titleInput()).toHaveValue(latestTitle)
    window.dispatchEvent(new Event("pagehide"))
    await flushAsync(20)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(2)
    expect(disk.get(CHAPTER_PATH)).toBe(partial)
    remount.unmount()
    errorLog.mockRestore()
  })

  it("PC4 admitted canonical A->A' relocation stops the OLD confirmation; latest input restores to its explicitly relocated owner", async () => {
    const disk = setupDisk()
    const migration = controlled<void>()
    const target = "/proj/wiki/chapters/第1章-迁移.md"
    mocks.realEditor.value = true
    mocks.writeFileAtomic.mockImplementationOnce(async (path: string, body: string) => {
      await migration.promise
      disk.set(path, body)
    })
    const view = render(<WritingWorkspace />)
    await flushAsync(20)
    await openConfirmation()
    fireEvent.focus(titleInput())
    fireEvent.change(titleInput(), { target: { value: "迁移" } })
    fireEvent.blur(titleInput())
    await flushAsync(20)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    expect(mocks.writeFileAtomic.mock.calls[0][0]).toBe(target)
    const latestBody = "迁移旧 I/O 之后输入但尚未保存的 B。"
    fireEvent.change(bodyInput(), { target: { value: latestBody } })
    fireEvent.focus(titleInput())
    fireEvent.change(titleInput(), { target: { value: "最新未提交标题 B" } })
    fireEvent.click(screen.getByTestId("workspace-confirm"))
    await flushAsync(20)
    expect(mocks.acceptChapterDraft).not.toHaveBeenCalled()
    await act(async () => migration.resolve())
    await flushAsync(20)
    view.rerender(<WritingWorkspace />)
    await flushAsync(20)
    expect(mocks.deleteFile).toHaveBeenCalledWith(CHAPTER_PATH)
    expect(mocks.state.selectedFile).toBe(target)
    expect(mocks.acceptChapterDraft).not.toHaveBeenCalled()
    expect(mocks.acceptSettled).not.toHaveBeenCalled()
    expect(mocks.ingestChapter).not.toHaveBeenCalled()
    expect(mocks.confirmError).toHaveBeenCalledTimes(1)
    expect(String(mocks.confirmError.mock.calls[0][0])).toContain("重新确认")
    expect(bodyInput()).toHaveValue(latestBody)
    expect(titleInput()).toHaveValue("最新未提交标题 B")
    window.dispatchEvent(new Event("pagehide"))
    await flushAsync(1100)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    expect(disk.has(CHAPTER_PATH)).toBe(false)
    expect(disk.get(target)).toBe(normalizeChapterWriting(CHAPTER_MD.replace("# 第一章", "# 第1章-迁移")))
    view.unmount()
  })
})

describe("PreviewPanel — U4-01 未编辑失焦/Escape 零写盘与 Enter 防二次提交", () => {
  it("非规范标题未编辑 focus → blur 零写盘、零删旧、零迁移", async () => {
    // CHAPTER_MD 含 chapter_number: 1 且标题为非规范「第一章」（若误提交会规范化并迁移为 第1章-第一章.md）
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    expect(input).toHaveValue("第一章")

    fireEvent.focus(input)
    fireEvent.blur(input)
    await flushAsync(30)

    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(mocks.deleteFile).not.toHaveBeenCalled()
    expect(mocks.state.setSelectedFile).not.toHaveBeenCalled()
    expect(input).toHaveValue("第一章")
    cleanup()
  })

  it("编辑标题后按 Escape（含随后 blur）零写盘并恢复原标题", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "临时误改标题" } })
    expect(input).toHaveValue("临时误改标题")
    fireEvent.keyDown(input, { key: "Escape" })
    // 模拟真实浏览器中 e.currentTarget.blur() 派发的 onBlur
    fireEvent.blur(input)
    await flushAsync(30)

    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(mocks.deleteFile).not.toHaveBeenCalled()
    expect(input).toHaveValue("第一章")
    cleanup()
  })

  it("编辑标题后按 Enter 立即提交且紧随其后的 blur 不二次触发写盘", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "只写一次" } })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.blur(input)

    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1))
    await flushAsync(40)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    expect(mocks.deleteFile).toHaveBeenCalledTimes(1)
    expect(mocks.writeFileAtomic.mock.calls[0][0]).toBe("/proj/wiki/chapters/第1章-只写一次.md")
    cleanup()
  })
})

describe("PreviewPanel — U4-02 重定位防旧路径复活与 ingest_failed 参数兜底", () => {
  it("外部重定位广播立即清防抖 timer，且切到新路径时跳过离开 flush（不复活旧文件）", async () => {
    const relocatedPath = "/proj/wiki/chapters/卷1/第1章.md"
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockImplementation(async (p: string) =>
      p === relocatedPath ? CHAPTER_MD.replace("正文第一段。", "已移卷正文。") : CHAPTER_MD,
    )
    const view = render(<PreviewPanel />)
    await flushAsync(20)

    // 在编辑区输入改动，挂起 1s 防抖写盘 timer
    mocks.saveText.value = CHAPTER_MD + "\n未落盘改动"
    fireEvent.click(screen.getByTestId("editor-save"))

    // 模拟知识树在防抖窗口内将 CHAPTER_PATH 移至 relocatedPath
    const coordinator = getChapterWriteCoordinator()
    const moveIntent = coordinator.captureIntent("tree-move", CHAPTER_PATH)
    coordinator.noteRelocation(moveIntent, CHAPTER_PATH, relocatedPath)

    // 随后 store 切到新路径
    mocks.state.selectedFile = relocatedPath
    view.rerender(<PreviewPanel />)
    await flushAsync(1150)

    // 防抖与切文件离开刷盘均被拦下，旧路径零写入
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(screen.getByTestId("editor-content").textContent).toContain("已移卷正文。")
    view.unmount()
  })

  it("commitChapter 自身重定位在 listDirectory 挂起前已同步 noteRelocation 与 selectedFile，期间 pagehide 不复活旧路径", async () => {
    const targetPath = "/proj/wiki/chapters/第1章-改名中.md"
    let resolveList!: (nodes: unknown[]) => void
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.listDirectory.mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve }))

    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "改名中" } })
    fireEvent.keyDown(input, { key: "Enter" })

    await waitFor(() => expect(mocks.listDirectory).toHaveBeenCalledTimes(1))
    // 早在 listDirectory 完成之前，selectedFile 与 relocation 状态已同步更新
    expect(mocks.state.selectedFile).toBe(targetPath)
    expect(getChapterWriteCoordinator().wasRelocatedSince(CHAPTER_PATH, 0)).toBe(true)

    window.dispatchEvent(new Event("pagehide"))
    await flushAsync(40)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    expect(mocks.writeFileAtomic.mock.calls[0][0]).toBe(targetPath)

    resolveList([])
    await flushAsync(20)
    cleanup()
  })

  it("ingest_failed 缺 params 时补默认 { message: 'unknown' }，且两处写入均传 message", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.finalChapterSave = {
      projectPath: "/proj",
      filePath: CHAPTER_PATH,
      saving: false,
      phase: "ingest_failed",
      params: undefined,
    }
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    expect(mocks.t).toHaveBeenCalledWith("novel.chapter.ingestFailedRetry", { message: "unknown" })
    cleanup()

    // handleReingest 进入 ingest_failed 时携带 { message }
    const finalMd = CHAPTER_MD.replace("chapter_status: draft", "chapter_status: final")
    mocks.compactToolbar.value = false
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = finalMd
    mocks.state.finalChapterSave = null
    mocks.readFile.mockResolvedValue(finalMd)
    mocks.ingestChapter.mockResolvedValueOnce({ snapshot: null, failReason: "extract_timeout" })
    const second = await renderPanel()
    fireEvent.click(screen.getByText("重新提取记忆"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "ingest_failed",
        params: { message: "extract_timeout" },
      }),
    ))
    second.cleanup()
  })
})

describe("PreviewPanel — U-6v2 去AI味动态导入异常恢复、错字修正与工具栏 a11y", () => {
  it("rewrite/edit 动态导入 de-ai-adapter 失败 → 解除 deAiProcessing 且 saveStatus 展示脱敏摘要", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on("unhandledRejection", onUnhandled)
    try {
      mocks.compactToolbar.value = false
      mocks.state.selectedFile = CHAPTER_PATH
      mocks.state.fileContent = CHAPTER_MD
      mocks.readFile.mockResolvedValue(CHAPTER_MD)
      const { cleanup } = await renderPanel()

      // 1) rewrite 分支动态导入失败（带 URL 与 Bearer 凭据，验证脱敏与摘要回显）
      mocks.deAiAdapterImportError.value = new Error("chunk load failed https://secret.example/a.js Bearer tok-123")
      fireEvent.click(screen.getByText("去AI味"))

      await waitFor(() => expect(errSpy).toHaveBeenCalled())
      const status = screen.getByRole("status")
      expect(status.textContent).toContain("去 AI 味未完成，请检查模型连接后重试。")
      expect(status.textContent).toContain("chunk load failed [url] [redacted]")
      expect(status.textContent).not.toContain("https://secret.example")
      expect(status.textContent).not.toContain("tok-123")
      expect(screen.getByTestId("de-ai-dialog").dataset.processing).toBe("false")
      expect(screen.getByRole("button", { name: "去AI味" })).not.toBeDisabled()

      // 2) 恢复导入打开对话框后，切到 edit 模式再次动态导入失败 → 解除 deAiProcessing 且更新摘要
      mocks.deAiAdapterImportError.value = null
      mocks.streamChat.mockImplementationOnce((_c: unknown, _m: unknown, cb: { onToken: (t: string) => void; onDone: () => void }) => {
        cb.onToken("重写正文")
        cb.onDone()
        return Promise.resolve()
      })
      fireEvent.click(screen.getByText("去AI味"))
      await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.open).toBe("true"))

      errSpy.mockClear()
      mocks.deAiAdapterImportError.value = new Error("edit chunk missing")
      fireEvent.click(screen.getByTestId("de-ai-switch-edit"))
      await waitFor(() => expect(errSpy).toHaveBeenCalled())
      expect(screen.getByRole("status").textContent).toContain("edit chunk missing")
      expect(screen.getByTestId("de-ai-dialog").dataset.processing).toBe("false")
      expect(unhandled).toEqual([])
      cleanup()
    } finally {
      process.off("unhandledRejection", onUnhandled)
      errSpy.mockRestore()
    }
  })

  it("handleDeAiModeChange('detect') 动态导入失败 → 无 unhandled rejection 且更新 saveStatus", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on("unhandledRejection", onUnhandled)
    try {
      mocks.compactToolbar.value = false
      mocks.state.selectedFile = CHAPTER_PATH
      mocks.state.fileContent = CHAPTER_MD
      mocks.readFile.mockResolvedValue(CHAPTER_MD)
      mocks.streamChat.mockImplementationOnce((_c: unknown, _m: unknown, cb: { onToken: (t: string) => void; onDone: () => void }) => {
        cb.onToken("初始重写")
        cb.onDone()
        return Promise.resolve()
      })
      const { cleanup } = await renderPanel()
      fireEvent.click(screen.getByText("去AI味"))
      await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.open).toBe("true"))

      mocks.deAiAdapterImportError.value = new Error("detect chunk offline")
      fireEvent.click(screen.getByTestId("de-ai-switch-detect"))

      await waitFor(() => expect(errSpy).toHaveBeenCalled())
      expect(screen.getByRole("status").textContent).toContain("去 AI 味未完成，请检查模型连接后重试。")
      expect(screen.getByRole("status").textContent).toContain("detect chunk offline")
      expect(screen.getByTestId("de-ai-dialog").dataset.processing).toBe("false")
      await flushAsync(20)
      expect(unhandled).toEqual([])
      cleanup()
    } finally {
      process.off("unhandledRejection", onUnhandled)
      errSpy.mockRestore()
    }
  })

  it("选区去AI味动态导入失败 → 释放 selectionActionPending 且展示错误提示", async () => {
    mocks.compactToolbar.value = false
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()

    mocks.deAiAdapterImportError.value = new Error("selection adapter broken")
    fireEvent.click(screen.getByTestId("editor-selection-deai"))

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("selection adapter broken"))
    expect(screen.queryByRole("button", { name: "取消" })).not.toBeInTheDocument()
    cleanup()
  })

  it("章节工具栏 a11y 与 ingest_no_chapter_number 错字修正", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.finalChapterSave = {
      projectPath: "/proj",
      filePath: CHAPTER_PATH,
      saving: false,
      phase: "ingest_no_chapter_number",
    }
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()

    // 章节标题 input 具备 aria-label="章节标题"，关闭按钮具备 type="button"
    expect(screen.getByRole("textbox", { name: "章节标题" })).toBeInTheDocument()
    const closeBtn = screen.getByRole("button", { name: "关闭预览" })
    expect(closeBtn).toHaveAttribute("type", "button")

    // 错字修正 & i18n 契约键 novel.chapter.ingestNoChapterNumber（非章节2栏）
    const status = screen.getByRole("status")
    expect(status.textContent).toContain("已保存为正式章节，但未识别到有效章号，跳过记忆提取")
    expect(status.textContent).not.toContain("章节2栏")
    cleanup()
  })

  it("R2-U04/U09/U10：排版成功清旧回执、批量单章操作异常有 catch 且忙锁阻断重入", async () => {
    mocks.compactToolbar.value = false
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.finalChapterSave = {
      projectPath: "/proj",
      filePath: CHAPTER_PATH,
      saving: false,
      phase: "saved",
    }
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.writeFileAtomic.mockResolvedValue(undefined)
    const { cleanup } = await renderPanel()

    fireEvent.click(screen.getByText("一键排版"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled())
    expect(mocks.state.clearFinalChapterSaveForPath).toHaveBeenCalledWith(CHAPTER_PATH)

    // 批量去AI味单章接受/拒绝失败时捕获错误并回显
    mocks.acceptDeAiBatchDraft.mockRejectedValueOnce(new Error("accept chapter boom"))
    fireEvent.click(screen.getByTestId("de-ai-batch-accept-1"))
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("accept chapter boom"))

    mocks.rejectDeAiBatchDraft.mockRejectedValueOnce(new Error("reject chapter boom"))
    fireEvent.click(screen.getByTestId("de-ai-batch-reject-1"))
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("reject chapter boom"))
    cleanup()
  })
})
