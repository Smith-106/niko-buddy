// @vitest-environment jsdom
/**
 * 視圖接線契約：注入賬本直接渲染（不碰磁盤）；磁盤裝載中顯示 loading；
 * 裝載失敗顯式報錯且不編造管線（零數據時為空態）。
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
  it("注入賬本直接渲染流程圖（不碰磁盤）", () => {
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
    // 大屏穿透：KPI 矩陣 + 回放開關 + CLI 膠囊條隨視圖一併掛載。
    expect(screen.getByTestId("motion-kpis")).toBeTruthy()
    expect(screen.getByTestId("motion-replay-toggle")).toBeTruthy()
    expect(screen.getByTestId("motion-status").textContent).toContain("niko-buddy pipeline --live")
    expect(screen.queryByTestId("motion-view-loading")).toBeNull()
  })

  it("磁盤裝載中顯示 loading（deps 懸掛不決議）", () => {
    render(<PipelineMotionView projectPath="/fake" deps={{ readText: () => new Promise(() => {}), appendText: () => Promise.resolve() }} />)
    expect(screen.getByTestId("motion-view-loading")).toBeTruthy()
    expect(screen.queryByTestId("motion-diagram")).toBeNull()
  })

  it("裝載失敗顯式報錯；零數據時為空態而非假管線", async () => {
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
    expect(error.textContent).toContain("保留上次數據")
    expect(screen.getByTestId("motion-empty")).toBeTruthy()
  })
})

describe("PipelineMotionView 磁盤裝載", () => {
  const LEDGER_LINE =
    '{"seq":0,"eventId":"e:0","ts":"2026-10-19T00:00:00.000Z","kind":"generate","actor":"system","evidenceRefs":[]}\n'

  it("第二次裝載失敗保留舊數據，且全程不寫磁盤", async () => {
    let calls = 0
    const appendText = vi.fn(() => Promise.resolve())
    const readText = vi.fn(() => {
      calls += 1
      return calls === 1 ? Promise.resolve(LEDGER_LINE) : Promise.reject(new Error("disk gone"))
    })
    render(<PipelineMotionView projectPath="/fake" deps={{ readText, appendText }} pollMs={20} />)
    // 首次成功：流程圖出現。
    await screen.findByTestId("motion-diagram")
    expect(screen.getByTestId("motion-node-draft").getAttribute("data-state")).toBe("current")
    // 後續輪詢失敗：錯誤條出現，舊圖保留。
    await screen.findByTestId("motion-load-error")
    expect(screen.getByTestId("motion-diagram")).toBeTruthy()
    expect(screen.getByTestId("motion-node-draft").getAttribute("data-state")).toBe("current")
    expect(appendText).not.toHaveBeenCalled()
  })
})
describe("PipelineMotionView 串行輪詢", () => {
  const LEDGER_LINE =
    '{"seq":0,"eventId":"e:0","ts":"2026-10-19T00:00:00.000Z","kind":"generate","actor":"system","evidenceRefs":[]}'

  it("首輪未結算不開第二槍：從構造上沒有重疊請求", async () => {
    const readText = vi.fn(() => new Promise<string>(() => {}))
    render(
      <PipelineMotionView
        projectPath="/fake"
        deps={{ readText, appendText: () => Promise.resolve() }}
        pollMs={20}
      />,
    )
    await new Promise((resolve) => setTimeout(resolve, 80))
    // 首輪懸掛時，輪詢不得開火：stale 整類不存在。
    expect(readText).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("motion-view-loading")).toBeTruthy()
    expect(screen.queryByTestId("motion-empty")).toBeNull()
    expect(screen.queryByTestId("motion-diagram")).toBeNull()
  })

  it("慢首輪結算即出圖：無假空態、無永久 loading", async () => {
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
