/**
 * repair-loop.spec — 波2-C 修正闭环率 + FP 统计（账本聚合）测试。
 * 覆盖：真修正闭环 / FP 误报（无修正动作翻转）/ open fail / 多门分账 + 全局
 * 合计 / 无 fail → 双率 null / scope 隔离（跨书互不干扰）。
 */
import { describe, expect, it } from "vitest"
import { appendRunEvents, createRunEventLedger, type RunEventInput } from "./run-event-ledger"
import { buildCorrectionLoopStats } from "./repair-loop"

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

function action(seq: number, kind: "retry" | "generate", extra?: Partial<RunEventInput>): RunEventInput {
  return { seq, eventId: `${kind}:${seq}`, ts: TS, kind, actor: "writer", payload: {}, ...extra }
}

describe("buildCorrectionLoopStats（闭环率 + FP 聚合）", () => {
  it("fail → retry → pass = 真修正闭环（closureRate=1, fpRate=0）", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateRun(0, "anti_ai", "fail"),
      action(1, "retry", { payload: { gate: "anti_ai" } }),
      gateRun(2, "anti_ai", "pass"),
    ])
    const stats = buildCorrectionLoopStats(ledger)
    const anti = stats.gates.find((g) => g.gate === "anti_ai")
    expect(anti).toMatchObject({ failRuns: 1, corrections: 1, falsePositives: 0, openFailRuns: 0, closureRate: 1, fpRate: 0 })
  })

  it("fail → pass 无修正动作 = FP 误报（机械代理口径：内容未变而裁定翻转）", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateRun(0, "anti_ai", "fail"),
      gateRun(1, "anti_ai", "pass"),
    ])
    const stats = buildCorrectionLoopStats(ledger)
    const anti = stats.gates.find((g) => g.gate === "anti_ai")
    expect(anti).toMatchObject({ failRuns: 1, corrections: 0, falsePositives: 1, closureRate: 0, fpRate: 1 })
  })

  it("fail 无后续运行 = open（未闭环，双率分子不含）", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateRun(0, "consistency", "fail"),
    ])
    const stats = buildCorrectionLoopStats(ledger)
    const consistency = stats.gates.find((g) => g.gate === "consistency")
    expect(consistency).toMatchObject({ failRuns: 1, openFailRuns: 1, corrections: 0, falsePositives: 0, closureRate: 0, fpRate: 0 })
  })

  it("fail → fail → retry → pass：首个 fail 相对同 scope 下一条 fail 不闭环（仍可继续）", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateRun(0, "anti_ai", "fail"),
      gateRun(1, "anti_ai", "fail"),
      action(2, "generate"),
      gateRun(3, "anti_ai", "pass"),
    ])
    const stats = buildCorrectionLoopStats(ledger)
    const anti = stats.gates.find((g) => g.gate === "anti_ai")
    // 两个 fail：fail[0]→next=fail（不计）；fail[1]→pass 有 generate → correction
    expect(anti).toMatchObject({ failRuns: 2, corrections: 1, falsePositives: 0, closureRate: 0.5, fpRate: 0 })
  })

  it("跨书 scope 隔离：bookId 不同互不干扰（fail A 书不被 B 书 pass 收口）", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateRun(0, "anti_ai", "fail", { bookId: "book-a" }),
      gateRun(1, "anti_ai", "pass", { bookId: "book-b" }),
    ])
    const stats = buildCorrectionLoopStats(ledger)
    const anti = stats.gates.find((g) => g.gate === "anti_ai")
    expect(anti).toMatchObject({ failRuns: 1, openFailRuns: 1, corrections: 0, falsePositives: 0 })
  })

  it("多门分账 + 全局合计；无 fail 门双率 null", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateRun(0, "anti_ai", "fail"),
      action(1, "retry"),
      gateRun(2, "anti_ai", "pass"),
      gateRun(3, "quality", "pass"),
      gateRun(4, "consistency", "pass"),
    ])
    const stats = buildCorrectionLoopStats(ledger)
    expect(stats.gates).toHaveLength(3)
    expect(stats.totals).toMatchObject({ failRuns: 1, corrections: 1, falsePositives: 0, closureRate: 1, fpRate: 0 })
    const consistency = stats.gates.find((g) => g.gate === "consistency")
    expect(consistency?.closureRate).toBeNull()
    expect(consistency?.fpRate).toBeNull()
  })

  it("空账本 → 全门零计数 + 双率 null（不臆造 100%）", () => {
    const stats = buildCorrectionLoopStats(createRunEventLedger())
    expect(stats.totals.failRuns).toBe(0)
    expect(stats.totals.closureRate).toBeNull()
    expect(stats.totals.fpRate).toBeNull()
  })

  it("generate 也算修正动作（改写后复检通过走完闭环）", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateRun(0, "anti_ai", "fail"),
      action(1, "generate"),
      gateRun(2, "anti_ai", "pass"),
    ])
    const stats = buildCorrectionLoopStats(ledger)
    expect(stats.gates.find((g) => g.gate === "anti_ai")?.corrections).toBe(1)
  })
})