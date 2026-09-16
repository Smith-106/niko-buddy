/**
 * dashboard-evidence.spec — 波2-D 首页/列表只读派生数据源测试。
 * 覆盖：账本→门状态派生（最近一条生效+R-04 未落=undefined）/ 快照组装与
 * buildEvidenceSnapshot 等价 / 列表健康列 per-book 三态（fail 阻塞+blockingGate
 * 优先级 / 全评估 pass / 部分评估 not_evaluated / 无事件书 / bookId 隔离）。
 */
import { describe, expect, it } from "vitest"
import { appendRunEvents, createRunEventLedger, type RunEventInput } from "./run-event-ledger"
import {
  buildDashboardEvidenceSnapshot,
  deriveBookHealthSummaries,
  deriveEvidenceGateStatuses,
} from "./dashboard-evidence"

const TS = "2026-09-16T00:00:00.000Z"

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

describe("deriveEvidenceGateStatuses（账本→门状态）", () => {
  it("每门取最近一条 gate-run（后运行覆盖先运行）；未落事件 → undefined", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateRun(0, "consistency", "fail"),
      gateRun(1, "consistency", "pass"),
      gateRun(2, "anti_ai", "skipped"),
    ])
    const statuses = deriveEvidenceGateStatuses(ledger)
    expect(statuses.consistency).toBe("pass")
    expect(statuses.anti_ai).toBe("skipped")
    expect(statuses.quality).toBeUndefined()
  })

  it("空账本 → 全 undefined（R-04：未落=未发生）", () => {
    const statuses = deriveEvidenceGateStatuses(createRunEventLedger())
    expect(statuses.consistency).toBeUndefined()
    expect(statuses.anti_ai).toBeUndefined()
    expect(statuses.quality).toBeUndefined()
  })
})

describe("buildDashboardEvidenceSnapshot（真实 UI 数据源入口）", () => {
  it("派生门状态组装快照：P0 fail → blocked + blockingGate=consistency", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateRun(0, "consistency", "fail", { evidenceRefs: ["w:1"] }),
      gateRun(1, "anti_ai", "pass"),
      gateRun(2, "quality", "pass"),
    ])
    const snapshot = buildDashboardEvidenceSnapshot(ledger)
    expect(snapshot.blocked).toBe(true)
    expect(snapshot.blockingGate).toBe("consistency")
    const consistency = snapshot.cards.find((card) => card.gate === "consistency")
    expect(consistency).toMatchObject({ display: "fail", hasEvent: true, evidenceCount: 1 })
    expect(snapshot.gateEventCoverage).toBe(1)
  })

  it("空账本快照：三门 NOT_EVALUATED、不阻塞、覆盖平凡 1", () => {
    const snapshot = buildDashboardEvidenceSnapshot(createRunEventLedger())
    expect(snapshot.blocked).toBe(false)
    expect(snapshot.cards.every((card) => card.display === "not_evaluated")).toBe(true)
  })
})

describe("deriveBookHealthSummaries（列表健康列）", () => {
  it("任一门 fail → fail+blocked+blockingGate 按 P0→P1→P2 首个", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateRun(0, "anti_ai", "fail", { bookId: "book-a" }),
      gateRun(1, "consistency", "fail", { bookId: "book-a" }),
      gateRun(2, "quality", "pass", { bookId: "book-a" }),
    ])
    const health = deriveBookHealthSummaries(ledger, ["book-a"])["book-a"]
    expect(health).toMatchObject({ display: "fail", blocked: true, blockingGate: "consistency", evaluatedGates: 3 })
  })

  it("三门全 pass → pass 不阻塞；部分评估无 fail → not_evaluated 不阻塞", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateRun(0, "consistency", "pass", { bookId: "book-ok" }),
      gateRun(1, "anti_ai", "pass", { bookId: "book-ok" }),
      gateRun(2, "quality", "pass", { bookId: "book-ok" }),
      gateRun(3, "consistency", "pass", { bookId: "book-partial" }),
    ])
    const health = deriveBookHealthSummaries(ledger, ["book-ok", "book-partial", "book-none"])
    expect(health["book-ok"]).toMatchObject({ display: "pass", blocked: false, evaluatedGates: 3 })
    expect(health["book-partial"]).toMatchObject({ display: "not_evaluated", blocked: false, evaluatedGates: 1 })
    // 无事件书 → not_evaluated（R-04 诚实面，不臆造）
    expect(health["book-none"]).toMatchObject({ display: "not_evaluated", blocked: false, blockingGate: null, evaluatedGates: 0 })
  })

  it("bookId 隔离：跨书事件互不干扰；每门最近一条生效", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateRun(0, "consistency", "fail", { bookId: "book-a" }),
      gateRun(1, "consistency", "pass", { bookId: "book-b" }),
      gateRun(2, "anti_ai", "pass", { bookId: "book-a" }),
      gateRun(3, "quality", "pass", { bookId: "book-a" }),
      gateRun(4, "anti_ai", "pass", { bookId: "book-a" }),
    ])
    const health = deriveBookHealthSummaries(ledger, ["book-a", "book-b"])
    // book-a：consistency 最近=fail → 阻塞；book-b 只评估了 consistency=pass 但未全评估 → not_evaluated
    expect(health["book-a"]).toMatchObject({ display: "fail", blocked: true, blockingGate: "consistency" })
    expect(health["book-b"]).toMatchObject({ display: "not_evaluated", blocked: false, evaluatedGates: 1 })
  })
})