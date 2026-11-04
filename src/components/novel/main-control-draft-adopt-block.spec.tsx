/**
 * main-control-draft-adopt-block.spec — 主控采纳块的 selectedFile 透传（F16，jsdom）。
 *
 * 覆盖：
 * 1. selectedFile 与草稿同名 ⇒ 确认面板复用当前打开的文件（不新建同名新章）；
 * 2. selectedFile 为空 ⇒ 走 wiki/chapters 新建路径；
 * 3. selectedFile 异名 ⇒ 不误复用，仍新建 wiki/chapters 路径；
 * 4. 回归点：主控视图把 store.selectedFile 真的传进采纳块（此前恒 null ⇒ 分支不可达）。
 *
 * 路径解析用真实现（`resolveMainControlDraftTarget` → `formalChapterPathForDraft`），
 * 只把副作用边界（列草稿 / 采纳通道 / 文件探测）换成 mock，断言的是真语义。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

const fileExists = vi.fn(async (_path: string) => false)
const listChapterDrafts = vi.fn(async (): Promise<unknown[]> => [])
const adoptMainControlDraft = vi.fn()
const runMainControlAgent = vi.fn()
const resolveWikiPath = vi.fn(async () => "/proj/wiki")
const saveTraceSnapshot = vi.fn(async (_projectPath: string, _snapshot: unknown) => true)
const rerunMainControlGates = vi.fn()

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, fileExists }
})

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    listChapterDrafts,
    adoptMainControlDraft,
    runMainControlAgent,
    resolveWikiPath,
    saveTraceSnapshot,
    rerunMainControlGates,
  }
})

// 真实设置块由 main-control-settings-block.spec.tsx 覆盖
// （避免 ChatModelSelector 读 providerConfigs 在 jsdom 抛错）。
vi.mock("./main-control-settings-block", () => ({
  MainControlSettingsBlock: () => <div data-testid="main-control-settings" />,
}))

const wikiState = vi.hoisted(() => ({
  project: { id: "p1", path: "/proj" } as { id: string; path: string } | null,
  selectedFile: null as string | null,
  llmConfig: { provider: "openai", model: "gpt-test", apiKey: "k", baseUrl: "" },
  aiWorkflowMode: "standard" as "fast" | "standard" | "strict",
  novelMode: true,
  dataVersion: 1,
  novelConfig: {
    stageJournalEnabled: true as boolean | undefined,
    journalTtlMs: 3_600_000,
    chapterTargetChars: 3000,
    preWriteGateMode: "warn" as "warn" | "block" | undefined,
    reviewModel: "",
    sceneBreakdownEnabled: false,
    literaryPolishAfterGate: false,
    autoIngestOnSave: false,
  },
  setActiveView: vi.fn(),
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  const state = {
    get project() {
      return wikiState.project
    },
    get selectedFile() {
      return wikiState.selectedFile
    },
    llmConfig: wikiState.llmConfig,
    get aiWorkflowMode() {
      return wikiState.aiWorkflowMode
    },
    get novelMode() {
      return wikiState.novelMode
    },
    get novelConfig() {
      return wikiState.novelConfig
    },
    get dataVersion() {
      return wikiState.dataVersion
    },
    get setActiveView() {
      return wikiState.setActiveView
    },
  }
  const useWikiStore = <T,>(selector: (s: typeof state) => T) => selector(state)
  return { ...actual, useWikiStore }
})

const { MainControlDraftAdoptBlock } = await import("./main-control-draft-adopt-block")
const { MainControlView } = await import("./main-control-view")

/** 草稿名与「当前打开的章」同名（复用分支的命中条件）。 */
const draftRow = { id: "draft_1_abc", chapterName: "第3章 旧梦", content: "正文", createdAt: 1, status: "draft" }
const CHAPTER_FILE = "/proj/wiki/volumes/第3章 旧梦.md"
const NEW_CHAPTER_PATH = "/proj/wiki/chapters/第3章 旧梦.md"

beforeEach(() => {
  fileExists.mockClear()
  fileExists.mockResolvedValue(false)
  listChapterDrafts.mockReset()
  listChapterDrafts.mockResolvedValue([draftRow])
  adoptMainControlDraft.mockReset()
  adoptMainControlDraft.mockResolvedValue({ formalChapterPath: NEW_CHAPTER_PATH, ingest: "skipped-config" })
  runMainControlAgent.mockReset()
  saveTraceSnapshot.mockReset()
  saveTraceSnapshot.mockResolvedValue(true)
  rerunMainControlGates.mockReset()
  wikiState.selectedFile = null
})

afterEach(() => {
  cleanup()
})

/** 展开第一步确认面板（只解析目标路径，不写盘）。 */
async function openConfirmPanel(): Promise<string> {
  await waitFor(() => expect(screen.getByTestId("main-control-draft-adopt-draft_1_abc")).toBeTruthy())
  fireEvent.click(screen.getByTestId("main-control-draft-adopt-draft_1_abc"))
  await waitFor(() => expect(screen.getByTestId("main-control-draft-adopt-confirm")).toBeTruthy())
  return screen.getByTestId("main-control-draft-adopt-confirm").textContent ?? ""
}

describe("MainControlDraftAdoptBlock selectedFile（F16）", () => {
  it("selectedFile 与草稿同名：复用当前文件路径，确认采纳也带同一个 selectedFile", async () => {
    render(<MainControlDraftAdoptBlock projectPath="/proj" selectedFile={CHAPTER_FILE} />)
    const text = await openConfirmPanel()
    // 复用：目标就是当前打开的章，而不是 wiki/chapters 下另建一个同名文件。
    expect(text).toContain(CHAPTER_FILE)
    expect(text).not.toContain(NEW_CHAPTER_PATH)

    fireEvent.click(screen.getByTestId("main-control-draft-adopt-confirm-accept"))
    await waitFor(() => expect(adoptMainControlDraft).toHaveBeenCalledTimes(1))
    expect(adoptMainControlDraft).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: "draft_1_abc", chapterName: "第3章 旧梦", confirmed: true, selectedFile: CHAPTER_FILE }),
    )
  })

  it("selectedFile 为空：落到 wiki/chapters 新建路径", async () => {
    render(<MainControlDraftAdoptBlock projectPath="/proj" selectedFile={null} />)
    const text = await openConfirmPanel()
    expect(text).toContain(NEW_CHAPTER_PATH)

    fireEvent.click(screen.getByTestId("main-control-draft-adopt-confirm-accept"))
    await waitFor(() => expect(adoptMainControlDraft).toHaveBeenCalledTimes(1))
    expect(adoptMainControlDraft).toHaveBeenCalledWith(
      expect.objectContaining({ selectedFile: null, confirmed: true }),
    )
  })

  it("selectedFile 异名：不误复用当前文件，仍新建同名章", async () => {
    render(<MainControlDraftAdoptBlock projectPath="/proj" selectedFile="/proj/wiki/chapters/第9章 别梦.md" />)
    const text = await openConfirmPanel()
    expect(text).toContain(NEW_CHAPTER_PATH)
    expect(text).not.toContain("第9章 别梦")
  })
})

/**
 * 回归点：缺陷在入口（主控视图没传 prop），采纳块自身逻辑本来就是对的，
 * 所以必须渲染 MainControlView 才能守住这条路径。
 */
describe("MainControlView → 采纳块 selectedFile 透传（F16 回归）", () => {
  it("store.selectedFile 为当前章时，主控 drafts 页签的确认面板复用它", async () => {
    wikiState.selectedFile = CHAPTER_FILE
    render(<MainControlView />)
    fireEvent.click(screen.getByTestId("main-control-tab-drafts"))
    const text = await openConfirmPanel()
    expect(text).toContain(CHAPTER_FILE)
    expect(text).not.toContain(NEW_CHAPTER_PATH)
  })

  it("store.selectedFile 为空时，主控 drafts 页签仍走新建路径", async () => {
    wikiState.selectedFile = null
    render(<MainControlView />)
    fireEvent.click(screen.getByTestId("main-control-tab-drafts"))
    const text = await openConfirmPanel()
    expect(text).toContain(NEW_CHAPTER_PATH)
  })
})
