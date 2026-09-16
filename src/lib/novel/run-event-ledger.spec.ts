/**
 * run-event-ledger.spec.ts — 波1 EB-4 全局事件账本 spec 锁定.
 *
 * 覆盖: append-only 不变式（原账本不变/seq 严格单调/eventId 唯一/冻结）+
 * recordGateRunEvents + checkGateEventCoverage（未落=未发生）+ R-04 三态
 * 显示（undefined/skipped → NOT_EVALUATED，绝不 pass）+ 切片/replay/成本归因.
 *
 * @license MIT © QMAI
 */

import { describe, expect, it } from "vitest"
import {
  RUN_EVENT_LEDGER_SCHEMA_VERSION,
  RunEventIntegrityError,
  aggregateBudgetCost,
  appendRunEvent,
  appendRunEvents,
  checkGateEventCoverage,
  createRunEventLedger,
  eventsByReplayId,
  gateDisplayLabel,
  gateDisplayStatus,
  latestEventOf,
  listReplayIds,
  recordGateRunEvents,
  sliceRunEvents,
  type RunEventInput,
} from "./run-event-ledger"
import type { GateKey } from "./audit-taxonomy"
import type { GateRunStatus } from "./rule-stack"

function baseEvent(seq: number, overrides: Partial<RunEventInput> = {}): RunEventInput {
  return {
    seq,
    eventId: `evt-${seq}`,
    ts: "2026-09-12T00:00:00.000Z",
    kind: "stage",
    actor: "system",
    ...overrides,
  }
}

describe("append-only 不变式", () => {
  it("append 返回新账本，原账本不变且产物冻结", () => {
    const l0 = createRunEventLedger()
    const l1 = appendRunEvent(l0, baseEvent(0))
    expect(l0.events).toHaveLength(0)
    expect(l1.events).toHaveLength(1)
    expect(Object.isFrozen(l1)).toBe(true)
    expect(Object.isFrozen(l1.events)).toBe(true)
    expect(Object.isFrozen(l1.events[0])).toBe(true)
    expect(l1.schemaVersion).toBe(RUN_EVENT_LEDGER_SCHEMA_VERSION)
  })

  it("seq 必须严格单调（=数组下标），跳号/回退拒绝", () => {
    const l0 = createRunEventLedger()
    expect(() => appendRunEvent(l0, baseEvent(1))).toThrow(RunEventIntegrityError)
    const l1 = appendRunEvent(l0, baseEvent(0))
    expect(() => appendRunEvent(l1, baseEvent(0))).toThrow(RunEventIntegrityError)
    expect(() => appendRunEvent(l1, baseEvent(2))).toThrow(RunEventIntegrityError)
  })

  it("eventId 全账本唯一", () => {
    const l1 = appendRunEvent(createRunEventLedger(), baseEvent(0, { eventId: "dup" }))
    expect(() => appendRunEvent(l1, baseEvent(1, { eventId: "dup" }))).toThrow(RunEventIntegrityError)
  })

  it("schema 违反拒绝（strict：未知字段/负 seq/非法 kind）", () => {
    const l0 = createRunEventLedger()
    expect(() => appendRunEvent(l0, baseEvent(0, { seq: -1 } as Partial<RunEventInput>))).toThrow(
      RunEventIntegrityError,
    )
    expect(() =>
      appendRunEvent(l0, baseEvent(0, { kind: "unknown-kind" as RunEventInput["kind"] })),
    ).toThrow(RunEventIntegrityError)
    expect(() => appendRunEvent(l0, { ...baseEvent(0), rogue: true } as RunEventInput)).toThrow(
      RunEventIntegrityError,
    )
  })

  it("批量追加：seq 连续 + 中途违反整体拒绝（不半提交）", () => {
    const l0 = createRunEventLedger()
    const l3 = appendRunEvents(l0, [baseEvent(0), baseEvent(1), baseEvent(2)])
    expect(l3.events).toHaveLength(3)
    expect(() => appendRunEvents(l0, [baseEvent(0), baseEvent(5)])).toThrow(RunEventIntegrityError)
  })
})

describe("recordGateRunEvents（每门一条事件，含 skipped）", () => {
  const outcomes = [
    { gate: "consistency" as GateKey, status: "fail" as GateRunStatus, findingsCount: 2 },
    { gate: "anti_ai" as GateKey, status: "skipped" as GateRunStatus },
    { gate: "quality" as GateKey, status: "skipped" as GateRunStatus },
  ]

  it("三门产出三条 gate-run 事件，payload 形状正确", () => {
    const l = recordGateRunEvents(
      createRunEventLedger(),
      outcomes,
      { ts: "2026-09-12T01:00:00.000Z", replayId: "rp-1", bookId: "b1", chapterId: 3 },
    )
    expect(l.events).toHaveLength(3)
    expect(l.events[0].eventId).toBe("gate-run:0:consistency")
    expect(l.events[0].kind).toBe("gate-run")
    const payload0 = l.events[0].payload as { gate: string; status: string }
    expect(payload0.gate).toBe("consistency")
    expect(payload0.status).toBe("fail")
    const payload1 = l.events[1].payload as { status: string }
    expect(payload1.status).toBe("skipped")
  })

  it("追加后账本序号连续（seq 单调跨批保持）", () => {
    const l1 = appendRunEvent(createRunEventLedger(), baseEvent(0))
    const l2 = recordGateRunEvents(l1, [{ gate: "quality", status: "pass" }], {
      ts: "2026-09-12T01:00:00.000Z",
    })
    expect(l2.events).toHaveLength(2)
    expect(l2.events[1].seq).toBe(1)
    expect(l2.events[1].eventId).toBe("gate-run:1:quality")
  })
})

describe("checkGateEventCoverage（门结果未落事件 = 未发生）", () => {
  it("全部落账 → rate=1，无 uncovered", () => {
    let l = createRunEventLedger()
    const outcomes = [
      { gate: "consistency" as GateKey, status: "pass" as GateRunStatus },
      { gate: "anti_ai" as GateKey, status: "fail" as GateRunStatus },
    ]
    l = recordGateRunEvents(l, outcomes, { ts: "2026-09-12T01:00:00.000Z" })
    const cov = checkGateEventCoverage(outcomes, l)
    expect(cov.rate).toBe(1)
    expect(cov.uncoveredGates).toHaveLength(0)
    expect(cov.covered).toBe(2)
  })

  it("缺事件门 → uncovered + rate<1（G1 硬门违反可机械检出）", () => {
    let l = createRunEventLedger()
    l = recordGateRunEvents(l, [{ gate: "consistency", status: "pass" }], {
      ts: "2026-09-12T01:00:00.000Z",
    })
    const cov = checkGateEventCoverage(
      [
        { gate: "consistency" },
        { gate: "anti_ai" },
        { gate: "quality" },
      ] as readonly { gate: GateKey }[],
      l,
    )
    expect(cov.uncoveredGates).toEqual(["anti_ai", "quality"])
    expect(cov.rate).toBeCloseTo(1 / 3)
  })

  it("replayId 过滤下只认同链事件", () => {
    let l = createRunEventLedger()
    l = recordGateRunEvents(l, [{ gate: "consistency", status: "pass" }], {
      ts: "2026-09-12T01:00:00.000Z",
      replayId: "rp-A",
    })
    const covOther = checkGateEventCoverage([{ gate: "consistency" }], l, { replayId: "rp-B" })
    expect(covOther.uncoveredGates).toEqual(["consistency"])
    const covSame = checkGateEventCoverage([{ gate: "consistency" }], l, { replayId: "rp-A" })
    expect(covSame.rate).toBe(1)
  })
})

describe("R-04 显示三态（未评估 ≠ 通过）", () => {
  it("pass/fail 原样；skipped/undefined/null → not_evaluated", () => {
    expect(gateDisplayStatus("pass")).toBe("pass")
    expect(gateDisplayStatus("fail")).toBe("fail")
    expect(gateDisplayStatus("skipped")).toBe("not_evaluated")
    expect(gateDisplayStatus(undefined)).toBe("not_evaluated")
    expect(gateDisplayStatus(null)).toBe("not_evaluated")
  })

  it("不变量：仅真实 pass 才映射 pass（skipped 绝不渲染为通过）", () => {
    for (const status of ["skipped", undefined, null] as const) {
      expect(gateDisplayStatus(status as GateRunStatus | undefined | null)).not.toBe("pass")
    }
    expect(gateDisplayLabel("not_evaluated")).toBe("未评估")
    expect(gateDisplayLabel("pass")).toBe("通过")
    expect(gateDisplayLabel("fail")).toBe("未通过")
  })
})

describe("切片 / replay / 成本归因", () => {
  function buildLedger() {
    let l = createRunEventLedger()
    l = appendRunEvents(l, [
      baseEvent(0, { kind: "gate-run", bookId: "b1", replayId: "rp-1", ts: "2026-09-12T00:00:00.000Z", budgetCost: { tokens: 100, wallclockMs: 500, calls: 1 } }),
      baseEvent(1, { kind: "retrieval", bookId: "b1", replayId: "rp-1", ts: "2026-09-12T00:01:00.000Z" }),
      baseEvent(2, { kind: "gate-run", bookId: "b2", replayId: "rp-2", ts: "2026-09-12T00:02:00.000Z", budgetCost: { tokens: 50 } }),
      baseEvent(3, { kind: "accept", actor: "user", bookId: "b1", ts: "2026-09-12T00:03:00.000Z" }),
      baseEvent(4, { kind: "retry", bookId: "b1", replayId: "rp-1", ts: "2026-09-12T00:04:00.000Z", budgetCost: { tokens: 30, calls: 1 } }),
    ])
    return l
  }

  it("kind/bookId/replayId/时间窗切片，seq 升序保持", () => {
    const l = buildLedger()
    expect(sliceRunEvents(l, { kind: "gate-run" })).toHaveLength(2)
    expect(sliceRunEvents(l, { bookId: "b1" })).toHaveLength(4)
    expect(sliceRunEvents(l, { replayId: "rp-1" }).map((e) => e.seq)).toEqual([0, 1, 4])
    expect(sliceRunEvents(l, { sinceTs: "2026-09-12T00:02:00.000Z" }).map((e) => e.seq)).toEqual([2, 3, 4])
    expect(sliceRunEvents(l, { untilTs: "2026-09-12T00:01:00.000Z" }).map((e) => e.seq)).toEqual([0, 1])
    expect(sliceRunEvents(l, { kinds: ["accept", "retry"] })).toHaveLength(2)
  })

  it("eventsByReplayId + listReplayIds（首见序去重）", () => {
    const l = buildLedger()
    expect(eventsByReplayId(l, "rp-1").every((e) => e.replayId === "rp-1")).toBe(true)
    expect(listReplayIds(l)).toEqual(["rp-1", "rp-2"])
  })

  it("aggregateBudgetCost 逐事件求和（缺省字段计 0）", () => {
    const l = buildLedger()
    const sum = aggregateBudgetCost(sliceRunEvents(l, { replayId: "rp-1" }))
    expect(sum.tokens).toBe(130)
    expect(sum.wallclockMs).toBe(500)
    expect(sum.calls).toBe(2)
    expect(sum.eventsCounted).toBe(2)
  })

  it("latestEventOf 取最后一条指定类别", () => {
    const l = buildLedger()
    expect(latestEventOf(l, "gate-run")?.seq).toBe(2)
    expect(latestEventOf(l, "quota")).toBeNull()
  })
})