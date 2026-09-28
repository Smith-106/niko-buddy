/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { CampaignDashboardDialog } from "./campaign-dashboard-dialog"

const mocks = vi.hoisted(() => ({
  projectPath: "/mock/project",
  getNextChapterNumber: vi.fn(async (_path?: string) => 5),
  runAutonomousDraftCampaign: vi.fn(async (_options?: any) => ({
    projectPath: "/mock/project",
    startChapter: 5,
    endChapter: 6,
    totalChapters: 2,
    completedChapters: 2,
    totalWords: 5200,
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
    results: [
      {
        chapterNumber: 5,
        title: "第五章 风暴前夕",
        content: "暴风雨在天边聚集，雷光撕裂黑夜。",
        taskBrief: "起草第5章",
        draftContent: "暴风雨在天边聚集，雷光撕裂黑夜。",
        wordCount: 2600,
        status: "ready" as const,
        reviewResults: [],
        revised: false,
      },
      {
        chapterNumber: 6,
        title: "第六章 破晓之战",
        content: "曙光初现，战鼓雷鸣。",
        taskBrief: "起草第6章",
        draftContent: "曙光初现，战鼓雷鸣。",
        wordCount: 2600,
        status: "ready" as const,
        reviewResults: [],
        revised: false,
      },
    ],
    summary: {
      allPassed: true,
      readyCount: 2,
      failedCount: 0,
    },
  })),
  batchAcceptCampaignDrafts: vi.fn(async (_path?: string, _results?: any[], _options?: any) => ({
    acceptedCount: 2,
    ingestedCount: 2,
    chapterPaths: ["/mock/project/wiki/chapters/chapter-005.md", "/mock/project/wiki/chapters/chapter-006.md"],
  })),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: (selector: (s: unknown) => unknown) =>
      selector({
        project: { path: mocks.projectPath },
        llmConfig: { provider: "mock", model: "gpt-4o" },
        novelConfig: { chapterTargetChars: 2500 },
        setFileTree: vi.fn(),
      }),
  }
})

vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(async () => []),
}))

vi.mock("@/lib/toast", () => ({
  toast: {
    success: mocks.toastSuccess,
    info: mocks.toastInfo,
    error: mocks.toastError,
  },
}))

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    getNextChapterNumber: mocks.getNextChapterNumber,
    runAutonomousDraftCampaign: mocks.runAutonomousDraftCampaign,
    batchAcceptCampaignDrafts: mocks.batchAcceptCampaignDrafts,
  }
})

describe("CampaignDashboardDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getNextChapterNumber.mockResolvedValue(5)
    mocks.runAutonomousDraftCampaign.mockImplementation(async (options: any) => {
      const results = [
        {
          chapterNumber: 5,
          title: "第五章 风暴前夕",
          content: "暴风雨在天边聚集，雷光撕裂黑夜。",
          taskBrief: "起草第5章",
          draftContent: "暴风雨在天边聚集，雷光撕裂黑夜。",
          wordCount: 2600,
          status: "ready" as const,
          reviewResults: [],
          revised: false,
        },
        {
          chapterNumber: 6,
          title: "第六章 破晓之战",
          content: "曙光初现，战鼓雷鸣。",
          taskBrief: "起草第6章",
          draftContent: "曙光初现，战鼓雷鸣。",
          wordCount: 2600,
          status: "ready" as const,
          reviewResults: [],
          revised: false,
        },
      ]
      options?.onChapterComplete?.(5, results[0])
      options?.onChapterComplete?.(6, results[1])
      return {
        projectPath: "/mock/project",
        startChapter: 5,
        endChapter: 6,
        totalChapters: 2,
        completedChapters: 2,
        totalWords: 5200,
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        results,
        summary: {
          allPassed: true,
          readyCount: 2,
          failedCount: 0,
        },
      }
    })
    mocks.batchAcceptCampaignDrafts.mockResolvedValue({
      acceptedCount: 2,
      ingestedCount: 2,
      chapterPaths: ["/mock/project/wiki/chapters/chapter-005.md", "/mock/project/wiki/chapters/chapter-006.md"],
    })
  })
  afterEach(() => {
    cleanup()
  })

  it("正确渲染战役调度工作台基础配置", async () => {
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)

    expect(screen.getByText(/长程战役调度工作台/)).toBeDefined()
    expect(screen.getByText("启动战役")).toBeDefined()
    expect(screen.getByText("验收时自动摄取事实库")).toBeDefined()

    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalledWith("/mock/project")
    })
  })

  it("点击启动战役能够推进批量生成并显示章节结果卡片", async () => {
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalled()
    })

    const startBtn = screen.getByRole("button", { name: "启动战役" })
    fireEvent.click(startBtn)

    await waitFor(() => {
      expect(mocks.runAutonomousDraftCampaign).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: "/mock/project",
          startChapter: 5,
        }),
      )
    })

    await waitFor(() => {
      expect(screen.getByText("第五章 风暴前夕")).toBeDefined()
      expect(screen.getByText("第六章 破晓之战")).toBeDefined()
      expect(screen.getByText(/批量验收并落盘 \(2\)/)).toBeDefined()
    })
  })

  it("支持批量验收就绪章节并原子落盘", async () => {
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalled()
    })

    // 先启动生成结果
    fireEvent.click(screen.getByRole("button", { name: "启动战役" }))

    await waitFor(() => {
      expect(screen.getByText(/批量验收并落盘 \(2\)/)).toBeDefined()
    })

    const acceptBtn = screen.getByRole("button", { name: /批量验收并落盘 \(2\)/ })
    fireEvent.click(acceptBtn)

    await waitFor(() => {
      expect(mocks.batchAcceptCampaignDrafts).toHaveBeenCalled()
      expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.stringContaining("批量验收完成"))
    })
  })
})
