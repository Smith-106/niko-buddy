import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  writeFile: vi.fn(async () => undefined),
  readFile: vi.fn(async () => ""),
  createDirectory: vi.fn(async () => undefined),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, ...mocks }
})

const {
  MAIN_CONTROL_TRACE,
  buildTraceEntries,
  buildTraceSnapshot,
  loadTraceSnapshot,
  saveTraceSnapshot,
  toWorkflowToolCalls,
  traceSnapshotPath,
} = await import("./main-control-trace")
import type { MainControlStep } from "./main-control"

function step(overrides: Partial<MainControlStep> & Pick<MainControlStep, "callId" | "name">): MainControlStep {
  return {
    params: {},
    status: "done",
    at: 1000,
    ...overrides,
  }
}

beforeEach(() => {
  mocks.writeFile.mockClear()
  mocks.createDirectory.mockClear()
})

describe("toWorkflowToolCalls", () => {
  it("映射状态并保留起止时间", () => {
    const calls = toWorkflowToolCalls([
      step({ callId: "c1", name: "read_chapter", at: 10, finishedAt: 42 }),
      step({ callId: "c2", name: "write_chapter", status: "error", error: "磁盘满" }),
    ])
    expect(calls[0]).toMatchObject({ id: "c1", status: "done", startedAt: 10, finishedAt: 42 })
    expect(calls[1]).toMatchObject({ status: "error", result: "磁盘满" })
  })
})

describe("buildTraceEntries", () => {
  it("每步带输入摘要、耗时、语义标题与原始结果", () => {
    const entries = buildTraceEntries([
      step({
        callId: "c1",
        name: "read_chapter",
        params: { name: "第3章" },
        result: "正文全文",
        at: 1000,
        finishedAt: 1250,
      }),
      step({ callId: "c2", name: "write_chapter", status: "error", error: "写入草稿失败" }),
    ])
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      callId: "c1",
      name: "read_chapter",
      durationMs: 250,
      status: "done",
      result: "正文全文",
    })
    expect(entries[0].input).toContain("第3章")
    expect(entries[0].title.length).toBeGreaterThan(0)
    expect(entries[1]).toMatchObject({ status: "error", error: "写入草稿失败" })
    expect(entries[1].durationMs).toBeUndefined()
  })

  it("无参数时给出显式占位，超长参数被截断", () => {
    const entries = buildTraceEntries([
      step({ callId: "a", name: "list_chapters" }),
      step({ callId: "b", name: "load_context", params: { q: "x".repeat(400) } }),
    ])
    expect(entries[0].input).toContain("无参数")
    expect(entries[1].input.length).toBeLessThanOrEqual(241)
  })
})

describe("快照持久化", () => {
  it("路径固定在 .novel/telemetry 下", () => {
    expect(traceSnapshotPath("/proj/")).toBe(`/proj/${MAIN_CONTROL_TRACE}`)
    expect(MAIN_CONTROL_TRACE).toBe(".novel/telemetry/main-control-trace.json")
  })

  it("写入快照后可读回并完整回放每一步", async () => {
    const snapshot = buildTraceSnapshot({
      goal: "给第 5 章写开头",
      ok: true,
      roundsUsed: 2,
      finalText: "完成",
      steps: [step({ callId: "c1", name: "read_chapter", result: "正文", at: 1, finishedAt: 3 })],
      now: 99,
    })
    await expect(saveTraceSnapshot("/proj", snapshot)).resolves.toBe(true)
    expect(mocks.createDirectory).toHaveBeenCalledWith("/proj/.novel/telemetry")
    const [path, payload] = mocks.writeFile.mock.calls[0] as unknown as [string, string]
    expect(path).toBe(`/proj/${MAIN_CONTROL_TRACE}`)
    const parsed = JSON.parse(payload)
    expect(parsed.entries[0]).toMatchObject({ name: "read_chapter", result: "正文", durationMs: 2 })

    mocks.readFile.mockResolvedValueOnce(payload)
    const loaded = await loadTraceSnapshot("/proj")
    expect(loaded?.goal).toBe("给第 5 章写开头")
    expect(loaded?.entries).toHaveLength(1)
  })

  it("读损坏或缺字段的快照返回 null", async () => {
    mocks.readFile.mockResolvedValueOnce("{bad json")
    await expect(loadTraceSnapshot("/proj")).resolves.toBeNull()
    mocks.readFile.mockResolvedValueOnce(JSON.stringify({ fileVersion: 2, entries: [] }))
    await expect(loadTraceSnapshot("/proj")).resolves.toBeNull()
  })

  it("写盘失败不抛（遥测不得阻断主流程）", async () => {
    mocks.writeFile.mockRejectedValueOnce(new Error("EACCES"))
    const snapshot = buildTraceSnapshot({
      goal: "g",
      ok: false,
      roundsUsed: 0,
      finalText: "",
      steps: [],
      now: 1,
    })
    await expect(saveTraceSnapshot("/proj", snapshot)).resolves.toBe(false)
  })
})
