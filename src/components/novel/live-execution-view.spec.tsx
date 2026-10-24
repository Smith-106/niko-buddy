// @vitest-environment jsdom
/**
 * 接线契约：注入三路信号直接渲染（不碰磁盘）；三路全空时为诚实空态
 * （不编造运行状态）；磁盘装载中显示 loading；装载失败显式报错且保留旧数据。
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

import { appendRunEvents, createRunEventLedger, type RunEventInput, type TraceEntry } from "@/lib/novel"
import { useActivityStore, type ActivityItem } from "@/stores/activity-store"

import { LiveExecutionView } from "./live-execution-view"

afterEach(() => {
  cleanup()
  useActivityStore.setState({ items: [] })
})

const TS = "2026-10-19T00:00:00.000Z"

function eventsOf(inputs: RunEventInput[]) {
  return appendRunEvents(createRunEventLedger(), inputs).events
}

function traceEntryOf(partial: Partial<TraceEntry> & { callId: string; name: string }): TraceEntry {
  return {
    input: "{}",
    status: "done",
    startedAt: 1,
    title: partial.name,
    summary: "",
    details: [],
    ...partial,
  }
}

function activityOf(partial: Partial<ActivityItem> & { id: string; title: string }): ActivityItem {
  return {
    type: "ingest",
    status: "running",
    detail: "",
    filesWritten: [],
    createdAt: 1,
    ...partial,
  }
}

describe("LiveExecutionView", () => {
  it("注入三路信号直接渲染三区（不碰磁盘）", () => {
    render(
      <LiveExecutionView
        projectPath="/fake"
        ledgerEvents={eventsOf([
          { seq: 0, eventId: "e:0", ts: TS, kind: "retrieval", actor: "system" },
          { seq: 1, eventId: "e:1", ts: TS, kind: "generate", actor: "writer" },
        ])}
        traceEntries={[
          traceEntryOf({ callId: "c1", name: "reader", durationMs: 120 }),
          traceEntryOf({ callId: "c2", name: "writer", status: "error", error: "boom" }),
        ]}
        activities={[
          activityOf({ id: "a1", title: "导入书籍", detail: "3/10" }),
          activityOf({ id: "a2", title: "已完成检查", status: "done" }),
        ]}
      />,
    )
    expect(screen.getByTestId("live-execution-view")).toBeTruthy()
    // 运行中只收 running（done 不算运行）。
    expect(screen.getByTestId("live-running")).toBeTruthy()
    expect(screen.getAllByTestId("live-running-item")).toHaveLength(1)
    expect(screen.getByTestId("live-running").textContent).toContain("导入书籍")
    expect(screen.getByTestId("live-running").textContent).not.toContain("已完成检查")
    // 事件流含 kind/actor/ts。
    expect(screen.getByTestId("live-events")).toBeTruthy()
    expect(screen.getAllByTestId("live-event-item")).toHaveLength(2)
    expect(screen.getByTestId("live-events").textContent).toContain("retrieval")
    expect(screen.getByTestId("live-events").textContent).toContain("writer")
    expect(screen.getByTestId("live-events").textContent).toContain(TS)
    // 轨迹含 name/status/durationMs/error。
    expect(screen.getByTestId("live-trace")).toBeTruthy()
    expect(screen.getAllByTestId("live-trace-item")).toHaveLength(2)
    expect(screen.getByTestId("live-trace").textContent).toContain("reader")
    expect(screen.getByTestId("live-trace").textContent).toContain("120ms")
    expect(screen.getByTestId("live-trace").textContent).toContain("boom")
    expect(screen.queryByTestId("live-view-loading")).toBeNull()
    expect(screen.queryByTestId("live-empty")).toBeNull()
    // 頂部掛載管線動態拓撲（注入賬本 → 渲染圖）。
    expect(screen.getByTestId("pipeline-motion-panel")).toBeTruthy()
    expect(screen.getByTestId("motion-diagram")).toBeTruthy()
  })

  it("三路全空时为诚实空态（不编造运行状态）", () => {
    render(<LiveExecutionView projectPath="/fake" ledgerEvents={[]} traceEntries={[]} activities={[]} />)
    expect(screen.getByTestId("live-empty")).toBeTruthy()
    expect(screen.queryByTestId("live-running")).toBeNull()
    expect(screen.queryByTestId("live-events")).toBeNull()
    expect(screen.queryByTestId("live-trace")).toBeNull()
    expect(screen.queryByTestId("live-view-loading")).toBeNull()
  })

  it("事件流最多保留 30 条", () => {
    const inputs: RunEventInput[] = []
    for (let i = 0; i < 35; i += 1) {
      const minute = String(i).padStart(2, "0")
      inputs.push({ seq: i, eventId: `e:${i}`, ts: `2026-10-19T00:${minute}:00.000Z`, kind: "generate", actor: "system" })
    }
    render(<LiveExecutionView projectPath="/fake" ledgerEvents={eventsOf(inputs)} traceEntries={[]} activities={[]} />)
    expect(screen.getAllByTestId("live-event-item")).toHaveLength(30)
    // 留尾部 30 条：最旧的分钟 00..04 被裁掉，34 保留。
    expect(screen.getByTestId("live-events").textContent).not.toContain("T00:00:00")
    expect(screen.getByTestId("live-events").textContent).toContain("T00:34:00")
  })

  it("未注入 activities 时实时订阅 activity-store", () => {
    useActivityStore.setState({
      items: [activityOf({ id: "store-1", title: "店内运行", type: "query", detail: "查书" })],
    })
    render(
      <LiveExecutionView
        projectPath="/fake"
        ledgerEvents={eventsOf([{ seq: 0, eventId: "e:0", ts: TS, kind: "generate", actor: "system" }])}
        traceEntries={[]}
      />,
    )
    expect(screen.getByTestId("live-running")).toBeTruthy()
    expect(screen.getByTestId("live-running").textContent).toContain("店内运行")
  })

  it("磁盘装载中显示 loading（deps 悬挂不决议）", () => {
    render(<LiveExecutionView projectPath="/fake" deps={{ readText: () => new Promise(() => {}), appendText: () => Promise.resolve() }} />)
    expect(screen.getByTestId("live-view-loading")).toBeTruthy()
    expect(screen.queryByTestId("live-empty")).toBeNull()
    expect(screen.queryByTestId("live-events")).toBeNull()
  })

  it("装载失败显式报错；零数据时为空态而非假实况", async () => {
    render(
      <LiveExecutionView
        projectPath="/fake"
        deps={{
          readText: () => Promise.reject(new Error("disk gone")),
          appendText: () => Promise.resolve(),
        }}
      />,
    )
    const error = await screen.findByTestId("live-load-error")
    expect(error.textContent).toContain("保留上次数据")
    expect(screen.getByTestId("live-empty")).toBeTruthy()
    expect(screen.queryByTestId("live-running")).toBeNull()
  })
})

describe("LiveExecutionView 磁盘装载", () => {
  const LEDGER_LINE =
    '{"seq":0,"eventId":"e:0","ts":"2026-10-19T00:00:00.000Z","kind":"generate","actor":"system","evidenceRefs":[]}\n'

  it("第二次装载失败保留旧数据，且全程不写磁盘", async () => {
    let calls = 0
    const appendText = vi.fn(() => Promise.resolve())
    const readText = vi.fn(() => {
      calls += 1
      return calls === 1 ? Promise.resolve(LEDGER_LINE) : Promise.reject(new Error("disk gone"))
    })
    render(<LiveExecutionView projectPath="/fake" deps={{ readText, appendText }} pollMs={20} />)
    // 首次成功：事件流出现。
    await screen.findByTestId("live-events")
    expect(screen.getAllByTestId("live-event-item")).toHaveLength(1)
    // 后续轮询失败：错误条出现，旧事件保留。
    await screen.findByTestId("live-load-error")
    expect(screen.getByTestId("live-events")).toBeTruthy()
    expect(screen.getAllByTestId("live-event-item")).toHaveLength(1)
    expect(appendText).not.toHaveBeenCalled()
  })
})

describe("LiveExecutionView 串行轮询", () => {
  const LEDGER_LINE =
    '{"seq":0,"eventId":"e:0","ts":"2026-10-19T00:00:00.000Z","kind":"generate","actor":"system","evidenceRefs":[]}'

  it("首轮未结算不开第二枪：从构造上没有重叠请求", async () => {
    const readText = vi.fn(() => new Promise<string>(() => {}))
    render(
      <LiveExecutionView
        projectPath="/fake"
        deps={{ readText, appendText: () => Promise.resolve() }}
        pollMs={20}
      />,
    )
    await new Promise((resolve) => setTimeout(resolve, 80))
    // 首轮悬挂时，轮询不得开火：stale 整类不存在。
    expect(readText).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("live-view-loading")).toBeTruthy()
    expect(screen.queryByTestId("live-empty")).toBeNull()
    expect(screen.queryByTestId("live-events")).toBeNull()
  })

  it("慢首轮结算即出实况：无假空态、无永久 loading", async () => {
    const resolvers: Array<(value: string) => void> = []
    const readText = vi.fn(() => new Promise<string>((resolve) => { resolvers.push(resolve) }))
    render(
      <LiveExecutionView
        projectPath="/fake"
        deps={{ readText, appendText: () => Promise.resolve() }}
        pollMs={20}
      />,
    )
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(screen.getByTestId("live-view-loading")).toBeTruthy()
    for (const resolve of resolvers) resolve(LEDGER_LINE)
    await screen.findByTestId("live-events")
    expect(screen.getAllByTestId("live-event-item")).toHaveLength(1)
  })
})
