// @vitest-environment jsdom
/**
 * FileEditPreview — AI 建议修改预览：单条应用/忽略/编辑、全部应用、已处理视图全分支覆盖。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FileEditAction } from "@/lib/novel/agent-parser"
import { FileEditPreview } from "./file-edit-preview"

const editA: FileEditAction = { filePath: "src/a.ts", search: "old line", replace: "new line" }
const editB: FileEditAction = { filePath: "src/b.ts", search: "second", replace: "second edited" }

function renderPreview(props: Partial<Parameters<typeof FileEditPreview>[0]> = {}) {
  const onApply = props.onApply ?? vi.fn(async () => [])
  const onDismiss = props.onDismiss ?? vi.fn()
  const utils = render(
    <FileEditPreview edits={[editA, editB]} onApply={onApply} onDismiss={onDismiss} {...props} />,
  )
  return { ...utils, onApply: onApply as ReturnType<typeof vi.fn>, onDismiss: onDismiss as ReturnType<typeof vi.fn> }
}

/** 第 n 条 pending 行内的按钮：0=展开 1=应用 2=编辑 3=忽略 */
function rowButtons(container: HTMLElement, index: number): HTMLButtonElement[] {
  const rows = Array.from(container.querySelectorAll("div.rounded.border.bg-background.p-2"))
  const row = rows[index] as HTMLElement
  return Array.from(row.querySelectorAll("button")) as HTMLButtonElement[]
}

describe("FileEditPreview", () => {
  afterEach(() => {
    cleanup()
  })
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("渲染待处理列表：文件路径 + 应用/编辑/忽略按钮 + 差异视图", () => {
    const { container } = renderPreview()
    expect(screen.getByText("AI 建议修改 2 处")).toBeTruthy()
    expect(screen.getByText("src/a.ts")).toBeTruthy()
    expect(screen.getByText("src/b.ts")).toBeTruthy()
    // 展开第一条 → 显示 -/+ 差异行
    fireEvent.click(rowButtons(container, 0)[0])
    expect(screen.getByText("old line")).toBeTruthy()
    expect(screen.getByText("new line")).toBeTruthy()
  })

  it("全部忽略 → onDismiss 被调用", () => {
    const { onDismiss } = renderPreview()
    fireEvent.click(screen.getByText("全部忽略"))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it("单条应用 → onApply 只收到该条编辑；应用后进入已处理视图", async () => {
    const { container, onApply } = renderPreview({
      edits: [editA],
      onApply: vi.fn(async () => [{ filePath: "src/a.ts", success: true }]),
    })
    fireEvent.click(rowButtons(container, 0)[1])
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    expect(onApply).toHaveBeenCalledWith([editA])
    expect(screen.getByText("已处理 1 条修改")).toBeTruthy()
  })

  it("单条应用返回失败结果 → 已处理视图显示错误信息", async () => {
    const { container } = renderPreview({
      edits: [editA],
      onApply: vi.fn(async () => [{ filePath: "src/a.ts", success: false, error: "not found" }]),
    })
    fireEvent.click(rowButtons(container, 0)[1])
    await waitFor(() => expect(screen.getByText("(not found)")).toBeTruthy())
  })

  it("单条忽略 → 该条显示『已忽略』，pending 剩 1 个时无全部应用按钮", () => {
    const { container } = renderPreview()
    fireEvent.click(rowButtons(container, 0)[3])
    expect(screen.getByText("src/a.ts (已忽略)")).toBeTruthy()
    // pending 仅剩 1 → 全部应用按钮不渲染（pendingCount > 1 才显示）
    expect(screen.queryByText(/全部应用/)).toBeNull()
  })

  it("编辑替换内容 → 确认后回到 pending 并携带 editedReplace；应用时 onApply 收到修改后的 replace", async () => {
    const { container, onApply } = renderPreview({
      onApply: vi.fn(async () => [{ filePath: "src/a.ts", success: true }]),
    })
    fireEvent.click(rowButtons(container, 0)[2])
    expect(screen.getByText("src/a.ts — 编辑替换内容")).toBeTruthy()
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: "rewritten" } })
    fireEvent.click(screen.getByText("确认"))
    // 回到 pending，应用 → 修改后的 replace
    fireEvent.click(rowButtons(container, 0)[1])
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    expect(onApply).toHaveBeenCalledWith([{ ...editA, replace: "rewritten" }])
  })

  it("编辑后点取消 → 回到 pending 且不修改 replace", () => {
    const { container } = renderPreview()
    fireEvent.click(rowButtons(container, 0)[2])
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: "discarded" } })
    fireEvent.click(screen.getByText("取消"))
    expect(screen.queryByText("src/a.ts — 编辑替换内容")).toBeNull()
    expect(screen.getByText("src/a.ts")).toBeTruthy()
  })

  it("pending > 1 时全部应用 → onApply 收到全部 pending 编辑", async () => {
    const { onApply } = renderPreview({
      onApply: vi.fn(async () => [
        { filePath: "src/a.ts", success: true },
        { filePath: "src/b.ts", success: true },
      ]),
    })
    fireEvent.click(screen.getByText("全部应用 (2)"))
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    expect(onApply).toHaveBeenCalledWith([editA, editB])
    expect(screen.getByText("已处理 2 条修改")).toBeTruthy()
  })

  it("全部应用时已忽略/已应用条目被排除", async () => {
    const editC: FileEditAction = { filePath: "src/c.ts", search: "third", replace: "third edited" }
    const { container, onApply } = renderPreview({
      edits: [editA, editB, editC],
      onApply: vi.fn(async () => [
        { filePath: "src/b.ts", success: true },
        { filePath: "src/c.ts", success: true },
      ]),
    })
    // 忽略第一条
    fireEvent.click(rowButtons(container, 0)[3])
    expect(screen.getByText("src/a.ts (已忽略)")).toBeTruthy()
    // 全部应用 → 只剩 b、c
    fireEvent.click(screen.getByText("全部应用 (2)"))
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    expect(onApply).toHaveBeenCalledWith([editB, editC])
  })

  it("pending 为 0 时全部应用按钮不渲染（无 pending 可应用）", async () => {
    const { container, onApply } = renderPreview({
      edits: [editA],
      onApply: vi.fn(async () => [{ filePath: "src/a.ts", success: true }]),
    })
    fireEvent.click(rowButtons(container, 0)[1])
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/全部应用/)).toBeNull()
  })

  it("applied 初始状态 → 直接显示已处理视图", () => {
    renderPreview({ applied: true })
    expect(screen.getByText("已处理 2 条修改")).toBeTruthy()
  })

  it("已处理视图中可展开差异（应用失败的结果展示）", async () => {
    const { container } = renderPreview({
      edits: [editA],
      onApply: vi.fn(async () => [{ filePath: "src/a.ts", success: false, error: "boom" }]),
    })
    fireEvent.click(rowButtons(container, 0)[1])
    await waitFor(() => expect(screen.getByText("已处理 1 条修改")).toBeTruthy())
    // 已处理行的文本为 "✓ src/a.ts"
    fireEvent.click(screen.getByText(/src\/a\.ts/))
    expect(screen.getByText("old line")).toBeTruthy()
    expect(screen.getByText("new line")).toBeTruthy()
    expect(screen.getByText("(boom)")).toBeTruthy()
  })

  it("edits 变长时补齐新条目的状态（useEffect 分支）", () => {
    const { rerender } = renderPreview({ edits: [editA] })
    rerender(
      <FileEditPreview
        edits={[editA, editB]}
        onApply={vi.fn(async () => [])}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getByText("AI 建议修改 2 处")).toBeTruthy()
    expect(screen.getByText("src/b.ts")).toBeTruthy()
  })

  it("展开后再点一次折叠（toggleExpand 删除分支）", () => {
    const { container } = renderPreview({ edits: [editA] })
    const expandButton = rowButtons(container, 0)[0]
    fireEvent.click(expandButton)
    expect(screen.getByText("old line")).toBeTruthy()
    fireEvent.click(expandButton)
    expect(screen.queryByText("old line")).toBeNull()
  })

  it("edits 缩短时剪枝过期展开项（filter + 返回 next 分支）", () => {
    const { rerender, container } = renderPreview()
    // 展开两条
    fireEvent.click(rowButtons(container, 0)[0])
    fireEvent.click(rowButtons(container, 1)[0])
    rerender(
      <FileEditPreview
        edits={[editA]}
        onApply={vi.fn(async () => [])}
        onDismiss={vi.fn()}
      />,
    )
    // 只剩一条 pending，expandedItems 中 index 1 被剪枝
    expect(screen.getByText("AI 建议修改 1 处")).toBeTruthy()
    // rerender 后（applied=true）itemStates 补齐新条目时 applied 分支 → b 行显示为已应用
    rerender(
      <FileEditPreview
        edits={[editA, editB]}
        applied
        onApply={vi.fn(async () => [])}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getByText(/✓ src\/b\.ts/)).toBeTruthy()
  })

  it("mutated edits array grows without effect dependency change → edit handler fills missing state", () => {
    const edits = [editA]
    const { rerender, container } = renderPreview({ edits })
    edits.push(editB)
    rerender(
      <FileEditPreview
        edits={edits}
        onApply={vi.fn(async () => [])}
        onDismiss={vi.fn()}
      />,
    )
    const rows = Array.from(container.querySelectorAll("div.rounded.border.bg-background.p-2"))
    const buttons = Array.from(rows[1]?.querySelectorAll("button") ?? [])
    fireEvent.click(buttons[2] as HTMLButtonElement)
    expect(screen.getByText("src/b.ts — 编辑替换内容")).toBeTruthy()
  })

  it("malformed empty replace keeps editor fallback expressions defensive", () => {
    const malformed = { ...editA, replace: undefined } as unknown as FileEditAction
    const { container } = renderPreview({ edits: [malformed] })
    fireEvent.click(rowButtons(container, 0)[2])
    expect(screen.getByRole("textbox")).toBeTruthy()
    fireEvent.click(screen.getByText("确认"))
    expect(screen.getByText("src/a.ts")).toBeTruthy()
  })

  it("sparse edits becoming dense without dependency change → handler fills missing state", () => {
    const edits = [] as FileEditAction[]
    edits.length = 2
    edits[1] = editB
    const { rerender, container } = renderPreview({ edits })
    edits[0] = editA
    rerender(
      <FileEditPreview
        edits={edits}
        onApply={vi.fn(async () => [])}
        onDismiss={vi.fn()}
      />,
    )
    const rows = Array.from(container.querySelectorAll("div.rounded.border.bg-background.p-2"))
    const buttons = Array.from(rows[0]?.querySelectorAll("button") ?? [])
    fireEvent.click(buttons[2] as HTMLButtonElement)
    expect(screen.getByText("src/a.ts — 编辑替换内容")).toBeTruthy()
  })

  it("全部应用时使用已编辑的替换内容（applyAll 的 editedReplace 分支）", async () => {
    const { container, onApply } = renderPreview({
      onApply: vi.fn(async () => [
        { filePath: "src/a.ts", success: true },
        { filePath: "src/b.ts", success: true },
      ]),
    })
    // 编辑第一条并确认
    fireEvent.click(rowButtons(container, 0)[2])
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "bulk-rewritten" } })
    fireEvent.click(screen.getByText("确认"))
    fireEvent.click(screen.getByText("全部应用 (2)"))
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    expect(onApply).toHaveBeenCalledWith([{ ...editA, replace: "bulk-rewritten" }, editB])
  })

  it("部分应用后主视图显示已应用行，可再次展开差异", async () => {
    const { container } = renderPreview({
      onApply: vi.fn(async () => [{ filePath: "src/a.ts", success: true }]),
    })
    fireEvent.click(rowButtons(container, 0)[1])
    // 主视图（b 仍 pending）中 a 显示为已应用行 → 展开差异
    await waitFor(() => expect(screen.getByText(/✓ src\/a\.ts/)).toBeTruthy())
    fireEvent.click(screen.getByText(/✓ src\/a\.ts/))
    expect(screen.getByText("old line")).toBeTruthy()
    expect(screen.getByText("src/b.ts")).toBeTruthy()
  })

  it("应用后的条目可再次展开查看差异（applied 视图的 toggleExpand）", async () => {
    const { container } = renderPreview({
      edits: [editA],
      onApply: vi.fn(async () => [{ filePath: "src/a.ts", success: true }]),
    })
    fireEvent.click(rowButtons(container, 0)[1])
    await waitFor(() => expect(screen.getByText("已处理 1 条修改")).toBeTruthy())
    fireEvent.click(screen.getByText(/src\/a\.ts/))
    expect(screen.getByText("old line")).toBeTruthy()
  })

  it("grow-then-click：edits 变长后对新增行点击编辑（next[index] 兜底路径尝试）", () => {
    const { rerender, container } = renderPreview({ edits: [editA] })
    rerender(
      <FileEditPreview
        edits={[editA, editB]}
        onApply={vi.fn(async () => [])}
        onDismiss={vi.fn()}
      />,
    )
    // useEffect 已补齐 itemStates → 新增行是 pending，点编辑应走正常路径
    const rows = Array.from(container.querySelectorAll("div.rounded.border.bg-background.p-2"))
    expect(rows.length).toBe(2)
    const row1Buttons = Array.from(rows[1]?.querySelectorAll("button") ?? [])
    fireEvent.click(row1Buttons[2] as HTMLButtonElement)
    expect(screen.getAllByText(/编辑替换内容/).length).toBeGreaterThan(0)
  })
})
