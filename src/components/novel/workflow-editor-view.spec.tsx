// @vitest-environment jsdom
/**
 * workflow-editor-view.spec.tsx — 工作流只读视图契约。
 *
 * 覆盖：
 *   1. 空 projectPath → 空态，不读磁盘；
 *   2. 空账本（文件缺失/空）→ 模板注册表照常渲染 + 账本诚实「暂无运行事件」；
 *   3. 合法事件行 → 最近事件渲染（seq/kind/actor）；
 *   4. 损坏行 → 账本区诚实失败文案，模板区不受影响；
 *   5. 显式注入快照 → 跳过磁盘装载。
 *
 * 磁盘统一经 `@/commands/fs` 的 readFile（账本 store 默认 deps），此处只 mock 该模块；
 * 模板注册表是同步纯函数，不走磁盘。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, readFile: vi.fn(), listDirectory: vi.fn() }
})

import { readFile } from "@/commands/fs"
import { WorkflowEditorView } from "./workflow-editor-view"

const readFileMock = vi.mocked(readFile)

const VALID_EVENT_LINE =
  '{"seq":0,"eventId":"generate:0:test","ts":"2026-10-19T00:00:00.000Z","kind":"generate","actor":"writer"}\n'

afterEach(cleanup)

beforeEach(() => {
  readFileMock.mockReset()
})

describe("WorkflowEditorView", () => {
  it("空 projectPath → 空态，不读磁盘", () => {
    render(<WorkflowEditorView projectPath="" />)
    expect(screen.getByTestId("workflow-editor-view")).toBeTruthy()
    expect(screen.getByTestId("workflow-empty").textContent).toContain("未指定项目路径")
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it("空账本 → 模板照常渲染 + 账本诚实空态", async () => {
    readFileMock.mockRejectedValue(new Error("missing"))
    render(<WorkflowEditorView projectPath="C:/proj" />)
    await waitFor(() => expect(screen.getByTestId("workflow-ledger-empty")).toBeTruthy())
    expect(screen.getByTestId("workflow-templates")).toBeTruthy()
    expect(screen.getByTestId("workflow-ledger-empty").textContent).toContain("暂无运行事件")
    // 模板注册表来自纯函数真源：断言至少有一项登记（不断言具体条目数，避免与真源漂移耦合）。
    expect(document.querySelectorAll('[data-testid^="workflow-template-"]').length).toBeGreaterThan(0)
    expect(screen.queryByTestId("workflow-ledger-error")).toBeNull()
  })

  it("合法事件行 → 最近事件渲染", async () => {
    readFileMock.mockResolvedValue(VALID_EVENT_LINE)
    render(<WorkflowEditorView projectPath="C:/proj" />)
    await waitFor(() => expect(screen.getByTestId("workflow-ledger-count")).toBeTruthy())
    expect(screen.getByTestId("workflow-ledger-count").textContent).toContain("共 1 条事件")
    const row = screen.getByTestId("workflow-event-0")
    expect(row.textContent).toContain("generate")
    expect(row.textContent).toContain("writer")
  })

  it("损坏行 → 账本区失败文案，模板区不受影响", async () => {
    readFileMock.mockResolvedValue("not-json\n")
    render(<WorkflowEditorView projectPath="C:/proj" />)
    await waitFor(() => expect(screen.getByTestId("workflow-ledger-error")).toBeTruthy())
    expect(screen.getByTestId("workflow-ledger-error").textContent).toContain("账本读取失败")
    expect(screen.getByTestId("workflow-templates")).toBeTruthy()
    expect(document.querySelectorAll('[data-testid^="workflow-template-"]').length).toBeGreaterThan(0)
  })

  it("显式注入快照 → 跳过磁盘装载", () => {
    render(
      <WorkflowEditorView
        projectPath="C:/proj"
        snapshot={{ templates: [], groups: [], ledgerEventCount: 0, recentEvents: [], ledgerError: null }}
      />,
    )
    expect(screen.getByTestId("workflow-templates-empty").textContent).toContain("暂无模板登记")
    expect(screen.getByTestId("workflow-ledger-empty")).toBeTruthy()
    expect(readFileMock).not.toHaveBeenCalled()
  })
})
