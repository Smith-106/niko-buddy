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
      // TASK-014：写侧本来就落这 9 个字段，丢字段的是读回端（面板）。这里把
      // 9 个字段全部钉住，防止以后有人「为了修复回放」去改写入形状。
      stopReason: "达到最大轮次",
      roundsUsed: 2,
      finalText: "完成",
      steps: [step({ callId: "c1", name: "read_chapter", result: "正文", at: 1, finishedAt: 3 })],
      activities: [
        { id: "a1", stageId: "s1", kind: "stage_output", title: "阶段产出", content: "片段", timestamp: 7 },
      ],
      now: 99,
    })
    await expect(saveTraceSnapshot("/proj", snapshot)).resolves.toBe(true)
    expect(mocks.createDirectory).toHaveBeenCalledWith("/proj/.novel/telemetry")
    const [path, payload] = mocks.writeFile.mock.calls[0] as unknown as [string, string]
    expect(path).toBe(`/proj/${MAIN_CONTROL_TRACE}`)
    const parsed = JSON.parse(payload)
    expect(parsed.entries[0]).toMatchObject({ name: "read_chapter", result: "正文", durationMs: 2 })
    // 9 个字段一个不少（fileVersion / goal / savedAt / ok / stopReason / roundsUsed / finalText / entries / activities）
    expect(Object.keys(parsed).sort()).toEqual(
      ["activities", "entries", "fileVersion", "finalText", "goal", "ok", "roundsUsed", "savedAt", "stopReason"],
    )

    mocks.readFile.mockResolvedValueOnce(payload)
    const loaded = await loadTraceSnapshot("/proj")
    expect(loaded?.goal).toBe("给第 5 章写开头")
    expect(loaded?.entries).toHaveLength(1)
    // 读回不丢字段：ok / stopReason / roundsUsed / finalText / activities 全在
    expect(loaded).toMatchObject({ ok: true, stopReason: "达到最大轮次", roundsUsed: 2, finalText: "完成" })
    expect(loaded?.activities).toEqual([{ kind: "stage_output", title: "阶段产出", summary: "片段", at: 7 }])
  })

  it("TASK-015：写入侧全字段快照 → 读回端 6 项逐字段比对（丢任一项即失败）", async () => {
    // 写侧造一份含全部 6 项的快照（activities / finalText / goal / ok / stopReason / roundsUsed），
    // 值一律取「非默认值」：读回端若把某项丢了（undefined / 0 / "" / 缺数组），下面的逐字段断言必红。
    const snapshot = buildTraceSnapshot({
      goal: "回放目标：第 9 章结尾",
      ok: false,
      stopReason: "工具调用轮次超限",
      roundsUsed: 3,
      finalText: "回放终稿正文",
      steps: [step({ callId: "c1", name: "read_chapter", result: "正文", at: 1, finishedAt: 3 })],
      activities: [
        { id: "a1", stageId: "s1", kind: "stage_output", title: "阶段产出", content: "片段", timestamp: 7 },
        { id: "a2", stageId: "s1", kind: "analysis", title: "共识写作", content: "席位: 3", timestamp: 8 },
      ],
      now: 123,
    })
    await expect(saveTraceSnapshot("/proj", snapshot)).resolves.toBe(true)
    const [, payload] = mocks.writeFile.mock.calls[0] as unknown as [string, string]

    mocks.readFile.mockResolvedValueOnce(payload)
    const loaded = await loadTraceSnapshot("/proj")
    expect(loaded).not.toBeNull()

    // ① goal —— 逐字段：断言的是这一项的值本身，不是「对象非空」。
    expect(loaded?.goal).toBe("回放目标：第 9 章结尾")
    // ② ok（注意 false 也是有效值：丢了会变 undefined，不会碰巧通过）
    expect(loaded?.ok).toBe(false)
    // ③ stopReason
    expect(loaded?.stopReason).toBe("工具调用轮次超限")
    // ④ roundsUsed
    expect(loaded?.roundsUsed).toBe(3)
    // ⑤ finalText
    expect(loaded?.finalText).toBe("回放终稿正文")
    // ⑥ activities —— 不只断言长度，逐项逐字段比对
    expect(loaded?.activities).toHaveLength(2)
    expect(loaded?.activities?.[0]).toEqual({
      kind: "stage_output",
      title: "阶段产出",
      summary: "片段",
      at: 7,
    })
    expect(loaded?.activities?.[1]).toEqual({
      kind: "analysis",
      title: "共识写作",
      summary: "席位: 3",
      at: 8,
    })

    // 6 项键一个不少：读回端若被改成「挑几个字段构造新对象」（R07 的原始 bug），这里直接红。
    expect(Object.keys(loaded ?? {}).sort()).toEqual(
      [
        "activities",
        "entries",
        "fileVersion",
        "finalText",
        "goal",
        "ok",
        "roundsUsed",
        "savedAt",
        "stopReason",
      ],
    )
  })

  it("读损坏或缺字段的快照返回 null", async () => {
    mocks.readFile.mockResolvedValueOnce("{bad json")
    await expect(loadTraceSnapshot("/proj")).resolves.toBeNull()
    // fileVersion 3 是不认识的未来版本（1|2 才接受）
    mocks.readFile.mockResolvedValueOnce(JSON.stringify({ fileVersion: 3, entries: [] }))
    await expect(loadTraceSnapshot("/proj")).resolves.toBeNull()
  })

  it("v1 老快照仍可读（升级后第一次回放不得显示空轨迹）", async () => {
    mocks.readFile.mockResolvedValueOnce(
      JSON.stringify({ fileVersion: 1, goal: "旧目标", savedAt: 1, ok: true, roundsUsed: 0, finalText: "", entries: [] }),
    )
    const loaded = await loadTraceSnapshot("/proj")
    expect(loaded).not.toBeNull()
    expect(loaded?.fileVersion).toBe(1)
    expect(loaded?.goal).toBe("旧目标")
    expect(loaded?.activities).toBeUndefined()
  })

  it("v2 快照带 activities 投影：content 截断 240 字 + '…'，全文不入快照", async () => {
    const longContent = "x".repeat(300)
    const snapshot = buildTraceSnapshot({
      goal: "g",
      ok: true,
      roundsUsed: 1,
      finalText: "done",
      steps: [],
      activities: [
        { id: "a1", stageId: "s1", kind: "stage_output", title: "阶段产出", content: longContent, timestamp: 1234 },
      ],
      now: 99,
    })
    expect(snapshot.fileVersion).toBe(2)
    expect(snapshot.activities).toHaveLength(1)
    expect(snapshot.activities?.[0]).toMatchObject({ kind: "stage_output", title: "阶段产出", at: 1234 })
    expect(snapshot.activities?.[0].summary).toHaveLength(241)
    expect(snapshot.activities?.[0].summary.endsWith("…")).toBe(true)
    // R-08 体积纪律：全文绝不进快照
    expect(JSON.stringify(snapshot)).not.toContain(longContent)
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
