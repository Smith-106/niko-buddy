import { describe, expect, it } from "vitest"
import {
  applyBulkDeleteAndAbandon,
  applyCleanupIssue,
  buildOverview,
  cleanupIssueKey,
  cleanupTaskKey,
  defaultCleanupAction,
  detectCleanupIssues,
  isActiveForeshadowingStatus,
  keepKey,
  looksLikeNoise,
  looksLikeStale,
  ruleBasedCleanupIssues,
  toForeshadowingSummary,
  type CleanupIssue,
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

describe("looksLikeNoise / looksLikeStale", () => {
  it("flags forecast-style names as noise", () => {
    expect(
      looksLikeNoise(
        summary({
          id: "F1",
          name: "美军地面部队规模需求升至三十万，预示大规模正规战争即将展开",
        }),
      ),
    ).toBe(true)
  })

  it("flags long-planted items without advances as stale", () => {
    expect(
      looksLikeStale(
        summary({ id: "F2", name: "灰门源头", plantedChapter: 4, status: "planted" }),
        30,
      ),
    ).toBe(true)
    expect(
      looksLikeStale(
        summary({
          id: "F3",
          name: "灰门源头",
          plantedChapter: 4,
          status: "planted",
          advancedChapters: [10],
        }),
        30,
      ),
    ).toBe(false)
  })
})

describe("ruleBasedCleanupIssues", () => {
  it("emits noise and stale and respects keep whitelist", () => {
    const issues = ruleBasedCleanupIssues(
      [
        summary({
          id: "F1",
          name: "敌意值上升预示非常规渗透事件即将触发",
          plantedChapter: 3,
        }),
        summary({ id: "F2", name: "莱拉真实身份", plantedChapter: 2 }),
      ],
      40,
      { keepKeys: [["F2"]] },
    )
    expect(issues.some((i) => i.kind === "noise" && i.ids[0] === "F1")).toBe(true)
    expect(issues.some((i) => i.ids[0] === "F2")).toBe(false)
  })
})

describe("applyCleanupIssue", () => {
  it("merges duplicates with earliest planted and union advanced", () => {
    const store = createEmptyForeshadowingStore()
    store.items = [
      item({
        id: "F001",
        name: "世界敌意值",
        description: "短",
        plantedChapter: 5,
        advancedChapters: [6],
      }),
      item({
        id: "F002",
        name: "世界敌意值上升",
        description: "更长的说明文本关于敌意值",
        plantedChapter: 2,
        status: "advanced",
        advancedChapters: [8],
      }),
    ]
    applyCleanupIssue(
      store,
      {
        kind: "duplicate",
        ids: ["F001", "F002"],
        canonicalId: "F001",
        reason: "同一线索",
        confidence: "high",
      },
      { canonicalId: "F001" },
    )
    expect(store.items).toHaveLength(1)
    expect(store.items[0].id).toBe("F001")
    expect(store.items[0].plantedChapter).toBe(2)
    expect(store.items[0].advancedChapters).toEqual([6, 8])
    expect(store.items[0].description).toContain("更长")
  })

  it("deletes noise", () => {
    const store = createEmptyForeshadowingStore()
    store.items = [
      item({ id: "F001", name: "噪声" }),
      item({ id: "F002", name: "保留" }),
    ]
    applyCleanupIssue(store, {
      kind: "noise",
      ids: ["F001"],
      reason: "噪声",
      confidence: "high",
    })
    expect(store.items.map((f) => f.id)).toEqual(["F002"])
  })

  it("deletes all ids in a duplicate group when action is delete", () => {
    const store = createEmptyForeshadowingStore()
    store.items = [
      item({ id: "F001", name: "a" }),
      item({ id: "F002", name: "b" }),
      item({ id: "F003", name: "keep" }),
    ]
    applyCleanupIssue(
      store,
      {
        kind: "duplicate",
        ids: ["F001", "F002"],
        canonicalId: "F001",
        reason: "都不要",
        confidence: "high",
      },
      { action: "delete" },
    )
    expect(store.items.map((f) => f.id)).toEqual(["F003"])
  })

  it("bulk deletes noise and abandons stale in one pass", () => {
    const store = createEmptyForeshadowingStore()
    store.items = [
      item({ id: "N1", name: "噪声1" }),
      item({ id: "N2", name: "噪声2" }),
      item({ id: "S1", name: "失效1", plantedChapter: 1 }),
      item({ id: "K1", name: "保留" }),
    ]
    const result = applyBulkDeleteAndAbandon(store, {
      deleteIds: ["N1", "N2"],
      abandonIds: ["S1"],
      chapter: 100,
    })
    expect(result).toEqual({ deleted: 2, abandoned: 1 })
    expect(store.items.map((f) => f.id).sort()).toEqual(["K1", "S1"])
    expect(store.items.find((f) => f.id === "S1")?.status).toBe("abandoned")
  })

  it("marks stale as abandoned with notes", () => {
    const store = createEmptyForeshadowingStore()
    store.items = [item({ id: "F001", name: "旧伏笔", plantedChapter: 1 })]
    applyCleanupIssue(
      store,
      {
        kind: "stale",
        ids: ["F001"],
        reason: "故事方向已变",
        confidence: "medium",
      },
      { chapter: 100 },
    )
    expect(store.items[0].status).toBe("abandoned")
    expect(store.items[0].notes).toContain("故事方向已变")
    expect(store.items[0].notes).toContain("第100章")
  })
})

describe("detectCleanupIssues", () => {
  it("parses LLM JSON and supplements with rules", async () => {
    const summaries = [
      summary({ id: "F001", name: "灰门", plantedChapter: 4 }),
      summary({ id: "F002", name: "灰门联络链", plantedChapter: 5 }),
      summary({
        id: "F003",
        name: "美军规模上升预示大规模正规战争即将展开",
        plantedChapter: 20,
      }),
    ]
    const llm = async () =>
      JSON.stringify({
        issues: [
          {
            kind: "duplicate",
            ids: ["F001", "F002"],
            canonicalId: "F001",
            reason: "同一灰门线索",
            confidence: "high",
          },
        ],
      })
    const issues = await detectCleanupIssues(summaries, 50, llm)
    expect(issues.some((i) => i.kind === "duplicate")).toBe(true)
    expect(issues.some((i) => i.kind === "noise" && i.ids[0] === "F003")).toBe(true)
  })
})

describe("isActiveForeshadowingStatus / keepKey / actions / keys", () => {
  it("planted/advanced 为活跃，其余非活跃", () => {
    expect(isActiveForeshadowingStatus("planted")).toBe(true)
    expect(isActiveForeshadowingStatus("advanced")).toBe(true)
    expect(isActiveForeshadowingStatus("resolved")).toBe(false)
    expect(isActiveForeshadowingStatus("abandoned")).toBe(false)
  })

  it("keepKey 大小写不敏感且排序", () => {
    expect(keepKey(["B", "a"])).toBe("a,b")
    expect(keepKey(["A", "b"])).toBe("a,b")
  })

  it("defaultCleanupAction 按 kind 分派", () => {
    expect(defaultCleanupAction("duplicate")).toBe("merge")
    expect(defaultCleanupAction("noise")).toBe("delete")
    expect(defaultCleanupAction("stale")).toBe("abandon")
  })

  it("cleanupIssueKey 归一化 kind + 排序后 ids", () => {
    const issue: CleanupIssue = { kind: "duplicate", ids: ["F002", "f001"], canonicalId: "F002", reason: "r", confidence: "high" }
    expect(cleanupIssueKey(issue)).toBe("duplicate:f001,f002")
  })

  it("cleanupTaskKey 默认动作与显式动作", () => {
    const noise: CleanupIssue = { kind: "noise", ids: ["N1"], reason: "r", confidence: "medium" }
    expect(cleanupTaskKey(noise)).toBe("delete:noise:n1")
    expect(cleanupTaskKey(noise, "abandon")).toBe("abandon:noise:n1")
  })
})

describe("toForeshadowingSummary", () => {
  it("全字段映射、缺 description 兜空、advancedChapters 拷贝", () => {
    const store = createEmptyForeshadowingStore()
    store.items = [
      item({ id: "F1", name: "灰门", plantedChapter: 4, advancedChapters: [6] }),
    ]
    const s = toForeshadowingSummary(store.items[0])
    expect(s).toMatchObject({ id: "F1", name: "灰门", status: "planted", plantedChapter: 4, advancedChapters: [6] })
    expect(s.description).toBe("")
    s.advancedChapters.push(9)
    expect(store.items[0].advancedChapters).toEqual([6])
  })

  it("透传 resolvedChapter、description", () => {
    const s = toForeshadowingSummary(
      item({ id: "F2", name: "密信", description: "真相", status: "resolved", resolvedChapter: 10 }),
    )
    expect(s.resolvedChapter).toBe(10)
    expect(s.description).toBe("真相")
  })
})

describe("buildOverview", () => {
  it("混合 store 计数与人均章回", () => {
    const store = createEmptyForeshadowingStore()
    store.items = [
      item({ id: "A", name: "a", status: "planted", plantedChapter: 1 }),
      item({ id: "B", name: "b", status: "advanced", plantedChapter: 1 }),
      item({ id: "C", name: "c", status: "resolved", plantedChapter: 2 }),
      item({ id: "D", name: "d", status: "abandoned", plantedChapter: 2 }),
    ]
    const ov = buildOverview(store)
    expect(ov).toMatchObject({ total: 4, active: 2, resolved: 1, abandoned: 1, planted: 1, advanced: 1 })
    expect(ov.avgPerChapter).toBe(2)
  })

  it("空 store 全零、plantedChapter<=0 不计章", () => {
    const store = createEmptyForeshadowingStore()
    expect(buildOverview(store)).toMatchObject({ total: 0, avgPerChapter: 0 })
    store.items = [item({ id: "X", name: "x", plantedChapter: 0 })]
    expect(buildOverview(store).avgPerChapter).toBe(0)
  })
})

describe("looksLikeNoise 分支", () => {
  it("resolved/abandoned 永不为 noise", () => {
    expect(looksLikeNoise(summary({ id: "R", name: "预示大战", status: "resolved" }))).toBe(false)
    expect(looksLikeNoise(summary({ id: "A", name: "预示大战", status: "abandoned" }))).toBe(false)
  })

  it("空名+空说明 → true", () => {
    expect(looksLikeNoise(summary({ id: "E", name: "  ", description: "  " }))).toBe(true)
  })

  it("无说明 + 模板名 → true；干净名 → false", () => {
    expect(looksLikeNoise(summary({ id: "N1", name: "倒计时三天", description: "" }))).toBe(true)
    expect(looksLikeNoise(summary({ id: "N2", name: "灰门", description: "" }))).toBe(false)
  })

  it("长文本含模板 → true；短文本含模板 → false；长干净文本 → false", () => {
    expect(looksLikeNoise(summary({ id: "L", name: "预示", description: "后续剧情将面临重大转折，涉及多方势力的博弈与抉择，整整持续数十章的铺垫与反复拉扯" }))).toBe(true)
    expect(looksLikeNoise(summary({ id: "S", name: "预示", description: "一些说明" }))).toBe(false)
    expect(looksLikeNoise(summary({ id: "C", name: "灰门异动", description: "城门守卫换防频繁，似乎在戒备着什么未知威胁的到来" }))).toBe(false)
  })
})

describe("looksLikeStale 分支", () => {
  it("非 planted → false；有推进 → false", () => {
    expect(looksLikeStale(summary({ id: "A", name: "x", status: "advanced", plantedChapter: 1 }), 50)).toBe(false)
    expect(looksLikeStale(summary({ id: "B", name: "x", plantedChapter: 1, advancedChapters: [5] }), 50)).toBe(false)
  })

  it("恰达阈值 → true；未达 → false；自定义阈值", () => {
    expect(looksLikeStale(summary({ id: "C", name: "x", plantedChapter: 10 }), 30)).toBe(true)
    expect(looksLikeStale(summary({ id: "D", name: "x", plantedChapter: 11 }), 30)).toBe(false)
    expect(looksLikeStale(summary({ id: "E", name: "x", plantedChapter: 25 }), 30, 10)).toBe(false)
  })
})

describe("ruleBasedCleanupIssues 增补", () => {
  it("非活跃直接跳过", () => {
    const out = ruleBasedCleanupIssues([summary({ id: "R", name: "预示大战将面临", status: "resolved", plantedChapter: 1 })], 50)
    expect(out).toHaveLength(0)
  })

  it("keep 命中 noise 则不输出", () => {
    const out = ruleBasedCleanupIssues(
      [summary({ id: "N", name: "敌意值上升预示非常规渗透事件即将触发", plantedChapter: 3 })],
      40,
      { keepKeys: [["N"]] },
    )
    expect(out).toHaveLength(0)
  })

  it("stale keep 命中则不输出", () => {
    const out = ruleBasedCleanupIssues(
      [summary({ id: "S", name: "旧线索", plantedChapter: 1 })],
      40,
      { keepKeys: [["S"]] },
    )
    expect(out).toHaveLength(0)
  })
})


describe("detectCleanupIssues 增补", () => {
  it("无活跃条目 → [] 且不调 LLM", () => {
    let called = 0
    return expect(
      detectCleanupIssues([summary({ id: "R", name: "x", status: "resolved" })], 10, async () => {
        called++
        return "{}"
      }),
    ).resolves.toEqual([]).then(() => expect(called).toBe(0))
  })

  it("多批次拆分 + progress 上报 batch_start/done", async () => {
    const summaries = [
      summary({ id: "F1", name: "灰门", plantedChapter: 1 }),
      summary({ id: "F2", name: "密信", plantedChapter: 2 }),
      summary({ id: "F3", name: "旧剑", plantedChapter: 3 }),
    ]
    const events: string[] = []
    const seenMessages: string[] = []
    const issues = await detectCleanupIssues(summaries, 10, async (_sys, msg) => {
      seenMessages.push(msg)
      return '{"issues": []}'
    }, {
      batchSize: 2,
      onBatchProgress: (p) => events.push(`${p.current}/${p.total}:${p.phase}:${p.batchSize}/${p.activeCount}`),
    })
    expect(seenMessages).toHaveLength(2)
    expect(events).toEqual(["1/2:batch_start:2/3", "1/2:batch_done:2/3", "2/2:batch_start:1/3", "2/2:batch_done:1/3"])
    expect(issues).toEqual([])
  })

  it("已 abort 的 signal 直接抛错", async () => {
    const c = new AbortController()
    c.abort()
    await expect(
      detectCleanupIssues([summary({ id: "F1", name: "x" })], 10, async () => '{"issues": []}', { signal: c.signal }),
    ).rejects.toThrow()
  })

  it("markdown 围栏 JSON 可解析；canonicalId 不在 ids 中时纠正为 ids[0]", async () => {
    const issues = await detectCleanupIssues(
      [summary({ id: "F1", name: "灰门", plantedChapter: 1 }), summary({ id: "F2", name: "灰门异动", plantedChapter: 2 })],
      10,
      async () => "```json\n{\"issues\": [{\"kind\": \"duplicate\", \"ids\": [\"F1\", \"F2\"], \"canonicalId\": \"F999\", \"reason\": \"同一线索\", \"confidence\": \"high\"}]}\n```",
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].canonicalId).toBe("F1")
  })

  it("非法 LLM 输出被丢弃：未知 kind/非对象/缺字段/长度非法/无 issues 字段/非 JSON", async () => {
    const summaries = [
      summary({ id: "F1", name: "灰门", plantedChapter: 1 }),
      summary({ id: "F2", name: "密信", plantedChapter: 1 }),
    ]
    const bodies = [
      "not json at all",
      '{"issues": [{"kind": "weird", "ids": ["F1"], "reason": "x", "confidence": "high"}]}',
      '{"issues": ["oops", null, 42]}',
      '{"issues": [{"kind": "duplicate", "ids": ["F1"], "reason": "x", "confidence": "high"}]}',
      '{"issues": [{"kind": "noise", "ids": ["F1", "F2"], "reason": "x", "confidence": "medium"}]}',
      '{"nope": []}',
      '{"issues": [{"kind": "noise", "ids": ["F1", "F2"], "reason": 42, "confidence": "ultra"}]}',
    ]
    for (const body of bodies) {
      const issues = await detectCleanupIssues(summaries, 5, async () => body)
      expect(issues.filter((i) => i.kind === "duplicate")).toEqual([])
    }
  })

  it("brace 平衡但 JSON 非法 → catch 兜 null；左 brace 永不闭合 → 尾部 null", async () => {
    const summaries = [
      summary({ id: "F1", name: "灰门", plantedChapter: 1 }),
      summary({ id: "F2", name: "密信", plantedChapter: 1 }),
    ]
    for (const body of ['{"a": }', '{"issues": [']) {
      const issues = await detectCleanupIssues(summaries, 5, async () => body)
      expect(issues).toEqual([])
    }
  })

  it("reason 缺失兜空串、confidence 非法兜 low、noise 的 canonicalId 置空", async () => {
    const issues = await detectCleanupIssues(
      [summary({ id: "F1", name: "灰门", plantedChapter: 1 }), summary({ id: "F2", name: "密信", plantedChapter: 1 }), summary({ id: "F3", name: "旧剑", plantedChapter: 1 })],
      5,
      async () => JSON.stringify({ issues: [{ kind: "noise", ids: ["F1"], canonicalId: "F1", confidence: "ultra" }] }),
    )
    const n = issues.find((i) => i.kind === "noise" && i.ids[0] === "F1")
    expect(n).toBeDefined()
    expect(n!.reason).toBe("")
    expect(n!.confidence).toBe("low")
    expect(n!.canonicalId).toBeUndefined()
  })

  it("未知 id 被过滤；冲突 id 以 duplicate 优先落 noise/stale", async () => {
    const summaries = [
      summary({ id: "F1", name: "灰门", plantedChapter: 1 }),
      summary({ id: "F2", name: "灰门异动", plantedChapter: 1 }),
    ]
    const issues = await detectCleanupIssues(summaries, 5, async () => JSON.stringify({
      issues: [
        { kind: "duplicate", ids: ["F1", "GHOST"], reason: "x", confidence: "high" },
        { kind: "noise", ids: ["F1"], reason: "x", confidence: "medium" },
        { kind: "stale", ids: ["F2"], reason: "x", confidence: "low" },
      ],
    }))
    expect(issues.some((i) => i.kind === "duplicate")).toBe(false)
    expect(issues.some((i) => i.kind === "noise" && i.ids[0] === "F1")).toBe(true)
    expect(issues.some((i) => i.kind === "stale" && i.ids[0] === "F2")).toBe(true)
  })

  it("keepKeys 命中 LLM duplicate → 剔除且不重复补规则", async () => {
    const issues = await detectCleanupIssues(
      [summary({ id: "F1", name: "灰门", plantedChapter: 1 }), summary({ id: "F2", name: "灰门异动", plantedChapter: 1 })],
      5,
      async () => JSON.stringify({ issues: [{ kind: "duplicate", ids: ["F1", "F2"], reason: "x", confidence: "high" }] }),
      { keepKeys: [["F1", "F2"]] },
    )
    expect(issues).toEqual([])
  })

  it("LLM 已覆盖的规则项不再重复补充", async () => {
    const issues = await detectCleanupIssues(
      [summary({ id: "F1", name: "美军规模上升预示大规模正规战争即将展开", plantedChapter: 1 })],
      50,
      async () => JSON.stringify({ issues: [{ kind: "noise", ids: ["F1"], reason: "llm", confidence: "high" }] }),
    )
    expect(issues.filter((i) => i.ids[0] === "F1")).toHaveLength(1)
    expect(issues[0].reason).toBe("llm")
  })
})

describe("applyCleanupIssue merge 增补", () => {
  function twoItems() {
    const store = createEmptyForeshadowingStore()
    store.items = [
      item({ id: "F001", name: "世界敌意值上升的漫长前奏曲", description: "短", plantedChapter: 5, advancedChapters: [6], relatedCharacters: ["林默"] }),
      item({
        id: "F002", name: "灰门", description: "更长的说明文本关于敌意值与灰门联动", plantedChapter: 2,
        status: "advanced", advancedChapters: [8], relatedCharacters: ["苏晴"],
      }),
    ]
    return store
  }

  it("options.canonicalId 覆盖 issue.canonicalId", () => {
    const store = twoItems()
    applyCleanupIssue(
      store,
      { kind: "duplicate", ids: ["F001", "F002"], canonicalId: "F001", reason: "r", confidence: "high" },
      { canonicalId: "F002" },
    )
    expect(store.items).toHaveLength(1)
    expect(store.items[0].id).toBe("F002")
  })

  it("merge 动作用于非 duplicate 抛错", () => {
    const store = createEmptyForeshadowingStore()
    store.items = [item({ id: "N1", name: "噪声" })]
    expect(() =>
      applyCleanupIssue(store, { kind: "noise", ids: ["N1"], reason: "r", confidence: "high" }, { action: "merge" }),
    ).toThrow("merge action requires duplicate")
  })

  it("canonical 不存在抛错", () => {
    const store = createEmptyForeshadowingStore()
    store.items = [item({ id: "F001", name: "a" })]
    expect(() =>
      applyCleanupIssue(store, { kind: "duplicate", ids: ["F001", "GHOST"], canonicalId: "GHOST", reason: "r", confidence: "high" }),
    ).toThrow("not found")
  })

  it("others 中缺失 id 跳过不抛错", () => {
    const store = createEmptyForeshadowingStore()
    store.items = [item({ id: "F001", name: "灰门灰门灰门灰门灰门灰门", plantedChapter: 3 })]
    applyCleanupIssue(store, { kind: "duplicate", ids: ["F001", "GHOST"], canonicalId: "F001", reason: "r", confidence: "high" })
    expect(store.items.map((f) => f.id)).toEqual(["F001"])
  })

  it("显著更短的 other 名替换长名、状态升级、人物并集", () => {
    const store = twoItems()
    applyCleanupIssue(store, { kind: "duplicate", ids: ["F001", "F002"], canonicalId: "F001", reason: "r", confidence: "high" })
    expect(store.items[0].name).toBe("灰门")
    expect(store.items[0].status).toBe("advanced")
    expect(store.items[0].relatedCharacters.sort()).toEqual(["林默", "苏晴"])
  })

  it("other 名不够短则保留 canonical 名", () => {
    const store = createEmptyForeshadowingStore()
    store.items = [
      item({ id: "F001", name: "灰门联动", plantedChapter: 5 }),
      item({ id: "F002", name: "灰门联动链", plantedChapter: 2 }),
    ]
    applyCleanupIssue(store, { kind: "duplicate", ids: ["F001", "F002"], canonicalId: "F001", reason: "r", confidence: "high" })
    expect(store.items[0].name).toBe("灰门联动")
  })

  it("other resolved 覆盖状态；无 resolvedChapter 则保留原值", () => {
    const store = createEmptyForeshadowingStore()
    store.items = [
      item({ id: "F001", name: "灰门", plantedChapter: 5, resolvedChapter: 9, status: "advanced" }),
      item({ id: "F002", name: "灰门异动", plantedChapter: 2, status: "resolved" }),
    ]
    applyCleanupIssue(store, { kind: "duplicate", ids: ["F001", "F002"], canonicalId: "F001", reason: "r", confidence: "high" })
    expect(store.items[0].status).toBe("resolved")
    expect(store.items[0].resolvedChapter).toBe(9)
  })

  it("other 描述更短则保留 canonical 描述", () => {
    const store = createEmptyForeshadowingStore()
    store.items = [
      item({ id: "F001", name: "灰门", description: "很长的 canonical 描述文本", plantedChapter: 5 }),
      item({ id: "F002", name: "灰门异动", description: "短", plantedChapter: 2 }),
    ]
    applyCleanupIssue(store, { kind: "duplicate", ids: ["F001", "F002"], canonicalId: "F001", reason: "r", confidence: "high" })
    expect(store.items[0].description).toBe("很长的 canonical 描述文本")
  })

  it("canonical 已 advanced、other planted → 保持 advanced", () => {
    const store = createEmptyForeshadowingStore()
    store.items = [
      item({ id: "F001", name: "灰门", plantedChapter: 5, status: "advanced" }),
      item({ id: "F002", name: "灰门异动", plantedChapter: 2, status: "planted" }),
    ]
    applyCleanupIssue(store, { kind: "duplicate", ids: ["F001", "F002"], canonicalId: "F001", reason: "r", confidence: "high" })
    expect(store.items[0].status).toBe("advanced")
  })
})

describe("applyCleanupIssue abandon/delete 增补", () => {
  it("abandon 跳过缺失 id、追加既有 notes、无章号不加后缀", () => {
    const store = createEmptyForeshadowingStore()
    store.items = [item({ id: "F001", name: "旧伏笔", notes: "旧注" })]
    applyCleanupIssue(
      store,
      { kind: "stale", ids: ["F001", "GHOST"], reason: "故事方向已变", confidence: "medium" },
      { action: "abandon" },
    )
    expect(store.items[0].status).toBe("abandoned")
    expect(store.items[0].notes).toBe("旧注；故事方向已变")
  })

  it("reason 全空兜底默认文案", () => {
    const store = createEmptyForeshadowingStore()
    store.items = [item({ id: "F001", name: "旧伏笔" })]
    applyCleanupIssue(store, { kind: "stale", ids: ["F001"], reason: "", confidence: "low" }, { action: "abandon" })
    expect(store.items[0].notes).toContain("维护工具标记为已放弃")
  })

  it("delete 动作透传 options.action", () => {
    const store = createEmptyForeshadowingStore()
    store.items = [item({ id: "N1", name: "噪声" }), item({ id: "K1", name: "保留" })]
    applyCleanupIssue(store, { kind: "noise", ids: ["N1"], reason: "r", confidence: "high" }, { action: "delete" })
    expect(store.items.map((f) => f.id)).toEqual(["K1"])
  })
})

describe("applyBulkDeleteAndAbandon 增补", () => {
  it("delete 与 abandon 重叠 → 仅删除", () => {
    const store = createEmptyForeshadowingStore()
    store.items = [item({ id: "X", name: "x" }), item({ id: "K", name: "k" })]
    const r = applyBulkDeleteAndAbandon(store, { deleteIds: ["X"], abandonIds: ["X", "K"], chapter: 7 })
    expect(r).toEqual({ deleted: 1, abandoned: 1 })
    expect(store.items.find((f) => f.id === "K")?.status).toBe("abandoned")
  })

  it("已 abandoned 不重复计数；空集合不碰 lastUpdated", () => {
    const store = createEmptyForeshadowingStore()
    const stamp = store.lastUpdated
    store.items = [item({ id: "S", name: "s", status: "abandoned" })]
    const r = applyBulkDeleteAndAbandon(store, { deleteIds: [], abandonIds: ["S"] })
    expect(r).toEqual({ deleted: 0, abandoned: 0 })
    expect(store.lastUpdated).toBe(stamp)
  })

  it("abandon 默认文案 + 追加既有 notes", () => {
    const store = createEmptyForeshadowingStore()
    store.items = [item({ id: "S", name: "s", notes: "旧注" })]
    const r = applyBulkDeleteAndAbandon(store, { deleteIds: [], abandonIds: ["S"] })
    expect(r).toEqual({ deleted: 0, abandoned: 1 })
    expect(store.items[0].notes).toBe("旧注；一键清理：标记为已放弃")
  })
})
describe("覆盖战役补齐：keepKeys 过滤与缺失 canonical", () => {
  it("LLM 报出的 duplicate 命中 keepKeys → 被过滤；无 keepKeys 时保留（差分钉住过滤分支）", async () => {
    const summaries = [
      summary({ id: "F001", name: "铜钥匙" }),
      summary({ id: "F002", name: "旧铜钥匙" }),
    ]
    const llmCall = async () =>
      JSON.stringify({
        issues: [
          {
            kind: "duplicate",
            ids: ["F001", "F002"],
            canonicalId: "F001",
            reason: "同物异名",
            confidence: "high",
          },
        ],
      })
    const kept = await detectCleanupIssues(summaries, 10, llmCall, {
      keepKeys: [["F001", "F002"]],
    })
    expect(kept).toEqual([])
    // 对照：同样的 LLM 输出、无 keepKeys 时 duplicate 保留——证明上式的 []
    // 来自 keepKeys 过滤分支（validateAndFilterIssues 内），而非解析失败。
    const unkept = await detectCleanupIssues(summaries, 10, llmCall, {})
    expect(unkept).toHaveLength(1)
    expect(unkept[0]).toMatchObject({ kind: "duplicate", ids: ["F001", "F002"] })
  })

  it("merge 的 canonicalId 不在 store → 抛错且不改动 store（不静默丢数据）", () => {
    const store = createEmptyForeshadowingStore()
    store.items = [item({ id: "F001", name: "铜钥匙" })]
    expect(() =>
      applyCleanupIssue(
        store,
        { kind: "duplicate", ids: ["F001", "GHOST"], reason: "r", confidence: "high" },
        { canonicalId: "GHOST" },
      ),
    ).toThrow("Canonical foreshadowing GHOST not found")
    expect(store.items.map((f) => f.id)).toEqual(["F001"])
  })
})
