// @vitest-environment jsdom
/**
 * 面板契约：零事件必须显示空态（不许画一条灰管线假装有跑）；
 * 有事件时蓝色当前路径必须落在最后一个事件的阶段上；
 * 返工计数为 0 的红边必须是灰色虚线（data-active=false）。
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { appendRunEvents, createRunEventLedger, type RunEventInput } from "@/lib/novel"
import { projectPipelineMotion } from "@/lib/novel"

import { PipelineMotionPanel } from "./pipeline-motion-panel"

afterEach(cleanup)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

const TS = "2026-10-19T00:00:00.000Z"

function input(seq: number, kind: RunEventInput["kind"], extra?: Partial<RunEventInput>): RunEventInput {
  return { seq, eventId: `e:${seq}`, ts: TS, kind, actor: "system", ...extra }
}

function panelProps(inputs: RunEventInput[]) {
  const ledger = appendRunEvents(createRunEventLedger(), inputs)
  return { input: { events: ledger.events } }
}

describe("PipelineMotionPanel 空態", () => {
  it("零事件 → 空態文案可見，不渲染流程圖", () => {
    render(<PipelineMotionPanel />)
    expect(screen.getByTestId("motion-empty")).toBeTruthy()
    expect(screen.queryByTestId("motion-diagram")).toBeNull()
    expect(screen.getByTestId("motion-log-empty")).toBeTruthy()
  })
})

describe("PipelineMotionPanel 事件驅動", () => {
  it("13 主節點 + 2 外部節點全部渲染；current 落在最後事件階段", () => {
    render(<PipelineMotionPanel {...panelProps([input(0, "retrieval"), input(1, "generate")])} />)
    expect(screen.getByTestId("motion-diagram")).toBeTruthy()
    const expected = [
      "goal", "evidence", "outline", "chapter-plan", "draft",
      "self-gate", "review", "review-gate", "revise",
      "ingest", "deliver", "reflow", "retrospective",
      "model-router", "knowledge-base",
    ]
    for (const id of expected) {
      expect(screen.getByTestId(`motion-node-${id}`)).toBeTruthy()
    }
    expect(screen.getByTestId("motion-node-draft").getAttribute("data-state")).toBe("current")
    expect(screen.getByTestId("motion-node-evidence").getAttribute("data-state")).toBe("visited")
    expect(screen.getByTestId("motion-node-goal").getAttribute("data-state")).toBe("idle")
  })

  it("retry 點亮返工紅邊；無返工時紅邊為灰色虛線", () => {
    render(<PipelineMotionPanel {...panelProps([input(0, "generate"), input(1, "retry")])} />)
    // retry 計入返修→正文：邊按計數點亮（與 current 落在哪無關）。
    expect(screen.getByTestId("motion-rework-revise-draft").getAttribute("data-active")).toBe("true")
    // 沒有失敗 gate-run：審稿門→返修保持灰色虛線。
    expect(screen.getByTestId("motion-rework-review-gate-revise").getAttribute("data-active")).toBe(
      "false",
    )
  })

  it("統計條數字來自事件計數；log 渲染最近條目", () => {
    render(
      <PipelineMotionPanel
        {...panelProps([input(0, "retrieval"), input(1, "generate"), input(2, "accept")])}
      />,
    )
    const stats = screen.getByTestId("motion-stats").textContent ?? ""
    for (const pair of ["事件 3", "取證 1", "生成 1", "門運行 0", "返工 0", "接收 1", "錯誤 0", "章節 0"]) {
      expect(stats).toContain(pair)
    }
    const log = screen.getByTestId("motion-log")
    expect(within(log).getAllByRole("listitem").length).toBe(3)
    expect(screen.getByTestId("motion-status").textContent).toContain("入庫")
  })
})

describe("PipelineMotionPanel 深色拓撲大屏", () => {
  it("KPI 矩陣 + 審查維度芯片條 + CLI 膠囊條渲染", () => {
    render(<PipelineMotionPanel {...panelProps([input(0, "retrieval"), input(1, "generate")])} />)
    expect(screen.getByTestId("motion-kpis")).toBeTruthy()
    expect(screen.getByText("NIKO-BUDDY · 完整寫作管線 · 目標 → 定稿 → 回流")).toBeTruthy()
    expect(screen.getByTestId("motion-review-dims").textContent).toContain("Canon")
    expect(screen.getByTestId("motion-reflow-loop")).toBeTruthy()
    expect(screen.getByTestId("motion-status").textContent).toContain("niko-buddy pipeline --live")
  })

  it("空賬本點演示 → 內置示例流步進演練；退出恢復空態", () => {
    render(<PipelineMotionPanel />)
    expect(screen.getByTestId("motion-empty")).toBeTruthy()
    fireEvent.click(screen.getByTestId("motion-replay-toggle"))
    expect(screen.getByTestId("motion-demo-note")).toBeTruthy()
    expect(screen.queryByTestId("motion-empty")).toBeNull()
    expect(screen.getByTestId("motion-diagram")).toBeTruthy()
    // 步進：700ms 推進一幀，前進 3 幀後返工邊應點亮。
    act(() => { vi.advanceTimersByTime(2100) })
    expect(screen.getByTestId("motion-rework-review-gate-revise").getAttribute("data-active")).toBe("true")
    // 退出演示恢復原狀。
    fireEvent.click(screen.getByTestId("motion-replay-toggle"))
    expect(screen.getByTestId("motion-empty")).toBeTruthy()
    expect(screen.queryByTestId("motion-diagram")).toBeNull()
  })

  it("有賬本點回放 → 按幀重演事件；停止恢復全量", () => {
    render(<PipelineMotionPanel {...panelProps([input(0, "retrieval"), input(1, "generate"), input(2, "accept")])} />)
    expect(screen.getByTestId("motion-node-ingest").getAttribute("data-state")).toBe("current")
    fireEvent.click(screen.getByTestId("motion-replay-toggle"))
    expect(screen.queryByTestId("motion-demo-note")).toBeNull()
    // 首幀：只有取證事件，draft 應為 idle。
    expect(screen.getByTestId("motion-node-draft").getAttribute("data-state")).toBe("idle")
    act(() => { vi.advanceTimersByTime(700) })
    expect(screen.getByTestId("motion-node-draft").getAttribute("data-state")).toBe("current")
    fireEvent.click(screen.getByTestId("motion-replay-toggle"))
    expect(screen.getByTestId("motion-node-ingest").getAttribute("data-state")).toBe("current")
  })
})

describe("PipelineMotionPanel 雙編碼與分支覆蓋", () => {
  it("visited 用 ●、idle 用 ○，不只靠顏色", () => {
    render(<PipelineMotionPanel {...panelProps([input(0, "retrieval"), input(1, "generate")])} />)
    expect(screen.getByTestId("motion-node-evidence").textContent).toContain("●")
    expect(screen.getByTestId("motion-node-goal").textContent).toContain("○")
    expect(screen.getByTestId("motion-node-draft").textContent).toContain("▶")
    expect(screen.getByTestId("motion-node-self-gate").querySelector("polygon")).not.toBeNull()
    expect(screen.getByTestId("motion-node-draft").querySelector("rect")).not.toBeNull()
  })

  it("critic 失敗點亮自檢門→返修紅邊（實線），審稿門邊保持虛線", () => {
    render(
      <PipelineMotionPanel
        {...panelProps([input(0, "gate-run", { actor: "critic", payload: { pass: false } })])}
      />,
    )
    const selfEdge = screen.getByTestId("motion-rework-self-gate-revise")
    expect(selfEdge.getAttribute("data-active")).toBe("true")
    expect(selfEdge.getAttribute("stroke")).toBe("#f85149")
    expect(selfEdge.getAttribute("stroke-dasharray")).toBeNull()
    const reviewEdge = screen.getByTestId("motion-rework-review-gate-revise")
    expect(reviewEdge.getAttribute("data-active")).toBe("false")
    expect(reviewEdge.getAttribute("stroke-dasharray")).toBe("4 3")
  })

  it("quota 落外部節點 current；知識庫保持 idle", () => {
    render(<PipelineMotionPanel {...panelProps([input(0, "retrieval"), input(1, "quota")])} />)
    expect(screen.getByTestId("motion-node-model-router").getAttribute("data-state")).toBe("current")
    expect(screen.getByTestId("motion-node-model-router").textContent).toContain("◇")
    expect(screen.getByTestId("motion-node-knowledge-base").getAttribute("data-state")).toBe("idle")
  })

  it("七層縱向 viewBox + 回放末幀顯示重新回放", () => {
    const { container } = render(<PipelineMotionPanel {...panelProps([input(0, "retrieval"), input(1, "generate")])} />)
    expect(screen.getByTestId("motion-diagram").getAttribute("viewBox")).toBe("0 0 1100 680")
    // 外部依赖连线为有效长度的琥珀色虚线（零长度 Bug 已修复）。
    const kb = container.querySelector('[data-testid="motion-node-knowledge-base"]')
    expect(kb?.querySelectorAll("path").length).toBeGreaterThan(0)
    // 回放到末帧：定时器清理且按钮显示重新回放。
    fireEvent.click(screen.getByTestId("motion-replay-toggle"))
    act(() => { vi.advanceTimersByTime(700 * 10) })
    expect(screen.getByTestId("motion-replay-toggle").textContent).toContain("重新回放")
  })

  it("進入當前節點的主線邊高亮，其餘邊冷", () => {
    // 自檢門 current、前序正文 visited → 進入邊（draft→self-gate，index 4）高亮；
    // 稀疏跳躍（前序 idle）的邊不高亮：沒走過的路不點亮。
    render(
      <PipelineMotionPanel
        {...panelProps([
          input(0, "generate"),
          input(1, "gate-run", { actor: "critic", payload: { pass: true } }),
        ])}
      />,
    )
    expect(screen.getByTestId("motion-edge-4").getAttribute("data-hot")).toBe("true")
    expect(screen.getByTestId("motion-edge-0").getAttribute("data-hot")).toBe("false")
  })

  it("log 只顯示最近 8 條；純軌跡輸入顯示未在運行", () => {
    const inputs = Array.from({ length: 10 }, (_, seq) =>
      input(seq, "generate", { ts: `2026-10-19T00:00:${String(seq).padStart(2, "0")}Z` }),
    )
    const { rerender } = render(<PipelineMotionPanel {...panelProps(inputs)} />)
    expect(within(screen.getByTestId("motion-log")).getAllByRole("listitem")).toHaveLength(8)
    rerender(
      <PipelineMotionPanel
        projection={projectPipelineMotion({
          events: [],
          traceEntries: [{ name: "read_outline", title: "讀大綱", status: "done", startedAt: 1 }],
        })}
      />,
    )
    expect(screen.getByTestId("motion-status").textContent).toContain("未在運行")
  })
})
