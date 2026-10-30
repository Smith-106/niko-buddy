// @vitest-environment jsdom
/**
 * 视图接线契约：注入账本直接渲染（不碰磁盘）；磁盘装载中显示 loading；
 * 装载失败显式报错且不编造管线（零数据时为空态）。
 */
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: () =>
      Promise.resolve(
        JSON.stringify({ fileVersion: 1, goal: "g", savedAt: 1, ok: true, roundsUsed: 0, finalText: "", entries: [] }),
      ),
  }
})

import { appendRunEvents, createRunEventLedger, type RunEventInput } from "@/lib/novel"

import { PipelineMotionView } from "./pipeline-motion-view"

afterEach(cleanup)

const TS = "2026-10-19T00:00:00.000Z"

function eventsOf(inputs: RunEventInput[]) {
  return appendRunEvents(createRunEventLedger(), inputs).events
}

describe("PipelineMotionView", () => {
  it("注入账本直接渲染流程图（不碰磁盘）", () => {
    render(
      <PipelineMotionView
        projectPath="/fake"
        ledgerEvents={eventsOf([
          { seq: 0, eventId: "e:0", ts: TS, kind: "retrieval", actor: "system" },
          { seq: 1, eventId: "e:1", ts: TS, kind: "generate", actor: "system" },
        ])}
        traceEntries={[]}
      />,
    )
    expect(screen.getByTestId("motion-diagram")).toBeTruthy()
    expect(screen.getByTestId("motion-node-draft").getAttribute("data-state")).toBe("current")
    // 大屏穿透：KPI 矩阵 + 回放开关 + CLI 胶囊条随视图一并挂载。
    expect(screen.getByTestId("motion-kpis")).toBeTruthy()
    expect(screen.getByTestId("motion-replay-toggle")).toBeTruthy()
    expect(screen.getByTestId("motion-status").textContent).toContain("niko-buddy pipeline --live")
    expect(screen.queryByTestId("motion-view-loading")).toBeNull()
  })

  it("磁盘装载中显示 loading（deps 悬挂不决议）", () => {
    render(<PipelineMotionView projectPath="/fake" deps={{ readText: () => new Promise(() => {}), appendText: () => Promise.resolve() }} />)
    expect(screen.getByTestId("motion-view-loading")).toBeTruthy()
    expect(screen.queryByTestId("motion-diagram")).toBeNull()
  })

  it("装载失败显式报错；零数据时为空态而非假管线", async () => {
    render(
      <PipelineMotionView
        projectPath="/fake"
        deps={{
          readText: () => Promise.reject(new Error("disk gone")),
          appendText: () => Promise.resolve(),
        }}
      />,
    )
    const error = await screen.findByTestId("motion-load-error")
    expect(error.textContent).toContain("保留上次数据")
    expect(screen.getByTestId("motion-empty")).toBeTruthy()
  })
})

describe("PipelineMotionView 磁盘装载", () => {
  const LEDGER_LINE =
    '{"seq":0,"eventId":"e:0","ts":"2026-10-19T00:00:00.000Z","kind":"generate","actor":"system","evidenceRefs":[]}\n'

  it("第二次装载失败保留旧数据，且全程不写磁盘", async () => {
    let calls = 0
    const appendText = vi.fn(() => Promise.resolve())
    const readText = vi.fn(() => {
      calls += 1
      return calls === 1 ? Promise.resolve(LEDGER_LINE) : Promise.reject(new Error("disk gone"))
    })
    render(<PipelineMotionView projectPath="/fake" deps={{ readText, appendText }} pollMs={20} />)
    // 首次成功：流程图出现。
    await screen.findByTestId("motion-diagram")
    expect(screen.getByTestId("motion-node-draft").getAttribute("data-state")).toBe("current")
    // 后续轮询失败：错误条出现，旧图保留。
    await screen.findByTestId("motion-load-error")
    expect(screen.getByTestId("motion-diagram")).toBeTruthy()
    expect(screen.getByTestId("motion-node-draft").getAttribute("data-state")).toBe("current")
    expect(appendText).not.toHaveBeenCalled()
  })
})
describe("PipelineMotionView 串行轮询", () => {
  const LEDGER_LINE =
    '{"seq":0,"eventId":"e:0","ts":"2026-10-19T00:00:00.000Z","kind":"generate","actor":"system","evidenceRefs":[]}'

  it("首轮未结算不开第二枪：从构造上没有重叠请求", async () => {
    const readText = vi.fn(() => new Promise<string>(() => {}))
    render(
      <PipelineMotionView
        projectPath="/fake"
        deps={{ readText, appendText: () => Promise.resolve() }}
        pollMs={20}
      />,
    )
    await new Promise((resolve) => setTimeout(resolve, 80))
    // 首轮悬挂时，轮询不得开火：stale 整类不存在。
    expect(readText).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("motion-view-loading")).toBeTruthy()
    expect(screen.queryByTestId("motion-empty")).toBeNull()
    expect(screen.queryByTestId("motion-diagram")).toBeNull()
  })

  it("慢首轮结算即出图：无假空态、无永久 loading", async () => {
    const resolvers: Array<(value: string) => void> = []
    const readText = vi.fn(() => new Promise<string>((resolve) => { resolvers.push(resolve) }))
    render(
      <PipelineMotionView
        projectPath="/fake"
        deps={{ readText, appendText: () => Promise.resolve() }}
        pollMs={20}
      />,
    )
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(screen.getByTestId("motion-view-loading")).toBeTruthy()
    for (const resolve of resolvers) resolve(LEDGER_LINE)
    await screen.findByTestId("motion-diagram")
    expect(screen.getByTestId("motion-node-draft").getAttribute("data-state")).toBe("current")
  })
})
