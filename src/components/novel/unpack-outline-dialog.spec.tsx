/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { UnpackOutlineDialog } from "./unpack-outline-dialog"

const mocks = vi.hoisted(() => ({
  projectPath: "/mock/project",
  listDirectory: vi.fn(async () => []),
  unpackOutlineToChapterFiles: vi.fn(async () => ({
    createdCount: 2,
    skippedCount: 0,
    createdFiles: ["/mock/project/wiki/chapters/chapter-001.md", "/mock/project/wiki/chapters/chapter-002.md"],
    skippedFiles: [],
  })),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: (selector: (s: { project: { path: string } | null; setFileTree: (tree: unknown) => void }) => unknown) =>
      selector({
        project: { path: mocks.projectPath },
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
    info: vi.fn(),
  },
}))

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    unpackOutlineToChapterFiles: mocks.unpackOutlineToChapterFiles,
  }
})

describe("UnpackOutlineDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    cleanup()
  })

  const sampleOutline = `
# 大纲

## 第一章 觉醒之刻
主角在雨夜醒来，获得了神秘代码。

## 第二章 暗流涌动
调查员来到公寓，气氛紧张。
`

  it("正确识别并渲染大纲章节列表", () => {
    render(
      <UnpackOutlineDialog
        open={true}
        onOpenChange={vi.fn()}
        outlineContent={sampleOutline}
      />,
    )

    expect(screen.getByText("大纲自动解构分发器")).toBeDefined()
    expect(screen.getByText(/第 1 章 · 觉醒之刻/)).toBeDefined()
    expect(screen.getByText(/第 2 章 · 暗流涌动/)).toBeDefined()
    expect(screen.getByText("chapter-001.md")).toBeDefined()
    expect(screen.getByText("chapter-002.md")).toBeDefined()
  })

  it("点击一键铺排后调用解构函数并触发回调", async () => {
    const handleSuccess = vi.fn()
    const handleOpenChange = vi.fn()

    render(
      <UnpackOutlineDialog
        open={true}
        onOpenChange={handleOpenChange}
        outlineContent={sampleOutline}
        onSuccess={handleSuccess}
      />,
    )

    const submitBtn = screen.getByRole("button", { name: /确认铺排 2 个章节/ })
    expect(submitBtn).toBeDefined()
    fireEvent.click(submitBtn)

    await waitFor(() => {
      expect(mocks.unpackOutlineToChapterFiles).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: "/mock/project",
          outlineContent: sampleOutline,
          overwriteExisting: false,
        }),
      )
      expect(mocks.toastSuccess).toHaveBeenCalled()
      expect(handleSuccess).toHaveBeenCalled()
      expect(handleOpenChange).toHaveBeenCalledWith(false)
    })
  })

  it("当无章节时显示空状态提示且禁用提交按钮", () => {
    render(
      <UnpackOutlineDialog
        open={true}
        onOpenChange={vi.fn()}
        outlineContent="这是一段没有章节标题的大纲描述"
      />,
    )

    expect(screen.getByText("未能在大纲中识别出章节标题")).toBeDefined()
    const submitBtn = screen.getByRole("button", { name: /确认铺排 0 个章节/ })
    expect((submitBtn as HTMLButtonElement).disabled).toBe(true)
  })
})
