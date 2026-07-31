import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

// mock UI 基础设施，避免 jsdom 下 Radix portal / 事件问题
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: unknown }) => children,
  DialogContent: ({ children }: { children: unknown }) => children,
  DialogHeader: ({ children }: { children: unknown }) => children,
  DialogTitle: ({ children }: { children: unknown }) => children,
  DialogFooter: ({ children }: { children: unknown }) => children,
}))
vi.mock("@/components/ui/button", () => ({
  Button: () => null,
}))

// mock MonacoDiffEditor，捕获透传 props
const mockDiff = vi.fn((_props: Record<string, unknown>) => null)
vi.mock("./monaco-diff-editor", () => ({
  MonacoDiffEditor: (props: Record<string, unknown>) => mockDiff(props),
}))

import { DeAiPreviewDialog } from "./de-ai-preview-dialog"

describe("DeAiPreviewDialog (RPC-2 / TASK-005)", () => {
  beforeEach(() => {
    mockDiff.mockClear()
  })

  it("将 source/candidate 透传给 MonacoDiffEditor（original=source, modified=candidate）", () => {
    renderToStaticMarkup(
      <DeAiPreviewDialog
        open
        sourceContent="原始正文"
        candidateContent="去AI味稿"
        onApply={() => {}}
        onSaveDraft={() => {}}
        onClose={() => {}}
      />,
    )
    expect(mockDiff).toHaveBeenCalledTimes(1)
    const callProps = mockDiff.mock.calls[0][0] as Record<string, unknown>
    expect(callProps.original).toBe("原始正文")
    expect(callProps.modified).toBe("去AI味稿")
  })

  it("保留 onApply / onSaveDraft / onClose props 契约", () => {
    const onApply = vi.fn()
    const onSaveDraft = vi.fn()
    const onClose = vi.fn()
    renderToStaticMarkup(
      <DeAiPreviewDialog
        open
        sourceContent="a"
        candidateContent="b"
        onApply={onApply}
        onSaveDraft={onSaveDraft}
        onClose={onClose}
      />,
    )
    // 契约存在性：组件接受这些 props 不抛错
    expect(onApply).not.toHaveBeenCalled()
  })
})
