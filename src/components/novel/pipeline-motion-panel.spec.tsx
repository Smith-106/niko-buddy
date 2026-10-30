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

describe("PipelineMotionPanel 空态", () => {
  it("零事件 → 空态文案可见，不渲染流程图", () => {
    render(<PipelineMotionPanel />)
    expect(screen.getByTestId("motion-empty")).toBeTruthy()
    expect(screen.queryByTestId("motion-diagram")).toBeNull()
    expect(screen.getByTestId("motion-log-empty")).toBeTruthy()
  })
})

describe("PipelineMotionPanel 事件驱动", () => {
  it("13 主节点 + 2 外部节点全部渲染；current 落在最后事件阶段", () => {
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

  it("retry 点亮返工红边；无返工时红边为灰色虚线", () => {
    render(<PipelineMotionPanel {...panelProps([input(0, "generate"), input(1, "retry")])} />)
    // retry 计入返修→正文：边按计数点亮（与 current 落在哪无关）。
    expect(screen.getByTestId("motion-rework-revise-draft").getAttribute("data-active")).toBe("true")
    // 没有失败 gate-run：审稿门→返修保持灰色虚线。
    expect(screen.getByTestId("motion-rework-review-gate-revise").getAttribute("data-active")).toBe(
      "false",
    )
  })

  it("统计条数字来自事件计数；log 渲染最近条目", () => {
    render(
      <PipelineMotionPanel
        {...panelProps([input(0, "retrieval"), input(1, "generate"), input(2, "accept")])}
      />,
    )
    const stats = screen.getByTestId("motion-stats").textContent ?? ""
    for (const pair of ["事件 3", "取证 1", "生成 1", "门运行 0", "返工 0", "接收 1", "错误 0", "章节 0"]) {
      expect(stats).toContain(pair)
    }
    const log = screen.getByTestId("motion-log")
    expect(within(log).getAllByRole("listitem").length).toBe(3)
    expect(screen.getByTestId("motion-status").textContent).toContain("入库")
  })
})

describe("PipelineMotionPanel 深色拓扑大屏", () => {
  it("KPI 矩阵 + 审查维度芯片条 + CLI 胶囊条渲染", () => {
    render(<PipelineMotionPanel {...panelProps([input(0, "retrieval"), input(1, "generate")])} />)
    expect(screen.getByTestId("motion-kpis")).toBeTruthy()
    expect(screen.getByText("NIKO-BUDDY · 完整写作管线 · 目标 → 定稿 → 回流")).toBeTruthy()
    expect(screen.getByTestId("motion-review-dims").textContent).toContain("Canon")
    expect(screen.getByTestId("motion-reflow-loop")).toBeTruthy()
    expect(screen.getByTestId("motion-status").textContent).toContain("niko-buddy pipeline --live")
  })

  it("空账本点演示 → 内置示例流步进演练；退出恢复空态", () => {
    render(<PipelineMotionPanel />)
    expect(screen.getByTestId("motion-empty")).toBeTruthy()
    fireEvent.click(screen.getByTestId("motion-replay-toggle"))
    expect(screen.getByTestId("motion-demo-note")).toBeTruthy()
    expect(screen.queryByTestId("motion-empty")).toBeNull()
    expect(screen.getByTestId("motion-diagram")).toBeTruthy()
    // 步进：700ms 推进一帧，前进 3 帧后返工边应点亮。
    act(() => { vi.advanceTimersByTime(2100) })
    expect(screen.getByTestId("motion-rework-review-gate-revise").getAttribute("data-active")).toBe("true")
    // 退出演示恢复原状。
    fireEvent.click(screen.getByTestId("motion-replay-toggle"))
    expect(screen.getByTestId("motion-empty")).toBeTruthy()
    expect(screen.queryByTestId("motion-diagram")).toBeNull()
  })

  it("有账本点回放 → 按帧重演事件；停止恢复全量", () => {
    render(<PipelineMotionPanel {...panelProps([input(0, "retrieval"), input(1, "generate"), input(2, "accept")])} />)
    expect(screen.getByTestId("motion-node-ingest").getAttribute("data-state")).toBe("current")
    fireEvent.click(screen.getByTestId("motion-replay-toggle"))
    expect(screen.queryByTestId("motion-demo-note")).toBeNull()
    // 首帧：只有取证事件，draft 应为 idle。
    expect(screen.getByTestId("motion-node-draft").getAttribute("data-state")).toBe("idle")
    act(() => { vi.advanceTimersByTime(700) })
    expect(screen.getByTestId("motion-node-draft").getAttribute("data-state")).toBe("current")
    fireEvent.click(screen.getByTestId("motion-replay-toggle"))
    expect(screen.getByTestId("motion-node-ingest").getAttribute("data-state")).toBe("current")
  })
})

describe("PipelineMotionPanel 双编码与分支覆盖", () => {
  it("visited 用 ●、idle 用 ○，不只靠颜色", () => {
    render(<PipelineMotionPanel {...panelProps([input(0, "retrieval"), input(1, "generate")])} />)
    expect(screen.getByTestId("motion-node-evidence").textContent).toContain("●")
    expect(screen.getByTestId("motion-node-goal").textContent).toContain("○")
    expect(screen.getByTestId("motion-node-draft").textContent).toContain("▶")
    expect(screen.getByTestId("motion-node-self-gate").querySelector("polygon")).not.toBeNull()
    expect(screen.getByTestId("motion-node-draft").querySelector("rect")).not.toBeNull()
  })

  it("critic 失败点亮自检门→返修红边（实线），审稿门边保持虚线", () => {
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

  it("quota 落外部节点 current；知识库保持 idle", () => {
    render(<PipelineMotionPanel {...panelProps([input(0, "retrieval"), input(1, "quota")])} />)
    expect(screen.getByTestId("motion-node-model-router").getAttribute("data-state")).toBe("current")
    expect(screen.getByTestId("motion-node-model-router").textContent).toContain("◇")
    expect(screen.getByTestId("motion-node-knowledge-base").getAttribute("data-state")).toBe("idle")
  })

  it("七层纵向 viewBox + 回放末帧显示重新回放", () => {
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

  it("进入当前节点的主线边高亮，其余边冷", () => {
    // 自检门 current、前序正文 visited → 进入边（draft→self-gate，index 4）高亮；
    // 稀疏跳跃（前序 idle）的边不高亮：没走过的路不点亮。
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

  it("log 只显示最近 8 条；纯轨迹输入显示未在运行", () => {
    const inputs = Array.from({ length: 10 }, (_, seq) =>
      input(seq, "generate", { ts: `2026-10-19T00:00:${String(seq).padStart(2, "0")}Z` }),
    )
    const { rerender } = render(<PipelineMotionPanel {...panelProps(inputs)} />)
    expect(within(screen.getByTestId("motion-log")).getAllByRole("listitem")).toHaveLength(8)
    rerender(
      <PipelineMotionPanel
        projection={projectPipelineMotion({
          events: [],
          traceEntries: [{ name: "read_outline", title: "读大纲", status: "done", startedAt: 1 }],
        })}
      />,
    )
    expect(screen.getByTestId("motion-status").textContent).toContain("未在运行")
  })
})
