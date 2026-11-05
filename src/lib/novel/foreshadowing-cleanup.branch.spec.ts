import { describe, expect, it } from "vitest"
import {
  applyBulkDeleteAndAbandon,
  applyCleanupIssue,
  detectCleanupIssues,
  looksLikeStale,
  ruleBasedCleanupIssues,
  toForeshadowingSummary,
  type ForeshadowingSummary,
} from "./foreshadowing-cleanup"
import { createEmptyForeshadowingStore, type Foreshadowing } from "./foreshadowing-tracker"

function item(partial: Partial<Foreshadowing> & { id: string; name: string }): Foreshadowing {
  return {
    description: "",
    status: "planted",
    plantedChapter: 1,
    advancedChapters: [],
    relatedCharacters: [],
    relatedEvents: [],
    notes: "",
    ...partial,
  }
}

function summary(partial: Partial<ForeshadowingSummary> & { id: string; name: string }): ForeshadowingSummary {
  return {
    description: "",
    status: "planted",
    plantedChapter: 1,
    advancedChapters: [],
    ...partial,
  }
}

/**
 * foreshadowing-cleanup.ts 分支补测（覆盖率战役第九批）。
 * 每个用例都断言可观察行为；b63（applyMergeIssue 内 kind 检查）为不可达，见文件末论证。
 */
describe("foreshadowing-cleanup branch coverage", () => {
  it("toForeshadowingSummary 容忍磁盘数据缺 advancedChapters（|| [] 右支）", () => {
    const raw = JSON.parse(
      JSON.stringify(item({ id: "F1", name: "灰门", description: "d", plantedChapter: 3 })),
    ) as Record<string, unknown>
    delete raw.advancedChapters
    const s = toForeshadowingSummary(raw as unknown as Foreshadowing)
    expect(s.advancedChapters).toEqual([])
    expect(s.id).toBe("F1")
  })

  it("looksLikeStale 缺 advancedChapters 时按 ?? 0 兜底判 stale", () => {
    const raw = JSON.parse(
      JSON.stringify(summary({ id: "F9", name: "远古伏笔", plantedChapter: 1 })),
    ) as Record<string, unknown>
    delete raw.advancedChapters
    expect(looksLikeStale(raw as unknown as ForeshadowingSummary, 40)).toBe(true)
  })

  it("detectCleanupIssues 把 advanced/desc 拼进 batch 消息（三元真支）", async () => {
    const summaries = [
      summary({
        id: "F1",
        name: "普通线索甲",
        plantedChapter: 49,
        advancedChapters: [48],
        description: "一段普通说明文字",
      }),
    ]
    let captured = ""
    const issues = await detectCleanupIssues(
      summaries,
      50,
      async (_sys, user) => {
        captured = user
        return JSON.stringify({ issues: [] })
      },
    )
    expect(issues).toEqual([])
    expect(captured).toContain("advanced=[48]")
    expect(captured).toContain("desc=")
  })

  it("detectCleanupIssues 过滤 ids 非数组的脏 LLM 输出（?? [] 右支）", async () => {
    const summaries = [summary({ id: "F1", name: "普通线索甲", plantedChapter: 49 })]
    const issues = await detectCleanupIssues(
      summaries,
      50,
      async () =>
        JSON.stringify({
          issues: [{ kind: "noise", ids: "F1", reason: "脏数据", confidence: "high" }],
        }),
    )
    expect(issues).toEqual([])
  })

  it("detectCleanupIssues 命中 keepKeys 时跳过 LLM 结论（continue 真支）", async () => {
    const summaries = [
      summary({
        id: "F1",
        name: "美军规模上升预示大规模正规战争即将展开",
        plantedChapter: 3,
      }),
    ]
    const issues = await detectCleanupIssues(
      summaries,
      50,
      async () =>
        JSON.stringify({
          issues: [{ kind: "noise", ids: ["F1"], reason: "LLM 结论", confidence: "high" }],
        }),
      { keepKeys: [["F1"]] },
    )
    expect(issues.some((i) => i.ids.includes("F1"))).toBe(false)
  })

  it("duplicate 缺 canonicalId 时回退到 ids[0]", async () => {
    const summaries = [
      summary({ id: "F1", name: "灰门甲", plantedChapter: 4 }),
      summary({ id: "F2", name: "灰门乙", plantedChapter: 5 }),
    ]
    const issues = await detectCleanupIssues(
      summaries,
      50,
      async () =>
        JSON.stringify({
          issues: [
            { kind: "duplicate", ids: ["F1", "F2"], reason: "同一线索", confidence: "high" },
          ],
        }),
    )
    const dup = issues.find((i) => i.kind === "duplicate")
    expect(dup?.canonicalId).toBe("F1")
  })

  it("validate 层过滤未知 id 后 noise 长度失配跳过（261 真支）", async () => {
    const summaries = [summary({ id: "F1", name: "普通线索甲", plantedChapter: 49 })]
    const issues = await detectCleanupIssues(
      summaries,
      50,
      async () =>
        JSON.stringify({
          issues: [{ kind: "noise", ids: ["GHOST"], reason: "幽灵", confidence: "high" }],
        }),
    )
    expect(issues).toEqual([])
  })

  it("validate 层 canonicalId 被过滤后回退 ids[0]（271 假支）", async () => {
    const summaries = [
      summary({ id: "F1", name: "灰门甲", plantedChapter: 4 }),
      summary({ id: "F2", name: "灰门乙", plantedChapter: 5 }),
    ]
    const issues = await detectCleanupIssues(
      summaries,
      50,
      async () =>
        JSON.stringify({
          issues: [
            {
              kind: "duplicate",
              ids: ["F1", "F2", "GHOST"],
              canonicalId: "GHOST",
              reason: "同一线索",
              confidence: "high",
            },
          ],
        }),
    )
    const dup = issues.find((i) => i.kind === "duplicate")
    expect(dup?.ids).toEqual(["F1", "F2"])
    expect(dup?.canonicalId).toBe("F1")
  })

  it("merge 容忍双方缺 advancedChapters/relatedCharacters 且空名（|| 右支）", () => {
    const store = createEmptyForeshadowingStore()
    const a = JSON.parse(
      JSON.stringify(item({ id: "A", name: "", description: "甲", plantedChapter: 5 })),
    ) as Foreshadowing
    const b = JSON.parse(
      JSON.stringify(item({ id: "B", name: "", description: "乙乙乙", plantedChapter: 2 })),
    ) as Foreshadowing
    for (const o of [a, b] as Foreshadowing[]) {
      delete (o as Partial<Foreshadowing>).advancedChapters
      delete (o as Partial<Foreshadowing>).relatedCharacters
    }
    store.items = [a, b]
    applyCleanupIssue(
      store,
      { kind: "duplicate", ids: ["A", "B"], canonicalId: "A", reason: "并", confidence: "high" },
      { canonicalId: "A" },
    )
    expect(store.items).toHaveLength(1)
    expect(store.items[0].id).toBe("A")
    expect(store.items[0].advancedChapters).toEqual([])
  })

  it("merge 外层成立但内层不成立时不改名（423 内层假支）", () => {
    const store = createEmptyForeshadowingStore()
    store.items = [
      item({ id: "A", name: "123456789012", plantedChapter: 1 }),
      item({ id: "B", name: "1234567890", plantedChapter: 2 }),
    ]
    applyCleanupIssue(
      store,
      { kind: "duplicate", ids: ["A", "B"], canonicalId: "A", reason: "并", confidence: "high" },
      { canonicalId: "A" },
    )
    // 外层 10 < 12 成立，内层 10<=18 成立但 10+6<12 不成立 → 保留原名
    expect(store.items[0].name).toBe("123456789012")
  })

  it("merge 显著更短时改名（423 内层真支断言）", () => {
    const store = createEmptyForeshadowingStore()
    store.items = [
      item({ id: "A", name: "世界敌意值上升趋势分析报告全文", plantedChapter: 1 }),
      item({ id: "B", name: "敌意值", plantedChapter: 2 }),
    ]
    applyCleanupIssue(
      store,
      { kind: "duplicate", ids: ["A", "B"], canonicalId: "A", reason: "并", confidence: "high" },
      { canonicalId: "A" },
    )
    expect(store.items[0].name).toBe("敌意值")
  })

  it("applyBulkDeleteAndAbandon 空 abandonSet 走假支", () => {
    const store = createEmptyForeshadowingStore()
    store.items = [item({ id: "N1", name: "噪" }), item({ id: "K1", name: "留" })]
    const result = applyBulkDeleteAndAbandon(store, { deleteIds: ["N1"], abandonIds: [] })
    expect(result).toEqual({ deleted: 1, abandoned: 0 })
    expect(store.items.map((f) => f.id)).toEqual(["K1"])
  })

  it("applyCleanupIssue duplicate 无 canonicalId 时用 ids[0]（554 右支）", () => {
    const store = createEmptyForeshadowingStore()
    store.items = [item({ id: "A", name: "甲" }), item({ id: "B", name: "乙" })]
    applyCleanupIssue(store, {
      kind: "duplicate",
      ids: ["A", "B"],
      reason: "并",
      confidence: "high",
    })
    expect(store.items).toHaveLength(1)
    expect(store.items[0].id).toBe("A")
  })

  it("ruleBasedCleanupIssues keepKeys 覆盖 noise（附带 keep 真支）", () => {
    const issues = ruleBasedCleanupIssues(
      [summary({ id: "F1", name: "预示大规模战争即将展开的播报0123456789ABCDEF", plantedChapter: 1 })],
      50,
      { keepKeys: [["F1"]] },
    )
    expect(issues).toEqual([])
  })
})
