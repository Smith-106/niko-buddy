/**
 * dashboard-evidence.spec — 波2-D 首页/列表只读派生数据源测试。
 * 覆盖：账本→门状态派生（最近一条生效+R-04 未落=undefined）/ 快照组装与
 * buildEvidenceSnapshot 等价 / 列表健康列 per-book 三态（fail 阻塞+blockingGate
 * 优先级 / 全评估 pass / 部分评估 not_evaluated / 无事件书 / bookId 隔离）。
 */
import { describe, expect, it } from "vitest"
import { appendRunEvent, appendRunEvents, createRunEventLedger, type RunEventInput } from "./run-event-ledger"
import { buildCorrectionLoopStats } from "./repair-loop"
import { buildChapterGateRunEvents, MAIN_CONTROL_RERUN_INTENT } from "./deep-chapter-gate-evidence"
import type { DeepChapterDecisionGates, DeepChapterDecisionGate } from "./deep-chapter-decision-gates"
import type { NovelReviewResult } from "./review-adapter"
import {
  buildDashboardEvidenceSnapshot,
  deriveBookHealthSummaries,
  deriveEvidenceGateStatuses,
  deriveSubGateAlerts,
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

describe("污染回归（F1b：草稿复核 gate-run 不得覆盖正式章权威口径）", () => {
  function finding(severity: "error" | "warning", type = "consistency"): NovelReviewResult {
    return { type, severity, description: `${type}-${severity}`, suggestion: "s" } as unknown as NovelReviewResult
  }

  function gate(status: "pending" | "passed" | "failed", findings: NovelReviewResult[] = []): DeepChapterDecisionGate {
    return {
      status,
      verdict: status === "failed" ? "fail" : status === "passed" ? "pass" : "pending",
      findings,
      repair_suggestions: [],
      retry_count: 0,
      updated_at: TS,
    } as DeepChapterDecisionGate
  }

  function decisionGates(
    statuses: { consistency: "pending" | "passed" | "failed"; anti_ai: "pending" | "passed" | "failed"; quality: "pending" | "passed" | "failed" },
    findings: NovelReviewResult[] = [],
  ): DeepChapterDecisionGates {
    return {
      consistency: gate(statuses.consistency, findings),
      anti_ai: gate(statuses.anti_ai, findings),
      quality: gate(statuses.quality, findings),
      overall: "pending",
    } as unknown as DeepChapterDecisionGates
  }

  /** 把一组 gate-run 事件按真实写入路径落账（同一次写入共享同一 ts）。 */
  function appendGroup(
    ledger: ReturnType<typeof createRunEventLedger>,
    events: ReturnType<typeof buildChapterGateRunEvents>,
    ts: string,
  ) {
    let next = ledger
    for (const event of events) {
      const seq = next.events.length
      next = appendRunEvent(next, { ...event, ts, seq, eventId: `gate-run:${seq}:${seq}` })
    }
    return next
  }

  it("正式章先写、main-control-rerun 后写：门状态/快照仍为正式章结论（不被重跑覆盖）", () => {
    const formal = buildChapterGateRunEvents({
      projectPath: "/p",
      decisionGates: decisionGates({ consistency: "passed", anti_ai: "passed", quality: "passed" }),
      chapterNumber: 3,
    })
    // 未采纳草稿的重跑：三门全部翻转（若不过滤就会覆盖首页三门）
    const rerun = buildChapterGateRunEvents({
      projectPath: "/p",
      decisionGates: decisionGates(
        { consistency: "failed", anti_ai: "pending", quality: "pending" },
        [finding("error")],
      ),
      chapterNumber: 3,
      intent: MAIN_CONTROL_RERUN_INTENT,
    })
    const ledger = appendGroup(
      appendGroup(createRunEventLedger(), formal, "2026-10-18T00:00:00.000Z"),
      rerun,
      "2026-10-18T00:10:00.000Z",
    )
    // 前提：重跑确实已落账（可审计，非静默丢弃）
    expect(ledger.events).toHaveLength(6)
    expect(ledger.events[5]?.evidenceRefs).toContain(`intent:${MAIN_CONTROL_RERUN_INTENT}`)

    // 回归断言：仍返回**正式章**结论
    const statuses = deriveEvidenceGateStatuses(ledger)
    expect(statuses).toEqual({ consistency: "pass", anti_ai: "pass", quality: "pass" })
    const snapshot = buildDashboardEvidenceSnapshot(ledger)
    expect(snapshot.blocked).toBe(false)
    expect(snapshot.cards.every((card) => card.display === "pass")).toBe(true)

    // 反证：若显式清空排除表（旧行为），重跑确实会翻转——证明拦截来自 intent 过滤
    const unfiltered = deriveEvidenceGateStatuses(ledger, { excludeIntents: [] })
    expect(unfiltered).toEqual({ consistency: "fail", anti_ai: "skipped", quality: "skipped" })
  })

  it("列表健康列同口径：重跑 fail 不把本书刷成 blocked", () => {
    const formal = buildChapterGateRunEvents({
      projectPath: "/p",
      decisionGates: decisionGates({ consistency: "passed", anti_ai: "passed", quality: "passed" }),
      chapterNumber: 3,
      bookId: "book-a",
    })
    const rerun = buildChapterGateRunEvents({
      projectPath: "/p",
      decisionGates: decisionGates({ consistency: "failed", anti_ai: "failed", quality: "failed" }, [finding("error")]),
      chapterNumber: 3,
      bookId: "book-a",
      intent: MAIN_CONTROL_RERUN_INTENT,
    })
    const ledger = appendGroup(
      appendGroup(createRunEventLedger(), formal, "2026-10-18T00:00:00.000Z"),
      rerun,
      "2026-10-18T00:10:00.000Z",
    )
    expect(deriveBookHealthSummaries(ledger, ["book-a"])["book-a"]).toMatchObject({
      display: "pass",
      blocked: false,
      blockingGate: null,
      evaluatedGates: 3,
    })
  })
})

describe("deriveSubGateAlerts（G-14 子门/告警可见面）", () => {
  function stage(seq: number, payload: Record<string, unknown>, extra?: Partial<RunEventInput>): RunEventInput {
    return { seq, eventId: `stage:${seq}`, ts: TS, kind: "stage", actor: "system", payload, ...extra }
  }

  it("subGate/告警/反事实三类 stage 事件均可派生；最新在前", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      stage(0, { subGate: "cross-form-derivation", verdict: "blocked", form: "comic" }),
      stage(1, { alert: "aura-homogenization", pairs: [{ entryIdA: "a", entryIdB: "b", similarity: 0.9 }] }),
      stage(2, { subGate: "vis-cont", pairsChecked: 2, findings: [{ frameA: "f2", frameB: "f3", similarity: 0.3 }] }),
      stage(3, { counterfactual: { gate: "consistency", decisiveSourceIds: ["x"] } }, { replayId: "rp-1" }),
    ])
    const items = deriveSubGateAlerts(ledger)
    expect(items).toHaveLength(4)
    expect(items[0]).toMatchObject({ category: "counterfactual", name: "counterfactual:consistency", summary: "决定性证据=1" })
    expect(items[3]).toMatchObject({ category: "subgate", name: "cross-form-derivation", summary: "裁定=blocked (comic)" })
    const alert = items.find((item) => item.name === "aura-homogenization")
    expect(alert?.summary).toContain("同质化角色对=1")
    expect(alert?.summary).toContain("最高相似度=0.9")
    expect(items.find((item) => item.name === "vis-cont")?.summary).toContain("跨帧对=2")
  })

  it("无关 stage 事件跳过；空账本空数组（零候选合法不制造噪声）；limit 截断", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      stage(0, { other: true }),
      { seq: 1, eventId: "gr:1", ts: TS, kind: "gate-run", actor: "system", payload: { gate: "quality", status: "pass" } },
    ])
    expect(deriveSubGateAlerts(ledger)).toHaveLength(0)
    expect(deriveSubGateAlerts(createRunEventLedger())).toHaveLength(0)
    const many = appendRunEvents(
      createRunEventLedger(),
      Array.from({ length: 60 }, (_, i) => stage(i, { alert: "voice-drift", drift: 0.7, chapterId: i })),
    )
    expect(deriveSubGateAlerts(many, 50)).toHaveLength(50)
  })
})

describe("事件收容矩阵回归（DeepSeek E1：stage 系不污染三门权威）", () => {
  function gateRun(seq: number, gate: string, status: "pass" | "fail" | "skipped"): RunEventInput {
    return { seq, eventId: `gate-run:${seq}:${gate}`, ts: TS, kind: "gate-run", actor: "system", payload: { gate, status } }
  }
  function stage(seq: number, payload: Record<string, unknown>): RunEventInput {
    return { seq, eventId: `stage:${seq}`, ts: TS, kind: "stage", actor: "system", payload }
  }

  it("反事实/子门/告警 stage 事件落账后：门状态、快照、覆盖率、闭环统计全部不变", () => {
    const base = appendRunEvents(createRunEventLedger(), [
      gateRun(0, "consistency", "pass"),
      gateRun(1, "anti_ai", "pass"),
      gateRun(2, "quality", "pass"),
    ])
    const polluted = appendRunEvents(base, [
      // 假想反事实 fail：若以 gate 語义落 stage 也不得翻转真实裁定（kind 谓词收容）
      stage(3, { counterfactual: { gate: "consistency", baselineVerdict: "pass", decisiveSourceIds: [] } }),
      stage(4, { subGate: "cross-form-derivation", verdict: "fail", form: "comic" }),
      stage(5, { alert: "aura-homogenization", pairs: [] }),
    ])
    expect(deriveEvidenceGateStatuses(polluted)).toEqual(deriveEvidenceGateStatuses(base))
    const snapBase = buildDashboardEvidenceSnapshot(base)
    const snapPolluted = buildDashboardEvidenceSnapshot(polluted)
    expect(snapPolluted.cards).toEqual(snapBase.cards)
    expect(snapPolluted.gateEventCoverage).toBe(snapBase.gateEventCoverage)
    expect(snapPolluted.blocked).toBe(false)
    // 闭环统计同样不受 stage 影响（修正动作仅 retry/generate）
    expect(buildCorrectionLoopStats(polluted).totals).toEqual(buildCorrectionLoopStats(base).totals)
    // 但可见面能派生出子门/告警项（G-14）
    expect(deriveSubGateAlerts(polluted)).toHaveLength(3)
  })
})
