/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { FanficMergeDialog } from "./fanfic-merge-dialog"
import type { BookAnalysisLibraryBook } from "@/lib/novel"
import type { CanonMergeProposal } from "@/lib/novel"

const mocks = vi.hoisted(() => ({
  t: vi.fn((k: string) => k),
  projectPath: "/p/book",
  saveProposal: vi.fn(async () => undefined),
  loadProposal: vi.fn<() => Promise<CanonMergeProposal | null>>(async () => null),
}))

vi.mock("react-i18next", () => ({  initReactI18next: { type: "3rdParty", init: () => {} },  useTranslation: () => ({ t: mocks.t }) }))
vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
      useWikiStore: (selector: (s: { project: { path: string } | null }) => unknown) =>
        selector({ project: { path: mocks.projectPath } }),
    
  }
})
vi.mock("@/lib/novel/fanfic-canon-import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/fanfic-canon-import")>()
  return {
    ...actual,
    saveFanficMergeProposal: mocks.saveProposal,
    loadFanficMergeProposal: mocks.loadProposal,
  }
})

const sourceBook: BookAnalysisLibraryBook = {
  id: "lib-1",
  path: "/lib/book.md",
  metadata: { title: "源书", author: "", sourcePath: "" } as never,
  recognizedCharacters: [],
  characters: [
    { id: "c1", name: "林晚", aliases: ["晚晚"] },
    { id: "c2", name: "新角色", aliases: [] },
  ] as never,
  skills: [],
  styleStatus: "missing",
  boundAurasCount: 0,
  addedAuraCharacterIds: [],
}

describe("FanficMergeDialog", () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => cleanup())

  it("生成合并预览（proposeCanonMerge 接线）：重名→认领新建跳过", async () => {
    render(
      <FanficMergeDialog open onOpenChange={() => undefined} sourceBook={sourceBook} targetNames={["林晚"]} />,
    )
    fireEvent.click(screen.getByText("novel.fanfic.preview"))
    const dlg = screen.getByTestId("fanfic-merge-dialog")
    await waitFor(() => expect(dlg.textContent).toContain("novel.fanfic.previewSummary"))
    await waitFor(() => {
      expect(dlg.textContent).toContain("novel.fanfic.actionBind")
      expect(dlg.textContent).toContain("novel.fanfic.actionCreate")
    })
  })

  it("保存合并草稿（Draft-first）", async () => {
    render(
      <FanficMergeDialog open onOpenChange={() => undefined} sourceBook={sourceBook} targetNames={["林晚"]} />,
    )
    fireEvent.click(screen.getByText("novel.fanfic.preview"))
    await screen.findByText("novel.fanfic.previewSummary")
    fireEvent.click(screen.getByText("novel.fanfic.savePending"))
    await screen.findByText("novel.fanfic.pendingSaved")
    expect(mocks.saveProposal).toHaveBeenCalled()
  })

  it("无源书时优雅降级（预览按钮禁用）", () => {
    render(<FanficMergeDialog open onOpenChange={() => undefined} />)
    expect(screen.getByText("novel.fanfic.title")).toBeTruthy()
    expect(screen.getByText("novel.fanfic.preview").closest("button")?.hasAttribute("disabled")).toBe(true)
  })
})

describe("FanficMergeDialog 覆盖补齐：skip 标签/预览异常/pending 双路径/冲突渲染", () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => cleanup())
  it("源书重名 → skip 标签 + 冲突清单渲染", async () => {
    const dupBook: BookAnalysisLibraryBook = {
      ...sourceBook,
      id: "lib-dup",
      characters: [
        { id: "c1", name: "阿重", aliases: [] },
        { id: "c2", name: "阿重", aliases: [] },
      ] as never,
    }
    render(
      <FanficMergeDialog open onOpenChange={() => undefined} sourceBook={dupBook} targetNames={[]} />,
    )
    fireEvent.click(screen.getByText("novel.fanfic.preview"))
    const dlg = () => screen.getByTestId("fanfic-merge-dialog").textContent ?? ""
    await waitFor(() => expect(dlg()).toMatch(/novel\.fanfic\.actionSkip(?!\w)/))
    // 冲突行（name_collision）带 ⚠ 标记
    expect(dlg()).toContain("无法自动合并")
  })

  it("预览抛错 → previewFailed 提示（不崩）", async () => {
    const evil = { ...sourceBook, id: "lib-evil" }
    Object.defineProperty(evil, "characters", {
      get() { throw new Error("chars gone") },
    })
    render(
      <FanficMergeDialog open onOpenChange={() => undefined} sourceBook={evil as never} targetNames={[]} />,
    )
    fireEvent.click(screen.getByText("novel.fanfic.preview"))
    await waitFor(() => {
      expect(screen.getByTestId("fanfic-merge-dialog").textContent).toContain("chars gone")
    })
    expect(screen.getByTestId("fanfic-merge-dialog").textContent).toContain("novel.fanfic.previewFailed")
  })

  it("加载既有 pending → 提案回填 + pendingLoaded 提示", async () => {
    mocks.loadProposal.mockResolvedValue({
      sourceBookId: "lib-1",
      mode: "canon",
      characters: [{ sourceId: "c9", canonicalName: "旧人", aliases: [], action: "create_new" }],
      conflicts: [],
    })
    render(
      <FanficMergeDialog open onOpenChange={() => undefined} sourceBook={sourceBook} targetNames={[]} />,
    )
    fireEvent.click(screen.getByText("novel.fanfic.loadPending"))
    await waitFor(() => {
      expect(screen.getByTestId("fanfic-merge-dialog").textContent).toContain("novel.fanfic.pendingLoaded")
    })
    expect(screen.getByTestId("fanfic-merge-dialog").textContent).toContain("旧人")
  })

  it("无 pending → noPending 提示（不回填空提案）", async () => {
    mocks.loadProposal.mockResolvedValue(null)
    render(
      <FanficMergeDialog open onOpenChange={() => undefined} sourceBook={sourceBook} targetNames={[]} />,
    )
    fireEvent.click(screen.getByText("novel.fanfic.loadPending"))
    await waitFor(() => {
      expect(screen.getByTestId("fanfic-merge-dialog").textContent).toContain("novel.fanfic.noPending")
    })
  })
})
