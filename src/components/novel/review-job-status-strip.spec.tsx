// @vitest-environment jsdom
/**
 * ReviewJobStatusStrip — review_job 状态条（纯展示，永不阻塞写入）。
 * 覆盖：无项目/无 job/null model/有 job（含/不含 chapterNumber）/加载失败/refreshKey 重读。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen, waitFor, act } from "@/test-helpers/component-test-utils"

const wiki = vi.hoisted(() => ({
  state: { project: { id: "p1", name: "Novel", path: "E:/Novel" } as { id: string; name: string; path: string } | null },
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
      useWikiStore: (selector: (s: typeof wiki.state) => unknown) => selector(wiki.state),
    
  }
})

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

vi.mock("@/lib/novel/novel-session-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/novel-session-status")>()
  return {
    ...actual,
      loadNovelSessionStatus: deps.loadNovelSessionStatus,
    
  }
})

vi.mock("@/lib/novel/review-job-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/review-job-ui")>()
  return {
    ...actual,
      getReviewJobUiModel: deps.getReviewJobUiModel,
      formatReviewJobStatusLine: deps.formatReviewJobStatusLine,
    
  }
})

import { ReviewJobStatusStrip } from "./review-job-status-strip"
import type { NovelSessionStatus } from "@/lib/novel"

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
    resolveLoad({ review_job: { phase: "running", schemaVersion: "write-review-split/1.0", blocksWrite: false, productHardGate: false } } as NovelSessionStatus)
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

  it("running 时每 2000ms 轮询 status.json 并刷新显示；单次轮询失败不清空已有状态", async () => {
    vi.useFakeTimers()
    try {
      render(<ReviewJobStatusStrip />)
      // 首轮加载（微任务）
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(deps.loadNovelSessionStatus).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId("review-job-status-strip")).toHaveTextContent("ch=7")

      // 第二轮：状态推进 → chapterNumber 变 9
      deps.getReviewJobUiModel.mockReturnValue({ ...deps.uiModel, chapterNumber: 9 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(deps.loadNovelSessionStatus).toHaveBeenCalledTimes(2)
      expect(screen.getByTestId("review-job-status-strip")).toHaveTextContent("ch=9")

      // 第三轮：轮询抛错 → catch 不 setModel，旧状态保留
      deps.loadNovelSessionStatus.mockRejectedValueOnce(new Error("poll-boom"))
      deps.getReviewJobUiModel.mockReturnValue(null)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(deps.loadNovelSessionStatus).toHaveBeenCalledTimes(3)
      expect(screen.getByTestId("review-job-status-strip")).toHaveTextContent("ch=9")

      // 下一轮成功继续生效（轮询未被失败阻断）
      deps.getReviewJobUiModel.mockReturnValue({ ...deps.uiModel, chapterNumber: 11 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(deps.loadNovelSessionStatus).toHaveBeenCalledTimes(4)
      expect(screen.getByTestId("review-job-status-strip")).toHaveTextContent("ch=11")
    } finally {
      vi.useRealTimers()
    }
  })

  it("非 running 阶段不启动轮询", async () => {
    deps.getReviewJobUiModel.mockReturnValue({ ...deps.uiModel, phase: "done" })
    vi.useFakeTimers()
    try {
      render(<ReviewJobStatusStrip />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(deps.loadNovelSessionStatus).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId("review-job-status-strip")).toHaveTextContent("审稿完成")
      // 推进 6 秒仍无额外读取
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000)
      })
      expect(deps.loadNovelSessionStatus).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("未知 phase → 回退显示「审稿」", async () => {
    deps.getReviewJobUiModel.mockReturnValue({ ...deps.uiModel, phase: "paused" as never })
    render(<ReviewJobStatusStrip />)
    const strip = await screen.findByTestId("review-job-status-strip")
    // PHASE_PLAIN 无 paused 条目 → ?? 回退文案
    expect(strip).toHaveTextContent("审稿")
    expect(strip).not.toHaveTextContent("审稿进行中")
  })

  it("轮询读取进行中卸载 → cancelled 守卫生效，不再 setModel", async () => {
    vi.useFakeTimers()
    try {
      const { unmount } = render(<ReviewJobStatusStrip />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(deps.getReviewJobUiModel).toHaveBeenCalledTimes(1)

      let resolvePoll!: (v: NovelSessionStatus | null) => void
      deps.loadNovelSessionStatus.mockReturnValueOnce(
        new Promise((res) => {
          resolvePoll = res
        }),
      )
      // 2000ms 后 interval 触发，读取挂起
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(deps.loadNovelSessionStatus).toHaveBeenCalledTimes(2)
      expect(deps.getReviewJobUiModel).toHaveBeenCalledTimes(1)

      unmount()
      await act(async () => {
        resolvePoll({ review_job: { phase: "running" } } as unknown as NovelSessionStatus)
        await vi.advanceTimersByTimeAsync(0)
      })
      // cancelled → return，不刷新模型；报错也不落定
      expect(deps.getReviewJobUiModel).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
