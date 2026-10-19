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
describe("PipelineMotionView 首輪慢於輪詢", () => {
  const LEDGER_LINE =
    '{"seq":0,"eventId":"e:0","ts":"2026-10-19T00:00:00.000Z","kind":"generate","actor":"system","evidenceRefs":[]}'

  it("首輪被輪詢超車：新數據照樣畫出來，不許永久 loading", async () => {
    const resolvers: Array<(value: string) => void> = []
    const readText = vi.fn(() => new Promise<string>((resolve) => { resolvers.push(resolve) }))
    render(
      <PipelineMotionView
        projectPath="/fake"
        deps={{ readText, appendText: () => Promise.resolve() }}
        pollMs={20}
      />,
    )
    // 等首輪＋至少一輪輪詢都掛起，再一次性全部放行：
    // 首輪已過期（應被丟棄），最新一輪寫入數據。
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(resolvers.length).toBeGreaterThanOrEqual(2)
    for (const resolve of resolvers) resolve(LEDGER_LINE)
    await screen.findByTestId("motion-diagram")
    expect(screen.getByTestId("motion-node-draft").getAttribute("data-state")).toBe("current")
  })
})
