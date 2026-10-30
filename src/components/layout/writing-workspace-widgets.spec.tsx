// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import type { ChapterDraft } from "@/lib/novel"
import { DraftsToggleButton, WorkspaceMoreTools, usePendingDraftCount } from "./writing-workspace-widgets"
import {
  buildChapterDraftGoal,
  clearMainControlGoalHandoff,
  peekMainControlGoalHandoff,
  setMainControlGoalHandoff,
} from "@/components/novel/main-control-handoff"

const mk = (id: string, status: ChapterDraft["status"]): ChapterDraft => ({ id, chapterName: id, content: "", createdAt: 1, status })

afterEach(() => {
  cleanup()
  clearMainControlGoalHandoff()
})

describe("writing-workspace-widgets", () => {
  it("待采纳数只计未写入正式章的草稿", async () => {
    const list = vi.fn(async () => [mk("a", "draft"), mk("b", "saved"), mk("c", "draft")])
    const { result } = renderHook(() => usePendingDraftCount("C:/book", 0, list))
    await waitFor(() => expect(result.current).toBe(2))
  })

  it("读草稿失败时不显示徽标（null）", async () => {
    const list = vi.fn(async () => {
      throw new Error("io")
    })
    const { result } = renderHook(() => usePendingDraftCount("C:/book", 0, list))
    await waitFor(() => expect(list).toHaveBeenCalled())
    expect(result.current).toBeNull()
  })

  it("有待采纳草稿时按钮显示「N 份待采纳」，没有时不显示", () => {
    const onClick = vi.fn()
    const { rerender } = render(<DraftsToggleButton pressed={false} pendingCount={1} onClick={onClick} />)
    expect(screen.getByTestId("workspace-pending-draft-badge").textContent).toContain("1 份待采纳")
    fireEvent.click(screen.getByTestId("workspace-desk-drafts"))
    expect(onClick).toHaveBeenCalledTimes(1)
    rerender(<DraftsToggleButton pressed={false} pendingCount={0} onClick={onClick} />)
    expect(screen.queryByTestId("workspace-pending-draft-badge")).toBeNull()
  })

  it("更多工具收纳的按钮仍在 DOM 中可点", () => {
    const onClick = vi.fn()
    render(
      <WorkspaceMoreTools active={false}>
        <button type="button" data-testid="inner" onClick={onClick}>x</button>
      </WorkspaceMoreTools>,
    )
    fireEvent.click(screen.getByTestId("inner"))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("主控目标交接：peek 不清空，clear 后为空；默认文案按章节标题生成", () => {
    setMainControlGoalHandoff(buildChapterDraftGoal("第3章 夜行"))
    expect(peekMainControlGoalHandoff()).toBe("为「第3章 夜行」生成本章草稿")
    expect(peekMainControlGoalHandoff()).toBe("为「第3章 夜行」生成本章草稿")
    clearMainControlGoalHandoff()
    expect(peekMainControlGoalHandoff()).toBeNull()
    expect(buildChapterDraftGoal("  ")).toBe("生成下一章草稿")
  })
})
