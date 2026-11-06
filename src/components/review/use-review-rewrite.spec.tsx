// @vitest-environment jsdom
/**
 * use-review-rewrite.spec.tsx — AI 改写垂直簇的落盘失败路径（此前无专属 spec）。
 *
 * 目标行为：`handleApplyRewrite` 在 `writeFileAtomic` 失败时必须
 *   1) 把错误翻译成可见横幅（formatOperationError = 本地化引导 + 原始诊断），
 *   2) **不**推进数据版本、**不**写 issueState、**不**关闭对话框
 *      （否则编辑器会以为改写已落盘，而磁盘上仍是原文——静默丢改动）。
 *
 * LLM（generateReviewRewriteEdits）与 fs 均 mock；锚点替换走真实
 * applyReviewRewriteEditsToMarkdown（真实实现才能证明「ok 之后才写盘」）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(async () => ""),
  writeFileAtomic: vi.fn(async () => {}),
  generateReviewRewriteEdits: vi.fn(async () => [] as unknown[]),
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFileAtomic: mocks.writeFileAtomic,
}))

vi.mock("@/lib/review-rewrite-plan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/review-rewrite-plan")>()
  return {
    ...actual,
    generateReviewRewriteEdits: mocks.generateReviewRewriteEdits,
  }
})

vi.mock("@/lib/novel", () => ({
  resolveDefaultModel: (cfg: unknown) => cfg,
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: {
    getState: () => ({
      llmConfig: { provider: "custom", apiKey: "k", model: "m", customEndpoint: "https://x/v1" },
    }),
  },
}))

import { useReviewRewrite, type ReviewRewriteDialogState } from "./use-review-rewrite"
import type { NovelReviewActionItem } from "@/lib/novel-review-action-items"

const t = ((key: string) => key) as unknown as Parameters<typeof useReviewRewrite>[0]["t"]

const ITEM = {
  id: "item-1",
  message: "第二段缺少转折",
  suggestion: "补一句过渡",
  evidence: "第二段。",
  targetPath: "/P/chapters/chapter-001.md",
} as unknown as NovelReviewActionItem

const MARKDOWN = "第一段内容。\n第二段。\n第三段内容。"

function makeOptions(overrides: Record<string, unknown> = {}) {
  return {
    project: { id: "p1", path: "/P", name: "书" },
    issueState: { rewrites: {} },
    persistIssueState: vi.fn(async () => {}),
    showAiRewriteAlert: vi.fn(),
    t,
    bumpDataVersion: vi.fn(),
    selectedFile: null,
    setFileContent: vi.fn(),
    setPendingEditorHighlight: vi.fn(),
    setSelectedFile: vi.fn(),
    setActiveView: vi.fn(),
    ...overrides,
  } as unknown as Parameters<typeof useReviewRewrite>[0]
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.readFile.mockResolvedValue(MARKDOWN)
  mocks.writeFileAtomic.mockResolvedValue(undefined)
  mocks.generateReviewRewriteEdits.mockResolvedValue([
    { id: "e1", originalText: "第二段。", replacementText: "第二段，转折来了。" },
  ])
})

async function openDialog(options: ReturnType<typeof makeOptions>) {
  const hook = renderHook(() => useReviewRewrite(options))
  await act(async () => {
    await hook.result.current.runNovelReviewAiRewrite(ITEM)
  })
  await waitFor(() => {
    expect(hook.result.current.rewriteDialog).not.toBeNull()
  })
  return hook
}

describe("useReviewRewrite handleApplyRewrite 落盘失败", () => {
  it("writeFileAtomic 抛错 → 错误横幅含原始诊断，且不推进版本/不写 issueState/不关框", async () => {
    const options = makeOptions()
    const hook = await openDialog(options)
    expect(
      (hook.result.current.rewriteDialog as ReviewRewriteDialogState).edits,
    ).toHaveLength(1)

    mocks.writeFileAtomic.mockRejectedValue(new Error("EACCES: permission denied"))
    await act(async () => {
      await hook.result.current.handleApplyRewrite()
    })

    expect(hook.result.current.rewriteError).toContain("EACCES: permission denied")
    expect(hook.result.current.rewriteError).toContain("common.operationFailed")
    expect(options.bumpDataVersion).not.toHaveBeenCalled()
    expect(options.persistIssueState).not.toHaveBeenCalled()
    expect(hook.result.current.rewriteDialog).not.toBeNull()
  })

  it("先前失败后按钮被 rewriteError 挡住：不会再次尝试写盘（防重复提交）", async () => {
    const options = makeOptions()
    const hook = await openDialog(options)

    mocks.writeFileAtomic.mockRejectedValue(new Error("磁盘只读"))
    await act(async () => {
      await hook.result.current.handleApplyRewrite()
    })
    const attemptsAfterFailure = mocks.writeFileAtomic.mock.calls.length
    expect(attemptsAfterFailure).toBe(1)

    await act(async () => {
      await hook.result.current.handleApplyRewrite()
    })
    expect(mocks.writeFileAtomic.mock.calls.length).toBe(attemptsAfterFailure)
  })

  it("对照：写盘成功时清空错误、推进版本并写回 issueState（证明上一例失败态非「永远不写」）", async () => {
    const options = makeOptions()
    const hook = await openDialog(options)

    await act(async () => {
      await hook.result.current.handleApplyRewrite()
    })

    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      "/P/chapters/chapter-001.md",
      expect.stringContaining("第二段，转折来了。"),
    )
    expect(options.bumpDataVersion).toHaveBeenCalled()
    expect(options.persistIssueState).toHaveBeenCalled()
    expect(hook.result.current.rewriteError).toBeNull()
    expect(hook.result.current.rewriteDialog).toBeNull()
  })
})
