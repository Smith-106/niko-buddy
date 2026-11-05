/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { UnpackOutlineDialog } from "./unpack-outline-dialog"

const mocks = vi.hoisted(() => ({
  projectPath: "/mock/project" as string | null,
  listDirectory: vi.fn(async () => []),
  unpackOutlineToChapterFiles: vi.fn(
    async (): Promise<{
      createdCount: number
      skippedCount: number
      createdFiles: string[]
      skippedFiles: string[]
    }> => ({
      createdCount: 2,
      skippedCount: 0,
      createdFiles: ["/mock/project/wiki/chapters/chapter-001.md", "/mock/project/wiki/chapters/chapter-002.md"],
      skippedFiles: [],
    }),
  ),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: (selector: (s: { project: { path: string } | null; setFileTree: (tree: unknown) => void }) => unknown) =>
      selector({
        // projectPath 置 null 模拟「未打开项目」，用于覆盖 handleConfirm 的 project 空守卫
        project: mocks.projectPath ? { path: mocks.projectPath } : null,
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

  it("章节无细纲摘要 → 显示「（无细纲摘要）」占位", () => {
    render(
      <UnpackOutlineDialog
        open={true}
        onOpenChange={vi.fn()}
        outlineContent={"## 第一章 无摘要\n## 第二章 有摘要\n正文内容"}
      />,
    )
    // 第一章紧随下一章标题，其后无正文 → summary 为空字符串
    expect(screen.getByText("（无细纲摘要）")).toBeDefined()
    expect(screen.getByText("正文内容")).toBeDefined()
  })

  it("取消按钮关闭对话框且不铺排", () => {
    const handleOpenChange = vi.fn()
    render(
      <UnpackOutlineDialog
        open={true}
        onOpenChange={handleOpenChange}
        outlineContent={sampleOutline}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "取消" }))
    expect(handleOpenChange).toHaveBeenCalledWith(false)
    expect(mocks.unpackOutlineToChapterFiles).not.toHaveBeenCalled()
  })

  it("勾选「覆盖已存在」后铺排 → unpack 收到 overwriteExisting: true", async () => {
    render(
      <UnpackOutlineDialog
        open={true}
        onOpenChange={vi.fn()}
        outlineContent={sampleOutline}
      />,
    )
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement
    expect(checkbox.checked).toBe(false)
    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(true)

    fireEvent.click(screen.getByRole("button", { name: /确认铺排 2 个章节/ }))
    await waitFor(() => {
      expect(mocks.unpackOutlineToChapterFiles).toHaveBeenCalledWith(
        expect.objectContaining({ overwriteExisting: true }),
      )
    })
  })

  it("刷新文件树失败 → console.warn 但不影响铺排成功流程", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.listDirectory.mockRejectedValueOnce(new Error("tree-boom"))
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

    fireEvent.click(screen.getByRole("button", { name: /确认铺排 2 个章节/ }))
    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith("刷新文件树失败:", expect.any(Error))
    })
    // 文件树刷新失败不阻断：仍提示成功、回调、关闭
    expect(mocks.toastSuccess).toHaveBeenCalledWith("大纲解构完成！成功创建 2 个章节骨架")
    expect(handleSuccess).toHaveBeenCalled()
    expect(handleOpenChange).toHaveBeenCalledWith(false)
    expect(mocks.toastError).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("铺排抛错 → toast.error 带原因，不调 onSuccess、不关闭对话框", async () => {
    mocks.unpackOutlineToChapterFiles.mockRejectedValueOnce(new Error("磁盘已满"))
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

    fireEvent.click(screen.getByRole("button", { name: /确认铺排 2 个章节/ }))
    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith("铺排章节失败：磁盘已满")
    })
    expect(handleSuccess).not.toHaveBeenCalled()
    expect(handleOpenChange).not.toHaveBeenCalledWith(false)
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    // finally 复位：按钮回到可点状态（非加载中）
    expect(screen.getByRole("button", { name: /确认铺排 2 个章节/ })).toBeDefined()
  })

  it("有跳过章节时成功提示包含跳过数量", async () => {
    mocks.unpackOutlineToChapterFiles.mockResolvedValueOnce({
      createdCount: 1,
      skippedCount: 1,
      createdFiles: ["/mock/project/wiki/chapters/chapter-001.md"],
      skippedFiles: ["/mock/project/wiki/chapters/chapter-002.md"],
    })
    render(
      <UnpackOutlineDialog
        open={true}
        onOpenChange={vi.fn()}
        outlineContent={sampleOutline}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /确认铺排 2 个章节/ }))
    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "大纲解构完成！成功创建 1 个章节骨架，跳过 1 个已存在章节",
      )
    })
  })

  it("未打开项目时确认铺排不执行（project 空守卫）", async () => {
    mocks.projectPath = null
    try {
      const handleOpenChange = vi.fn()
      render(
        <UnpackOutlineDialog
          open={true}
          onOpenChange={handleOpenChange}
          outlineContent={sampleOutline}
        />,
      )
      fireEvent.click(screen.getByRole("button", { name: /确认铺排 2 个章节/ }))
      await new Promise((r) => setTimeout(r, 0))
      expect(mocks.unpackOutlineToChapterFiles).not.toHaveBeenCalled()
      expect(mocks.toastSuccess).not.toHaveBeenCalled()
      expect(handleOpenChange).not.toHaveBeenCalled()
    } finally {
      mocks.projectPath = "/mock/project"
    }
  })
})
