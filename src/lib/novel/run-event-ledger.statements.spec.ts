/**
 * run-event-ledger.statements.spec.ts — 覆盖率战役增量（statements/branches 尾段）。
 *
 * 只补既有 run-event-ledger.spec.ts 未触达的行为面：
 *   - readGateRunPayload 的 payload 形状守卫（gate/status 非字符串 → null）
 *   - checkGateEventCoverage 中「有 gate-run 事件但 payload 形状不符 = 未落」的覆盖缺口
 *   - sliceRunEvents 四维过滤的 chapterId / sessionId / modelId 命中与失配边
 *   - aggregateBudgetCost 对缺省字段（只有部分成本字段携带）的归零语义
 *
 * @license MIT © Niko Buddy
 */

import { describe, expect, it } from "vitest"

import type { GateKey } from "./audit-taxonomy"
import {
  aggregateBudgetCost,
  appendRunEvents,
  checkGateEventCoverage,
  createRunEventLedger,
  readGateRunPayload,
  sliceRunEvents,
  type RunEventInput,
} from "./run-event-ledger"

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

describe("readGateRunPayload / payload 形状守卫", () => {
  it("gate 非字符串 → null（不放行伪造口径）", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      baseEvent(0, { kind: "gate-run", payload: { gate: 42, status: "pass" } }),
    ])
    expect(readGateRunPayload(ledger.events[0]!)).toBeNull()
  })

  it("status 非字符串 → null", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      baseEvent(0, { kind: "gate-run", payload: { gate: "consistency", status: { raw: "pass" } } }),
    ])
    expect(readGateRunPayload(ledger.events[0]!)).toBeNull()
  })

  it("形状合法 → 原样返回 gate/status（类型化视图）", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      baseEvent(0, { kind: "gate-run", payload: { gate: "anti_ai", status: "fail", findingsCount: 3 } }),
    ])
    const payload = readGateRunPayload(ledger.events[0]!)
    expect(payload).toEqual({ gate: "anti_ai", status: "fail", findingsCount: 3 })
  })
})

describe("checkGateEventCoverage / 形状不符 = 未落事件", () => {
  it("gate-run 事件 payload 形状不符的门仍算未覆盖（rate < 1）", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      baseEvent(0, { kind: "gate-run", payload: { gate: "consistency", status: "pass" } }),
      // 形状不符：status 缺失 → readGateRunPayload 返回 null，不计入已记录
      baseEvent(1, { kind: "gate-run", payload: { gate: "anti_ai" } }),
    ])
    const coverage = checkGateEventCoverage(
      [{ gate: "consistency" as GateKey }, { gate: "anti_ai" as GateKey }],
      ledger,
    )
    expect(coverage.totalGates).toBe(2)
    expect(coverage.covered).toBe(1)
    expect(coverage.uncoveredGates).toEqual(["anti_ai"])
    expect(coverage.rate).toBe(0.5)
  })
})

describe("sliceRunEvents / 四维过滤边", () => {
  const ledger = appendRunEvents(createRunEventLedger(), [
    baseEvent(0, { kind: "generate", chapterId: 3, sessionId: "s-1", modelId: "m-a" }),
    baseEvent(1, { kind: "retrieval", chapterId: 4, sessionId: "s-2", modelId: "m-b" }),
  ])

  it("chapterId 过滤：命中保留、失配剔除", () => {
    expect(sliceRunEvents(ledger, { chapterId: 3 }).map((e) => e.eventId)).toEqual(["evt-0"])
    expect(sliceRunEvents(ledger, { chapterId: 9 })).toEqual([])
  })

  it("sessionId 过滤：命中保留、失配剔除", () => {
    expect(sliceRunEvents(ledger, { sessionId: "s-2" }).map((e) => e.eventId)).toEqual(["evt-1"])
    expect(sliceRunEvents(ledger, { sessionId: "s-9" })).toEqual([])
  })

  it("modelId 过滤：命中保留、失配剔除", () => {
    expect(sliceRunEvents(ledger, { modelId: "m-a" }).map((e) => e.eventId)).toEqual(["evt-0"])
    expect(sliceRunEvents(ledger, { modelId: "m-z" })).toEqual([])
  })

  it("多维组合过滤取交集", () => {
    expect(sliceRunEvents(ledger, { chapterId: 3, sessionId: "s-1", modelId: "m-a" })).toHaveLength(1)
    expect(sliceRunEvents(ledger, { chapterId: 3, sessionId: "s-2" })).toEqual([])
  })
})

describe("aggregateBudgetCost / 缺省字段归零", () => {
  it("只携带部分成本字段的事件按缺省 0 计入 eventsCounted", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      baseEvent(0, { kind: "generate", budgetCost: { wallclockMs: 1200 } }),
      baseEvent(1, { kind: "generate", budgetCost: {} }),
      // 未携带 budgetCost：不参与聚合
      baseEvent(2, { kind: "stage" }),
    ])
    const summary = aggregateBudgetCost(ledger.events)
    expect(summary).toEqual({ tokens: 0, wallclockMs: 1200, calls: 0, eventsCounted: 2 })
  })
})
