/**
 * gate-run-authority.spec.ts — 账本层唯一权威过滤器（防污染单源）测试。
 *
 * 覆盖：意图解析（intent:<name>）/ 判据（无 intent = 权威、命中注册表 = 非权威、
 * 非 gate-run = false）/ 自定义排除表替换语义 / 整本视图（只剔非权威 gate-run，
 * 其它 kind 与账本全序原样保留）/ schemaVersion 保持。
 *
 * @license MIT © Niko Buddy
 */

import { describe, expect, it } from "vitest"
import { appendRunEvents, createRunEventLedger, type RunEventInput } from "./run-event-ledger"
import {
  GATE_RUN_INTENT_REF_PREFIX,
  MAIN_CONTROL_RERUN_INTENT,
  NON_AUTHORITATIVE_GATE_RUN_INTENTS,
  isAuthoritativeGateRun,
  readGateRunIntent,
  selectAuthoritativeEvents,
  toAuthoritativeLedger,
} from "./gate-run-authority"

const TS = "2026-10-18T00:00:00.000Z"

function gateRun(seq: number, gate: string, status: "pass" | "fail" | "skipped", extra?: Partial<RunEventInput>): RunEventInput {
  return {
    seq,
    eventId: `gate-run:${seq}:${gate}`,
    ts: TS,
    kind: "gate-run",
    actor: "system",
    payload: { gate, status },
    ...extra,
  }
}

describe("readGateRunIntent（意图解析）", () => {
  it("取 evidenceRefs 里的 intent:<name>；无 → undefined；空值忽略", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateRun(0, "consistency", "pass"),
      gateRun(1, "consistency", "pass", { evidenceRefs: ["chapter:3", `${GATE_RUN_INTENT_REF_PREFIX}${MAIN_CONTROL_RERUN_INTENT}`] }),
      gateRun(2, "consistency", "pass", { evidenceRefs: ["intent:"] }),
    ])
    expect(readGateRunIntent(ledger.events[0]!)).toBeUndefined()
    expect(readGateRunIntent(ledger.events[1]!)).toBe(MAIN_CONTROL_RERUN_INTENT)
    expect(readGateRunIntent(ledger.events[2]!)).toBeUndefined()
  })
})

describe("isAuthoritativeGateRun（唯一判据）", () => {
  it("无 intent = 权威（正式章运行）；命中注册表 = 非权威；非 gate-run = false", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateRun(0, "consistency", "pass"),
      gateRun(1, "consistency", "fail", { evidenceRefs: [`intent:${MAIN_CONTROL_RERUN_INTENT}`] }),
      { seq: 2, eventId: "stage:2", ts: TS, kind: "stage", actor: "system", payload: { subGate: "x" } },
    ])
    expect(isAuthoritativeGateRun(ledger.events[0]!)).toBe(true)
    expect(isAuthoritativeGateRun(ledger.events[1]!)).toBe(false)
    expect(isAuthoritativeGateRun(ledger.events[2]!)).toBe(false)
  })

  it("自定义排除表替换默认表（[] = 不过滤，便于反证）", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateRun(0, "consistency", "fail", { evidenceRefs: [`intent:${MAIN_CONTROL_RERUN_INTENT}`] }),
      gateRun(1, "consistency", "pass", { evidenceRefs: ["intent:some-other-draft"] }),
    ])
    expect(isAuthoritativeGateRun(ledger.events[0]!, [])).toBe(true)
    expect(isAuthoritativeGateRun(ledger.events[0]!, ["some-other-draft"])).toBe(true)
    expect(isAuthoritativeGateRun(ledger.events[1]!, ["some-other-draft"])).toBe(false)
    // 默认注册表只含草稿复核意图
    expect(NON_AUTHORITATIVE_GATE_RUN_INTENTS).toEqual([MAIN_CONTROL_RERUN_INTENT])
  })
})

describe("selectAuthoritativeEvents / toAuthoritativeLedger（整本视图）", () => {
  it("只剔非权威 gate-run；stage/retry 与账本顺序原样保留", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      { seq: 0, eventId: "retry:0", ts: TS, kind: "retry", actor: "writer", payload: {} },
      gateRun(1, "consistency", "fail", { evidenceRefs: [`intent:${MAIN_CONTROL_RERUN_INTENT}`] }),
      gateRun(2, "consistency", "pass"),
      { seq: 3, eventId: "stage:3", ts: TS, kind: "stage", actor: "system", payload: { alert: "voice-drift" } },
    ])
    const kept = selectAuthoritativeEvents(ledger)
    expect(kept.map((event) => event.eventId)).toEqual(["retry:0", "gate-run:2:consistency", "stage:3"])
    const view = toAuthoritativeLedger(ledger)
    expect(view.schemaVersion).toBe(ledger.schemaVersion)
    expect(view.events.map((event) => event.seq)).toEqual([0, 2, 3])
  })

  it("空账本 → 空视图（不抛错）；excludeIntents 可显式清空过滤", () => {
    const empty = createRunEventLedger()
    expect(toAuthoritativeLedger(empty).events).toEqual([])
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateRun(0, "consistency", "fail", { evidenceRefs: [`intent:${MAIN_CONTROL_RERUN_INTENT}`] }),
    ])
    expect(selectAuthoritativeEvents(ledger)).toHaveLength(0)
    expect(selectAuthoritativeEvents(ledger, { excludeIntents: [] })).toHaveLength(1)
  })
})
