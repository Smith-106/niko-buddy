// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup as rtlCleanup, render, screen, fireEvent } from "@testing-library/react"
import { DeAiBatchDialog } from "./de-ai-batch-dialog"
import type { DeAiBatchProgress, DeAiBatchSummary } from "@/lib/novel/de-ai-batch"

const progress: DeAiBatchProgress = {
  phase: "running",
  done: 2,
  total: 4,
  processed: 1,
  failed: 1,
  skipped: 0,
  current: { chapterNumber: 3, status: "running" },
  updatedAt: "2026-08-19T00:00:00.000Z",
}

const summary: DeAiBatchSummary = {
  schemaVersion: "de-ai-batch/1.0",
  batchId: "de-ai-1",
  phase: "completed",
  total: 4,
  processed: 2,
  failed: [{ chapterNumber: 3, error: "boom", retries: 2, lastAttemptAt: "2026-08-19T00:00:00.000Z" }],
  skipped: 1,
  durationMs: 3000,
  startedAt: "2026-08-19T00:00:00.000Z",
  finishedAt: "2026-08-19T00:00:03.000Z",
}

function baseProps(overrides: Record<string, any> = {}) {
  return {
    open: true,
    running: false,
    progress: null,
    summary: null,
    chapters: [],
    onCancel: vi.fn(),
    onAcceptAll: vi.fn(),
    onAcceptChapter: vi.fn(),
    onRejectChapter: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
}

describe("DeAiBatchDialog", () => {
  afterEach(() => {
    rtlCleanup()
  })

  it("运行中：进度条 + 计数 + 当前章 + 中止按钮", () => {
    render(<DeAiBatchDialog {...baseProps({ running: true, progress })} />)
    expect(screen.getByText("批量去AI味处理中")).toBeTruthy()
    expect(screen.getByText(/2\/4 章/)).toBeTruthy()
    expect(screen.getByText("50%")).toBeTruthy()
    expect(screen.getByText(/正在处理第 3 章/)).toBeTruthy()
    fireEvent.click(screen.getByText("中止"))
  })

  it("运行中但 progress 为 null：仅标题 + 中止按钮，无进度条", () => {
    render(<DeAiBatchDialog {...baseProps({ running: true, progress: null })} />)
    expect(screen.getByText("批量去AI味处理中")).toBeTruthy()
    expect(screen.queryByText(/%/)).toBeNull()
    fireEvent.click(screen.getByText("中止"))
  })

  it("运行中且无当前章：不显示正在处理提示", () => {
    render(<DeAiBatchDialog {...baseProps({ running: true, progress: { ...progress, current: null } })} />)
    expect(screen.getByText(/2\/4 章/)).toBeTruthy()
    expect(screen.queryByText(/正在处理第/)).toBeNull()
  })

  it("完成：摘要 + 待回填提示 + 逐章列表（ready 可回填/拒绝，failed 显示错误）", () => {
    const onAcceptAll = vi.fn()
    const onAcceptChapter = vi.fn()
    const onRejectChapter = vi.fn()
    render(
      <DeAiBatchDialog
        {...baseProps({
          summary,
          chapters: [
            { chapterNumber: 1, status: "ready" },
            { chapterNumber: 2, status: "accepted" },
            { chapterNumber: 3, status: "failed", lastError: "boom" },
            { chapterNumber: 4, status: "skipped" },
          ],
          onAcceptAll,
          onAcceptChapter,
          onRejectChapter,
        })}
      />,
    )
    expect(screen.getByText(/完成 2 · 失败 1 · 跳过 1 · 共 4 章/)).toBeTruthy()
    expect(screen.getByText(/1 章待回填/)).toBeTruthy()
    expect(screen.getByText(/第 3 章 · failed/)).toBeTruthy()
    expect(screen.getByText(/boom/)).toBeTruthy()
    fireEvent.click(screen.getByText("全部回填"))
    expect(onAcceptAll).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText("回填"))
    expect(onAcceptChapter).toHaveBeenCalledWith(1)
    fireEvent.click(screen.getByText("拒绝"))
    expect(onRejectChapter).toHaveBeenCalledWith(1)
  })

  it("完成且无 ready 章：不显示回填提示", () => {
    render(
      <DeAiBatchDialog
        {...baseProps({
          summary,
          chapters: [{ chapterNumber: 3, status: "failed", lastError: "boom" }],
        })}
      />,
    )
    expect(screen.queryByText(/待回填/)).toBeNull()
  })

  it("完成且无章节列表：不渲染列表区", () => {
    render(<DeAiBatchDialog {...baseProps({ summary, chapters: [] })} />)
    expect(screen.getByText(/完成 2 · 失败 1/)).toBeTruthy()
    expect(screen.queryByText(/第 \d+ 章/)).toBeNull()
  })

  it("关闭：onClose 回调", () => {
    const onClose = vi.fn()
    render(<DeAiBatchDialog {...baseProps({ onClose })} />)
    fireEvent.click(screen.getByText("关闭"))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("对话框 X 关闭（onOpenChange false）→ onClose", () => {
    const onClose = vi.fn()
    render(<DeAiBatchDialog {...baseProps({ onClose })} />)
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
