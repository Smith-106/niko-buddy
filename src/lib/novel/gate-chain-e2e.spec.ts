/**
 * gate-chain-e2e.spec — 波2-A 门链端到端（DS/GLM P0 缺口：门链端到端接线）。
 *
 * 链路：世界样本硬约束 → runRuleStack（P0>P1>P2 硬短路）→ recordGateRunEvents
 * → run-event-ledger-store 落盘往返 → buildEvidenceSnapshot → EvidenceGateCards
 * 渲染（jsdom）+ 检索留痕点亮（queryHash/modelId/corpusFilter/落选原因落账本 +
 * 反事实重放决定性证据）+ INV-7（配额熔断不写门控）+ autoarm 接 status.json 补丁。
 *
 * 机械层：除 store IO（内存 fake deps）与组件渲染（jsdom）外零外部依赖；
 * ts 全部注入（零时钟）。断网可跑（无网络/无模型调用）。
 */
// @vitest-environment jsdom
import { createElement } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen } from "@/test-helpers/component-test-utils"
import { EvidenceGateCards } from "@/components/novel/evidence-gate-card"
import {
  WORLD_SAMPLE_ENTRY_SCHEMA,
  applyDraftAutoArmPatch,
  assertAutoArmNeverAccepts,
  assertAutoArmPatchNeverAccepts,
  buildDraftAutoArmPatch,
  buildDraftAutoArmRecord,
  buildEvidenceSnapshot,
  checkGateEventCoverage,
  computeQueryHash,
  counterfactualReplay,
  createRunEventLedger,
  evaluateDraftAutoArm,
  evaluateSchedulingGate,
  assertNoGateFieldsInSchedulingResult,
  markHitRejection,
  recordGateRunEvents,
  sliceRunEvents,
} from "@/lib/novel"
import { createBudgetCounters, recordRoleCall } from "./budget-counters"
import { combinePacks, runRuleStack } from "./rule-stack"
import { createRetrievalTrace } from "./retrieval-trace"
import {
  appendRunEventToStore,
  appendRunEventsToStore,
  loadRunEventLedgerStore,
  runEventsPath,
  type RunEventLedgerStoreDeps,
} from "./run-event-ledger-store"
import { buildWorldConstraintPack } from "./world-constraint-gate"

// ── 测试基础设施 ─────────────────────────────────────────────────────────────

const PP = "C:/proj/gate-chain-e2e"
const TS = "2026-09-16T00:00:00.000Z"
const REPLAY = "replay-gate-chain-e2e"

/** 内存 fake deps（与 store spec 同型；Map 存文件）。 */
function memoryDeps(): { deps: RunEventLedgerStoreDeps; files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    deps: {
      readText: async (path) => files.get(path) ?? null,
      appendText: async (path, text) => {
        files.set(path, (files.get(path) ?? "") + text)
      },
    },
  }
}

function worldSample(input: { entryId: string; hard?: string[]; soft?: string[] }) {
  return WORLD_SAMPLE_ENTRY_SCHEMA.parse({
    entryId: input.entryId,
    sourceRef: "ref-e2e",
    transferableConstraints: input.hard ?? [],
    softConstraints: input.soft ?? [],
    sceneSeeds: [],
  })
}

/** 最小会话状态对象（applyDraftAutoArmPatch 结构收口输入）。 */
function minimalStatus(draftStatus: string): {
  draft: { draft_status: string }
} {
  return { draft: { draft_status: draftStatus } }
}

afterEach(() => cleanup())

// ── 链 1：P0 违规全链点亮 ───────────────────────────────────────────────────

describe("门链端到端（世界约束→rule stack→账本 store→快照→UI 卡片）", () => {
  it("P0 世界样本硬约束违规 → 全链点亮：FAIL 卡 + 阻塞条 + 覆盖率 1", async () => {
    const { deps } = memoryDeps()
    const text = "他掏出了钢铁战衣，一拳轰碎了山岩。"
    const pack = buildWorldConstraintPack({
      text,
      samples: [worldSample({ entryId: "ws-a", hard: ["forbid:钢铁"] })],
    })
    const stack = combinePacks([pack])
    const result = runRuleStack(stack, { isFinale: false })
    expect(result.verdicts.consistency).toBe("fail")
    expect(result.shortCircuitGate).toBe("consistency")

    // 门结果落事件账本（含 skipped 门——跳过也是可审计事件）
    const recorded = recordGateRunEvents(createRunEventLedger(), result.outcomes, {
      ts: TS,
      replayId: REPLAY,
      evidenceRefs: result.allFindings.map((f) => `finding:${f.ruleId}`),
    })
    await appendRunEventsToStore(deps, PP, recorded.events)
    const reloaded = await loadRunEventLedgerStore(deps, PP)
    expect(reloaded.events).toHaveLength(3)
    expect(reloaded.events.map((e) => e.eventId)).toEqual([
      "gate-run:0:consistency",
      "gate-run:1:anti_ai",
      "gate-run:2:quality",
    ])

    // G1 门事件覆盖率 = 1（含 skipped 门）
    const coverage = checkGateEventCoverage(result.outcomes, reloaded)
    expect(coverage.rate).toBe(1)

    // EB-1 证据快照：P0 FAIL + 被短路门 NOT_EVALUATED + blocked 语义
    const snapshot = buildEvidenceSnapshot({ gateStatuses: result.verdicts, ledger: reloaded })
    expect(snapshot.cards[0]?.gate).toBe("consistency")
    expect(snapshot.cards[0]?.display).toBe("fail")
    expect(snapshot.cards[0]?.hasEvent).toBe(true)
    expect(snapshot.cards[0]?.evidenceCount).toBe(1)
    expect(snapshot.cards[0]?.replayId).toBe(REPLAY)
    expect(snapshot.cards[1]?.gate).toBe("anti_ai")
    expect(snapshot.cards[1]?.display).toBe("not_evaluated")
    expect(snapshot.blocked).toBe(true)
    expect(snapshot.blockingGate).toBe("consistency")

    // UI 证据卡渲染：阻塞条 + 未通过 + 未评估（绝不显示「通过」）
    render(createElement(EvidenceGateCards, { snapshot }))
    expect(screen.getByTestId("evidence-blocked-banner")).not.toBeNull()
    expect(screen.getByText("未通过")).not.toBeNull()
    expect(screen.getAllByText("未评估")).toHaveLength(2)
    expect(screen.queryByText("通过")).toBeNull()
  })

  it("R-04 反证：内存裁定未落事件 → 三门全部 NOT_EVALUATED，绝不显示通过", () => {
    const snapshot = buildEvidenceSnapshot({
      gateStatuses: { consistency: "pass", anti_ai: "pass", quality: "pass" },
      ledger: createRunEventLedger(),
    })
    for (const card of snapshot.cards) {
      expect(card.display).toBe("not_evaluated")
      expect(card.hasEvent).toBe(false)
    }
    expect(snapshot.blocked).toBe(false)
    render(createElement(EvidenceGateCards, { snapshot }))
    expect(screen.queryByText("通过")).toBeNull()
    expect(screen.queryByTestId("evidence-blocked-banner")).toBeNull()
  })
})

// ── 链 2：检索留痕点亮 + 反事实重放决定性证据 ────────────────────────────────

describe("检索留痕点亮（traceChannel 语义：门评估链强制留痕）", () => {
  it("检索 trace 落账本：queryHash/modelId/corpusFilter/落选原因可点开", async () => {
    const { deps } = memoryDeps()
    const query = "主角的机械义肢与世界观冲突？"
    const trace = createRetrievalTrace({
      traceId: "trace-1",
      chapter: 1,
      query,
      channel: "hybrid",
      hits: [
        { sourceId: "world-sample:ws-a", sourceType: "world", score: 0.9 },
        { sourceId: "chapter:1", sourceType: "chapter", score: 0.5 },
      ],
      latencyMs: 12,
      queryHash: computeQueryHash(query),
      modelId: "router-model-1",
      corpusFilter: { authoritativeOnly: true },
    })
    // 落选原因结构化（未采用 + 有因可查）
    const marked = markHitRejection([trace], "trace-1", "world-sample:ws-a", {
      reason: "slot_full",
      detail: "P0 槽位已满",
    })
    expect(marked[0]?.hits[0]?.used).toBe(false)
    expect(marked[0]?.hits[0]?.rejection?.reason).toBe("slot_full")

    // 留痕事件落账本（门评估链强制开启留痕——检索对照键 + 落选原因可点开）
    await appendRunEventToStore(deps, PP, {
      ts: TS,
      kind: "retrieval",
      actor: "writer",
      modelId: "router-model-1",
      replayId: REPLAY,
      evidenceRefs: ["world-sample:ws-a", "chapter:1"],
      payload: {
        queryHash: marked[0]?.queryHash,
        channel: marked[0]?.channel,
        corpusFilter: marked[0]?.corpusFilter,
        rejections: [{ sourceId: "world-sample:ws-a", reason: "slot_full", detail: "P0 槽位已满" }],
      },
    })
    const reloaded = await loadRunEventLedgerStore(deps, PP)
    const retrievalEvents = sliceRunEvents(reloaded, { kind: "retrieval" })
    expect(retrievalEvents).toHaveLength(1)
    const payload = retrievalEvents[0]?.payload as {
      queryHash: string
      channel: string
      corpusFilter: { authoritativeOnly: boolean }
    }
    expect(payload.queryHash).toBe(computeQueryHash(query))
    expect(payload.channel).toBe("hybrid")
    expect(payload.corpusFilter.authoritativeOnly).toBe(true)
    expect(retrievalEvents[0]?.modelId).toBe("router-model-1")
  })

  it("反事实重放：剔除世界样本命中 → P0 verdict 翻转 = 决定性证据", () => {
    const replay = counterfactualReplay({
      baselineP0Verdict: "fail",
      candidates: [
        { removedSourceId: "world-sample:ws-a", p0VerdictAfterRemoval: "pass" },
        { removedSourceId: "chapter:1", p0VerdictAfterRemoval: "fail" },
      ],
    })
    expect(replay.decisiveSourceIds).toEqual(["world-sample:ws-a"])
    expect(replay.nonDecisiveSourceIds).toEqual(["chapter:1"])
  })
})

// ── 链 3：INV-7 配额熔断不写门控 ────────────────────────────────────────────

describe("INV-7（熔断不写门控结果）", () => {
  it("配额硬封顶 → 调度 reject 无门控字段；账本只落 quota 事件，gate-run 计数不变", async () => {
    const { deps } = memoryDeps()
    const counters = createBudgetCounters()
    recordRoleCall(counters, "writer", { promptTokens: 20 })
    const scheduling = evaluateSchedulingGate(counters, "writer", { hardCapTokens: 10 })
    expect(scheduling.decision).toBe("reject")
    expect(scheduling.reason).toBe("quota_hard_cap_exceeded")
    // INV-7 运行时兜底：调度结果零门控字段
    expect(() => assertNoGateFieldsInSchedulingResult(scheduling)).not.toThrow()

    await appendRunEventToStore(deps, PP, {
      ts: TS,
      kind: "quota",
      actor: "system",
      payload: { decision: scheduling.decision, reason: scheduling.reason, role: scheduling.quota.role },
    })
    const reloaded = await loadRunEventLedgerStore(deps, PP)
    expect(reloaded.events.filter((e) => e.kind === "quota")).toHaveLength(1)
    // 熔断不写门控：账本零 gate-run 事件（配额停机=事件粒度停机，门控状态完整）
    expect(reloaded.events.filter((e) => e.kind === "gate-run")).toHaveLength(0)
  })
})

// ── 链 4：autoarm 接 status.json（升 ready 非 accept） ──────────────────────

describe("autoarm → status.json 契约接线（端到端）", () => {
  it("机械门全 pass → draft 升 ready；自动化路径零 accept 语义", async () => {
    const { deps } = memoryDeps()
    const pack = buildWorldConstraintPack({
      text: "主角左手握剑，城头细雨如织。",
      samples: [worldSample({ entryId: "ws-clean", hard: ["require:左手"], soft: ["forbid:雨"] })],
    })
    const result = runRuleStack(combinePacks([pack]), { isFinale: false })
    expect(result.verdicts.consistency).toBe("pass")
    const recorded = recordGateRunEvents(createRunEventLedger(), result.outcomes, { ts: TS, replayId: REPLAY })
    await appendRunEventsToStore(deps, PP, recorded.events)
    const reloaded = await loadRunEventLedgerStore(deps, PP)

    const decision = evaluateDraftAutoArm({
      policy: { enabled: true, requiredGates: ["consistency", "anti_ai"] },
      gateStatuses: result.verdicts,
    })
    expect(decision.armed).toBe(true)
    const record = buildDraftAutoArmRecord(decision, TS)
    const patch = buildDraftAutoArmPatch(record)
    expect(() => assertAutoArmPatchNeverAccepts(patch)).not.toThrow()
    const next = applyDraftAutoArmPatch(minimalStatus("pending"), patch)
    expect(next.draft.draft_status).toBe("ready")
    expect(next.draft_auto_arm?.target).toBe("ready")
    // 序列化后整对象深扫仍零 accept 语义
    expect(() => assertAutoArmPatchNeverAccepts(JSON.parse(JSON.stringify(next)))).not.toThrow()
    // 落盘事件 + autoarm 裁定同链可追溯（replayId 一致）
    expect(recorded.events.every((e) => e.replayId === REPLAY)).toBe(true)
    expect(reloaded.events.length).toBe(3)
  })

  it("P0 fail → 不 arm；草稿态保持 pending（未评估与 fail 均不 arm）", () => {
    const decision = evaluateDraftAutoArm({
      policy: { enabled: true, requiredGates: ["consistency", "anti_ai"] },
      gateStatuses: { consistency: "fail", anti_ai: "pass", quality: "pass" },
    })
    expect(decision.armed).toBe(false)
    const patch = buildDraftAutoArmPatch(buildDraftAutoArmRecord(decision, TS))
    expect(patch.draft_status).toBeNull()
    const next = applyDraftAutoArmPatch(minimalStatus("pending"), patch)
    expect(next.draft.draft_status).toBe("pending")
  })

  it("assertAutoArmNeverAccepts 兜底：accept 语义字符串即抛", () => {
    expect(() => assertAutoArmNeverAccepts("accepted")).toThrow()
  })
})

// ── 链 5：store 真实 fs 路径契约（生产 deps 结构面） ─────────────────────────

describe("账本落盘路径契约", () => {
  it("runEventsPath 恒 .novel/run-events.jsonl；与 status.json 同目录不混写", () => {
    const path = runEventsPath(PP)
    expect(path.endsWith("/.novel/run-events.jsonl")).toBe(true)
    expect(path).not.toContain("status.json")
  })
})