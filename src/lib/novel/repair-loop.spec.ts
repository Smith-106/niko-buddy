/**
 * repair-loop.spec — 波2-C 修正闭环率 + FP 统计（账本聚合）测试。
 * 覆盖：真修正闭环 / FP 误报（无修正动作翻转）/ open fail / 多门分账 + 全局
 * 合计 / 无 fail → 双率 null / scope 隔离（跨书互不干扰）。
 */
import { describe, expect, it } from "vitest"
import { appendRunEvents, createRunEventLedger, type RunEventInput } from "./run-event-ledger"
import {
  advanceChapterTriad,
  buildCorrectionLoopStats,
  createChapterTriadState,
  triadDraftGate,
  triadPlanGate,
  triadReviewGate,
  TRIAD_MAX_REWORK,
} from "./repair-loop"
import type { DimensionReviewIssue, DimensionReviewResult } from "./dimension-review-adapter"
import { buildChapterContractSection } from "./deep-chapter-task-brief"

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

describe("§GAP-91 三权分立单章编排（Architect→Writer→Editor 收缩态）", () => {
  const contractBrief = (body: string) =>
    `任务书正文\n${buildChapterContractSection({
      requiredBeats: ["主角握住陌生钥匙"],
      forbiddenMoves: ["不得提前揭露屋主身份"],
      continuityChecks: ["雨夜时间线连续"],
    })}\n${body}`

  const passDim = (): DimensionReviewResult => ({
    dimensionKey: "thrill",
    score: 9,
    status: "pass",
    summary: "钩子成立",
    thinking: "",
    issues: [],
  })

  const errorIssue = (chapter?: number): DimensionReviewIssue => ({
    severity: "error",
    type: "timeline",
    dimensionKey: "continuity",
    message: "时间线矛盾",
    evidence: "祠堂门缝里透出一线冷光",
    relatedMemory: "",
    suggestion: "修正时间线",
    ...(chapter !== undefined
      ? { continuityMeta: { subtype: "x", ref: "r", chapter } }
      : {}),
  })

  it("plan 门：无契约如实标记不阻断；有契约就绪", () => {
    const none = triadPlanGate("本章必须完成：推进线索")
    expect(none.contract).toBeNull()
    expect(none.ready).toBe(true)
    const withContract = triadPlanGate(contractBrief("后续段落"))
    expect(withContract.contract).not.toBeNull()
    expect(withContract.contract!.requiredBeats).toEqual(["主角握住陌生钥匙"])
    expect(withContract.ready).toBe(true)
  })

  it("draft 门：无契约不阻断；禁区命中阻断；干净正文放行", () => {
    expect(triadDraftGate(null, "任意正文").blocked).toBe(false)
    const { contract } = triadPlanGate(contractBrief("后续段落"))
    // 正文含禁区原文逐字 → error 阻断
    const blocked = triadDraftGate(contract, "他推开门，不得提前揭露屋主身份的秘密被说出。")
    expect(blocked.blocked).toBe(true)
    expect(blocked.findings.some((f) => f.severity === "error")).toBe(true)
    // 干净正文：仅 required_beats 缺失 warning，不阻断
    const clean = triadDraftGate(contract, "他推开门走了出去，夜色很深，远处有狗叫。")
    expect(clean.blocked).toBe(false)
  })

  it("review 门：全 pass 无返工；error issue 触发返工+最小返工集", () => {
    const ok = triadReviewGate({ dimensionResults: { thrill: passDim() }, issues: [] })
    expect(ok.rework).toBe(false)
    expect(ok.reworkChapters).toEqual([])
    const bad = triadReviewGate({
      dimensionResults: {},
      issues: [errorIssue(8), errorIssue(5)],
      chapterBody: "祠堂门缝里透出一线冷光，夜色很深。",
    })
    expect(bad.rework).toBe(true)
    expect(bad.reworkChapters).toEqual([5, 8])
  })

  it("状态机：plan→draft→review→done 全绿路径", () => {
    let s = createChapterTriadState()
    expect(s.phase).toBe("plan")
    s = advanceChapterTriad(s, { reason: "契约就绪" })
    expect(s.phase).toBe("draft")
    s = advanceChapterTriad(s, { blocked: false, reason: "写后核对通过" })
    expect(s.phase).toBe("review")
    s = advanceChapterTriad(s, { rework: false, reason: "editor 裁定通过" })
    expect(s.phase).toBe("done")
    expect(s.reworkCount).toBe(0)
  })

  it("状态机：review 返工回 draft，超限 handoff（上限 TRIAD_MAX_REWORK=2）", () => {
    expect(TRIAD_MAX_REWORK).toBe(2)
    let s = advanceChapterTriad(
      advanceChapterTriad(createChapterTriadState(), { reason: "p" }),
      { blocked: false, reason: "d" },
    )
    expect(s.phase).toBe("review")
    s = advanceChapterTriad(s, { rework: true, reworkChapters: [8], reason: "返工1" })
    expect(s.phase).toBe("draft")
    expect(s.reworkCount).toBe(1)
    expect(s.reworkChapters).toEqual([8])
    s = advanceChapterTriad(s, { blocked: false, reason: "d2" })
    s = advanceChapterTriad(s, { rework: true, reworkChapters: [8], reason: "返工2" })
    expect(s.phase).toBe("draft")
    expect(s.reworkCount).toBe(2)
    s = advanceChapterTriad(s, { blocked: false, reason: "d3" })
    s = advanceChapterTriad(s, { rework: true, reworkChapters: [8], reason: "返工3超限" })
    expect(s.phase).toBe("handoff")
    expect(s.reworkCount).toBe(3)
    expect(s.reason).toContain("超限")
  })

  it("状态机：draft 禁区阻断超限同样 handoff；终态 done/handoff 恒等", () => {
    let s = advanceChapterTriad(createChapterTriadState(), { reason: "p" })
    for (let i = 0; i <= TRIAD_MAX_REWORK; i++) {
      s = advanceChapterTriad(s, { blocked: true, reason: `禁区${i}` })
    }
    expect(s.phase).toBe("handoff")
    const done = { ...s, phase: "done" as const }
    expect(advanceChapterTriad(done, { reason: "x" })).toBe(done)
  })
})