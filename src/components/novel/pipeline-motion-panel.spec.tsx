// @vitest-environment jsdom
/**
 * 面板契约：零事件必须显示空态（不许画一条灰管线假装有跑）；
 * 有事件时蓝色当前路径必须落在最后一个事件的阶段上；
 * 返工计数为 0 的红边必须是灰色虚线（data-active=false）。
 */
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { appendRunEvents, createRunEventLedger, type RunEventInput } from "@/lib/novel"
import { projectPipelineMotion } from "@/lib/novel"

import { PipelineMotionPanel } from "./pipeline-motion-panel"

afterEach(cleanup)

const TS = "2026-10-19T00:00:00.000Z"

function input(seq: number, kind: RunEventInput["kind"], extra?: Partial<RunEventInput>): RunEventInput {
  return { seq, eventId: `e:${seq}`, ts: TS, kind, actor: "system", ...extra }
}

function panelProps(inputs: RunEventInput[]) {
  const ledger = appendRunEvents(createRunEventLedger(), inputs)
  return { projection: projectPipelineMotion({ events: ledger.events }) }
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
    expect(stats).toContain("3")
    const log = screen.getByTestId("motion-log")
    expect(within(log).getAllByRole("listitem").length).toBe(3)
    expect(screen.getByTestId("motion-status").textContent).toContain("入庫")
  })
})
