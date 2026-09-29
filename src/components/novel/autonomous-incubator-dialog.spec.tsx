/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { AutonomousIncubatorDialog } from "./autonomous-incubator-dialog"

const mocks = vi.hoisted(() => ({
  projectPath: "/mock/project",
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
        project: { path: mocks.projectPath },
        llmConfig: { provider: "mock", apiKey: "key", model: "m" },
        novelConfig: {},
        setFileTree: vi.fn(),
      }),
  }
})

vi.mock("@/commands/fs", () => ({
  listDirectory: mocks.listDirectory,
}))

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
  })

  it("正确渲染对话框标题、输入框与提交按钮", () => {
    render(<AutonomousIncubatorDialog open={true} onOpenChange={vi.fn()} />)

    expect(screen.getByText("全自动小说冷启动孵化器 (Autonomous Novel Incubator)")).toBeTruthy()
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
})
