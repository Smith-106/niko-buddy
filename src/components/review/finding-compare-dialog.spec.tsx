// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import { FindingCompareDialog, type FindingCompareDialogProps } from "./finding-compare-dialog"
import type { NovelReviewActionItem } from "@/lib/novel-review-action-items"

const mocks = vi.hoisted(() => {
  let resolveGenerate: ((eds: unknown[]) => void) | null = null
  let rejectGenerate: ((err: unknown) => void) | null = null
  return {
    generateReviewRewriteEdits: vi.fn(),
    applyReviewRewriteEditsToMarkdown: vi.fn(),
    writeFindingRewriteDraft: vi.fn(async () => {}),
    acceptFindingRewriteDraft: vi.fn(async () => {}),
    rejectFindingRewriteDraft: vi.fn(async () => {}),
    reviewChapter: vi.fn(),
    t: vi.fn((key: string) => key),
    resolveGenerate,
    rejectGenerate,
  }
})

vi.mock("@/lib/review-rewrite-plan", () => ({
  generateReviewRewriteEdits: mocks.generateReviewRewriteEdits,
  applyReviewRewriteEditsToMarkdown: mocks.applyReviewRewriteEditsToMarkdown,
}))

vi.mock("@/lib/novel/novel-session-status", () => ({
  writeFindingRewriteDraft: mocks.writeFindingRewriteDraft,
  acceptFindingRewriteDraft: mocks.acceptFindingRewriteDraft,
  rejectFindingRewriteDraft: mocks.rejectFindingRewriteDraft,
}))

vi.mock("@/lib/novel/review-adapter", () => ({
  reviewChapter: mocks.reviewChapter,
}))

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children, onOpenChange }: any) => (
    <div data-testid="dialog" data-open={String(open)}>
      {open ? children : null}
      <button type="button" data-testid="dialog-open" onClick={() => onOpenChange(true)}>
        open-change-true
      </button>
      <button type="button" data-testid="dialog-close" onClick={() => onOpenChange(false)}>
        open-change-false
      </button>
    </div>
  ),
  DialogContent: ({ children }: any) => <div data-testid="dialog-content">{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
}))

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled, variant }: any) => (
    <button type="button" onClick={onClick} disabled={disabled} data-variant={variant}>
      {children}
    </button>
  ),
}))

vi.mock("@/components/novel/monaco-diff-editor", () => ({
  MonacoDiffEditor: ({ original, modified, onModifiedChange }: any) => (
    <div>
      <span data-testid="diff-original">{original}</span>
      <span data-testid="diff-modified">{modified}</span>
      <button type="button" data-testid="diff-modify" onClick={() => onModifiedChange("新改写文本")}>
        modify
      </button>
    </div>
  ),
}))

const FINDING: NovelReviewActionItem = {
  id: "f1",
  severity: "high",
  reviewSeverity: "error",
  source: "review",
  message: "证据不一致",
  detail: "细节",
  evidence: "原文片段甲",
  secondaryEvidence: "次要证据",
  suggestion: "建议改法",
  targetPath: "chapters/ch1.md",
}

const EDITS = [
  { id: "e1", originalText: "原文片段甲", replacementText: "替换文本乙" },
  { id: "e2", originalText: "第二段原文", replacementText: "第二段替换" },
]

const CHAPTER = "## 第一章\n\n原文片段甲与第二段原文都在这。\n"

function baseProps(): FindingCompareDialogProps {
  return {
    open: true,
    finding: FINDING,
    chapterContent: CHAPTER,
    llmConfig: { provider: "openai", apiKey: "k", model: "m", ollamaUrl: "" } as never,
    projectPath: "/proj",
    sessionId: "s1",
    onClose: vi.fn(),
    onAccept: vi.fn(),
    onReject: vi.fn(),
  }
}

describe("FindingCompareDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.generateReviewRewriteEdits.mockResolvedValue(EDITS)
    mocks.applyReviewRewriteEditsToMarkdown.mockReturnValue({ markdown: CHAPTER, applied: [], ok: true } as never)
    mocks.reviewChapter.mockResolvedValue([])
    mocks.writeFindingRewriteDraft.mockResolvedValue(undefined)
    mocks.acceptFindingRewriteDraft.mockResolvedValue(undefined)
    mocks.rejectFindingRewriteDraft.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanup()
  })

  it("open=false：不触发生成，对话框内容不渲染", () => {
    render(<FindingCompareDialog {...baseProps()} open={false} />)
    expect(mocks.generateReviewRewriteEdits).not.toHaveBeenCalled()
    expect(screen.getByTestId("dialog")).toHaveAttribute("data-open", "false")
    expect(screen.queryByText("对比改写")).not.toBeInTheDocument()
  })

  it("open=true：生成 loading → 成功写入 pending draft 并展示 diff；Dialog 关闭回调", async () => {
    const onClose = vi.fn()
    const props = baseProps()
    props.onClose = onClose
    render(<FindingCompareDialog {...props} />)

    // 初始 loading
    expect(screen.getByText("生成改写中…")).toBeInTheDocument()

    await waitFor(() => expect(screen.getByTestId("diff-original")).toHaveTextContent("原文片段甲"))
    expect(screen.getByTestId("diff-modified")).toHaveTextContent("替换文本乙")
    expect(mocks.writeFindingRewriteDraft).toHaveBeenCalledWith("/proj", "s1", {
      chapterId: "chapters/ch1.md",
      originalText: "原文片段甲",
      replacementText: "替换文本乙",
      findingId: "f1",
    })

    // Dialog onOpenChange(false) → onClose；onOpenChange(true) → 不触发
    fireEvent.click(screen.getByTestId("dialog-close"))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId("dialog-open"))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("生成 0 条 edits → 显示未定位提示且不写 draft", async () => {
    mocks.generateReviewRewriteEdits.mockResolvedValue([])
    render(<FindingCompareDialog {...baseProps()} />)
    await waitFor(() =>
      expect(screen.getByText("未在正文中定位到证据片段，请手动选择原文后重试")).toBeInTheDocument(),
    )
    expect(mocks.writeFindingRewriteDraft).not.toHaveBeenCalled()
    expect(screen.queryByText("暂无改写建议")).not.toBeInTheDocument()
  })

  it("pending draft 写入失败 → errorMsg（Error 实例）", async () => {
    mocks.writeFindingRewriteDraft.mockRejectedValueOnce(new Error("write-fail"))
    render(<FindingCompareDialog {...baseProps()} />)
    await waitFor(() => expect(screen.getByText("write-fail")).toBeInTheDocument())
  })

  it("生成异常：Error 实例取 message；非 Error 用 String 化", async () => {
    mocks.generateReviewRewriteEdits.mockRejectedValueOnce(new Error("gen-fail"))
    const first = render(<FindingCompareDialog {...baseProps()} />)
    await waitFor(() => expect(screen.getByText("gen-fail")).toBeInTheDocument())
    first.unmount()

    mocks.generateReviewRewriteEdits.mockRejectedValueOnce("raw-fail")
    const second = render(<FindingCompareDialog {...baseProps()} />)
    await waitFor(() => expect(screen.getByText("raw-fail")).toBeInTheDocument())
    second.unmount()
  })

  it("open 后立即关闭：cancelled 丢弃异步结果", async () => {
    let resolveGenerate!: (eds: unknown[]) => void
    mocks.generateReviewRewriteEdits.mockReturnValue(
      new Promise((resolve) => {
        resolveGenerate = resolve
      }),
    )
    const { rerender, unmount } = render(<FindingCompareDialog {...baseProps()} />)
    rerender(<FindingCompareDialog {...baseProps()} open={false} />)
    await act(async () => {
      resolveGenerate(EDITS)
    })
    expect(mocks.writeFindingRewriteDraft).not.toHaveBeenCalled()
    unmount()
  })

  it("生成挂起期间关闭，随后 reject → 外层 catch 的 cancelled 分支直接 return", async () => {
    let rejectGenerate!: (err: unknown) => void
    mocks.generateReviewRewriteEdits.mockReturnValue(
      new Promise((_, reject) => {
        rejectGenerate = reject
      }),
    )
    const { rerender, unmount } = render(<FindingCompareDialog {...baseProps()} />)
    rerender(<FindingCompareDialog {...baseProps()} open={false} />)
    await act(async () => {
      rejectGenerate(new Error("late-gen-fail"))
    })
    // cancelled → 不写入 errorMsg，DOM 无错误文案
    expect(screen.queryByText("late-gen-fail")).not.toBeInTheDocument()
    expect(mocks.writeFindingRewriteDraft).not.toHaveBeenCalled()
    unmount()
  })

  it("draft 写入挂起期间关闭，随后 reject → catch 的 !cancelled 分支跳过", async () => {
    let rejectDraft!: (err: unknown) => void
    mocks.writeFindingRewriteDraft.mockReturnValue(
      new Promise((_, reject) => {
        rejectDraft = reject
      }),
    )
    const { rerender, unmount } = render(<FindingCompareDialog {...baseProps()} />)
    await waitFor(() => expect(screen.getByTestId("diff-original")).toBeInTheDocument())
    rerender(<FindingCompareDialog {...baseProps()} open={false} />)
    await act(async () => {
      rejectDraft(new Error("late-draft-fail"))
    })
    expect(screen.queryByText("late-draft-fail")).not.toBeInTheDocument()
    unmount()
  })

  it("pending draft 写入失败（非 Error）→ String 化错误文案", async () => {
    mocks.writeFindingRewriteDraft.mockRejectedValueOnce("draft-boom")
    render(<FindingCompareDialog {...baseProps()} />)
    await waitFor(() => expect(screen.getByText("draft-boom")).toBeInTheDocument())
  })

  it("取消按钮 → onClose；拒绝按钮 → rejectFindingRewriteDraft + onReject", async () => {
    const props = baseProps()
    render(<FindingCompareDialog {...props} />)
    await waitFor(() => expect(screen.getByTestId("diff-original")).toBeInTheDocument())

    fireEvent.click(screen.getByText("取消"))
    expect(props.onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText("拒绝"))
    await waitFor(() => expect(mocks.rejectFindingRewriteDraft).toHaveBeenCalledWith("/proj", "s1"))
    expect(props.onReject).toHaveBeenCalledTimes(1)
  })

  it("接受：门控通过 → acceptFindingRewriteDraft + onAccept（多 edit 时仅首条替换 modifiedText）", async () => {
    const props = baseProps()
    render(<FindingCompareDialog {...props} />)
    await waitFor(() => expect(screen.getByTestId("diff-original")).toBeInTheDocument())

    // 修改 Monaco 文本 → modifiedText 变化
    fireEvent.click(screen.getByTestId("diff-modify"))

    fireEvent.click(screen.getByText("接受改写"))
    await waitFor(() => expect(mocks.acceptFindingRewriteDraft).toHaveBeenCalledWith("/proj", "s1"))
    expect(props.onAccept).toHaveBeenCalledTimes(1)

    const [chapterArg, finalEdits] = mocks.applyReviewRewriteEditsToMarkdown.mock.calls[0] as unknown as [
      string,
      { replacementText: string }[],
    ]
    expect(chapterArg).toBe(CHAPTER)
    expect(finalEdits[0].replacementText).toBe("新改写文本")
    expect(finalEdits[1].replacementText).toBe("第二段替换")
    expect(mocks.reviewChapter).toHaveBeenCalledWith("/proj", CHAPTER, undefined, {}, undefined)
  })

  it("接受：门控阻断（severity=error）→ 展示阻断列表，不 accept", async () => {
    const props = baseProps()
    mocks.reviewChapter.mockResolvedValue([
      { severity: "error", message: "连续性错误" },
      { severity: "warning", message: "轻度警告" },
    ] as never)
    render(<FindingCompareDialog {...props} />)
    await waitFor(() => expect(screen.getByTestId("diff-original")).toBeInTheDocument())

    fireEvent.click(screen.getByText("接受改写"))
    await waitFor(() => expect(screen.getByText("连续性错误")).toBeInTheDocument())
    expect(screen.queryByText("轻度警告")).not.toBeInTheDocument()
    expect(screen.getByText(/1 个阻断问题/)).toBeInTheDocument()
    expect(mocks.acceptFindingRewriteDraft).not.toHaveBeenCalled()
    expect(props.onAccept).not.toHaveBeenCalled()
  })

  it("接受：reviewChapter 抛错 → errorMsg，不 accept", async () => {
    const props = baseProps()
    mocks.reviewChapter.mockRejectedValue(new Error("gate-fail"))
    render(<FindingCompareDialog {...props} />)
    await waitFor(() => expect(screen.getByTestId("diff-original")).toBeInTheDocument())

    fireEvent.click(screen.getByText("接受改写"))
    await waitFor(() => expect(screen.getByText("gate-fail")).toBeInTheDocument())
    expect(mocks.acceptFindingRewriteDraft).not.toHaveBeenCalled()
    expect(props.onAccept).not.toHaveBeenCalled()
  })

  it("接受：reviewChapter 抛非 Error → String 化错误文案", async () => {
    const props = baseProps()
    mocks.reviewChapter.mockRejectedValue("gate-boom")
    render(<FindingCompareDialog {...props} />)
    await waitFor(() => expect(screen.getByTestId("diff-original")).toBeInTheDocument())

    fireEvent.click(screen.getByText("接受改写"))
    await waitFor(() => expect(screen.getByText("gate-boom")).toBeInTheDocument())
    expect(props.onAccept).not.toHaveBeenCalled()
  })

  it("门控回检进行中：按钮禁用且文案变化", async () => {
    const props = baseProps()
    let resolveReview!: (v: unknown) => void
    mocks.reviewChapter.mockReturnValue(
      new Promise((resolve) => {
        resolveReview = resolve
      }),
    )
    render(<FindingCompareDialog {...props} />)
    await waitFor(() => expect(screen.getByTestId("diff-original")).toBeInTheDocument())

    fireEvent.click(screen.getByText("接受改写"))
    const acceptBtn = screen.getByText("门控回检中…") as HTMLButtonElement
    expect(acceptBtn.disabled).toBe(true)
    await act(async () => {
      resolveReview([])
    })
    await waitFor(() => expect(props.onAccept).toHaveBeenCalledTimes(1))
  })

  it("无 edits 时接受按钮禁用", async () => {
    mocks.generateReviewRewriteEdits.mockResolvedValue([])
    render(<FindingCompareDialog {...baseProps()} />)
    await waitFor(() => expect(screen.getByText("未在正文中定位到证据片段，请手动选择原文后重试")).toBeInTheDocument())
    const acceptBtn = screen.getByText("接受改写") as HTMLButtonElement
    expect(acceptBtn.disabled).toBe(true)
  })

  it("edit 缺 originalText 时 diff 展示空串（源码 ?? 兜底）", async () => {
    mocks.generateReviewRewriteEdits.mockResolvedValue([
      { id: "e1", originalText: undefined as unknown as string, replacementText: "替换文本" },
    ])
    render(<FindingCompareDialog {...baseProps()} />)
    await waitFor(() => expect(screen.getByTestId("diff-original")).toBeInTheDocument())
    expect(screen.getByTestId("diff-original")).toHaveTextContent("")
    expect(screen.getByTestId("diff-modified")).toHaveTextContent("替换文本")
    expect(mocks.writeFindingRewriteDraft).toHaveBeenCalledWith("/proj", "s1", {
      chapterId: "chapters/ch1.md",
      originalText: undefined,
      replacementText: "替换文本",
      findingId: "f1",
    })
  })
})
