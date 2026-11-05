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
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

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

/**
 * 错误面与入口守卫（可达路径）：
 * 列草稿失败、草稿脏数据（空章名）、目标探测失败、确认采纳失败，都必须给出人话文案，
 * 且不得把「失败」渲染成「已采纳」；没有项目路径时不得发起任何探测/写盘。
 */
describe("MainControlDraftAdoptBlock 错误面与入口守卫", () => {
  it("没有项目路径：不列草稿，直接呈现空态", async () => {
    render(<MainControlDraftAdoptBlock projectPath="" />)
    expect(await screen.findByTestId("main-control-draft-adopt-empty")).toBeTruthy()
    expect(listChapterDrafts).not.toHaveBeenCalled()
  })

  it("列草稿失败：把原因显示为状态文案（不静默吞错）", async () => {
    listChapterDrafts.mockRejectedValue(new Error("drafts dir gone"))
    render(<MainControlDraftAdoptBlock projectPath="/proj" />)
    const note = await waitFor(() => screen.getByTestId("main-control-draft-adopt-note"))
    expect(note.textContent).toContain("drafts dir gone")
    // 失败不是「没有草稿也行」：不得渲染采纳入口
    expect(screen.queryByTestId("main-control-draft-adopt-draft_1_abc")).toBeNull()
  })

  it("草稿章名为空（脏数据）：采纳失败并说明原因，不进入确认面板、不探测目标", async () => {
    listChapterDrafts.mockResolvedValue([{ ...draftRow, id: "draft_blank", chapterName: "   " }])
    render(<MainControlDraftAdoptBlock projectPath="/proj" />)

    const adoptBtn = await waitFor(() => screen.getByTestId("main-control-draft-adopt-draft_blank"))
    fireEvent.click(adoptBtn)

    const note = await waitFor(() => screen.getByTestId("main-control-draft-adopt-note"))
    expect(note.textContent).toContain("采纳失败")
    // 真实现（formalChapterPathForDraft）给出的原因必须透出，而不是笼统的「失败」
    expect(note.textContent).toContain("草稿没有章节名")
    expect(screen.queryByTestId("main-control-draft-adopt-confirm")).toBeNull()
    expect(fileExists).not.toHaveBeenCalled()
    expect(adoptMainControlDraft).not.toHaveBeenCalled()
  })

  it("目标文件探测失败：按「已存在」保守提示（不误报可安全新建）", async () => {
    fileExists.mockRejectedValue(new Error("eacces"))
    render(<MainControlDraftAdoptBlock projectPath="/proj" />)

    const text = await openConfirmPanel()
    expect(text).toContain("目标文件已存在，继续将覆盖。")
    expect(text).not.toContain("草稿需在草稿区确认后才会写入正式正文")
  })

  it("确认采纳失败：文案带原因，确认面板保留可重试，且不上报活动事件", async () => {
    const onActivityEvent = vi.fn()
    adoptMainControlDraft.mockRejectedValue(new Error("write denied"))
    render(<MainControlDraftAdoptBlock projectPath="/proj" onActivityEvent={onActivityEvent} />)

    await openConfirmPanel()
    fireEvent.click(screen.getByTestId("main-control-draft-adopt-confirm-accept"))

    const note = await waitFor(() => screen.getByTestId("main-control-draft-adopt-note"))
    expect(note.textContent).toContain("采纳失败")
    expect(note.textContent).toContain("write denied")
    // 失败后可重试：确认面板与按钮仍在，且按钮已从 busy 恢复
    expect(screen.getByTestId("main-control-draft-adopt-confirm")).toBeTruthy()
    expect((screen.getByTestId("main-control-draft-adopt-confirm-accept") as HTMLButtonElement).disabled).toBe(false)
    // 没有写盘成功 → 不得伪造 ingest 活动事件
    expect(onActivityEvent).not.toHaveBeenCalled()
  })

  it("草稿加载后项目路径被清空：采纳入口不再解析目标、不探测文件", async () => {
    const { rerender } = render(<MainControlDraftAdoptBlock projectPath="/proj" />)
    await waitFor(() => expect(screen.getByTestId("main-control-draft-adopt-draft_1_abc")).toBeTruthy())

    rerender(<MainControlDraftAdoptBlock projectPath="" />)
    fireEvent.click(screen.getByTestId("main-control-draft-adopt-draft_1_abc"))

    // 没有项目 = 目标路径无从解析：不弹确认面板、不探测文件、不发写盘
    await act(async () => {})
    expect(screen.queryByTestId("main-control-draft-adopt-confirm")).toBeNull()
    expect(fileExists).not.toHaveBeenCalled()
    expect(adoptMainControlDraft).not.toHaveBeenCalled()
    // 行的可见性不变（列表不清空，用户仍能看到有草稿）
    expect(screen.getByTestId("main-control-draft-adopt-draft_1_abc")).toBeTruthy()
  })
})

describe("MainControlDraftAdoptBlock 第二步确认可撤销", () => {
  it("取消确认面板：不写盘，且下次仍可重新展开确认", async () => {
    render(<MainControlDraftAdoptBlock projectPath="/proj" />)
    await openConfirmPanel()

    fireEvent.click(screen.getByTestId("main-control-draft-adopt-confirm-cancel"))
    // 第一步只是解析目标路径：取消后不得有任何写盘
    expect(screen.queryByTestId("main-control-draft-adopt-confirm")).toBeNull()
    expect(adoptMainControlDraft).not.toHaveBeenCalled()

    // 可重入：再次点「采纳」仍能展开确认面板
    const reopened = await openConfirmPanel()
    expect(reopened).toContain(NEW_CHAPTER_PATH)
  })
})

describe("MainControlDraftAdoptBlock 换项目竞态", () => {
  it("旧项目的列草稿失败晚到：不覆盖新项目的状态（cancelled 守卫）", async () => {
    let rejectOld!: (error: unknown) => void
    const oldPending = new Promise<unknown[]>((_, reject) => {
      rejectOld = reject
    })
    listChapterDrafts
      .mockImplementationOnce(() => oldPending)
      .mockResolvedValueOnce([draftRow])

    const { rerender } = render(<MainControlDraftAdoptBlock projectPath="/proj-a" />)
    await waitFor(() => expect(listChapterDrafts).toHaveBeenCalledTimes(1))

    // 换项目：旧请求尚未返回，新请求先成功
    rerender(<MainControlDraftAdoptBlock projectPath="/proj-b" />)
    await waitFor(() => expect(screen.getByTestId("main-control-draft-adopt-draft_1_abc")).toBeTruthy())

    // 旧项目的失败此刻才到达 → 必须被丢弃，不能污染新项目的状态面
    rejectOld(new Error("stale project failure"))
    await act(async () => {})
    expect(screen.queryByTestId("main-control-draft-adopt-note")).toBeNull()
    expect(screen.getByTestId("main-control-draft-adopt-draft_1_abc")).toBeTruthy()
  })
})
