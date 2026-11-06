import { describe, expect, it } from "vitest"
import {
  closeDeclarationsOnDeath,
  traceCausality,
  validateChangeConsistency,
  validateEventLog,
  type NarrativeEvent,
} from "./event-causality"

function event(overrides: Partial<NarrativeEvent>): NarrativeEvent {
  return {
    eventId: "e1",
    type: "change",
    storyTime: "ch1",
    entityId: "ent1",
    source: "engine",
    ...overrides,
  }
}

describe("event-causality（吸收 underworld-graph 事件因果链+级联闭合模式，增强环检测）", () => {
  const chain: NarrativeEvent[] = [
    event({ eventId: "e-root", type: "birth", summary: "暗门出现" }),
    event({ eventId: "e-mid", causedBy: "e-root", summary: "侦探发现暗门" }),
    event({ eventId: "e-leaf", causedBy: "e-mid", summary: "凶手封闭暗门" }),
  ]

  it("traceCausality：根→触发事件全链回溯", () => {
    const traced = traceCausality(chain, "e-leaf")
    expect(traced.map((e) => e.eventId)).toEqual(["e-root", "e-mid", "e-leaf"])
    expect(traceCausality(chain, "e-root").map((e) => e.eventId)).toEqual(["e-root"])
  })

  it("traceCausality：目标不存在返回空；causedBy 缺失安全终止", () => {
    expect(traceCausality(chain, "e-none")).toEqual([])
    const orphan = [event({ eventId: "x1", causedBy: "gone" })]
    expect(traceCausality(orphan, "x1").map((e) => e.eventId)).toEqual(["x1"])
  })

  it("traceCausality 环检测增强：环数据不再死循环（原版 while 缺陷）", () => {
    const cyclic = [
      event({ eventId: "a", causedBy: "b" }),
      event({ eventId: "b", causedBy: "a" }),
    ]
    const traced = traceCausality(cyclic, "a")
    expect(traced).toHaveLength(2)
    expect(new Set(traced.map((e) => e.eventId)).size).toBe(2)
  })

  it("closeDeclarationsOnDeath：仅闭合该实体未闭合声明；已闭合不动", () => {
    const decls = [
      { declarationId: "d1", entityId: "ent1", validTo: "Infinity" },
      { declarationId: "d2", entityId: "ent1", validTo: "ch2" },
      { declarationId: "d3", entityId: "ent2", validTo: "Infinity" },
    ]
    const closed = closeDeclarationsOnDeath(decls, "ent1", "ch5")
    expect(closed).toEqual([{ declarationId: "d1", validTo: "ch5" }])
  })

  it("validateEventLog：id 重复/causedBy 悬空/因果环逐一报错", () => {
    const errsDup = validateEventLog([event({ eventId: "x" }), event({ eventId: "x" })])
    expect(errsDup.some((e) => e.includes("重复"))).toBe(true)
    const errsDangling = validateEventLog([event({ eventId: "y", causedBy: "gone" })])
    expect(errsDangling.some((e) => e.includes("不存在"))).toBe(true)
    const cyclic = [
      event({ eventId: "a", causedBy: "b" }),
      event({ eventId: "b", causedBy: "a" }),
    ]
    expect(validateEventLog(cyclic).some((e) => e.includes("因果环"))).toBe(true)
    expect(validateEventLog(chain)).toEqual([])
  })

  it("validateChangeConsistency：invalidated 引用不存在声明 / newFact 无对应 invalidated 报错", () => {
    const decls = [
      { declarationId: "d-old", property: "atmosphere" },
    ]
    const bad = event({
      eventId: "e2",
      invalidated: [{ declarationId: "d-old" }, { declarationId: "d-ghost" }],
      newFacts: [
        { declarationId: "d-new", entityId: "ent1", property: "atmosphere", description: "新描述", modality: "fact" },
        { declarationId: "d-new2", entityId: "ent1", property: "mood", description: "多余", modality: "fact" },
      ],
    })
    const errs = validateChangeConsistency(bad, decls)
    expect(errs.some((e) => e.includes("d-ghost"))).toBe(true)
    expect(errs.some((e) => e.includes("mood"))).toBe(true)

    const good = event({
      eventId: "e3",
      invalidated: [{ declarationId: "d-old" }],
      newFacts: [
        { declarationId: "d-new", entityId: "ent1", property: "atmosphere", description: "新描述", modality: "fact" },
      ],
    })
    expect(validateChangeConsistency(good, decls)).toEqual([])
    expect(validateChangeConsistency(event({ eventId: "e4", type: "birth" }), decls)).toEqual([])
  })

  it("确定性：同输入双跑全等", () => {
    expect(JSON.stringify(traceCausality(chain, "e-leaf"))).toBe(JSON.stringify(traceCausality(chain, "e-leaf")))
  })
})

describe("validateEventLog 环检测的重复访问剪枝", () => {
  it("链上进入他人环（A→B↔C）时剪枝终止，只报环成员，不误报 A", () => {
    const events = [
      event({ eventId: "a", causedBy: "b" }),
      event({ eventId: "b", causedBy: "c" }),
      event({ eventId: "c", causedBy: "b" }),
    ]
    const errs = validateEventLog(events)
    const cycles = errs.filter((e) => e.includes("因果环"))
    // b、c 各自从自身出发命中环；a 的游走遇到已访问节点后 break（不自称环）
    expect(cycles).toHaveLength(2)
    expect(cycles.some((e) => e.startsWith("因果环：b"))).toBe(true)
    expect(cycles.some((e) => e.startsWith("因果环：c"))).toBe(true)
    expect(errs.some((e) => e.includes("因果环：a"))).toBe(false)
    expect(validateEventLog(events)).toEqual(errs)
  })

  it("自环（A→A）由自身命中而非剪枝分支", () => {
    expect(validateEventLog([event({ eventId: "a", causedBy: "a" })])).toEqual(["因果环：a → … → a"])
  })
})
