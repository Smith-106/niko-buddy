import { describe, expect, it } from "vitest"
import {
  buildQueryPlan,
  classifyNovelIntent,
  decomposeNovelQuery,
} from "./bm25-ranking"

describe("query-decomposition (64 号实施：zero-LLM 查询分解 fidelis 模式)", () => {
  it("引号提取：四种引号字面量", () => {
    const d = decomposeNovelQuery("「剑」和“刀”与『枪』还有\"弓\"的关系")
    expect(d.verbatim.sort()).toEqual(["刀", "剑", "枪", "弓"].sort())
  })

  it("无引号退化：verbatim 空，rest 为原查询", () => {
    const d = decomposeNovelQuery("主角的师父是谁")
    expect(d.verbatim).toEqual([])
    expect(d.rest).toBe("主角的师父是谁")
  })

  it("实体前缀解析：character/location/item 分面", () => {
    const d = decomposeNovelQuery("character:张三和location:青云山")
    expect(d.facets.character).toBe("张三")
    expect(d.facets.location).toBe("青云山")
    expect(d.entityMentions).toContain("character:张三")
  })

  it("别名注入命中：别名 → canon 实体提及", () => {
    const aliases = new Map([["小三", "张三"]])
    const d = decomposeNovelQuery("小三在哪", { aliases })
    expect(d.facets.character).toBe("张三")
    expect(d.entityMentions).toContain("character:张三")
  })

  it("意图分类：verbatim 非空 → verbatim_lookup", () => {
    const d = decomposeNovelQuery("“雪夜”在哪章")
    expect(classifyNovelIntent(d)).toBe("verbatim_lookup")
  })

  it("意图分类：实体分面 → entity_fact", () => {
    const d = decomposeNovelQuery("character:李四的武器")
    expect(classifyNovelIntent(d)).toBe("entity_fact")
  })

  it("意图分类：时序词 → continuity_check", () => {
    const d = decomposeNovelQuery("张三和李四谁先到的")
    expect(classifyNovelIntent(d)).toBe("continuity_check")
  })

  it("意图分类：文风词 → style_lookup", () => {
    const d = decomposeNovelQuery("主角的文风是什么")
    expect(classifyNovelIntent(d)).toBe("style_lookup")
  })

  it("意图分类：其余 → scene_search", () => {
    const d = decomposeNovelQuery("夜市里的打斗")
    expect(classifyNovelIntent(d)).toBe("scene_search")
  })

  it("plan 路由剪枝：verbatim_lookup 关 vector/graph", () => {
    const plan = buildQueryPlan("“断剑”在哪")
    expect(plan.intent).toBe("verbatim_lookup")
    expect(plan.route.vector).toBe(false)
    expect(plan.route.graph).toBe(false)
    expect(plan.route.keyword).toBe(true)
  })

  it("verbatim 闸门：全部命中 → pass", () => {
    const plan = buildQueryPlan("“雪夜”场景", new Set(["第3章-雪夜", "人物卡-张三"]))
    expect(plan.verbatimGate.pass).toBe(true)
    expect(plan.verbatimGate.hits).toEqual(["雪夜"])
  })

  it("verbatim 闸门：部分/未命中 → 非 pass（降级普通路径）", () => {
    const plan = buildQueryPlan("“雪夜”“不存在词”", new Set(["第3章-雪夜"]))
    expect(plan.verbatimGate.pass).toBe(false)
    expect(plan.verbatimGate.missed).toContain("不存在词")
  })

  it("空查询：verbatim 空、rest 空、意图 scene_search", () => {
    const d = decomposeNovelQuery("  ")
    expect(d.rest).toBe("")
    expect(classifyNovelIntent(d)).toBe("scene_search")
  })

  it("纯性：分解不改输入", () => {
    const q = "“剑”与character:张三"
    const snap = q.slice()
    decomposeNovelQuery(q)
    expect(q).toBe(snap)
  })

  it("rest 残查询可再分解（一致性）", () => {
    const d = decomposeNovelQuery("「血月」前后 character:王五 的状态")
    const d2 = decomposeNovelQuery(d.rest)
    expect(d2.verbatim).toEqual([])
    expect(d2.facets.character).toBeUndefined()
    expect(d2.rest.length).toBeGreaterThan(0)
  })
})
