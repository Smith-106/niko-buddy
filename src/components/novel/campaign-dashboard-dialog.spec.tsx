/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { CampaignDashboardDialog } from "./campaign-dashboard-dialog"
import type { CampaignChapterResult } from "@/lib/novel"

const mocks = vi.hoisted(() => ({
  projectPath: "/mock/project",
  projectNull: false,
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
        status: "ready" as CampaignChapterResult["status"],
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
        status: "ready" as CampaignChapterResult["status"],
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
        project: mocks.projectNull ? null : { path: mocks.projectPath },
        llmConfig: { provider: "mock", model: "gpt-4o" },
        novelConfig: { chapterTargetChars: 2500 },
        setFileTree: vi.fn(),
      }),
  }
})

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    listDirectory: vi.fn(async () => []),
  }
})

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
  afterEach(() => {
    cleanup()
  })

  it("正确渲染战役调度工作台基础配置", async () => {
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)

    expect(screen.getByText(/长程战役调度工作台/)).toBeDefined()
    expect(screen.getByText("启动战役")).toBeDefined()
    expect(screen.getByText("批量验收摄取事实库")).toBeDefined()

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

describe("CampaignDashboardDialog 增补：未覆盖分支收敛", () => {
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
        summary: { allPassed: true, readyCount: 2, failedCount: 0 },
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

  const readyResults = () => [
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

  it("open=false 时不探测章节号（守卫早退）", async () => {
    render(<CampaignDashboardDialog open={false} onOpenChange={vi.fn()} />)
    await new Promise((r) => setTimeout(r, 50))
    expect(mocks.getNextChapterNumber).not.toHaveBeenCalled()
  })

  it("章节号探测返回非正数：不回填起始章节", async () => {
    mocks.getNextChapterNumber.mockResolvedValueOnce(0)
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalledWith("/mock/project")
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.getByText(/长程战役调度工作台/)).toBeDefined()
  })

  it("章节号探测失败：console.error 且面板不受影响", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      mocks.getNextChapterNumber.mockRejectedValueOnce(new Error("ipc 断开"))
      render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
      await waitFor(() => {
        expect(errSpy).toHaveBeenCalledWith(
          "[Campaign] detect next chapter failed:",
          expect.anything(),
        )
      })
      expect(screen.getByText("启动战役")).toBeDefined()
    } finally {
      errSpy.mockRestore()
    }
  })

  it("运行中重复点击启动：第二次直接返回（防重入）", async () => {
    mocks.runAutonomousDraftCampaign.mockImplementationOnce(() => new Promise(() => {}))
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByRole("button", { name: "启动战役" }))
    await waitFor(() => {
      expect(mocks.runAutonomousDraftCampaign).toHaveBeenCalledTimes(1)
    })
    // 终止按钮出现证明正在跑；此时启动按钮已卸载，run 只调过一次
    expect(screen.getByRole("button", { name: "终止战役" })).toBeDefined()
    expect(mocks.runAutonomousDraftCampaign).toHaveBeenCalledTimes(1)
  })

  it("onChapterStart / onProgress 回调驱动进度文案", async () => {
    mocks.runAutonomousDraftCampaign.mockImplementationOnce(async (options: any) => {
      options?.onChapterStart?.(5, 1, 2)
      options?.onProgress?.({ message: "自定义进度：检索世界观" })
      options?.onChapterComplete?.(5, readyResults()[0])
      return {
        projectPath: "/mock/project",
        startChapter: 5,
        endChapter: 5,
        totalChapters: 1,
        completedChapters: 1,
        totalWords: 2600,
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        results: [readyResults()[0]],
        summary: { allPassed: true, readyCount: 1, failedCount: 0 },
      }
    })
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByRole("button", { name: "启动战役" }))
    await waitFor(() => {
      expect(screen.getByText("自定义进度：检索世界观")).toBeDefined()
    })
  })

  it("同章重复完成：原地更新而不是追加第二张卡片", async () => {
    const [r5] = readyResults()
    const updated = { ...r5, title: "第五章 风暴前夕（修订版）" }
    mocks.runAutonomousDraftCampaign.mockImplementationOnce(async (options: any) => {
      options?.onChapterComplete?.(5, r5)
      options?.onChapterComplete?.(5, updated)
      return {
        projectPath: "/mock/project",
        startChapter: 5,
        endChapter: 5,
        totalChapters: 1,
        completedChapters: 1,
        totalWords: 2600,
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        results: [updated],
        summary: { allPassed: true, readyCount: 1, failedCount: 0 },
      }
    })
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByRole("button", { name: "启动战役" }))
    await waitFor(() => {
      expect(screen.getByText("第五章 风暴前夕（修订版）")).toBeDefined()
    })
    expect(screen.queryByText("第五章 风暴前夕", { exact: true })).toBeNull()
  })
})

describe("CampaignDashboardDialog 增补2：巡航 / 中止 / 验收边界", () => {
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
        summary: { allPassed: true, readyCount: 2, failedCount: 0 },
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

  const readyResults = () => [
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
  ]

  it("巡航落盘：autoAccepted 章触发巡航成功文案", async () => {
    const auto = { ...readyResults()[0], autoAccepted: true }
    mocks.runAutonomousDraftCampaign.mockImplementationOnce(async () => ({
      projectPath: "/mock/project",
      startChapter: 5,
      endChapter: 5,
      totalChapters: 1,
      completedChapters: 1,
      totalWords: 2600,
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      results: [auto],
      summary: { allPassed: true, readyCount: 1, failedCount: 0 },
    }))
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByText(/开启全自动巡航推进/))
    fireEvent.click(screen.getByRole("button", { name: "启动战役" }))
    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.stringContaining("全自动巡航完成"))
    })
  })

  it("巡航后刷新文件树失败：warn 但不影响成功文案", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { listDirectory } = await import("@/commands/fs")
    vi.mocked(listDirectory).mockRejectedValueOnce(new Error("ls 失败"))
    try {
      const auto = { ...readyResults()[0], autoAccepted: true }
      mocks.runAutonomousDraftCampaign.mockImplementationOnce(async () => ({
        projectPath: "/mock/project",
        startChapter: 5,
        endChapter: 5,
        totalChapters: 1,
        completedChapters: 1,
        totalWords: 2600,
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        results: [auto],
        summary: { allPassed: true, readyCount: 1, failedCount: 0 },
      }))
      render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
      await waitFor(() => {
        expect(mocks.getNextChapterNumber).toHaveBeenCalled()
      })
      fireEvent.click(screen.getByText(/开启全自动巡航推进/))
      fireEvent.click(screen.getByRole("button", { name: "启动战役" }))
      await waitFor(() => {
        expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.stringContaining("全自动巡航完成"))
      })
      expect(warnSpy).toHaveBeenCalledWith("巡航落盘后刷新文件树异常:", expect.anything())
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("战役抛错：toast.error 带原因", async () => {
    mocks.runAutonomousDraftCampaign.mockRejectedValueOnce(new Error("模型炸了"))
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByRole("button", { name: "启动战役" }))
    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining("模型炸了"))
    })
  })

  it("用户终止战役：abort 后拒绝走 info 通道而非 error", async () => {
    let rejectRun!: (e: Error) => void
    mocks.runAutonomousDraftCampaign.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRun = reject
        }),
    )
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByRole("button", { name: "启动战役" }))
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "终止战役" })).toBeDefined()
    })
    fireEvent.click(screen.getByRole("button", { name: "终止战役" }))
    rejectRun(new Error("aborted"))
    await waitFor(() => {
      expect(mocks.toastInfo).toHaveBeenCalledWith("战役推进已被用户终止")
    })
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it("报告就绪为 0 但面板有就绪卡：验收提示没有可验收章节", async () => {
    const [r5] = readyResults()
    const blocked = { ...r5, status: "blocked" as const }
    mocks.runAutonomousDraftCampaign.mockImplementationOnce(async (options?: any) => {
      options?.onChapterComplete?.(5, r5)
      return {
        projectPath: "/mock/project",
        startChapter: 5,
        endChapter: 5,
        totalChapters: 1,
        completedChapters: 1,
        totalWords: 2600,
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        results: [blocked],
        summary: { allPassed: false, readyCount: 0, failedCount: 0 },
      }
    })
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByRole("button", { name: "启动战役" }))
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /批量验收并落盘 \(1\)/ })).toBeDefined()
    })
    fireEvent.click(screen.getByRole("button", { name: /批量验收并落盘 \(1\)/ }))
    await waitFor(() => {
      expect(mocks.toastInfo).toHaveBeenCalledWith("没有可验收落盘的就绪章节")
    })
    expect(mocks.batchAcceptCampaignDrafts).not.toHaveBeenCalled()
  })

  it("批量验收透传 onProgress：落盘进度文案可观测", async () => {
    mocks.batchAcceptCampaignDrafts.mockImplementationOnce(
      async (_path?: string, _results?: any[], options?: any) => {
        options?.onProgress?.(1, 2, "a/b/c.md")
        return { acceptedCount: 2, ingestedCount: 2, chapterPaths: ["x", "y"] }
      },
    )
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByRole("button", { name: "启动战役" }))
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /批量验收并落盘 \(2\)/ })).toBeDefined()
    })
    fireEvent.click(screen.getByRole("button", { name: /批量验收并落盘 \(2\)/ }))
    await waitFor(() => {
      expect(screen.getByText("正在落盘: 第 1/2 篇 (c.md)")).toBeDefined()
    })
  })

  it("验收后刷新文件树失败：warn 但成功横幅照常", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { listDirectory } = await import("@/commands/fs")
    vi.mocked(listDirectory).mockRejectedValueOnce(new Error("tree 失败"))
    try {
      render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
      await waitFor(() => {
        expect(mocks.getNextChapterNumber).toHaveBeenCalled()
      })
      fireEvent.click(screen.getByRole("button", { name: "启动战役" }))
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /批量验收并落盘 \(2\)/ })).toBeDefined()
      })
      fireEvent.click(screen.getByRole("button", { name: /批量验收并落盘 \(2\)/ }))
      await waitFor(() => {
        expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.stringContaining("批量验收完成"))
      })
      expect(warnSpy).toHaveBeenCalledWith("刷新文件树失败:", expect.anything())
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("批量验收失败：toast.error 带原因", async () => {
    mocks.batchAcceptCampaignDrafts.mockRejectedValueOnce(new Error("落盘 IO 错"))
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByRole("button", { name: "启动战役" }))
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /批量验收并落盘 \(2\)/ })).toBeDefined()
    })
    fireEvent.click(screen.getByRole("button", { name: /批量验收并落盘 \(2\)/ }))
    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining("落盘 IO 错"))
    })
  })
})

describe("CampaignDashboardDialog 增补3：输入 / 开关 / 展开 / 关闭", () => {
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
        summary: { allPassed: true, readyCount: 2, failedCount: 0 },
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

  it("验收中重复点击：第二次直接返回（防重入）", async () => {
    let resolveAccept!: (v: { acceptedCount: number; ingestedCount: number; chapterPaths: string[] }) => void
    mocks.batchAcceptCampaignDrafts.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAccept = resolve as (v: {
            acceptedCount: number
            ingestedCount: number
            chapterPaths: string[]
          }) => void
        }),
    )
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByRole("button", { name: "启动战役" }))
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /批量验收并落盘 \(2\)/ })).toBeDefined()
    })
    const acceptBtn = screen.getByRole("button", { name: /批量验收并落盘 \(2\)/ })
    fireEvent.click(acceptBtn)
    fireEvent.click(acceptBtn)
    expect(mocks.batchAcceptCampaignDrafts).toHaveBeenCalledTimes(1)
    resolveAccept({ acceptedCount: 2, ingestedCount: 2, chapterPaths: [] })
    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.stringContaining("批量验收完成"))
    })
  })

  it("起始章节 / 连写章数输入：改值后空态提示同步", async () => {
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalled()
    })
    const startInput = (await screen.findByDisplayValue("5")) as HTMLInputElement
    fireEvent.change(startInput, { target: { value: "7" } })
    const countInput = screen.getByDisplayValue("3") as HTMLInputElement
    fireEvent.change(countInput, { target: { value: "2" } })
    await waitFor(() => {
      expect(screen.getByText(/第 7 至 8 章/)).toBeDefined()
    })
  })

  it("关闭自动摄取开关：验收透传 autoIngest=false", async () => {
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByText("批量验收摄取事实库"))
    fireEvent.click(screen.getByRole("button", { name: "启动战役" }))
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /批量验收并落盘 \(2\)/ })).toBeDefined()
    })
    fireEvent.click(screen.getByRole("button", { name: /批量验收并落盘 \(2\)/ }))
    await waitFor(() => {
      expect(mocks.batchAcceptCampaignDrafts).toHaveBeenCalledWith(
        "/mock/project",
        expect.anything(),
        expect.objectContaining({ autoIngest: false }),
      )
    })
  })

  it("展开章节详情：正文选段可观测；关闭按钮回传 false", async () => {
    const onOpenChange = vi.fn()
    render(<CampaignDashboardDialog open={true} onOpenChange={onOpenChange} />)
    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByRole("button", { name: "启动战役" }))
    await waitFor(() => {
      expect(screen.getByText("第五章 风暴前夕")).toBeDefined()
    })
    fireEvent.click(screen.getByRole("button", { name: "展开第 5 章详情" }))
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "第 5 章详情" })).toBeDefined()
    })
    expect(screen.getByRole("region", { name: "第 5 章详情" }).textContent).toContain(
      "暴风雨在天边聚集",
    )
    fireEvent.click(screen.getByRole("button", { name: "关闭" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe("CampaignDashboardDialog 增补4：分支缺口收敛（77-branch 冲刺）", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.projectNull = false
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
        summary: { allPassed: true, readyCount: 2, failedCount: 0 },
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

  it("卸载后探测拒绝：cancelled 守卫吞掉迟到错误（L86）", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    let rejectDetect!: (e: Error) => void
    mocks.getNextChapterNumber.mockImplementationOnce(
      () =>
        new Promise<number>((_resolve, reject) => {
          rejectDetect = reject
        }),
    )
    try {
      const { unmount } = render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
      await waitFor(() => {
        expect(mocks.getNextChapterNumber).toHaveBeenCalled()
      })
      unmount()
      rejectDetect(new Error("迟到 IPC"))
      await new Promise((r) => setTimeout(r, 50))
      expect(errSpy).not.toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })

  it("无项目时启动守卫早退：不探测章节号也不调度战役（L95）", async () => {
    mocks.projectNull = true
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
    await new Promise((r) => setTimeout(r, 30))
    expect(mocks.getNextChapterNumber).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "启动战役" }))
    expect(mocks.runAutonomousDraftCampaign).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "启动战役" })).toBeDefined()
  })

  it("项目中途关闭后点验收：守卫早退不落盘（L173）", async () => {
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByRole("button", { name: "启动战役" }))
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /批量验收并落盘 \(2\)/ })).toBeDefined()
    })
    // 模拟用户在结果就绪后关闭了项目：store 读到 null，触发重渲染拿到新闭包
    mocks.toastSuccess.mockClear()
    mocks.projectNull = true
    fireEvent.click(screen.getByRole("button", { name: "展开第 5 章详情" }))
    expect(screen.getByRole("region", { name: "第 5 章详情" })).toBeDefined()
    fireEvent.click(screen.getByRole("button", { name: /批量验收并落盘 \(2\)/ }))
    expect(mocks.batchAcceptCampaignDrafts).not.toHaveBeenCalled()
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })

  it("战役抛错前已有部分完成：验收走 chapterResults 兜底（L174 ?? 右）", async () => {
    const partial = {
      chapterNumber: 5,
      title: "第五章 风暴前夕",
      content: "暴风雨在天边聚集，雷光撕裂黑夜。",
      taskBrief: "起草第5章",
      draftContent: "暴风雨在天边聚集，雷光撕裂黑夜。",
      wordCount: 2600,
      status: "ready" as const,
      reviewResults: [],
      revised: false,
    }
    mocks.runAutonomousDraftCampaign.mockImplementationOnce(async (options: any) => {
      options?.onChapterComplete?.(5, partial)
      throw new Error("第 6 章调度崩了")
    })
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByRole("button", { name: "启动战役" }))
    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining("第 6 章调度崩了"))
    })
    // campaignReport 为 null，但 chapterResults 有 1 章就绪 → 兜底可验收
    const acceptBtn = await screen.findByRole("button", { name: /批量验收并落盘 \(1\)/ })
    fireEvent.click(acceptBtn)
    await waitFor(() => {
      expect(mocks.batchAcceptCampaignDrafts).toHaveBeenCalledWith(
        "/mock/project",
        [partial],
        expect.anything(),
      )
    })
  })

  it("验收零摄取：成功文案不带摄取后缀、横幅无摄取（L203/L373 else）", async () => {
    mocks.batchAcceptCampaignDrafts.mockResolvedValueOnce({
      acceptedCount: 2,
      ingestedCount: 0,
      chapterPaths: ["a", "b"],
    })
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByRole("button", { name: "启动战役" }))
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /批量验收并落盘 \(2\)/ })).toBeDefined()
    })
    fireEvent.click(screen.getByRole("button", { name: /批量验收并落盘 \(2\)/ }))
    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith("批量验收完成！成功落盘 2 个章节")
    })
    expect(screen.getByText("已成功验收落盘 2 章节。")).toBeDefined()
  })

  it("巡航卡片渲染：autoAccepted 章显示巡航落盘徽（L323 cons）", async () => {
    const auto = {
      chapterNumber: 5,
      title: "第五章 风暴前夕",
      content: "暴风雨在天边聚集。",
      taskBrief: "起草第5章",
      draftContent: "暴风雨在天边聚集。",
      wordCount: 1200,
      status: "ready" as const,
      autoAccepted: true,
      reviewResults: [],
      revised: false,
    }
    mocks.runAutonomousDraftCampaign.mockImplementationOnce(async (options: any) => {
      options?.onChapterComplete?.(5, auto)
      return {
        projectPath: "/mock/project",
        startChapter: 5,
        endChapter: 5,
        totalChapters: 1,
        completedChapters: 1,
        totalWords: 1200,
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        results: [auto],
        summary: { allPassed: true, readyCount: 1, failedCount: 0 },
      }
    })
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByRole("button", { name: "启动战役" }))
    await waitFor(() => {
      expect(screen.getByText("巡航落盘")).toBeDefined()
    })
  })

  it("阻断/失败卡片渲染：非就绪章无就绪徽（L327 else / L332 / L337）", async () => {
    const blocked = {
      chapterNumber: 5,
      title: "第五章 卡住",
      content: "内容待定。",
      taskBrief: "起草第5章",
      draftContent: "内容待定。",
      wordCount: 100,
      status: "blocked" as const,
      reviewResults: [],
      revised: false,
    }
    const failed = {
      chapterNumber: 6,
      title: "第六章 崩了",
      content: "内容待定。",
      taskBrief: "起草第6章",
      draftContent: "内容待定。",
      wordCount: 100,
      status: "failed" as const,
      reviewResults: [],
      revised: false,
    }
    mocks.runAutonomousDraftCampaign.mockImplementationOnce(async (options: any) => {
      options?.onChapterComplete?.(5, blocked)
      options?.onChapterComplete?.(6, failed)
      return {
        projectPath: "/mock/project",
        startChapter: 5,
        endChapter: 6,
        totalChapters: 2,
        completedChapters: 2,
        totalWords: 200,
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        results: [blocked, failed],
        summary: { allPassed: false, readyCount: 0, failedCount: 1 },
      }
    })
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByRole("button", { name: "启动战役" }))
    await waitFor(() => {
      expect(screen.getByText("阻断转人工")).toBeDefined()
    })
    expect(screen.getByText("失败")).toBeDefined()
    expect(screen.queryByText("就绪")).toBeNull()
  })

  it("空标题/空正文/超长正文卡片（L314 || 右 / L359 双向）", async () => {
    const empty = {
      chapterNumber: 5,
      title: "",
      content: "",
      taskBrief: "起草第5章",
      draftContent: "",
      wordCount: 0,
      status: "ready" as const,
      reviewResults: [],
      revised: false,
    }
    const longChapter = {
      chapterNumber: 6,
      title: "第六章 长文",
      content: "甲".repeat(600),
      taskBrief: "起草第6章",
      draftContent: "甲".repeat(600),
      wordCount: 600,
      status: "ready" as const,
      reviewResults: [],
      revised: false,
    }
    mocks.runAutonomousDraftCampaign.mockImplementationOnce(async (options: any) => {
      options?.onChapterComplete?.(5, empty)
      options?.onChapterComplete?.(6, longChapter)
      return {
        projectPath: "/mock/project",
        startChapter: 5,
        endChapter: 6,
        totalChapters: 2,
        completedChapters: 2,
        totalWords: 600,
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        results: [empty, longChapter],
        summary: { allPassed: true, readyCount: 2, failedCount: 0 },
      }
    })
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByRole("button", { name: "启动战役" }))
    await waitFor(() => {
      expect(screen.getByText("正文起草")).toBeDefined()
    })
    fireEvent.click(screen.getByRole("button", { name: "展开第 5 章详情" }))
    expect(screen.getByRole("region", { name: "第 5 章详情" }).textContent).toContain("空正文")
    fireEvent.click(screen.getByRole("button", { name: "展开第 6 章详情" }))
    const longText = screen.getByRole("region", { name: "第 6 章详情" }).textContent ?? ""
    expect(longText.endsWith("...")).toBe(true)
  })

  it("已展开章节可收起（L348 cons → null）", async () => {
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByRole("button", { name: "启动战役" }))
    await waitFor(() => {
      expect(screen.getByText("第五章 风暴前夕")).toBeDefined()
    })
    fireEvent.click(screen.getByRole("button", { name: "展开第 5 章详情" }))
    expect(screen.getByRole("region", { name: "第 5 章详情" })).toBeDefined()
    fireEvent.click(screen.getByRole("button", { name: "收起第 5 章详情" }))
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "第 5 章详情" })).toBeNull()
    })
  })

  it("起始章节输入非法时回落到 1（L238 || 右）", async () => {
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalled()
    })
    const startInput = (await screen.findByDisplayValue("5")) as HTMLInputElement
    fireEvent.change(startInput, { target: { value: "" } })
    expect(startInput.value).toBe("1")
    expect(screen.getByText(/第 1 至 3 章/)).toBeDefined()
  })

  it("连写章数输入非法时回落到 1（L250 || 右）", async () => {
    render(<CampaignDashboardDialog open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(mocks.getNextChapterNumber).toHaveBeenCalled()
    })
    const countInput = screen.getByDisplayValue("3") as HTMLInputElement
    fireEvent.change(countInput, { target: { value: "abc" } })
    expect(countInput.value).toBe("1")
    expect(screen.getByText(/第 5 至 5 章/)).toBeDefined()
  })
})

