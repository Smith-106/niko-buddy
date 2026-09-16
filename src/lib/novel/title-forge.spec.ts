/**
 * title-forge.spec — 波2-B 模块 11 标题工坊可证筛选测试。
 * 覆盖：逐条 constraints 对账 hit/miss / 采纳淘汰确定性裁定与原因 /
 * minConstraintHits 阈值 / 重复候选拒绝 / 事件落账（store 往返 + 切片）。
 */
import { describe, expect, it } from "vitest"
import { TITLE_SEED_ENTRY_SCHEMA, type TitleSeedEntry } from "./asset-library"
import { forgeTitles } from "./title-forge"
import {
  appendRunEventsToStore,
  loadRunEventLedgerStore,
  type RunEventLedgerStoreDeps,
} from "./run-event-ledger-store"
import { sliceRunEvents } from "./run-event-ledger"

function seed(input: { entryId: string; pattern: string; constraints?: string[] }): TitleSeedEntry {
  return TITLE_SEED_ENTRY_SCHEMA.parse({ ...input, constraints: input.constraints ?? [] })
}

const TS = "2026-09-16T00:00:00.000Z"

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

describe("forgeTitles（逐条对账证据表）", () => {
  it("候选命中种子 pattern + 部分约束 → 采纳，逐条 hit/miss 可见", () => {
    const report = forgeTitles({
      ts: TS,
      candidates: [{ candidateId: "c1", title: "左利手剑客的雨夜" }],
      seeds: [seed({ entryId: "s1", pattern: "剑客", constraints: ["左利手", "雨夜", "孤城"] })],
    })
    const row = report.rows[0]
    expect(row?.admitted).toBe(true)
    expect(row?.reason).toBe("admitted")
    expect(row?.totalConstraintHits).toBe(2)
    const checks = row?.seedRows[0]?.constraintChecks
    expect(checks?.find((c) => c.constraint === "左利手")?.hit).toBe(true)
    expect(checks?.find((c) => c.constraint === "孤城")?.hit).toBe(false)
    expect(report.admitted).toEqual(["c1"])
    expect(report.rejected).toHaveLength(0)
  })

  it("无种子 pattern 命中 → 淘汰 no_seed_pattern_match（证据行仍完整）", () => {
    const report = forgeTitles({
      ts: TS,
      candidates: [{ candidateId: "c2", title: "完全不相关标题" }],
      seeds: [seed({ entryId: "s1", pattern: "剑客", constraints: ["左利手"] })],
    })
    const row = report.rows[0]
    expect(row?.admitted).toBe(false)
    expect(row?.reason).toBe("no_seed_pattern_match")
    expect(row?.seedMatchCount).toBe(0)
    expect(report.rejected).toEqual(["c2"])
  })

  it("pattern 命中但约束命中数低于阈值 → below_min_constraint_hits", () => {
    const report = forgeTitles({
      ts: TS,
      candidates: [{ candidateId: "c3", title: "剑客传说" }],
      seeds: [seed({ entryId: "s1", pattern: "剑客", constraints: ["左利手", "雨夜"] })],
      minConstraintHits: 2,
    })
    expect(report.rows[0]?.reason).toBe("below_min_constraint_hits")
    expect(report.rows[0]?.totalConstraintHits).toBe(0)
  })

  it("确定性：同输入两次构建全等（对账表可重放）", () => {
    const input = {
      ts: TS,
      candidates: [
        { candidateId: "a", title: "左利手剑客" },
        { candidateId: "b", title: "剑客" },
      ],
      seeds: [seed({ entryId: "s1", pattern: "剑客", constraints: ["左利手"] })],
    }
    const first = forgeTitles(input)
    const second = forgeTitles(input)
    expect(first).toEqual(second)
    expect(first.rows.map((r) => r.candidateId)).toEqual(["a", "b"])
  })

  it("重复候选 id 拒绝；空候选/空种子 → 空报告", () => {
    expect(() =>
      forgeTitles({
        ts: TS,
        candidates: [
          { candidateId: "x", title: "a" },
          { candidateId: "x", title: "b" },
        ],
        seeds: [],
      }),
    ).toThrow(/重复的候选 id/)
    const empty = forgeTitles({ ts: TS, candidates: [], seeds: [seed({ entryId: "s", pattern: "x" })] })
    expect(empty.rows).toHaveLength(0)
    expect(empty.events).toHaveLength(0)
  })

  it("空 ts 拒绝（零时钟纪律：事件落账前必须注入时间戳）", () => {
    expect(() =>
      forgeTitles({ ts: "", candidates: [{ candidateId: "c", title: "x" }], seeds: [] }),
    ).toThrow(/ts 为空/)
  })
})

describe("标题工坊事件落账（GLM 验收：采纳/淘汰原因落事件）", () => {
  it("events 落 store 后切片可见，payload 含裁定原因与对账计数", async () => {
    const { deps, files } = memoryDeps()
    const report = forgeTitles({
      ts: TS,
      candidates: [
        { candidateId: "c1", title: "左利手剑客的雨夜" },
        { candidateId: "c2", title: "完全不相关" },
      ],
      seeds: [seed({ entryId: "s1", pattern: "剑客", constraints: ["左利手"] })],
    })
    await appendRunEventsToStore(deps, "C:/proj/tf", report.events)
    const ledger = await loadRunEventLedgerStore(deps, "C:/proj/tf")
    expect(ledger.events).toHaveLength(2)
    const slice = sliceRunEvents(ledger, { kind: "stage" })
    const c1 = slice.find((e) => (e.payload as { candidateId?: string }).candidateId === "c1")
    const c2 = slice.find((e) => (e.payload as { candidateId?: string }).candidateId === "c2")
    expect((c1?.payload as { reason?: string }).reason).toBe("admitted")
    expect((c2?.payload as { reason?: string }).reason).toBe("no_seed_pattern_match")
    // 种子血缘可点开（evidenceRefs 回溯到 entryId + 约束锚）
    expect(c1?.evidenceRefs).toContain("title-seed:s1")
    expect(c1?.evidenceRefs).toContain("title-seed:s1:hit:左利手")
    expect(c2?.evidenceRefs).toHaveLength(0)
    expect(files.size).toBe(1)
  })
})