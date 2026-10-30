// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { cleanup } from "@testing-library/react"
import { render, screen, fireEvent, setupDomGlobals } from "@/test-helpers/component-test-utils"

import type { ReactNode } from "react"

// mock UI 基础设施，避免 jsdom 下 Radix portal / 事件问题
const mockDialog = vi.fn((_props: { onOpenChange?: (next: boolean) => void }) => null)
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, onOpenChange }: { children?: ReactNode; onOpenChange?: (next: boolean) => void }) => {
    mockDialog({ onOpenChange })
    return children
  },
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  DialogFooter: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}))
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled, variant, "data-testid": testId }: {
    children?: ReactNode
    onClick?: () => void
    disabled?: boolean
    variant?: string
    "data-testid"?: string
  }) => (
    <button data-testid={testId} data-variant={variant} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
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
    mockDialog.mockClear()
    setupDomGlobals()
  })

  afterEach(() => {
    cleanup()
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

  it("调用 onOpenChange(false) 时关闭，其他值不关闭", () => {
    const onClose = vi.fn()
    renderToStaticMarkup(
      <DeAiPreviewDialog
        open
        sourceContent="a"
        candidateContent="b"
        onApply={() => {}}
        onSaveDraft={() => {}}
        onClose={onClose}
      />,
    )
    const onOpenChange = mockDialog.mock.calls[0][0].onOpenChange
    onOpenChange?.(true)
    expect(onClose).not.toHaveBeenCalled()
    onOpenChange?.(false)
    expect(onClose).toHaveBeenCalledTimes(1)
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

  it("渲染三模式切换器（detect / rewrite / edit），点击切换触发 onModeChange", () => {
    const onModeChange = vi.fn()
    render(
      <DeAiPreviewDialog
        open
        sourceContent="原文"
        candidateContent="改文"
        mode="rewrite"
        onModeChange={onModeChange}
        onApply={() => {}}
        onSaveDraft={() => {}}
        onClose={() => {}}
      />,
    )

    const detectTab = screen.getByTestId("de-ai-mode-detect")
    const rewriteTab = screen.getByTestId("de-ai-mode-rewrite")
    const editTab = screen.getByTestId("de-ai-mode-edit")

    expect(detectTab).toBeInTheDocument()
    expect(rewriteTab).toBeInTheDocument()
    expect(editTab).toBeInTheDocument()

    expect(rewriteTab).toHaveAttribute("aria-selected", "true")
    expect(detectTab).toHaveAttribute("aria-selected", "false")
    expect(editTab).toHaveAttribute("aria-selected", "false")

    fireEvent.click(detectTab)
    expect(onModeChange).toHaveBeenCalledWith("detect")

    fireEvent.click(editTab)
    expect(onModeChange).toHaveBeenCalledWith("edit")
  })

  it("detect 模式：零写回守卫 — 隐藏另存草稿与替换正文，仅展示关闭与不写回提示", () => {
    const onClose = vi.fn()
    const onApply = vi.fn()
    const onSaveDraft = vi.fn()

    const detectResult = {
      hits: [
        {
          id: "hit-1",
          term: "显而易见",
          category: "总结腔",
          tier: "1A" as const,
          startIndex: 0,
          endIndex: 4,
          suggestion: "删掉",
        },
      ],
      slopPenalty: 3.5,
      slopClass: "warn" as const,
      markedText: "【显而易见】，天色已晚。",
    }

    render(
      <DeAiPreviewDialog
        open
        sourceContent="显而易见，天色已晚。"
        candidateContent=""
        mode="detect"
        detectResult={detectResult}
        onModeChange={() => {}}
        onApply={onApply}
        onSaveDraft={onSaveDraft}
        onClose={onClose}
      />,
    )

    // 不可渲染 apply 与 save draft 按钮
    expect(screen.queryByTestId("de-ai-apply")).toBeNull()
    expect(screen.queryByTestId("de-ai-save-draft")).toBeNull()

    // 渲染关闭按钮并可点击
    const closeBtn = screen.getByTestId("de-ai-close")
    expect(closeBtn).toBeInTheDocument()
    fireEvent.click(closeBtn)
    expect(onClose).toHaveBeenCalledTimes(1)

    // 渲染仅检测模式不修改正文提示
    expect(screen.getByTestId("de-ai-detect-notice")).toBeInTheDocument()

    // 渲染命中词条与标记预览
    expect(screen.getByText("「显而易见」")).toBeInTheDocument()
    expect(screen.getByTestId("de-ai-marked-preview")).toHaveTextContent("【显而易见】，天色已晚。")

    // MonacoDiffEditor 不在 detect 模式渲染
    expect(mockDiff).not.toHaveBeenCalled()
  })

  it("edit 模式：锚点校验失败（ok: false）时禁用替换正文与另存草稿，仍允许取消", () => {
    const onClose = vi.fn()
    const onApply = vi.fn()
    const onSaveDraft = vi.fn()

    const failedEditResult = {
      ok: false as const,
      markdown: "未完全替换的正文",
      applied: [],
      failed: [
        {
          id: "edit-1",
          originalText: "不存在的原文",
          replacementText: "新片段",
          note: "测试",
        },
        {
          id: "edit-2",
          originalText: "重复的原文",
          replacementText: "新片段2",
          note: "测试2",
        },
      ],
    }

    render(
      <DeAiPreviewDialog
        open
        sourceContent="原文"
        candidateContent="未完全替换的正文"
        mode="edit"
        editResult={failedEditResult}
        onModeChange={() => {}}
        onApply={onApply}
        onSaveDraft={onSaveDraft}
        onClose={onClose}
      />,
    )

    const applyBtn = screen.getByTestId("de-ai-apply")
    const saveDraftBtn = screen.getByTestId("de-ai-save-draft")
    const cancelBtn = screen.getByTestId("de-ai-cancel")

    // 校验失败时 apply 与 saveDraft 被禁用
    expect(applyBtn).toBeDisabled()
    expect(saveDraftBtn).toBeDisabled()
    expect(cancelBtn).not.toBeDisabled()

    // 点击取消依然有效
    fireEvent.click(cancelBtn)
    expect(onClose).toHaveBeenCalledTimes(1)

    // 状态提示条提示 2 处冲突
    const statusBanner = screen.getByTestId("de-ai-edit-status")
    expect(statusBanner).toHaveTextContent("2")

    // 依然渲染 Diff 供审阅
    expect(mockDiff).toHaveBeenCalledTimes(1)
  })

  it("edit 模式：锚点校验成功（ok: true）时允许替换正文与另存草稿", () => {
    const onClose = vi.fn()
    const onApply = vi.fn()
    const onSaveDraft = vi.fn()

    const successEditResult = {
      ok: true as const,
      markdown: "替换后的正文",
      applied: [
        {
          edit: {
            id: "edit-1",
            originalText: "AI味句子",
            replacementText: "自然句子",
          },
          backup: {
            itemId: "edit-1",
            targetPath: "",
            evidence: "",
            originalText: "AI味句子",
            replacementText: "自然句子",
            updatedAt: "",
          },
        },
      ],
    }

    render(
      <DeAiPreviewDialog
        open
        sourceContent="原文"
        candidateContent="替换后的正文"
        mode="edit"
        editResult={successEditResult}
        onModeChange={() => {}}
        onApply={onApply}
        onSaveDraft={onSaveDraft}
        onClose={onClose}
      />,
    )

    const applyBtn = screen.getByTestId("de-ai-apply")
    const saveDraftBtn = screen.getByTestId("de-ai-save-draft")

    expect(applyBtn).not.toBeDisabled()
    expect(saveDraftBtn).not.toBeDisabled()

    fireEvent.click(applyBtn)
    expect(onApply).toHaveBeenCalledTimes(1)

    fireEvent.click(saveDraftBtn)
    expect(onSaveDraft).toHaveBeenCalledTimes(1)
  })

  it("processing 为 true 时展示处理中状态且禁用模式切换按钮", () => {
    render(
      <DeAiPreviewDialog
        open
        sourceContent="原文"
        candidateContent=""
        mode="rewrite"
        processing={true}
        onModeChange={() => {}}
        onApply={() => {}}
        onSaveDraft={() => {}}
        onClose={() => {}}
      />,
    )

    expect(screen.getByTestId("de-ai-mode-detect")).toBeDisabled()
    expect(screen.getByTestId("de-ai-mode-rewrite")).toBeDisabled()
    expect(screen.getByTestId("de-ai-mode-edit")).toBeDisabled()
  })
})
