/**
 * deep-chapter-gate-evidence.spec.ts — 三门证据落账契约。
 *
 * 覆盖（对应改进计划 A 项验收标准）：
 *   1. 三门顺序固定 Consistency > Anti-AI > Quality；
 *   2. pending（未评估）落 skipped，绝不落 pass（R-04）；
 *   3. findings / escalated 计数进 payload；
 *   4. IO 失败非致命（只回 error，不抛）；
 *   5. resume 意图进 evidenceRefs（续写与从头写可审计区分）；
 *   6. 端到端可读：落账事件经只读派生后能被首页证据看板读到真实值。
 */
import { describe, expect, it, vi } from "vitest"

// 覆盖增补：recordChapterGateEvidence 的「未注入 deps → 生产默认 store」分支需要落在
// @/commands/fs 边界；这里只拦在 fs 上（默认 fs 依赖的读写行为），被测模块与账本逻辑不动。
const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  createDirectory: vi.fn(),
}))
vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: (...args: unknown[]) => fsMocks.readFile(...args),
    writeFileAtomic: (...args: unknown[]) => fsMocks.writeFileAtomic(...args),
    createDirectory: (...args: unknown[]) => fsMocks.createDirectory(...args),
  }
})

import type { DeepChapterDecisionGates, DeepChapterDecisionGate } from "./deep-chapter-decision-gates"
import {
  MAIN_CONTROL_RERUN_INTENT,
  buildChapterGateRunEvents,
  mapDecisionGateToRunStatus,
  readLatestGateRunGroup,
  recordChapterGateEvidence,
} from "./deep-chapter-gate-evidence"
import { appendRunEvent, createRunEventLedger, type RunEventKind } from "./run-event-ledger"
import { deriveEvidenceGateStatuses } from "./dashboard-evidence"
import type { NovelReviewResult } from "./review-adapter"

function finding(severity: "error" | "warning", type = "consistency"): NovelReviewResult {
  return { type, severity, description: `${type}-${severity}-desc`, suggestion: "s" } as unknown as NovelReviewResult
}

function gate(status: "pending" | "passed" | "failed", findings: NovelReviewResult[] = []): DeepChapterDecisionGate {
  return {
    status,
    verdict: status === "failed" ? "fail" : status === "passed" ? "pass" : "pending",
    findings,
    repair_suggestions: [],
    retry_count: 0,
    updated_at: "2026-10-18T00:00:00.000Z",
  }
}

function gates(overrides: Partial<DeepChapterDecisionGates> = {}): DeepChapterDecisionGates {
  return {
    consistency: gate("passed"),
    anti_ai: gate("warning" as unknown as "passed"),
    quality: gate("pending"),
    overall: "warning",
    ...overrides,
  } as DeepChapterDecisionGates
}

describe("mapDecisionGateToRunStatus（R-04：未评估绝不落 pass）", () => {
  it("passed→pass / failed→fail / pending→skipped", () => {
    expect(mapDecisionGateToRunStatus("passed")).toBe("pass")
    expect(mapDecisionGateToRunStatus("failed")).toBe("fail")
    expect(mapDecisionGateToRunStatus("pending")).toBe("skipped")
  })
})

describe("buildChapterGateRunEvents", () => {
  it("三门各一条且顺序固定，payload 带 findings/escalated 计数", () => {
    const events = buildChapterGateRunEvents({
      projectPath: "/p",
      decisionGates: gates({
        consistency: gate("failed", [finding("error"), finding("warning")]),
        anti_ai: gate("passed", [finding("warning", "anti_ai")]),
      }),
      chapterNumber: 7,
      retryCount: 2,
    })
    expect(events.map((e) => (e.payload as { gate: string }).gate)).toEqual(["consistency", "anti_ai", "quality"])
    expect(events.map((e) => (e.payload as { status: string }).status)).toEqual(["fail", "pass", "skipped"])
    const consistency = events[0]?.payload as { findingsCount: number; escalatedCount: number }
    expect(consistency.findingsCount).toBe(2)
    expect(consistency.escalatedCount).toBe(1)
    expect(events.every((e) => e.kind === "gate-run")).toBe(true)
    expect(events[0]?.chapterId).toBe(7)
  })

  it("resume 意图与章节/重试次数进 evidenceRefs（续写可审计区分）", () => {
    const events = buildChapterGateRunEvents({
      projectPath: "/p",
      decisionGates: gates(),
      chapterNumber: 3,
      retryCount: 1,
      intent: "resume",
    })
    expect(events[0]?.evidenceRefs).toEqual(["chapter:3", "intent:resume", "retry:1"])
  })

  it("无 chapterNumber/intent 时不造假 ref", () => {
    const events = buildChapterGateRunEvents({ projectPath: "/p", decisionGates: gates() })
    expect(events[0]?.evidenceRefs).toEqual([])
  })
})

describe("recordChapterGateEvidence", () => {
  it("注入 append：一次落三门，ts 由时间源给定", async () => {
    const appendEvents = vi.fn(async () => createRunEventLedger())
    const result = await recordChapterGateEvidence(
      { projectPath: "/p", decisionGates: gates(), chapterNumber: 1 },
      {
        appendEvents: appendEvents as never,
        storeDeps: { readText: async () => null, appendText: async () => {}, ensureDir: async () => {} },
        now: () => new Date("2026-10-18T01:02:03.000Z"),
      },
    )
    expect(result.error).toBeUndefined()
    expect(result.recorded).toEqual(["consistency", "anti_ai", "quality"])
    expect(appendEvents).toHaveBeenCalledTimes(1)
    const events = (appendEvents.mock.calls[0] as unknown as unknown[])[2] as Array<{ ts: string }>
    expect(events).toHaveLength(3)
    expect(events[0]?.ts).toBe("2026-10-18T01:02:03.000Z")
  })

  it("IO 失败非致命：回 error 不抛", async () => {
    const result = await recordChapterGateEvidence(
      { projectPath: "/p", decisionGates: gates() },
      {
        appendEvents: (async () => {
          throw new Error("disk-full")
        }) as never,
        storeDeps: { readText: async () => null, appendText: async () => {}, ensureDir: async () => {} },
      },
    )
    expect(result.error).toContain("disk-full")
    expect(result.recorded).toHaveLength(3)
  })

  it("未指定 projectPath → 不落账（零事件）", async () => {
    const appendEvents = vi.fn()
    const result = await recordChapterGateEvidence(
      { projectPath: "", decisionGates: gates() },
      { appendEvents: appendEvents as never },
    )
    expect(result.recorded).toEqual([])
    expect(appendEvents).not.toHaveBeenCalled()
  })

  // 覆盖增补：未注入 appendEvents/storeDeps 时必须落到生产默认 store
  //（createFsRunEventLedgerStoreDeps + appendRunEventsToStore），仍返回 recorded/ts。
  it("未注入 deps → 走生产默认账本 store（写 .novel/run-events.jsonl，三门三行）", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT: run-events"))
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)
    fsMocks.createDirectory.mockResolvedValue(undefined)

    const result = await recordChapterGateEvidence(
      { projectPath: "/proj", decisionGates: gates(), chapterNumber: 9 },
      { now: () => new Date("2026-10-18T02:00:00.000Z") },
    )

    expect(result.error).toBeUndefined()
    expect(result.recorded).toEqual(["consistency", "anti_ai", "quality"])
    expect(result.ts).toBe("2026-10-18T02:00:00.000Z")

    const paths = fsMocks.writeFileAtomic.mock.calls.map((call) => String(call[0]))
    expect(paths.some((p) => p.endsWith("/.novel/run-events.jsonl"))).toBe(true)
    const lines = fsMocks.writeFileAtomic.mock.calls
      .map((call) => String(call[1]))
      .join("")
      .split("\n")
      .filter(Boolean)
    expect(lines).toHaveLength(3)
    const written = lines.map((line) => JSON.parse(line) as { kind: string; ts: string; payload: { gate: string } })
    expect(written.map((e) => e.kind)).toEqual(["gate-run", "gate-run", "gate-run"])
    expect(written.map((e) => e.payload.gate)).toEqual(["consistency", "anti_ai", "quality"])
    expect(written.every((e) => e.ts === "2026-10-18T02:00:00.000Z")).toBe(true)
  })

  it("端到端：落账事件经只读派生后，首页三门读到真实 status（不再恒未评估）", async () => {
    const ledger = (() => {
      let next = createRunEventLedger()
      const events = buildChapterGateRunEvents({
        projectPath: "/p",
        decisionGates: gates({
          consistency: gate("passed"),
          anti_ai: gate("failed", [finding("error", "anti_ai")]),
          quality: gate("pending"),
        }),
        chapterNumber: 2,
      })
      for (const event of events) {
        next = appendRunEvent(next, { ...event, ts: "2026-10-18T00:00:00.000Z", seq: next.events.length, eventId: `e${next.events.length}` })
      }
      return next
    })()
    const statuses = deriveEvidenceGateStatuses(ledger)
    expect(statuses.consistency).toBe("pass")
    expect(statuses.anti_ai).toBe("fail")
    expect(statuses.quality).toBe("skipped")
  })
})

describe("readLatestGateRunGroup（B9：回读上一次运行结论）", () => {
  /** 按真实写入路径落账一组事件（同一批共享同一 ts）。 */
  function appendGroup(
    ledger: ReturnType<typeof createRunEventLedger>,
    events: ReturnType<typeof buildChapterGateRunEvents>,
    ts: string,
  ) {
    let next = ledger
    for (const event of events) {
      const seq = next.events.length
      next = appendRunEvent(next, { ...event, ts, seq, eventId: `gate-run:${seq}:${next.events.length}` })
    }
    return next
  }

  it("按 intent 过滤回读：能取回上一次 main-control-rerun 的三门结论（含 ts/chapterId）", () => {
    const rerun = buildChapterGateRunEvents({
      projectPath: "/p",
      decisionGates: gates({ consistency: gate("failed", [finding("error")]), anti_ai: gate("passed"), quality: gate("pending") }),
      chapterNumber: 4,
      bookId: "book-a",
      intent: MAIN_CONTROL_RERUN_INTENT,
    })
    const ledger = appendGroup(createRunEventLedger(), rerun, "2026-10-18T00:10:00.000Z")

    const group = readLatestGateRunGroup(ledger, { intent: MAIN_CONTROL_RERUN_INTENT })
    expect(group).not.toBeNull()
    expect(group?.ts).toBe("2026-10-18T00:10:00.000Z")
    expect(group?.intent).toBe(MAIN_CONTROL_RERUN_INTENT)
    expect(group?.chapterId).toBe(4)
    expect(group?.bookId).toBe("book-a")
    expect(group?.rows.map((row) => [row.gate, row.status])).toEqual([
      ["consistency", "fail"],
      ["anti_ai", "pass"],
      ["quality", "skipped"],
    ])
  })

  it("正式章事件随后写入也不影响带 intent 的回读（历史面稳定 = 页签切回来结论还在）", () => {
    const rerun = buildChapterGateRunEvents({
      projectPath: "/p",
      decisionGates: gates({ consistency: gate("passed") }),
      chapterNumber: 4,
      intent: MAIN_CONTROL_RERUN_INTENT,
    })
    const formal = buildChapterGateRunEvents({
      projectPath: "/p",
      decisionGates: gates({ consistency: gate("failed", [finding("error")]) }),
      chapterNumber: 4,
    })
    const ledger = appendGroup(
      appendGroup(createRunEventLedger(), rerun, "2026-10-18T00:10:00.000Z"),
      formal,
      "2026-10-18T00:20:00.000Z",
    )
    const group = readLatestGateRunGroup(ledger, { intent: MAIN_CONTROL_RERUN_INTENT })
    expect(group?.ts).toBe("2026-10-18T00:10:00.000Z")
    expect(group?.rows.find((row) => row.gate === "consistency")?.status).toBe("pass")
    // 不带过滤 → 取最近一次（正式章）
    expect(readLatestGateRunGroup(ledger)?.ts).toBe("2026-10-18T00:20:00.000Z")
  })

  it("空账本 / 无匹配意图 → null（诚实缺失，不臆造历史）", () => {
    expect(readLatestGateRunGroup(createRunEventLedger())).toBeNull()
    expect(readLatestGateRunGroup(createRunEventLedger(), { intent: MAIN_CONTROL_RERUN_INTENT })).toBeNull()
    const formalOnly = appendGroup(
      createRunEventLedger(),
      buildChapterGateRunEvents({ projectPath: "/p", decisionGates: gates(), chapterNumber: 1 }),
      "2026-10-18T00:00:00.000Z",
    )
    expect(readLatestGateRunGroup(formalOnly, { intent: MAIN_CONTROL_RERUN_INTENT })).toBeNull()
  })
})

// 覆盖增补：回读的「非 gate-run 夹层 / 同 ts 不同意图 / gate 越界 / 缺字段」降级路径。
// 账本是 append-only 的共享文件（retrieval/stage 等异类事件与门控事件混写），
// 回读必须只看 gate-run 且只认 anchor 的 (ts, intent) 组，否则「未评估」会被
// 异类事件拉成假结论。
describe("readLatestGateRunGroup 覆盖增补：混写账本的降级路径", () => {
  type RawEvent = {
    ts: string
    kind: RunEventKind
    chapterId?: number
    bookId?: string
    payload?: Record<string, unknown>
  }

  function appendRaw(ledger: ReturnType<typeof createRunEventLedger>, event: RawEvent) {
    const seq = ledger.events.length
    return appendRunEvent(ledger, {
      seq,
      eventId: `${event.kind}:${seq}`,
      ts: event.ts,
      kind: event.kind,
      actor: "system",
      chapterId: event.chapterId,
      bookId: event.bookId,
      evidenceRefs: [],
      payload: event.payload,
    })
  }

  function appendGateGroup(
    ledger: ReturnType<typeof createRunEventLedger>,
    events: ReturnType<typeof buildChapterGateRunEvents>,
    ts: string,
  ) {
    let next = ledger
    for (const event of events) {
      const seq = next.events.length
      next = appendRunEvent(next, { ...event, ts, seq, eventId: `gate-run:${seq}` })
    }
    return next
  }

  const TS = "2026-10-18T00:10:00.000Z"

  it("异类事件夹在同一 ts 的组里：反向定锚与正向归组都跳过它", () => {
    const group = buildChapterGateRunEvents({
      projectPath: "/p",
      decisionGates: gates({ consistency: gate("passed"), anti_ai: gate("failed", [finding("error")]) }),
      chapterNumber: 5,
    })
    const ledger = appendRaw(appendGateGroup(createRunEventLedger(), group, TS), {
      ts: TS,
      kind: "stage",
      chapterId: 5,
      payload: { stage: "write" },
    })

    const read = readLatestGateRunGroup(ledger)
    expect(read?.ts).toBe(TS)
    // stage 事件既不能成为 anchor，也不能污染 rows / chapterId。
    expect(read?.rows.map((row) => [row.gate, row.status])).toEqual([
      ["consistency", "pass"],
      ["anti_ai", "fail"],
      ["quality", "skipped"],
    ])
    expect(read?.chapterId).toBe(5)
    expect(read?.intent).toBeUndefined()
  })

  it("同 ts 但不同 intent：只归组 anchor 的 intent（另一意图的同刻事件不分串）", () => {
    const formal = buildChapterGateRunEvents({
      projectPath: "/p",
      decisionGates: gates({ consistency: gate("passed") }),
      chapterNumber: 1,
    })
    const rerun = buildChapterGateRunEvents({
      projectPath: "/p",
      decisionGates: gates({ consistency: gate("failed", [finding("error")]) }),
      chapterNumber: 2,
      intent: MAIN_CONTROL_RERUN_INTENT,
    })
    const ledger = appendGateGroup(appendGateGroup(createRunEventLedger(), formal, TS), rerun, TS)

    const read = readLatestGateRunGroup(ledger)
    expect(read?.intent).toBe(MAIN_CONTROL_RERUN_INTENT)
    expect(read?.ts).toBe(TS)
    // anchor = rerun（同刻后写），故结论取 rerun 的 fail/chapter 2，而不是正式章的 pass/chapter 1。
    expect(read?.chapterId).toBe(2)
    expect(read?.rows.find((row) => row.gate === "consistency")?.status).toBe("fail")
    // 带 intent 过滤时读同一组；带错 intent 过滤则无锚 → null（不借用同刻别的意图）。
    expect(readLatestGateRunGroup(ledger, { intent: MAIN_CONTROL_RERUN_INTENT })?.chapterId).toBe(2)
    expect(readLatestGateRunGroup(ledger, { intent: "unknown-intent" })).toBeNull()
  })

  it("gate 不在三门之内 → 丢弃该行；缺 findingsCount / chapterId 时回退不缺字段的行", () => {
    const group = buildChapterGateRunEvents({
      projectPath: "/p",
      decisionGates: gates({ consistency: gate("passed"), anti_ai: gate("passed"), quality: gate("passed") }),
      chapterNumber: 6,
      bookId: "book-z",
    })
    let ledger = appendGateGroup(createRunEventLedger(), group, TS)
    // 越界 gate（注册表新增投影名混进 payload）：不得渲染为第四行。
    ledger = appendRaw(ledger, { ts: TS, kind: "gate-run", chapterId: 6, payload: { gate: "graph_entity_pages", status: "pass" } })
    // 合法 gate 但缺 findingsCount / chapterId：行可读（计数回退 0），章节号沿用组内已有值。
    ledger = appendRaw(ledger, { ts: TS, kind: "gate-run", payload: { gate: "quality", status: "fail" } })

    const read = readLatestGateRunGroup(ledger)
    expect(read?.rows.map((row) => row.gate)).toEqual(["consistency", "anti_ai", "quality"])
    const quality = read?.rows.find((row) => row.gate === "quality")
    expect(quality?.status).toBe("fail")
    expect(quality?.findingsCount).toBe(0)
    expect(read?.chapterId).toBe(6)
    expect(read?.bookId).toBe("book-z")
  })
})

describe("buildChapterGateRunEvents 覆盖增补：gate 缺 findings 字段", () => {
  it("findings 缺省 → findingsCount/escalatedCount 均为 0（不抛）", () => {
    const withoutFindings = { ...gate("passed"), findings: undefined } as unknown as DeepChapterDecisionGate
    const events = buildChapterGateRunEvents({
      projectPath: "/p",
      decisionGates: gates({ consistency: withoutFindings }),
    })
    const payload = events[0]?.payload as { findingsCount: number; escalatedCount: number }
    expect(payload.findingsCount).toBe(0)
    expect(payload.escalatedCount).toBe(0)
  })
})
