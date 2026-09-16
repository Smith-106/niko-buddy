/**
 * cross-form-consistency.spec — 波3-A 跨形态一致性（单向派生子门 + VIS-CONT
 * + L9 显式 N/A）测试。覆盖：母本未过 → blocked / 母本过 → checks 裁定 /
 * VIS-CONT 跨帧 Jaccard + 平凡 pass / 子门事件 kind=stage 不污染 gate-run /
 * L9 显式 N-A / 阈值与 ts 纪律。
 */
import { describe, expect, it } from "vitest"
import {
  CROSS_FORM_DERIVATION_SCHEMA,
  crossFormSubGateEvents,
  evaluateCrossFormSubGate,
  evaluateVisCont,
  formL9Status,
  visContEvents,
  type ComicFrameAura,
} from "./cross-form-consistency"
import { appendRunEvents, createRunEventLedger, sliceRunEvents } from "./run-event-ledger"
import { appendRunEventsToStore, loadRunEventLedgerStore, type RunEventLedgerStoreDeps } from "./run-event-ledger-store"

const TS = "2026-09-16T00:00:00.000Z"

const derivation = CROSS_FORM_DERIVATION_SCHEMA.parse({
  derivationId: "dv-1",
  form: "short_drama",
  sourceChapterId: 7,
  derivedArtifactId: "sd-script-01",
})

function memoryDeps(): RunEventLedgerStoreDeps {
  const files = new Map<string, string>()
  return {
    readText: async (path) => files.get(path) ?? null,
    appendText: async (path, text) => {
      files.set(path, (files.get(path) ?? "") + text)
    },
  }
}

describe("evaluateCrossFormSubGate（单向派生子门）", () => {
  it("母本未 pass → 子门 blocked（不独立评估，永不反向改写母本）", () => {
    const verdict = evaluateCrossFormSubGate({
      derivation,
      novelGateStatus: "fail",
      checks: [{ checkId: "c-1", consistent: true }],
    })
    expect(verdict).toMatchObject({ verdict: "blocked", blockedBy: "novel-baseline", failedChecks: [] })
    expect(evaluateCrossFormSubGate({ derivation, novelGateStatus: "skipped", checks: [] }).verdict).toBe("blocked")
  })

  it("母本 pass → 全部 consistent → pass；任一 false → fail 含 id", () => {
    const pass = evaluateCrossFormSubGate({ derivation, novelGateStatus: "pass", checks: [{ checkId: "c-1", consistent: true }, { checkId: "c-2", consistent: true }] })
    expect(pass).toMatchObject({ verdict: "pass", blockedBy: null })
    const fail = evaluateCrossFormSubGate({ derivation, novelGateStatus: "pass", checks: [{ checkId: "c-1", consistent: true }, { checkId: "c-2", consistent: false }] })
    expect(fail).toMatchObject({ verdict: "fail", failedChecks: ["c-2"] })
    expect(() => crossFormSubGateEvents({ verdict: pass, derivation, ts: "" })).toThrow(/ts 为空/)
  })
})

describe("evaluateVisCont（跨帧 aura 判据）", () => {
  it("相邻帧 auraSeeds 重叠高 → pass；断裂帧对 → fail 含 finding", () => {
    const frames: ComicFrameAura[] = [
      { frameId: "f1", auraSeeds: ["雨夜霓虹街巷的逆光剪影"] },
      { frameId: "f2", auraSeeds: ["雨夜霓虹街巷的逆光剪影"] },
      { frameId: "f3", auraSeeds: ["完全无关的白昼课堂特写"] },
    ]
    const verdict = evaluateVisCont(frames, 0.5)
    expect(verdict.verdict).toBe("fail")
    expect(verdict.pairsChecked).toBe(2)
    expect(verdict.findings).toHaveLength(1)
    expect(verdict.findings[0]).toMatchObject({ frameA: "f2", frameB: "f3" })
    expect(evaluateVisCont(frames.slice(0, 2), 0.5).verdict).toBe("pass")
  })

  it("单帧/空 aura 平凡 pass（无可比对，不臆造）；阈值越界拒绝", () => {
    expect(evaluateVisCont([{ frameId: "f1", auraSeeds: ["x"] }]).pairsChecked).toBe(0)
    expect(evaluateVisCont([{ frameId: "f1", auraSeeds: [] }, { frameId: "f2", auraSeeds: ["y"] }]).verdict).toBe("pass")
    expect(() => evaluateVisCont([], 1.5)).toThrow(/threshold 越界/)
  })
})

describe("formL9Status（L9 显式 N/A）", () => {
  it("novel 适用；comic/short_drama 显式 N/A（na=true + reason，非缺省漏报）", () => {
    expect(formL9Status("novel")).toMatchObject({ applicable: true, na: false })
    const comic = formL9Status("comic")
    const drama = formL9Status("short_drama")
    expect(comic).toMatchObject({ applicable: false, na: true })
    expect(comic.reason).toContain("显式 N/A")
    expect(drama.na).toBe(true)
    expect(drama.reason).toContain("短剧")
  })
})

describe("子门事件（kind=stage，不污染三门覆盖口径）", () => {
  it("派生评估事件落账本：evidenceRefs 母本锚+派生产物可点开；gate-run 切片为零", async () => {
    const verdict = evaluateCrossFormSubGate({ derivation, novelGateStatus: "pass", checks: [{ checkId: "c-1", consistent: false }] })
    const events = crossFormSubGateEvents({ verdict, derivation, ts: TS })
    expect(events[0]?.kind).toBe("stage")
    expect((events[0]?.payload as { subGate?: string }).subGate).toBe("cross-form-derivation")

    const deps = memoryDeps()
    await appendRunEventsToStore(deps, "C:/proj/cf", events)
    const ledger = await loadRunEventLedgerStore(deps, "C:/proj/cf")
    expect(sliceRunEvents(ledger, { kind: "gate-run" })).toHaveLength(0)
    const stages = sliceRunEvents(ledger, { kind: "stage" })
    expect(stages[0]?.evidenceRefs).toEqual(["novel-ch:7", "derived:sd-script-01"])
  })

  it("VIS-CONT 事件携带 findings；空 ts 拒绝（零时钟纪律）", () => {
    const verdict = evaluateVisCont([
      { frameId: "f1", auraSeeds: ["雨夜霓虹街巷的逆光剪影"] },
      { frameId: "f2", auraSeeds: ["完全无关的白昼课堂特写"] },
    ])
    const events = visContEvents({ verdict, ts: TS, bookId: "book-a" })
    expect((events[0]?.payload as { subGate?: string }).subGate).toBe("vis-cont")
    expect(events[0]?.evidenceRefs).toEqual(["vis-cont:f1:f2"])
    expect(() => visContEvents({ verdict, ts: "" })).toThrow(/ts 为空/)
  })
})

describe("波1 账本联动（appendRunEvents + 切片）", () => {
  it("子门事件经内存账本落账后可按 stage 切片追溯", () => {
    const verdict = evaluateCrossFormSubGate({ derivation, novelGateStatus: "fail", checks: [] })
    const ledger = appendRunEvents(
      createRunEventLedger(),
      crossFormSubGateEvents({ verdict, derivation, ts: TS }).map((event, i) => ({ ...event, seq: i, eventId: `stage:${i}` }) as never),
    )
    const stages = sliceRunEvents(ledger, { kind: "stage" })
    expect(stages).toHaveLength(1)
    expect((stages[0]?.payload as { verdict?: string }).verdict).toBe("blocked")
  })
})