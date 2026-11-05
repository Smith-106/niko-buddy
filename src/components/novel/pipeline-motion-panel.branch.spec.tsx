// @vitest-environment jsdom
/**
 * pipeline-motion-panel 分支覆盖补齐（Ralph 覆盖率战役）。
 * 只增补：自定义投影直驱未覆盖分支 + 回放 timer 边界，每例均断言可观察行为。
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { appendRunEvents, createRunEventLedger, type RunEventInput } from "@/lib/novel"
import type { PipelineMotionProjection } from "@/lib/novel"

import { PipelineMotionPanel } from "./pipeline-motion-panel"

afterEach(cleanup)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

const TS = "2026-10-19T00:00:00.000Z"

function input(seq: number, kind: RunEventInput["kind"]): RunEventInput {
  return { seq, eventId: `e:${seq}`, ts: TS, kind, actor: "system" }
}

function panelProps(inputs: RunEventInput[]) {
  const ledger = appendRunEvents(createRunEventLedger(), inputs)
  return { input: { events: ledger.events } }
}

const IDLE_COUNTS = {
  events: 1,
  evidence: 0,
  generated: 0,
  gates: 0,
  passed: 0,
  reworks: 0,
  accepts: 0,
  errors: 0,
  chapters: 0,
}

function idleNode(id: string, label: string): PipelineMotionProjection["nodes"][number] {
  return { id, label, kind: "stage", state: "idle", lastTs: null }
}

describe("PipelineMotionPanel 分支补齐", () => {
  it("未知节点 id 回退默认座标；未知外部节点走右出分支；空返工计数画灰边", () => {
    const projection: PipelineMotionProjection = {
      checked: true,
      nodes: [idleNode("goal", "目标"), { id: "mystery-node", label: "神秘", kind: "stage", state: "current", lastTs: TS }, { ...idleNode("reflow", "回流"), state: "visited" }, idleNode("retrospective", "回顾")],
      externals: [{ id: "mystery-ext", label: "外部", kind: "stage", state: "visited", lastTs: TS }],
      hotEdge: null,
      reworkCounts: {},
      counts: IDLE_COUNTS,
      log: [{ ts: TS, label: "出错了", tone: "error" }],
    }
    render(<PipelineMotionPanel projection={projection} />)
    // nodeXY 未知 id 回退分支
    expect(screen.getByTestId("motion-node-mystery-node")).toBeTruthy()
    expect(screen.getByTestId("motion-node-mystery-ext")).toBeTruthy()
    // reworkCounts 缺键 ?? 0 → 灰色虚线
    expect(screen.getByTestId("motion-rework-revise-draft").getAttribute("data-active")).toBe("false")
    expect(screen.getByTestId("motion-rework-self-gate-revise").getAttribute("data-active")).toBe("false")
    // error tone 红色分支
    expect(screen.getByTestId("motion-log").textContent).toContain("出错了")
    // 回流已走过 → 高亮回路分支（含脉冲圆点）
    const loop = screen.getByTestId("motion-reflow-loop")
    expect(loop.querySelector("circle")).not.toBeNull()
  })

  it("有当前节点但无日志 → 状态条不追加上次后缀", () => {
    const projection: PipelineMotionProjection = {
      checked: true,
      nodes: [idleNode("goal", "目标"), { id: "draft", label: "正文", kind: "stage", state: "current", lastTs: TS }],
      externals: [],
      hotEdge: null,
      reworkCounts: {},
      counts: IDLE_COUNTS,
      log: [],
    }
    render(<PipelineMotionPanel projection={projection} />)
    const status = screen.getByTestId("motion-status")
    expect(status.textContent).toContain("当前路径 [正文]")
    expect(status.textContent).not.toContain("·")
    expect(screen.getByTestId("motion-log-empty")).toBeTruthy()
  })

  it("全 idle 无当前节点 + 有日志 → 未在运行且展示上次", () => {
    const projection: PipelineMotionProjection = {
      checked: true,
      nodes: [idleNode("goal", "目标"), idleNode("reflow", "回流"), idleNode("retrospective", "回顾")],
      externals: [],
      hotEdge: null,
      reworkCounts: {},
      counts: { ...IDLE_COUNTS, events: 0 },
      log: [{ ts: TS, label: "上次取证", tone: "info" }],
    }
    render(<PipelineMotionPanel projection={projection} />)
    const status = screen.getByTestId("motion-status")
    expect(status.textContent).toContain("未在运行")
    expect(status.textContent).toContain("上次：上次取证")
  })

  it("回放播完后退出走 timer-null 分支并恢复常态", () => {
    render(<PipelineMotionPanel {...panelProps([input(0, "retrieval")])} />)
    fireEvent.click(screen.getByTestId("motion-replay-toggle"))
    // 单事件账本 total=1：一帧即播完，timer 被清理且 finished 置位
    act(() => {
      vi.advanceTimersByTime(700)
    })
    expect(screen.getByTestId("motion-replay-toggle").textContent).toContain("重新回放")
    // 此时退出走 stopReplay 的 timer-null 分支
    fireEvent.click(screen.getByTestId("motion-replay-toggle"))
    expect(screen.getByTestId("motion-replay-toggle").textContent).toContain("流程回放")
  })

  it("卸载进行中的回放清理 timer", () => {
    const clearSpy = vi.spyOn(globalThis, "clearInterval")
    try {
      const { unmount } = render(<PipelineMotionPanel {...panelProps([input(0, "retrieval"), input(1, "generate")])} />)
      fireEvent.click(screen.getByTestId("motion-replay-toggle"))
      expect(clearSpy).not.toHaveBeenCalled()
      unmount()
      expect(clearSpy).toHaveBeenCalled()
    } finally {
      clearSpy.mockRestore()
    }
  })
})
