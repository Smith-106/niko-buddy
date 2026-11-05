/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { AutonomousIncubatorDialog } from "./autonomous-incubator-dialog"

const mocks = vi.hoisted(() => ({
  projectPath: "/mock/project",
  projectOverride: undefined as { path: string } | null | undefined,
  listDirectory: vi.fn(async () => []),
  runEndToEndAutonomousNovelProduction: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: (selector: (s: {
      project: { path: string } | null
      llmConfig: unknown
      novelConfig: unknown
      setFileTree: (tree: unknown) => void
    }) => unknown) =>
      selector({
        project: mocks.projectOverride !== undefined ? mocks.projectOverride : { path: mocks.projectPath },
        llmConfig: { provider: "mock", apiKey: "key", model: "m" },
        novelConfig: {},
        setFileTree: vi.fn(),
      }),
  }
})

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    listDirectory: mocks.listDirectory,
  }
})

vi.mock("@/lib/toast", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    info: mocks.toastInfo,
  },
}))

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    runEndToEndAutonomousNovelProduction: mocks.runEndToEndAutonomousNovelProduction,
  }
})

describe("AutonomousIncubatorDialog (全自动小说冷启动孵化器组件)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.runEndToEndAutonomousNovelProduction.mockResolvedValue({
      incubation: {
        projectPath: "/mock/project",
        title: "赛博纪元",
        genre: "科幻未来",
        soulDoc: "soul",
        worldBlueprint: { version: "1.0", worldType: "科幻", layers: {} },
        characters: [
          { name: "林玄", role: "主角", profile: "p1", filePath: "/mock/wiki/characters/林玄.md" },
          { name: "顾渊", role: "反派", profile: "p2", filePath: "/mock/wiki/characters/顾渊.md" },
        ],
        outlineContent: "outline",
        unpackedSkeletons: {
          totalParsed: 5,
          createdCount: 5,
          skippedCount: 0,
          createdFiles: [],
          chapters: [],
        },
        activeBinding: {
          frameworkId: "fw-1",
          targetChapterCount: 5,
          bindingVersion: "1.0",
          createdAt: "",
          updatedAt: "",
          chapterAllocation: [],
        },
      },
    })
  })

  afterEach(() => {
    cleanup()
    mocks.projectOverride = undefined
  })

  it("正确渲染对话框标题、输入框与提交按钮", () => {
    render(<AutonomousIncubatorDialog open={true} onOpenChange={vi.fn()} />)

    expect(screen.getByText("全自动小说冷启动孵化器")).toBeTruthy()
    expect(screen.getByPlaceholderText(/赛博朋克都市中一名被遗忘的机械记忆修复师/)).toBeTruthy()
    expect(screen.getByText("一键启动全自动孵化")).toBeTruthy()
  })

  it("输入核心创意后点击启动，成功调用 runEndToEndAutonomousNovelProduction 并展示结果卡片", async () => {
    const onOpenChange = vi.fn()
    const onSuccess = vi.fn()

    render(<AutonomousIncubatorDialog open={true} onOpenChange={onOpenChange} onSuccess={onSuccess} />)

    const textarea = screen.getByPlaceholderText(/赛博朋克都市中一名被遗忘的机械记忆修复师/)
    fireEvent.change(textarea, { target: { value: "修真少年偶得神秘古玉逆天改命" } })

    const startBtn = screen.getByText("一键启动全自动孵化")
    fireEvent.click(startBtn)

    await waitFor(() => {
      expect(mocks.runEndToEndAutonomousNovelProduction).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: "/mock/project",
          idea: "修真少年偶得神秘古玉逆天改命",
        }),
      )
    })

    await waitFor(() => {
      expect(screen.getByText("《赛博纪元》全自动孵化大获成功！")).toBeTruthy()
      expect(screen.getByText("完成并开启创作")).toBeTruthy()
    })

    expect(mocks.toastSuccess).toHaveBeenCalled()
    expect(onSuccess).toHaveBeenCalled()
  })

  it("空灵感与空白灵感禁用启动按钮", () => {
    render(<AutonomousIncubatorDialog open={true} onOpenChange={vi.fn()} />)
    const startBtn = screen.getByText("一键启动全自动孵化")
    expect((startBtn as HTMLButtonElement).disabled).toBe(true)
    const textarea = screen.getByPlaceholderText(/赛博朋克都市中一名被遗忘的机械记忆修复师/)
    fireEvent.change(textarea, { target: { value: "   " } })
    expect((screen.getByText("一键启动全自动孵化") as HTMLButtonElement).disabled).toBe(true)
    expect(mocks.runEndToEndAutonomousNovelProduction).not.toHaveBeenCalled()
  })

  it("取消按钮关闭对话框（未运行时）", () => {
    const onOpenChange = vi.fn()
    render(<AutonomousIncubatorDialog open={true} onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByText("取消"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mocks.runEndToEndAutonomousNovelProduction).not.toHaveBeenCalled()
  })

  it("无项目时启动守卫直接返回（不调生产流水线）", () => {
    mocks.projectOverride = null
    render(<AutonomousIncubatorDialog open={true} onOpenChange={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText(/赛博朋克都市中一名被遗忘的机械记忆修复师/), {
      target: { value: "有灵感但无项目" },
    })
    fireEvent.click(screen.getByText("一键启动全自动孵化"))
    expect(mocks.runEndToEndAutonomousNovelProduction).not.toHaveBeenCalled()
  })

  it("可选参数透传：标题/题材/篇幅/巡航开关与章数", async () => {
    render(<AutonomousIncubatorDialog open={true} onOpenChange={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText(/赛博朋克都市中一名被遗忘的机械记忆修复师/), {
      target: { value: "星舰远航" },
    })
    fireEvent.change(screen.getByPlaceholderText("未填写则自动推导"), { target: { value: "星海" } })
    fireEvent.change(screen.getByPlaceholderText(/科幻 \/ 玄幻 \/ 悬疑等/), { target: { value: "科幻" } })
    fireEvent.change(screen.getByDisplayValue("10"), { target: { value: "20" } })
    fireEvent.click(screen.getByText(/孵化后直接启动全自动巡航推进/))
    fireEvent.change(screen.getByDisplayValue("3"), { target: { value: "2" } })
    fireEvent.click(screen.getByText("一键启动全自动孵化"))
    await waitFor(() => {
      expect(mocks.runEndToEndAutonomousNovelProduction).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "星海",
          genre: "科幻",
          targetChapters: 20,
          autoStartCruise: true,
          cruiseChapterCount: 2,
        }),
      )
    })
  })

  it("篇幅与巡航章数输入非法时回退默认值", () => {
    render(<AutonomousIncubatorDialog open={true} onOpenChange={vi.fn()} />)
    const chaptersInput = screen.getByDisplayValue("10")
    fireEvent.change(chaptersInput, { target: { value: "" } })
    expect(screen.getByDisplayValue("10")).toBeTruthy()
    fireEvent.click(screen.getByText(/孵化后直接启动全自动巡航推进/))
    const cruiseInput = screen.getByDisplayValue("3")
    fireEvent.change(cruiseInput, { target: { value: "abc" } })
    expect(screen.getByDisplayValue("3")).toBeTruthy()
  })

  it("启动失败弹 toast.error 且无结果卡片、按钮恢复可用", async () => {
    mocks.runEndToEndAutonomousNovelProduction.mockRejectedValueOnce(new Error("LLM 炸了"))
    render(<AutonomousIncubatorDialog open={true} onOpenChange={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText(/赛博朋克都市中一名被遗忘的机械记忆修复师/), {
      target: { value: "失败用例" },
    })
    fireEvent.click(screen.getByText("一键启动全自动孵化"))
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining("全自动孵化失败")),
    )
    expect(mocks.toastError.mock.calls[0][0] as string).toContain("LLM 炸了")
    expect(screen.queryByText("完成并开启创作")).toBeNull()
    expect((screen.getByText("一键启动全自动孵化") as HTMLButtonElement).disabled).toBe(false)
  })

  it("中止流程：abort 后弹 toast.info", async () => {
    mocks.runEndToEndAutonomousNovelProduction.mockImplementationOnce(
      (opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          )
        }),
    )
    render(<AutonomousIncubatorDialog open={true} onOpenChange={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText(/赛博朋克都市中一名被遗忘的机械记忆修复师/), {
      target: { value: "可中止的长任务" },
    })
    fireEvent.click(screen.getByText("一键启动全自动孵化"))
    expect(await screen.findByText("中止孵化")).toBeTruthy()
    expect(screen.getByText("正在启动全自动孵化引擎...")).toBeTruthy()
    fireEvent.click(screen.getByText("中止孵化"))
    await waitFor(() =>
      expect(mocks.toastInfo).toHaveBeenCalledWith("全自动孵化已被中止"),
    )
    expect((screen.getByText("一键启动全自动孵化") as HTMLButtonElement).disabled).toBe(false)
  })

  it("进度回调驱动阶段显示，完成后展示结果并可关闭重置", async () => {
    let captured: { onProgress: (info: { stage: string; message: string }) => void } | null = null
    let resolveRun!: (v: unknown) => void
    mocks.runEndToEndAutonomousNovelProduction.mockImplementationOnce(
      (opts: { onProgress: (info: { stage: string; message: string }) => void }) => {
        captured = opts
        return new Promise((res) => { resolveRun = res })
      },
    )
    const onOpenChange = vi.fn()
    render(<AutonomousIncubatorDialog open={true} onOpenChange={onOpenChange} />)
    fireEvent.change(screen.getByPlaceholderText(/赛博朋克都市中一名被遗忘的机械记忆修复师/), {
      target: { value: "进度用例" },
    })
    fireEvent.click(screen.getByText("一键启动全自动孵化"))
    expect(await screen.findByText("正在链式自主孵化...")).toBeTruthy()
    await act(async () => {
      captured!.onProgress({ stage: "characters", message: "角色生成中" })
    })
    expect(await screen.findByText("角色生成中")).toBeTruthy()
    await act(async () => {
      resolveRun({
        incubation: {
          projectPath: "/mock/project",
          title: "赛博纪元",
          genre: "科幻未来",
          soulDoc: "soul",
          worldBlueprint: {},
          characters: [{ name: "林玄", role: "主角", profile: "p1", filePath: "/x" }],
          outlineContent: "outline",
          unpackedSkeletons: { totalParsed: 5, createdCount: 5, skippedCount: 0, createdFiles: [], chapters: [] },
          activeBinding: {},
        },
      })
    })
    expect(await screen.findByText("《赛博纪元》全自动孵化大获成功！")).toBeTruthy()
    // 完成按钮关闭并重置为表单态
    fireEvent.click(screen.getByText("完成并开启创作"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(await screen.findByText("一键启动全自动孵化")).toBeTruthy()
  })

  it("战役巡航结果展示战报横幅与巡航 toast", async () => {
    mocks.runEndToEndAutonomousNovelProduction.mockResolvedValueOnce({
      incubation: {
        projectPath: "/mock/project",
        title: "赛博纪元",
        genre: "科幻未来",
        soulDoc: "soul",
        worldBlueprint: {},
        characters: [],
        outlineContent: "outline",
        unpackedSkeletons: { totalParsed: 5, createdCount: 5, skippedCount: 0, createdFiles: [], chapters: [] },
        activeBinding: {},
      },
      campaign: { completedChapters: 3, totalWords: 12000 },
    })
    render(<AutonomousIncubatorDialog open={true} onOpenChange={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText(/赛博朋克都市中一名被遗忘的机械记忆修复师/), {
      target: { value: "巡航用例" },
    })
    fireEvent.click(screen.getByText(/孵化后直接启动全自动巡航推进/))
    fireEvent.click(screen.getByText("一键启动全自动孵化"))
    expect(await screen.findByText(/战役全自动巡航已完成第 1 至 3 章/)).toBeTruthy()
    expect(
      screen.getByText(
        (_content, el) => el?.tagName === "SPAN" && el.textContent === `${(12000).toLocaleString()} 字`,
      ),
    ).toBeTruthy()
    expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.stringContaining("巡航完成"))
  })

  it("文件树刷新失败不影响结果展示（仅 warn）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      mocks.listDirectory.mockRejectedValueOnce(new Error("ls 炸了"))
      render(<AutonomousIncubatorDialog open={true} onOpenChange={vi.fn()} />)
      fireEvent.change(screen.getByPlaceholderText(/赛博朋克都市中一名被遗忘的机械记忆修复师/), {
        target: { value: "刷新失败用例" },
      })
      fireEvent.click(screen.getByText("一键启动全自动孵化"))
      expect(await screen.findByText("《赛博纪元》全自动孵化大获成功！")).toBeTruthy()
      expect(warnSpy).toHaveBeenCalledWith("孵化后刷新文件树失败:", expect.any(Error))
      expect(mocks.toastSuccess).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})
