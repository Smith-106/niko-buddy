/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@testing-library/react"
import { FanficMergeDialog } from "./fanfic-merge-dialog"
import type { BookAnalysisLibraryBook } from "@/lib/novel/book-analysis/library-state"

const mocks = vi.hoisted(() => ({
  t: vi.fn((k: string) => k),
  projectPath: "/p/book",
  saveProposal: vi.fn(async () => undefined),
  loadProposal: vi.fn(async () => null),
}))

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }) }))
vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: { project: { path: string } | null }) => unknown) =>
    selector({ project: { path: mocks.projectPath } }),
}))
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

  it("生成合并预览（proposeCanonMerge 接线）：重名→bind_existing", async () => {
    render(
      <FanficMergeDialog open onOpenChange={() => undefined} sourceBook={sourceBook} targetNames={["林晚"]} />,
    )
    fireEvent.click(screen.getByText("novel.fanfic.preview"))
    expect((await screen.findAllByText(/bind_existing/)).length).toBeGreaterThan(0)
    expect((await screen.findAllByText(/create_new/)).length).toBeGreaterThan(0)
  })

  it("保存 pending 工件（Draft-first）", async () => {
    render(
      <FanficMergeDialog open onOpenChange={() => undefined} sourceBook={sourceBook} targetNames={["林晚"]} />,
    )
    fireEvent.click(screen.getByText("novel.fanfic.preview"))
    await screen.findAllByText(/bind_existing/)
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
