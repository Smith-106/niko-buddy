// @vitest-environment jsdom
/**
 * ReviewJobStatusStrip — review_job 状态条（纯展示，永不阻塞写入）。
 * 覆盖：无项目/无 job/null model/有 job（含/不含 chapterNumber）/加载失败/refreshKey 重读。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen, waitFor } from "@/test-helpers/component-test-utils"

const wiki = vi.hoisted(() => ({
  state: { project: { id: "p1", name: "Novel", path: "E:/Novel" } as { id: string; name: string; path: string } | null },
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: typeof wiki.state) => unknown) => selector(wiki.state),
}))

const deps = vi.hoisted(() => ({
  loadNovelSessionStatus: vi.fn<(projectPath: string) => Promise<NovelSessionStatus | null>>(async () => null),
  getReviewJobUiModel: vi.fn(),
  formatReviewJobStatusLine: vi.fn(() => "write-review-split line"),
  uiModel: {
    phase: "running" as const,
    chapterNumber: 7,
    statusLine: "status-line",
    phaseLabel: "review:running",
    writeUnblocked: true as const,
    productHardGate: false as const,
    blocksWrite: false as const,
  },
}))

vi.mock("@/lib/novel/novel-session-status", () => ({
  loadNovelSessionStatus: deps.loadNovelSessionStatus,
}))

vi.mock("@/lib/novel/review-job-ui", () => ({
  getReviewJobUiModel: deps.getReviewJobUiModel,
  formatReviewJobStatusLine: deps.formatReviewJobStatusLine,
}))

import { ReviewJobStatusStrip } from "./review-job-status-strip"
import type { NovelSessionStatus } from "@/lib/novel/novel-session-status"

beforeEach(() => {
  vi.clearAllMocks()
  wiki.state.project = { id: "p1", name: "Novel", path: "E:/Novel" }
  deps.loadNovelSessionStatus.mockResolvedValue({ review_job: { phase: "running", chapterNumber: 7 } } as NovelSessionStatus)
  deps.getReviewJobUiModel.mockReturnValue(deps.uiModel)
  deps.formatReviewJobStatusLine.mockReturnValue("status-line-text")
})

afterEach(() => cleanup())

describe("ReviewJobStatusStrip", () => {
  it("renders nothing when no project is open", async () => {
    wiki.state.project = null
    render(<ReviewJobStatusStrip />)
    await waitFor(() => expect(deps.loadNovelSessionStatus).not.toHaveBeenCalled())
    expect(screen.queryByTestId("review-job-status-strip")).not.toBeInTheDocument()
  })

  it("renders nothing when there is no review job (model null)", async () => {
    deps.loadNovelSessionStatus.mockResolvedValue({} as NovelSessionStatus)
    deps.getReviewJobUiModel.mockReturnValue(null)
    render(<ReviewJobStatusStrip />)
    await waitFor(() => expect(deps.loadNovelSessionStatus).toHaveBeenCalledWith("E:/Novel"))
    expect(screen.queryByTestId("review-job-status-strip")).not.toBeInTheDocument()
  })

  it("renders phase label, chapter number and status line", async () => {
    render(<ReviewJobStatusStrip />)
    const strip = await screen.findByTestId("review-job-status-strip")
    expect(strip).toHaveTextContent("review:running")
    expect(strip).toHaveTextContent("ch=7")
    expect(strip).toHaveTextContent("status-line-text")
    expect(strip).toHaveTextContent("write unblocked")
    // 重建的最小 job 对象传给 formatReviewJobStatusLine
    expect(deps.formatReviewJobStatusLine).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: "write-review-split/1.0",
        phase: "running",
        chapterNumber: 7,
        blocksWrite: false,
        productHardGate: false,
      }),
    )
  })

  it("omits the chapter span when chapterNumber is missing", async () => {
    deps.getReviewJobUiModel.mockReturnValue({ ...deps.uiModel, chapterNumber: undefined })
    render(<ReviewJobStatusStrip />)
    const strip = await screen.findByTestId("review-job-status-strip")
    expect(strip).not.toHaveTextContent(/ch=/)
    expect(deps.formatReviewJobStatusLine).toHaveBeenCalledWith(expect.objectContaining({ chapterNumber: undefined }))
  })

  it("passes className to the container", async () => {
    render(<ReviewJobStatusStrip className="custom-strip" />)
    const strip = await screen.findByTestId("review-job-status-strip")
    expect(strip.className).toContain("custom-strip")
  })

  it("renders nothing when loading the status fails", async () => {
    deps.loadNovelSessionStatus.mockRejectedValue(new Error("boom"))
    render(<ReviewJobStatusStrip />)
    await waitFor(() => expect(deps.loadNovelSessionStatus).toHaveBeenCalled())
    expect(screen.queryByTestId("review-job-status-strip")).not.toBeInTheDocument()
  })

  it("re-reads the status when refreshKey changes", async () => {
    const { rerender } = render(<ReviewJobStatusStrip refreshKey={1} />)
    await screen.findByTestId("review-job-status-strip")
    expect(deps.loadNovelSessionStatus).toHaveBeenCalledTimes(1)
    rerender(<ReviewJobStatusStrip refreshKey={2} />)
    await waitFor(() => expect(deps.loadNovelSessionStatus).toHaveBeenCalledTimes(2))
  })

  it("unmounts while loading → cancelled skips setModel (成功路径假分支)", async () => {
    let resolveLoad!: (v: NovelSessionStatus | null) => void
    deps.loadNovelSessionStatus.mockReturnValueOnce(new Promise((res) => { resolveLoad = res }))
    const { unmount } = render(<ReviewJobStatusStrip />)
    await waitFor(() => expect(deps.loadNovelSessionStatus).toHaveBeenCalled())
    unmount()
    resolveLoad({ review_job: { phase: "running" } })
    await new Promise((r) => setTimeout(r, 0))
    expect(deps.getReviewJobUiModel).not.toHaveBeenCalled()
  })

  it("unmounts while loading → cancelled skips setModel in catch (错误路径假分支)", async () => {
    let rejectLoad!: (e: unknown) => void
    deps.loadNovelSessionStatus.mockReturnValueOnce(new Promise((_res, rej) => { rejectLoad = rej }))
    const { unmount } = render(<ReviewJobStatusStrip />)
    await waitFor(() => expect(deps.loadNovelSessionStatus).toHaveBeenCalled())
    unmount()
    rejectLoad(new Error("boom"))
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByTestId("review-job-status-strip")).not.toBeInTheDocument()
  })

  it("does not re-read when refreshKey stays the same", async () => {
    const { rerender } = render(<ReviewJobStatusStrip refreshKey={1} />)
    await screen.findByTestId("review-job-status-strip")
    rerender(<ReviewJobStatusStrip refreshKey={1} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(deps.loadNovelSessionStatus).toHaveBeenCalledTimes(1)
  })
})
