// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ChapterDraft } from "@/lib/novel"
import { DraftPreviewDiffDialog } from "./draft-preview-diff-dialog"

afterEach(() => cleanup())

const SAMPLE_DRAFT: ChapterDraft = {
  id: "draft_1",
  chapterName: "第1章 雾起",
  content: "第一行新正文\n第二行保持不变\n第三行新增内容",
  createdAt: 1_700_000_000_000,
  status: "draft",
}

describe("DraftPreviewDiffDialog", () => {
  it("preview 模式渲染草稿标题、字数与正文内容", () => {
    const onOpenChange = vi.fn()
    render(
      <DraftPreviewDiffDialog
        open={true}
        onOpenChange={onOpenChange}
        mode="preview"
        draft={SAMPLE_DRAFT}
      />,
    )

    expect(screen.getByTestId("draft-preview-diff-dialog")).toBeTruthy()
    expect(screen.getByTestId("draft-preview-body").textContent).toContain("第一行新正文")
    const closeButtons = screen.getAllByRole("button", { name: "关闭" })
    fireEvent.click(closeButtons[0]!)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("diff 模式经 barrel diffLines 渲染逐行增删对比", () => {
    render(
      <DraftPreviewDiffDialog
        open={true}
        onOpenChange={vi.fn()}
        mode="diff"
        draft={SAMPLE_DRAFT}
        targetPath="/proj/wiki/chapters/chapter-001.md"
        existingContent={"第一行旧正文\n第二行保持不变"}
      />,
    )

    expect(screen.getByTestId("draft-diff-count").textContent).toContain("2")
    expect(screen.getByTestId("draft-diff-line-1").textContent).toContain("- 第一行旧正文")
    expect(screen.getByTestId("draft-diff-line-1").textContent).toContain("+ 第一行新正文")
    expect(screen.getByTestId("draft-diff-line-3").textContent).toContain("+ 第三行新增内容")
  })

  it("diff 模式无差异时展示一致提示；新建文件时展示新建提示；读取报错展示 alert", () => {
    const { rerender } = render(
      <DraftPreviewDiffDialog
        open={true}
        onOpenChange={vi.fn()}
        mode="diff"
        draft={SAMPLE_DRAFT}
        existingContent={SAMPLE_DRAFT.content}
      />,
    )
    expect(screen.getByTestId("draft-diff-no-changes")).toBeTruthy()

    rerender(
      <DraftPreviewDiffDialog
        open={true}
        onOpenChange={vi.fn()}
        mode="diff"
        draft={SAMPLE_DRAFT}
        existingContent={null}
      />,
    )
    expect(screen.getByTestId("draft-diff-new-file")).toBeTruthy()

    rerender(
      <DraftPreviewDiffDialog
        open={true}
        onOpenChange={vi.fn()}
        mode="diff"
        draft={SAMPLE_DRAFT}
        error="读取失败：permission denied"
      />,
    )
    const alert = screen.getByTestId("draft-diff-error")
    expect(alert.getAttribute("role")).toBe("alert")
    expect(alert.textContent).toContain("permission denied")
  })
})
